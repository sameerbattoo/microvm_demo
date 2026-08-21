import { useState, useEffect, useMemo, useRef } from 'react'

/**
 * useNotebookSearch — find-in-notebook (Cmd+F) state, match computation, and
 * navigation. Extracted from Notebook.jsx.
 *
 * @param {Array} cells - the notebook cells (searched by their `code`)
 * @param {Function} setActiveCellId - focus/scroll a cell when a match is selected
 *
 * Returns search state + setters, next/prev navigation, and the two derived
 * lookups the cell list consumes (searchMatchCellIds, searchActiveOccurrenceMap).
 */
export function useNotebookSearch(cells, setActiveCellId, enabled = true) {
  const [showSearch, setShowSearch] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchMatches, setSearchMatches] = useState([]) // [{cellId, pos}]
  const [searchActiveIdx, setSearchActiveIdx] = useState(0)
  const searchInputRef = useRef(null)

  const scrollToCellId = (cellId) => {
    setTimeout(() => {
      const el = document.querySelector(`[data-cell-id="${cellId}"]`)
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 50)
  }

  // When notebook find is disabled (e.g. App view), make sure any open search
  // bar is closed — the browser's native Cmd+F then searches the rendered app.
  useEffect(() => {
    if (!enabled && showSearch) {
      setShowSearch(false)
      setSearchQuery('')
      setSearchMatches([])
    }
  }, [enabled])  // eslint-disable-line react-hooks/exhaustive-deps

  // Cmd+F to open search — only when enabled (notebook view). In App view we let
  // the browser's native find run over the rendered content instead.
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (!enabled) return
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
  }, [showSearch, enabled])

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

  return {
    showSearch,
    setShowSearch,
    searchQuery,
    setSearchQuery,
    searchMatches,
    setSearchMatches,
    searchActiveIdx,
    searchInputRef,
    searchNext,
    searchPrev,
    searchMatchCellIds,
    searchActiveOccurrenceMap,
  }
}
