import { useState, useRef, useEffect, useMemo } from 'react'
import { marked } from 'marked'
import { sanitizeHtml, sanitizeMarkdown } from '../services/sanitize'
import MarkdownCell from './MarkdownCell'
import CellEditor from './CellEditor'
import { IconPlay, IconPlus, IconTrash, IconX, IconStop, IconChevronDown, IconChevronRight, IconGripVertical, IconEraser, IconCode, IconDatabase, IconZap } from './Icons'
import { PROXY_URL } from '../config'
import SortableTable from './SortableTable'
import './Cell.css'
import './CellEditor.css'

// Derive a default variable name from SQL (based on the primary table being queried)
function deriveSqlVarName(sql) {
  if (!sql || !sql.trim()) return 'result'
  // Try to extract table name from FROM clause
  const fromMatch = sql.match(/\bFROM\s+dynamodb\."?([a-zA-Z_][\w\-]*)"?/i)
    || sql.match(/\bFROM\s+'\/tmp\/([^']+)'/i)
    || sql.match(/\bFROM\s+read_(?:csv|json|parquet)\('[^']*\/([^'/]+)'\)/i)
    || sql.match(/\bFROM\s+[a-zA-Z_]\w*\.([a-zA-Z_]\w*)/i)
    || sql.match(/\bFROM\s+([a-zA-Z_]\w*)/i)
  if (fromMatch) {
    const raw = fromMatch[1] || 'result'
    // Sanitize: remove extension, replace non-identifier chars with underscore
    const cleaned = raw.replace(/\.\w+$/, '').replace(/[^a-zA-Z0-9_]/g, '_').replace(/^_+|_+$/g, '')
    if (cleaned && /^[a-zA-Z_]/.test(cleaned)) return cleaned
  }
  return 'result'
}

// Ticking timer component for running cells
function ElapsedTimer() {
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    const start = Date.now()
    const interval = setInterval(() => {
      setElapsed(((Date.now() - start) / 1000).toFixed(1))
    }, 500)
    return () => clearInterval(interval)
  }, [])
  return <span className="cell-timer">{elapsed}s</span>
}

export default function Cell({
  cell,
  index,
  isConnected,
  isActive,
  isDragOver,
  hasSearchMatch,
  onFocus,
  onExecute,
  onInterrupt,
  onCodeChange,
  onOutputVarChange,
  onAddBelow,
  onInsertAbove,
  onSetAiExplanation,
  onDelete,
  onClearOutput,
  onTypeChange,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  searchQuery,
  searchActiveOccurrence,
  notebookContext,
  notebookName,
  microvmId,
  sessionId,
  aiAvailable,
  variables = {},
  dataSources = null,
}) {
  const [codeCollapsed, setCodeCollapsed] = useState(false)
  const [outputCollapsed, setOutputCollapsed] = useState(false)
  const [aiResult, setAiResult] = useState(
    cell.aiExplanation ? { type: 'explain', content: cell.aiExplanation, loading: false } : null
  )
  const [generating, setGenerating] = useState(false)
  const aiAbortRef = useRef(null) // { type: 'explain'|'fix', content: string, loading: boolean }

  // Sync aiResult when cell.aiExplanation changes externally (e.g. from Annotate button)
  useEffect(() => {
    if (cell.aiExplanation && (!aiResult || aiResult.content !== cell.aiExplanation)) {
      setAiResult({ type: 'explain', content: cell.aiExplanation, loading: false })
    }
  }, [cell.aiExplanation])

  // Variable names for autocomplete
  const variableNames = useMemo(() => Object.keys(variables || {}), [variables])

  // Datasource identifiers for autocomplete (table names, file paths, schemas)
  const dataSourceNames = useMemo(() => {
    if (!dataSources) return { items: [], schemas: {} }
    const items = []
    const schemas = {} // schema_name → [table_names]

    // S3 files — suggest the read_csv('s3://...') pattern
    if (dataSources.s3) {
      dataSources.s3.forEach(f => {
        const uri = f.uri || `s3://${f.bucket}/${f.key}`
        items.push({ label: uri, type: 's3', detail: 'S3 file' })
      })
    }

    // Local sandbox files — suggest '/tmp/filename'
    // (uploadedFiles come separately but we get them from the sidebar sync)

    // DynamoDB tables — schema is "dynamodb", table names need quotes
    if (dataSources.dynamodb) {
      items.push({ label: 'dynamodb', type: 'schema', detail: 'DynamoDB schema' })
      const dynTables = []
      dataSources.dynamodb.forEach(t => {
        const name = t.name || t.table_name || t
        const label = typeof name === 'string' ? name : String(name)
        dynTables.push(label)
        items.push({ label: `dynamodb."${label}"`, type: 'dynamodb', detail: 'DynamoDB table' })
      })
      schemas['dynamodb'] = dynTables
    }

    // Athena tables — schema is the database name (from API response)
    if (dataSources.athena && dataSources.athena.length > 0) {
      const dbName = dataSources.athena[0]?.database
      if (dbName) {
        items.push({ label: dbName, type: 'schema', detail: 'Athena database' })
        const athenaTables = []
        dataSources.athena.forEach(t => {
          const name = t.name || t.table_name || t
          const label = typeof name === 'string' ? name : String(name)
          athenaTables.push(label)
          items.push({ label, type: 'athena', detail: 'Athena table' })
          items.push({ label: `${dbName}.${label}`, type: 'athena', detail: 'Athena (qualified)' })
        })
        schemas[dbName] = athenaTables
      } else {
        // No database name — just add raw table names
        dataSources.athena.forEach(t => {
          const name = t.name || t.table_name || t
          const label = typeof name === 'string' ? name : String(name)
          items.push({ label, type: 'athena', detail: 'Athena table' })
        })
      }
    }

    return { items, schemas }
  }, [dataSources])

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
      const resp = await fetch(`${PROXY_URL}/ai/explain`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
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
      const resp = await fetch(`${PROXY_URL}/ai/fix`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          code: cell.code || '',
          error: cell.error || '',
          microvm_id: microvmId || '',
          session_id: sessionId || '',
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
      setAiResult(null)
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

      const resp = await fetch(`${PROXY_URL}/ai/chat/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: 'oneshot-generate',
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
        // Strip markdown fences based on cell type
        if (isSqlCell) {
          if (code.includes('```sql')) {
            code = code.split('```sql')[1]?.split('```')[0]?.trim() || code
          } else if (code.startsWith('```') && code.endsWith('```')) {
            code = code.split('\n').slice(1, -1).join('\n').trim()
          }
        } else {
          if (code.includes('```python')) {
            code = code.split('```python')[1]?.split('```')[0]?.trim() || code
          } else if (code.includes('```sql')) {
            // AI returned SQL despite being told Python — extract it anyway
            code = code.split('```sql')[1]?.split('```')[0]?.trim() || code
          } else if (code.startsWith('```') && code.endsWith('```')) {
            code = code.split('\n').slice(1, -1).join('\n').trim()
          }
        }
        if (code) onCodeChange(code)
      }
    } catch {}
    setGenerating(false)
  }

  const statusColor =
    cell.status === 'running' ? 'cell-running'
    : cell.status === 'success' ? 'cell-success'
    : cell.status === 'error' ? 'cell-error'
    : 'cell-idle'

  // --- MARKDOWN CELL ---
  if (cell.type === 'markdown') {
    return (
      <MarkdownCell
        cell={cell}
        isActive={isActive}
        isDragOver={isDragOver}
        hasSearchMatch={hasSearchMatch}
        searchQuery={searchQuery}
        onFocus={onFocus}
        onCodeChange={onCodeChange}
        onAddBelow={onAddBelow}
        onDelete={onDelete}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onDragEnd={onDragEnd}
      />
    )
  }

  // --- CODE CELL ---

  return (
    <div
      className={`cell ${statusColor} ${isActive ? 'cell-active' : ''} ${isDragOver ? 'cell-drag-over' : ''} ${hasSearchMatch ? 'cell-search-match' : ''} ${cell.type === 'sql' ? 'cell-sql' : ''}`}
      data-cell-id={cell.id}
      onClick={onFocus}
      onDragOver={(e) => { e.preventDefault(); onDragOver?.() }}
      onDrop={(e) => { e.preventDefault(); onDrop?.() }}
      onDragEnd={onDragEnd}
    >
      <div className="cell-gutter">
        <span
          className="cell-drag-handle"
          draggable
          onDragStart={onDragStart}
          title="Drag to reorder"
        >
          <IconGripVertical width={12} height={12} />
        </span>
        <button
          className="cell-collapse-btn"
          onClick={() => setCodeCollapsed(!codeCollapsed)}
          title={codeCollapsed ? 'Expand code' : 'Collapse code'}
        >
          {codeCollapsed ? <IconChevronRight width={12} height={12} /> : <IconChevronDown width={12} height={12} />}
        </button>
        <span className="cell-number">
          {cell.executionNumber ? `[${cell.executionNumber}]` : `[${index + 1}]`}
        </span>
        <span className={`cell-type-badge ${cell.type === 'sql' ? 'cell-type-sql' : 'cell-type-code'}`} title={cell.type === 'sql' ? 'SQL cell' : 'Python cell'}>
          {cell.type === 'sql'
            ? <IconDatabase width={10} height={10} />
            : <IconCode width={10} height={10} />
          }
        </span>
        {cell.status === 'running' && <ElapsedTimer />}
        {cell.lastExecutedCode != null && cell.code !== cell.lastExecutedCode && cell.status !== 'running' && (
          <span className="cell-stale-badge" title="Code modified since last execution — re-run to update output">●</span>
        )}
      </div>

      <div className="cell-content">
        {/* Collapsed code summary */}
        {codeCollapsed && (
          <div className="cell-collapsed-summary" onClick={() => setCodeCollapsed(false)}>
            <span className="cell-collapsed-text">
              {cell.code.split('\n')[0].slice(0, 80)}{cell.code.split('\n').length > 1 ? '...' : ''}
            </span>
            <span className="cell-collapsed-lines">{cell.code.split('\n').length} lines</span>
          </div>
        )}

        {/* Code editor */}
        {!codeCollapsed && (
          <div className="cell-input">
            {/* SQL output variable name */}
            {cell.type === 'sql' && (
              <div className="sql-output-var">
                <span className="sql-output-var-label">→</span>
                <input
                  className="sql-output-var-input"
                  type="text"
                  value={cell.outputVariable || ''}
                  onChange={(e) => onOutputVarChange && onOutputVarChange(e.target.value)}
                  placeholder={deriveSqlVarName(cell.code)}
                  title="Variable name for the query result (accessible in subsequent cells)"
                  spellCheck={false}
                />
              </div>
            )}
            <CellEditor
              code={cell.code}
              language={cell.type === 'sql' ? 'sql' : 'python'}
              placeholder={cell.type === 'sql'
                ? 'Write SQL or describe what you want... (Shift+Enter runs or generates)'
                : 'Type Python code or describe what you want in plain English... (Shift+Enter runs code or generates from NLP)'}
              onCodeChange={onCodeChange}
              onExecute={smartExecute}
              onFocus={onFocus}
              variables={variableNames}
              dataSources={dataSourceNames}
              sessionId={sessionId}
              searchQuery={searchQuery}
            />
            <div className="cell-actions">
              {cell.status === 'running' || generating ? (
                <button
                  className="cell-run-btn cell-stop-btn"
                  onClick={generating ? () => {} : onInterrupt}
                  title={generating ? 'Generating code...' : 'Stop execution'}
                >
                  {generating ? <span className="cell-gen-spinner" /> : <IconStop width={12} height={12} />}
                </button>
              ) : (
                <button
                  className="cell-run-btn"
                  onClick={smartExecute}
                  disabled={!isConnected || cell.status === 'running'}
                  title="Run cell (Shift+Enter)"
                >
                  <IconPlay width={12} height={12} />
                </button>
              )}
              <button className="cell-action-btn" onClick={(e) => { e.stopPropagation(); onAddBelow('code') }} title="Add code cell below">
                <IconCode width={14} height={14} />
              </button>
              <button className="cell-action-btn cell-add-sql-btn" onClick={(e) => { e.stopPropagation(); onAddBelow('sql') }} title="Add SQL cell below">
                <IconDatabase width={12} height={12} />
              </button>
              <button className="cell-action-btn cell-add-md-btn" onClick={(e) => { e.stopPropagation(); onAddBelow('markdown') }} title="Add text cell below">
                M
              </button>
              <button className="cell-action-btn cell-delete-btn" onClick={(e) => { e.stopPropagation(); onDelete() }} title="Delete cell">
                <IconTrash width={14} height={14} />
              </button>
              {isConnected && aiAvailable && cell.code?.trim() && (() => {
                if (cell.error) {
                  return (
                    <button
                      className="cell-action-btn cell-ai-action-btn cell-ai-fix-btn"
                      onClick={(e) => { e.stopPropagation(); handleAiFix() }}
                      disabled={aiResult?.loading}
                      title="Fix error with AI"
                    >🔧</button>
                  )
                }
                // Show explain button only when content looks like actual code/SQL
                const code = cell.code.trim()
                const looksLikeCode = /^(import |from |def |class |for |while |if |#|[a-zA-Z_]\w*\s*[=([]|print\(|plt\.|pd\.|np\.)/.test(code) || code.includes('=') || code.includes('(')
                const looksLikeSql = /^(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|WITH|SHOW|DESCRIBE|EXPLAIN)\b/i.test(code) || code.trimStart().startsWith('--')
                if (looksLikeCode || looksLikeSql) {
                  return (
                    <button
                      className="cell-action-btn cell-ai-action-btn"
                      onClick={(e) => { e.stopPropagation(); handleAiExplain() }}
                      disabled={aiResult?.loading}
                      title="Auto-annotate cell with AI explanation"
                    ><IconZap width={12} height={12} /></button>
                  )
                }
                return null
              })()}
            </div>
          </div>
        )}

        {(cell.output || cell.error || cell.html || cell.image) && (
          <div className={`cell-output ${cell.error ? 'cell-output-error' : ''} ${outputCollapsed ? 'cell-output-collapsed' : ''}`}>
            {outputCollapsed ? (
              <div className="cell-output-collapse-bar" onClick={() => setOutputCollapsed(false)}>
                <IconChevronRight width={10} height={10} />
                <span>Output hidden — click to expand</span>
              </div>
            ) : (
              <>
                <div className="cell-output-collapse-bar" onClick={() => setOutputCollapsed(true)}>
                  <IconChevronDown width={10} height={10} />
                  <span>Output</span>
                  <div className="cell-output-actions" onClick={(e) => e.stopPropagation()}>
                    <div className="cell-output-export-wrap">
                      <button className="cell-output-action-btn" title="Export output" onClick={(e) => {
                        e.stopPropagation()
                        const menu = e.currentTarget.nextElementSibling
                        menu.style.display = menu.style.display === 'block' ? 'none' : 'block'
                      }}>
                        <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Export
                      </button>
                      <div className="cell-output-export-menu" style={{ display: 'none' }}>
                        <button onClick={() => {
                          const filename = `${(notebookName || 'notebook').replace(/\s+/g, '-')}-cell-${index + 1}-output.html`
                          let htmlContent = `<html><head><meta charset="UTF-8"><title>${notebookName || 'Notebook'} — Cell ${index + 1}</title><style>body{font-family:system-ui;padding:20px;max-width:900px;margin:0 auto}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:8px;text-align:left}th{background:#f5f5f5;font-weight:600}pre{background:#f5f5f5;padding:12px;border-radius:4px;overflow-x:auto;font-size:13px}details{margin-bottom:16px;border:1px solid #e0e0e0;border-radius:4px}summary{padding:8px 12px;cursor:pointer;font-weight:600;font-size:13px;color:#555}details pre{margin:0;border-radius:0 0 4px 4px;border-top:1px solid #e0e0e0}img{max-width:100%}h3{color:#333;margin-top:0}</style></head><body>`
                          htmlContent += `<h3>${notebookName || 'Notebook'} — Cell ${index + 1} Output</h3>`
                          htmlContent += `<details><summary>Code</summary><pre>${(cell.code || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre></details>`
                          if (cell.output) htmlContent += `<pre>${cell.output}</pre>`
                          if (cell.html) htmlContent += cell.html
                          if (cell.image) htmlContent += `<img src="${cell.image}" alt="Plot output"/>`
                          htmlContent += `<hr style="margin-top:32px;border:none;border-top:1px solid #e0e0e0"><footer style="text-align:center;padding:12px;color:#888;font-size:11px"><strong>Lambda MicroVM Notebook</strong><br>Developed by the AWS Startup SA Team<br>&copy; ${new Date().getFullYear()} Amazon Web Services, Inc.</footer>`
                          htmlContent += '</body></html>'
                          const blob = new Blob([htmlContent], { type: 'text/html' })
                          const url = URL.createObjectURL(blob)
                          const a = document.createElement('a')
                          a.href = url; a.download = filename; a.click()
                          URL.revokeObjectURL(url)
                        }}>HTML</button>
                        <button onClick={() => {
                          const filename = `${(notebookName || 'notebook').replace(/\s+/g, '-')}-cell-${index + 1}-output.md`
                          let md = `# ${notebookName || 'Notebook'} — Cell ${index + 1}\n\n`
                          md += `<details><summary>Code</summary>\n\n\`\`\`python\n${cell.code || ''}\n\`\`\`\n</details>\n\n`
                          md += `## Output\n\n`
                          if (cell.output) md += `\`\`\`\n${cell.output}\n\`\`\`\n\n`
                          if (cell.html) md += `*(DataFrame table — export as HTML for full rendering)*\n\n`
                          if (cell.image) md += `![Plot output](plot.png)\n\n`
                          if (!cell.output && !cell.html && !cell.image) md += '*(empty output)*\n'
                          md += `\n---\n\n*Lambda MicroVM Notebook — Developed by the AWS Startup SA Team*\n`
                          const blob = new Blob([md], { type: 'text/markdown' })
                          const url = URL.createObjectURL(blob)
                          const a = document.createElement('a')
                          a.href = url; a.download = filename; a.click()
                          URL.revokeObjectURL(url)
                        }}>Markdown</button>
                      </div>
                    </div>
                    {onClearOutput && (
                      <button className="cell-output-action-btn" onClick={() => onClearOutput()} title="Clear output">
                        <IconEraser width={11} height={11} /> Clear
                      </button>
                    )}
                  </div>
                </div>
                {cell.image && (
                  <div className="output-image">
                    <img src={cell.image} alt="Plot output" />
                  </div>
                )}
                {cell.output && <pre className="output-text">{cell.output}</pre>}
                {cell.html && (
                  cell.html.includes('data-plotly="true"') ? (
                    <div className="output-plotly">
                      <iframe
                        srcDoc={cell.html}
                        sandbox="allow-scripts"
                        style={{ width: '100%', height: '600px', border: 'none', borderRadius: '8px' }}
                        title="Plotly Chart"
                        onLoad={(e) => {
                          // Auto-resize iframe to fit content
                          try {
                            const doc = e.target.contentDocument || e.target.contentWindow.document
                            const h = doc.body.scrollHeight
                            if (h > 100) e.target.style.height = `${h + 20}px`
                          } catch (err) { /* sandbox may block access */ }
                        }}
                      />
                    </div>
                  ) : (
                    <SortableTable html={cell.html} sanitizer={sanitizeHtml} />
                  )
                )}
                {cell.error && <pre className="output-error">{cell.error}</pre>}
                {cell.executionTime != null && (
                  <div className="output-meta">
                    Executed in {cell.executionTime.toFixed(1)}ms
              </div>
            )}
              </>
            )}
          </div>
        )}

        {/* AI Result (explain or fix preview) — shown outside output section */}
        {aiResult?.loading && (
          <div className="cell-ai-result cell-ai-loading">
            <span className="cell-ai-spinner" />
            <span className="cell-ai-loading-text">{aiResult.type === 'fix' ? 'Fixing...' : 'Explaining...'}</span>
            <button className="cell-ai-cancel-btn" onClick={handleAiCancel}>Cancel</button>
          </div>
        )}
        {aiResult && !aiResult.loading && (
          <div className={`cell-ai-result cell-ai-result-${aiResult.type}`}>
            <div className="cell-ai-result-header">
              <span className="cell-ai-badge">✨ AI</span>
              <button className="cell-ai-dismiss" onClick={() => { setAiResult(null); if (onSetAiExplanation) onSetAiExplanation(null) }}>
                <IconX width={10} height={10} />
              </button>
            </div>
            {aiResult.type === 'explain' && (
              <div className="cell-ai-explain-text" dangerouslySetInnerHTML={{ __html: sanitizeMarkdown(marked.parse(aiResult.content, { breaks: true })) }} />
            )}
            {aiResult.type === 'fix' && aiResult.content && (
              <div className="cell-ai-fix-preview">
                <pre className="cell-ai-fix-code">{aiResult.content}</pre>
                <div className="cell-ai-fix-actions">
                  <button className="cell-ai-apply-btn" onClick={handleApplyFix}>Apply Fix</button>
                  <button className="cell-ai-dismiss-btn" onClick={() => setAiResult(null)}>Dismiss</button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
