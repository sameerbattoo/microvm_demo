import { useRef, useEffect } from 'react'
import './Cell.css'

export default function Cell({
  cell,
  index,
  isConnected,
  onExecute,
  onCodeChange,
  onAddBelow,
  onDelete,
}) {
  const textareaRef = useRef(null)

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current
    if (el) {
      el.style.height = 'auto'
      el.style.height = `${el.scrollHeight}px`
    }
  }, [cell.code])

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
      // Move cursor after indent
      setTimeout(() => {
        e.target.selectionStart = e.target.selectionEnd = start + 4
      }, 0)
    }
  }

  const statusColor =
    cell.status === 'running' ? 'cell-running'
    : cell.status === 'success' ? 'cell-success'
    : cell.status === 'error' ? 'cell-error'
    : 'cell-idle'

  return (
    <div className={`cell ${statusColor}`}>
      <div className="cell-gutter">
        <span className="cell-number">
          {cell.executionNumber ? `[${cell.executionNumber}]` : `[${index + 1}]`}
        </span>
        {cell.status === 'running' && <span className="cell-spinner" />}
      </div>

      <div className="cell-content">
        <div className="cell-input">
          <textarea
            ref={textareaRef}
            className="cell-editor"
            value={cell.code}
            onChange={(e) => onCodeChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type Python code... (Shift+Enter to run)"
            spellCheck={false}
            rows={1}
          />
          <div className="cell-actions">
            <button
              className="cell-run-btn"
              onClick={onExecute}
              disabled={!isConnected || cell.status === 'running'}
              title="Run cell (Shift+Enter)"
            >
              ▶
            </button>
            <button className="cell-action-btn" onClick={onAddBelow} title="Add cell below">
              +
            </button>
            <button className="cell-action-btn cell-delete-btn" onClick={onDelete} title="Delete cell">
              🗑
            </button>
          </div>
        </div>

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
