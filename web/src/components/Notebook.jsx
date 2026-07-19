import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import Cell from './Cell'
import ConnectionPanel from './ConnectionPanel'
import { IconPlus, IconPlayAll, IconPlay, IconTrash, IconSave, IconFolderOpen, IconStop, IconFile, IconSearch, IconChevronUp, IconChevronDown, IconX, IconZap, IconSun, IconMoon, IconCode, IconNotebook } from './Icons'
import { PROXY_URL } from '../config'
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

function createCell(type = 'code') {
  return {
    id: nextCellId++,
    type,  // 'code' | 'markdown'
    code: '',
    output: null,
    error: null,
    html: null,
    image: null,
    status: 'idle', // idle | running | success | error
    executionNumber: null,
    executionTime: null,
    lastExecutedCode: null, // snapshot of code at execution time (for staleness detection)
  }
}

export default function Notebook({ tab, onUpdateTab, attachedIds = [], theme, onToggleTheme, aiAvailable = false }) {
  const [cells, setCells] = useState(() => {
    // Restore cells from tab state (persists across tab switches)
    if (tab._cells && Array.isArray(tab._cells) && tab._cells.length > 0) {
      return tab._cells
    }
    // If tab has pre-loaded cells (from sample), use them
    if (tab._loadedCells && Array.isArray(tab._loadedCells)) {
      return tab._loadedCells.map(c => ({
        id: nextCellId++,
        type: c.type || 'code',
        code: c.code || '',
        output: c.output || null,
        error: c.error || null,
        html: c.html || null,
        image: c.image || null,
        status: 'idle',
        executionNumber: c.executionNumber || null,
        executionTime: c.executionTime || null,
        lastExecutedCode: c.lastExecutedCode || null,
      }))
    }
    return [createCell()]
  })
  const [showConnection, setShowConnection] = useState(tab.status !== 'connected')
  const [isExecuting, setIsExecuting] = useState(false)
  const [activeCellId, setActiveCellId] = useState(null)
  const [dragOverId, setDragOverId] = useState(null)
  const [showSearch, setShowSearch] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchMatches, setSearchMatches] = useState([]) // [{cellId, index}]
  const [searchActiveIdx, setSearchActiveIdx] = useState(0)
  const [variables, setVariables] = useState({})
  const searchInputRef = useRef(null)
  const draggedCellRef = useRef(null)
  const executionQueue = useRef([])
  const tagSuggestedRef = useRef(false)

  // Cmd+F to open search
  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault()
        setShowSearch(true)
        setTimeout(() => searchInputRef.current?.focus(), 50)
      }
      if (e.key === 'Escape' && showSearch) {
        setShowSearch(false)
        setSearchQuery('')
        setSearchMatches([])
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [showSearch])

  // Update matches when query changes
  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchMatches([])
      setSearchActiveIdx(0)
      return
    }
    const q = searchQuery.toLowerCase()
    const matches = []
    cells.forEach(cell => {
      if (cell.code && cell.code.toLowerCase().includes(q)) {
        // Count occurrences in this cell
        let idx = 0
        const code = cell.code.toLowerCase()
        while ((idx = code.indexOf(q, idx)) !== -1) {
          matches.push({ cellId: cell.id, pos: idx })
          idx += q.length
        }
      }
    })
    setSearchMatches(matches)
    setSearchActiveIdx(0)
    // Scroll to first match
    if (matches.length > 0) {
      setActiveCellId(matches[0].cellId)
      scrollToCellId(matches[0].cellId)
    }
  }, [searchQuery, cells])

  const scrollToCellId = (cellId) => {
    setTimeout(() => {
      const el = document.querySelector(`[data-cell-id="${cellId}"]`)
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 50)
  }

  const searchNext = () => {
    if (searchMatches.length === 0) return
    const nextIdx = (searchActiveIdx + 1) % searchMatches.length
    setSearchActiveIdx(nextIdx)
    setActiveCellId(searchMatches[nextIdx].cellId)
    scrollToCellId(searchMatches[nextIdx].cellId)
  }

  const searchPrev = () => {
    if (searchMatches.length === 0) return
    const prevIdx = (searchActiveIdx - 1 + searchMatches.length) % searchMatches.length
    setSearchActiveIdx(prevIdx)
    setActiveCellId(searchMatches[prevIdx].cellId)
    scrollToCellId(searchMatches[prevIdx].cellId)
  }

  // Scroll new cell into view when added
  useEffect(() => {
    if (activeCellId) {
      const el = document.querySelector(`[data-cell-id="${activeCellId}"]`)
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
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

  // Sync active cell index to tab so AI chat panel can reference it
  useEffect(() => {
    if (activeCellId) {
      const idx = cells.findIndex(c => c.id === activeCellId)
      if (idx >= 0) onUpdateTab({ _activeCellIndex: idx })
    }
  }, [activeCellId, cells])

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
          id: nextCellId++,
          type: 'code',
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

  const fetchVariables = useCallback(async () => {
    if (!tab.microvmEndpoint || tab.status !== 'connected') return
    try {
      const headers = { 'Content-Type': 'application/json' }
      if (tab.microvmId) {
        headers['X-MicroVM-Id'] = tab.microvmId
        if (tab.microvmRealEndpoint) headers['X-MicroVM-Endpoint'] = tab.microvmRealEndpoint
      }
      const resp = await fetch(`${tab.microvmEndpoint}/variables`, { headers })
      if (resp.ok) {
        const data = await resp.json()
        setVariables(data.variables || {})
        onUpdateTab({ _variables: data.variables || {} })
      }
    } catch {}
  }, [tab.microvmEndpoint, tab.microvmId, tab.microvmRealEndpoint, tab.status])

  const executeCell = useCallback(async (cellId) => {
    if (!tab.microvmEndpoint || tab.status !== 'connected') {
      return
    }

    const cell = prevCellsRef.current.find(c => c.id === cellId)
    if (!cell || !cell.code.trim()) return
    if (cell.type === 'markdown') return  // Markdown cells don't execute

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
            const instResp = await fetch(`${PROXY_URL}/instances`)
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
                lastExecutedCode: c.code,
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
      // Refresh variable explorer after execution
      fetchVariables()
      // Auto-tag: suggest a tag if enough cells have been executed and tag is still 'Drafts'
      if ((!tab.tag || tab.tag === 'Drafts') && !tagSuggestedRef.current) {
        tagSuggestedRef.current = true  // prevent re-fire during this attempt
        // Use a microtask to let state flush before checking outputs
        setTimeout(() => {
          const currentCells = prevCellsRef.current || []
          const executedCount = currentCells.filter(c => c.output || c.html || c.image || c.error).length
          if (executedCount >= 2) {
            const cellData = currentCells.slice(0, 4).map(c => ({ type: c.type || 'code', code: (c.code || '').slice(0, 200) }))
            fetch(`${PROXY_URL}/ai/suggest-tag`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: tab.name, description: tab.description || '', cells: cellData }),
            })
              .then(r => r.json())
              .then(data => { if (data.tag && data.tag !== 'Drafts') { onUpdateTab({ tag: data.tag }) } else { tagSuggestedRef.current = false } })
              .catch(() => { tagSuggestedRef.current = false })
          } else {
            tagSuggestedRef.current = false
          }
        }, 100)
      }
    }
  }, [tab.microvmEndpoint, tab.microvmId, tab.microvmRealEndpoint, tab.status, tab.tag, tab.name, tab.description, isExecuting])

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

  const interruptExecution = useCallback(async () => {
    if (!tab.microvmEndpoint || tab.status !== 'connected') return

    const headers = { 'Content-Type': 'application/json' }
    if (tab.microvmId) {
      headers['X-MicroVM-Id'] = tab.microvmId
      if (tab.microvmRealEndpoint) {
        headers['X-MicroVM-Endpoint'] = tab.microvmRealEndpoint
      }
    }

    try {
      await fetch(`${tab.microvmEndpoint}/interrupt`, {
        method: 'POST',
        headers,
      })
    } catch {}

    // Mark any running cell as interrupted
    setCells(prev => prev.map(c =>
      c.status === 'running'
        ? { ...c, status: 'error', error: 'Execution interrupted by user' }
        : c
    ))
  }, [tab.microvmEndpoint, tab.microvmId, tab.microvmRealEndpoint, tab.status])

  const deleteActiveCell = useCallback(() => {
    if (activeCellId) {
      setCells(prev => {
        if (prev.length <= 1) {
          // Last cell — replace with a fresh empty cell
          const fresh = createCell()
          setActiveCellId(fresh.id)
          return [fresh]
        }
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

  const addCellBelow = useCallback((cellId, type = 'code') => {
    const newCell = createCell(type)
    setCells(prev => {
      const idx = prev.findIndex(c => c.id === cellId)
      if (idx === -1) return [...prev, newCell]  // fallback: add at end
      const next = [...prev]
      next.splice(idx + 1, 0, newCell)
      return next
    })
    setActiveCellId(newCell.id)
  }, [])

  const addCellAtEnd = useCallback((type = 'code') => {
    const newCell = createCell(type)
    setCells(prev => [...prev, newCell])
    setActiveCellId(newCell.id)
  }, [])

  const changeCellType = useCallback((cellId, newType) => {
    setCells(prev => prev.map(c =>
      c.id === cellId ? { ...c, type: newType, output: null, error: null, html: null, image: null, status: 'idle' } : c
    ))
  }, [])

  // Drag-to-reorder handlers
  const handleDragStart = useCallback((cellId) => {
    draggedCellRef.current = cellId
  }, [])

  const handleDragOver = useCallback((cellId) => {
    if (draggedCellRef.current && draggedCellRef.current !== cellId) {
      setDragOverId(cellId)
    }
  }, [])

  const handleDrop = useCallback((targetCellId) => {
    const draggedId = draggedCellRef.current
    if (!draggedId || draggedId === targetCellId) {
      setDragOverId(null)
      draggedCellRef.current = null
      return
    }
    setCells(prev => {
      const draggedIdx = prev.findIndex(c => c.id === draggedId)
      const targetIdx = prev.findIndex(c => c.id === targetCellId)
      if (draggedIdx === -1 || targetIdx === -1) return prev
      const reordered = [...prev]
      const [moved] = reordered.splice(draggedIdx, 1)
      reordered.splice(targetIdx, 0, moved)
      return reordered
    })
    setDragOverId(null)
    draggedCellRef.current = null
  }, [])

  const handleDragEnd = useCallback(() => {
    setDragOverId(null)
    draggedCellRef.current = null
  }, [])

  const deleteCell = useCallback((cellId) => {
    setCells(prev => {
      if (prev.length <= 1) {
        // Last cell — replace with a fresh empty cell
        const fresh = createCell()
        setActiveCellId(fresh.id)
        return [fresh]
      }
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

  // Auto-document: explain all code cells that don't have an AI explanation yet
  const autoDocumentNotebook = useCallback(async () => {
    const codeCells = cells.filter(c => c.type !== 'markdown' && c.code?.trim() && !c.aiExplanation)
    if (codeCells.length === 0) return

    // Process cells sequentially to avoid rate limiting
    for (const cell of codeCells) {
      try {
        const resp = await fetch(`${PROXY_URL}/ai/explain`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code: cell.code || '',
            output: (cell.output || '') + (cell.html ? ' [table output]' : ''),
            microvm_id: tab.microvmId || '',
            microvm_endpoint: tab.microvmRealEndpoint || '',
          }),
        })
        if (resp.ok) {
          const data = await resp.json()
          if (data.explanation) {
            setCells(prev => prev.map(c => c.id === cell.id ? { ...c, aiExplanation: data.explanation } : c))
          }
          // Insert markdown summary above
          if (data.summary) {
            setCells(prev => {
              const idx = prev.findIndex(c => c.id === cell.id)
              if (idx < 0) return prev
              const mdText = data.summary.startsWith('#') || data.summary.startsWith('**') ? data.summary : `**${data.summary}**`
              const newCells = [...prev]
              newCells.splice(idx, 0, { id: Date.now() + Math.random(), type: 'markdown', code: mdText, output: null, error: null, html: null, image: null })
              return newCells
            })
          }
        }
      } catch {}
    }
  }, [cells, tab.microvmId, tab.microvmRealEndpoint])

  const saveNotebook = useCallback(() => {
    const notebook = {
      name: tab.name,
      description: tab.description || '',
      tag: tab.tag || null,
      microvmId: tab.microvmId || null,
      savedAt: new Date().toISOString(),
      cells: cells.map(c => ({
        type: c.type || 'code',
        code: c.code,
        output: c.output,
        error: c.error,
        html: c.html,
        image: c.image,
        executionNumber: c.executionNumber,
        aiExplanation: c.aiExplanation || null,
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
            // Open as a new notebook tab (don't overwrite current)
            window.dispatchEvent(new CustomEvent('open-notebook', {
              detail: {
                name: notebook.name || file.name.replace('.notebook.json', '').replace('.json', ''),
                description: notebook.description || '',
                tag: notebook.tag || null,
                cells: notebook.cells,
              }
            }))
          }
        } catch {
          alert('Invalid notebook file')
        }
      }
      reader.readAsText(file)
    }
    input.click()
  }, [onUpdateTab])

  // Pre-compute search match data for performance (avoids recalculating per-cell in JSX)
  const searchMatchCellIds = useMemo(() => {
    if (!showSearch || !searchQuery) return new Set()
    return new Set(searchMatches.map(m => m.cellId))
  }, [showSearch, searchQuery, searchMatches])

  const searchActiveOccurrenceMap = useMemo(() => {
    if (!showSearch || !searchQuery || searchMatches.length === 0) return {}
    const activeMatch = searchMatches[searchActiveIdx]
    if (!activeMatch) return {}
    // Count which occurrence within the active cell is highlighted
    let countInCell = 0
    for (let i = 0; i < searchActiveIdx; i++) {
      if (searchMatches[i].cellId === activeMatch.cellId) countInCell++
    }
    return { [activeMatch.cellId]: countInCell }
  }, [showSearch, searchQuery, searchMatches, searchActiveIdx])

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
          <div className="toolbar-scrollable">
          <div className="toolbar-brand">
            <IconZap width={14} height={14} />
            <span>MicroVM</span>
          </div>

          <span className="toolbar-divider" />

          <div className="toolbar-group">
            <button className="toolbar-btn" onClick={() => addCellAtEnd('code')} title="Add code cell">
              <IconPlus width={14} height={14} /> Code
            </button>
            <button className="toolbar-btn" onClick={() => addCellAtEnd('markdown')} title="Add text/markdown cell">
              <IconFile width={14} height={14} /> Text
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
              className="toolbar-btn toolbar-btn-stop"
              onClick={interruptExecution}
              disabled={!cells.some(c => c.status === 'running')}
              title="Stop execution"
            >
              <IconStop width={14} height={14} /> Stop
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
            <button className="toolbar-btn toolbar-btn-save" onClick={saveNotebook} title="Save notebook">
              <IconSave width={14} height={14} /> Save
            </button>
            <button className="toolbar-btn toolbar-btn-open" onClick={loadNotebook} title="Open notebook">
              <IconFolderOpen width={14} height={14} /> Open
            </button>
            <button className="toolbar-btn toolbar-btn-find" onClick={() => { setShowSearch(true); setTimeout(() => searchInputRef.current?.focus(), 50) }} title="Find in notebook (Cmd+F)">
              <IconSearch width={14} height={14} /> Find
            </button>
            {aiAvailable && (
              <button
                className="toolbar-btn toolbar-btn-autodoc"
                onClick={autoDocumentNotebook}
                disabled={!tab.microvmEndpoint || tab.status !== 'connected'}
                title="Auto-annotate all cells with AI explanations"
              >
                <IconFile width={14} height={14} /> Annotate
              </button>
            )}
          </div>

          </div>

          <div className="toolbar-pinned">
          <div className="toolbar-status" onClick={() => setShowConnection(true)} title="Click to manage connection">
            <span className={`status-dot status-${tab.status}`} />
            <span className="status-text">
              {tab.status === 'connected' ? 'Connected' :
               tab.status === 'connecting' ? 'Connecting...' :
               tab.status === 'launching' ? 'Launching...' :
               'Disconnected'}
            </span>
            {tab.microvmId && tab.status === 'connected' && (
              <span className="status-id" title={tab.microvmId}>{tab.microvmId.slice(-12)}</span>
            )}
          </div>

          <button className="toolbar-theme-btn" onClick={onToggleTheme} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}>
            {theme === 'dark' ? <IconSun width={14} height={14} /> : <IconMoon width={14} height={14} />}
          </button>
          </div>
        </div>
        {tab.description && (
          <div className="notebook-identity">
            <span className="notebook-description">{tab.description}</span>
          </div>
        )}
        </>
      )}

      {showSearch && (
        <div className="notebook-search-bar">
          <div className="notebook-search-field">
            <IconSearch width={13} height={13} className="notebook-search-icon" />
            <input
              ref={searchInputRef}
              className="notebook-search-input"
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.shiftKey ? searchPrev() : searchNext() }
                if (e.key === 'Escape') { setShowSearch(false); setSearchQuery(''); setSearchMatches([]) }
              }}
              placeholder="Find in notebook..."
              autoFocus
            />
            {searchQuery && (
              <span className="notebook-search-count">
                {searchMatches.length > 0
                  ? `${searchActiveIdx + 1} of ${searchMatches.length} in ${new Set(searchMatches.map(m => m.cellId)).size} cells`
                  : 'No results'}
              </span>
            )}
          </div>
          <div className="notebook-search-actions">
            <button className="notebook-search-nav" onClick={searchPrev} disabled={searchMatches.length === 0} title="Previous (Shift+Enter)">
              <IconChevronUp width={14} height={14} />
            </button>
            <button className="notebook-search-nav" onClick={searchNext} disabled={searchMatches.length === 0} title="Next (Enter)">
              <IconChevronDown width={14} height={14} />
            </button>
            <button className="notebook-search-close" onClick={() => { setShowSearch(false); setSearchQuery(''); setSearchMatches([]) }} title="Close (Esc)">
              <IconX width={14} height={14} />
            </button>
          </div>
        </div>
      )}

      <div className="notebook-body">
      <div className="cells-container">
        {cells.map((cell, index) => (
          <Cell
            key={cell.id}
            cell={cell}
            index={index}
            isConnected={tab.status === 'connected'}
            isActive={cell.id === activeCellId}
            isDragOver={cell.id === dragOverId}
            hasSearchMatch={searchMatchCellIds.has(cell.id)}
            onFocus={() => setActiveCellId(cell.id)}
            onExecute={() => executeCell(cell.id)}
            onInterrupt={interruptExecution}
            onCodeChange={(code) => updateCellCode(cell.id, code)}
            onAddBelow={(type) => addCellBelow(cell.id, type)}
            onInsertAbove={(summary) => {
              const cellAbove = index > 0 ? cells[index - 1] : null
              if (!cellAbove || cellAbove.type !== 'markdown') {
                setCells(prev => {
                  const newCells = [...prev]
                  // Format as markdown bold heading
                  const mdText = summary.startsWith('#') ? summary : `**${summary}**`
                  newCells.splice(index, 0, { id: Date.now(), type: 'markdown', code: mdText, output: null, error: null, html: null, image: null })
                  return newCells
                })
              }
            }}
            onSetAiExplanation={(explanation) => {
              setCells(prev => prev.map(c => c.id === cell.id ? { ...c, aiExplanation: explanation } : c))
            }}
            onTypeChange={(newType) => changeCellType(cell.id, newType)}
            onDelete={() => deleteCell(cell.id)}
            onDragStart={() => handleDragStart(cell.id)}
            onDragOver={() => handleDragOver(cell.id)}
            onDrop={() => handleDrop(cell.id)}
            onDragEnd={handleDragEnd}
            searchQuery={showSearch ? searchQuery : ''}
            searchActiveOccurrence={searchActiveOccurrenceMap[cell.id] ?? -1}
            notebookContext={cells}
            microvmId={tab.microvmId}
            microvmRealEndpoint={tab.microvmRealEndpoint}
            aiAvailable={aiAvailable}
          />
        ))}
        <div className="add-cell-row">
          <button className="add-cell-btn" onClick={() => addCellAtEnd('code')}>
            + Code
          </button>
          <button className="add-cell-btn" onClick={() => addCellAtEnd('markdown')}>
            + Text
          </button>
        </div>
      </div>

      </div>
    </div>
  )
}
