import { useState, useEffect, useCallback } from 'react'
import { IconRefresh, IconX } from '../Icons'
import { PROXY_URL } from '../../config'

export default function MicroVMsPanel({
  tabs,
  activeTab,
  attachedIds,
  vmMetrics,
  onAttachInstance,
  onTerminateAndSave,
  onSuspendInstance,
  formatDuration,
  onClose,
}) {
  const [vmInstances, setVmInstances] = useState({})
  const [vmLoading, setVmLoading] = useState(false)
  const [vmFetched, setVmFetched] = useState(false)
  const [expandedVmId, setExpandedVmId] = useState(null)
  const [vmActionInProgress, setVmActionInProgress] = useState(new Set())

  // Tick every 30s to keep countdown timers fresh
  const [, setTick] = useState(0)
  useEffect(() => {
    const interval = setInterval(() => setTick(t => t + 1), 30000)
    return () => clearInterval(interval)
  }, [])

  const fetchVmInstances = useCallback(async (showLoading = true) => {
    if (showLoading) setVmLoading(true)
    try {
      const resp = await fetch(`${PROXY_URL}/instances`)
      if (resp.ok) {
        const data = await resp.json()
        setVmInstances(data.instances || {})
      } else {
        setVmInstances({})
      }
    } catch {
      setVmInstances({})
    }
    setVmLoading(false)
    setVmFetched(true)
  }, [])

  // Initial fetch
  useEffect(() => {
    if (!vmFetched) fetchVmInstances()
  }, [vmFetched, fetchVmInstances])

  // Auto-refresh every 10s
  useEffect(() => {
    const interval = setInterval(() => fetchVmInstances(false), 10000)
    return () => clearInterval(interval)
  }, [fetchVmInstances])

  // Auto-expand the VM connected to the active notebook
  useEffect(() => {
    if (activeTab?.microvmId) {
      setExpandedVmId(activeTab.microvmId)
    }
  }, [activeTab?.microvmId])

  const handleVmResume = async (id) => {
    setVmActionInProgress(prev => new Set([...prev, id]))
    try {
      const resp = await fetch(`${PROXY_URL}/resume/${id}`, { method: 'POST' })
      if (resp.ok) await fetchVmInstances()
    } catch {}
    setVmActionInProgress(prev => { const n = new Set(prev); n.delete(id); return n })
  }

  const handleVmTerminate = async (id) => {
    setVmActionInProgress(prev => new Set([...prev, id]))
    try {
      await fetch(`${PROXY_URL}/terminate/${id}`, { method: 'POST' })
      await fetchVmInstances()
    } catch {}
    setVmActionInProgress(prev => { const n = new Set(prev); n.delete(id); return n })
  }

  return (
    <div className="sidebar-panel-content">
      <div className="sidebar-panel-header">
        <span className="sidebar-panel-title">MicroVMs</span>
        <span className="sidebar-panel-count">{Object.keys(vmInstances).length}</span>
        <button className="sidebar-panel-action" onClick={() => { setVmFetched(false); fetchVmInstances() }} title="Refresh">
          <IconRefresh width={14} height={14} />
        </button>
        <button className="sidebar-panel-close" onClick={onClose} title="Close panel"><IconX width={12} height={12} /></button>
      </div>
      <div className="sidebar-panel-body">
        {/* Total cost summary */}
        {Object.keys(vmInstances).length > 0 && (
          <div className="vm-total-cost-bar">
            <span className="vm-total-cost-label">Total session cost</span>
            <span className="vm-total-cost-value">
              ${Object.values(vmInstances).reduce((sum, inst) => sum + (inst.cost?.total_cost_usd || 0), 0).toFixed(4)}
            </span>
          </div>
        )}
        {vmLoading && <div className="sidebar-empty">Loading instances...</div>}
        {!vmLoading && Object.keys(vmInstances).length === 0 && (
          <div className="sidebar-empty">No MicroVM instances. Launch one from a notebook.</div>
        )}
        {Object.entries(vmInstances)
          .sort((a, b) => (b[1].launched_at || 0) - (a[1].launched_at || 0))
          .map(([id, inst]) => {
          const isExpanded = expandedVmId === id
          const isActive = activeTab?.microvmId === id
          const isActioning = vmActionInProgress.has(id)
          const state = inst.state || 'UNKNOWN'
          const attachedTab = tabs.find(t => t.microvmId === id)
          const memGb = (inst.memory_mib || 4096) / 1024

          // Compute remaining lifetime for urgency indicators
          let remainingSec = Infinity
          if (inst.launched_at && inst.max_duration_sec) {
            const launchMs = typeof inst.launched_at === 'number'
              ? inst.launched_at * 1000
              : new Date(inst.launched_at).getTime()
            remainingSec = Math.max(0, Math.floor((launchMs + inst.max_duration_sec * 1000 - Date.now()) / 1000))
          }
          const vmUrgency = remainingSec <= 60 ? 'vm-item-critical' : remainingSec <= 300 ? 'vm-item-warning' : ''

          return (
            <div key={id} className={`vm-item ${isActive ? 'vm-item-active' : ''} ${vmUrgency}`}>
              <div className="vm-item-row" onClick={() => setExpandedVmId(isExpanded ? null : id)}>
                <span className={`vm-state-dot vm-state-${state.toLowerCase()}`} />
                <div className="vm-item-info">
                  <span className="vm-item-name">{id}</span>
                  <span className="vm-item-meta">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><rect x="2" y="6" width="20" height="12" rx="2"/><line x1="6" y1="10" x2="6" y2="14"/><line x1="18" y1="10" x2="18" y2="14"/></svg>
                    {memGb} GB
                    <span className="vm-meta-sep">·</span>
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 9h6v6H9z"/></svg>
                    {(memGb / 2).toFixed(1)} vCPU
                    <span className="vm-meta-sep">·</span>
                    ARM64
                    <span className="vm-meta-sep">·</span>
                    {state.toLowerCase()}
                  </span>
                </div>
                {inst.cost && <span className="vm-item-cost">${inst.cost.total_cost_usd.toFixed(4)}</span>}
              </div>

              {isExpanded && (
                <div className="vm-detail">
                  {/* Instance Info */}
                  <div className="vm-detail-section">
                    <div className="vm-detail-section-title">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="2" width="20" height="20" rx="3"/><line x1="2" y1="8" x2="22" y2="8"/><line x1="8" y1="2" x2="8" y2="8"/></svg>
                      Instance
                    </div>
                    <div className="vm-detail-row">
                      <span className="vm-detail-label">Notebook</span>
                      <span className={`vm-detail-value ${!attachedIds.includes(id) && !inst.name ? 'vm-detail-unattached' : 'vm-detail-linked'}`}>{inst.name || attachedTab?.name || 'Unattached'}</span>
                    </div>
                    {attachedTab?.sessionId && (
                      <div className="vm-detail-row">
                        <span className="vm-detail-label">Session</span>
                        <code className="vm-detail-value">{attachedTab.sessionId}</code>
                      </div>
                    )}
                    {!attachedIds.includes(id) && (
                      <div className="vm-detail-row">
                        <span className="vm-detail-label">Status</span>
                        <span className="vm-detail-value">{state}</span>
                      </div>
                    )}
                  </div>

                  {/* Lifecycle */}
                  {(inst.idle_timeout_sec || inst.max_duration_sec) && (
                    <div className="vm-detail-section">
                      <div className="vm-detail-section-title">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                        Lifecycle
                      </div>
                      {inst.launched_at && (
                        <div className="vm-detail-row">
                          <span className="vm-detail-label">Launched</span>
                          <span className="vm-detail-value">{(() => {
                            const t = typeof inst.launched_at === 'number'
                              ? new Date(inst.launched_at * 1000)
                              : new Date(inst.launched_at)
                            return t.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                          })()}</span>
                        </div>
                      )}
                      {inst.idle_timeout_sec && (
                        <div className="vm-detail-row">
                          <span className="vm-detail-label">Idle suspend</span>
                          <span className="vm-detail-value">{formatDuration(inst.idle_timeout_sec)}</span>
                        </div>
                      )}
                      {inst.max_duration_sec && (
                        <div className="vm-detail-row">
                          <span className="vm-detail-label">Max lifetime</span>
                          <span className="vm-detail-value">{formatDuration(inst.max_duration_sec)}</span>
                        </div>
                      )}
                      {inst.launched_at && inst.max_duration_sec && (
                        <div className="vm-detail-row">
                          <span className="vm-detail-label">Terminates in</span>
                          <span className={`vm-detail-value vm-countdown ${(() => {
                            const launchMs = typeof inst.launched_at === 'number'
                              ? inst.launched_at * 1000
                              : new Date(inst.launched_at).getTime()
                            const remainingSec = Math.max(0, Math.floor((launchMs + inst.max_duration_sec * 1000 - Date.now()) / 1000))
                            if (remainingSec <= 60) return 'vm-countdown-critical'
                            if (remainingSec <= 300) return 'vm-countdown-warning'
                            return ''
                          })()}`}>{(() => {
                            const launchMs = typeof inst.launched_at === 'number'
                              ? inst.launched_at * 1000
                              : new Date(inst.launched_at).getTime()
                            const expiresMs = launchMs + inst.max_duration_sec * 1000
                            const remainingSec = Math.max(0, Math.floor((expiresMs - Date.now()) / 1000))
                            if (remainingSec <= 0) return 'expired'
                            const h = Math.floor(remainingSec / 3600)
                            const m = Math.floor((remainingSec % 3600) / 60)
                            const s = remainingSec % 60
                            return h > 0 ? `${h}h ${m}m` : `${m}m ${s}s`
                          })()}</span>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Live Metrics */}
                  {vmMetrics[id] && state === 'RUNNING' && (
                    <div className="vm-detail-section">
                      <div className="vm-detail-section-title">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
                        Resources
                      </div>
                      <div className="vm-metrics-gauges">
                        <div className="vm-metric-gauge">
                          <div className="vm-metric-bar">
                            <div className="vm-metric-fill vm-metric-cpu" style={{ width: `${Math.min(vmMetrics[id].cpu?.percent || 0, 100)}%` }} />
                          </div>
                          <span className="vm-metric-label">CPU</span>
                          <span className="vm-metric-value">{(vmMetrics[id].cpu?.percent || 0).toFixed(0)}%</span>
                        </div>
                        <div className="vm-metric-gauge">
                          <div className="vm-metric-bar">
                            <div className="vm-metric-fill vm-metric-mem" style={{ width: `${Math.min(vmMetrics[id].memory?.percent || 0, 100)}%` }} />
                          </div>
                          <span className="vm-metric-label">Mem</span>
                          <span className="vm-metric-value" title={`${(vmMetrics[id].memory?.used_mb || 0).toFixed(0)} MB used`}>{(vmMetrics[id].memory?.percent || 0).toFixed(0)}%</span>
                        </div>
                        <div className="vm-metric-gauge">
                          <div className="vm-metric-bar">
                            <div className="vm-metric-fill vm-metric-disk" style={{ width: `${Math.min(vmMetrics[id].disk?.percent || 0, 100)}%` }} />
                          </div>
                          <span className="vm-metric-label">Disk</span>
                          <span className="vm-metric-value">{(vmMetrics[id].disk?.percent || 0).toFixed(0)}%</span>
                        </div>
                      </div>
                      <div className="vm-detail-row">
                        <span className="vm-detail-label">Uptime</span>
                        <span className="vm-detail-value">{formatDuration(vmMetrics[id].uptime_sec || 0)}</span>
                      </div>
                      <div className="vm-detail-row">
                        <span className="vm-detail-label">Processes</span>
                        <span className="vm-detail-value">{vmMetrics[id].processes || 0}</span>
                      </div>
                    </div>
                  )}

                  {/* Cost Breakdown */}
                  {inst.cost && (
                    <div className="vm-detail-section">
                      <div className="vm-detail-section-title">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
                        Cost Breakdown
                      </div>
                      <div className="vm-cost-item vm-cost-compute">
                        <div className="vm-detail-row">
                          <span className="vm-detail-label"><strong>⚡ Running</strong> <span className="vm-cost-hint">(compute)</span></span>
                          <span className="vm-detail-value">{formatDuration(inst.cost.running_secs)}</span>
                        </div>
                        <div className="vm-detail-row vm-detail-row-sub">
                          <span className="vm-detail-label">Rate</span>
                          <span className="vm-detail-value">{memGb} GB × $0.0000133/s</span>
                        </div>
                        <div className="vm-detail-row vm-detail-row-sub">
                          <span className="vm-detail-label">Subtotal</span>
                          <span className="vm-detail-value">${inst.cost.running_cost_usd.toFixed(6)}</span>
                        </div>
                      </div>
                      {inst.cost.suspended_secs > 0 && (
                        <div className="vm-cost-item vm-cost-suspended">
                          <div className="vm-detail-row">
                            <span className="vm-detail-label"><strong>💤 Suspended</strong> <span className="vm-cost-hint">(snapshot storage)</span></span>
                            <span className="vm-detail-value">{formatDuration(inst.cost.suspended_secs)}</span>
                          </div>
                          <div className="vm-detail-row vm-detail-row-sub">
                            <span className="vm-detail-label">Rate</span>
                            <span className="vm-detail-value">{memGb} GB × $0.0000000309/s</span>
                          </div>
                          <div className="vm-detail-row vm-detail-row-sub">
                            <span className="vm-detail-label">Subtotal</span>
                            <span className="vm-detail-value">${inst.cost.suspended_cost_usd.toFixed(6)}</span>
                          </div>
                        </div>
                      )}
                      <div className="vm-detail-row vm-detail-total">
                        <span className="vm-detail-label">Total</span>
                        <span className="vm-detail-value">${inst.cost.total_cost_usd.toFixed(6)}</span>
                      </div>
                    </div>
                  )}

                  {/* Actions */}
                  <div className="vm-detail-actions">
                    {state === 'RUNNING' && attachedIds.includes(id) && (
                      <>
                        <button className="vm-action-btn vm-btn-suspend" onClick={() => { onSuspendInstance && onSuspendInstance(id) }} disabled={isActioning}>
                          Suspend
                        </button>
                        <button className="vm-action-btn vm-btn-terminate" onClick={() => { onTerminateAndSave && onTerminateAndSave(id) }} disabled={isActioning}>
                          {attachedTab?.checkpointEnabled ? 'Terminate & Save' : 'Terminate'}
                        </button>
                      </>
                    )}
                    {state === 'RUNNING' && !attachedIds.includes(id) && (
                      <>
                        <button className="vm-action-btn vm-btn-attach" onClick={() => onAttachInstance && onAttachInstance(id, inst.endpoint, inst.memory_mib)} disabled={isActioning}>Attach</button>
                        <button className="vm-action-btn vm-btn-terminate" onClick={() => handleVmTerminate(id)} disabled={isActioning}>{isActioning ? '...' : 'Terminate'}</button>
                      </>
                    )}
                    {state === 'SUSPENDED' && !attachedIds.includes(id) && (
                      <button className="vm-action-btn vm-btn-terminate" onClick={() => handleVmTerminate(id)} disabled={isActioning}>{isActioning ? '...' : 'Terminate'}</button>
                    )}
                    {state === 'SUSPENDED' && attachedIds.includes(id) && (
                      <button className="vm-action-btn vm-btn-attach" onClick={async () => { await handleVmResume(id) }} disabled={isActioning}>{isActioning ? '...' : 'Resume'}</button>
                    )}
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
