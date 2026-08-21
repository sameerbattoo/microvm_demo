import { useState, useEffect, useRef } from 'react'
import { marked } from 'marked'
import { PROXY_URL } from '../../../config'
import { IconSparkles, IconX } from '../../Icons'

/**
 * Strip the title heading (# entity_name) and "Data Quality" section from entity
 * markdown — title is already in the modal header, and quality flags are rendered
 * separately with colored indicators below the schema.
 */
function _stripTitleAndDataQuality(md) {
  if (!md) return ''
  // Remove the first # heading (entity name — already in modal header)
  let result = md.replace(/^#[^#\n].*\n+/, '')
  // Remove "## Data Quality" section (rendered separately with colored dots)
  result = result.replace(/## Data Quality[\s\S]*?(?=\n## |\n# |$)/, '')
  return result.trim()
}

/**
 * EntityDocBadge — shows a sparkle icon for entities that have AI-generated profiles.
 * Clicking shows a popover with business description and quality flags.
 * "View Full Profile" opens a modal with the full markdown (+ .md/.html export).
 */
export default function EntityDocBadge({ sourceId, businessDescription, qualityFlags, sessionId }) {
  const [showPopover, setShowPopover] = useState(false)
  const [showModal, setShowModal] = useState(false)
  const [fullDoc, setFullDoc] = useState(null)
  const [loadingFull, setLoadingFull] = useState(false)
  const popRef = useRef(null)

  useEffect(() => {
    if (!showPopover) return
    const handleClick = (e) => {
      if (popRef.current && !popRef.current.contains(e.target)) setShowPopover(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [showPopover])

  const loadFullDoc = async () => {
    setLoadingFull(true)
    try {
      const resp = await fetch(`${PROXY_URL}/datasources/entity-doc?source_id=${encodeURIComponent(sourceId)}`, {
        headers: sessionId ? { 'X-Session-Id': sessionId } : {},
      })
      if (resp.ok) {
        const data = await resp.json()
        setFullDoc(data)
      }
    } catch (e) {
      console.warn('Failed to load entity doc:', e)
    }
    setLoadingFull(false)
    setShowModal(true)
    setShowPopover(false)
  }

  const severityColor = (sev) => {
    if (sev === 'high') return 'var(--accent-danger, #ff5c5c)'
    if (sev === 'medium') return 'var(--accent-warning, #f9a825)'
    return 'var(--text-muted)'
  }

  const entityName = () => sourceId.split('/').pop() || sourceId
  const entitySlug = () => entityName().replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '') || 'entity'

  // Export the full entity profile (raw markdown, incl. Data Quality section) as .md
  const exportEntityMarkdown = () => {
    let md = `*Generated: ${new Date().toLocaleString()}*\n\n`
    md += fullDoc?.markdown || ''
    md += `\n\n---\n\n*Lambda MicroVM Notebook — Developed by the AWS Startup SA Team*\n`
    const blob = new Blob([md], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `entity-${entitySlug()}.md`; a.click()
    URL.revokeObjectURL(url)
  }

  // Export the full entity profile as a self-contained styled .html document
  const exportEntityHtml = () => {
    const bodyHtml = marked(fullDoc?.markdown || '')
    const footer = `<hr style="margin-top:32px;border:none;border-top:1px solid #333"><footer style="text-align:center;padding:12px;color:#666;font-size:11px"><strong>Lambda MicroVM Notebook</strong><br>Developed by the AWS Startup SA Team<br>&copy; ${new Date().getFullYear()} Amazon Web Services, Inc.</footer>`
    const genMeta = `<p style="color:#888;font-size:12px">Generated: ${new Date().toLocaleString()}</p>`
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${entityName()} — Entity Profile</title><style>body{font-family:-apple-system,sans-serif;max-width:800px;margin:40px auto;padding:0 20px;line-height:1.6;color:#e0e0e0;background:#1a1a2e}h1,h2,h3{color:#fff}code{background:#2d2d44;padding:2px 6px;border-radius:3px}pre{background:#2d2d44;padding:12px;border-radius:6px;overflow-x:auto}li{margin-bottom:8px}em{color:#aaa}table{width:100%;border-collapse:collapse;margin:12px 0;font-size:13px}th{text-align:left;padding:6px 10px;background:#2d2d44;color:#fff;border:1px solid #3d3d5c}td{padding:5px 10px;border:1px solid #3d3d5c}tr:nth-child(even){background:#1f1f35}</style></head><body>${genMeta}${bodyHtml}${footer}</body></html>`
    const blob = new Blob([html], { type: 'text/html' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `entity-${entitySlug()}.html`; a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <>
      <button
        className="ds-entity-doc-badge"
        onClick={(e) => { e.stopPropagation(); setShowPopover(!showPopover) }}
        title="AI-profiled entity — click for details"
      >
        <IconSparkles width={12} height={12} />
      </button>
      {showPopover && (
        <div className="ds-entity-popover" ref={popRef} onClick={(e) => e.stopPropagation()}>
          <div className="ds-entity-popover-header">{sourceId.split('/').pop() || sourceId}</div>
          <div className="ds-entity-popover-desc">{businessDescription || 'No description available.'}</div>
          {qualityFlags && qualityFlags.length > 0 && (
            <div className="ds-entity-popover-flags">
              {qualityFlags.slice(0, 4).map((flag, i) => (
                <div key={i} className="ds-entity-flag">
                  <span className="ds-entity-flag-dot" style={{ background: severityColor(flag.severity) }} />
                  <span className="ds-entity-flag-text">{flag.detail || flag.type}</span>
                </div>
              ))}
              {qualityFlags.length > 4 && <div className="ds-entity-flag-more">+{qualityFlags.length - 4} more</div>}
            </div>
          )}
          <button className="ds-entity-popover-full" onClick={loadFullDoc} disabled={loadingFull}>
            {loadingFull ? 'Loading...' : 'View Full Profile'}
          </button>
        </div>
      )}
      {showModal && (
        <div className="ds-entity-modal-overlay" onClick={() => setShowModal(false)}>
          <div className="ds-entity-modal" onClick={(e) => e.stopPropagation()}>
            <div className="ds-entity-modal-header">
              <span>{sourceId.split('/').pop() || sourceId}</span>
              <div className="ds-entity-modal-actions">
                <button className="ds-entity-export-btn" onClick={exportEntityMarkdown} disabled={!fullDoc?.markdown} title="Export as Markdown">
                  <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                  <span className="ds-entity-export-label">.md</span>
                </button>
                <button className="ds-entity-export-btn" onClick={exportEntityHtml} disabled={!fullDoc?.markdown} title="Export as HTML">
                  <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                  <span className="ds-entity-export-label">.html</span>
                </button>
                <button onClick={() => setShowModal(false)}><IconX width={14} height={14} /></button>
              </div>
            </div>
            <div className="ds-entity-modal-body">
              <div dangerouslySetInnerHTML={{ __html: marked(_stripTitleAndDataQuality(fullDoc?.markdown || '')) }} />
              {fullDoc?.quality_flags && fullDoc.quality_flags.length > 0 && (
                <div className="ds-entity-modal-flags">
                  <div className="ds-entity-modal-flags-title">Data Quality</div>
                  {fullDoc.quality_flags.map((flag, i) => (
                    <div key={i} className="ds-entity-modal-flag">
                      <span className="ds-entity-flag-dot" style={{ background: severityColor(flag.severity) }} />
                      <span className="ds-entity-modal-flag-text">
                        <strong>{flag.column ? `${flag.column}` : flag.type}</strong> — {flag.detail}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
