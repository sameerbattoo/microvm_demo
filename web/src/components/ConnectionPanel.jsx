import { useState, useEffect } from 'react'
import './ConnectionPanel.css'

const PROXY_URL = 'http://localhost:8081'

export default function ConnectionPanel({ tab, onConnect, onUpdateTab, onDismiss, attachedIds = [] }) {
  const [mode, setMode] = useState(null) // null until detected, then 'local' | 'microvm'
  const [proxyAvailable, setProxyAvailable] = useState(false)
  const [error, setError] = useState(null)
  const [availableInstances, setAvailableInstances] = useState([])
  const [loadingInstances, setLoadingInstances] = useState(false)
  const [launchMemory, setLaunchMemory] = useState('4096')

  // Auto-detect which mode we're in
  useEffect(() => {
    fetch(`${PROXY_URL}/health`)
      .then(r => r.json())
      .then(data => {
        if (data.image_arn && data.image_arn !== '(not configured)') {
          setProxyAvailable(true)
          setMode('microvm')
          fetchAvailableInstances()
        } else {
          setMode('local')
        }
      })
      .catch(() => setMode('local'))
  }, [])

  const fetchAvailableInstances = async () => {
    setLoadingInstances(true)
    try {
      const resp = await fetch(`${PROXY_URL}/instances`)
      if (resp.ok) {
        const data = await resp.json()
        // Only show RUNNING instances that aren't attached to any notebook
        const available = Object.entries(data.instances || {})
          .filter(([id, inst]) => !attachedIds.includes(id) && inst.state === 'RUNNING')
          .map(([id, inst]) => ({ id, ...inst }))
        setAvailableInstances(available)
      }
    } catch {}
    setLoadingInstances(false)
  }

  const handleConnectLocal = async () => {
    const url = 'http://localhost:8080'
    onUpdateTab({ status: 'connecting' })
    setError(null)

    try {
      const response = await fetch(`${url}/health`)
      if (response.ok) {
        onUpdateTab({ microvmId: null })
        onConnect(url)
      } else {
        setError(`Health check failed: ${response.status}`)
        onUpdateTab({ status: 'disconnected' })
      }
    } catch {
      setError('Cannot reach local backend. Run: python3 -m uvicorn app.server:app --port 8080')
      onUpdateTab({ status: 'disconnected' })
    }
  }

  const handleLaunchMicroVM = async () => {
    onUpdateTab({ status: 'launching' })
    setError(null)

    try {
      const response = await fetch(`${PROXY_URL}/launch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: tab.name, memoryMiB: parseInt(launchMemory) }),
      })

      if (response.ok) {
        const result = await response.json()
        onUpdateTab({
          microvmId: result.microvmId,
          microvmEndpoint: `${PROXY_URL}/proxy`,
          microvmRealEndpoint: result.endpoint,
          microvmMemory: parseInt(launchMemory),
          status: 'connected',
          mode: 'microvm',
        })
        onDismiss()
      } else {
        const body = await response.json().catch(() => ({}))
        setError(body.error || `Launch failed: ${response.status}`)
        onUpdateTab({ status: 'disconnected' })
      }
    } catch (err) {
      setError(`Proxy error: ${err.message}`)
      onUpdateTab({ status: 'disconnected' })
    }
  }

  const handleAttachInstance = (instance) => {
    onUpdateTab({
      microvmId: instance.id,
      microvmEndpoint: `${PROXY_URL}/proxy`,
      microvmRealEndpoint: instance.endpoint,
      microvmMemory: instance.memory_mib || 4096,
      status: 'connected',
      mode: 'microvm',
    })
    onDismiss()
  }

  return (
    <div className="connection-panel">
      <div className="connection-card">
        {/* Show connected status prominently at top when already connected */}
        {tab.status === 'connected' && (
          <>
            <div className="connection-info connection-info-top">
              <div className="connection-info-content">
                <div className="connection-info-status">✓ Connected</div>
                {tab.microvmId && (
                  <div className="connection-info-details">
                    <div className="connection-info-row">
                      <span className="connection-info-label">MicroVM</span>
                      <code className="connection-info-id">{tab.microvmId}</code>
                    </div>
                    <div className="connection-info-row">
                      <span className="connection-info-label">Spec</span>
                      <span className="connection-info-spec">
                        {tab.microvmMemory
                          ? `${tab.microvmMemory / 1024} GB · ${Math.max(1, tab.microvmMemory / 2048)} vCPU · ARM64`
                          : 'Fetching...'}
                      </span>
                    </div>
                  </div>
                )}
                <div className="connection-info-note">Variables persist across cell executions.</div>
              </div>
              <button className="dismiss-btn dismiss-btn-primary" onClick={onDismiss}>Dismiss</button>
            </div>
            <div className="connection-divider" />
          </>
        )}

        <div className="connection-title">
          {tab.status === 'connected' ? 'Switch Sandbox' : 'Connect to Sandbox'}
        </div>
        <div className="connection-desc">
          {tab.status === 'connected'
            ? 'Launch a different MicroVM or reconnect to another instance.'
            : 'Each notebook connects to its own execution sandbox for isolated, stateful Python.'}
        </div>

        <div className="connection-modes">
          {mode === null && <div className="connection-detecting">Detecting environment...</div>}
        </div>

        {mode === 'local' && (
          <div className="connection-form">
            <div className="connection-hint">
              Connects directly to the FastAPI sandbox on <code>localhost:8080</code>.
              No auth token required.
            </div>
            <div className="form-actions">
              <button className="connect-btn" onClick={handleConnectLocal}
                disabled={tab.status === 'connecting'}>
                {tab.status === 'connecting' ? 'Connecting...' : 'Connect to Local'}
              </button>
              {tab.status !== 'connected' && (
                <button className="dismiss-btn" onClick={onDismiss}>Dismiss</button>
              )}
            </div>
          </div>
        )}

        {mode === 'microvm' && (
          <div className="connection-form">
            {tab.status !== 'connected' && (
              <div className="connection-hint">
                {tab.microvmId
                  ? <>Previously connected to <code>{tab.microvmId.replace('microvm-', '').slice(0, 12)}...</code> — launch a new MicroVM or re-attach below.</>
                  : 'Launch a new MicroVM or attach to an existing available instance.'}
              </div>
            )}

            <div className="launch-config">
              <div className="launch-config-title">Instance Specification</div>
              <div className="launch-config-specs">
                <div className="launch-spec-item launch-spec-editable">
                  <span className="launch-spec-label">Baseline</span>
                  <select className="launch-spec-select" value={launchMemory} onChange={(e) => setLaunchMemory(e.target.value)}>
                    <option value="2048">2 GB · 1 vCPU</option>
                    <option value="4096">4 GB · 2 vCPU</option>
                    <option value="8192">8 GB · 4 vCPU</option>
                  </select>
                </div>
                <div className="launch-spec-item">
                  <span className="launch-spec-label">Peak (burst 4×)</span>
                  <span className="launch-spec-value">{parseInt(launchMemory) / 1024 * 4} GB · {Math.max(1, parseInt(launchMemory) / 2048) * 4} vCPU</span>
                </div>
                <div className="launch-spec-item">
                  <span className="launch-spec-label">Architecture</span>
                  <span className="launch-spec-value">ARM64 (Graviton)</span>
                </div>
                <div className="launch-spec-item">
                  <span className="launch-spec-label">Max lifetime</span>
                  <span className="launch-spec-value">8 hours</span>
                </div>
              </div>
              <div className="launch-config-note">
                Auto-scales up to <strong>4× baseline</strong> during peak load. Burst resources billed only when active. Suspends after 30 min idle.
              </div>
            </div>

            <div className="form-actions">
              <button
                className="connect-btn"
                onClick={handleLaunchMicroVM}
                disabled={tab.status === 'launching'}
              >
                {tab.status === 'launching' ? '⏳ Launching...' : '🚀 Launch New MicroVM'}
              </button>
              {tab.status !== 'connected' && (
                <button className="dismiss-btn" onClick={onDismiss}>Dismiss</button>
              )}
            </div>
            {tab.status === 'launching' && (
              <div className="connection-launching">
                Provisioning a new Firecracker VM... This takes a few seconds.
              </div>
            )}

            {/* Available instances to attach */}
            {availableInstances.length > 0 && (
              <div className="available-instances">
                <div className="available-title">Available MicroVMs:</div>
                {availableInstances.map(inst => (
                  <div key={inst.id} className="available-row">
                    <div className="available-info">
                      <span className="available-id">{inst.id}</span>
                      {inst.name && <span className="available-name">{inst.name}</span>}
                    </div>
                    <button
                      className="available-attach-btn"
                      onClick={() => handleAttachInstance(inst)}
                    >
                      Attach
                    </button>
                  </div>
                ))}
              </div>
            )}
            {!loadingInstances && availableInstances.length === 0 && proxyAvailable && (
              <div className="available-empty">No unattached MicroVMs available.</div>
            )}
          </div>
        )}

        {error && (
          <div className="connection-error">
            {error}
          </div>
        )}
      </div>
    </div>
  )
}
