import { useState, useCallback, useRef, useEffect } from 'react'
import Cell from './Cell'
import ConnectionPanel from './ConnectionPanel'
import './Notebook.css'

let nextCellId = 1

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
  const [showInstall, setShowInstall] = useState(false)
  const [installPkg, setInstallPkg] = useState('')
  const [installStatus, setInstallStatus] = useState(null) // null | 'installing' | 'success' | 'error'
  const [installMessage, setInstallMessage] = useState('')
  const [isExecuting, setIsExecuting] = useState(false)
  const executionQueue = useRef([])
  const bottomRef = useRef(null)
  const installInputRef = useRef(null)

  // Auto-scroll when cells are added
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [cells.length])

  // Focus install input when shown
  useEffect(() => {
    if (showInstall && installInputRef.current) {
      installInputRef.current.focus()
    }
  }, [showInstall])

  const installPackage = useCallback(async () => {
    if (!installPkg.trim() || !tab.microvmEndpoint) return

    setInstallStatus('installing')
    setInstallMessage('')

    try {
      const response = await fetch(`${tab.microvmEndpoint}/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ package: installPkg.trim() }),
      })
      const result = await response.json()

      if (result.success) {
        setInstallStatus('success')
        setInstallMessage(result.output)
        setInstallPkg('')
      } else {
        setInstallStatus('error')
        setInstallMessage(result.error || 'Install failed')
      }
    } catch (err) {
      setInstallStatus('error')
      setInstallMessage(err.message)
    }

    setTimeout(() => setInstallStatus(null), 4000)
  }, [installPkg, tab.microvmEndpoint])

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

  const uploadDataFile = useCallback(() => {
    if (!tab.microvmEndpoint || tab.status !== 'connected') return

    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.csv,.xlsx,.xls,.parquet,.json'
    input.onchange = async (e) => {
      const file = e.target.files?.[0]
      if (!file) return

      // Read file as base64
      const reader = new FileReader()
      reader.onload = async (ev) => {
        const base64 = ev.target.result.split(',')[1]

        // Build headers
        const headers = { 'Content-Type': 'application/json' }
        if (tab.microvmId) {
          headers['X-MicroVM-Id'] = tab.microvmId
          if (tab.microvmRealEndpoint) {
            headers['X-MicroVM-Endpoint'] = tab.microvmRealEndpoint
          }
        }

        // Add a cell showing the upload
        const newCell = createCell()
        newCell.code = `# Uploaded: ${file.name}`
        newCell.status = 'running'
        setCells(prev => [...prev, newCell])

        try {
          const response = await fetch(`${tab.microvmEndpoint}/upload`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              filename: file.name,
              data: base64,
            }),
          })

          const text = await response.text()
          let result
          try { result = JSON.parse(text) } catch { result = { success: false, error: 'Upload failed' } }

          if (result.success) {
            setCells(prev => prev.map(c =>
              c.id === newCell.id
                ? {
                    ...c,
                    code: `# Uploaded: ${file.name} → ${result.variable_name}`,
                    status: 'success',
                    output: `${result.message}\n${result.shape || ''}`,
                  }
                : c
            ))
          } else {
            setCells(prev => prev.map(c =>
              c.id === newCell.id
                ? { ...c, status: 'error', error: result.error || 'Upload failed' }
                : c
            ))
          }
        } catch (err) {
          setCells(prev => prev.map(c =>
            c.id === newCell.id
              ? { ...c, status: 'error', error: `Upload error: ${err.message}` }
              : c
          ))
        }
      }
      reader.readAsDataURL(file)
    }
    input.click()
  }, [tab.microvmEndpoint, tab.microvmId, tab.microvmRealEndpoint, tab.status])

  return (
    <div className="notebook">
      {showConnection || tab.status !== 'connected' ? (
        <ConnectionPanel
          tab={tab}
          onConnect={handleConnect}
          onUpdateTab={onUpdateTab}
          onDismiss={() => setShowConnection(false)}
          attachedIds={attachedIds}
        />
      ) : (
        <>
        <div className="notebook-toolbar">
          <button className="toolbar-btn" onClick={addCellAtEnd}>
            + Cell
          </button>
          <button
            className={`toolbar-btn ${showInstall ? 'toolbar-btn-active' : ''}`}
            onClick={() => setShowInstall(!showInstall)}
          >
            📦 Install
          </button>
          <button className="toolbar-btn" onClick={saveNotebook}>
            💾 Save
          </button>
          <button className="toolbar-btn" onClick={loadNotebook}>
            📂 Open
          </button>
          <button className="toolbar-btn" onClick={() => setShowConnection(true)}>
            ⚙ Connection
          </button>

          {showInstall && (
            <div className="toolbar-install">
              <input
                ref={installInputRef}
                className="install-input"
                type="text"
                value={installPkg}
                onChange={(e) => setInstallPkg(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && installPackage()}
                placeholder="package name (e.g. pandas)"
                disabled={installStatus === 'installing'}
              />
              <button
                className="install-btn"
                onClick={installPackage}
                disabled={!installPkg.trim() || installStatus === 'installing'}
              >
                {installStatus === 'installing' ? '...' : 'Install'}
              </button>
              {installStatus === 'success' && (
                <span className="install-msg install-msg-ok">✓ Installed</span>
              )}
              {installStatus === 'error' && (
                <span className="install-msg install-msg-err" title={installMessage}>✗ Failed</span>
              )}
            </div>
          )}

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
            onExecute={() => executeCell(cell.id)}
            onCodeChange={(code) => updateCellCode(cell.id, code)}
            onAddBelow={() => addCellBelow(cell.id)}
            onDelete={() => deleteCell(cell.id)}
          />
        ))}
        <div className="add-cell-row">
          <button className="add-cell-btn" onClick={addCellAtEnd}>
            + Add cell
          </button>
        </div>
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
