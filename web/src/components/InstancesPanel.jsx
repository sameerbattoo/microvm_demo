import { useState, useEffect, useCallback } from 'react'
import { IconRefresh, IconX } from './Icons'
import { PROXY_URL } from '../config'
import './InstancesPanel.css'

export default function InstancesPanel({ onClose, onAttach, onTerminateAndSave, onSuspend, attachedIds, tabs = [] }) {
  const [instances, setInstances] = useState({})
  const [totalCost, setTotalCost] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [actionInProgress, setActionInProgress] = useState(new Set())
  const [confirmTerminate, setConfirmTerminate] = useState(null) // { id, type: 'terminate' | 'terminateAndSave', name }
  const [expandedCostId, setExpandedCostId] = useState(null) // MicroVM ID with cost detail expanded

  const fetchInstances = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const resp = await fetch(`${PROXY_URL}/instances`)
      if (resp.ok) {
        const data = await resp.json()
        setInstances(data.instances || {})
        setTotalCost(data.total_cost || null)
      } else {
        setError('Failed to fetch instances')
      }
    } catch (err) {
      setError(`Proxy not reachable: ${err.message}`)
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    fetchInstances()
  }, [fetchInstances])

  const handleTerminate = async (microvmId) => {
    setConfirmTerminate({ id: microvmId, type: 'terminate' })
  }

  const doTerminate = async () => {
    const { id, type } = confirmTerminate
    setConfirmTerminate(null)

    if (type === 'terminateAndSave') {
      onTerminateAndSave(id)
      onClose()
      return
    }

    setActionInProgress(prev => new Set([...prev, id]))
    try {
      await fetch(`${PROXY_URL}/terminate/${id}`, { method: 'POST' })
      await fetchInstances()
    } catch (err) {
      setError(`Terminate failed: ${err.message}`)
    }
    setActionInProgress(prev => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }

  const handleResume = async (microvmId) => {
    setActionInProgress(prev => new Set([...prev, microvmId]))
    try {
      const resp = await fetch(`${PROXY_URL}/resume/${microvmId}`, { method: 'POST' })
      if (resp.ok) {
        await fetchInstances()
      } else {
        const body = await resp.json().catch(() => ({}))
        setError(body.error || 'Resume failed')
      }
    } catch (err) {
      setError(`Resume failed: ${err.message}`)
    }
    setActionInProgress(prev => {
      const next = new Set(prev)
      next.delete(microvmId)
      return next
    })
  }

  const handleAttach = (microvmId, endpoint, memoryMib) => {
    onAttach(microvmId, endpoint, memoryMib)
    onClose()
  }

  const instanceList = Object.entries(instances)

  const formatDuration = (secs) => {
    if (!secs || secs < 60) return `${secs || 0}s`
    if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`
    const h = Math.floor(secs / 3600)
    const m = Math.floor((secs % 3600) / 60)
    return `${h}h ${m}m`
  }

  const formatCostDisplay = (cost) => {
    if (!cost) return '—'
    const usd = cost.total_cost_usd
    if (usd === 0) return '$0.0000'
    if (usd < 0.01) return `$${usd.toFixed(4)}`
    return `$${usd.toFixed(2)}`
  }

  const getStatusBadge = (id, state) => {
    const isAttached = attachedIds.includes(id)

    // Always show the real VM state
    let stateBadge
    switch (state) {
      case 'RUNNING':
        stateBadge = <span className="inst-badge inst-badge-running">Running</span>
        break
      case 'SUSPENDED':
        stateBadge = <span className="inst-badge inst-badge-suspended">Suspended</span>
        break
      case 'TERMINATED':
        stateBadge = <span className="inst-badge inst-badge-terminated">Terminated</span>
        break
      case 'PENDING':
        stateBadge = <span className="inst-badge inst-badge-pending">Pending</span>
        break
      default:
        stateBadge = <span className="inst-badge inst-badge-unknown">{state || 'Unknown'}</span>
    }

    // Show attachment as a secondary indicator
    if (isAttached) {
      return (
        <span className="inst-state-group">
          {stateBadge}
          <span className="inst-badge inst-badge-linked">Linked</span>
        </span>
      )
    }

    return stateBadge
  }

  return (
    <div className="instances-overlay" onClick={onClose}>
      <div className="instances-modal" onClick={e => e.stopPropagation()}>
        <div className="instances-header">
          <h3>Lambda MicroVM Instances</h3>
          <div className="instances-header-actions">
            <button className="instances-refresh-btn" onClick={fetchInstances}><IconRefresh width={14} height={14} /> Refresh</button>
            <button className="instances-close-btn" onClick={onClose}><IconX width={16} height={16} /></button>
          </div>
        </div>

        {loading && <div className="instances-loading">Loading...</div>}
        {error && <div className="instances-error">{error}</div>}

        {!loading && instanceList.length === 0 && (
          <div className="instances-empty">No MicroVM instances found.</div>
        )}

        {!loading && instanceList.length > 0 && (() => {
          return (
          <div className="instances-list">
            <div className="instances-table-header">
              <span>MicroVM ID</span>
              <span>Notebook</span>
              <span>Session</span>
              <span>Spec</span>
              <span>State</span>
              <span>Est. Cost</span>
              <span>Actions</span>
            </div>
            {instanceList.map(([id, inst]) => {
              const isAttached = attachedIds.includes(id)
              const attachedTab = tabs.find(t => t.microvmId === id)
              const isActioning = actionInProgress.has(id)
              const state = inst.state || 'UNKNOWN'
              const hasCheckpoint = attachedTab?.checkpointEnabled

              return (
                <div key={id} className="instances-row-wrapper">
                <div className={`instances-row ${isAttached ? 'instances-row-attached' : ''}`}>
                  <span className="inst-id-text">{id}</span>
                  <span>{attachedTab ? attachedTab.name : '—'}</span>
                  <span className="inst-id-text">{attachedTab?.sessionId ? attachedTab.sessionId.slice(-12) : '—'}</span>
                  <span className="inst-spec-text">
                    {inst.memory_mib
                      ? `${inst.memory_mib / 1024} GB · ${inst.memory_mib / 2048} vCPU`
                      : '4 GB · 2 vCPU'}
                  </span>
                  <span>{getStatusBadge(id, state)}</span>
                  <span
                    className={`inst-cost-cell ${expandedCostId === id ? 'inst-cost-cell-active' : ''}`}
                    onClick={() => setExpandedCostId(expandedCostId === id ? null : id)}
                  >
                    {formatCostDisplay(inst.cost)}
                    <span className="inst-cost-chevron">{expandedCostId === id ? '▾' : '▸'}</span>
                  </span>
                  <span className="inst-col-actions">
                    {/* Attached + Running: Suspend (detach) and Terminate & Save */}
                    {state === 'RUNNING' && isAttached && (
                      <>
                        <button
                          className="inst-action-btn inst-resume-btn"
                          onClick={async () => { await onSuspend(id); onClose() }}
                          disabled={isActioning}
                          title="Detach from notebook (VM will suspend on idle)"
                        >
                          Detach
                        </button>
                        <button
                          className="inst-action-btn inst-terminate-btn"
                          onClick={() => setConfirmTerminate({ id, type: 'terminateAndSave', name: attachedTab?.name || id })}
                          disabled={isActioning}
                          title={hasCheckpoint ? "Terminate & save state to S3" : "Terminate VM"}
                        >
                          {hasCheckpoint ? 'Terminate & Save' : 'Terminate'}
                        </button>
                      </>
                    )}
                    {/* Unattached + Running: Attach or Terminate */}
                    {state === 'RUNNING' && !isAttached && (
                      <>
                        <button
                          className="inst-action-btn inst-attach-btn"
                          onClick={() => handleAttach(id, inst.endpoint, inst.memory_mib)}
                          disabled={isActioning}
                        >
                          Attach
                        </button>
                        <button
                          className="inst-action-btn inst-terminate-btn"
                          onClick={() => handleTerminate(id)}
                          disabled={isActioning}
                        >
                          {isActioning ? '...' : 'Terminate'}
                        </button>
                      </>
                    )}
                    {/* Suspended: Resume & Attach */}
                    {state === 'SUSPENDED' && (
                      <button
                        className="inst-action-btn inst-attach-btn"
                        onClick={async () => {
                          setActionInProgress(prev => new Set([...prev, id]))
                          await handleResume(id)
                          // Fetch fresh instance data after resume to get updated endpoint
                          try {
                            const resp = await fetch(`${PROXY_URL}/instances`)
                            if (resp.ok) {
                              const data = await resp.json()
                              const freshInst = data.instances?.[id]
                              if (freshInst?.endpoint) {
                                handleAttach(id, freshInst.endpoint, freshInst.memory_mib)
                              }
                            }
                          } catch {}
                          setActionInProgress(prev => {
                            const next = new Set(prev)
                            next.delete(id)
                            return next
                          })
                        }}
                        disabled={isActioning}
                      >
                        {isActioning ? '...' : 'Resume & Attach'}
                      </button>
                    )}
                  </span>
                </div>
                {expandedCostId === id && inst.cost && (() => {
                  const memGb = (inst.memory_mib || 4096) / 1024
                  const cost = inst.cost
                  const effectiveRunRate = memGb * 0.0000133
                  const effectiveSuspendRate = memGb * 0.0000000309
                  return (
                    <div className="inst-cost-detail">
                      <div className="inst-cost-detail-grid">
                        <div className="inst-cost-detail-section">
                          <div className="inst-cost-detail-title">Compute (Running)</div>
                          <div className="inst-cost-detail-row">
                            <span className="inst-cost-label">Duration</span>
                            <span className="inst-cost-value">{formatDuration(cost.running_secs)}</span>
                          </div>
                          <div className="inst-cost-detail-row">
                            <span className="inst-cost-label">Rate</span>
                            <span className="inst-cost-value">${effectiveRunRate.toFixed(7)}/sec ({memGb} GB × $0.0000133)</span>
                          </div>
                          <div className="inst-cost-detail-row inst-cost-detail-subtotal">
                            <span className="inst-cost-label">Subtotal</span>
                            <span className="inst-cost-value">${cost.running_cost_usd.toFixed(6)}</span>
                          </div>
                        </div>
                        <div className="inst-cost-detail-section">
                          <div className="inst-cost-detail-title">Snapshot (Suspended)</div>
                          <div className="inst-cost-detail-row">
                            <span className="inst-cost-label">Duration</span>
                            <span className="inst-cost-value">{formatDuration(cost.suspended_secs)}</span>
                          </div>
                          <div className="inst-cost-detail-row">
                            <span className="inst-cost-label">Rate</span>
                            <span className="inst-cost-value">${effectiveSuspendRate.toFixed(10)}/sec ({memGb} GB × $0.0000000309)</span>
                          </div>
                          <div className="inst-cost-detail-row inst-cost-detail-subtotal">
                            <span className="inst-cost-label">Subtotal</span>
                            <span className="inst-cost-value">${cost.suspended_cost_usd.toFixed(6)}</span>
                          </div>
                        </div>
                      </div>
                      <div className="inst-cost-detail-total">
                        <span>Total estimated cost</span>
                        <span>${cost.total_cost_usd.toFixed(6)}</span>
                      </div>
                    </div>
                  )
                })()}
                </div>
              )
            })}
          </div>
          )
        })()}

        <div className="instances-footer">
          <span className="instances-count">{instanceList.length} instance(s)</span>
          {' · '}
          <span className="instances-count">
            {instanceList.filter(([, i]) => i.state === 'RUNNING').length} running,{' '}
            {instanceList.filter(([, i]) => i.state === 'SUSPENDED').length} suspended
          </span>
          {totalCost && totalCost.total_cost_usd > 0 && (
            <>
              {' · '}
              <span
                className="instances-total-cost"
                title={`Total running: ${formatDuration(totalCost.running_secs)}\nTotal suspended: ${formatDuration(totalCost.suspended_secs)}\nTracking ${totalCost.microvm_count} MicroVM(s) this session`}
              >
                Session total: {formatCostDisplay(totalCost)}
              </span>
            </>
          )}
        </div>
      </div>

      {/* Terminate confirmation modal */}
      {confirmTerminate && (
        <div className="instances-confirm-overlay" onClick={() => setConfirmTerminate(null)}>
          <div className="instances-confirm-card" onClick={e => e.stopPropagation()}>
            <div className="instances-confirm-title">
              {confirmTerminate.type === 'terminateAndSave' ? 'Terminate & Save?' : 'Terminate MicroVM?'}
            </div>
            <div className="instances-confirm-message">
              {confirmTerminate.type === 'terminateAndSave'
                ? <>Terminate <strong>{confirmTerminate.name}</strong>? State will be saved to S3 and can be restored later.</>
                : <>This will destroy <code>{confirmTerminate.id.replace('microvm-', '').slice(0, 12)}...</code> and all its in-memory state. This cannot be undone.</>
              }
            </div>
            <div className="instances-confirm-actions">
              <button className="modal-btn modal-btn-cancel" onClick={() => setConfirmTerminate(null)}>Cancel</button>
              <button
                className={confirmTerminate.type === 'terminateAndSave' ? "modal-btn modal-btn-confirm" : "modal-btn modal-btn-danger"}
                onClick={doTerminate}
              >
                {confirmTerminate.type === 'terminateAndSave' ? 'Terminate & Save' : 'Terminate'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
