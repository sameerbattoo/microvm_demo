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
  const [launchIdleTimeout, setLaunchIdleTimeout] = useState('1800')
  const [launchMaxDuration, setLaunchMaxDuration] = useState('28800')
  const [checkpointEnabled, setCheckpointEnabled] = useState(true)

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

  const handleRestoreSession = async () => {
    onUpdateTab({ status: 'launching' })
    setError(null)

    try {
      const response = await fetch(`${PROXY_URL}/launch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: tab.name,
          memoryMiB: parseInt(launchMemory),
          idleTimeoutSeconds: parseInt(launchIdleTimeout),
          maxDurationSeconds: parseInt(launchMaxDuration),
          checkpointEnabled: true,
          sessionId: `${tab.sessionId}-restored-${Date.now()}`,
          restoreFromSession: tab.sessionId,
        }),
      })

      if (response.ok) {
        const result = await response.json()
        onUpdateTab({
          microvmId: result.microvmId,
          microvmEndpoint: `${PROXY_URL}/proxy`,
          microvmRealEndpoint: result.endpoint,
          microvmMemory: parseInt(launchMemory),
          sessionId: result.sessionId,
          checkpointEnabled: true,
          sessionSaved: false,
          status: 'connected',
          mode: 'microvm',
        })
        onDismiss()
      } else {
        const body = await response.json().catch(() => ({}))
        setError(body.error || `Restore failed: ${response.status}`)
        onUpdateTab({ status: 'disconnected' })
      }
    } catch (err) {
      setError(`Restore error: ${err.message}`)
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
        body: JSON.stringify({
          name: tab.name,
          memoryMiB: parseInt(launchMemory),
          idleTimeoutSeconds: parseInt(launchIdleTimeout),
          maxDurationSeconds: parseInt(launchMaxDuration),
          checkpointEnabled,
          sessionId: `${tab.name.replace(/\s+/g, '-').toLowerCase()}-${Date.now()}`,
        }),
      })

      if (response.ok) {
        const result = await response.json()
        onUpdateTab({
          microvmId: result.microvmId,
          microvmEndpoint: `${PROXY_URL}/proxy`,
          microvmRealEndpoint: result.endpoint,
          microvmMemory: parseInt(launchMemory),
          sessionId: result.sessionId,
          checkpointEnabled,
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
      sessionSaved: false,
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
                    {tab.sessionId && (
                      <div className="connection-info-row">
                        <span className="connection-info-label">Session</span>
                        <code className="connection-info-id">{tab.sessionId}</code>
                      </div>
                    )}
                    {tab.checkpointEnabled && (
                      <div className="connection-info-row">
                        <span className="connection-info-label">Restore</span>
                        <span className="connection-info-spec">Enabled — state saves to S3 on termination</span>
                      </div>
                    )}
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
                {tab.sessionSaved
                  ? <>Session <code>{tab.sessionId.slice(-12)}</code> was saved. You can restore it on a new MicroVM.</>
                  : tab.microvmId
                    ? <>Previously connected to <code>{tab.microvmId.replace('microvm-', '').slice(0, 12)}...</code> — launch a new MicroVM or re-attach below.</>
                    : 'Launch a new MicroVM or attach to an existing available instance.'}
              </div>
            )}

            {/* Restore Session button — shown when session was checkpointed to S3 */}
            {tab.status !== 'connected' && tab.sessionSaved && (
              <div className="form-actions" style={{ marginBottom: 'var(--space-3)' }}>
                <button
                  className="connect-btn"
                  onClick={handleRestoreSession}
                  disabled={tab.status === 'launching'}
                >
                  {tab.status === 'launching' ? '⏳ Restoring...' : '♻ Restore Session'}
                </button>
              </div>
            )}

            {/* Available instances to attach — shown first for quick access */}
            {availableInstances.length > 0 && (
              <div className="available-instances">
                <div className="available-title">Available MicroVMs — click to attach:</div>
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
                <div className="launch-spec-item launch-spec-editable">
                  <span className="launch-spec-label">Idle suspend</span>
                  <select className="launch-spec-select" value={launchIdleTimeout} onChange={(e) => setLaunchIdleTimeout(e.target.value)}>
                    <option value="300">5 minutes</option>
                    <option value="900">15 minutes</option>
                    <option value="1800">30 minutes</option>
                    <option value="3600">1 hour</option>
                    <option value="7200">2 hours</option>
                  </select>
                </div>
                <div className="launch-spec-item launch-spec-editable">
                  <span className="launch-spec-label">Max lifetime</span>
                  <select className="launch-spec-select" value={launchMaxDuration} onChange={(e) => setLaunchMaxDuration(e.target.value)}>
                    <option value="3600">1 hour</option>
                    <option value="7200">2 hours</option>
                    <option value="14400">4 hours</option>
                    <option value="28800">8 hours</option>
                  </select>
                </div>
              </div>
              <div className="launch-config-note">
                Auto-scales up to <strong>4× baseline</strong> during peak load. Burst resources billed only when active. Auto-resumes on traffic (~1s).
              </div>
              <label className="launch-checkpoint-toggle">
                <input
                  type="checkbox"
                  checked={checkpointEnabled}
                  onChange={(e) => setCheckpointEnabled(e.target.checked)}
                />
                <span className="launch-checkpoint-label">
                  Enable session restore
                </span>
                <span className="launch-checkpoint-desc">
                  Save state to S3 on termination. Allows restoring variables, files, and packages on a new MicroVM beyond the max lifetime.
                </span>
              </label>
            </div>

            <div className="form-actions">
              <button
                className={availableInstances.length > 0 ? "dismiss-btn" : "connect-btn"}
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
