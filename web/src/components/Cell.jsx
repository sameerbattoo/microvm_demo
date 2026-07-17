import { useState, useRef, useEffect, useCallback } from 'react'
import Prism from 'prismjs'
import 'prismjs/components/prism-python'
import { marked } from 'marked'
import { IconPlay, IconPlus, IconTrash, IconSparkles, IconCode, IconCheck, IconX, IconStop, IconChevronDown, IconChevronRight, IconGripVertical } from './Icons'
import { PROXY_URL } from '../config'
import './Cell.css'

// Ticking timer component for running cells
function ElapsedTimer() {
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    const start = Date.now()
    const interval = setInterval(() => {
      setElapsed(((Date.now() - start) / 1000).toFixed(1))
    }, 100)
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
  onDelete,
  onTypeChange,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  searchQuery,
  searchActiveOccurrence,
  notebookContext,
  microvmEndpoint,
  aiAvailable,
}) {
  const aiInputRef = useRef(null)
  const textareaRef = useRef(null)
  const mdTextareaRef = useRef(null)
  const [mode, setMode] = useState('code') // 'code' | 'ai'
  const [mdEditing, setMdEditing] = useState(!cell.code) // markdown cells start in edit mode if empty
  const [codeCollapsed, setCodeCollapsed] = useState(false)
  const [outputCollapsed, setOutputCollapsed] = useState(false)
  const [aiPrompt, setAiPrompt] = useState('')
  const [aiGenerating, setAiGenerating] = useState(false)
  const [aiPreview, setAiPreview] = useState(null) // generated code awaiting accept/discard
  const [aiError, setAiError] = useState(null)

  // Focus AI input when switching to AI mode
  useEffect(() => {
    if (mode === 'ai' && aiInputRef.current) {
      aiInputRef.current.focus()
    }
  }, [mode])

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current
    if (el) {
      el.style.height = 'auto'
      el.style.height = `${el.scrollHeight}px`
    }
  }, [cell.code, mode, codeCollapsed])

  // Auto-resize markdown textarea
  useEffect(() => {
    const el = mdTextareaRef.current
    if (el && mdEditing) {
      el.style.height = 'auto'
      el.style.height = `${el.scrollHeight}px`
    }
  }, [cell.code, mdEditing])

  const highlightCode = useCallback((code) => {
    if (!code) return ''
    let html = Prism.highlight(code, Prism.languages.python, 'python')
    // Add search highlighting on top of syntax highlighting
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
  }, [searchQuery, searchActiveOccurrence])

  const handleKeyDown = (e) => {
    // Shift+Enter to execute
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault()
      onExecute()
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

  const handleAiGenerate = async () => {
    if (!aiPrompt.trim() || !microvmEndpoint) return

    setAiGenerating(true)
    setAiError(null)
    setAiPreview(null)

    // AI endpoints live on the proxy or local backend
    const aiBase = microvmEndpoint.includes(PROXY_URL)
      ? PROXY_URL
      : microvmEndpoint

    try {
      // Build context from prior cells
      const context = notebookContext || []
      const variables = []

      const response = await fetch(`${aiBase}/ai/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: aiPrompt,
          notebook_context: context.slice(0, index).map((c, i) => ({
            code: c.code || '',
            output: c.output || '',
            html: c.html || '',
            index: i,
          })),
          current_cell_code: cell.code || '',
          cell_index: index,
          variables,
        }),
      })

      const result = await response.json()

      if (result.success && result.code) {
        setAiPreview(result.code)
      } else {
        setAiError(result.error || 'Failed to generate code')
      }
    } catch (err) {
      setAiError(`Connection error: ${err.message}`)
    }

    setAiGenerating(false)
  }

  const handleAiAccept = () => {
    onCodeChange(aiPreview)
    setAiPreview(null)
    setAiPrompt('')
    setMode('code')
  }

  const handleAiDiscard = () => {
    setAiPreview(null)
  }

  const handleAiKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleAiGenerate()
    }
    if (e.key === 'Escape') {
      setMode('code')
      setAiPreview(null)
      setAiError(null)
    }
  }

  const statusColor =
    cell.status === 'running' ? 'cell-running'
    : cell.status === 'success' ? 'cell-success'
    : cell.status === 'error' ? 'cell-error'
    : 'cell-idle'

  // --- MARKDOWN CELL ---
  if (cell.type === 'markdown') {
    return (
      <div
        className={`cell cell-markdown ${isActive ? 'cell-active' : ''} ${isDragOver ? 'cell-drag-over' : ''} ${hasSearchMatch ? 'cell-search-match' : ''}`}
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
          <span className="cell-type-badge">MD</span>
        </div>
        <div className="cell-content">
          {mdEditing ? (
            <div className="md-edit-area">
              <textarea
                ref={mdTextareaRef}
                className="md-textarea"
                value={cell.code}
                onChange={(e) => onCodeChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape' || (e.key === 'Enter' && e.shiftKey)) {
                    e.preventDefault()
                    setMdEditing(false)
                  }
                }}
                placeholder="Write markdown here... (Shift+Enter or Esc to render)"
                spellCheck={true}
                autoFocus
              />
              <div className="md-edit-hint">Shift+Enter to render · Esc to close</div>
            </div>
          ) : (
            <div
              className="md-rendered"
              onDoubleClick={() => setMdEditing(true)}
              dangerouslySetInnerHTML={{ __html: cell.code ? marked.parse(cell.code) : '<p class="md-placeholder">Double-click to edit markdown</p>' }}
            />
          )}
          <div className="cell-actions md-actions">
            {mdEditing ? (
              <button className="cell-action-btn" onClick={() => setMdEditing(false)} title="Render markdown">
                <IconCheck width={14} height={14} />
              </button>
            ) : (
              <button className="cell-action-btn" onClick={() => setMdEditing(true)} title="Edit markdown">
                <IconCode width={14} height={14} />
              </button>
            )}
            <button className="cell-action-btn" onClick={() => onAddBelow('code')} title="Add code cell below">
              <IconPlus width={14} height={14} />
            </button>
            <button className="cell-action-btn cell-add-md-btn" onClick={() => onAddBelow('markdown')} title="Add text cell below">
              M
            </button>
            <button className="cell-action-btn cell-delete-btn" onClick={onDelete} title="Delete cell">
              <IconTrash width={14} height={14} />
            </button>
          </div>
        </div>
      </div>
    )
  }

  // --- CODE CELL ---

  return (
    <div
      className={`cell ${statusColor} ${mode === 'ai' ? 'cell-ai-mode' : ''} ${isActive ? 'cell-active' : ''} ${isDragOver ? 'cell-drag-over' : ''} ${hasSearchMatch ? 'cell-search-match' : ''}`}
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

        {/* Mode toggle — only show if AI is available */}
        {aiAvailable && (
          <div className="cell-mode-bar">
            <div className="cell-mode-toggle">
              <button
                className={`mode-toggle-btn ${mode === 'code' ? 'mode-toggle-active' : ''}`}
                onClick={() => { setMode('code'); setAiPreview(null); setAiError(null); }}
                title="Code mode"
              >
                <IconCode width={11} height={11} /> Code
              </button>
              <button
                className={`mode-toggle-btn mode-toggle-ai ${mode === 'ai' ? 'mode-toggle-active' : ''}`}
                onClick={() => setMode('ai')}
                title="AI generate mode (describe what you want)"
              >
                <IconSparkles width={11} height={11} /> AI
              </button>
            </div>
          </div>
        )}

        {/* Code mode — normal editor */}
        {(mode === 'code' || !aiAvailable) && !codeCollapsed && (
          <div className="cell-input">
            <div className="cell-editor-wrapper">
              <pre
                className="cell-editor-highlight"
                aria-hidden="true"
                dangerouslySetInnerHTML={{ __html: highlightCode(cell.code) + '\n' }}
              />
              <textarea
                ref={textareaRef}
                className="cell-editor-textarea"
                value={cell.code}
                onChange={(e) => onCodeChange(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Type Python code... (Shift+Enter to run)"
                spellCheck={false}
                rows={1}
              />
            </div>
            <div className="cell-actions">
              {cell.status === 'running' ? (
                <button
                  className="cell-run-btn cell-stop-btn"
                  onClick={onInterrupt}
                  title="Stop execution"
                >
                  <IconStop width={12} height={12} />
                </button>
              ) : (
                <button
                  className="cell-run-btn"
                  onClick={onExecute}
                  disabled={!isConnected || cell.status === 'running'}
                  title="Run cell (Shift+Enter)"
                >
                  <IconPlay width={12} height={12} />
                </button>
              )}
              <button className="cell-action-btn" onClick={() => onAddBelow('code')} title="Add code cell below">
                <IconPlus width={14} height={14} />
              </button>
              <button className="cell-action-btn cell-add-md-btn" onClick={() => onAddBelow('markdown')} title="Add text cell below">
                M
              </button>
              <button className="cell-action-btn cell-delete-btn" onClick={onDelete} title="Delete cell">
                <IconTrash width={14} height={14} />
              </button>
            </div>
          </div>
        )}

        {/* AI mode — prompt input + preview */}
        {mode === 'ai' && aiAvailable && (
          <div className="cell-ai">
            <div className="ai-prompt-area">
              <textarea
                ref={aiInputRef}
                className="ai-prompt-input"
                value={aiPrompt}
                onChange={(e) => setAiPrompt(e.target.value)}
                onKeyDown={handleAiKeyDown}
                placeholder="Describe what you want this cell to do... (Enter to generate, Esc to cancel)"
                spellCheck={false}
                rows={2}
              />
              <div className="ai-prompt-actions">
                <button
                  className="ai-generate-btn"
                  onClick={handleAiGenerate}
                  disabled={!aiPrompt.trim() || aiGenerating || !isConnected}
                >
                                    {aiGenerating ? 'Generating...' : <><IconSparkles width={13} height={13} /> Generate</>}
                </button>
              </div>
            </div>

            {/* AI preview — show generated code with accept/discard */}
            {aiPreview && (
              <div className="ai-preview">
                <div className="ai-preview-header">
                  <span className="ai-preview-label">Generated Code</span>
                  <div className="ai-preview-actions">
                    <button className="ai-accept-btn" onClick={handleAiAccept}>
                      <IconCheck width={12} height={12} /> Accept
                    </button>
                    <button className="ai-discard-btn" onClick={handleAiDiscard}>
                      <IconX width={12} height={12} /> Discard
                    </button>
                  </div>
                </div>
                <pre className="ai-preview-code">{aiPreview}</pre>
              </div>
            )}

            {/* AI error */}
            {aiError && (
              <div className="ai-error">{aiError}</div>
            )}

            {/* Cell actions in AI mode */}
            <div className="cell-actions cell-actions-ai">
              <button className="cell-action-btn" onClick={() => onAddBelow('code')} title="Add code cell below">
                <IconPlus width={14} height={14} />
              </button>
              <button className="cell-action-btn cell-add-md-btn" onClick={() => onAddBelow('markdown')} title="Add text cell below">
                M
              </button>
              <button className="cell-action-btn cell-delete-btn" onClick={onDelete} title="Delete cell">
                <IconTrash width={14} height={14} />
              </button>
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
                </div>
                {cell.image && (
                  <div className="output-image">
                    <img src={cell.image} alt="Plot output" />
                  </div>
                )}
                {cell.output && <pre className="output-text">{cell.output}</pre>}
                {cell.html && (
                  <div className="output-html" dangerouslySetInnerHTML={{ __html: cell.html }} />
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
      </div>
    </div>
  )
}
