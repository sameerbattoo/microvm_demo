import { useState, useRef, useEffect, useMemo } from 'react'
import Prism from 'prismjs'
import 'prismjs/components/prism-python'
import { marked } from 'marked'
import { sanitizeHtml, sanitizeMarkdown } from '../services/sanitize'
import MarkdownCell from './MarkdownCell'
import { IconPlay, IconPlus, IconTrash, IconX, IconStop, IconChevronDown, IconChevronRight, IconGripVertical, IconEraser } from './Icons'
import { PROXY_URL } from '../config'
import './Cell.css'

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
  microvmId,
  microvmRealEndpoint,
  aiAvailable,
}) {
  const textareaRef = useRef(null)
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

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current
    if (el) {
      el.style.height = 'auto'
      el.style.height = `${el.scrollHeight}px`
    }
  }, [cell.code, codeCollapsed])

  const highlightedHtml = useMemo(() => {
    if (!cell.code) return ''
    let html = Prism.highlight(cell.code, Prism.languages.python, 'python')
    if (searchQuery && searchQuery.trim()) {
      const escaped = searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const regex = new RegExp(`(${escaped})`, 'gi')
      let occurrenceIdx = 0
      html = html.replace(regex, (match) => {
        const cls = occurrenceIdx === searchActiveOccurrence
          ? 'search-highlight search-highlight-active'
          : 'search-highlight'
        occurrenceIdx++
        return `<mark class="${cls}">${match}</mark>`
      })
    }
    return html
  }, [cell.code, searchQuery, searchActiveOccurrence])

  // Smart execute: detects NLP vs code and routes accordingly
  const smartExecute = () => {
    const code = (cell.code || '').trim()
    if (code && aiAvailable && isConnected) {
      const looksLikeCode = /^(import |from |def |class |for |while |if |#|[a-zA-Z_]\w*\s*[=([]|print\(|plt\.|pd\.|np\.)/.test(code) || code.includes('=') || code.includes('(')
      if (!looksLikeCode && !generating) {
        handleGenerate()
        return
      }
    }
    onExecute()
  }

  const handleKeyDown = (e) => {
    // Shift+Enter to execute (or generate if content looks like NLP)
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault()
      smartExecute()
    }
    // Tab to indent
    if (e.key === 'Tab') {
      e.preventDefault()
      const start = e.target.selectionStart
      const end = e.target.selectionEnd
      const val = e.target.value
      onCodeChange(val.substring(0, start) + '    ' + val.substring(end))
      setTimeout(() => {
        e.target.selectionStart = e.target.selectionEnd = start + 4
      }, 0)
    }
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
          microvm_endpoint: microvmRealEndpoint || '',
        }),
      })
      if (resp.ok) {
        const data = await resp.json()
        const explanation = data.explanation || 'No explanation'
        setAiResult({ type: 'explain', content: explanation, loading: false })
        if (onSetAiExplanation) onSetAiExplanation(explanation)
        // Insert a short markdown summary above if no markdown cell exists above
        if (onInsertAbove && data.summary) {
          onInsertAbove(data.summary)
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
          microvm_endpoint: microvmRealEndpoint || '',
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
      const resp = await fetch(`${PROXY_URL}/ai/chat/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: 'oneshot-generate',
          message: `Generate Python code for the following request. Return ONLY the code, no explanations:\n\n${cell.code}`,
          active_cell_index: index,
          cells: (notebookContext || []).slice(0, index).map(c => ({
            type: c.type || 'code',
            code: (c.code || '').slice(0, 200),
            output: (c.output || '').slice(0, 100),
          })),
          microvm_id: microvmId || '',
          microvm_endpoint: microvmRealEndpoint || '',
        }),
      })
      if (resp.ok) {
        const data = await resp.json()
        let code = data.response || ''
        // Strip markdown fences if present
        if (code.includes('```python')) {
          code = code.split('```python')[1]?.split('```')[0]?.trim() || code
        } else if (code.startsWith('```') && code.endsWith('```')) {
          code = code.split('\n').slice(1, -1).join('\n').trim()
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
      className={`cell ${statusColor} ${isActive ? 'cell-active' : ''} ${isDragOver ? 'cell-drag-over' : ''} ${hasSearchMatch ? 'cell-search-match' : ''}`}
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
            <div className="cell-editor-wrapper">
              <pre
                className="cell-editor-highlight"
                aria-hidden="true"
                dangerouslySetInnerHTML={{ __html: sanitizeHtml(highlightedHtml + '\n') }}
              />
              <textarea
                ref={textareaRef}
                className="cell-editor-textarea"
                value={cell.code}
                onChange={(e) => onCodeChange(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Type Python code or describe what you want in plain English... (Shift+Enter runs code or generates from NLP)"
                spellCheck={false}
                rows={1}
              />
            </div>
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
                <IconPlus width={14} height={14} />
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
                // Show explain button only when content looks like actual code
                const code = cell.code.trim()
                const looksLikeCode = /^(import |from |def |class |for |while |if |#|[a-zA-Z_]\w*\s*[=([]|print\(|plt\.|pd\.|np\.)/.test(code) || code.includes('=') || code.includes('(')
                if (looksLikeCode) {
                  return (
                    <button
                      className="cell-action-btn cell-ai-action-btn"
                      onClick={(e) => { e.stopPropagation(); handleAiExplain() }}
                      disabled={aiResult?.loading}
                      title="Explain with AI"
                    >💡</button>
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
                  {onClearOutput && (
                    <button className="cell-output-clear-btn" onClick={(e) => { e.stopPropagation(); onClearOutput() }} title="Clear output">
                      <IconEraser width={11} height={11} /> Clear
                    </button>
                  )}
                </div>
                {cell.image && (
                  <div className="output-image">
                    <img src={cell.image} alt="Plot output" />
                  </div>
                )}
                {cell.output && <pre className="output-text">{cell.output}</pre>}
                {cell.html && (
                  <div className="output-html" dangerouslySetInnerHTML={{ __html: sanitizeHtml(cell.html) }} />
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
