import { useState, useCallback, useEffect, useRef } from 'react'
import Notebook from './components/Notebook'
import Sidebar from './components/Sidebar'
import AiChatPanel from './components/AiChatPanel'
import TerminalPanel from './components/panels/TerminalPanel'
import LogsPanel from './components/LogsPanel'
import IntelPanel from './components/IntelPanel'
import { ConfirmModal, InputModal } from './components/Modal'
import WelcomeScreen from './components/WelcomeScreen'
import { useInstances } from './hooks/useInstances'
import { useTabsPersistence } from './hooks/useTabsPersistence'
import { useNotebookFiles } from './hooks/useNotebookFiles'
import { useSamplesImport } from './hooks/useSamplesImport'
import { useTheme } from './hooks/useTheme'
import { useBottomPanel } from './hooks/useBottomPanel'
import { IconZap, IconSun, IconMoon, IconFlame, IconTerminal, IconLogs, IconIntel } from './components/Icons'
import { PROXY_URL } from './config'
import { logError } from './services/logger'
import { showDragOverlay, hideDragOverlay } from './utils/dragOverlay'
import { INTEL_GENERATING_POLL_MS, INTEL_IDLE_POLL_MS, INTEL_MAX_POLL_ATTEMPTS, DEFAULT_POLL_INTERVAL_MS } from './constants'
import { fetchNotebooks, saveNotebook as apiSaveNotebook, createNotebook as apiCreateNotebook, deleteNotebook as apiDeleteNotebook, migrateFromLocalStorage, loadChatMessages, saveChatMessages } from './services/notebooks'
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
  const [pollIntervalMs, setPollIntervalMs] = useState(DEFAULT_POLL_INTERVAL_MS)

  // Persist tabs (localStorage + API, debounced), load/migrate from API on mount,
  // and persist the active tab id.
  useTabsPersistence({ tabs, setTabs, activeTabId, setActiveTabId })

  // Theme state (persisted, 3-way toggle)
  const { theme, toggleTheme } = useTheme()

  // Modal state
  const [modal, setModal] = useState(null)
  const [showAiChat, setShowAiChat] = useState(true)

  // MicroVM instances + lifecycle (polling, auto-connect/rotation/termination sync,
  // metrics, attach/resume/suspend/terminate). Single source of truth for VM state.
  const {
    instances, vmMetrics, refreshMetrics, markVmRunning, fetchInstances,
    attachInstance, resumeInstance, terminateInstance, confirmTerminateInstance,
    terminateAndSave, suspendInstance,
  } = useInstances({ tabs, setTabs, setActiveTabId, setModal, createTab, pollIntervalMs })

  // Sandbox + S3 file operations (list/upload/delete) with Intel (re)generation.
  const { fetchFiles, uploadFile, deleteFile, deleteS3File } = useNotebookFiles({ tabs, setTabs, activeTabId })

  // Welcome-screen sample gallery + git import + sample loading.
  const {
    loadSample, showGitImport, setShowGitImport, gitImportUrl, setGitImportUrl,
    gitImportLoading, importFromGitUrl, showSampleGallery, setShowSampleGallery,
    toggleSampleGallery, samples,
  } = useSamplesImport({ createTab, setTabs, setActiveTabId, setShowAiChat })
  // Bottom panel (terminal / logs / intel) — open tabs, active tab, height.
  const {
    bottomPanelTabs, setBottomPanelTabs,
    bottomPanelActive, setBottomPanelActive,
    bottomPanelHeight, setBottomPanelHeight,
    toggleBottomTab, closeBottomTab,
  } = useBottomPanel()
  const [aiAvailable, setAiAvailable] = useState(false)
  const [intelShownForSession, setIntelShownForSession] = useState(null) // tracks which session we auto-showed intel for

  // Auto-show Intel panel when intel becomes available for the active tab.
  //
  // This polls the backend's REAL generation state (see is_generating() in
  // proxy/notebook/ai/workbook_intel.py) instead of guessing a fixed time
  // window. The old version waited a blind 30s then polled every 15s for up
  // to 3 minutes before giving up permanently — since actual generation time
  // varies (agent tool calls + LLM latency), anything slower than 3 minutes
  // meant the tab silently never popped up even though generation succeeded
  // moments later. Now: check immediately, poll fast while status is
  // genuinely "generating", and only stop when the backend reports ready
  // (or error) — no arbitrary cutoff for the case we know is still running.
  const intelPollRef = useRef({ sessionId: null, cancelled: true })

  useEffect(() => {
    const activeTab = tabs.find(t => t.id === activeTabId)
    const sessionId = activeTab?.sessionId
    if (!sessionId || sessionId === intelShownForSession) return
    if (activeTab?.status !== 'connected') return

    // Guard against starting a duplicate poll loop for a session that's already
    // being watched (e.g. rapid re-renders before the deps below actually change)
    if (intelPollRef.current.sessionId === sessionId && !intelPollRef.current.cancelled) {
      return
    }

    const pollState = { sessionId, cancelled: false }
    intelPollRef.current = pollState

    const GENERATING_INTERVAL_MS = INTEL_GENERATING_POLL_MS
    const IDLE_INTERVAL_MS = INTEL_IDLE_POLL_MS
    const MAX_ATTEMPTS = INTEL_MAX_POLL_ATTEMPTS

    let attempts = 0

    const poll = async () => {
      if (pollState.cancelled || pollState.fetching) return
      attempts++

      pollState.fetching = true
      let data = null
      try {
        const resp = await fetch(`${PROXY_URL}/workbook-intel`, { headers: { 'X-Session-Id': sessionId } })
        if (resp.ok) data = await resp.json()
      } catch {
        // network hiccup — fall through and retry at the idle interval
      } finally {
        pollState.fetching = false
      }

      if (pollState.cancelled) return

      if (data?.status === 'ready' && data.intel) {
        setBottomPanelTabs(prev => new Set([...prev, 'intel']))
        setBottomPanelActive('intel')
        setIntelShownForSession(sessionId)
        // Intel generation also creates local file entity docs — refresh the
        // data sources panel so sparkle icons appear for local files too
        window.dispatchEvent(new CustomEvent('refresh-datasources'))
        return  // done
      }

      if (data?.status === 'error') return  // generation failed — nothing to auto-open
      if (attempts >= MAX_ATTEMPTS) return   // safety net exhausted

      const delay = data?.status === 'generating' ? GENERATING_INTERVAL_MS : IDLE_INTERVAL_MS
      setTimeout(poll, delay)
    }

    poll()  // check right away — no blind upfront wait

    return () => { pollState.cancelled = true }
    // NOTE: sessionId MUST be a dependency. On some connect paths `status` flips to
    // 'connected' before the tab's sessionId is set (e.g. auto-reconnect in
    // useInstances/useNotebookCells updates status without sessionId). Without
    // sessionId here, the effect runs once with sessionId=null, bails at the guard
    // above, and never re-runs when the id lands — so the poll never starts and the
    // Intel tab never auto-opens even though generation completed.
  }, [activeTabId, tabs.find?.(t => t?.id === activeTabId)?.status, tabs.find?.(t => t?.id === activeTabId)?.sessionId, intelShownForSession])
  const [newNotebookName, setNewNotebookName] = useState('')
  const [newNotebookDesc, setNewNotebookDesc] = useState('')

  // Global keyboard shortcuts
  useEffect(() => {
    const handler = (e) => {
      // Ctrl+` or Cmd+` — toggle terminal
      if (e.key === '`' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        toggleBottomTab('terminal')
      }
      // Ctrl+L or Cmd+L — toggle logs panel
      if (e.key === 'l' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        toggleBottomTab('logs')
      }
      // Shortcuts follow the activity-bar's visual top-to-bottom order:
      // ⌥1 notebooks, ⌥2 outline, ⌥3 data, ⌥4 variables, ⌥5 packages (sidebar panels),
      // ⌥6 terminal, ⌥7 logs, ⌥8 intel (bottom tabs), ⌥9 snippets (sidebar panel).
      if (e.altKey && !e.ctrlKey && !e.metaKey) {
        const digitMatch = e.code?.match(/^Digit([1-9])$/)
        if (digitMatch) {
          e.preventDefault()
          const idx = parseInt(digitMatch[1])
          const sidebarPanels = { 1: 'notebooks', 2: 'outline', 3: 'data', 4: 'variables', 5: 'packages', 9: 'snippets' }
          if (sidebarPanels[idx]) {
            window.dispatchEvent(new CustomEvent('toggle-sidebar-panel', { detail: sidebarPanels[idx] }))
          } else if (idx === 6) {
            toggleBottomTab('terminal')
          } else if (idx === 7) {
            toggleBottomTab('logs')
          } else if (idx === 8) {
            toggleBottomTab('intel')
          }
        }
      }
      // Cmd+S / Ctrl+S — save notebook (prevent browser save dialog)
      if (e.key === 's' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        // Trigger save via custom event (Notebook component listens)
        window.dispatchEvent(new CustomEvent('notebook-save'))
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

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
      if (closingTab.sessionId) {
        fetch(`${PROXY_URL}/terminate`, { method: 'POST', headers: { 'X-Session-Id': closingTab.sessionId } }).catch(() => {})
      }
    }

    // Delete notebook from backend storage
    apiDeleteNotebook(String(closingTab.id)).catch(() => {})

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
        outputVariable: c.outputVariable || null,
      }))
      setTabs(prev => [...prev, { ...tab }])
      setActiveTabId(tab.id)
    }
    window.addEventListener('open-notebook', handler)
    return () => window.removeEventListener('open-notebook', handler)
  }, [])

  const insertCode = useCallback((code, type) => {
    // Dispatch event for the active notebook to pick up
    window.dispatchEvent(new CustomEvent('insert-code', { detail: { code, type } }))
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
          onDeleteS3File={deleteS3File}
          onLoadSample={loadSample}
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
          onRefreshFiles={fetchFiles}
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
          onReorderCellIds={(orderedIds) => {
            // Bulk reorder: rebuild _cells to match the given id order in one update
            // (used by the outline's tree-aware block move up/down).
            const tab = tabs.find(t => t.id === activeTabId)
            if (!tab || !tab._cells) return
            const byId = new Map(tab._cells.map(c => [c.id, c]))
            const reordered = orderedIds.map(id => byId.get(id)).filter(Boolean)
            if (reordered.length === tab._cells.length) {
              updateTab(activeTabId, { _cells: reordered })
            }
          }}
          onRunFromCell={(cellIdx) => {
            window.dispatchEvent(new CustomEvent('notebook-run-from-cell', { detail: { cellIdx } }))
          }}
          onDeleteCells={(cellIds) => {
            const currentCells = tabs.find(t => t.id === activeTabId)?._cells || []
            const remaining = currentCells.filter(c => !cellIds.includes(c.id))
            updateTab(activeTabId, { _cells: remaining })
          }}
          onRunCells={(cellIndices) => {
            window.dispatchEvent(new CustomEvent('notebook-run-cells', { detail: { cellIndices } }))
          }}
          onClearOutputs={(cellIds) => {
            const currentCells = tabs.find(t => t.id === activeTabId)?._cells || []
            const updated = currentCells.map(c =>
              cellIds.includes(c.id) ? { ...c, output: null, error: null, html: null, image: null, executionTime: null, executionNumber: null } : c
            )
            updateTab(activeTabId, { _cells: updated })
          }}
          showTerminal={bottomPanelTabs.has('terminal')}
          onToggleTerminal={() => toggleBottomTab('terminal')}
          showLogs={bottomPanelTabs.has('logs')}
          onToggleLogs={() => toggleBottomTab('logs')}
          showIntel={bottomPanelTabs.has('intel')}
          onToggleIntel={() => toggleBottomTab('intel')}
        />
        <main className="app-main">
          {tabs.length === 0 && (
            <WelcomeScreen
              theme={theme}
              onToggleTheme={toggleTheme}
              onNewNotebook={addTab}
              showSampleGallery={showSampleGallery}
              onToggleSampleGallery={toggleSampleGallery}
              samples={samples}
              onLoadSample={loadSample}
              showGitImport={showGitImport}
              setShowGitImport={setShowGitImport}
              setShowSampleGallery={setShowSampleGallery}
              gitImportUrl={gitImportUrl}
              setGitImportUrl={setGitImportUrl}
              gitImportLoading={gitImportLoading}
              onImportFromGitUrl={importFromGitUrl}
            />
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
          {bottomPanelTabs.size > 0 && (
            <div className="bottom-panel-container" style={{ height: bottomPanelHeight }}>
              <div
                className="bottom-panel-resize-handle"
                onMouseDown={(e) => {
                  e.preventDefault()
                  const startY = e.clientY
                  const startHeight = bottomPanelHeight
                  // Overlay so dragging over an embedded Plotly iframe doesn't steal the
                  // mouse events and break the resize.
                  showDragOverlay('row-resize')
                  const handleMove = (moveEvent) => {
                    const delta = startY - moveEvent.clientY
                    setBottomPanelHeight(Math.max(100, Math.min(window.innerHeight * 0.7, startHeight + delta)))
                  }
                  const handleUp = () => {
                    document.removeEventListener('mousemove', handleMove)
                    document.removeEventListener('mouseup', handleUp)
                    hideDragOverlay()
                  }
                  document.addEventListener('mousemove', handleMove)
                  document.addEventListener('mouseup', handleUp)
                }}
              />
              <div className="bottom-panel-tabs">
                {bottomPanelTabs.has('terminal') && (
                  <button
                    className={`bottom-panel-tab ${bottomPanelActive === 'terminal' ? 'bottom-panel-tab-active' : ''}`}
                    onClick={() => setBottomPanelActive('terminal')}
                  >
                    <IconTerminal width={14} height={14} />
                    Terminal
                    {bottomPanelTabs.size > 1 && (
                      <span className="bottom-panel-tab-close" onClick={(e) => { e.stopPropagation(); closeBottomTab('terminal') }}>&times;</span>
                    )}
                  </button>
                )}
                {bottomPanelTabs.has('logs') && (
                  <button
                    className={`bottom-panel-tab ${bottomPanelActive === 'logs' ? 'bottom-panel-tab-active' : ''}`}
                    onClick={() => setBottomPanelActive('logs')}
                  >
                    <IconLogs width={14} height={14} />
                    Logs
                    {bottomPanelTabs.size > 1 && (
                      <span className="bottom-panel-tab-close" onClick={(e) => { e.stopPropagation(); closeBottomTab('logs') }}>&times;</span>
                    )}
                  </button>
                )}
                {bottomPanelTabs.has('intel') && (
                  <button
                    className={`bottom-panel-tab ${bottomPanelActive === 'intel' ? 'bottom-panel-tab-active' : ''}`}
                    onClick={() => setBottomPanelActive('intel')}
                  >
                    <IconIntel width={14} height={14} />
                    Intel
                    {bottomPanelTabs.size > 1 && (
                      <span className="bottom-panel-tab-close" onClick={(e) => { e.stopPropagation(); closeBottomTab('intel') }}>&times;</span>
                    )}
                  </button>
                )}
                <button
                  className="bottom-panel-close"
                  onClick={() => { setBottomPanelTabs(new Set()); setBottomPanelActive(null) }}
                  title="Close panel"
                >
                  &times;
                </button>
              </div>
              {bottomPanelActive === 'terminal' && (
                <TerminalPanel
                  activeTab={tabs.find(t => t.id === activeTabId) || null}
                  onClose={() => closeBottomTab('terminal')}
                  theme={theme}
                  embedded={bottomPanelTabs.size > 1}
                />
              )}
              {bottomPanelActive === 'logs' && (
                <LogsPanel
                  activeTab={tabs.find(t => t.id === activeTabId) || null}
                  onClose={() => closeBottomTab('logs')}
                  embedded={bottomPanelTabs.size > 1}
                />
              )}
              {bottomPanelActive === 'intel' && (
                <IntelPanel
                  activeTab={tabs.find(t => t.id === activeTabId) || null}
                  onClose={() => closeBottomTab('intel')}
                  onInsertPrompt={(prompt) => {
                    // Open AI chat and send the prompt
                    setShowAiChat(true)
                    // Delay to let chat panel mount, then inject the message
                    setTimeout(() => {
                      window.dispatchEvent(new CustomEvent('ai-chat-send', { detail: prompt }))
                    }, 300)
                  }}
                />
              )}
            </div>
          )}
        </main>
        {showAiChat && (
          <AiChatPanel
            activeTab={tabs.find(t => t.id === activeTabId) || null}
            uploadedFiles={tabs.find(t => t.id === activeTabId)?._localFiles || []}
            onClose={() => setShowAiChat(false)}
            onUpdateMessages={(msgs) => {
              updateTab(activeTabId, { _chatMessages: msgs })
              // Persist to DB (non-blocking)
              const tab = tabs.find(t => t.id === activeTabId)
              if (tab?.sessionId) saveChatMessages(tab.sessionId, String(tab.id), msgs)
            }}
            onUpdateCell={(code) => {
              const tab = tabs.find(t => t.id === activeTabId)
              if (!tab || !tab._cells || tab._activeCellIndex == null) return
              const newCells = [...tab._cells]
              newCells[tab._activeCellIndex] = { ...newCells[tab._activeCellIndex], code }
              updateTab(activeTabId, { _cells: newCells })
            }}
            onInsertCells={(codeBlocks, types) => {
              codeBlocks.forEach((code, i) => {
                const type = types?.[i] || 'code'
                window.dispatchEvent(new CustomEvent('insert-code', { detail: { code, type } }))
              })
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
