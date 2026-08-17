import { useState, useEffect } from 'react'
import { PROXY_URL, BACKEND_URL } from '../config'
import './ConnectionPanel.css'

export default function ConnectionPanel({ tab, onConnect, onUpdateTab, onDismiss, attachedIds = [] }) {
  const [mode, setMode] = useState(null) // null until detected, then 'local' | 'microvm'
  const [proxyAvailable, setProxyAvailable] = useState(false)
  const [persistenceMode, setPersistenceMode] = useState('eternal')
  const [maxLifetime, setMaxLifetime] = useState(28800)
  const [error, setError] = useState(null)
  const [availableInstances, setAvailableInstances] = useState([])
  const [loadingInstances, setLoadingInstances] = useState(false)
  const [launchMemory, setLaunchMemory] = useState(String(tab.microvmMemory || '2048'))
  const [launchIdleTimeout, setLaunchIdleTimeout] = useState(String(tab.idleTimeoutSeconds || '60'))
  const [launchMaxDuration, setLaunchMaxDuration] = useState(String(tab.maxDurationSeconds || maxLifetime || '28800'))
  const [imageTiers, setImageTiers] = useState([])
  const [availableSecrets, setAvailableSecrets] = useState([])
  const [selectedSecrets, setSelectedSecrets] = useState([]) // [{name, arn, envVar, secretKey?}]
  const [directEnvVars, setDirectEnvVars] = useState([]) // [{key, value}]
  const [launchTab, setLaunchTab] = useState('spec') // 'spec' | 'secrets'
  const [expandedSecret, setExpandedSecret] = useState(null) // ARN of secret showing keys
  const [secretKeys, setSecretKeys] = useState({}) // {arn: [key1, key2, ...]}

  // Auto-detect which mode we're in
  useEffect(() => {
    fetch(`${PROXY_URL}/health`)
      .then(r => r.json())
      .then(data => {
        if (data.image_arn && data.image_arn !== '(not configured)') {
          setProxyAvailable(true)
          setMode('microvm')
          if (data.persistence_mode) setPersistenceMode(data.persistence_mode)
          if (data.max_lifetime_seconds) setMaxLifetime(data.max_lifetime_seconds)
          fetchAvailableInstances()
          fetchImageTiers()
        } else {
          setMode('local')
        }
      })
      .catch(() => setMode('local'))
  }, [])

  const fetchImageTiers = async () => {
    try {
      const resp = await fetch(`${PROXY_URL}/image-tiers`)
      if (resp.ok) {
        const data = await resp.json()
        if (data.tiers && data.tiers.length > 0) {
          setImageTiers(data.tiers)
          if (!tab.microvmMemory) {
            const defaultTier = data.tiers.find(t => t.memory_mib === 2048) || data.tiers[0]
            setLaunchMemory(String(defaultTier.memory_mib))
          }
        }
      }
    } catch {}
  }

  const fetchSecrets = async () => {
    try {
      const resp = await fetch(`${PROXY_URL}/secrets`)
      if (resp.ok) {
        const data = await resp.json()
        setAvailableSecrets(data.secrets || [])
      }
    } catch {}
  }

  const fetchSecretKeys = async (arn) => {
    if (secretKeys[arn]) return // Already fetched
    try {
      const resp = await fetch(`${PROXY_URL}/secrets/keys?secret_id=${encodeURIComponent(arn)}`)
      if (resp.ok) {
        const data = await resp.json()
        setSecretKeys(prev => ({ ...prev, [arn]: data.keys || [] }))
      }
    } catch {}
  }

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
    const url = BACKEND_URL
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
      setError(`Cannot reach local backend. Run: python3 -m uvicorn app.server:app --port ${BACKEND_URL.split(':').pop()}`)
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
          sessionId: tab.sessionId,
          restoreFromSession: tab.sessionId,
        }),
      })

      if (response.ok) {
        const result = await response.json()
        onUpdateTab({
          microvmId: result.microvmId,
          microvmEndpoint: `${PROXY_URL}/proxy`,
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
          checkpointEnabled: true,
          sessionId: crypto.randomUUID(),
          secrets: selectedSecrets.filter(s => s.envVar).map(s => ({ name: s.name, arn: s.arn, envVar: s.envVar, secretKey: s.secretKey || '' })),
          envVars: directEnvVars.filter(e => e.key && e.value).reduce((acc, e) => ({ ...acc, [e.key]: e.value }), {}),
        }),
      })

      if (response.ok) {
        const result = await response.json()
        onUpdateTab({
          microvmId: result.microvmId,
          microvmEndpoint: `${PROXY_URL}/proxy`,
          microvmMemory: parseInt(launchMemory),
          idleTimeoutSeconds: parseInt(launchIdleTimeout),
          maxDurationSeconds: parseInt(launchMaxDuration),
          sessionId: result.sessionId,
          checkpointEnabled: true,
          status: 'connected',
          mode: 'microvm',
          _envVars: [
            ...selectedSecrets.filter(s => s.envVar).map(s => ({ key: s.envVar, source: 'sm', secretName: s.name })),
            ...directEnvVars.filter(e => e.key && e.value).map(e => ({ key: e.key, source: 'direct' })),
          ],
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
                          ? `${tab.microvmMemory / 1024} GB · ${tab.microvmMemory / 2048} vCPU · ARM64`
                          : 'Fetching...'}
                      </span>
                    </div>
                    {tab.idleTimeoutSeconds && (
                      <div className="connection-info-row">
                        <span className="connection-info-label">Idle Suspend</span>
                        <span className="connection-info-spec">
                          {tab.idleTimeoutSeconds >= 3600
                            ? `${Math.floor(tab.idleTimeoutSeconds / 3600)}h ${Math.floor((tab.idleTimeoutSeconds % 3600) / 60)}m`
                            : tab.idleTimeoutSeconds >= 60
                              ? `${Math.floor(tab.idleTimeoutSeconds / 60)} minute${Math.floor(tab.idleTimeoutSeconds / 60) > 1 ? 's' : ''}`
                              : `${tab.idleTimeoutSeconds} seconds`}
                        </span>
                      </div>
                    )}
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
          {mode === 'microvm' && (
            <span className={`vm-mode-badge vm-mode-${persistenceMode}`} style={{marginLeft: '8px', fontSize: '11px'}}>
              {persistenceMode === 'eternal' ? '∞ eternal' : '💾 checkpoint'}
            </span>
          )}
        </div>
        <div className="connection-desc">
          {tab.status === 'connected'
            ? 'Launch a different MicroVM or reconnect to another instance.'
            : persistenceMode === 'checkpoint'
              ? `Each notebook connects to its own execution sandbox. VM expires after ${parseInt(launchMaxDuration) >= 3600 ? `${Math.floor(parseInt(launchMaxDuration)/3600)}h` : `${Math.floor(parseInt(launchMaxDuration)/60)}m`} — state is auto-saved to S3 before expiry.`
              : 'Each notebook connects to its own execution sandbox for isolated, stateful Python.'}
        </div>

        <div className="connection-modes">
          {mode === null && <div className="connection-detecting">Detecting environment...</div>}
        </div>

        {mode === 'local' && (
          <div className="connection-form">
            <div className="connection-hint">
              Connects directly to the FastAPI sandbox on <code>localhost:{BACKEND_URL.split(':').pop()}</code>.
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
              <div className="launch-config-tabs">
                <button className={`launch-tab ${launchTab === 'spec' ? 'launch-tab-active' : ''}`} onClick={() => setLaunchTab('spec')}>Instance Spec</button>
                <button className={`launch-tab ${launchTab === 'secrets' ? 'launch-tab-active' : ''}`} onClick={() => { setLaunchTab('secrets'); if (availableSecrets.length === 0) fetchSecrets(); }}>Secrets & Env Vars {selectedSecrets.length + directEnvVars.length > 0 ? `(${selectedSecrets.length + directEnvVars.length})` : ''}</button>
              </div>

              {launchTab === 'spec' && (
              <>
              <div className="launch-config-specs">
                <div className="launch-spec-item launch-spec-editable">
                  <span className="launch-spec-label">Baseline Image Size</span>
                  <select className="launch-spec-select" value={launchMemory} onChange={(e) => setLaunchMemory(e.target.value)}>
                    {imageTiers.length > 0 ? (
                      imageTiers.map(tier => (
                        <option key={tier.memory_mib} value={tier.memory_mib}>
                          {tier.label}
                        </option>
                      ))
                    ) : (
                      <>
                        <option value="512">🧠 0.5 GB · ⚡ 0.25 vCPU</option>
                        <option value="1024">🧠 1 GB · ⚡ 0.5 vCPU</option>
                        <option value="2048">🧠 2 GB · ⚡ 1 vCPU</option>
                        <option value="4096">🧠 4 GB · ⚡ 2 vCPU</option>
                        <option value="8192">🧠 8 GB · ⚡ 4 vCPU</option>
                      </>
                    )}
                  </select>
                </div>
                <div className="launch-spec-item">
                  <span className="launch-spec-label">Peak (burst 4×)</span>
                  <span className="launch-spec-value">🧠 {(parseInt(launchMemory) / 1024 * 4).toFixed(1)} GB · ⚡ {Math.max(0.25, parseInt(launchMemory) / 2048) * 4} vCPU</span>
                </div>
                <div className="launch-spec-item">
                  <span className="launch-spec-label">Architecture</span>
                  <span className="launch-spec-value">ARM64 (Graviton)</span>
                </div>
                <div className="launch-spec-item launch-spec-editable">
                  <span className="launch-spec-label">Idle suspend</span>
                  <select className="launch-spec-select" value={launchIdleTimeout} onChange={(e) => setLaunchIdleTimeout(e.target.value)}>
                    <option value="60">1 minute</option>
                    <option value="120">2 minutes</option>
                    <option value="300">5 minutes</option>
                    <option value="900">15 minutes</option>
                    <option value="1800">30 minutes</option>
                    <option value="3600">1 hour</option>
                    <option value="7200">2 hours</option>
                  </select>
                </div>
                <div className="launch-spec-item launch-spec-editable">
                  <span className="launch-spec-label">Max duration</span>
                  <select className="launch-spec-select" value={launchMaxDuration} onChange={(e) => setLaunchMaxDuration(e.target.value)}>
                    <option value="1800">30 minutes</option>
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
              </>
              )}

              {launchTab === 'secrets' && (
              <div className="launch-secrets-body">
                {/* Secrets Manager picker */}
                <div className="launch-secrets-group">
                  <label className="launch-secrets-label">From Secrets Manager:</label>
                  <select
                    className="launch-spec-select"
                    value=""
                    onChange={async (e) => {
                      const arn = e.target.value
                      if (!arn) return
                      setExpandedSecret(arn)
                      await fetchSecretKeys(arn)
                    }}
                  >
                    <option value="">Select a secret...</option>
                    {availableSecrets.map(s => (
                      <option key={s.arn} value={s.arn}>{s.name}</option>
                    ))}
                  </select>

                  {/* Show keys for selected secret */}
                  {expandedSecret && secretKeys[expandedSecret] && secretKeys[expandedSecret].length > 0 && (
                    <div className="launch-secret-keys-panel">
                      <div className="launch-secret-keys-title">
                        Keys in: <code>{availableSecrets.find(s => s.arn === expandedSecret)?.name?.split('/').pop()}</code>
                      </div>
                      <div className="launch-secret-keys">
                        {secretKeys[expandedSecret].map(key => {
                          const isKeySelected = selectedSecrets.some(s => s.arn === expandedSecret && s.secretKey === key)
                          const envVar = selectedSecrets.find(s => s.arn === expandedSecret && s.secretKey === key)?.envVar || ''
                          return (
                            <div key={key} className="launch-secret-key-row">
                              <label className="launch-secret-check">
                                <input
                                  type="checkbox"
                                  checked={isKeySelected}
                                  onChange={(e) => {
                                    if (e.target.checked) {
                                      const secret = availableSecrets.find(s => s.arn === expandedSecret)
                                      setSelectedSecrets(prev => [...prev, { name: secret?.name || '', arn: expandedSecret, secretKey: key, envVar: key.toUpperCase() }])
                                    } else {
                                      setSelectedSecrets(prev => prev.filter(s => !(s.arn === expandedSecret && s.secretKey === key)))
                                    }
                                  }}
                                />
                                <code className="launch-secret-key-name">{key}</code>
                              </label>
                              {isKeySelected && (
                                <>
                                  <span className="launch-secret-arrow">→</span>
                                  <input
                                    className="launch-secret-envvar-inline"
                                    type="text"
                                    value={envVar}
                                    onChange={(e) => setSelectedSecrets(prev => prev.map(s => (s.arn === expandedSecret && s.secretKey === key) ? { ...s, envVar: e.target.value } : s))}
                                  />
                                </>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  {/* Show all selected keys (across all secrets) */}
                  {selectedSecrets.length > 0 && (
                    <div className="launch-secret-selected-summary">
                      <div className="launch-secrets-label">Selected ({selectedSecrets.length}):</div>
                      {selectedSecrets.map((s, idx) => (
                        <div key={idx} className="launch-secret-selected-row">
                          <code>{s.secretKey}</code>
                          <span className="launch-secret-arrow">→</span>
                          <code className="launch-secret-envvar-display">{s.envVar}</code>
                          <button className="launch-envvar-remove" onClick={() => setSelectedSecrets(prev => prev.filter((_, i) => i !== idx))}>✕</button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Direct key-value env vars */}
                <div className="launch-secrets-group">
                  <label className="launch-secrets-label">Direct env vars:</label>
                  {directEnvVars.map((env, idx) => (
                    <div key={idx} className="launch-envvar-row">
                      <input
                        className="launch-envvar-key"
                        type="text"
                        placeholder="KEY"
                        value={env.key}
                        onChange={(e) => setDirectEnvVars(prev => prev.map((v, i) => i === idx ? { ...v, key: e.target.value } : v))}
                      />
                      <input
                        className="launch-envvar-value"
                        type="password"
                        placeholder="value"
                        value={env.value}
                        onChange={(e) => setDirectEnvVars(prev => prev.map((v, i) => i === idx ? { ...v, value: e.target.value } : v))}
                      />
                      <button className="launch-envvar-remove" onClick={() => setDirectEnvVars(prev => prev.filter((_, i) => i !== idx))}>✕</button>
                    </div>
                  ))}
                  <button className="launch-envvar-add" onClick={() => setDirectEnvVars(prev => [...prev, { key: '', value: '' }])}>+ Add variable</button>
                </div>
              </div>
              )}
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
