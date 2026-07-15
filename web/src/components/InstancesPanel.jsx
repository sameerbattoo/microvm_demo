import { useState, useEffect, useCallback } from 'react'
import './InstancesPanel.css'

const PROXY_URL = 'http://localhost:8081'

export default function InstancesPanel({ onClose, onAttach, attachedIds, tabs = [] }) {
  const [instances, setInstances] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [actionInProgress, setActionInProgress] = useState(new Set())
  const [confirmTerminate, setConfirmTerminate] = useState(null) // microvmId to confirm

  const fetchInstances = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const resp = await fetch(`${PROXY_URL}/instances`)
      if (resp.ok) {
        const data = await resp.json()
        setInstances(data.instances || {})
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
    setConfirmTerminate(microvmId)
  }

  const doTerminate = async () => {
    const microvmId = confirmTerminate
    setConfirmTerminate(null)
    setActionInProgress(prev => new Set([...prev, microvmId]))
    try {
      await fetch(`${PROXY_URL}/terminate/${microvmId}`, { method: 'POST' })
      await fetchInstances()
    } catch (err) {
      setError(`Terminate failed: ${err.message}`)
    }
    setActionInProgress(prev => {
      const next = new Set(prev)
      next.delete(microvmId)
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

  const handleAttach = (microvmId, endpoint) => {
    onAttach(microvmId, endpoint)
    onClose()
  }

  const instanceList = Object.entries(instances)

  const getStatusBadge = (id, state) => {
    const isAttached = attachedIds.includes(id)
    if (isAttached) return <span className="inst-badge inst-badge-attached">Attached</span>

    switch (state) {
      case 'RUNNING':
        return <span className="inst-badge inst-badge-running">Running</span>
      case 'SUSPENDED':
        return <span className="inst-badge inst-badge-suspended">Suspended</span>
      case 'TERMINATED':
        return <span className="inst-badge inst-badge-terminated">Terminated</span>
      case 'PENDING':
        return <span className="inst-badge inst-badge-pending">Pending</span>
      default:
        return <span className="inst-badge inst-badge-unknown">{state || 'Unknown'}</span>
    }
  }

  return (
    <div className="instances-overlay" onClick={onClose}>
      <div className="instances-modal" onClick={e => e.stopPropagation()}>
        <div className="instances-header">
          <h3>Lambda MicroVM Instances</h3>
          <div className="instances-header-actions">
            <button className="instances-refresh-btn" onClick={fetchInstances}>↻ Refresh</button>
            <button className="instances-close-btn" onClick={onClose}>✕</button>
          </div>
        </div>

        {loading && <div className="instances-loading">Loading...</div>}
        {error && <div className="instances-error">{error}</div>}

        {!loading && instanceList.length === 0 && (
          <div className="instances-empty">No MicroVM instances found.</div>
        )}

        {!loading && instanceList.length > 0 && (
          <div className="instances-list">
            <div className="instances-table-header">
              <span>MicroVM ID</span>
              <span>Notebook</span>
              <span>Spec</span>
              <span>State</span>
              <span>Actions</span>
            </div>
            {instanceList.map(([id, inst]) => {
              const isAttached = attachedIds.includes(id)
              const attachedTab = tabs.find(t => t.microvmId === id)
              const isActioning = actionInProgress.has(id)
              const state = inst.state || 'UNKNOWN'

              return (
                <div key={id} className={`instances-row ${isAttached ? 'instances-row-attached' : ''}`}>
                  <span className="inst-id-text">{id}</span>
                  <span>{attachedTab ? attachedTab.name : '—'}</span>
                  <span className="inst-spec-text">4 GB · 2 vCPU</span>
                  <span>{getStatusBadge(id, state)}</span>
                  <span className="inst-col-actions">
                    {/* Attach: only if running and not already attached */}
                    {state === 'RUNNING' && !isAttached && (
                      <button
                        className="inst-action-btn inst-attach-btn"
                        onClick={() => handleAttach(id, inst.endpoint)}
                        disabled={isActioning}
                      >
                        Attach
                      </button>
                    )}
                    {/* Resume: only if suspended */}
                    {state === 'SUSPENDED' && (
                      <button
                        className="inst-action-btn inst-resume-btn"
                        onClick={() => handleResume(id)}
                        disabled={isActioning}
                      >
                        {isActioning ? '...' : 'Resume'}
                      </button>
                    )}
                    {/* Terminate: only if NOT attached to a notebook */}
                    {(state === 'RUNNING' || state === 'SUSPENDED') && !isAttached && (
                      <button
                        className="inst-action-btn inst-terminate-btn"
                        onClick={() => handleTerminate(id)}
                        disabled={isActioning}
                      >
                        {isActioning ? '...' : 'Terminate'}
                      </button>
                    )}
                  </span>
                </div>
              )
            })}
          </div>
        )}

        <div className="instances-footer">
          <span className="instances-count">{instanceList.length} instance(s)</span>
          {' · '}
          <span className="instances-count">
            {instanceList.filter(([, i]) => i.state === 'RUNNING').length} running,{' '}
            {instanceList.filter(([, i]) => i.state === 'SUSPENDED').length} suspended
          </span>
        </div>
      </div>

      {/* Terminate confirmation modal */}
      {confirmTerminate && (
        <div className="instances-confirm-overlay" onClick={() => setConfirmTerminate(null)}>
          <div className="instances-confirm-card" onClick={e => e.stopPropagation()}>
            <div className="instances-confirm-title">Terminate MicroVM?</div>
            <div className="instances-confirm-message">
              This will destroy <code>{confirmTerminate.replace('microvm-', '').slice(0, 12)}...</code> and all its in-memory state. This cannot be undone.
            </div>
            <div className="instances-confirm-actions">
              <button className="modal-btn modal-btn-cancel" onClick={() => setConfirmTerminate(null)}>Cancel</button>
              <button className="modal-btn modal-btn-danger" onClick={doTerminate}>Terminate</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
