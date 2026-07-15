import { useState, useEffect, useRef } from 'react'
import { IconPackage, IconX, IconLoader } from './Icons'
import './PackageManager.css'

export default function PackageManager({ onClose, microvmEndpoint, microvmId, microvmRealEndpoint }) {
  const [packages, setPackages] = useState([])
  const [loading, setLoading] = useState(true)
  const [installPkg, setInstallPkg] = useState('')
  const [installStatus, setInstallStatus] = useState(null) // null | 'installing' | 'success' | 'error'
  const [installMessage, setInstallMessage] = useState('')
  const [filter, setFilter] = useState('')
  const inputRef = useRef(null)

  useEffect(() => {
    if (inputRef.current) inputRef.current.focus()
    fetchPackages()
  }, [])

  const fetchPackages = async () => {
    setLoading(true)
    try {
      // Run pip list on the connected MicroVM via the execute endpoint
      const headers = { 'Content-Type': 'application/json' }
      if (microvmId) {
        headers['X-MicroVM-Id'] = microvmId
        if (microvmRealEndpoint) headers['X-MicroVM-Endpoint'] = microvmRealEndpoint
      }
      const resp = await fetch(`${microvmEndpoint}/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ code: `
import subprocess, json
_r = subprocess.run(["pip", "list", "--format=json"], capture_output=True, text=True)
_pkgs = json.loads(_r.stdout) if _r.returncode == 0 else []
print(json.dumps(_pkgs))
` }),
      })
      if (resp.ok) {
        const data = await resp.json()
        if (data.success && data.output) {
          const pkgs = JSON.parse(data.output.trim())
          setPackages(pkgs.map(p => ({ name: p.name, version: p.version })))
        }
      }
    } catch {}
    setLoading(false)
  }

  const handleInstall = async () => {
    if (!installPkg.trim()) return

    setInstallStatus('installing')
    setInstallMessage('')

    try {
      const headers = { 'Content-Type': 'application/json' }
      if (microvmId) {
        headers['X-MicroVM-Id'] = microvmId
        if (microvmRealEndpoint) headers['X-MicroVM-Endpoint'] = microvmRealEndpoint
      }

      const response = await fetch(`${microvmEndpoint}/install`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ package: installPkg.trim() }),
      })
      const result = await response.json()

      if (result.success) {
        setInstallStatus('success')
        setInstallMessage(result.output || `Installed ${installPkg}`)
        setInstallPkg('')
        // Refresh package list
        fetchPackages()
      } else {
        setInstallStatus('error')
        setInstallMessage(result.error || 'Install failed')
      }
    } catch (err) {
      setInstallStatus('error')
      setInstallMessage(err.message)
    }

    setTimeout(() => setInstallStatus(null), 5000)
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') handleInstall()
    if (e.key === 'Escape') onClose()
  }

  const filteredPackages = filter
    ? packages.filter(p => p.name.toLowerCase().includes(filter.toLowerCase()))
    : packages

  return (
    <div className="pkg-overlay" onClick={onClose}>
      <div className="pkg-modal" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="pkg-header">
          <div className="pkg-header-title">
            <IconPackage width={18} height={18} />
            <h3>Package Manager</h3>
          </div>
          <button className="pkg-close-btn" onClick={onClose}>
            <IconX width={16} height={16} />
          </button>
        </div>

        {/* Install input */}
        <div className="pkg-install-section">
          <div className="pkg-install-row">
            <input
              ref={inputRef}
              className="pkg-install-input"
              type="text"
              value={installPkg}
              onChange={(e) => setInstallPkg(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Package name (e.g. scikit-learn or pandas==2.1.0)"
              disabled={installStatus === 'installing'}
            />
            <button
              className="pkg-install-btn"
              onClick={handleInstall}
              disabled={!installPkg.trim() || installStatus === 'installing'}
            >
              {installStatus === 'installing' ? 'Installing...' : 'Install'}
            </button>
          </div>
          {installStatus === 'success' && (
            <div className="pkg-install-msg pkg-install-success">{installMessage}</div>
          )}
          {installStatus === 'error' && (
            <div className="pkg-install-msg pkg-install-error">{installMessage}</div>
          )}
        </div>

        {/* Filter */}
        <div className="pkg-filter-row">
          <input
            className="pkg-filter-input"
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter installed packages..."
          />
          <div className="pkg-counts">
            <span className="pkg-count-badge">{packages.length} packages</span>
          </div>
        </div>

        {/* Package list */}
        <div className="pkg-list">
          {loading && (
            <div className="pkg-loading">
              <IconLoader width={16} height={16} /> Loading packages...
            </div>
          )}
          {!loading && filteredPackages.length === 0 && (
            <div className="pkg-empty">
              {filter ? 'No packages match your filter.' : 'No packages found.'}
            </div>
          )}
          {!loading && filteredPackages.map(pkg => (
            <div key={pkg.name} className="pkg-item">
              <div className="pkg-item-name">{pkg.name}</div>
              <div className="pkg-item-version">{pkg.version}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
