import { useState, useEffect, useCallback, useRef } from 'react'
import { IconUpload, IconFile, IconDatabase, IconBucket, IconRefresh, IconPlus, IconX, IconChevronDown, IconChevronRight, IconNotebook, IconServer, IconTable, IconCode, IconPackage } from './Icons'
import VariablePreviewRenderer from './VariablePreviewRenderer'
import { PROXY_URL } from '../config'
import './Sidebar.css'

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

function IconAI({ width = 16, height = 16 }) {
  return (
    <svg width={width} height={height} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2l3 7h7l-5.5 4 2 7L12 16l-6.5 4 2-7L2 9h7z" />
    </svg>
  )
}

const TYPE_ICONS = {
  DataFrame: '📊', Series: '📈', ndarray: '🔢', list: '[ ]', dict: '{ }',
  tuple: '( )', str: 'abc', int: '#', float: '#.', bool: '⊘', NoneType: '∅',
}

function getTypeIcon(type) { return TYPE_ICONS[type] || '◇' }

function getTypeColor(type) {
  if (['DataFrame', 'Series'].includes(type)) return 'var-type-dataframe'
  if (['list', 'tuple', 'set'].includes(type)) return 'var-type-collection'
  if (['dict'].includes(type)) return 'var-type-dict'
  if (['int', 'float', 'complex'].includes(type)) return 'var-type-number'
  if (['str'].includes(type)) return 'var-type-string'
  if (['bool', 'NoneType'].includes(type)) return 'var-type-bool'
  return 'var-type-other'
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
}) {
  // Activity bar state — which panel is active (null = collapsed)
  const [activePanel, setActivePanel] = useState(() => {
    try {
      return localStorage.getItem('microvm-sidebar-panel') || 'notebooks'
    } catch { return 'notebooks' }
  })

  // Existing section expand states
  const [dataSourcesExpanded, setDataSourcesExpanded] = useState(true)
  const [sampleNotebooksExpanded, setSampleNotebooksExpanded] = useState(true)
  const [sampleDataExpanded, setSampleDataExpanded] = useState(true)
  const [s3Expanded, setS3Expanded] = useState(true)
  const [dynamoExpanded, setDynamoExpanded] = useState(true)
  const [athenaExpanded, setAthenaExpanded] = useState(true)
  const [publicApisExpanded, setPublicApisExpanded] = useState(true)
  const [editingId, setEditingId] = useState(null)
  const [editValue, setEditValue] = useState('')
  const [editingTagId, setEditingTagId] = useState(null)
  const [editTagValue, setEditTagValue] = useState('')
  const [collapsedTags, setCollapsedTags] = useState({})

  // Cell outline search
  const [outlineSearch, setOutlineSearch] = useState('')
  // Outline drag state
  const [outlineDragIdx, setOutlineDragIdx] = useState(null)
  const [outlineDragOverIdx, setOutlineDragOverIdx] = useState(null)
  // Variable explorer
  const [expandedVar, setExpandedVar] = useState(null)
  // Package manager state
  const [packages, setPackages] = useState([])
  const [pkgLoading, setPkgLoading] = useState(false)
  const [pkgFetched, setPkgFetched] = useState(false)
  const [installPkg, setInstallPkg] = useState('')
  const [installStatus, setInstallStatus] = useState(null)
  const [installMessage, setInstallMessage] = useState('')
  const [pkgFilter, setPkgFilter] = useState('')
  // MicroVM instances state
  const [vmInstances, setVmInstances] = useState({})
  const [vmLoading, setVmLoading] = useState(false)
  const [vmFetched, setVmFetched] = useState(false)
  const [expandedVmId, setExpandedVmId] = useState(null)
  const [vmActionInProgress, setVmActionInProgress] = useState(new Set())
  // Panel resize
  const [panelWidth, setPanelWidth] = useState(() => {
    try { return parseInt(localStorage.getItem('microvm-sidebar-width')) || 240 } catch { return 240 }
  })
  const isResizing = useRef(false)

  // External data sources state
  const [s3Files, setS3Files] = useState([])
  const [dynamoTables, setDynamoTables] = useState([])
  const [athenaTables, setAthenaTables] = useState([])
  const [artifactBucket, setArtifactBucket] = useState('')
  const [athenaWorkgroup, setAthenaWorkgroup] = useState('microvm-demo')
  const [dsLoading, setDsLoading] = useState(false)
  const [dsFetched, setDsFetched] = useState(false)

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

  const startRename = (e, tab) => {
    e.stopPropagation()
    setEditingId(tab.id)
    setEditValue(tab.name)
  }

  const commitRename = () => {
    if (editingId && editValue.trim()) {
      onRenameTab(editingId, editValue.trim())
    }
    setEditingId(null)
  }

  const fetchDataSources = useCallback(async () => {
    setDsLoading(true)
    try {
      const resp = await fetch(`${PROXY_URL}/datasources`)
      if (resp.ok) {
        const data = await resp.json()
        setS3Files(data.s3 || [])
        setDynamoTables(data.dynamodb || [])
        setAthenaTables(data.athena || [])
        setArtifactBucket(data.artifact_bucket || '')
        setAthenaWorkgroup(data.athena_workgroup || 'microvm-demo')
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

  // Load packages when connected (runs in background, not tied to panel being active)
  useEffect(() => {
    if (!pkgFetched && activeTab?.microvmEndpoint && activeTab?.status === 'connected') {
      fetchPackages()
    }
    // Clear packages when no active connection
    if (!activeTab?.microvmEndpoint || activeTab?.status !== 'connected') {
      setPackages([])
      setPkgFetched(false)
    }
  }, [pkgFetched, activeTab?.microvmEndpoint, activeTab?.status])

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

  const handleInstallPkg = async () => {
    if (!installPkg.trim() || !activeTab?.microvmEndpoint) return
    setInstallStatus('installing')
    setInstallMessage('')
    try {
      const headers = { 'Content-Type': 'application/json' }
      if (activeTab.microvmId) {
        headers['X-MicroVM-Id'] = activeTab.microvmId
        if (activeTab.microvmRealEndpoint) headers['X-MicroVM-Endpoint'] = activeTab.microvmRealEndpoint
      }
      const resp = await fetch(`${activeTab.microvmEndpoint}/install`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ package: installPkg.trim() }),
      })
      const result = await resp.json()
      if (result.success) {
        setInstallStatus('success')
        setInstallMessage(`Installed ${installPkg}`)
        setInstallPkg('')
        setPkgFetched(false) // trigger re-fetch
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

  // MicroVM instances
  const fetchVmInstances = useCallback(async (showLoading = true) => {
    if (showLoading) setVmLoading(true)
    try {
      const resp = await fetch(`${PROXY_URL}/instances`)
      if (resp.ok) {
        const data = await resp.json()
        setVmInstances(data.instances || {})
      } else {
        setVmInstances({})
      }
    } catch {
      // Proxy not reachable — clear stale data
      setVmInstances({})
    }
    setVmLoading(false)
    setVmFetched(true)
  }, [])

  useEffect(() => {
    if (activePanel === 'microvms' && !vmFetched) {
      fetchVmInstances()
    }
  }, [activePanel, vmFetched, fetchVmInstances])

  // Auto-refresh VMs every 10s when panel is active
  useEffect(() => {
    if (activePanel !== 'microvms') return
    const interval = setInterval(() => fetchVmInstances(false), 10000)
    return () => clearInterval(interval)
  }, [activePanel, fetchVmInstances])

  // Also poll for badge count even when panel isn't active (every 15s)
  useEffect(() => {
    if (activePanel === 'microvms') return // already polling above
    const interval = setInterval(() => fetchVmInstances(false), 15000)
    fetchVmInstances(false) // initial fetch for badge
    return () => clearInterval(interval)
  }, [activePanel, fetchVmInstances])

  // Auto-expand the VM connected to the active notebook
  useEffect(() => {
    if (activePanel === 'microvms' && activeTab?.microvmId) {
      setExpandedVmId(activeTab.microvmId)
    }
  }, [activePanel, activeTab?.microvmId])

  const handleVmResume = async (id) => {
    setVmActionInProgress(prev => new Set([...prev, id]))
    try {
      const resp = await fetch(`${PROXY_URL}/resume/${id}`, { method: 'POST' })
      if (resp.ok) await fetchVmInstances()
    } catch {}
    setVmActionInProgress(prev => { const n = new Set(prev); n.delete(id); return n })
  }

  const handleVmTerminate = async (id) => {
    setVmActionInProgress(prev => new Set([...prev, id]))
    try {
      await fetch(`${PROXY_URL}/terminate/${id}`, { method: 'POST' })
      await fetchVmInstances()
    } catch {}
    setVmActionInProgress(prev => { const n = new Set(prev); n.delete(id); return n })
  }

  const formatDuration = (secs) => {
    if (!secs || secs < 60) return `${secs || 0}s`
    if (secs < 3600) return `${Math.floor(secs / 60)}m ${Math.round(secs % 60)}s`
    return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`
  }

  const samples = [
    { id: 'sales_analysis', name: 'Sales Data Analysis', icon: '📊', file: '/samples/sales_analysis.notebook.json' },
    { id: 'time_series', name: 'Time Series Forecasting', icon: '📈', file: '/samples/time_series.notebook.json' },
    { id: 'data_cleaning', name: 'Data Cleaning & Transform', icon: '🧹', file: '/samples/data_cleaning.notebook.json' },
    { id: 'statistical_analysis', name: 'Statistical Analysis', icon: '🔬', file: '/samples/statistical_analysis.notebook.json' },
    { id: 'public_apis', name: 'Public API Data Analysis', icon: '🌐', file: '/samples/public_apis.notebook.json' },
    { id: 'aws_data_sources', name: 'AWS Data Sources', icon: '☁️', file: '/samples/aws_data_sources.notebook.json' },
  ]

  const sampleDataFiles = [
    { name: 'sales_data.csv', size: '500 rows', desc: 'Orders with products, regions, discounts' },
    { name: 'customers.csv', size: '200 rows', desc: 'Customer data (some messy values)' },
    { name: 'web_traffic.csv', size: '730 rows', desc: 'Daily visitors over 2 years' },
    { name: 'ab_test_results.csv', size: '1000 rows', desc: 'A/B test conversion data' },
  ]

  const publicApis = [
    { id: 'worldbank', name: 'World Bank', icon: '🌍', desc: 'Country indicators & economics', code: `import pandas as pd, requests\n\n# Indicators: NY.GDP.MKTP.CD=GDP($), SP.POP.TOTL=Population, EN.ATM.CO2E.KT=CO2 emissions\ndef world_bank(indicator='NY.GDP.MKTP.CD', country='all', date='2018:2023'):\n    url = f'https://api.worldbank.org/v2/country/{country}/indicator/{indicator}?date={date}&format=json&per_page=300'\n    resp = requests.get(url).json()\n    df = pd.DataFrame(resp[1])[['country','date','value']]\n    df['country'] = df['country'].apply(lambda x: x['value'])\n    return df.dropna(subset=['value'])\n\ndf = world_bank()  # GDP in current US$ for all countries\ndf.head(20)` },
    { id: 'countries', name: 'World Countries', icon: '🗺️', desc: '200+ countries with region, income, capital', code: `import pandas as pd, requests\n\nresp = requests.get('https://api.worldbank.org/v2/country/all?format=json&per_page=300').json()\ndf = pd.DataFrame(resp[1])[['name','region','capitalCity','incomeLevel','longitude','latitude']]\ndf['region'] = df['region'].apply(lambda x: x['value'])\ndf['incomeLevel'] = df['incomeLevel'].apply(lambda x: x['value'])\ndf = df[df['capitalCity'] != '']  # Filter out aggregates\ndf.head(20)` },
    { id: 'coingecko', name: 'CoinGecko', icon: '💰', desc: 'Cryptocurrency market data', code: `import pandas as pd, requests\n\nresp = requests.get('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=50').json()\ndf = pd.DataFrame(resp)[['name','symbol','current_price','market_cap','price_change_percentage_24h','total_volume']]\ndf.head(20)` },
    { id: 'openmeteo', name: 'Open-Meteo', icon: '🌤️', desc: 'Weather forecast & historical data', code: `import pandas as pd, requests\n\ndef weather_forecast(lat, lon, days=7):\n    """Hourly weather forecast. Cities: NYC(40.71,-74.01), London(51.5,-0.12), Tokyo(35.68,139.69)"""\n    url = f'https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&hourly=temperature_2m,precipitation,wind_speed_10m&timezone=auto&forecast_days={days}'\n    data = requests.get(url).json()\n    df = pd.DataFrame(data['hourly'])\n    df['time'] = pd.to_datetime(df['time'])\n    return df\n\ndf = weather_forecast(40.71, -74.01)  # New York\ndf.head(20)` },
    { id: 'earthquakes', name: 'USGS Earthquakes', icon: '🌋', desc: 'Recent seismic activity worldwide', code: `import pandas as pd, requests\n\ndef earthquakes(min_mag='4.5', period='month'):\n    """Seismic activity.\n    min_mag: '1.0', '2.5', '4.5', or 'significant' (only these are valid)\n    period: 'hour', 'day', 'week', or 'month'"""\n    valid_mags = ['1.0', '2.5', '4.5', 'significant']\n    if min_mag not in valid_mags:\n        raise ValueError(f'min_mag must be one of {valid_mags}')\n    url = f'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/{min_mag}_{period}.geojson'\n    data = requests.get(url).json()\n    eqs = pd.json_normalize(data['features'])\n    df = eqs[['properties.mag','properties.place','properties.time']].copy()\n    df.columns = ['magnitude','place','time']\n    df['time'] = pd.to_datetime(df['time'], unit='ms')\n    return df.sort_values('magnitude', ascending=False)\n\ndf = earthquakes('4.5', 'month')\ndf.head(20)` },
    { id: 'nasa', name: 'NASA APOD', icon: '🚀', desc: 'Astronomy Picture of the Day', code: `import pandas as pd, requests\n\ndef nasa_apod(count=20):\n    """Astronomy Picture of the Day. count: number of random entries to fetch"""\n    resp = requests.get(f'https://api.nasa.gov/planetary/apod?api_key=DEMO_KEY&count={count}').json()\n    return pd.DataFrame(resp)[['date','title','url','explanation']]\n\ndf = nasa_apod(20)\ndf` },
    { id: 'openlibrary', name: 'Open Library', icon: '📚', desc: 'Search books and authors', code: `import pandas as pd, requests\n\ndef search_books(query='machine learning', limit=20):\n    """Search Open Library. Returns title, author, year, editions."""\n    resp = requests.get(f'https://openlibrary.org/search.json?q={query}&limit={limit}').json()\n    df = pd.DataFrame(resp['docs'])[['title','author_name','first_publish_year','edition_count']]\n    df['author_name'] = df['author_name'].apply(lambda x: x[0] if isinstance(x, list) and x else None)\n    return df.sort_values('edition_count', ascending=False)\n\ndf = search_books('machine learning', 20)\ndf` },
    { id: 'publicholidays', name: 'Public Holidays', icon: '📅', desc: 'Holidays by country and year', code: `import pandas as pd, requests\n\ndef public_holidays(country='US', year=2025):\n    """Get holidays. Countries: US, GB, DE, FR, JP, IN, AU, CA"""\n    resp = requests.get(f'https://date.nager.at/api/v3/publicholidays/{year}/{country}').json()\n    return pd.DataFrame(resp)[['date','localName','name','countryCode']]\n\ndf = public_holidays('US', 2025)\ndf` },
  ]

  const handleFileUpload = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.csv,.xlsx,.xls,.parquet,.json,.txt'
    input.multiple = true
    input.onchange = (e) => {
      Array.from(e.target.files || []).forEach(file => {
        onUploadFile(file)
      })
    }
    input.click()
  }

  // Cell outline: build cell list with labels
  let codeCounter = 0
  const cellOutlineItems = cells.map((cell, idx) => {
    let label = ''
    let icon = ''
    let cellType = cell.type || 'code'

    if (cellType === 'markdown') {
      // Extract first heading or first line
      const firstLine = (cell.code || '').split('\n').find(l => l.trim()) || ''
      if (firstLine.startsWith('#')) {
        label = firstLine.replace(/^#+\s*/, '')
      } else {
        label = firstLine.slice(0, 60)
      }
      icon = 'M'
    } else {
      codeCounter++
      // Code cell — show the most meaningful line (skip imports and comments)
      const lines = (cell.code || '').split('\n').filter(l => l.trim())
      const meaningfulLine = lines.find(l => !l.trim().startsWith('import ') && !l.trim().startsWith('from ') && !l.trim().startsWith('#'))
      if (meaningfulLine) {
        label = meaningfulLine.trim().slice(0, 50)
      } else if (lines.length > 0) {
        // All imports — show summary
        const pkgs = lines.filter(l => l.trim().startsWith('import ') || l.trim().startsWith('from '))
          .map(l => l.replace(/^(import |from )/, '').split(/[\s,.]/)[0])
          .slice(0, 3)
        label = `imports: ${pkgs.join(', ')}`
      } else {
        label = '(empty)'
      }
      icon = `${codeCounter}`
    }

    return { id: cell.id, idx, label, icon, cellType, hasOutput: !!(cell.output || cell.html || cell.image), hasError: !!cell.error, isStale: cell.lastExecutedCode != null && cell.code !== cell.lastExecutedCode, aiExplanation: cell.aiExplanation || null }
  })

  const filteredOutline = outlineSearch
    ? cellOutlineItems.filter(item => item.label.toLowerCase().includes(outlineSearch.toLowerCase()))
    : cellOutlineItems

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
          className={`activity-bar-item activity-bar-item-bottom ${activePanel === 'microvms' ? 'activity-bar-item-active' : ''}`}
          onClick={() => togglePanel('microvms')}
          title="MicroVMs"
          style={activePanel === 'microvms' ? { color: '#5cc2d4', borderColor: '#5cc2d4' } : {}}
        >
          <IconServer width={18} height={18} />
          {Object.values(vmInstances).filter(i => i.state === 'RUNNING').length > 0 && (
            <span className="activity-bar-badge">
              {Object.values(vmInstances).filter(i => i.state === 'RUNNING').length}
            </span>
          )}
        </button>
      </div>

      {/* Panel Content — shown when a panel is active */}
      {activePanel && (
        <div className="sidebar-panel" style={{ width: `${panelWidth}px`, minWidth: `${panelWidth}px` }}>
          {/* NOTEBOOKS PANEL */}
          {activePanel === 'notebooks' && (
            <div className="sidebar-panel-content">
              <div className="sidebar-panel-header">
                <span className="sidebar-panel-title">Notebooks</span>
                <button
                  className="sidebar-panel-action"
                  onClick={onNewNotebook}
                  title="New notebook"
                >
                  <IconPlus width={14} height={14} />
                </button>
                <button className="sidebar-panel-close" onClick={() => setActivePanel(null)} title="Close panel"><IconX width={12} height={12} /></button>
              </div>
              <div className="sidebar-panel-body">
                {tabs.length === 0 && (
                  <div className="sidebar-empty">No notebooks open</div>
                )}
                {(() => {
                  // Group tabs by tag
                  const groups = {}
                  tabs.forEach(tab => {
                    const tag = tab.tag || 'Untitled'
                    if (!groups[tag]) groups[tag] = []
                    groups[tag].push(tab)
                  })
                  const tagOrder = Object.keys(groups).sort((a, b) => {
                    // Drafts first, Samples last, rest alphabetical
                    if (a === 'Drafts') return -1
                    if (b === 'Drafts') return 1
                    if (a === 'Samples') return 1
                    if (b === 'Samples') return -1
                    return a.localeCompare(b)
                  })
                  return tagOrder.map(tag => (
                    <div key={tag} className="nb-tag-group">
                      <div
                        className="nb-tag-header"
                        onClick={() => setCollapsedTags(prev => ({ ...prev, [tag]: !prev[tag] }))}
                      >
                        <span className="nb-tag-chevron">{collapsedTags[tag] ? '▸' : '▾'}</span>
                        <span className="nb-tag-name">{tag}</span>
                        {tag === 'Drafts' && (
                          <button
                            className="nb-tag-autotag-btn"
                            onClick={(e) => {
                              e.stopPropagation()
                              groups[tag].forEach(t => {
                                const cellData = (t._cells || []).slice(0, 4).map(c => ({ type: c.type || 'code', code: (c.code || '').slice(0, 200) }))
                                if (cellData.length >= 2) {
                                  fetch(`${PROXY_URL}/ai/suggest-tag`, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ name: t.name, description: t.description || '', cells: cellData }),
                                  })
                                    .then(r => r.json())
                                    .then(data => { if (data.tag && data.tag !== 'Drafts') onUpdateTabTag(t.id, data.tag) })
                                    .catch(() => {})
                                }
                              })
                            }}
                            title="Auto-tag all drafts with AI"
                          >
                            <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
                          </button>
                        )}
                        <span className="nb-tag-count">{groups[tag].length}</span>
                      </div>
                      {!collapsedTags[tag] && groups[tag].map(tab => (
                        <div
                          key={tab.id}
                          className={`sidebar-item ${tab.id === activeTabId ? 'sidebar-item-active' : ''}`}
                          onClick={() => onSelectTab(tab.id)}
                          onDoubleClick={(e) => startRename(e, tab)}
                          title={tab.description || ''}
                        >
                          <span className={`sidebar-item-dot sidebar-dot-${tab.status}`} />
                          {editingId === tab.id ? (
                            <input
                              className="sidebar-rename-input"
                              value={editValue}
                              onChange={(e) => setEditValue(e.target.value)}
                              onBlur={commitRename}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') commitRename()
                                if (e.key === 'Escape') setEditingId(null)
                              }}
                              onClick={(e) => e.stopPropagation()}
                              autoFocus
                            />
                          ) : (
                            <span className="sidebar-item-label">{tab.name}</span>
                          )}
                          {/* Tag edit */}
                          {editingTagId === tab.id ? (
                            <input
                              className="sidebar-tag-input"
                              value={editTagValue}
                              onChange={(e) => setEditTagValue(e.target.value)}
                              onBlur={() => { if (editTagValue.trim()) onUpdateTabTag(tab.id, editTagValue.trim()); setEditingTagId(null) }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') { if (editTagValue.trim()) onUpdateTabTag(tab.id, editTagValue.trim()); setEditingTagId(null) }
                                if (e.key === 'Escape') setEditingTagId(null)
                              }}
                              onClick={(e) => e.stopPropagation()}
                              autoFocus
                              placeholder="Tag name"
                            />
                          ) : (
                            <button
                              className="sidebar-tag-btn"
                              onClick={(e) => { e.stopPropagation(); setEditingTagId(tab.id); setEditTagValue(tab.tag || '') }}
                              title="Change tag"
                            >
                              #
                            </button>
                          )}
                          <button
                            className="sidebar-item-close"
                            onClick={(e) => { e.stopPropagation(); onCloseTab(tab.id) }}
                            title="Close"
                          >
                            <IconX width={12} height={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                  ))
                })()}
              </div>
            </div>
          )}

          {/* CELL OUTLINE PANEL */}
          {activePanel === 'outline' && (
            <div className="sidebar-panel-content">
              <div className="sidebar-panel-header">
                <span className="sidebar-panel-title">Outline</span>
                <span className="sidebar-panel-count">{cells.length} cells</span>
                <button className="sidebar-panel-close" onClick={() => setActivePanel(null)} title="Close panel"><IconX width={12} height={12} /></button>
              </div>
              {activeTab && <div className="sidebar-scope-pill"><IconNotebook width={12} height={12} /> {activeTab.name}</div>}
              <div className="outline-search">
                <input
                  className="outline-search-input"
                  type="text"
                  placeholder="Jump to or search..."
                  value={outlineSearch}
                  onChange={(e) => setOutlineSearch(e.target.value)}
                />
              </div>
              <div className="sidebar-panel-body outline-list">
                {filteredOutline.length === 0 && (
                  <div className="sidebar-empty">
                    {cells.length === 0 ? 'No cells in this notebook' : 'No matching cells'}
                  </div>
                )}
                {filteredOutline.map(item => (
                  <div
                    key={item.id}
                    className={`outline-item outline-item-${item.cellType}${outlineDragOverIdx === item.idx ? ' outline-item-dragover' : ''}`}
                    onClick={() => onScrollToCell && onScrollToCell(item.idx)}
                    draggable={!outlineSearch}
                    onDragStart={() => setOutlineDragIdx(item.idx)}
                    onDragOver={(e) => { e.preventDefault(); setOutlineDragOverIdx(item.idx) }}
                    onDrop={() => {
                      if (outlineDragIdx != null && outlineDragIdx !== item.idx) {
                        onReorderCells && onReorderCells(outlineDragIdx, item.idx)
                      }
                      setOutlineDragIdx(null)
                      setOutlineDragOverIdx(null)
                    }}
                    onDragEnd={() => { setOutlineDragIdx(null); setOutlineDragOverIdx(null) }}
                    title={item.aiExplanation || item.label}
                  >
                    <span className={`outline-item-icon outline-icon-${item.cellType}`}>
                      {item.cellType === 'markdown' ? 'M' : <>{item.icon}</>}
                    </span>
                    <span className="outline-item-label">{item.label}</span>
                    {item.isStale && <span className="outline-item-status outline-status-stale" title="Modified since last run">●</span>}
                    {item.hasError && <span className="outline-item-status outline-status-error">✗</span>}
                    {!item.hasError && item.hasOutput && <span className="outline-item-status outline-status-success">✓</span>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* DATA SOURCES PANEL */}
          {activePanel === 'data' && (
            <div className="sidebar-panel-content">
              <div className="sidebar-panel-header">
                <span className="sidebar-panel-title">Data Sources</span>
                <button className="sidebar-panel-action" onClick={fetchDataSources} title="Refresh">
                  <IconRefresh width={14} height={14} />
                </button>
                <button className="sidebar-panel-action" onClick={handleFileUpload} title="Upload file">
                  <IconUpload width={14} height={14} />
                </button>
                <button className="sidebar-panel-close" onClick={() => setActivePanel(null)} title="Close panel"><IconX width={12} height={12} /></button>
              </div>
              {activeTab && <div className="sidebar-scope-pill"><IconNotebook width={12} height={12} /> {activeTab.name}</div>}
              <div className="sidebar-panel-body">
                {/* Sandbox Files */}
                <div className="sidebar-subheader sidebar-subheader-toggle">
                  <IconUpload width={11} height={11} className="sidebar-icon-file-csv" /> Sandbox Files <span className="sidebar-subheader-hint">local to VM</span>
                </div>
                {uploadedFiles.length > 0 ? (
                  <>
                    {uploadedFiles.map(file => (
                      <div
                        key={file.name}
                        className="sidebar-file-item sidebar-ds-clickable"
                        onClick={() => onInsertCode && onInsertCode(`import pandas as pd\n\n${file.variable || 'df'} = pd.read_csv('/tmp/${file.name}')\n${file.variable || 'df'}.head()`)}
                        title={`Click to insert: pd.read_csv('/tmp/${file.name}')`}
                      >
                        <span className="sidebar-file-icon sidebar-icon-file-csv">
                          <IconFile width={13} height={13} />
                        </span>
                        <div className="sidebar-file-info">
                          <span className="sidebar-file-name" title={file.name}>{file.name}</span>
                          <span className="sidebar-file-meta">{file.size} · {file.variable || 'uploading...'}</span>
                        </div>
                        <button
                          className="sidebar-file-delete"
                          onClick={(e) => { e.stopPropagation(); onDeleteFile(file.name) }}
                          title="Remove"
                        >
                          <IconX width={11} height={11} />
                        </button>
                      </div>
                    ))}
                  </>
                ) : (
                  <div className="sidebar-empty-inline">No files in sandbox.</div>
                )}

                {/* Sample Data */}
                <div className="sidebar-subheader sidebar-subheader-toggle" onClick={() => setSampleDataExpanded(!sampleDataExpanded)}>
                  <IconFile width={11} height={11} /> Sample Data
                  <span className="sidebar-subheader-chevron">{sampleDataExpanded ? '▾' : '▸'}</span>
                </div>
                {sampleDataExpanded && sampleDataFiles.map(sample => (
                  <div
                    key={sample.name}
                    className="sidebar-file-item sidebar-sample-data"
                    onClick={() => onUploadSampleData(sample.name)}
                    title={sample.desc}
                  >
                    <span className="sidebar-file-icon sidebar-icon-file-csv">
                      <IconFile width={13} height={13} />
                    </span>
                    <div className="sidebar-file-info">
                      <span className="sidebar-file-name">{sample.name}</span>
                      <span className="sidebar-file-meta">{sample.size}</span>
                    </div>
                  </div>
                ))}

                {/* S3 Bucket */}
                <div className="sidebar-subheader sidebar-subheader-toggle" onClick={() => setS3Expanded(!s3Expanded)}>
                  <IconBucket width={11} height={11} className="sidebar-icon-s3" /> S3 Bucket
                  {s3Files.length > 0 && <span className="sidebar-subheader-count">{s3Files.length} files</span>}
                  <span className="sidebar-subheader-chevron">{s3Expanded ? '▾' : '▸'}</span>
                </div>
                {s3Expanded && (
                  <>
                    {dsLoading && <div className="sidebar-empty-inline">Loading...</div>}
                    {!dsLoading && s3Files.length === 0 && <div className="sidebar-empty-inline">No S3 files found.</div>}
                    {s3Files.map(file => (
                      <div
                        key={file.key}
                        className="sidebar-file-item sidebar-ds-clickable"
                        onClick={() => onInsertCode && onInsertCode(`import boto3, pandas as pd\n\ndef read_s3_csv(bucket, key):\n    obj = boto3.client('s3').get_object(Bucket=bucket, Key=key)\n    return pd.read_csv(obj['Body'])\n\ndf = read_s3_csv('${file.bucket}', '${file.key}')\ndf.head()`)}
                        title={`Click to insert code: read '${file.key}' from S3`}
                      >
                        <span className="sidebar-file-icon sidebar-icon-s3"><IconFile width={13} height={13} /></span>
                        <div className="sidebar-file-info">
                          <span className="sidebar-file-name">{file.key}</span>
                          <span className="sidebar-file-meta">{file.size}</span>
                        </div>
                      </div>
                    ))}
                  </>
                )}

                {/* DynamoDB */}
                <div className="sidebar-subheader sidebar-subheader-toggle" onClick={() => setDynamoExpanded(!dynamoExpanded)}>
                  <IconDatabase width={11} height={11} className="sidebar-icon-dynamodb" /> DynamoDB
                  {dynamoTables.length > 0 && <span className="sidebar-subheader-count">{dynamoTables.length} tables</span>}
                  <span className="sidebar-subheader-chevron">{dynamoExpanded ? '▾' : '▸'}</span>
                </div>
                {dynamoExpanded && (
                  <>
                    {dsLoading && <div className="sidebar-empty-inline">Loading...</div>}
                    {!dsLoading && dynamoTables.length === 0 && <div className="sidebar-empty-inline">No DynamoDB tables found.</div>}
                    {dynamoTables.map(table => (
                      <div
                        key={table.name}
                        className="sidebar-file-item sidebar-ds-clickable"
                        onClick={() => onInsertCode && onInsertCode(`import boto3, pandas as pd\n\ndef scan_dynamodb(table_name, region='${table.region}'):\n    table = boto3.resource('dynamodb', region_name=region).Table(table_name)\n    return pd.DataFrame(table.scan()['Items'])\n\ndf = scan_dynamodb('${table.name}')\ndf.head()`)}
                        title={`Click to insert code for table '${table.name}'`}
                      >
                        <span className="sidebar-file-icon sidebar-icon-dynamodb"><IconDatabase width={13} height={13} /></span>
                        <div className="sidebar-file-info">
                          <span className="sidebar-file-name">{table.name}</span>
                          <span className="sidebar-file-meta">{table.item_count} items · {table.region}</span>
                        </div>
                      </div>
                    ))}
                  </>
                )}

                {/* Athena */}
                <div className="sidebar-subheader sidebar-subheader-toggle" onClick={() => setAthenaExpanded(!athenaExpanded)}>
                  <IconTable width={11} height={11} className="sidebar-icon-athena" /> Athena
                  {athenaTables.length > 0 && <span className="sidebar-subheader-count">{athenaTables.length} tables</span>}
                  <span className="sidebar-subheader-chevron">{athenaExpanded ? '▾' : '▸'}</span>
                </div>
                {athenaExpanded && (
                  <>
                    {dsLoading && <div className="sidebar-empty-inline">Loading...</div>}
                    {!dsLoading && athenaTables.length === 0 && <div className="sidebar-empty-inline">No Athena tables found.</div>}
                    {athenaTables.map(table => (
                      <div
                        key={`${table.database}.${table.name}`}
                        className="sidebar-file-item sidebar-ds-clickable"
                        onClick={() => onInsertCode && onInsertCode(`import boto3, pandas as pd, time\n\ndef athena_query(sql, workgroup='${athenaWorkgroup}', region='${table.region}'):\n    c = boto3.client('athena', region_name=region)\n    eid = c.start_query_execution(QueryString=sql, WorkGroup=workgroup)['QueryExecutionId']\n    while c.get_query_execution(QueryExecutionId=eid)['QueryExecution']['Status']['State'] in ('QUEUED','RUNNING'): time.sleep(0.5)\n    rows = c.get_query_results(QueryExecutionId=eid)['ResultSet']['Rows']\n    header = [col['VarCharValue'] for col in rows[0]['Data']]\n    data = [[col.get('VarCharValue','') for col in row['Data']] for row in rows[1:]]\n    return pd.DataFrame(data, columns=header)\n\ndf = athena_query("SELECT * FROM ${table.database}.${table.name} LIMIT 100")\ndf`)}
                        title={`Click to query ${table.database}.${table.name} (${table.column_count} columns)`}
                      >
                        <span className="sidebar-file-icon sidebar-icon-athena"><IconTable width={13} height={13} /></span>
                        <div className="sidebar-file-info">
                          <span className="sidebar-file-name">{table.name}</span>
                          <span className="sidebar-file-meta">{table.column_count} cols · {table.database}</span>
                        </div>
                      </div>
                    ))}
                  </>
                )}

                {/* Public APIs */}
                <div className="sidebar-subheader sidebar-subheader-toggle" onClick={() => setPublicApisExpanded(!publicApisExpanded)}>
                  🌐 Public APIs
                  <span className="sidebar-subheader-count">{publicApis.length} sources</span>
                  <span className="sidebar-subheader-chevron">{publicApisExpanded ? '▾' : '▸'}</span>
                </div>
                {publicApisExpanded && publicApis.map(api => (
                  <div
                    key={api.id}
                    className="sidebar-file-item sidebar-ds-clickable"
                    onClick={() => onInsertCode && onInsertCode(api.code)}
                    title={api.desc}
                  >
                    <span className="sidebar-file-icon">{api.icon}</span>
                    <div className="sidebar-file-info">
                      <span className="sidebar-file-name">{api.name}</span>
                      <span className="sidebar-file-meta">{api.desc}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* SAMPLE NOTEBOOKS PANEL */}
          {activePanel === 'samples' && (
            <div className="sidebar-panel-content">
              <div className="sidebar-panel-header">
                <span className="sidebar-panel-title">Samples</span>
                <button className="sidebar-panel-close" onClick={() => setActivePanel(null)} title="Close panel"><IconX width={12} height={12} /></button>
              </div>
              <div className="sidebar-panel-body">
                {samples.map(sample => (
                  <div
                    key={sample.id}
                    className="sidebar-item sidebar-sample-item"
                    onClick={() => onLoadSample(sample.file, sample.name)}
                  >
                    <span className="sidebar-file-icon">{sample.icon}</span>
                    <span className="sidebar-item-label">{sample.name}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* VARIABLES PANEL */}
          {activePanel === 'variables' && (
            <div className="sidebar-panel-content">
              <div className="sidebar-panel-header">
                <span className="sidebar-panel-title">Variables</span>
                <span className="sidebar-panel-count">{Object.keys(variables).length}</span>
                <button className="sidebar-panel-close" onClick={() => setActivePanel(null)} title="Close panel"><IconX width={12} height={12} /></button>
              </div>
              {activeTab && <div className="sidebar-scope-pill"><IconNotebook width={12} height={12} /> {activeTab.name}</div>}
              <div className="sidebar-panel-body">
                {Object.keys(variables).length === 0 && (
                  <div className="sidebar-empty">
                    No variables defined yet. Execute a cell to see variables here.
                  </div>
                )}
                {Object.entries(variables).map(([name, info]) => (
                  <div key={name} className="var-item">
                    <div
                      className="var-item-row"
                      onClick={() => setExpandedVar(expandedVar === name ? null : name)}
                    >
                      <span className="var-expand-icon">
                        {expandedVar === name ? <IconChevronDown width={10} height={10} /> : <IconChevronRight width={10} height={10} />}
                      </span>
                      <span className={`var-type-icon ${getTypeColor(info.type)}`}>
                        {getTypeIcon(info.type)}
                      </span>
                      <span className="var-name">{name}</span>
                      <span className="var-type">{info.type}</span>
                      {info.shape && <span className="var-shape">{info.shape}</span>}
                    </div>
                    {expandedVar === name && (
                      <div className="var-detail">
                        {info.size && (
                          <div className="var-detail-row">
                            <span className="var-detail-label">Size</span>
                            <span className="var-detail-value">{info.size}</span>
                          </div>
                        )}
                        {info.shape && (
                          <div className="var-detail-row">
                            <span className="var-detail-label">Shape</span>
                            <span className="var-detail-value">{info.shape}</span>
                          </div>
                        )}
                        <div className="var-detail-preview">
                          <VariablePreviewRenderer info={info} />
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* PACKAGES PANEL */}
          {activePanel === 'packages' && (
            <div className="sidebar-panel-content">
              <div className="sidebar-panel-header">
                <span className="sidebar-panel-title">Packages</span>
                <span className="sidebar-panel-count">{packages.length}</span>
                <button className="sidebar-panel-action" onClick={() => { setPkgFetched(false); fetchPackages() }} title="Refresh">
                  <IconRefresh width={14} height={14} />
                </button>
                <button className="sidebar-panel-close" onClick={() => setActivePanel(null)} title="Close panel"><IconX width={12} height={12} /></button>
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
          )}

          {/* MICROVMS PANEL */}
          {activePanel === 'microvms' && (
            <div className="sidebar-panel-content">
              <div className="sidebar-panel-header">
                <span className="sidebar-panel-title">MicroVMs</span>
                <span className="sidebar-panel-count">{Object.keys(vmInstances).length}</span>
                <button className="sidebar-panel-action" onClick={() => { setVmFetched(false); fetchVmInstances() }} title="Refresh">
                  <IconRefresh width={14} height={14} />
                </button>
                <button className="sidebar-panel-close" onClick={() => setActivePanel(null)} title="Close panel"><IconX width={12} height={12} /></button>
              </div>
              <div className="sidebar-panel-body">
                {/* Total cost summary */}
                {Object.keys(vmInstances).length > 0 && (
                  <div className="vm-total-cost-bar">
                    <span className="vm-total-cost-label">Total session cost</span>
                    <span className="vm-total-cost-value">
                      ${Object.values(vmInstances).reduce((sum, inst) => sum + (inst.cost?.total_cost_usd || 0), 0).toFixed(4)}
                    </span>
                  </div>
                )}
                {vmLoading && <div className="sidebar-empty">Loading instances...</div>}
                {!vmLoading && Object.keys(vmInstances).length === 0 && (
                  <div className="sidebar-empty">No MicroVM instances. Launch one from a notebook.</div>
                )}
                {Object.entries(vmInstances)
                  .sort((a, b) => (b[1].launched_at || 0) - (a[1].launched_at || 0))
                  .map(([id, inst]) => {
                  const isExpanded = expandedVmId === id
                  const isActive = activeTab?.microvmId === id
                  const isActioning = vmActionInProgress.has(id)
                  const state = inst.state || 'UNKNOWN'
                  const attachedTab = tabs.find(t => t.microvmId === id)
                  const memGb = (inst.memory_mib || 4096) / 1024

                  return (
                    <div key={id} className={`vm-item ${isActive ? 'vm-item-active' : ''}`}>
                      <div className="vm-item-row" onClick={() => setExpandedVmId(isExpanded ? null : id)}>
                        <span className={`vm-state-dot vm-state-${state.toLowerCase()}`} />
                        <div className="vm-item-info">
                          <span className="vm-item-name">{id}</span>
                          <span className="vm-item-meta">{memGb} GB · {state.toLowerCase()}</span>
                        </div>
                        {inst.cost && <span className="vm-item-cost">${inst.cost.total_cost_usd.toFixed(4)}</span>}
                      </div>

                      {isExpanded && (
                        <div className="vm-detail">
                          {/* Instance Info */}
                          <div className="vm-detail-section">
                            <div className="vm-detail-section-title">
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="2" width="20" height="20" rx="3"/><line x1="2" y1="8" x2="22" y2="8"/><line x1="8" y1="2" x2="8" y2="8"/></svg>
                              Instance
                            </div>
                            <div className="vm-detail-row">
                              <span className="vm-detail-label">Notebook</span>
                              <span className={`vm-detail-value ${!attachedIds.includes(id) && !inst.name ? 'vm-detail-unattached' : 'vm-detail-linked'}`}>{inst.name || attachedTab?.name || 'Unattached'}</span>
                            </div>
                            <div className="vm-detail-row">
                              <span className="vm-detail-label">Spec</span>
                              <span className="vm-detail-value">{memGb} GB · {memGb / 2} vCPU · ARM64</span>
                            </div>
                            {attachedTab?.sessionId && (
                              <div className="vm-detail-row">
                                <span className="vm-detail-label">Session</span>
                                <code className="vm-detail-value">{attachedTab.sessionId}</code>
                              </div>
                            )}
                            {!attachedIds.includes(id) && (
                              <div className="vm-detail-row">
                                <span className="vm-detail-label">Status</span>
                                <span className="vm-detail-value">{state}</span>
                              </div>
                            )}
                          </div>

                          {/* Lifecycle */}
                          {(inst.idle_timeout_sec || inst.max_duration_sec) && (
                            <div className="vm-detail-section">
                              <div className="vm-detail-section-title">
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                                Lifecycle
                              </div>
                              {inst.idle_timeout_sec && (
                                <div className="vm-detail-row">
                                  <span className="vm-detail-label">Idle suspend</span>
                                  <span className="vm-detail-value">{formatDuration(inst.idle_timeout_sec)}</span>
                                </div>
                              )}
                              {inst.max_duration_sec && (
                                <div className="vm-detail-row">
                                  <span className="vm-detail-label">Max lifetime</span>
                                  <span className="vm-detail-value">{formatDuration(inst.max_duration_sec)}</span>
                                </div>
                              )}
                            </div>
                          )}

                          {/* Cost Breakdown */}
                          {inst.cost && (
                            <div className="vm-detail-section">
                              <div className="vm-detail-section-title">
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
                                Cost Breakdown
                              </div>
                              <div className="vm-detail-row">
                                <span className="vm-detail-label">Compute</span>
                                <span className="vm-detail-value">{formatDuration(inst.cost.running_secs)}</span>
                              </div>
                              <div className="vm-detail-row vm-detail-row-sub">
                                <span className="vm-detail-label">Rate</span>
                                <span className="vm-detail-value">{memGb} GB × $0.0000133/s = ${(memGb * 0.0000133).toFixed(7)}/s</span>
                              </div>
                              <div className="vm-detail-row vm-detail-row-sub">
                                <span className="vm-detail-label">Subtotal</span>
                                <span className="vm-detail-value">${inst.cost.running_cost_usd.toFixed(6)}</span>
                              </div>
                              {inst.cost.suspended_secs > 0 && (
                                <>
                                  <div className="vm-detail-row">
                                    <span className="vm-detail-label">Suspended</span>
                                    <span className="vm-detail-value">{formatDuration(inst.cost.suspended_secs)}</span>
                                  </div>
                                  <div className="vm-detail-row vm-detail-row-sub">
                                    <span className="vm-detail-label">Rate</span>
                                    <span className="vm-detail-value">{memGb} GB × $0.0000000309/s = ${(memGb * 0.0000000309).toFixed(10)}/s</span>
                                  </div>
                                  <div className="vm-detail-row vm-detail-row-sub">
                                    <span className="vm-detail-label">Subtotal</span>
                                    <span className="vm-detail-value">${inst.cost.suspended_cost_usd.toFixed(6)}</span>
                                  </div>
                                </>
                              )}
                              <div className="vm-detail-row vm-detail-total">
                                <span className="vm-detail-label">Total</span>
                                <span className="vm-detail-value">${inst.cost.total_cost_usd.toFixed(6)}</span>
                              </div>
                            </div>
                          )}

                          {/* Actions */}
                          <div className="vm-detail-actions">
                            {state === 'RUNNING' && attachedIds.includes(id) && (
                              <button className="vm-action-btn vm-btn-terminate" onClick={() => { onTerminateAndSave && onTerminateAndSave(id) }} disabled={isActioning}>
                                {attachedTab?.checkpointEnabled ? 'Terminate & Save' : 'Terminate'}
                              </button>
                            )}
                            {state === 'RUNNING' && !attachedIds.includes(id) && (
                              <>
                                <button className="vm-action-btn vm-btn-attach" onClick={() => onAttachInstance && onAttachInstance(id, inst.endpoint, inst.memory_mib)} disabled={isActioning}>Attach</button>
                                <button className="vm-action-btn vm-btn-terminate" onClick={() => handleVmTerminate(id)} disabled={isActioning}>{isActioning ? '...' : 'Terminate'}</button>
                              </>
                            )}
                            {state === 'SUSPENDED' && !attachedIds.includes(id) && (
                              <button className="vm-action-btn vm-btn-terminate" onClick={() => handleVmTerminate(id)} disabled={isActioning}>{isActioning ? '...' : 'Terminate'}</button>
                            )}
                            {state === 'SUSPENDED' && attachedIds.includes(id) && (
                              <button className="vm-action-btn vm-btn-attach" onClick={async () => { await handleVmResume(id) }} disabled={isActioning}>{isActioning ? '...' : 'Resume'}</button>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Resize handle */}
          <div className="sidebar-resize-handle" onMouseDown={handleResizeStart} />
        </div>
      )}
    </aside>
  )
}
