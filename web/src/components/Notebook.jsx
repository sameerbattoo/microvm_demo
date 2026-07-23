import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import Cell from './Cell'
import ConnectionPanel from './ConnectionPanel'
import { IconPlus, IconPlayAll, IconPlay, IconTrash, IconSave, IconFolderOpen, IconStop, IconFile, IconSearch, IconChevronUp, IconChevronDown, IconX, IconZap, IconSun, IconMoon, IconCode, IconNotebook, IconEraser, IconDatabase } from './Icons'
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

// Derive default output variable name from SQL query
function _deriveSqlVarName(sql) {
  if (!sql || !sql.trim()) return 'result'
  const fromMatch = sql.match(/\bFROM\s+(?:dynamodb\.)?"?([a-zA-Z_][\w\-]*)"?/i)
    || sql.match(/\bFROM\s+'\/tmp\/([^']+)'/i)
    || sql.match(/\bFROM\s+read_(?:csv|json|parquet)\('[^']*\/([^'/]+)'\)/i)
    || sql.match(/\bFROM\s+([a-zA-Z_]\w*\.)?([a-zA-Z_]\w*)/i)
  if (fromMatch) {
    const raw = fromMatch[fromMatch.length - 1] || fromMatch[1] || 'result'
    const cleaned = raw.replace(/\.\w+$/, '').replace(/[^a-zA-Z0-9_]/g, '_').replace(/^_+|_+$/g, '')
    if (cleaned && /^[a-zA-Z_]/.test(cleaned)) return cleaned
  }
  return 'result'
}

function createCell(type = 'code') {
  return {
    id: nextCellId++,
    type,  // 'code' | 'markdown' | 'sql'
    code: '',
    output: null,
    error: null,
    html: null,
    image: null,
    status: 'idle', // idle | running | success | error
    executionNumber: null,
    executionTime: null,
    lastExecutedCode: null, // snapshot of code at execution time (for staleness detection)
    outputVariable: type === 'sql' ? 'result' : null, // SQL cells store result as a named DataFrame
  }
}

export default function Notebook({ tab, instances = {}, onUpdateTab, onMarkVmRunning, onNewNotebook, onCloseTab, onRefreshMetrics, attachedIds = [], theme, onToggleTheme, aiAvailable = false }) {
  const [cells, setCells] = useState(() => {
    // Restore cells from tab state (persists across tab switches)
    if (tab._cells && Array.isArray(tab._cells) && tab._cells.length > 0) {
      // Ensure all cells have unique IDs (fix for cells loaded from API/localStorage without IDs)
      const seen = new Set()
      return tab._cells.map(c => {
        let id = c.id
        if (!id || seen.has(id)) {
          id = nextCellId++
        }
        seen.add(id)
        return { ...c, id }
      })
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
  const [isAnnotating, setIsAnnotating] = useState(false)
  const [showExportMenu, setShowExportMenu] = useState(false)
  const [saveMenuPos, setSaveMenuPos] = useState(null)
  const [exportMenuPos, setExportMenuPos] = useState(null)

  // Sync connection panel visibility when tab status changes
  useEffect(() => {
    if (tab.status === 'connected') {
      setShowConnection(false)
    }
  }, [tab.status])

  // Auto-show connection panel when VM is terminated (disappeared from instances)
  useEffect(() => {
    if (tab.microvmId && Object.keys(instances).length > 0 && !instances[tab.microvmId]) {
      setShowConnection(true)
    }
  }, [tab.microvmId, instances])
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
      const { code, type: cellType } = e.detail
      if (!code) return
      const insertType = cellType || 'code'
      setCells(prev => {
        const lastCell = prev[prev.length - 1]
        if (lastCell && !lastCell.code.trim() && lastCell.type === insertType) {
          // Use the last empty cell if same type
          return prev.map((c, i) => i === prev.length - 1 ? { ...c, code } : c)
        }
        // Add a new cell
        return [...prev, {
          id: nextCellId++,
          type: insertType,
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
    // If no VM linked at all, can't execute
    if (!tab.microvmId) return

    // Ensure we have an endpoint (might be missing after page refresh)
    let endpoint = tab.microvmEndpoint
    let realEndpoint = tab.microvmRealEndpoint
    if (!endpoint) {
      endpoint = `${PROXY_URL}/proxy`
      // Discover real endpoint from instances
      try {
        const instResp = await fetch(`${PROXY_URL}/instances`)
        const instData = await instResp.json()
        const inst = instData.instances?.[tab.microvmId]
        if (inst?.endpoint) {
          realEndpoint = inst.endpoint
          onUpdateTab({ microvmEndpoint: endpoint, microvmRealEndpoint: realEndpoint, status: 'connected' })
        }
      } catch {}
    }

    if (!realEndpoint) {
      // Auto-restore: if VM was terminated but has a checkpoint, auto-launch + restore
      if (tab.sessionSaved && tab.sessionId) {
        // Set a guard state to prevent polling from interfering
        onUpdateTab({ status: 'launching' })
        setCells(prev => prev.map(c =>
          c.id === cellId ? { ...c, status: 'running', output: null, error: null } : c
        ))
        try {
          const resp = await fetch(`${PROXY_URL}/launch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              notebookName: tab.name || 'Restored',
              memoryMiB: tab.microvmMemory || 2048,
              idleTimeoutSeconds: tab.idleTimeoutSeconds || 60,
              maxDurationSeconds: tab.maxDurationSeconds || 14400,
              checkpointEnabled: true,
              sessionId: tab.sessionId,
              restoreFromSession: tab.sessionId,
            }),
          })
          if (resp.ok) {
            const data = await resp.json()
            onUpdateTab({
              microvmId: data.microvmId,
              microvmEndpoint: `${PROXY_URL}/proxy`,
              microvmRealEndpoint: data.endpoint,
              microvmMemory: tab.microvmMemory || 2048,
              status: 'connected',
              mode: 'microvm',
              sessionSaved: false,
              checkpointEnabled: true,
              sessionId: data.sessionId,
            })
            // Retry the cell execution after restore
            setCells(prev => prev.map(c =>
              c.id === cellId ? { ...c, status: 'idle', output: '♻️ Session restored — re-run this cell.', error: null } : c
            ))
          } else {
            onUpdateTab({ status: 'disconnected' })
            setCells(prev => prev.map(c =>
              c.id === cellId ? { ...c, status: 'error', error: '⚠️ Failed to auto-restore session. Use the connection panel to restore manually.' } : c
            ))
          }
        } catch (err) {
          onUpdateTab({ status: 'disconnected' })
          setCells(prev => prev.map(c =>
            c.id === cellId ? { ...c, status: 'error', error: `⚠️ Auto-restore failed: ${err.message}` } : c
          ))
        }
      }
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
        // Route SQL cells to /execute-sql, code cells to /execute
        const isSql = cell.type === 'sql'
        const url = isSql
          ? `${tab.microvmEndpoint}/execute-sql`
          : `${tab.microvmEndpoint}/execute`
        const body = isSql
          ? JSON.stringify({ sql: cell.code, output_variable: cell.outputVariable || _deriveSqlVarName(cell.code) })
          : JSON.stringify({ code: cell.code })

        const response = await fetch(url, {
          method: 'POST',
          headers,
          body,
        })

        const text = await response.text()
        let result
        try {
          result = JSON.parse(text)
        } catch {
          setCells(prev => prev.map(c =>
            c.id === cellId
              ? { ...c, status: 'error', error: '⚠️ Sandbox unresponsive — it may have crashed or been terminated. Click "Terminate" in the MicroVMs panel and launch a new one.' }
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

        // If execution succeeded and VM was suspended, immediately mark it as RUNNING
        // (don't wait for 10s poll — this is the ONE exception to poll-only updates)
        if (result.success && tab.microvmId && onMarkVmRunning) {
          onMarkVmRunning(tab.microvmId)
        }
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
      // Refresh variable explorer and metrics after execution
      fetchVariables()
      if (onRefreshMetrics) onRefreshMetrics()
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
    if (!tab.microvmId) return

    for (const cell of cells) {
      if (cell.code.trim()) {
        await executeCell(cell.id)
      }
    }
  }, [cells, tab.microvmEndpoint, tab.status, executeCell])

  const clearAllOutputs = useCallback(() => {
    setCells(prev => prev.map(c => c.type === 'markdown' ? c : {
      ...c, output: null, error: null, html: null, image: null, executionNumber: null, executionTime: null, status: 'idle'
    }))
  }, [])

  const runActiveCell = useCallback(() => {
    if (activeCellId) {
      executeCell(activeCellId)
    }
  }, [activeCellId, executeCell])

  const interruptExecution = useCallback(async () => {
    if (!tab.microvmEndpoint || !tab.microvmId) return

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

  const updateCellOutputVar = useCallback((cellId, outputVariable) => {
    setCells(prev => prev.map(c => c.id === cellId ? { ...c, outputVariable } : c))
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
    // Only annotate cells that don't already have an AI explanation AND don't have a markdown summary above
    const codeCells = cells.filter((c, idx) => {
      if (c.type === 'markdown' || !c.code?.trim()) return false
      if (c.aiExplanation) return false
      // Check if the cell above is already a markdown annotation
      if (idx > 0 && cells[idx - 1].type === 'markdown') return false
      return true
    })
    if (codeCells.length === 0) return

    setIsAnnotating(true)
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
              const descLine = data.description ? `\n\n${data.description}` : ''
              const newCells = [...prev]
              newCells.splice(idx, 0, { id: Date.now() + Math.random(), type: 'markdown', code: mdText + descLine, output: null, error: null, html: null, image: null })
              return newCells
            })
          }
        }
      } catch {}
    }
    setIsAnnotating(false)
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
        outputVariable: c.outputVariable || null,
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

  const exportNotebookHTML = useCallback(() => {
    const nbName = tab.name || 'Notebook'
    let html = `<html><head><meta charset="UTF-8"><title>${nbName}</title><style>body{font-family:system-ui;padding:20px;max-width:1000px;margin:0 auto;background:#1a1a2e;color:#e0e0e0}h1{color:#89b4fa}h2{color:#cdd6f4;font-size:16px;margin-top:24px}.desc{color:#888;margin-bottom:24px}.cell{margin:16px 0;border:1px solid #333;border-radius:8px;overflow:hidden}.cell-header{background:#2a2a4a;padding:8px 12px;font-size:11px;color:#888;display:flex;justify-content:space-between}details{margin:0}summary{padding:8px 12px;cursor:pointer;font-weight:600;font-size:12px;color:#a6adc8;background:#1e2a3a}pre{margin:0;padding:12px;background:#0d1117;overflow-x:auto;font-size:13px;color:#e0e0e0}table{border-collapse:collapse;width:100%;margin:8px 0}th,td{border:1px solid #444;padding:6px 10px;text-align:left;font-size:12px}th{background:#2a2a4a}.output{padding:12px;background:#11111b}.ai-note{padding:8px 12px;background:#1e2a3a;border-top:1px solid #333;font-size:12px;color:#a6adc8;font-style:italic}img{max-width:100%}.error{color:#f38ba8}footer{text-align:center;padding:24px;color:#555;font-size:11px;border-top:1px solid #333;margin-top:32px}</style></head><body>`
    html += `<h1>${nbName}</h1>`
    if (tab.description) html += `<p class="desc">${tab.description}</p>`
    html += `<p style="color:#666;font-size:12px">Exported: ${new Date().toLocaleString()} · ${cells.length} cells</p>`
    cells.forEach((cell, i) => {
      const cellType = cell.type || 'code'
      html += `<div class="cell">`
      html += `<div class="cell-header"><span>${cellType === 'markdown' ? 'Text' : cellType === 'sql' ? `SQL — Cell ${i + 1}` : `Code — Cell ${i + 1}`}</span>${cell.executionNumber ? `<span>[${cell.executionNumber}]</span>` : ''}</div>`
      html += `<details open><summary>${cellType === 'sql' ? 'SQL' : 'Code'}</summary><pre>${(cell.code || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre></details>`
      if (cell.output || cell.html || cell.image || cell.error) {
        html += `<div class="output">`
        if (cell.output) html += `<pre>${cell.output}</pre>`
        if (cell.html) html += cell.html
        if (cell.image) html += `<img src="${cell.image}" alt="Plot"/>`
        if (cell.error) html += `<pre class="error">${cell.error}</pre>`
        html += `</div>`
      }
      if (cell.aiExplanation) html += `<div class="ai-note">✨ ${cell.aiExplanation}</div>`
      html += `</div>`
    })
    html += `<footer><strong>Lambda MicroVM Notebook</strong><br>Developed by the AWS Startup SA Team<br>&copy; ${new Date().getFullYear()} Amazon Web Services, Inc.</footer></body></html>`
    const blob = new Blob([html], { type: 'text/html' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `${nbName.replace(/\s+/g, '-')}.html`; a.click()
    URL.revokeObjectURL(url)
  }, [tab.name, tab.description, cells])

  const exportNotebookMD = useCallback(() => {
    const nbName = tab.name || 'Notebook'
    let md = `# ${nbName}\n\n`
    if (tab.description) md += `> ${tab.description}\n\n`
    md += `*Exported: ${new Date().toLocaleString()} · ${cells.length} cells*\n\n---\n\n`
    cells.forEach((cell, i) => {
      const cellType = cell.type || 'code'
      md += `## ${cellType === 'markdown' ? 'Text' : cellType === 'sql' ? `SQL — Cell ${i + 1}` : `Code — Cell ${i + 1}`}${cell.executionNumber ? ` [${cell.executionNumber}]` : ''}\n\n`
      md += `<details><summary>${cellType === 'sql' ? 'SQL' : 'Code'}</summary>\n\n\`\`\`${cellType === 'sql' ? 'sql' : 'python'}\n${cell.code || ''}\n\`\`\`\n</details>\n\n`
      if (cell.output) md += `**Output:**\n\`\`\`\n${cell.output}\n\`\`\`\n\n`
      if (cell.html) md += `*(DataFrame table — view HTML export for full rendering)*\n\n`
      if (cell.image) md += `![Plot](plot-cell-${i + 1}.png)\n\n`
      if (cell.error) md += `**Error:** \`${cell.error}\`\n\n`
      if (cell.aiExplanation) md += `> ✨ *${cell.aiExplanation}*\n\n`
      md += `---\n\n`
    })
    md += `\n*Lambda MicroVM Notebook — Developed by the AWS Startup SA Team*\n`
    const blob = new Blob([md], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `${nbName.replace(/\s+/g, '-')}.md`; a.click()
    URL.revokeObjectURL(url)
  }, [tab.name, tab.description, cells])

  const saveAsIPYNB = useCallback(() => {
    const nbName = tab.name || 'Notebook'
    const ipynb = {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {
        kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
        language_info: { name: 'python', version: '3.11' },
      },
      cells: cells.map(cell => {
        const cellType = cell.type === 'markdown' ? 'markdown' : 'code'
        // For SQL cells exported as ipynb code cells, prepend %%sql magic
        const codeContent = cell.type === 'sql' ? `%%sql\n${cell.code || ''}` : (cell.code || '')
        const source = codeContent.split('\n').map((line, i, arr) => i < arr.length - 1 ? line + '\n' : line)
        const outputs = []
        if (cellType === 'code') {
          if (cell.output) {
            outputs.push({ output_type: 'stream', name: 'stdout', text: cell.output.split('\n').map((l, i, a) => i < a.length - 1 ? l + '\n' : l) })
          }
          if (cell.error) {
            outputs.push({ output_type: 'stream', name: 'stderr', text: [cell.error] })
          }
        }
        return {
          cell_type: cellType,
          metadata: {},
          source,
          ...(cellType === 'code' ? { outputs, execution_count: cell.executionNumber || null } : {}),
        }
      }),
    }
    const blob = new Blob([JSON.stringify(ipynb, null, 1)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `${nbName.replace(/\s+/g, '_')}.ipynb`; a.click()
    URL.revokeObjectURL(url)
    setSaveMenuPos(null)
  }, [tab.name, cells])

  const loadNotebook = useCallback(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json,.notebook.json,.ipynb'
    input.onchange = (e) => {
      const file = e.target.files?.[0]
      if (!file) return

      const reader = new FileReader()
      reader.onload = (ev) => {
        try {
          const data = JSON.parse(ev.target.result)

          // Detect Jupyter .ipynb format
          if (data.nbformat && data.cells && Array.isArray(data.cells)) {
            // Parse Jupyter notebook
            const cells = data.cells
              .filter(c => c.cell_type === 'code' || c.cell_type === 'markdown')
              .map(c => {
                const code = Array.isArray(c.source) ? c.source.join('') : (c.source || '')
                // Detect %%sql magic → SQL cell type
                let cellType = c.cell_type === 'markdown' ? 'markdown' : 'code'
                let cellCode = code
                if (cellType === 'code' && code.trimStart().startsWith('%%sql')) {
                  cellType = 'sql'
                  cellCode = code.trimStart().replace(/^%%sql\s*\n?/, '')
                }
                // Extract text output if available
                let output = null
                if (c.outputs && c.outputs.length > 0) {
                  const textOut = c.outputs.find(o => o.output_type === 'stream' || o.output_type === 'execute_result')
                  if (textOut) {
                    const text = textOut.text || textOut.data?.['text/plain']
                    output = Array.isArray(text) ? text.join('') : text || null
                  }
                }
                return {
                  type: cellType,
                  code: cellCode,
                  output,
                  error: null,
                  html: null,
                  image: null,
                }
              })

            const name = file.name.replace('.ipynb', '')
            window.dispatchEvent(new CustomEvent('open-notebook', {
              detail: { name, description: `Imported from Jupyter: ${file.name}`, tag: null, cells }
            }))
            return
          }

          // Our native .notebook.json format
          if (data.cells && Array.isArray(data.cells)) {
            window.dispatchEvent(new CustomEvent('open-notebook', {
              detail: {
                name: data.name || file.name.replace('.notebook.json', '').replace('.json', ''),
                description: data.description || '',
                tag: data.tag || null,
                cells: data.cells,
              }
            }))
          }
        } catch {
          alert('Invalid notebook file. Supported formats: .notebook.json, .ipynb')
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

  // Derive whether the linked VM is alive (exists in instances) — used for toolbar/cell disabled state
  const vmAlive = tab.microvmId && !!instances[tab.microvmId]

  return (
    <>
    <div className="notebook">
      {showConnection && tab.status !== 'connecting' && (
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
            <span className="toolbar-notebook-name" title={tab.name}>{tab.name || 'Untitled'}</span>
          </div>

          <span className="toolbar-divider" />

          <div className="toolbar-group toolbar-group-cells" title="Cell actions">
            <button
              className="toolbar-btn toolbar-btn-run"
              onClick={runActiveCell}
              disabled={!activeCellId || isExecuting || !vmAlive}
              title="Run active cell (Shift+Enter)"
            >
              <IconPlay width={14} height={14} />
            </button>
            <button
              className="toolbar-btn toolbar-btn-stop"
              onClick={interruptExecution}
              disabled={!cells.some(c => c.status === 'running')}
              title="Stop execution"
            >
              <IconStop width={14} height={14} />
            </button>
            <button
              className="toolbar-btn toolbar-btn-run-all"
              onClick={executeAllCells}
              disabled={isExecuting || !vmAlive}
              title="Execute all cells sequentially"
            >
              <IconPlayAll width={14} height={14} />
            </button>
            <button className="toolbar-btn" onClick={() => addCellAtEnd('code')} title="Add code cell">
              <IconCode width={14} height={14} />
            </button>
            <button className="toolbar-btn" onClick={() => addCellAtEnd('sql')} title="Add SQL cell">
              <IconDatabase width={14} height={14} />
            </button>
            <button className="toolbar-btn" onClick={() => addCellAtEnd('markdown')} title="Add text/markdown cell">
              <span style={{fontWeight: 700, fontSize: '13px'}}>M</span>
            </button>
            <button
              className="toolbar-btn toolbar-btn-delete"
              onClick={deleteActiveCell}
              disabled={!activeCellId}
              title="Delete active cell"
            >
              <IconTrash width={14} height={14} />
            </button>
          </div>

          <span className="toolbar-divider" />

          <div className="toolbar-group toolbar-group-notebook" title="Notebook actions">
            {onNewNotebook && (
              <button className="toolbar-btn" onClick={onNewNotebook} title="New notebook">
                <IconNotebook width={14} height={14} />
              </button>
            )}
            <button className="toolbar-btn toolbar-btn-open" onClick={loadNotebook} title="Open notebook">
              <IconFolderOpen width={14} height={14} />
            </button>
            <button className="toolbar-btn toolbar-btn-save" onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect()
              setSaveMenuPos(saveMenuPos ? null : { top: rect.bottom + 4, left: rect.left })
            }} title="Save notebook">
              <IconSave width={14} height={14} />
            </button>
            <button className="toolbar-btn" onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect()
              setExportMenuPos(exportMenuPos ? null : { top: rect.bottom + 4, left: rect.left })
            }} title="Export notebook">
              <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            </button>
            <button className="toolbar-btn toolbar-btn-find" onClick={() => { setShowSearch(true); setTimeout(() => searchInputRef.current?.focus(), 50) }} title="Find in notebook (Cmd+F)">
              <IconSearch width={14} height={14} />
            </button>
            {aiAvailable && (
              <button
                className={`toolbar-btn toolbar-btn-autodoc ${isAnnotating ? 'toolbar-btn-loading' : ''}`}
                onClick={autoDocumentNotebook}
                disabled={!tab.microvmEndpoint || tab.status !== 'connected' || isAnnotating}
                title="Auto-annotate all cells with AI explanations"
              >
                {isAnnotating ? <span className="toolbar-spinner" /> : <IconZap width={14} height={14} />}
              </button>
            )}
            <button
              className="toolbar-btn"
              onClick={clearAllOutputs}
              disabled={!cells.some(c => c.output || c.error || c.html || c.image)}
              title="Clear all cell outputs"
            >
              <IconEraser width={14} height={14} />
            </button>
            {onCloseTab && (
              <button className="toolbar-btn toolbar-btn-close" onClick={() => onCloseTab(tab.id)} title="Close notebook">
                <IconX width={14} height={14} />
              </button>
            )}
          </div>

          </div>

          <div className="toolbar-pinned">
          {(() => {
            // VM state derived directly from instances (single source of truth)
            const vmState = tab.microvmId && instances[tab.microvmId] ? instances[tab.microvmId].state : null
            const isSuspended = vmState === 'SUSPENDED'
            const isTerminated = tab.microvmId && !instances[tab.microvmId]
            const isUnhealthy = tab.microvmId && instances[tab.microvmId]?.unhealthy
            return (
              <div className="toolbar-status" onClick={() => setShowConnection(true)} title="Click to manage connection">
                <span className={`status-dot ${isUnhealthy ? 'status-terminated' : isSuspended ? 'status-suspended' : isTerminated ? 'status-terminated' : `status-${tab.status}`}`} />
                <span className="status-text">
                  {isUnhealthy ? 'Unhealthy' :
                   isSuspended ? 'Suspended' :
                   isTerminated ? 'Terminated' :
                   tab.status === 'connected' ? 'Running' :
                   tab.status === 'connecting' ? 'Connecting...' :
                   tab.status === 'launching' ? 'Launching...' :
                   'Disconnected'}
                </span>
                {tab.microvmId && tab.status === 'connected' && (
                  <span className="status-id" title={tab.microvmId}>{tab.microvmId.slice(-12)}</span>
                )}
              </div>
            )
          })()}

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
            isConnected={vmAlive}
            isActive={cell.id === activeCellId}
            isDragOver={cell.id === dragOverId}
            hasSearchMatch={searchMatchCellIds.has(cell.id)}
            onFocus={() => setActiveCellId(cell.id)}
            onExecute={() => executeCell(cell.id)}
            onInterrupt={interruptExecution}
            onCodeChange={(code) => updateCellCode(cell.id, code)}
            onOutputVarChange={(v) => updateCellOutputVar(cell.id, v)}
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
            onClearOutput={() => setCells(prev => prev.map(c => c.id === cell.id ? { ...c, output: null, error: null, html: null, image: null, executionNumber: null, executionTime: null, status: 'idle' } : c))}
            onDragStart={() => handleDragStart(cell.id)}
            onDragOver={() => handleDragOver(cell.id)}
            onDrop={() => handleDrop(cell.id)}
            onDragEnd={handleDragEnd}
            searchQuery={showSearch ? searchQuery : ''}
            searchActiveOccurrence={searchActiveOccurrenceMap[cell.id] ?? -1}
            notebookContext={cells}
            notebookName={tab.name}
            microvmId={tab.microvmId}
            microvmRealEndpoint={tab.microvmRealEndpoint}
            aiAvailable={aiAvailable}
          />
        ))}
        <div className="add-cell-row">
          <button className="add-cell-btn" onClick={() => addCellAtEnd('code')}>
            + Code
          </button>
          <button className="add-cell-btn" onClick={() => addCellAtEnd('sql')}>
            + SQL
          </button>
          <button className="add-cell-btn" onClick={() => addCellAtEnd('markdown')}>
            + Text
          </button>
        </div>
      </div>

      </div>
    </div>
    {saveMenuPos && createPortal(
      <div className="toolbar-portal-menu" style={{ position: 'fixed', top: saveMenuPos.top, left: saveMenuPos.left, zIndex: 9999 }}>
        <div className="toolbar-portal-backdrop" onClick={() => setSaveMenuPos(null)} />
        <div className="toolbar-portal-options">
          <button onClick={() => { saveNotebook(); setSaveMenuPos(null) }}>Native (.notebook.json)</button>
          <button onClick={saveAsIPYNB}>Jupyter (.ipynb)</button>
        </div>
      </div>,
      document.body
    )}
    {exportMenuPos && createPortal(
      <div className="toolbar-portal-menu" style={{ position: 'fixed', top: exportMenuPos.top, left: exportMenuPos.left, zIndex: 9999 }}>
        <div className="toolbar-portal-backdrop" onClick={() => setExportMenuPos(null)} />
        <div className="toolbar-portal-options">
          <button onClick={() => { exportNotebookHTML(); setExportMenuPos(null) }}>HTML</button>
          <button onClick={() => { exportNotebookMD(); setExportMenuPos(null) }}>Markdown</button>
        </div>
      </div>,
      document.body
    )}
    </>
  )
}
