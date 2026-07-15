import { useState, useRef, useEffect, useCallback } from 'react'
import Prism from 'prismjs'
import 'prismjs/components/prism-python'
import { IconPlay, IconPlus, IconTrash, IconSparkles, IconCode, IconCheck, IconX } from './Icons'
import './Cell.css'

export default function Cell({
  cell,
  index,
  isConnected,
  isActive,
  onFocus,
  onExecute,
  onCodeChange,
  onAddBelow,
  onDelete,
  notebookContext,
  microvmEndpoint,
  aiAvailable,
}) {
  const aiInputRef = useRef(null)
  const textareaRef = useRef(null)
  const [mode, setMode] = useState('code') // 'code' | 'ai'
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
  }, [cell.code, mode])

  const highlightCode = useCallback((code) => {
    if (!code) return ''
    return Prism.highlight(code, Prism.languages.python, 'python')
  }, [])

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

    // AI endpoints live on the proxy (8081) or local backend (8080)
    const aiBase = microvmEndpoint.includes('8081')
      ? 'http://localhost:8081'
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

  return (
    <div
      className={`cell ${statusColor} ${mode === 'ai' ? 'cell-ai-mode' : ''} ${isActive ? 'cell-active' : ''}`}
      onClick={onFocus}
    >
      <div className="cell-gutter">
        <span className="cell-number">
          {cell.executionNumber ? `[${cell.executionNumber}]` : `[${index + 1}]`}
        </span>
        {cell.status === 'running' && <span className="cell-spinner" />}
      </div>

      <div className="cell-content">
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
        {(mode === 'code' || !aiAvailable) && (
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
              <button
                className="cell-run-btn"
                onClick={onExecute}
                disabled={!isConnected || cell.status === 'running'}
                title="Run cell (Shift+Enter)"
              >
                <IconPlay width={12} height={12} />
              </button>
              <button className="cell-action-btn" onClick={onAddBelow} title="Add cell below">
                <IconPlus width={14} height={14} />
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
              <button className="cell-action-btn" onClick={onAddBelow} title="Add cell below">
                <IconPlus width={14} height={14} />
              </button>
              <button className="cell-action-btn cell-delete-btn" onClick={onDelete} title="Delete cell">
                <IconTrash width={14} height={14} />
              </button>
            </div>
          </div>
        )}

        {(cell.output || cell.error || cell.html || cell.image) && (
          <div className={`cell-output ${cell.error ? 'cell-output-error' : ''}`}>
            {cell.image && (
              <div className="output-image">
                <img src={cell.image} alt="Plot output" />
              </div>
            )}
            {cell.html && (
              <div className="output-html" dangerouslySetInnerHTML={{ __html: cell.html }} />
            )}
            {cell.output && <pre className="output-text">{cell.output}</pre>}
            {cell.error && <pre className="output-error">{cell.error}</pre>}
            {cell.executionTime != null && (
              <div className="output-meta">
                Executed in {cell.executionTime.toFixed(1)}ms
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
