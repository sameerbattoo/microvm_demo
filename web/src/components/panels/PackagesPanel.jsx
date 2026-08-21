import { useState, useEffect, useMemo, useCallback } from 'react'
import { IconRefresh, IconX, IconNotebook } from '../Icons'
import { PROXY_URL } from '../../config'
import { fetchWithTimeout } from '../../services/fetchWithTimeout'

export default function PackagesPanel({
  packages,
  pkgLoading,
  pkgFetched,
  activeTab,
  fetchPackages,
  onInstallPackage,
  onUninstallPackage,
  onInsertCode,
  onClose,
}) {
  const [installPkg, setInstallPkg] = useState('')
  const [installStatus, setInstallStatus] = useState(null)
  const [installMessage, setInstallMessage] = useState('')
  const [pkgFilter, setPkgFilter] = useState('')
  const [viewMode, setViewMode] = useState('grouped') // 'flat' | 'grouped'

  // Category data from proxy (fetched once)
  const [categoryMap, setCategoryMap] = useState({})
  const [importAliases, setImportAliases] = useState({})
  const [categoryOrder, setCategoryOrder] = useState([])
  const [userInstalled, setUserInstalled] = useState([])

  // Fetch categories from proxy on mount
  useEffect(() => {
    const sessionId = activeTab?.sessionId || ''
    fetchWithTimeout(`${PROXY_URL}/package-categories${sessionId ? `?session_id=${sessionId}` : ''}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data) {
          setCategoryMap(data.categories || {})
          setImportAliases(data.import_aliases || {})
          setCategoryOrder(data.category_order || [])
          setUserInstalled(data.user_installed || [])
        }
      })
      .catch(() => {})
  }, [activeTab?.sessionId])

  const userInstalledSet = useMemo(
    () => new Set(userInstalled.map(p => p.package?.toLowerCase())),
    [userInstalled]
  )

  const handleInstallPkg = async () => {
    if (!installPkg.trim() || !activeTab?.microvmEndpoint) return
    const pkgName = installPkg.trim()
    const hasVersion = /[<>=!~]/.test(pkgName)
    const baseName = pkgName.split(/[<>=!~[]/)[0].trim()
    const baseLower = baseName.toLowerCase()

    // Already installed? Skip the slow pip call unless a specific version is asked for.
    const existing = packages.find(p => p.name.toLowerCase() === baseLower)
    if (existing && !hasVersion) {
      setInstallStatus('success')
      setInstallMessage(`${existing.name} is already installed (v${existing.version})`)
      setInstallPkg('')
      setTimeout(() => setInstallStatus(null), 5000)
      return
    }

    // Soft typo pre-check against PyPI — avoids a slow, doomed install. Skipped
    // silently if blocked (CORS) or offline; pip still validates authoritatively.
    try {
      const probe = await fetch(`https://pypi.org/pypi/${encodeURIComponent(baseName)}/json`)
      if (probe.status === 404) {
        setInstallStatus('error')
        setInstallMessage(`"${baseName}" not found on PyPI — check the name`)
        setTimeout(() => setInstallStatus(null), 6000)
        return
      }
    } catch { /* pre-check unavailable — let pip decide */ }

    setInstallStatus('installing')
    setInstallMessage(`Installing ${pkgName}… (can take a minute)`)
    const result = await onInstallPackage(pkgName)
    if (result.success) {
      setInstallStatus('success')
      setInstallMessage(`Installed ${result.installed_spec || pkgName}`)
      setInstallPkg('')
      // Notify proxy to track + classify the install
      try {
        const resp = await fetchWithTimeout(`${PROXY_URL}/track-install`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: activeTab?.sessionId || '', package: baseName }),
        })
        if (resp.ok) {
          const data = await resp.json()
          setUserInstalled(prev => [...prev, { package: baseName, category: data.category }])
        } else {
          console.warn('[packages] track-install failed:', resp.status)
        }
      } catch (err) {
        console.warn('[packages] track-install error:', err.message)
      }
    } else {
      setInstallStatus('error')
      setInstallMessage(result.error || 'Install failed')
    }
    setTimeout(() => setInstallStatus(null), 5000)
  }

  const handleUninstall = async (pkgName) => {
    if (!onUninstallPackage) return
    const result = await onUninstallPackage(pkgName)
    if (result.success) {
      setUserInstalled(prev => prev.filter(p => p.package?.toLowerCase() !== pkgName.toLowerCase()))
      fetchPackages()
    }
  }

  const handleImport = (pkgName) => {
    if (!onInsertCode) return
    const alias = importAliases[pkgName.toLowerCase()]
    const code = alias || `import ${pkgName.replace(/-/g, '_')}`
    onInsertCode(code)
  }

  const getCategory = useCallback((pkgName) => {
    // Check user-installed list first (has PyPI-determined category)
    const userPkg = userInstalled.find(p => p.package?.toLowerCase() === pkgName.toLowerCase())
    if (userPkg?.category) return userPkg.category
    // Then static mapping
    return categoryMap[pkgName.toLowerCase()] || 'Other'
  }, [categoryMap, userInstalled])

  const filteredPackages = useMemo(() => {
    let pkgs = packages
    if (pkgFilter) {
      pkgs = pkgs.filter(p => p.name.toLowerCase().includes(pkgFilter.toLowerCase()))
    }
    return pkgs
  }, [packages, pkgFilter])

  // Grouped view
  const groupedPackages = useMemo(() => {
    const groups = {}
    for (const pkg of filteredPackages) {
      const cat = getCategory(pkg.name)
      if (!groups[cat]) groups[cat] = []
      groups[cat].push(pkg)
    }
    // Sort: use order from proxy, fallback to alphabetical for unknown categories
    const order = categoryOrder.length > 0 ? categoryOrder : Object.keys(groups).sort()
    const orderedGroups = order.filter(k => groups[k]?.length > 0).map(k => ({ name: k, packages: groups[k] }))
    // Add any categories not in the order list
    const ordered = new Set(order)
    Object.keys(groups).filter(k => !ordered.has(k) && groups[k]?.length > 0).forEach(k => {
      orderedGroups.push({ name: k, packages: groups[k] })
    })
    return orderedGroups
  }, [filteredPackages, getCategory, categoryOrder])

  const isUserPkg = (name) => userInstalledSet.has(name.toLowerCase())

  const renderPkgItem = (pkg) => (
    <div key={pkg.name} className={`pkg-sidebar-item ${isUserPkg(pkg.name) ? 'pkg-user-installed' : ''}`}>
      <span className="pkg-sidebar-name">
        {pkg.name}
        {isUserPkg(pkg.name) && <span className="pkg-user-badge">user</span>}
      </span>
      <span className="pkg-actions">
        <button
          className="pkg-action-btn pkg-import-btn"
          onClick={(e) => { e.stopPropagation(); handleImport(pkg.name) }}
          title={`Insert: ${importAliases[pkg.name.toLowerCase()] || `import ${pkg.name.replace(/-/g, '_')}`}`}
        >↵</button>
        {isUserPkg(pkg.name) && onUninstallPackage && (
          <button
            className="pkg-action-btn pkg-uninstall-btn"
            onClick={(e) => { e.stopPropagation(); handleUninstall(pkg.name) }}
            title={`Uninstall ${pkg.name}`}
          >✕</button>
        )}
      </span>
      <span className="pkg-sidebar-version">{pkg.version}</span>
    </div>
  )

  return (
    <div className="sidebar-panel-content">
      <div className="sidebar-panel-header">
        <span className="sidebar-panel-title">Packages</span>
        <span className="sidebar-panel-count">{packages.length}</span>
        <button
          className={`sidebar-panel-action pkg-view-toggle ${viewMode === 'grouped' ? 'active' : ''}`}
          onClick={() => setViewMode(v => v === 'flat' ? 'grouped' : 'flat')}
          title={viewMode === 'flat' ? 'Group by category' : 'Flat list'}
        >
          ≡
        </button>
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
      {installStatus === 'installing' && <div className="pkg-sidebar-msg pkg-msg-installing">{installMessage}</div>}
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
        {activeTab?.microvmEndpoint && (pkgLoading || (!pkgFetched && packages.length === 0)) && (
          <div className="sidebar-empty">Loading packages...</div>
        )}
        {activeTab?.microvmEndpoint && pkgFetched && !pkgLoading && packages.length === 0 && (
          <div className="sidebar-empty">No packages found.</div>
        )}

        {/* Flat view */}
        {!pkgLoading && viewMode === 'flat' && filteredPackages.map(renderPkgItem)}

        {/* Grouped view */}
        {!pkgLoading && viewMode === 'grouped' && groupedPackages.map(group => (
          <div key={group.name} className="pkg-group">
            <div className="pkg-group-header">
              {group.name}
              <span className="pkg-group-count">{group.packages.length}</span>
            </div>
            {group.packages.map(renderPkgItem)}
          </div>
        ))}
      </div>
    </div>
  )
}
