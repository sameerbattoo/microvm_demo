import { useState, useEffect, useCallback, useRef } from 'react'
import { IconX, IconNotebook, IconDatabase, IconCode, IconPackage, IconServer } from './Icons'
import { PROXY_URL } from '../config'
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
  onUploadSampleData,
  onInsertCode,
  cells = [],
  variables = {},
  activeTab = null,
  onScrollToCell,
  onReorderCells,
  onAttachInstance,
  onTerminateAndSave,
  onSuspendInstance,
  onUpdateTabTag,
  onSyncPackages,
  onSyncDataSources,
  instances = {},
  vmMetrics = {},
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
  const [athenaWorkgroup, setAthenaWorkgroup] = useState('microvm-demo')
  const [dsLoading, setDsLoading] = useState(false)
  const [dsFetched, setDsFetched] = useState(false)

  // VM badge state (for activity bar badge count)
  const [vmBadgeInstances, setVmBadgeInstances] = useState({})

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
      const newWidth = Math.min(480, Math.max(180, startWidth + delta))
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

  // --- Data Sources fetching ---
  const fetchDataSources = useCallback(async () => {
    setDsLoading(true)
    try {
      const resp = await fetch(`${PROXY_URL}/datasources`)
      if (resp.ok) {
        const data = await resp.json()
        setS3Files(data.s3 || [])
        setDynamoTables(data.dynamodb || [])
        setAthenaTables(data.athena || [])
        setAthenaWorkgroup(data.athena_workgroup || 'microvm-demo')
        if (onSyncDataSources) onSyncDataSources(data)
      }
    } catch {}
    setDsLoading(false)
    setDsFetched(true)
  }, [])

  // Lazy-load data sources when panel is active
  useEffect(() => {
    if (activePanel === 'data' && !dsFetched) {
      fetchDataSources()
    }
  }, [activePanel, dsFetched, fetchDataSources])

  // Also fetch data sources on connect (so AI chat always has the info)
  useEffect(() => {
    if (!dsFetched && activeTab?.status === 'connected') {
      fetchDataSources()
    }
  }, [activeTab?.status, dsFetched, fetchDataSources])

  // --- Package fetching ---
  const fetchPackages = useCallback(async () => {
    if (!activeTab?.microvmEndpoint || activeTab?.status !== 'connected') return
    setPkgLoading(true)
    try {
      const headers = { 'Content-Type': 'application/json' }
      if (activeTab.microvmId) {
        headers['X-MicroVM-Id'] = activeTab.microvmId
        if (activeTab.microvmRealEndpoint) headers['X-MicroVM-Endpoint'] = activeTab.microvmRealEndpoint
      }
      const resp = await fetch(`${activeTab.microvmEndpoint}/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ code: `import subprocess, json\n_r = subprocess.run(["pip", "list", "--format=json"], capture_output=True, text=True)\nprint(json.dumps(json.loads(_r.stdout) if _r.returncode == 0 else []))` }),
      })
      if (resp.ok) {
        const data = await resp.json()
        if (data.success && data.output) {
          const pkgList = JSON.parse(data.output.trim()).map(p => ({ name: p.name, version: p.version }))
          setPackages(pkgList)
          if (onSyncPackages) onSyncPackages(pkgList)
        }
      }
    } catch {}
    setPkgLoading(false)
    setPkgFetched(true)
  }, [activeTab?.microvmEndpoint, activeTab?.microvmId, activeTab?.microvmRealEndpoint, activeTab?.status])

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
      if (activeTab.microvmId) {
        headers['X-MicroVM-Id'] = activeTab.microvmId
        if (activeTab.microvmRealEndpoint) headers['X-MicroVM-Endpoint'] = activeTab.microvmRealEndpoint
      }
      const resp = await fetch(`${activeTab.microvmEndpoint}/install`, {
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

  // --- VM badge polling (for activity bar badge when MicroVMs panel is NOT active) ---
  const fetchVmBadge = useCallback(async () => {
    try {
      const resp = await fetch(`${PROXY_URL}/instances`)
      if (resp.ok) {
        const data = await resp.json()
        setVmBadgeInstances(data.instances || {})
      } else {
        setVmBadgeInstances({})
      }
    } catch {
      setVmBadgeInstances({})
    }
  }, [])

  useEffect(() => {
    if (activePanel === 'microvms') return // MicroVMsPanel handles its own polling
    const interval = setInterval(fetchVmBadge, 15000)
    fetchVmBadge() // initial fetch
    return () => clearInterval(interval)
  }, [activePanel, fetchVmBadge])

  const formatDuration = (secs) => {
    if (!secs || secs < 60) return `${secs || 0}s`
    if (secs < 3600) return `${Math.floor(secs / 60)}m ${Math.round(secs % 60)}s`
    return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`
  }

  // Activity bar items
  const activityItems = [
    { id: 'notebooks', icon: <IconNotebook width={18} height={18} />, title: 'Notebooks', color: 'var(--accent-primary)' },
    { id: 'outline', icon: <IconOutline width={18} height={18} />, title: 'Cell Outline', color: '#cba6f7' },
    { id: 'data', icon: <IconDatabase width={18} height={18} />, title: 'Data Sources', color: '#7ec89f' },
    { id: 'variables', icon: <IconCode width={18} height={18} />, title: 'Variables', color: '#f9e2af' },
    { id: 'packages', icon: <IconPackage width={18} height={18} />, title: 'Packages', color: '#f38ba8' },
    { id: 'samples', icon: <IconSamples width={18} height={18} />, title: 'Sample Notebooks', color: '#e2b86b' },
  ]

  return (
    <aside className={`sidebar ${activePanel ? '' : 'sidebar-collapsed'}`}>
      {/* Activity Bar — always visible thin icon strip */}
      <div className="activity-bar">
        {activityItems.map(item => (
          <button
            key={item.id}
            className={`activity-bar-item ${activePanel === item.id ? 'activity-bar-item-active' : ''}`}
            onClick={() => togglePanel(item.id)}
            title={item.title}
            style={activePanel === item.id ? { color: item.color, borderColor: item.color } : {}}
          >
            {item.icon}
          </button>
        ))}
        {/* MicroVMs at bottom */}
        <div className="activity-bar-spacer" />
        <button
          className={`activity-bar-item activity-bar-item-bottom ${activePanel === 'microvms' ? 'activity-bar-item-active' : ''} ${(() => {
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
          style={activePanel === 'microvms' ? { color: '#5cc2d4', borderColor: '#5cc2d4' } : {}}
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
          style={activePanel === 'about' ? { color: '#89b4fa', borderColor: '#89b4fa' } : {}}
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
              onClose={() => setActivePanel(null)}
            />
          )}

          {activePanel === 'data' && (
            <DataSourcesPanel
              uploadedFiles={uploadedFiles}
              onUploadFile={onUploadFile}
              onDeleteFile={onDeleteFile}
              onUploadSampleData={onUploadSampleData}
              onInsertCode={onInsertCode}
              activeTab={activeTab}
              s3Files={s3Files}
              dynamoTables={dynamoTables}
              athenaTables={athenaTables}
              athenaWorkgroup={athenaWorkgroup}
              dsLoading={dsLoading}
              fetchDataSources={fetchDataSources}
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
              onClose={() => setActivePanel(null)}
            />
          )}

          {activePanel === 'microvms' && (
            <MicroVMsPanel
              tabs={tabs}
              activeTab={activeTab}
              attachedIds={attachedIds}
              vmMetrics={vmMetrics}
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
