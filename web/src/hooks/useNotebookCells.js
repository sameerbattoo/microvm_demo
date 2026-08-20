import { useState, useEffect, useRef, useCallback } from 'react'
import { PROXY_URL } from '../config'

/**
 * useNotebookCells — owns the notebook's cell state and everything that mutates
 * or runs it: cell CRUD, drag-to-reorder, tab persistence/sync, and the full
 * execution pipeline (executeCell/executeAllCells/runActive/interrupt + the
 * sequential queue, the outline "run from"/"run selected" listeners, variable
 * fetching, and metrics-on-execution). Extracted from Notebook.jsx as one
 * cohesive unit because these pieces share refs (prevCellsRef, executionQueue)
 * and would be fragile to split.
 */

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
  // Extract table/source name from FROM clause (for external sources only)
  const fromMatch = sql.match(/\bFROM\s+dynamodb\."?([a-zA-Z_][\w\-]*)"?/i)
    || sql.match(/\bFROM\s+'\/tmp\/([^']+)'/i)
    || sql.match(/\bFROM\s+read_(?:csv|json|parquet)\('[^']*\/([^'/]+)'\)/i)
    || sql.match(/\bFROM\s+[a-zA-Z_]\w*\.([a-zA-Z_]\w*)/i)
  if (fromMatch) {
    const raw = fromMatch[1] || 'result'
    const cleaned = raw.replace(/\.\w+$/, '').replace(/[^a-zA-Z0-9_]/g, '_').replace(/^_+|_+$/g, '')
    if (cleaned && /^[a-zA-Z_]/.test(cleaned)) return cleaned
  }
  // For queries on in-memory DataFrames (FROM df_name), use generic 'result'
  // to avoid overwriting the source DataFrame
  return 'result'
}

export function createCell(type = 'code') {
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

export function useNotebookCells({ tab, onUpdateTab, onMarkVmRunning, onRefreshMetrics }) {
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
  const [activeCellId, setActiveCellId] = useState(null)
  const [dragOverId, setDragOverId] = useState(null)
  const [variables, setVariables] = useState({})
  const [isExecuting, setIsExecuting] = useState(false)
  const [runProgress, setRunProgress] = useState(null) // { current: N, total: M } during Run All

  const prevCellsRef = useRef(cells)
  const draggedCellRef = useRef(null)
  const executionQueue = useRef([])
  const tagSuggestedRef = useRef(false)
  const prevExecutingRef = useRef(false)

  // Fetch metrics once when execution starts and once when it ends (for burst cost tracking).
  // DO NOT poll continuously — it keeps the VM from suspending.
  useEffect(() => {
    if (isExecuting && !prevExecutingRef.current && onRefreshMetrics) {
      onRefreshMetrics() // Fetch on execution start
    }
    if (!isExecuting && prevExecutingRef.current && onRefreshMetrics) {
      // Fetch once after execution ends (delayed to capture final burst state)
      setTimeout(() => onRefreshMetrics(), 1000)
    }
    prevExecutingRef.current = isExecuting
  }, [isExecuting, onRefreshMetrics])

  // Scroll new cell into view when added
  useEffect(() => {
    if (activeCellId) {
      const el = document.querySelector(`[data-cell-id="${activeCellId}"]`)
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [cells.length])

  // Persist cells to tab state (survives tab switches)
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
      // Notify the Outline panel so it can highlight the corresponding row
      // (helps navigate long notebooks — clicking a cell selects it in the outline).
      window.dispatchEvent(new CustomEvent('notebook-active-cell', { detail: { cellId: activeCellId } }))
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
      // Scroll to the new/updated cell after render
      setTimeout(() => {
        const cells = document.querySelectorAll('.cell')
        const lastCell = cells[cells.length - 1]
        if (lastCell) lastCell.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }, 100)
    }
    window.addEventListener('insert-code', handler)
    return () => window.removeEventListener('insert-code', handler)
  }, [])

  const fetchVariables = useCallback(async () => {
    if (!tab.microvmEndpoint || tab.status !== 'connected') return
    try {
      const headers = { 'Content-Type': 'application/json' }
      if (tab.sessionId) {
        headers['X-Session-Id'] = tab.sessionId
      }
      const resp = await fetch(`${tab.microvmEndpoint}/variables`, { headers })
      if (resp.ok) {
        const data = await resp.json()
        setVariables(data.variables || {})
        onUpdateTab({ _variables: data.variables || {} })
      }
    } catch {}
  }, [tab.microvmEndpoint, tab.sessionId, tab.status])

  // Re-fetch the variable namespace on demand (e.g. after the Variables panel
  // deletes a variable from the session).
  useEffect(() => {
    const handler = () => fetchVariables()
    window.addEventListener('refresh-variables', handler)
    return () => window.removeEventListener('refresh-variables', handler)
  }, [fetchVariables])

  const executeCell = useCallback(async (cellId) => {
    // If no VM linked at all, can't execute
    if (!tab.microvmId) return

    // Ensure we have an endpoint (might be missing after page refresh)
    let endpoint = tab.microvmEndpoint
    if (!endpoint) {
      endpoint = `${PROXY_URL}/proxy`
      // Check if VM exists in instances
      try {
        const instResp = await fetch(`${PROXY_URL}/instances`)
        const instData = await instResp.json()
        const inst = instData.instances?.[tab.microvmId]
        if (inst?.endpoint) {
          onUpdateTab({ microvmEndpoint: endpoint, status: 'connected' })
        }
      } catch {}
    }

    if (!endpoint || (tab.status !== 'connected' && tab.status !== 'launching')) {
      // Auto-restore: if VM was terminated but has a checkpoint, auto-launch + restore
      if (tab.sessionSaved && tab.sessionId && !tab._autoRestoreFailed) {
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
            onUpdateTab({ status: 'disconnected', _autoRestoreFailed: true })
            setCells(prev => prev.map(c =>
              c.id === cellId ? { ...c, status: 'error', error: '⚠️ Failed to auto-restore session. Use the connection panel to restore manually.' } : c
            ))
          }
        } catch (err) {
          onUpdateTab({ status: 'disconnected', _autoRestoreFailed: true })
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
      if (tab.sessionId) {
        headers['X-Session-Id'] = tab.sessionId
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
  }, [tab.microvmEndpoint, tab.microvmId, tab.sessionId, tab.status, tab.tag, tab.name, tab.description, isExecuting])

  const executeAllCells = useCallback(async () => {
    if (!tab.microvmId) return
    const runnableCells = cells.filter(c => c.code.trim() && c.type !== 'markdown')
    const total = runnableCells.length

    // Signal the Outline activity-bar icon: open the panel + pulse green while running.
    window.dispatchEvent(new CustomEvent('outline-run-status', { detail: 'running' }))

    const ranIds = []
    for (let i = 0; i < runnableCells.length; i++) {
      setRunProgress({ current: i + 1, total })
      await executeCell(runnableCells[i].id)
      ranIds.push(runnableCells[i].id)
    }
    setRunProgress(null)

    // After the run, check the latest cell statuses for any error. Let React flush the
    // last executeCell's setCells into prevCellsRef first (short yield), then read the
    // freshest snapshot so we see the statuses set during the run, not this closure's
    // stale `cells`.
    setTimeout(() => {
      const latest = prevCellsRef.current || cells
      const anyError = latest.some(c => ranIds.includes(c.id) && c.status === 'error')
      // Red persists so the user can spot the failed cell in the Outline; green clears.
      window.dispatchEvent(new CustomEvent('outline-run-status', { detail: anyError ? 'error' : 'clear' }))
    }, 120)
  }, [cells, tab.microvmEndpoint, tab.status, executeCell])

  // Listen for "Run from cell" events from the outline panel
  useEffect(() => {
    const handleRunFrom = async (e) => {
      const { cellIdx } = e.detail || {}
      if (cellIdx == null || !tab.microvmId) return
      const cellsToRun = cells.slice(cellIdx)
      for (const cell of cellsToRun) {
        if (cell.code.trim() && cell.type !== 'markdown') {
          await executeCell(cell.id)
        }
      }
    }
    window.addEventListener('notebook-run-from-cell', handleRunFrom)
    return () => window.removeEventListener('notebook-run-from-cell', handleRunFrom)
  }, [cells, tab.microvmId, executeCell])

  // Listen for "Run selected cells" events from the outline panel
  useEffect(() => {
    const handleRunCells = async (e) => {
      const { cellIndices } = e.detail || {}
      if (!cellIndices || !tab.microvmId) return
      for (const idx of cellIndices) {
        const cell = cells[idx]
        if (cell && cell.code.trim() && cell.type !== 'markdown') {
          await executeCell(cell.id)
        }
      }
    }
    window.addEventListener('notebook-run-cells', handleRunCells)
    return () => window.removeEventListener('notebook-run-cells', handleRunCells)
  }, [cells, tab.microvmId, executeCell])

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
    if (tab.sessionId) {
      headers['X-Session-Id'] = tab.sessionId
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
  }, [tab.microvmEndpoint, tab.microvmId, tab.sessionId, tab.status])

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

  return {
    cells,
    setCells,
    activeCellId,
    setActiveCellId,
    dragOverId,
    variables,
    isExecuting,
    runProgress,
    fetchVariables,
    executeCell,
    executeAllCells,
    runActiveCell,
    interruptExecution,
    clearAllOutputs,
    deleteActiveCell,
    updateCellCode,
    updateCellOutputVar,
    addCellBelow,
    addCellAtEnd,
    changeCellType,
    handleDragStart,
    handleDragOver,
    handleDrop,
    handleDragEnd,
    deleteCell,
  }
}
