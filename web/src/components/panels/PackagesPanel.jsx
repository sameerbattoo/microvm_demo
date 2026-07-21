import { useState } from 'react'
import { IconRefresh, IconX, IconNotebook } from '../Icons'

export default function PackagesPanel({
  packages,
  pkgLoading,
  activeTab,
  fetchPackages,
  onInstallPackage,
  onClose,
}) {
  const [installPkg, setInstallPkg] = useState('')
  const [installStatus, setInstallStatus] = useState(null)
  const [installMessage, setInstallMessage] = useState('')
  const [pkgFilter, setPkgFilter] = useState('')

  const handleInstallPkg = async () => {
    if (!installPkg.trim() || !activeTab?.microvmEndpoint) return
    setInstallStatus('installing')
    setInstallMessage('')
    const result = await onInstallPackage(installPkg.trim())
    if (result.success) {
      setInstallStatus('success')
      setInstallMessage(`Installed ${installPkg}`)
      setInstallPkg('')
    } else {
      setInstallStatus('error')
      setInstallMessage(result.error || 'Install failed')
    }
    setTimeout(() => setInstallStatus(null), 5000)
  }

  return (
    <div className="sidebar-panel-content">
      <div className="sidebar-panel-header">
        <span className="sidebar-panel-title">Packages</span>
        <span className="sidebar-panel-count">{packages.length}</span>
        <button className="sidebar-panel-action" onClick={fetchPackages} title="Refresh">
          <IconRefresh width={14} height={14} />
        </button>
        <button className="sidebar-panel-close" onClick={onClose} title="Close panel"><IconX width={12} height={12} /></button>
      </div>
      {activeTab && <div className="sidebar-scope-pill"><IconNotebook width={12} height={12} /> {activeTab.name}</div>}
      {/* Install input */}
      <div className="pkg-sidebar-install">
        <input
          className="pkg-sidebar-input"
          type="text"
          value={installPkg}
          onChange={(e) => setInstallPkg(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleInstallPkg() }}
          placeholder="pip install..."
          disabled={installStatus === 'installing' || !activeTab?.microvmEndpoint}
        />
        <button
          className="pkg-sidebar-btn"
          onClick={handleInstallPkg}
          disabled={!installPkg.trim() || installStatus === 'installing' || !activeTab?.microvmEndpoint}
        >
          {installStatus === 'installing' ? '...' : '+'}
        </button>
      </div>
      {installStatus === 'success' && <div className="pkg-sidebar-msg pkg-msg-success">{installMessage}</div>}
      {installStatus === 'error' && <div className="pkg-sidebar-msg pkg-msg-error">{installMessage}</div>}
      {/* Filter */}
      <div className="pkg-sidebar-filter">
        <input
          className="outline-search-input"
          type="text"
          value={pkgFilter}
          onChange={(e) => setPkgFilter(e.target.value)}
          placeholder="Filter packages..."
        />
      </div>
      <div className="sidebar-panel-body">
        {!activeTab?.microvmEndpoint && (
          <div className="sidebar-empty">Connect to a MicroVM to manage packages.</div>
        )}
        {activeTab?.microvmEndpoint && pkgLoading && (
          <div className="sidebar-empty">Loading packages...</div>
        )}
        {activeTab?.microvmEndpoint && !pkgLoading && packages.length === 0 && (
          <div className="sidebar-empty">No packages found.</div>
        )}
        {!pkgLoading && (pkgFilter
          ? packages.filter(p => p.name.toLowerCase().includes(pkgFilter.toLowerCase()))
          : packages
        ).map(pkg => (
          <div key={pkg.name} className="pkg-sidebar-item">
            <span className="pkg-sidebar-name">{pkg.name}</span>
            <span className="pkg-sidebar-version">{pkg.version}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
