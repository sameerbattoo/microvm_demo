import { useState, useCallback, useRef, useEffect } from 'react'
import Cell from './Cell'
import ConnectionPanel from './ConnectionPanel'
import PackageManager from './PackageManager'
import { IconPlus, IconPlayAll, IconPlay, IconTrash, IconPackage, IconSave, IconFolderOpen, IconSettings } from './Icons'
import './Notebook.css'

let nextCellId = (() => {
  // Start above any existing cell IDs from persisted state
  try {
    const saved = localStorage.getItem('microvm-notebooks')
    if (saved) {
      const tabs = JSON.parse(saved)
      let maxId = 0
      for (const tab of tabs) {
        for (const cell of (tab._cells || [])) {
          if (cell.id > maxId) maxId = cell.id
        }
      }
      return maxId + 1
    }
  } catch {}
  return 1
})()

function createCell() {
  return {
    id: nextCellId++,
    code: '',
    output: null,
    error: null,
    html: null,
    image: null,
    status: 'idle', // idle | running | success | error
    executionNumber: null,
    executionTime: null,
  }
}

export default function Notebook({ tab, onUpdateTab, attachedIds = [] }) {
  const [cells, setCells] = useState(() => {
    // Restore cells from tab state (persists across tab switches)
    if (tab._cells && Array.isArray(tab._cells) && tab._cells.length > 0) {
      return tab._cells
    }
    // If tab has pre-loaded cells (from sample), use them
    if (tab._loadedCells && Array.isArray(tab._loadedCells)) {
      return tab._loadedCells.map(c => ({
        id: nextCellId++,
        code: c.code || '',
        output: c.output || null,
        error: c.error || null,
        html: c.html || null,
        image: c.image || null,
        status: 'idle',
        executionNumber: c.executionNumber || null,
        executionTime: null,
      }))
    }
    return [createCell()]
  })
  const [showConnection, setShowConnection] = useState(tab.status !== 'connected')
  const [showPackageManager, setShowPackageManager] = useState(false)
  const [isExecuting, setIsExecuting] = useState(false)
  const [activeCellId, setActiveCellId] = useState(null)
  const [aiAvailable, setAiAvailable] = useState(false)
  const executionQueue = useRef([])
  const bottomRef = useRef(null)

  // Auto-scroll when cells are added
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [cells.length])

  // Persist cells to tab state (survives tab switches)
  const prevCellsRef = useRef(cells)
  useEffect(() => {
    // Only update if cells actually changed (avoid infinite loop)
    if (prevCellsRef.current !== cells) {
      prevCellsRef.current = cells
      onUpdateTab({ _cells: cells })
    }
  }, [cells])

  // Sync cells from tab._cells when changed externally (e.g. insertCode from sidebar)
  useEffect(() => {
    if (tab._cells && tab._cells !== prevCellsRef.current) {
      prevCellsRef.current = tab._cells
      setCells(tab._cells)
    }
  }, [tab._cells])

  // Listen for code insertion events from sidebar (S3/DynamoDB clicks)
  useEffect(() => {
    const handler = (e) => {
      const { code } = e.detail
      if (!code) return
      setCells(prev => {
        const lastCell = prev[prev.length - 1]
        if (lastCell && !lastCell.code.trim()) {
          // Use the last empty cell
          return prev.map((c, i) => i === prev.length - 1 ? { ...c, code } : c)
        }
        // Add a new cell
        return [...prev, {
          id: Date.now(),
          code,
          output: null,
          error: null,
          html: null,
          image: null,
          status: 'idle',
          executionNumber: null,
          executionTime: null,
        }]
      })
    }
    window.addEventListener('insert-code', handler)
    return () => window.removeEventListener('insert-code', handler)
  }, [])

  // Check AI availability when connected
  useEffect(() => {
    if (tab.status === 'connected' && tab.microvmEndpoint) {
      // AI endpoints live on the proxy (8081) or local backend (8080)
      const aiBase = tab.microvmEndpoint.includes('8081')
        ? 'http://localhost:8081'
        : tab.microvmEndpoint
      fetch(`${aiBase}/ai/config`)
        .then(r => r.json())
        .then(data => setAiAvailable(data.ai_available === true))
        .catch(() => setAiAvailable(false))
    }
  }, [tab.status, tab.microvmEndpoint])

  const executeCell = useCallback(async (cellId) => {
    if (!tab.microvmEndpoint || tab.status !== 'connected') {
      return
    }

    const cell = cells.find(c => c.id === cellId)
    if (!cell || !cell.code.trim()) return

    // Queue execution — cells run sequentially to maintain state consistency
    const doExecute = async () => {
      // Mark as running
      setCells(prev => prev.map(c =>
        c.id === cellId ? { ...c, status: 'running', output: null, error: null } : c
      ))

      // Build headers
      const headers = { 'Content-Type': 'application/json' }
      if (tab.microvmId) {
        headers['X-MicroVM-Id'] = tab.microvmId
        let realEndpoint = tab.microvmRealEndpoint
        if (!realEndpoint) {
          try {
            const instResp = await fetch('http://localhost:8081/instances')
            const instData = await instResp.json()
            const inst = instData.instances?.[tab.microvmId]
            if (inst?.endpoint) {
              realEndpoint = inst.endpoint
            }
          } catch {}
        }
        if (realEndpoint) {
          headers['X-MicroVM-Endpoint'] = realEndpoint
        }
      }

      try {
        const response = await fetch(`${tab.microvmEndpoint}/execute`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ code: cell.code }),
        })

        const text = await response.text()
        let result
        try {
          result = JSON.parse(text)
        } catch {
          setCells(prev => prev.map(c =>
            c.id === cellId
              ? { ...c, status: 'error', error: 'MicroVM unreachable (may be terminated or suspended). Reconnect via ⚙ Connection.' }
              : c
          ))
          return
        }

        if (result.error && !('success' in result)) {
          setCells(prev => prev.map(c =>
            c.id === cellId
              ? { ...c, status: 'error', error: result.error }
              : c
          ))
          return
        }

        setCells(prev => prev.map(c =>
          c.id === cellId
            ? {
                ...c,
                status: result.success ? 'success' : 'error',
                output: result.output || null,
                error: result.error || null,
                html: result.html || null,
                image: result.image || null,
                executionNumber: result.execution_number,
                executionTime: result.execution_time_ms,
              }
            : c
        ))
      } catch (err) {
        setCells(prev => prev.map(c =>
          c.id === cellId
            ? { ...c, status: 'error', error: `Connection error: ${err.message}` }
            : c
        ))
      }
    }

    // Add to queue and process sequentially
    executionQueue.current.push(doExecute)
    if (!isExecuting) {
      setIsExecuting(true)
      while (executionQueue.current.length > 0) {
        const next = executionQueue.current.shift()
        await next()
      }
      setIsExecuting(false)
    }
  }, [tab.microvmEndpoint, tab.microvmId, tab.microvmRealEndpoint, tab.status, cells, isExecuting])

  const executeAllCells = useCallback(async () => {
    if (!tab.microvmEndpoint || tab.status !== 'connected') return

    for (const cell of cells) {
      if (cell.code.trim()) {
        await executeCell(cell.id)
      }
    }
  }, [cells, tab.microvmEndpoint, tab.status, executeCell])

  const runActiveCell = useCallback(() => {
    if (activeCellId) {
      executeCell(activeCellId)
    }
  }, [activeCellId, executeCell])

  const deleteActiveCell = useCallback(() => {
    if (activeCellId) {
      setCells(prev => {
        if (prev.length <= 1) return prev
        const idx = prev.findIndex(c => c.id === activeCellId)
        const next = prev.filter(c => c.id !== activeCellId)
        // Select the next cell (or previous if last)
        const newActive = next[Math.min(idx, next.length - 1)]
        if (newActive) setActiveCellId(newActive.id)
        return next
      })
    }
  }, [activeCellId])

  const updateCellCode = useCallback((cellId, code) => {
    setCells(prev => prev.map(c => c.id === cellId ? { ...c, code } : c))
  }, [])

  const addCellBelow = useCallback((cellId) => {
    const newCell = createCell()
    setCells(prev => {
      const idx = prev.findIndex(c => c.id === cellId)
      const next = [...prev]
      next.splice(idx + 1, 0, newCell)
      return next
    })
  }, [])

  const addCellAtEnd = useCallback(() => {
    setCells(prev => [...prev, createCell()])
  }, [])

  const deleteCell = useCallback((cellId) => {
    setCells(prev => {
      if (prev.length <= 1) return prev // Keep at least one cell
      return prev.filter(c => c.id !== cellId)
    })
  }, [])

  const handleConnect = useCallback((endpoint) => {
    onUpdateTab({
      microvmEndpoint: endpoint,
      status: 'connected',
    })
    setShowConnection(false)
  }, [onUpdateTab])

  const saveNotebook = useCallback(() => {
    const notebook = {
      name: tab.name,
      description: tab.description || '',
      microvmId: tab.microvmId || null,
      savedAt: new Date().toISOString(),
      cells: cells.map(c => ({
        code: c.code,
        output: c.output,
        error: c.error,
        html: c.html,
        image: c.image,
        executionNumber: c.executionNumber,
      })),
    }

    const blob = new Blob([JSON.stringify(notebook, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${tab.name.replace(/\s+/g, '_')}.notebook.json`
    a.click()
    URL.revokeObjectURL(url)
  }, [tab.name, tab.microvmId, cells])

  const loadNotebook = useCallback(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json,.notebook.json'
    input.onchange = (e) => {
      const file = e.target.files?.[0]
      if (!file) return

      const reader = new FileReader()
      reader.onload = (ev) => {
        try {
          const notebook = JSON.parse(ev.target.result)
          if (notebook.cells && Array.isArray(notebook.cells)) {
            const loadedCells = notebook.cells.map(c => ({
              id: nextCellId++,
              code: c.code || '',
              output: c.output || null,
              error: c.error || null,
              html: c.html || null,
              image: c.image || null,
              status: c.output || c.error || c.html || c.image ? 'success' : 'idle',
              executionNumber: c.executionNumber || null,
              executionTime: null,
            }))
            setCells(loadedCells.length > 0 ? loadedCells : [createCell()])
            if (notebook.name) {
              onUpdateTab({ name: notebook.name, description: notebook.description || '' })
            }
          }
        } catch {
          alert('Invalid notebook file')
        }
      }
      reader.readAsText(file)
    }
    input.click()
  }, [onUpdateTab])

  return (
    <div className="notebook">
      {showConnection && (
        <ConnectionPanel
          tab={tab}
          onConnect={handleConnect}
          onUpdateTab={onUpdateTab}
          onDismiss={() => setShowConnection(false)}
          attachedIds={attachedIds}
        />
      )}
      {!showConnection && (
        <>
        <div className="notebook-toolbar">
          <div className="toolbar-group">
            <button className="toolbar-btn" onClick={addCellAtEnd} title="Add cell">
              <IconPlus width={14} height={14} /> Cell
            </button>
            <button
              className="toolbar-btn toolbar-btn-run"
              onClick={runActiveCell}
              disabled={!activeCellId || isExecuting || tab.status !== 'connected'}
              title="Run active cell (Shift+Enter)"
            >
              <IconPlay width={14} height={14} /> Run
            </button>
            <button
              className="toolbar-btn toolbar-btn-run-all"
              onClick={executeAllCells}
              disabled={isExecuting || tab.status !== 'connected'}
              title="Execute all cells sequentially"
            >
              <IconPlayAll width={14} height={14} /> Run All
            </button>
            <button
              className="toolbar-btn toolbar-btn-delete"
              onClick={deleteActiveCell}
              disabled={!activeCellId}
              title="Delete active cell"
            >
              <IconTrash width={14} height={14} /> Delete
            </button>
          </div>

          <span className="toolbar-divider" />

          <div className="toolbar-group">
            <button className="toolbar-btn" onClick={saveNotebook} title="Save notebook">
              <IconSave width={14} height={14} /> Save
            </button>
            <button className="toolbar-btn" onClick={loadNotebook} title="Open notebook">
              <IconFolderOpen width={14} height={14} /> Open
            </button>
          </div>

          <span className="toolbar-divider" />

          <button
            className="toolbar-btn"
            onClick={() => setShowPackageManager(true)}
            title="Manage packages"
          >
            <IconPackage width={14} height={14} /> Packages
          </button>

          <span className="toolbar-divider" />

          <button className="toolbar-btn" onClick={() => setShowConnection(true)} title="Connection settings">
            <IconSettings width={14} height={14} /> Connection
          </button>

          <div className="toolbar-status">
            <span className={`status-dot status-${tab.status}`} />
            <span className="status-text">
              {tab.status === 'connected' ? 'Connected' : 'Disconnected'}
            </span>
            {tab.microvmId && (
              <span className="status-id">{tab.microvmId}</span>
            )}
          </div>
        </div>
        {tab.description && (
          <div className="notebook-description">{tab.description}</div>
        )}
        </>
      )}

      <div className="cells-container">
        {cells.map((cell, index) => (
          <Cell
            key={cell.id}
            cell={cell}
            index={index}
            isConnected={tab.status === 'connected'}
            isActive={cell.id === activeCellId}
            onFocus={() => setActiveCellId(cell.id)}
            onExecute={() => executeCell(cell.id)}
            onCodeChange={(code) => updateCellCode(cell.id, code)}
            onAddBelow={() => addCellBelow(cell.id)}
            onDelete={() => deleteCell(cell.id)}
            notebookContext={cells}
            microvmEndpoint={tab.microvmEndpoint}
            aiAvailable={aiAvailable}
          />
        ))}
        <div className="add-cell-row">
          <button className="add-cell-btn" onClick={addCellAtEnd}>
            + Add cell
          </button>
        </div>
        <div ref={bottomRef} />
      </div>

      {showPackageManager && (
        <PackageManager
          onClose={() => setShowPackageManager(false)}
          microvmEndpoint={tab.microvmEndpoint}
          microvmId={tab.microvmId}
          microvmRealEndpoint={tab.microvmRealEndpoint}
        />
      )}
    </div>
  )
}
