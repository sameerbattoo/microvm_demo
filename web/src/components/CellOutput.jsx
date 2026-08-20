import { sanitizeHtml } from '../services/sanitize'
import SortableTable from './SortableTable'

/**
 * CellOutput — renders a cell's execution output (image, text, Plotly chart, HTML
 * table, error, and timing). Presentational and read-only; extracted from Cell.jsx
 * so both the notebook editor and (later) App mode can share the same renderers.
 *
 * Pass onFix (+ aiBusy/aiFixing) to show the inline "Fix with AI" button on errors;
 * omit onFix for a purely read-only render (e.g. App mode).
 */
export default function CellOutput({ cell, isConnected = false, onFix = null, aiBusy = false, aiFixing = false }) {
  return (
    <>
      {cell.image && (
        <div className="output-image">
          <img src={cell.image} alt="Plot output" />
        </div>
      )}
      {cell.output && (
        <pre className="output-text">{cell.output}</pre>
      )}
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
      {cell.error && (
        <div className="output-error-wrap">
          <pre className="output-error">{cell.error}</pre>
          {onFix && isConnected && (
            <button className="output-error-fix-btn" onClick={onFix} disabled={aiBusy} title="Fix this error with AI">
              {aiFixing ? 'Fixing...' : '⚡ Fix'}
            </button>
          )}
        </div>
      )}
      {cell.executionTime != null && (
        <div className="output-meta">
          Executed in {cell.executionTime.toFixed(1)}ms
        </div>
      )}
    </>
  )
}
