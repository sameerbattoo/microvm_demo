import { useState, useEffect } from 'react'
import Modal from './Modal'
import SortableTable from './SortableTable'
import JsonTree from './JsonTree'
import { sanitizeHtml } from '../services/sanitize'

// Standalone full-grid viewer for a single variable. Fetches /variable-detail
// itself (schema + head(N) table_html) so it can be opened from either the
// Variables panel or directly from a notebook cell's "variables defined here"
// chips. For tabular values it renders a sortable grid; for everything else it
// falls back to the repr text the backend returns.
export default function VariableDetailModal({ name, endpoint, sessionId, onClose }) {
  const [state, setState] = useState({ loading: true, data: null, error: null })

  useEffect(() => {
    if (!name || !endpoint) return
    let cancelled = false
    setState({ loading: true, data: null, error: null })
    ;(async () => {
      try {
        const headers = { 'Content-Type': 'application/json' }
        if (sessionId) headers['X-Session-Id'] = sessionId
        const resp = await fetch(`${endpoint}/variable-detail`, {
          method: 'POST', headers, body: JSON.stringify({ name }),
        })
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
        const data = await resp.json()
        if (!cancelled) setState({ loading: false, data, error: null })
      } catch (err) {
        if (!cancelled) setState({ loading: false, data: null, error: err.message })
      }
    })()
    return () => { cancelled = true }
  }, [name, endpoint, sessionId])

  const { loading, data, error } = state
  const rowsLabel = data?.total_rows != null
    ? ` · ${data.total_rows.toLocaleString()} rows${data.total_cols != null ? ` × ${data.total_cols} cols` : ''}`
    : ''

  return (
    <Modal title={`${name}${rowsLabel}`} onClose={onClose} className="modal-card-lg">
      <div className="var-viewer">
        {loading && <div className="var-viewer-status">Loading data…</div>}
        {error && <div className="var-viewer-status var-viewer-error">Failed to load: {error}</div>}
        {data?.table_html
          ? <SortableTable html={data.table_html} sanitizer={sanitizeHtml} />
          : (data && data.json_tree !== undefined)
            ? <JsonTree data={data.json_tree} />
            : (!loading && !error && data?.text
                ? <pre className="var-viewer-text">{data.text}</pre>
                : null)}
        {data?.note && (
          <div className="var-viewer-note">{data.note}</div>
        )}
        {data?.truncated && (
          <div className="var-viewer-note">Showing the first rows of a larger dataset.</div>
        )}
      </div>
    </Modal>
  )
}
