import { useState, useEffect, useRef } from 'react'
import { PROXY_URL, AI_TIMEOUT_MS } from '../config'
import { fetchWithTimeout } from '../services/fetchWithTimeout'

/**
 * useCellAI — the AI + execution-routing logic for a code/SQL cell:
 *   - smartExecute: NLP-vs-code detection → generate or run
 *   - handleGenerate: NLP → code (Python/SQL) via /ai/chat/sync
 *   - handleAiExplain / handleAiFix / handleAiCancel / handleApplyFix
 * Owns aiResult, generating, and editorVersion (bumped to remount the editor when
 * code is replaced by Apply Fix / generate). Extracted from Cell.jsx.
 */
export function useCellAI({
  cell,
  index,
  isConnected,
  aiAvailable,
  microvmId,
  sessionId,
  variables = {},
  dataSources = null,
  notebookContext,
  onExecute,
  onCodeChange,
  onClearOutput,
  onInsertAbove,
  onSetAiExplanation,
}) {
  const [aiResult, setAiResult] = useState(
    cell.aiExplanation ? { type: 'explain', content: cell.aiExplanation, loading: false } : null
  )
  const [generating, setGenerating] = useState(false)
  // Version counter — incremented on external code changes (Apply Fix, AI generate)
  // Forces CellEditor to remount with fresh content
  const [editorVersion, setEditorVersion] = useState(0)
  const aiAbortRef = useRef(null)

  // Sync aiResult when cell.aiExplanation changes externally (e.g. from Annotate button)
  useEffect(() => {
    if (cell.aiExplanation && (!aiResult || aiResult.content !== cell.aiExplanation)) {
      setAiResult({ type: 'explain', content: cell.aiExplanation, loading: false })
    }
  }, [cell.aiExplanation])

  // Smart execute: detects NLP vs code and routes accordingly
  const smartExecute = () => {
    const code = (cell.code || '').trim()
    if (cell.type === 'sql') {
      // For SQL cells: detect NLP (doesn't look like SQL) → generate SQL
      if (code && aiAvailable && isConnected) {
        const looksLikeSql = /^(SELECT|INSERT INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+(TABLE|VIEW|INDEX|DATABASE)|DROP\s+(TABLE|VIEW)|ALTER\s+TABLE|WITH\s+\w+\s+AS|SHOW\s+(TABLES|DATABASES|COLUMNS)|DESCRIBE|EXPLAIN)\b/i.test(code) || code.trimStart().startsWith('--')
        if (!looksLikeSql && !generating) {
          handleGenerate()
          return
        }
      }
      onExecute()
      return
    }
    if (code && aiAvailable && isConnected) {
      const looksLikeCode = /^(import |from |def |class |for |while |if |#|[a-zA-Z_]\w*\s*[=([]|print\(|plt\.|pd\.|np\.)/.test(code) || code.includes('=') || code.includes('(')
      if (!looksLikeCode && !generating) {
        handleGenerate()
        return
      }
    }
    onExecute()
  }

  const handleAiExplain = async () => {
    setAiResult({ type: 'explain', content: '', loading: true })
    const controller = new AbortController()
    aiAbortRef.current = controller
    try {
      const resp = await fetchWithTimeout(`${PROXY_URL}/ai/explain`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        timeout: AI_TIMEOUT_MS,
        body: JSON.stringify({
          code: cell.code || '',
          output: (cell.output || '') + (cell.html ? ' [table output]' : ''),
          microvm_id: microvmId || '',
          session_id: sessionId || '',
        }),
      })
      if (resp.ok) {
        const data = await resp.json()
        const explanation = data.explanation || 'No explanation'
        setAiResult({ type: 'explain', content: explanation, loading: false })
        if (onSetAiExplanation) onSetAiExplanation(explanation)
        // Insert a short markdown summary above if no markdown cell exists above
        if (onInsertAbove && data.summary) {
          const desc = data.description ? `\n\n${data.description}` : ''
          onInsertAbove(data.summary + desc)
        }
      } else {
        setAiResult({ type: 'explain', content: 'Failed to get explanation', loading: false })
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        setAiResult({ type: 'explain', content: `Error: ${err.message}`, loading: false })
      }
    }
  }

  const handleAiFix = async () => {
    setAiResult({ type: 'fix', content: '', loading: true })
    const controller = new AbortController()
    aiAbortRef.current = controller
    try {
      const resp = await fetchWithTimeout(`${PROXY_URL}/ai/fix`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        timeout: AI_TIMEOUT_MS,
        body: JSON.stringify({
          code: cell.code || '',
          error: cell.error || '',
          cell_type: cell.type || 'code',
          microvm_id: microvmId || '',
          session_id: sessionId || '',
          variables: Object.keys(variables || {}),
          data_sources: dataSources || null,
          cells: (notebookContext || []).slice(0, index).map(c => ({
            type: c.type || 'code',
            code: (c.code || '').slice(0, 300),
            output: (c.output || '').slice(0, 100),
          })),
        }),
      })
      if (resp.ok) {
        const data = await resp.json()
        setAiResult({ type: 'fix', content: data.fixed_code || '', loading: false })
      } else {
        setAiResult({ type: 'fix', content: 'Failed to fix error', loading: false })
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        setAiResult({ type: 'fix', content: `Error: ${err.message}`, loading: false })
      }
    }
  }

  const handleAiCancel = () => {
    if (aiAbortRef.current) aiAbortRef.current.abort()
    setAiResult(null)
  }

  const handleApplyFix = () => {
    if (aiResult?.type === 'fix' && aiResult.content) {
      onCodeChange(aiResult.content)
      setEditorVersion(v => v + 1)
      setAiResult(null)
      // The old error/output belonged to the previous (broken) code — clear it so the
      // cell no longer shows a stale error after the fix is applied.
      if (onClearOutput) onClearOutput()
    }
  }

  const handleGenerate = async () => {
    if (!cell.code?.trim() || generating) return
    setGenerating(true)
    try {
      const isSqlCell = cell.type === 'sql'
      const prompt = isSqlCell
        ? `Generate a SQL query for the following request. This is a SQL cell using DuckDB. Use proper DuckDB syntax: local files as '/tmp/file.csv', S3 as read_csv('s3://...'), Athena tables as database.table. Return ONLY the SQL wrapped in \`\`\`sql, no explanations:\n\n${cell.code}`
        : `Generate Python code for the following request. This is a PYTHON code cell — return ONLY Python code, never SQL. Do NOT use \`\`\`sql blocks. Return ONLY the code wrapped in \`\`\`python, no explanations:\n\n${cell.code}`

      const resp = await fetchWithTimeout(`${PROXY_URL}/ai/chat/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        timeout: AI_TIMEOUT_MS,
        body: JSON.stringify({
          message: prompt,
          active_cell_index: index,
          cells: (notebookContext || []).slice(0, index).map(c => ({
            type: c.type || 'code',
            code: (c.code || '').slice(0, 200),
            output: (c.output || '').slice(0, 100),
          })),
          microvm_id: microvmId || '',
          session_id: sessionId || '',
        }),
      })
      if (resp.ok) {
        const data = await resp.json()
        let code = data.response || ''
        // Extract code from markdown fences using regex (robust to whitespace/formatting)
        if (isSqlCell) {
          const sqlMatch = code.match(/```sql\s*\n?([\s\S]*?)```/i)
          if (sqlMatch?.[1]) {
            code = sqlMatch[1].trim()
          } else if (code.startsWith('```') && code.endsWith('```')) {
            code = code.split('\n').slice(1, -1).join('\n').trim()
          }
        } else {
          const pyMatch = code.match(/```python\s*\n?([\s\S]*?)```/i)
          if (pyMatch?.[1]) {
            code = pyMatch[1].trim()
          } else {
            // Fallback: AI may have returned SQL despite being told Python
            const anyMatch = code.match(/```(?:sql|javascript)?\s*\n?([\s\S]*?)```/i)
            if (anyMatch?.[1]) {
              code = anyMatch[1].trim()
            } else if (code.startsWith('```') && code.endsWith('```')) {
              code = code.split('\n').slice(1, -1).join('\n').trim()
            }
          }
        }
        if (code) {
          onCodeChange(code)
          setEditorVersion(v => v + 1)
        }
      }
    } catch (err) {
      console.warn('[generate] AI code generation failed:', err.message)
    }
    setGenerating(false)
  }

  return {
    aiResult,
    setAiResult,
    generating,
    editorVersion,
    smartExecute,
    handleAiExplain,
    handleAiFix,
    handleAiCancel,
    handleApplyFix,
  }
}
