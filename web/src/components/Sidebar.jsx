import { useState, useEffect, useCallback, useRef, Fragment } from 'react'
import { IconX, IconNotebook, IconDatabase, IconCode, IconPackage, IconServer, IconBraces, IconTerminal, IconLogs, IconIntel } from './Icons'
import { PROXY_URL, API_TIMEOUT_MS } from '../config'
import { fetchWithTimeout } from '../services/fetchWithTimeout'
import './Sidebar.css'

// Panel components
import NotebooksPanel from './panels/NotebooksPanel'
import OutlinePanel from './panels/OutlinePanel'
import DataSourcesPanel from './panels/DataSourcesPanel'
import SamplesPanel from './panels/SamplesPanel'
import VariablesPanel from './panels/VariablesPanel'
import PackagesPanel from './panels/PackagesPanel'
import MicroVMsPanel from './panels/MicroVMsPanel'
import AboutPanel from './panels/AboutPanel'
import SnippetsPanel from './panels/SnippetsPanel'

// Activity bar icon components
function IconOutline({ width = 16, height = 16 }) {
  return (
    <svg width={width} height={height} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="15" y2="12" /><line x1="3" y1="18" x2="11" y2="18" />
    </svg>
  )
}

function IconSamples({ width = 16, height = 16 }) {
  return (
    <svg width={width} height={height} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" /><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
    </svg>
  )
}
export default function Sidebar({
  tabs,
  activeTabId,
  attachedIds,
  uploadedFiles,
  onSelectTab,
  onNewNotebook,
  onCloseTab,
  onRenameTab,
  onUploadFile,
  onDeleteFile,
  onLoadSample,
  onInsertCode,
  cells = [],
  variables = {},
  activeTab = null,
  onScrollToCell,
  onReorderCells,
  onRunFromCell,
  onDeleteCells,
  onRunCells,
  onClearOutputs,
  onAttachInstance,
  onTerminateAndSave,
  onSuspendInstance,
  onUpdateTabTag,
  onSyncPackages,
  onSyncDataSources,
  onRefreshFiles,
  instances = {},
  vmMetrics = {},
  showTerminal = false,
  onToggleTerminal,
  showLogs = false,
  onToggleLogs,
  showIntel = false,
  onToggleIntel,
}) {
  // Activity bar state — which panel is active (null = collapsed)
  const [activePanel, setActivePanel] = useState(() => {
    try {
      return localStorage.getItem('microvm-sidebar-panel') || 'notebooks'
    } catch { return 'notebooks' }
  })

  // Panel resize
  const [panelWidth, setPanelWidth] = useState(() => {
    try { return parseInt(localStorage.getItem('microvm-sidebar-width')) || 240 } catch { return 240 }
  })
  const isResizing = useRef(false)

  // Package manager state
  const [packages, setPackages] = useState([])
  const [pkgLoading, setPkgLoading] = useState(false)
  const [pkgFetched, setPkgFetched] = useState(false)

  // External data sources state
  const [s3Files, setS3Files] = useState([])
  const [dynamoTables, setDynamoTables] = useState([])
  const [athenaTables, setAthenaTables] = useState([])
  const [catalogEntries, setCatalogEntries] = useState([])  // enriched entries from /datasources/catalog
  const [athenaWorkgroup, setAthenaWorkgroup] = useState('microvm-demo')
  const [dsLoading, setDsLoading] = useState(false)
  const [dsFetched, setDsFetched] = useState(false)
  // True once the enriched /datasources/catalog (has_entity_doc + schemas) has
  // been successfully loaded for the current session. Distinct from dsFetched,
  // which only tracks the plain source list. Drives the connect re-fetch so the
  // entity intel icons appear without a manual refresh.
  const [catalogLoaded, setCatalogLoaded] = useState(false)

  // VM badge state — use instances prop directly (synced with parent polling)
  // Only use local poll as fallback when instances prop is empty
  const [vmBadgeFallback, setVmBadgeFallback] = useState({})
  const [persistenceMode, setPersistenceMode] = useState('eternal')

  // The canonical VM data: prefer the prop (updated by parent's faster poll) over local fallback
  const vmBadgeInstances = Object.keys(instances).length > 0 ? instances : vmBadgeFallback

  // Persist active panel
  useEffect(() => {
    try {
      if (activePanel) localStorage.setItem('microvm-sidebar-panel', activePanel)
      else localStorage.removeItem('microvm-sidebar-panel')
    } catch {}
  }, [activePanel])

  // Persist panel width
  useEffect(() => {
    try { localStorage.setItem('microvm-sidebar-width', String(panelWidth)) } catch {}
  }, [panelWidth])

  const handleResizeStart = useCallback((e) => {
    e.preventDefault()
    isResizing.current = true
    const startX = e.clientX
    const startWidth = panelWidth

    const handleMouseMove = (e) => {
      if (!isResizing.current) return
      const delta = e.clientX - startX
      const newWidth = Math.min(720, Math.max(180, startWidth + delta))
      setPanelWidth(newWidth)
    }

    const handleMouseUp = () => {
      isResizing.current = false
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [panelWidth])

  const togglePanel = (panel) => {
    setActivePanel(prev => prev === panel ? null : panel)
  }

  // Run All status for the Outline activity-bar icon: null | 'running' | 'error'.
  // Driven by the 'outline-run-status' window event dispatched from Notebook.jsx.
  // 'running' pulses green while Run All executes; 'error' turns the icon red and
  // PERSISTS after the run so the user knows to open Outline and find the failed cell.
  const [outlineRunStatus, setOutlineRunStatus] = useState(null)
  useEffect(() => {
    const handler = (e) => {
      const status = e.detail  // 'running' | 'error' | 'clear'
      if (status === 'running') {
        setOutlineRunStatus('running')
        setActivePanel('outline')  // auto-open the Outline panel on Run All
      } else if (status === 'error') {
        setOutlineRunStatus('error')
      } else {
        setOutlineRunStatus(null)  // 'clear' / anything else
      }
    }
    window.addEventListener('outline-run-status', handler)
    return () => window.removeEventListener('outline-run-status', handler)
  }, [])

  // Listen for keyboard shortcut events from App
  useEffect(() => {
    const handler = (e) => togglePanel(e.detail)
    window.addEventListener('toggle-sidebar-panel', handler)
    return () => window.removeEventListener('toggle-sidebar-panel', handler)
  }, [])

  // --- Data Sources fetching ---
  // NOTE: this callback MUST depend on activeTab.sessionId. The enriched catalog
  // (which carries has_entity_doc → the entity intel icons) is only fetched when
  // a sessionId is present. If this closed over a stale activeTab, the catalog
  // fetch would be skipped on the first connect, dsFetched would latch true, and
  // the icons would never appear until a manual refresh.
  const sessionId = activeTab?.sessionId
  const fetchDataSources = useCallback(async () => {
    setDsLoading(true)
    // Also refresh local VM files
    if (onRefreshFiles) onRefreshFiles()
    // Track whether we got everything we need. We only "latch" dsFetched=true once
    // the enriched catalog has actually been retrieved (or there is genuinely no
    // session to enrich against). Otherwise we leave it false so the connect
    // effect retries once the session id lands / the VM stops returning 502.
    let catalogResolved = false
    try {
      const resp = await fetchWithTimeout(`${PROXY_URL}/datasources`)
      if (resp.ok) {
        const data = await resp.json()
        setS3Files(data.s3 || [])
        setDynamoTables(data.dynamodb || [])
        setAthenaTables(data.athena || [])
        setAthenaWorkgroup(data.athena_workgroup || 'microvm-demo')

        // Fetch full catalog (with column schemas + entity-doc enrichment) when a
        // session is active. The proxy retries the VM internally on transient 502s.
        if (sessionId) {
          try {
            const catalogResp = await fetch(`${PROXY_URL}/datasources/catalog`, {
              headers: { 'X-Session-Id': sessionId },
            })
            if (catalogResp.ok) {
              const catalog = await catalogResp.json()
              data._catalog = catalog  // Attach catalog entries with column info
              setCatalogEntries(catalog.entries || [])
              catalogResolved = true
              setCatalogLoaded(true)
            }
          } catch {}
        }

        if (onSyncDataSources) onSyncDataSources(data)
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        console.warn('[datasources] Fetch timed out')
      }
    }
    setDsLoading(false)
    // Only mark as fetched once the enriched catalog resolved. When there is no
    // session yet, mark fetched so the panel isn't stuck in a loading state — the
    // connect effect will re-run and re-fetch once a sessionId is available.
    if (catalogResolved || !sessionId) {
      setDsFetched(true)
    }
  }, [onRefreshFiles, onSyncDataSources, sessionId])

  // Lazy-load data sources when panel is active
  useEffect(() => {
    if (activePanel === 'data' && !dsFetched) {
      fetchDataSources()
    }
  }, [activePanel, dsFetched, fetchDataSources])

  // Also fetch data sources on connect (so AI chat always has the info).
  // This re-fires when the sessionId lands (not just on the status flip), and
  // keeps trying until the enriched catalog has actually loaded — so a transient
  // VM 502 or a status-before-sessionId race can't leave the icons missing.
  useEffect(() => {
    if (activeTab?.status === 'connected' && sessionId && !catalogLoaded) {
      fetchDataSources()
    }
  }, [activeTab?.status, sessionId, catalogLoaded, fetchDataSources])

  // Reset the catalog-loaded flag whenever the active session changes, so a newly
  // linked VM re-fetches its enriched catalog (entity docs are session-scoped for
  // local files and VM-catalog-scoped for schemas).
  useEffect(() => {
    setCatalogLoaded(false)
  }, [sessionId])

  // Re-fetch data sources when intel generation completes (local file entity
  // docs are created during intel generation — this ensures sparkle icons
  // appear for local files without requiring the user to manually refresh)
  useEffect(() => {
    const handler = () => fetchDataSources()
    window.addEventListener('refresh-datasources', handler)
    return () => window.removeEventListener('refresh-datasources', handler)
  }, [fetchDataSources])

  // --- Package fetching ---
  const fetchPackages = useCallback(async () => {
    if (!activeTab?.microvmEndpoint || activeTab?.status !== 'connected') return
    setPkgLoading(true)
    try {
      const headers = { 'Content-Type': 'application/json' }
      if (activeTab.sessionId) {
        headers['X-Session-Id'] = activeTab.sessionId
      }
      const resp = await fetchWithTimeout(`${activeTab.microvmEndpoint}/packages`, {
        method: 'GET',
        headers,
      })
      if (resp.ok) {
        const data = await resp.json()
        if (data.packages) {
          const pkgList = data.packages.map(p => ({ name: p.name, version: p.version }))
          setPackages(pkgList)
          if (onSyncPackages) onSyncPackages(pkgList)
        }
      }
    } catch {}
    setPkgLoading(false)
    setPkgFetched(true)
  }, [activeTab?.microvmEndpoint, activeTab?.sessionId, activeTab?.status])

  // Load packages when connected
  useEffect(() => {
    if (!pkgFetched && activeTab?.microvmEndpoint && activeTab?.status === 'connected') {
      fetchPackages()
    }
    if (!activeTab?.microvmEndpoint || activeTab?.status !== 'connected') {
      setPackages([])
      setPkgFetched(false)
    }
  }, [pkgFetched, activeTab?.microvmEndpoint, activeTab?.status])

  // Reset package state when switching tabs
  useEffect(() => {
    setPackages([])
    setPkgFetched(false)
  }, [activeTabId])

  const handleInstallPackage = async (pkgName) => {
    if (!activeTab?.microvmEndpoint) return { success: false, error: 'No VM connected' }
    try {
      const headers = { 'Content-Type': 'application/json' }
      if (activeTab.sessionId) {
        headers['X-Session-Id'] = activeTab.sessionId
      }
      const resp = await fetchWithTimeout(`${activeTab.microvmEndpoint}/install`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ package: pkgName }),
      })
      const result = await resp.json()
      if (result.success) {
        setPkgFetched(false) // trigger re-fetch
        return { success: true }
      } else {
        return { success: false, error: result.error || 'Install failed' }
      }
    } catch (err) {
      return { success: false, error: err.message }
    }
  }

  // --- VM badge fallback polling (only when instances prop is not provided) ---
  const fetchVmBadge = useCallback(async () => {
    try {
      const resp = await fetchWithTimeout(`${PROXY_URL}/instances`)
      if (resp.ok) {
        const data = await resp.json()
        setVmBadgeFallback(data.instances || {})
        if (data.persistence_mode) setPersistenceMode(data.persistence_mode)
      } else {
        setVmBadgeFallback({})
      }
    } catch {
      setVmBadgeFallback({})
    }
  }, [])

  useEffect(() => {
    // Only run the fallback poll if parent isn't providing instances
    if (Object.keys(instances).length > 0) return
    const interval = setInterval(fetchVmBadge, 15000)
    fetchVmBadge() // initial fetch
    return () => clearInterval(interval)
  }, [fetchVmBadge, instances])

  const formatDuration = (secs) => {
    if (!secs || secs < 60) return `${secs || 0}s`
    if (secs < 3600) return `${Math.floor(secs / 60)}m ${Math.round(secs % 60)}s`
    return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`
  }

  // Activity bar items
  // Grouped for visual separation in the activity bar (a divider is rendered whenever
  // the group changes). Group 1: workspace nav. Group 2: inspect the notebook + its env.
  // Group 3: runtime/interaction. Group 4: reusable content/templates.
  const activityItems = [
    { id: 'notebooks', group: 1, icon: <IconNotebook width={18} height={18} />, title: 'Notebooks (⌥1)', color: 'var(--accent-primary)' },
    { id: 'outline', group: 2, icon: <IconOutline width={18} height={18} />, title: 'Cell Outline (⌥2)', color: '#cba6f7' },
    { id: 'data', group: 2, icon: <IconDatabase width={18} height={18} />, title: 'Data Sources (⌥3)', color: '#7ec89f' },
    { id: 'variables', group: 2, icon: <IconBraces width={18} height={18} />, title: 'Variables (⌥4)', color: '#f9e2af' },
    { id: 'packages', group: 2, icon: <IconPackage width={18} height={18} />, title: 'Packages (⌥5)', color: '#f38ba8' },
    { id: 'terminal', group: 3, icon: <IconTerminal width={18} height={18} />, title: 'Terminal (⌥6)', color: '#5cc2d4' },
    { id: 'logs', group: 3, icon: <IconLogs width={18} height={18} />, title: 'MicroVM Logs (⌥7)', color: '#89b4fa' },
    { id: 'intel', group: 3, icon: <IconIntel width={18} height={18} />, title: 'Workbook Intel (⌥8)', color: '#f9e2af' },
    { id: 'snippets', group: 4, icon: <IconCode width={18} height={18} />, title: 'Snippets (⌥9)', color: '#f9e2af' },
    { id: 'samples', group: 4, icon: <IconSamples width={18} height={18} />, title: 'Sample Notebooks', color: '#e2b86b' },
  ]

  return (
    <aside className={`sidebar ${activePanel ? '' : 'sidebar-collapsed'}`}>
      {/* Activity Bar — always visible thin icon strip */}
      <div className="activity-bar">
        {activityItems.map((item, idx) => (
          <Fragment key={item.id}>
            {idx > 0 && activityItems[idx - 1].group !== item.group && (
              <div className="activity-bar-divider" aria-hidden="true" />
            )}
          <button
            className={`activity-bar-item ${
              item.id === 'terminal'
                ? (showTerminal ? 'activity-bar-item-active' : '')
                : item.id === 'logs'
                  ? (showLogs ? 'activity-bar-item-active' : '')
                  : item.id === 'intel'
                    ? (showIntel ? 'activity-bar-item-active' : '')
                    : (activePanel === item.id ? 'activity-bar-item-active' : '')
            } ${
              item.id === 'outline' && outlineRunStatus === 'running'
                ? 'activity-bar-item-run-active'
                : item.id === 'outline' && outlineRunStatus === 'error'
                  ? 'activity-bar-item-run-error'
                  : ''
            }`}
            onClick={() => {
              if (item.id === 'terminal') {
                onToggleTerminal?.()
              } else if (item.id === 'logs') {
                onToggleLogs?.()
              } else if (item.id === 'intel') {
                onToggleIntel?.()
              } else {
                if (item.id === 'outline' && outlineRunStatus === 'error') {
                  setOutlineRunStatus(null)  // user is opening Outline to inspect — clear the red flag
                }
                togglePanel(item.id)
              }
            }}
            title={item.title}
            style={
              (item.id === 'terminal' ? showTerminal : activePanel === item.id)
                ? { color: item.color, borderColor: item.color }
                : {}
            }
          >
            {item.icon}
          </button>
          </Fragment>
        ))}
        {/* MicroVMs at bottom */}
        <div className="activity-bar-spacer" />
        <button
          className={`activity-bar-item activity-bar-item-bottom ${activePanel === 'microvms' ? 'activity-bar-item-active' : ''} ${(() => {
            if (persistenceMode !== 'checkpoint') return ''
            const now = Date.now()
            for (const inst of Object.values(vmBadgeInstances)) {
              if (!inst.launched_at || !inst.max_duration_sec) continue
              const launchMs = typeof inst.launched_at === 'number' ? inst.launched_at * 1000 : new Date(inst.launched_at).getTime()
              const remaining = Math.max(0, (launchMs + inst.max_duration_sec * 1000 - now) / 1000)
              if (remaining <= 60) return 'activity-bar-item-critical'
              if (remaining <= 300) return 'activity-bar-item-warning'
            }
            return ''
          })()}`}
          onClick={() => togglePanel('microvms')}
          title="MicroVMs"
          style={activePanel === 'microvms' ? { color: 'var(--accent-primary)', borderColor: 'var(--accent-primary)' } : {}}
        >
          <IconServer width={18} height={18} />
          {Object.values(vmBadgeInstances).filter(i => i.state === 'RUNNING').length > 0 && (
            <span className="activity-bar-badge">
              {Object.values(vmBadgeInstances).filter(i => i.state === 'RUNNING').length}
            </span>
          )}
        </button>
        <button
          className={`activity-bar-item activity-bar-item-bottom ${activePanel === 'about' ? 'activity-bar-item-active' : ''}`}
          onClick={() => togglePanel('about')}
          title="About"
          style={activePanel === 'about' ? { color: 'var(--accent-primary)', borderColor: 'var(--accent-primary)' } : {}}
        >
          <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
        </button>
      </div>

      {/* Panel Content — shown when a panel is active */}
      {activePanel && (
        <div className="sidebar-panel" style={{ width: `${panelWidth}px`, minWidth: `${panelWidth}px` }}>
          {activePanel === 'notebooks' && (
            <NotebooksPanel
              tabs={tabs}
              activeTabId={activeTabId}
              onSelectTab={onSelectTab}
              onNewNotebook={onNewNotebook}
              onCloseTab={onCloseTab}
              onRenameTab={onRenameTab}
              onUpdateTabTag={onUpdateTabTag}
              onClose={() => setActivePanel(null)}
            />
          )}

          {activePanel === 'outline' && (
            <OutlinePanel
              cells={cells}
              activeTab={activeTab}
              onScrollToCell={onScrollToCell}
              onReorderCells={onReorderCells}
              onRunFromCell={onRunFromCell}
              onDeleteCells={onDeleteCells}
              onRunCells={onRunCells}
              onClearOutputs={onClearOutputs}
              onClose={() => setActivePanel(null)}
            />
          )}

          {activePanel === 'data' && (
            <DataSourcesPanel
              uploadedFiles={uploadedFiles}
              onUploadFile={onUploadFile}
              onDeleteFile={onDeleteFile}
              onInsertCode={onInsertCode}
              activeTab={activeTab}
              s3Files={s3Files}
              dynamoTables={dynamoTables}
              athenaTables={athenaTables}
              athenaWorkgroup={athenaWorkgroup}
              dsLoading={dsLoading}
              catalogEntries={catalogEntries}
              fetchDataSources={fetchDataSources}
              onClose={() => setActivePanel(null)}
            />
          )}

          {activePanel === 'snippets' && (
            <SnippetsPanel
              onInsertCode={onInsertCode}
              onClose={() => setActivePanel(null)}
            />
          )}

          {activePanel === 'samples' && (
            <SamplesPanel
              onLoadSample={onLoadSample}
              onClose={() => setActivePanel(null)}
            />
          )}

          {activePanel === 'variables' && (
            <VariablesPanel
              variables={variables}
              activeTab={activeTab}
              onInsertCode={onInsertCode}
              onClose={() => setActivePanel(null)}
            />
          )}

          {activePanel === 'packages' && (
            <PackagesPanel
              packages={packages}
              pkgLoading={pkgLoading}
              activeTab={activeTab}
              fetchPackages={() => { setPkgFetched(false); fetchPackages() }}
              onInstallPackage={handleInstallPackage}
              onUninstallPackage={async (pkgName) => {
                if (!activeTab?.microvmEndpoint) return { success: false, error: 'No VM connected' }
                try {
                  const headers = { 'Content-Type': 'application/json' }
                  if (activeTab.sessionId) headers['X-Session-Id'] = activeTab.sessionId
                  const resp = await fetchWithTimeout(`${activeTab.microvmEndpoint}/install`, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ package: pkgName, uninstall: true }),
                  })
                  const result = await resp.json()
                  return result.success ? { success: true } : { success: false, error: result.error }
                } catch (err) {
                  return { success: false, error: err.message }
                }
              }}
              onInsertCode={onInsertCode}
              onClose={() => setActivePanel(null)}
            />
          )}

          {activePanel === 'microvms' && (
            <MicroVMsPanel
              tabs={tabs}
              activeTab={activeTab}
              attachedIds={attachedIds}
              vmMetrics={vmMetrics}
              instances={instances}
              onAttachInstance={onAttachInstance}
              onTerminateAndSave={onTerminateAndSave}
              onSuspendInstance={onSuspendInstance}
              formatDuration={formatDuration}
              onClose={() => setActivePanel(null)}
            />
          )}

          {activePanel === 'about' && (
            <AboutPanel onClose={() => setActivePanel(null)} />
          )}

          {/* Resize handle */}
          <div className="sidebar-resize-handle" onMouseDown={handleResizeStart} />
        </div>
      )}
    </aside>
  )
}
