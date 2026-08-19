/**
 * IntelPanel — Workbook Intelligence: AI-generated data insights as actionable cards.
 * 
 * Shows structured cards for:
 * - Suggested Analyses (with [Run] buttons)
 * - Recommended Visualizations
 * - Further Investigation Ideas
 * - Alerts (PII, quality, duplicates, performance)
 * 
 * Plus a "View Full Report" link that opens the detailed markdown in a modal.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { marked } from 'marked'
import { PROXY_URL } from '../config'
import { IconX, IconBarChart, IconChartLine, IconSearch, IconAlertTriangle, IconPlay } from './Icons'
import './IntelPanel.css'

const ALERT_ICONS = {
  pii: '🔒',
  quality: '⚠️',
  duplicate: '📋',
  performance: '⚡',
}

const CATEGORY_ICONS = {
  aggregation: '📊',
  join: '🔗',
  trend: '📈',
  correlation: '🔬',
}

// Module-level cache to persist generating state across unmount/remount
const _generatingMap = new Map()  // sessionId → timestamp when generation started

export default function IntelPanel({ activeTab, onClose, onInsertPrompt }) {
  const [intel, setIntel] = useState(null)
  const [status, setStatus] = useState('loading')
  const [generatedAt, setGeneratedAt] = useState(null)
  const [activeSection, setActiveSection] = useState('analyses')
  const [showFullReport, setShowFullReport] = useState(false)
  // True while an incremental UPDATE (delta) is running on top of an existing report.
  // In that case we keep the current report visible and show an "updating" strip
  // instead of blanking to a spinner.
  const [isUpdating, setIsUpdating] = useState(false)
  // Why we're updating: "addition" (file uploaded) or "deletion" (file removed) —
  // drives the wording of the updating strip.
  const [updateReason, setUpdateReason] = useState('addition')
  // Tracks Phase 2 (full_report generation): 'generating' while prose report is being written,
  // 'ready' once it's available. Structured intel (analyses, alerts) is already visible.
  const [reportStatus, setReportStatus] = useState('ready')

  const sessionId = activeTab?.sessionId
  const regeneratingRef = useRef(null)  // timestamp when regeneration was triggered
  const prevSessionRef = useRef(null)

  // On mount / session change: restore generating state if applicable
  useEffect(() => {
    if (prevSessionRef.current !== sessionId) {
      prevSessionRef.current = sessionId
      setIntel(null)
      setGeneratedAt(null)
      regeneratingRef.current = _generatingMap.get(sessionId) || null
      setStatus(regeneratingRef.current ? 'generating' : 'loading')
    }
  }, [sessionId])

  const fetchIntel = useCallback(async () => {
    if (!sessionId) { setStatus('not_generated'); return }
    try {
      const resp = await fetch(`${PROXY_URL}/workbook-intel`, {
        headers: { 'X-Session-Id': sessionId },
      })
      if (resp.ok) {
        const data = await resp.json()
        if (data.status === 'ready' && data.intel) {
          // If we're regenerating, only accept if the timestamp is newer
          if (regeneratingRef.current && data.generated_at) {
            const genTime = new Date(data.generated_at).getTime()
            if (genTime < regeneratingRef.current) {
              return  // Stale report — keep "generating" state
            }
          }
          setIntel(data.intel)
          setGeneratedAt(data.generated_at)
          setStatus('ready')
          setIsUpdating(false)
          setReportStatus(data.report_status || data.intel?.report_status || 'ready')
          regeneratingRef.current = null
          _generatingMap.delete(sessionId)
        } else if (data.status === 'generating') {
          // Backend now reports real in-progress state (not just our local guess) —
          // trust it directly, including for the very first auto-triggered generation
          // (regeneratingRef is only set for user-initiated regenerate clicks).
          setStatus('generating')
          // An incremental update (delta) extends OR prunes an existing report. Keep the
          // current report on screen and flag "updating" so changes appear when it lands.
          setIsUpdating(data.mode === 'update' || !!data.has_existing)
          if (data.reason) setUpdateReason(data.reason)
          // The backend includes the CURRENT (pre-update) report during an update so a
          // fresh mount (navigated away & back mid-update) can render it under the
          // "updating" strip instead of a bare spinner. Adopt it only if we don't already
          // have content (functional updater avoids clobbering a newer local report and
          // keeps fetchIntel free of an `intel` dependency).
          if (data.intel) {
            setIntel(prev => prev || data.intel)
            if (data.generated_at) setGeneratedAt(prev => prev || data.generated_at)
          }
        } else if (!regeneratingRef.current) {
          setStatus('not_generated')
        }
      }
    } catch (err) { setStatus('error') }
  }, [sessionId])

  useEffect(() => {
    fetchIntel()
    const interval = setInterval(fetchIntel, 10000)
    return () => clearInterval(interval)
  }, [fetchIntel])

  const handleGenerate = async () => {
    if (!sessionId) return
    setIntel(null)
    setStatus('generating')
    regeneratingRef.current = Date.now()
    _generatingMap.set(sessionId, Date.now())
    try {
      await fetch(`${PROXY_URL}/workbook-intel/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-Id': sessionId },
        body: JSON.stringify({ trigger: 'manual' }),
      })
    } catch { setStatus('error') }
  }

  const handleRunPrompt = (prompt) => {
    if (onInsertPrompt) onInsertPrompt(prompt)
  }

  const analyses = intel?.suggested_analyses || []
  const visualizations = intel?.visualizations || []
  const investigations = intel?.investigations || []
  const alerts = intel?.alerts || []
  const relationships = intel?.relationships || []
  const fullReport = intel?.full_report || ''

  const alertCount = alerts.length
  const hasContent = analyses.length > 0 || visualizations.length > 0 || investigations.length > 0 || alerts.length > 0

  return (
    <div className="intel-panel">
      <div className="intel-panel-header">
        <span className="intel-panel-title">Workbook Intel</span>
        {alertCount > 0 && <span className="intel-alert-badge">{alertCount}</span>}
        <div className="intel-header-actions">
          {status === 'ready' && (
            <span className="intel-meta">{new Date(generatedAt).toLocaleString(undefined, {month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"})}</span>
          )}
          {status === 'ready' && fullReport && (
            <button className="intel-btn-icon" onClick={() => setShowFullReport(true)} title="View full report">
              <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
            </button>
          )}
          {status === 'ready' && !fullReport && reportStatus === 'generating' && (
            <button className="intel-btn-icon" disabled title="Full report generating...">
              <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
            </button>
          )}
          <button className="intel-btn-icon" onClick={handleGenerate} disabled={status === 'generating' || !sessionId} title="Refresh intelligence">
            <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
          </button>
        </div>
      </div>

      {status === 'loading' && <div className="intel-empty">Loading...</div>}
      {status === 'not_generated' && (
        <div className="intel-empty">
          {sessionId ? (
            <>
              <p>No intelligence report yet.</p>
              <button className="intel-generate-btn-large" onClick={handleGenerate}>
                Generate Intelligence Report
              </button>
            </>
          ) : (
            <p style={{color: 'var(--text-muted)'}}>No active session — launch a notebook to generate Intel reports.</p>
          )}
        </div>
      )}
      {/* Blank spinner ONLY when generating a fresh report with nothing to show yet.
          During an incremental update we keep the existing report visible (below). */}
      {status === 'generating' && !hasContent && (
        <div className="intel-empty">
          <div className="intel-spinner" />
          <p>{isUpdating
            ? (updateReason === 'deletion' ? 'Updating the report after the file was removed...' : 'Updating the report with the new data...')
            : 'Analyzing data sources...'}</p>
          <p className="intel-empty-hint">10-20 seconds</p>
        </div>
      )}

      {status === 'ready' && !hasContent && fullReport && (
        <div className="intel-panel-body">
          <div className="intel-full-report-inline" dangerouslySetInnerHTML={{ __html: marked(fullReport) }} />
        </div>
      )}

      {status === 'ready' && !hasContent && !fullReport && (
        <div className="intel-empty">
          <p>Report generated but no structured insights available.</p>
          <button className="intel-generate-btn-large" onClick={handleGenerate} disabled={!sessionId}>
            Regenerate
          </button>
        </div>
      )}

      {/* Content block: render whenever we have content — whether the report is
          fully ready OR an incremental update is in flight (keep it visible, show a
          thin "updating" strip so the user knows new items are on the way). */}
      {hasContent && (
        <div className="intel-panel-body">
          {status === 'generating' && isUpdating && (
            <div className="intel-updating-strip">
              <div className="intel-spinner intel-spinner-sm" />
              <span>{updateReason === 'deletion'
                ? 'Updating after a data source was removed — related insights will be pruned shortly…'
                : 'Updating with newly uploaded data — new insights will appear shortly…'}</span>
            </div>
          )}
          {/* Section tabs */}
          <div className="intel-section-tabs">
            <button className={`intel-tab ${activeSection === 'analyses' ? 'active' : ''}`} onClick={() => setActiveSection('analyses')}>
              <IconBarChart width={13} height={13} />
              Analyses ({analyses.length})
            </button>
            <button className={`intel-tab ${activeSection === 'viz' ? 'active' : ''}`} onClick={() => setActiveSection('viz')}>
              <IconChartLine width={13} height={13} />
              Visualizations ({visualizations.length})
            </button>
            <button className={`intel-tab ${activeSection === 'investigate' ? 'active' : ''}`} onClick={() => setActiveSection('investigate')}>
              <IconSearch width={13} height={13} />
              Investigate ({investigations.length})
            </button>
            {alerts.length > 0 && (
              <button className={`intel-tab intel-tab-alert ${activeSection === 'alerts' ? 'active' : ''}`} onClick={() => setActiveSection('alerts')}>
                <IconAlertTriangle width={13} height={13} />
                Alerts ({alerts.length})
              </button>
            )}
          </div>

          {/* Cards */}
          <div className="intel-cards">
            {activeSection === 'analyses' && analyses.map((item, i) => (
              <div key={i} className="intel-card">
                <span className="intel-card-icon">{CATEGORY_ICONS[item.category] || '\ud83d\udcca'}</span>
                <span className="intel-card-title">{item.title}</span>
                <button className="intel-card-run" onClick={() => handleRunPrompt(item.prompt)}><IconPlay width={10} height={10} /> Run</button>
              </div>
            ))}
            {activeSection === 'viz' && visualizations.map((item, i) => (
              <div key={i} className="intel-card">
                <span className="intel-card-icon">📉</span>
                <span className="intel-card-title">{item.title}</span>
                <span className="intel-card-badge">{item.chart_type}</span>
                <button className="intel-card-run" onClick={() => handleRunPrompt(item.prompt)}><IconPlay width={10} height={10} /> Run</button>
              </div>
            ))}
            {activeSection === 'investigate' && investigations.map((item, i) => (
              <div key={i} className="intel-card intel-card-investigate">
                <span className="intel-card-icon">🔍</span>
                <div className="intel-card-body">
                  <span className="intel-card-title">{item.title}</span>
                  {item.reason && <span className="intel-card-reason">{item.reason}</span>}
                </div>
                <button className="intel-card-run" onClick={() => handleRunPrompt(item.prompt)}><IconPlay width={10} height={10} /> Run</button>
              </div>
            ))}
            {activeSection === 'alerts' && alerts.map((item, i) => (
              <div key={i} className={`intel-card intel-card-alert intel-alert-${item.severity}`}>
                <span className="intel-card-icon">{ALERT_ICONS[item.type] || '\u26a0\ufe0f'}</span>
                <div className="intel-card-body">
                  <span className="intel-card-title">{item.message}</span>
                  {item.action && <span className="intel-card-action">{item.action}</span>}
                </div>
                {item.action && (
                  <button className="intel-card-run" onClick={() => handleRunPrompt(item.action)}><IconPlay width={10} height={10} /> Run</button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Full Report Modal */}
      {showFullReport && (
        <div className="intel-modal-overlay" onClick={() => setShowFullReport(false)}>
          <div className="intel-modal" onClick={e => e.stopPropagation()}>
            <div className="intel-modal-header">
              <div>
                <h3>Intelligence Report</h3>
                {generatedAt && <span className="intel-modal-date">{new Date(generatedAt).toLocaleString()}</span>}
              </div>
              <div className="intel-modal-actions">
                <div className="intel-export-wrapper">
                  <button className="intel-header-action" onClick={() => {
                    // Build full markdown combining structured data + narrative report
                    let md = `*Generated: ${generatedAt ? new Date(generatedAt).toLocaleString() : 'Unknown'}*\n\n---\n\n`
                    if (fullReport) { md += `${fullReport}\n\n` }
                    if (alerts.length > 0) {
                      md += `---\n\n## Alerts\n\n`
                      alerts.forEach((al, i) => { md += `${i+1}. **[${(al.severity||'').toUpperCase()}]** ${al.message}\n   *Action:* ${al.action || 'N/A'}\n\n` })
                    }
                    const hasNextStepsMd = analyses.length > 0 || visualizations.length > 0 || investigations.length > 0
                    if (hasNextStepsMd) {
                      md += `---\n\n## Recommended Next Steps\n\n`
                      if (analyses.length > 0) {
                        md += `### Suggested Analyses\n\n`
                        analyses.forEach((a, i) => { md += `${i+1}. **${a.title}**\n   ${a.prompt}\n\n` })
                      }
                      if (visualizations.length > 0) {
                        md += `### Recommended Visualizations\n\n`
                        visualizations.forEach((v, i) => { md += `${i+1}. **${v.title}** *(${v.chart_type})*\n   ${v.prompt}\n\n` })
                      }
                      if (investigations.length > 0) {
                        md += `### Further Investigations\n\n`
                        investigations.forEach((inv, i) => { md += `${i+1}. **${inv.title}**\n   ${inv.reason}\n   *Prompt:* ${inv.prompt}\n\n` })
                      }
                    }
                    md += `\n---\n\n*Lambda MicroVM Notebook — Developed by the AWS Startup SA Team*\n`
                    const blob = new Blob([md], { type: 'text/markdown' })
                    const url = URL.createObjectURL(blob)
                    const a = document.createElement('a')
                    a.href = url; a.download = `workbook-intel-${new Date().toISOString().slice(0, 10)}.md`; a.click()
                    URL.revokeObjectURL(url)
                  }} title="Export as Markdown">
                    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                    <span style={{fontSize: '9px', marginLeft: '2px'}}>.md</span>
                  </button>
                  <button className="intel-header-action" onClick={() => {
                    // Build full HTML report
                    let bodyHtml = ''
                    if (fullReport) { bodyHtml += marked.parse(fullReport, { breaks: true }) }
                    if (alerts.length > 0) {
                      bodyHtml += `<hr><h2>⚠️ Alerts</h2><ul>`
                      alerts.forEach(al => { bodyHtml += `<li><strong style="color:#ff5c5c">[${(al.severity||'').toUpperCase()}]</strong> ${al.message}<br><em style="color:#aaa">Action: ${al.action || 'N/A'}</em></li>` })
                      bodyHtml += `</ul>`
                    }
                    const hasNextStepsHtml = analyses.length > 0 || visualizations.length > 0 || investigations.length > 0
                    if (hasNextStepsHtml) {
                      bodyHtml += `<hr><h2>Recommended Next Steps</h2>`
                      if (analyses.length > 0) {
                        bodyHtml += `<h3>Suggested Analyses</h3><ol>`
                        analyses.forEach(a => { bodyHtml += `<li><strong>${a.title}</strong><br><em>${a.prompt}</em></li>` })
                        bodyHtml += `</ol>`
                      }
                      if (visualizations.length > 0) {
                        bodyHtml += `<h3>Recommended Visualizations</h3><ol>`
                        visualizations.forEach(v => { bodyHtml += `<li><strong>${v.title}</strong> <span style="color:#888">(${v.chart_type})</span><br><em>${v.prompt}</em></li>` })
                        bodyHtml += `</ol>`
                      }
                      if (investigations.length > 0) {
                        bodyHtml += `<h3>Further Investigations</h3><ol>`
                        investigations.forEach(inv => { bodyHtml += `<li><strong>${inv.title}</strong><br>${inv.reason}<br><em>Prompt: ${inv.prompt}</em></li>` })
                        bodyHtml += `</ol>`
                      }
                    }
                    bodyHtml += `<hr style="margin-top:32px;border:none;border-top:1px solid #333"><footer style="text-align:center;padding:12px;color:#666;font-size:11px"><strong>Lambda MicroVM Notebook</strong><br>Developed by the AWS Startup SA Team<br>&copy; ${new Date().getFullYear()} Amazon Web Services, Inc.</footer>`
                    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Intelligence Report</title><style>body{font-family:-apple-system,sans-serif;max-width:800px;margin:40px auto;padding:0 20px;line-height:1.6;color:#e0e0e0;background:#1a1a2e}h1,h2,h3{color:#fff}code{background:#2d2d44;padding:2px 6px;border-radius:3px}pre{background:#2d2d44;padding:12px;border-radius:6px;overflow-x:auto}li{margin-bottom:8px}em{color:#aaa}table{width:100%;border-collapse:collapse;margin:12px 0;font-size:13px}th{text-align:left;padding:6px 10px;background:#2d2d44;color:#fff;border:1px solid #3d3d5c}td{padding:5px 10px;border:1px solid #3d3d5c}tr:nth-child(even){background:#1f1f35}</style></head><body><p><em>Generated: ${generatedAt ? new Date(generatedAt).toLocaleString() : 'Unknown'}</em></p>${bodyHtml}</body></html>`
                    const blob = new Blob([html], { type: 'text/html' })
                    const url = URL.createObjectURL(blob)
                    const a = document.createElement('a')
                    a.href = url; a.download = `workbook-intel-${new Date().toISOString().slice(0, 10)}.html`; a.click()
                    URL.revokeObjectURL(url)
                  }} title="Export as HTML">
                    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                    <span style={{fontSize: '9px', marginLeft: '2px'}}>.html</span>
                  </button>
                </div>
                <button onClick={() => setShowFullReport(false)}><IconX width={14} height={14} /></button>
              </div>
            </div>
            <div className="intel-modal-body" dangerouslySetInnerHTML={{ __html: (() => {
              let html = ''
              // Detailed narrative report first
              if (fullReport) { html += marked.parse(fullReport, { breaks: true }) }
              // Alerts
              if (alerts.length > 0) {
                html += `<hr style="margin:24px 0"><h2>⚠️ Alerts</h2><ul>`
                alerts.forEach(al => { html += `<li><strong style="color:var(--accent-danger)">[${(al.severity||'').toUpperCase()}]</strong> ${al.message}<br><em style="color:var(--text-muted)">Action: ${al.action || 'N/A'}</em></li>` })
                html += `</ul>`
              }
              // Recommended Next Steps
              const hasNextSteps = analyses.length > 0 || visualizations.length > 0 || investigations.length > 0
              if (hasNextSteps) {
                html += `<hr style="margin:24px 0"><h2>Recommended Next Steps</h2>`
                if (analyses.length > 0) {
                  html += `<h3>Suggested Analyses</h3><ol>`
                  analyses.forEach(a => { html += `<li><strong>${a.title}</strong><br><span style="color:var(--text-muted)">${a.prompt}</span></li>` })
                  html += `</ol>`
                }
                if (visualizations.length > 0) {
                  html += `<h3>Recommended Visualizations</h3><ol>`
                  visualizations.forEach(v => { html += `<li><strong>${v.title}</strong> <span style="opacity:0.6">(${v.chart_type})</span><br><span style="color:var(--text-muted)">${v.prompt}</span></li>` })
                  html += `</ol>`
                }
                if (investigations.length > 0) {
                  html += `<h3>Further Investigations</h3><ol>`
                  investigations.forEach(inv => { html += `<li><strong>${inv.title}</strong><br>${inv.reason}<br><span style="color:var(--text-muted)"><em>${inv.prompt}</em></span></li>` })
                  html += `</ol>`
                }
              }
              return html || '<p>No report content available.</p>'
            })() }} />
          </div>
        </div>
      )}
    </div>
  )
}
