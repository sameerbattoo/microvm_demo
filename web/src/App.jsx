import { useState, useCallback, useEffect, useRef } from 'react'
import Notebook from './components/Notebook'
import Sidebar from './components/Sidebar'
import InstancesPanel from './components/InstancesPanel'
import { ConfirmModal, InputModal } from './components/Modal'
import { IconZap, IconSun, IconMoon } from './components/Icons'
import { PROXY_URL } from './config'
import './App.css'

let nextTabId = parseInt(localStorage.getItem('microvm-next-tab-id') || '1')

function createTab(name, description) {
  const id = nextTabId++
  localStorage.setItem('microvm-next-tab-id', String(nextTabId))
  return {
    id,
    name: name || `Notebook ${id}`,
    description: description || '',
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
          // Keep microvmId for reconnection, reset transient connection state
          return parsed.map(t => ({
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
  const [uploadedFiles, setUploadedFiles] = useState([])
  const [pollIntervalMs, setPollIntervalMs] = useState(10000)
  const saveTimerRef = useRef(null)

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
  const [showInstances, setShowInstances] = useState(false)
  const [newNotebookName, setNewNotebookName] = useState('')
  const [newNotebookDesc, setNewNotebookDesc] = useState('')

  // Fetch instances periodically
  const fetchInstances = useCallback(async () => {
    try {
      const resp = await fetch(`${PROXY_URL}/instances`)
      if (resp.ok) {
        const data = await resp.json()
        setInstances(data.instances || {})
      }
    } catch {
      // Proxy not available
    }
  }, [])

  // Fetch files from the active MicroVM
  const fetchFiles = useCallback(async () => {
    const activeTab = tabs.find(t => t.id === activeTabId)
    if (!activeTab || activeTab.status !== 'connected') {
      setUploadedFiles([])
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
        setUploadedFiles((data.files || []).map(f => ({
          name: f.name,
          size: f.size,
          variable: f.name.replace(/\.[^.]+$/, '').replace(/[-\s.]/g, '_'),
          status: 'ready',
        })))
      }
    } catch {
      // Ignore — might not be connected yet
    }
  }, [tabs, activeTabId])

  useEffect(() => {
    fetchInstances()
    const interval = setInterval(fetchInstances, pollIntervalMs)
    return () => clearInterval(interval)
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
  }, [])

  // Auto-reconnect tabs that have a saved microvmId
  useEffect(() => {
    const reconnect = async () => {
      try {
        const resp = await fetch(`${PROXY_URL}/instances`)
        if (!resp.ok) return
        const data = await resp.json()
        const runningInstances = data.instances || {}

        setTabs(prev => prev.map(tab => {
          if (tab.microvmId && tab.status === 'disconnected') {
            const inst = runningInstances[tab.microvmId]
            if (inst && inst.state === 'RUNNING' && inst.endpoint) {
              // Auto-reconnect with memory spec from API
              return {
                ...tab,
                microvmEndpoint: `${PROXY_URL}/proxy`,
                microvmRealEndpoint: inst.endpoint,
                microvmMemory: inst.memory_mib || tab.microvmMemory,
                status: 'connected',
                mode: 'microvm',
              }
            }
            // VM not running — keep microvmId as hint but stay disconnected
          }
          return tab
        }))
      } catch {}
    }
    reconnect()
  }, []) // Run once on mount

  // Refresh files when active tab changes or connects
  useEffect(() => {
    fetchFiles()
  }, [activeTabId, tabs.find(t => t.id === activeTabId)?.status])

  // Auto-resume suspended MicroVM when user navigates to its notebook
  useEffect(() => {
    const activeTab = tabs.find(t => t.id === activeTabId)
    if (!activeTab?.microvmId) return

    const checkAndResume = async () => {
      try {
        const resp = await fetch(`${PROXY_URL}/instances`)
        if (!resp.ok) return
        const data = await resp.json()
        const inst = data.instances?.[activeTab.microvmId]
        if (inst?.state === 'SUSPENDED') {
          // Auto-resume the suspended VM
          await fetch(`${PROXY_URL}/resume/${activeTab.microvmId}`, { method: 'POST' })
          // Update tab to connected once resumed
          setTabs(prev => prev.map(t => {
            if (t.id !== activeTabId) return t
            return {
              ...t,
              microvmEndpoint: `${PROXY_URL}/proxy`,
              microvmRealEndpoint: inst.endpoint,
              status: 'connected',
              mode: 'microvm',
            }
          }))
          fetchInstances()
        }
      } catch {}
    }
    checkAndResume()
  }, [activeTabId])

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
  }, [newNotebookName, newNotebookDesc])

  const closeTab = useCallback((tabId) => {
    const closingTab = tabs.find(t => t.id === tabId)
    if (!closingTab) return
    // Show confirm modal with save option
    setModal({ type: 'closeNotebook', tabId, tabName: closingTab.name })
  }, [tabs])

  const confirmCloseTab = useCallback((tabId, shouldSave) => {
    if (shouldSave) {
      // Trigger save on the notebook before closing (save handled by Notebook component via ref — simplified: just close)
      // For simplicity, we dispatch a custom event
      window.dispatchEvent(new CustomEvent('save-notebook', { detail: { tabId } }))
    }

    const closingTab = tabs.find(t => t.id === tabId)
    if (closingTab?.microvmId && closingTab.mode === 'microvm') {
      fetch(`${PROXY_URL}/terminate/${closingTab.microvmId}`, { method: 'POST' }).catch(() => {})
    }

    setTabs(prev => {
      const remaining = prev.filter(t => t.id !== tabId)
      return remaining
    })
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

  // Suspend: suspends an attached VM, detaches from notebook
  const suspendInstance = useCallback(async (microvmId) => {
    try {
      // Detach the notebook from the VM — the VM stays running but will suspend on idle timeout.
      setTabs(prev => prev.map(t => {
        if (t.microvmId !== microvmId) return t
        return { ...t, microvmId: null, status: 'disconnected', microvmEndpoint: null, microvmRealEndpoint: null, mode: null }
      }))
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
    setUploadedFiles(prev => [...prev, { name: file.name, size, variable: null, status: 'uploading' }])

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

        setUploadedFiles(prev => prev.map(f =>
          f.name === file.name
            ? { ...f, variable: result.variable_name || null, status: result.success ? 'ready' : 'error' }
            : f
        ))
      } catch {
        setUploadedFiles(prev => prev.map(f =>
          f.name === file.name ? { ...f, status: 'error', variable: 'failed' } : f
        ))
      }
    }
    reader.readAsDataURL(file)
  }, [tabs, activeTabId])

  const deleteFile = useCallback((filename) => {
    setUploadedFiles(prev => prev.filter(f => f.name !== filename))
  }, [])

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

      setUploadedFiles(prev => [...prev, { name: filename, size, variable: null, status: 'uploading' }])

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

      setUploadedFiles(prev => prev.map(f =>
        f.name === filename
          ? { ...f, variable: result.variable_name || null, status: result.success ? 'ready' : 'error' }
          : f
      ))
    } catch (err) {
      setUploadedFiles(prev => prev.map(f =>
        f.name === filename ? { ...f, status: 'error', variable: 'failed' } : f
      ))
    }
  }, [tabs, activeTabId])

  const loadSample = useCallback(async (sampleUrl, sampleName) => {
    try {
      const resp = await fetch(sampleUrl)
      const notebook = await resp.json()

      const tab = createTab(sampleName || notebook.name, notebook.description || '')
      tab._loadedCells = notebook.cells
      setTabs(prev => [...prev, { ...tab }])
      setActiveTabId(tab.id)
    } catch (err) {
      alert(`Failed to load sample: ${err.message}`)
    }
  }, [])

  // Listen for "Open Notebook" events from Notebook toolbar (creates a new tab)
  useEffect(() => {
    const handler = (e) => {
      const { name, description, cells } = e.detail
      const tab = createTab(name, description)
      tab._loadedCells = cells
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
          instances={instances}
          attachedIds={attachedIds}
          uploadedFiles={uploadedFiles}
          onSelectTab={setActiveTabId}
          onNewNotebook={addTab}
          onCloseTab={closeTab}
          onRenameTab={renameTab}
          onAttachInstance={attachInstance}
          onResumeInstance={resumeInstance}
          onTerminateInstance={terminateInstance}
          onRefreshInstances={fetchInstances}
          onUploadFile={uploadFile}
          onDeleteFile={deleteFile}
          onLoadSample={loadSample}
          onUploadSampleData={uploadSampleData}
          onInsertCode={insertCode}
          onShowInstances={() => setShowInstances(true)}
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
          {tabs.filter(tab => tab.id === activeTabId).map(tab => (
            <Notebook
              key={tab.id}
              tab={tab}
              onUpdateTab={(updates) => updateTab(tab.id, updates)}
              attachedIds={attachedIds}
              theme={theme}
              onToggleTheme={toggleTheme}
            />
          ))}
        </main>
      </div>

      {/* Modals */}
      {showInstances && (
        <InstancesPanel
          onClose={() => setShowInstances(false)}
          onAttach={attachInstance}
          onTerminateAndSave={terminateAndSave}
          onSuspend={suspendInstance}
          attachedIds={attachedIds}
          tabs={tabs}
        />
      )}

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
