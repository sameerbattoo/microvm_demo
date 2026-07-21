import { useState, useCallback, useEffect, useRef } from 'react'
import Notebook from './components/Notebook'
import Sidebar from './components/Sidebar'
import AiChatPanel from './components/AiChatPanel'
import { ConfirmModal, InputModal } from './components/Modal'
import { IconZap, IconSun, IconMoon } from './components/Icons'
import { PROXY_URL } from './config'
import { fetchNotebooks, saveNotebook as apiSaveNotebook, createNotebook as apiCreateNotebook, deleteNotebook as apiDeleteNotebook, migrateFromLocalStorage } from './services/notebooks'
import './App.css'

let nextTabId = parseInt(localStorage.getItem('microvm-next-tab-id') || '1')

function createTab(name, description, tag) {
  const id = nextTabId++
  localStorage.setItem('microvm-next-tab-id', String(nextTabId))
  return {
    id,
    name: name || `Notebook ${id}`,
    description: description || '',
    tag: tag || 'Drafts',
    microvmEndpoint: null,
    microvmRealEndpoint: null,
    microvmId: null,
    status: 'disconnected',
    mode: null,
  }
}

export default function App() {
  const [tabs, setTabs] = useState(() => {
    try {
      const saved = localStorage.getItem('microvm-notebooks')
      if (saved) {
        const parsed = JSON.parse(saved)
        if (Array.isArray(parsed) && parsed.length > 0) {
          // Deduplicate by ID (guard against corrupted localStorage)
          const seen = new Set()
          const deduped = parsed.filter(t => {
            if (seen.has(t.id)) return false
            seen.add(t.id)
            return true
          })
          // Keep microvmId for reconnection, reset transient connection state
          return deduped.map(t => ({
            ...t,
            status: 'disconnected',
            microvmEndpoint: null,
            microvmRealEndpoint: null,
            // Keep microvmId so we can auto-reconnect
            mode: null,
          }))
        }
      }
    } catch {}
    return []
  })
  const [activeTabId, setActiveTabId] = useState(() => {
    try {
      const saved = localStorage.getItem('microvm-active-tab')
      return saved ? JSON.parse(saved) : null
    } catch {}
    return null
  })
  const [instances, setInstances] = useState({})
  const [vmMetrics, setVmMetrics] = useState({})  // microvm_id -> latest metrics
  const [pollIntervalMs, setPollIntervalMs] = useState(10000)
  const saveTimerRef = useRef(null)

  // Fetch metrics for a specific VM (called after cell execution, not on a timer)
  const refreshMetrics = useCallback(async (microvmId) => {
    if (!microvmId) return
    try {
      const resp = await fetch(`${PROXY_URL}/instances/metrics?microvm_id=${microvmId}`)
      if (resp.ok) {
        const data = await resp.json()
        if (data.metrics) setVmMetrics(prev => ({ ...prev, ...data.metrics }))
      }
    } catch {}
  }, [])

  // Persist tabs to localStorage (debounced 1.5s to avoid thrashing during typing)
  useEffect(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
    const toSave = tabs.map(({ _loadedCells, ...tab }) => {
      // Persist cells with code and text outputs, but strip base64 images
      const cells = (tab._cells || []).map(c => ({
        id: c.id,
        type: c.type || 'code',
        code: c.code || '',
        output: c.output || null,
        error: c.error || null,
        html: c.html || null,
        image: null, // Strip base64 images (too large for localStorage)
        status: c.output || c.error || c.html ? 'success' : 'idle',
        executionNumber: c.executionNumber || null,
        executionTime: c.executionTime || null,
        lastExecutedCode: c.lastExecutedCode || null,
        aiExplanation: c.aiExplanation || null,
      }))
      return { ...tab, _cells: cells.length > 0 ? cells : undefined }
    })
    try {
      localStorage.setItem('microvm-notebooks', JSON.stringify(toSave))
    } catch (e) {
      // If localStorage is full (quota exceeded), save without outputs
      const minimal = tabs.map(({ _cells, _loadedCells, ...rest }) => ({
        ...rest,
        _cells: (_cells || []).map(c => ({ id: c.id, type: c.type || 'code', code: c.code || '', output: null, error: null, html: null, image: null, status: 'idle', executionNumber: null, executionTime: null, lastExecutedCode: null })),
      }))
      try {
        localStorage.setItem('microvm-notebooks', JSON.stringify(minimal))
      } catch {}
    }
    }, 1500)
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current) }
  }, [tabs])

  // Also persist to API (debounced, non-blocking)
  const apiSaveTimerRef = useRef(null)
  useEffect(() => {
    if (apiSaveTimerRef.current) clearTimeout(apiSaveTimerRef.current)
    apiSaveTimerRef.current = setTimeout(() => {
      tabs.forEach(tab => {
        const cells = (tab._cells || []).map(c => ({
          type: c.type || 'code',
          code: c.code || '',
          output: c.output || null,
          error: c.error || null,
          html: c.html || null,
          image: null,
          aiExplanation: c.aiExplanation || null,
        }))
        apiSaveNotebook({
          id: String(tab.id),
          name: tab.name,
          description: tab.description || '',
          tag: tab.tag || 'Drafts',
          cells,
          session_id: tab.sessionId || null,
          microvm_id: tab.microvmId || null,
          checkpoint_enabled: tab.checkpointEnabled || false,
        }).catch(() => {})  // Non-blocking — localStorage is the safety net
      })
    }, 3000)
    return () => { if (apiSaveTimerRef.current) clearTimeout(apiSaveTimerRef.current) }
  }, [tabs])

  // On first mount: try to load notebooks from API, migrate localStorage if needed
  useEffect(() => {
    async function loadFromApi() {
      // Try migration first (if localStorage has data but API doesn't)
      if (!localStorage.getItem('microvm-notebooks-migrated')) {
        await migrateFromLocalStorage()
      }

      // Fetch from API
      const apiNotebooks = await fetchNotebooks()
      if (apiNotebooks && apiNotebooks.length > 0 && tabs.length === 0) {
        // API has notebooks but local state is empty — load from API
        const loaded = apiNotebooks.map(nb => ({
          id: nb.id.includes('-') ? nb.id : parseInt(nb.id) || nb.id,
          name: nb.name,
          description: nb.description || '',
          tag: nb.tag || 'Drafts',
          _cells: nb.cells || [],
          microvmEndpoint: null,
          microvmRealEndpoint: null,
          microvmId: nb.microvm_id || null,
          status: 'disconnected',
          mode: null,
          sessionId: nb.session_id || null,
          checkpointEnabled: nb.checkpoint_enabled || false,
        }))
        setTabs(loaded)
        if (loaded.length > 0 && !activeTabId) {
          setActiveTabId(loaded[0].id)
        }
      }
    }
    loadFromApi()
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    localStorage.setItem('microvm-active-tab', JSON.stringify(activeTabId))
  }, [activeTabId])

  // Theme state
  const [theme, setTheme] = useState(() => {
    return localStorage.getItem('microvm-theme') || 'dark'
  })

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('microvm-theme', theme)
  }, [theme])

  const toggleTheme = useCallback(() => {
    setTheme(prev => prev === 'dark' ? 'light' : 'dark')
  }, [])

  // Modal state
  const [modal, setModal] = useState(null)
  const [showAiChat, setShowAiChat] = useState(true)
  const [aiAvailable, setAiAvailable] = useState(false)
  const [newNotebookName, setNewNotebookName] = useState('')
  const [newNotebookDesc, setNewNotebookDesc] = useState('')

  // Track previous instances to detect termination transitions
  const prevInstancesRef = useRef({})

  // Fetch instances periodically — this is THE SINGLE SOURCE OF TRUTH for VM state.
  // No copies (_vmState) are stored on tabs. Components derive state from `instances[tab.microvmId]`.
  const fetchInstances = useCallback(async () => {
    try {
      const resp = await fetch(`${PROXY_URL}/instances`)
      if (resp.ok) {
        const data = await resp.json()
        const inst = data.instances || {}
        setInstances(inst)

        // Only sync connection-related info on tabs (endpoint, status)
        // NOT vm state — that comes from `instances` directly
        setTabs(prev => {
          const prevInst = prevInstancesRef.current
          let changed = false
          const updated = prev.map(tab => {
            if (tab.microvmId && inst[tab.microvmId]) {
              const vmState = inst[tab.microvmId].state || 'UNKNOWN'
              const endpoint = inst[tab.microvmId].endpoint

              // Auto-connect: tab has a VM that is RUNNING/SUSPENDED but tab is not connected
              if ((tab.status === 'connecting' || tab.status === 'disconnected') && (vmState === 'RUNNING' || vmState === 'SUSPENDED') && endpoint) {
                changed = true
                return {
                  ...tab,
                  microvmEndpoint: `${PROXY_URL}/proxy`,
                  microvmRealEndpoint: endpoint,
                  microvmMemory: inst[tab.microvmId].memory_mib || tab.microvmMemory,
                  status: 'connected',
                  mode: 'microvm',
                }
              }
            } else if (tab.microvmId && !inst[tab.microvmId]) {
              // VM not in instances → terminated (either by service or manually)
              if (tab.status !== 'disconnected' && tab.status !== 'launching') {
                changed = true
                return {
                  ...tab,
                  status: 'disconnected',
                  microvmEndpoint: null,
                  microvmRealEndpoint: null,
                  // If checkpoint was enabled, mark session as saved so "Restore" button appears
                  sessionSaved: tab.checkpointEnabled ? true : tab.sessionSaved,
                }
              }
            }
            return tab
          })
          prevInstancesRef.current = inst
          return changed ? updated : prev
        })
      }
    } catch {
      // Proxy not available
    }
  }, [])

  // Helper: immediately update a single VM's state in the instances map
  // Used after successful cell execution on a suspended VM (don't wait for poll)
  const markVmRunning = useCallback((microvmId) => {
    setInstances(prev => {
      if (!prev[microvmId]) return prev
      if (prev[microvmId].state === 'RUNNING') return prev
      return { ...prev, [microvmId]: { ...prev[microvmId], state: 'RUNNING' } }
    })
  }, [])

  // Fetch files from the active MicroVM (stored per-tab to avoid cross-VM contamination)
  const fetchFiles = useCallback(async () => {
    const activeTab = tabs.find(t => t.id === activeTabId)
    if (!activeTab || activeTab.status !== 'connected') {
      return
    }

    const headers = {}
    if (activeTab.microvmId) {
      headers['X-MicroVM-Id'] = activeTab.microvmId
      if (activeTab.microvmRealEndpoint) {
        headers['X-MicroVM-Endpoint'] = activeTab.microvmRealEndpoint
      }
    }

    try {
      const resp = await fetch(`${activeTab.microvmEndpoint}/files`, { headers })
      if (resp.ok) {
        const data = await resp.json()
        const files = (data.files || []).map(f => ({
          name: f.name,
          size: f.size,
          variable: f.name.replace(/\.[^.]+$/, '').replace(/[-\s.]/g, '_'),
          status: 'ready',
        }))
        // Store files on the tab object so each VM has its own file list
        setTabs(prev => prev.map(t => t.id === activeTabId ? { ...t, _localFiles: files } : t))
      }
    } catch {
      // Ignore — might not be connected yet
    }
  }, [tabs, activeTabId])

  useEffect(() => {
    fetchInstances()
    const interval = setInterval(fetchInstances, pollIntervalMs)

    // Metrics are NOT polled continuously — that would keep VMs awake.
    // Instead, metrics are fetched on-demand after cell execution via refreshMetrics().

    return () => { clearInterval(interval) }
  }, [fetchInstances, pollIntervalMs])

  // Fetch poll interval from proxy config
  useEffect(() => {
    fetch(`${PROXY_URL}/health`)
      .then(r => r.json())
      .then(data => {
        if (data.poll_interval_ms && data.poll_interval_ms > 0) {
          setPollIntervalMs(data.poll_interval_ms)
        }
      })
      .catch(() => {})

    // Check AI availability
    fetch(`${PROXY_URL}/ai/config`)
      .then(r => r.json())
      .then(data => setAiAvailable(data.ai_available === true))
      .catch(() => setAiAvailable(false))
  }, [])

  // NOTE: Auto-reconnect is handled by fetchInstances polling (runs on mount + every 10s).
  // It auto-connects any tab whose VM is RUNNING or SUSPENDED.
  // No separate mount effect needed — fetchInstances is the single source of truth.

  // Refresh files when active tab changes or connects
  useEffect(() => {
    fetchFiles()
  }, [activeTabId, tabs.find(t => t.id === activeTabId)?.status])

  const addTab = useCallback(() => {
    setNewNotebookName(`Notebook ${nextTabId}`)
    setNewNotebookDesc('')
    setModal({ type: 'newNotebook' })
  }, [])

  const confirmNewNotebook = useCallback(() => {
    const tab = createTab(newNotebookName || undefined, newNotebookDesc)
    setTabs(prev => [...prev, tab])
    setActiveTabId(tab.id)
    setModal(null)
    setShowAiChat(true)
  }, [newNotebookName, newNotebookDesc])

  const closeTab = useCallback((tabId) => {
    const closingTab = tabs.find(t => t.id === tabId)
    if (!closingTab) return
    // Show confirm modal with save option
    setModal({ type: 'closeNotebook', tabId, tabName: closingTab.name })
  }, [tabs])

  const confirmCloseTab = useCallback((tabId, shouldSave) => {
    const closingTab = tabs.find(t => t.id === tabId)
    if (!closingTab) { setModal(null); return }

    if (shouldSave) {
      // Save notebook as a file download (same as toolbar Save button)
      const cells = (closingTab._cells || []).map(c => ({
        type: c.type || 'code',
        code: c.code || '',
        output: c.output || null,
        error: c.error || null,
        html: c.html || null,
        image: null,
        executionNumber: c.executionNumber || null,
        executionTime: c.executionTime || null,
        aiExplanation: c.aiExplanation || null,
      }))
      const notebook = {
        name: closingTab.name,
        description: closingTab.description || '',
        tag: closingTab.tag || 'Drafts',
        cells,
        session_id: closingTab.sessionId || null,
        microvm_id: closingTab.microvmId || null,
        checkpoint_enabled: closingTab.checkpointEnabled || false,
        saved_at: new Date().toISOString(),
      }
      const blob = new Blob([JSON.stringify(notebook, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${(closingTab.name || 'notebook').replace(/\s+/g, '_')}.notebook.json`
      a.click()
      URL.revokeObjectURL(url)
    }

    if (closingTab.microvmId && closingTab.mode === 'microvm') {
      fetch(`${PROXY_URL}/terminate/${closingTab.microvmId}`, { method: 'POST' }).catch(() => {})
    }

    setTabs(prev => prev.filter(t => t.id !== tabId))
    setActiveTabId(prev => {
      if (prev === tabId) {
        const remaining = tabs.filter(t => t.id !== tabId)
        return remaining.length > 0 ? remaining[0].id : null
      }
      return prev
    })
    setModal(null)
  }, [tabs])

  const updateTab = useCallback((tabId, updates) => {
    setTabs(prev => prev.map(t => t.id === tabId ? { ...t, ...updates } : t))
  }, [])

  const renameTab = useCallback((tabId, newName) => {
    setTabs(prev => prev.map(t => t.id === tabId ? { ...t, name: newName } : t))
  }, [])

  const attachInstance = useCallback((microvmId, endpoint, memoryMib) => {
    const tab = createTab(`VM-${microvmId.replace('microvm-', '').slice(0, 8)}`)
    tab.microvmId = microvmId
    tab.microvmEndpoint = `${PROXY_URL}/proxy`
    tab.microvmRealEndpoint = endpoint
    tab.microvmMemory = memoryMib || 4096
    tab.status = 'connected'
    tab.mode = 'microvm'
    setTabs(prev => [...prev, tab])
    setActiveTabId(tab.id)
  }, [])

  const resumeInstance = useCallback(async (microvmId) => {
    try {
      await fetch(`${PROXY_URL}/resume/${microvmId}`, { method: 'POST' })
      fetchInstances()
    } catch {}
  }, [fetchInstances])

  const terminateInstance = useCallback(async (microvmId) => {
    // Check if attached to a notebook
    const attachedTab = tabs.find(t => t.microvmId === microvmId)
    if (attachedTab) {
      setModal({
        type: 'cannotTerminate',
        microvmId,
        notebookName: attachedTab.name,
      })
      return
    }
    setModal({ type: 'terminateInstance', microvmId })
  }, [tabs])

  const confirmTerminateInstance = useCallback(async (microvmId) => {
    setModal(null)
    try {
      await fetch(`${PROXY_URL}/terminate/${microvmId}`, { method: 'POST' })
      fetchInstances()
    } catch {}
  }, [fetchInstances])

  // Terminate & Save: terminates attached VM, detaches from notebook but preserves sessionId for restore
  const terminateAndSave = useCallback(async (microvmId) => {
    try {
      await fetch(`${PROXY_URL}/terminate/${microvmId}`, { method: 'POST' })
      // Detach from notebook tab but keep sessionId for restore
      setTabs(prev => prev.map(t => {
        if (t.microvmId !== microvmId) return t
        return {
          ...t,
          microvmId: null,
          microvmEndpoint: null,
          microvmRealEndpoint: null,
          status: 'disconnected',
          mode: null,
          sessionSaved: true, // Signal that checkpoint was saved — enables "Restore Session"
        }
      }))
      fetchInstances()
    } catch {}
  }, [fetchInstances])

  // Suspend: suspends an attached VM via the AWS API
  const suspendInstance = useCallback(async (microvmId) => {
    try {
      await fetch(`${PROXY_URL}/suspend/${microvmId}`, { method: 'POST' })
      // Immediately update instances state so UI reflects suspension without waiting for poll
      setInstances(prev => {
        if (!prev[microvmId]) return prev
        return { ...prev, [microvmId]: { ...prev[microvmId], state: 'SUSPENDED' } }
      })
    } catch {}
  }, [])

  const uploadFile = useCallback(async (file) => {
    // Find the active tab's connection to upload to
    const activeTab = tabs.find(t => t.id === activeTabId)
    if (!activeTab || activeTab.status !== 'connected') {
      alert('Connect to a MicroVM first before uploading files.')
      return
    }

    const size = file.size < 1024 * 1024
      ? `${(file.size / 1024).toFixed(1)} KB`
      : `${(file.size / (1024 * 1024)).toFixed(1)} MB`

    // Add to list immediately (uploading state)
    setTabs(prev => prev.map(t => t.id === activeTabId
      ? { ...t, _localFiles: [...(t._localFiles || []), { name: file.name, size, variable: null, status: 'uploading' }] }
      : t
    ))

    // Read as base64
    const reader = new FileReader()
    reader.onload = async (ev) => {
      const base64 = ev.target.result.split(',')[1]

      const headers = { 'Content-Type': 'application/json' }
      if (activeTab.microvmId) {
        headers['X-MicroVM-Id'] = activeTab.microvmId
        if (activeTab.microvmRealEndpoint) {
          headers['X-MicroVM-Endpoint'] = activeTab.microvmRealEndpoint
        }
      }

      try {
        const response = await fetch(`${activeTab.microvmEndpoint}/upload`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ filename: file.name, data: base64 }),
        })
        const result = await response.json()

        setTabs(prev => prev.map(t => t.id === activeTabId
          ? { ...t, _localFiles: (t._localFiles || []).map(f =>
              f.name === file.name
                ? { ...f, variable: result.variable_name || null, status: result.success ? 'ready' : 'error' }
                : f
            ) }
          : t
        ))
      } catch {
        setTabs(prev => prev.map(t => t.id === activeTabId
          ? { ...t, _localFiles: (t._localFiles || []).map(f =>
              f.name === file.name ? { ...f, status: 'error', variable: 'failed' } : f
            ) }
          : t
        ))
      }
    }
    reader.readAsDataURL(file)
  }, [tabs, activeTabId])

  const deleteFile = useCallback((filename) => {
    setTabs(prev => prev.map(t => t.id === activeTabId
      ? { ...t, _localFiles: (t._localFiles || []).filter(f => f.name !== filename) }
      : t
    ))
  }, [activeTabId])

  const uploadSampleData = useCallback(async (filename) => {
    const activeTab = tabs.find(t => t.id === activeTabId)
    if (!activeTab || activeTab.status !== 'connected') {
      alert('Connect to a sandbox first before loading data files.')
      return
    }

    // Fetch the sample file from public/samples/data/
    try {
      const resp = await fetch(`/samples/data/${filename}`)
      const text = await resp.text()
      const base64 = btoa(text)

      const size = text.length < 1024 * 1024
        ? `${(text.length / 1024).toFixed(1)} KB`
        : `${(text.length / (1024 * 1024)).toFixed(1)} MB`

      setTabs(prev => prev.map(t => t.id === activeTabId
        ? { ...t, _localFiles: [...(t._localFiles || []), { name: filename, size, variable: null, status: 'uploading' }] }
        : t
      ))

      const headers = { 'Content-Type': 'application/json' }
      if (activeTab.microvmId) {
        headers['X-MicroVM-Id'] = activeTab.microvmId
        if (activeTab.microvmRealEndpoint) {
          headers['X-MicroVM-Endpoint'] = activeTab.microvmRealEndpoint
        }
      }

      const uploadResp = await fetch(`${activeTab.microvmEndpoint}/upload`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ filename, data: base64 }),
      })
      const result = await uploadResp.json()

      setTabs(prev => prev.map(t => t.id === activeTabId
        ? { ...t, _localFiles: (t._localFiles || []).map(f =>
            f.name === filename
              ? { ...f, variable: result.variable_name || null, status: result.success ? 'ready' : 'error' }
              : f
          ) }
        : t
      ))
    } catch (err) {
      setTabs(prev => prev.map(t => t.id === activeTabId
        ? { ...t, _localFiles: (t._localFiles || []).map(f =>
            f.name === filename ? { ...f, status: 'error', variable: 'failed' } : f
          ) }
        : t
      ))
    }
  }, [tabs, activeTabId])

  const loadSample = useCallback(async (sampleUrl, sampleName) => {
    try {
      const resp = await fetch(sampleUrl)
      const notebook = await resp.json()

      const tab = createTab(sampleName || notebook.name, notebook.description || '', 'Samples')
      tab._loadedCells = notebook.cells
      tab._cells = notebook.cells.map((c, i) => ({
        id: Date.now() + Math.random() + i,
        type: c.type || 'code',
        code: c.code || '',
        output: c.output || null,
        error: c.error || null,
        html: c.html || null,
        image: c.image || null,
        aiExplanation: c.aiExplanation || null,
      }))
      setTabs(prev => [...prev, { ...tab }])
      setActiveTabId(tab.id)
      setShowAiChat(true)
    } catch (err) {
      alert(`Failed to load sample: ${err.message}`)
    }
  }, [])

  // Listen for "Open Notebook" events from Notebook toolbar (creates a new tab)
  useEffect(() => {
    const handler = (e) => {
      const { name, description, tag, cells } = e.detail
      const tab = createTab(name, description, tag || undefined)
      tab._loadedCells = cells
      tab._cells = (cells || []).map((c, i) => ({
        id: Date.now() + Math.random() + i,
        type: c.type || 'code',
        code: c.code || '',
        output: c.output || null,
        error: c.error || null,
        html: c.html || null,
        image: c.image || null,
        aiExplanation: c.aiExplanation || null,
      }))
      setTabs(prev => [...prev, { ...tab }])
      setActiveTabId(tab.id)
    }
    window.addEventListener('open-notebook', handler)
    return () => window.removeEventListener('open-notebook', handler)
  }, [])

  const insertCode = useCallback((code) => {
    // Dispatch event for the active notebook to pick up
    window.dispatchEvent(new CustomEvent('insert-code', { detail: { code } }))
  }, [])

  const attachedIds = tabs.filter(t => t.microvmId).map(t => t.microvmId)

  return (
    <div className="app">
      <div className="app-body">
        <Sidebar
          tabs={tabs}
          activeTabId={activeTabId}
          attachedIds={attachedIds}
          uploadedFiles={tabs.find(t => t.id === activeTabId)?._localFiles || []}
          onSelectTab={setActiveTabId}
          onNewNotebook={addTab}
          onCloseTab={closeTab}
          onRenameTab={renameTab}
          onUploadFile={uploadFile}
          onDeleteFile={deleteFile}
          onLoadSample={loadSample}
          onUploadSampleData={uploadSampleData}
          onInsertCode={insertCode}
          cells={(tabs.find(t => t.id === activeTabId)?._cells) || []}
          variables={(tabs.find(t => t.id === activeTabId)?._variables) || {}}
          activeTab={tabs.find(t => t.id === activeTabId) || null}
          onAttachInstance={attachInstance}
          onTerminateAndSave={terminateAndSave}
          onSuspendInstance={suspendInstance}
          onUpdateTabTag={(tabId, tag) => updateTab(tabId, { tag })}
          onSyncPackages={(pkgList) => { if (activeTabId) updateTab(activeTabId, { _packages: pkgList }) }}
          onSyncDataSources={(ds) => { if (activeTabId) updateTab(activeTabId, { _dataSources: ds }) }}
          instances={instances}
          vmMetrics={vmMetrics}
          onScrollToCell={(idx) => {
            const activeCells = tabs.find(t => t.id === activeTabId)?._cells || []
            const cell = activeCells[idx]
            if (cell) {
              setTimeout(() => {
                const el = document.querySelector(`[data-cell-id="${cell.id}"]`)
                if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
              }, 50)
            }
          }}
          onReorderCells={(fromIdx, toIdx) => {
            const tab = tabs.find(t => t.id === activeTabId)
            if (!tab || !tab._cells) return
            const reordered = [...tab._cells]
            const [moved] = reordered.splice(fromIdx, 1)
            reordered.splice(toIdx, 0, moved)
            updateTab(activeTabId, { _cells: reordered })
          }}
        />
        <main className="app-main">
          {tabs.length === 0 && (
            <div className="app-empty">
              <button className="app-empty-theme-btn" onClick={toggleTheme} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}>
                {theme === 'dark' ? <IconSun width={16} height={16} /> : <IconMoon width={16} height={16} />}
              </button>
              <div className="app-empty-icon">
                <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="4" y="4" width="16" height="16" rx="2" />
                  <path d="M9 9h6M9 13h6M9 17h4" />
                </svg>
              </div>
              <h2 className="app-empty-title">MicroVM Notebook</h2>
              <p className="app-empty-subtitle">Stateful Python execution in isolated Firecracker VMs</p>
              <div className="app-empty-actions">
                <button className="app-empty-btn app-empty-btn-primary" onClick={addTab}>
                  + New Notebook
                </button>
                <button className="app-empty-btn" onClick={() => loadSample('/samples/aws_data_sources.notebook.json', 'AWS Data Sources')}>
                  Open Sample: AWS Data Sources
                </button>
              </div>
              <div className="app-empty-hints">
                <div className="app-empty-hint">
                  <span className="app-empty-hint-icon">1</span>
                  <span>Create a notebook and connect to a MicroVM sandbox</span>
                </div>
                <div className="app-empty-hint">
                  <span className="app-empty-hint-icon">2</span>
                  <span>Write Python code in cells — <kbd>Shift+Enter</kbd> to execute</span>
                </div>
                <div className="app-empty-hint">
                  <span className="app-empty-hint-icon">3</span>
                  <span>Use the <strong>AI assistant</strong> — toggle any cell to AI mode, describe what you want, and get code generated</span>
                </div>
                <div className="app-empty-hint">
                  <span className="app-empty-hint-icon">4</span>
                  <span>Click data sources in the sidebar to insert ready-to-run query code</span>
                </div>
              </div>
            </div>
          )}
          {(() => {
            const tab = tabs.find(t => t.id === activeTabId)
            if (!tab) return null
            return (
            <Notebook
              key={tab.id}
              tab={tab}
              instances={instances}
              onUpdateTab={(updates) => updateTab(tab.id, updates)}
              onMarkVmRunning={markVmRunning}
              onNewNotebook={addTab}
              onCloseTab={closeTab}
              attachedIds={attachedIds}
              theme={theme}
              onToggleTheme={toggleTheme}
              aiAvailable={aiAvailable}
              onRefreshMetrics={() => refreshMetrics(tab.microvmId)}
            />
            )
          })()}
        </main>
        {showAiChat && (
          <AiChatPanel
            activeTab={tabs.find(t => t.id === activeTabId) || null}
            uploadedFiles={tabs.find(t => t.id === activeTabId)?._localFiles || []}
            onClose={() => setShowAiChat(false)}
            onUpdateMessages={(msgs) => updateTab(activeTabId, { _chatMessages: msgs })}
            onUpdateCell={(code) => {
              const tab = tabs.find(t => t.id === activeTabId)
              if (!tab || !tab._cells || tab._activeCellIndex == null) return
              const newCells = [...tab._cells]
              newCells[tab._activeCellIndex] = { ...newCells[tab._activeCellIndex], code }
              updateTab(activeTabId, { _cells: newCells })
            }}
            onInsertCells={(codeBlocks) => {
              const tab = tabs.find(t => t.id === activeTabId)
              if (!tab || !tab._cells) return
              const insertIdx = (tab._activeCellIndex ?? tab._cells.length - 1) + 1
              const newCells = [...tab._cells]
              codeBlocks.forEach((code, i) => {
                newCells.splice(insertIdx + i, 0, { id: Date.now() + Math.random() + i, type: 'code', code, output: null, error: null, html: null, image: null })
              })
              updateTab(activeTabId, { _cells: newCells })
            }}
          />
        )}
      </div>

      {/* AI Chat toggle button (bottom-right) */}
      {!showAiChat && tabs.length > 0 && aiAvailable && (
        <button className="ai-fab" onClick={() => setShowAiChat(true)} title="Open AI Assistant">
          ✨
        </button>
      )}

      {/* Modals */}
      {modal?.type === 'newNotebook' && (
        <InputModal
          title="New Notebook"
          onSubmit={confirmNewNotebook}
          onCancel={() => setModal(null)}
          submitLabel="Create"
          fields={<>
            <div className="modal-input-group">
              <label className="modal-label">Name</label>
              <input
                className="modal-input"
                value={newNotebookName}
                onChange={(e) => setNewNotebookName(e.target.value)}
                placeholder="My Notebook"
                autoFocus
              />
            </div>
            <div className="modal-input-group">
              <label className="modal-label">Description (optional)</label>
              <input
                className="modal-input"
                value={newNotebookDesc}
                onChange={(e) => setNewNotebookDesc(e.target.value)}
                placeholder="What this notebook is about..."
              />
              <div className="modal-input-hint">Shown below the toolbar when the notebook is open.</div>
            </div>
          </>}
        />
      )}

      {modal?.type === 'closeNotebook' && (
        <div className="modal-overlay" onClick={() => setModal(null)}>
          <div className="modal-card" onClick={e => e.stopPropagation()}>
            <div className="modal-title">Close "{modal.tabName}"?</div>
            <div className="modal-body">
              <p className="modal-message">Would you like to save this notebook before closing?</p>
            </div>
            <div className="modal-actions">
              <button className="modal-btn modal-btn-cancel" onClick={() => setModal(null)}>Cancel</button>
              <button className="modal-btn modal-btn-confirm" onClick={() => confirmCloseTab(modal.tabId, true)}>Save & Close</button>
              <button className="modal-btn modal-btn-danger" onClick={() => confirmCloseTab(modal.tabId, false)}>Close without saving</button>
            </div>
          </div>
        </div>
      )}

      {modal?.type === 'terminateInstance' && (
        <ConfirmModal
          title="Terminate MicroVM?"
          message={`This will destroy ${modal.microvmId.replace('microvm-', '').slice(0, 8)}... and all its in-memory state. This cannot be undone.`}
          onCancel={() => setModal(null)}
          onConfirm={() => confirmTerminateInstance(modal.microvmId)}
          confirmLabel="Terminate"
          confirmDanger
        />
      )}

      {modal?.type === 'cannotTerminate' && (
        <ConfirmModal
          title="Cannot Terminate"
          onCancel={() => setModal(null)}
          onConfirm={() => setModal(null)}
          confirmLabel="OK"
          cancelLabel=""
        >
          <p className="modal-message">
            This MicroVM is attached to notebook <strong>"{modal.notebookName}"</strong>.
          </p>
          <div className="modal-warning">
            Close the notebook first to detach the MicroVM, then terminate it.
          </div>
        </ConfirmModal>
      )}
    </div>
  )
}
