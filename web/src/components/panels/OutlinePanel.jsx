import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import { IconX, IconNotebook, IconEraser, IconChevronDown, IconChevronRight, IconLoader } from '../Icons'

export default function OutlinePanel({
  cells,
  activeTab,
  onScrollToCell,
  onReorderCells,
  onReorderCellIds,
  onRunFromCell,
  onDeleteCells,
  onRunCells,
  onClearOutputs,
  onClose,
}) {
  const [outlineSearch, setOutlineSearch] = useState('')
  const [outlineDragId, setOutlineDragId] = useState(null)
  const [outlineDragOverId, setOutlineDragOverId] = useState(null)
  const [collapsedSections, setCollapsedSections] = useState(new Set())
  const [selectMode, setSelectMode] = useState(false)
  const [selectedCells, setSelectedCells] = useState(new Set())
  // Pending delete confirmation: { ids: string[], fromBulk: boolean } | null
  const [pendingDelete, setPendingDelete] = useState(null)
  // Active cell (scroll-sync): id of the cell currently most-visible in the viewport
  const [activeCellId, setActiveCellId] = useState(null)
  // Type/status filter: 'all' | 'code' | 'markdown' | 'sql' | 'errors'
  const [typeFilter, setTypeFilter] = useState('all')
  // When a cell is explicitly clicked/focused in the notebook, that selection is
  // authoritative for a short window. The scroll-sync observer must NOT override
  // the highlight during this window, otherwise it stomps the clicked row with
  // whatever cell happens to be most-visible after the focus scroll.
  const clickGuardUntil = useRef(0)
  // Latest outline items, readable from the (mount-only) click listener without
  // stale closures — used to reveal a clicked cell that sits under collapsed parents.
  const itemsRef = useRef([])

  // Scroll-sync: observe cells in the DOM and highlight the most-visible one.
  // Cells render with [data-cell-id="..."]. We track intersection ratios and
  // pick the cell with the largest visible area as "active".
  useEffect(() => {
    const container = document.querySelector('.notebook-cells') || document.querySelector('.notebook-scroll') || document
    const cellEls = Array.from(document.querySelectorAll('[data-cell-id]'))
    if (cellEls.length === 0) return

    const ratios = new Map()
    const observer = new IntersectionObserver(
      (entries) => {
        // Respect a recent explicit click — don't fight the click-to-select highlight.
        if (Date.now() < clickGuardUntil.current) return
        for (const entry of entries) {
          const id = entry.target.getAttribute('data-cell-id')
          if (entry.isIntersecting) ratios.set(id, entry.intersectionRatio)
          else ratios.delete(id)
        }
        // Pick the most-visible cell
        let bestId = null
        let bestRatio = 0
        for (const [id, ratio] of ratios) {
          if (ratio > bestRatio) { bestRatio = ratio; bestId = id }
        }
        if (bestId) setActiveCellId(bestId)
      },
      { root: container === document ? null : container, threshold: [0, 0.25, 0.5, 0.75, 1] }
    )
    cellEls.forEach(el => observer.observe(el))
    return () => observer.disconnect()
  }, [cells.length, activeTab?.id])

  // Click-to-select: when a cell is clicked/focused in the notebook, highlight
  // its row in the outline and scroll the row into view (helps in long notebooks).
  useEffect(() => {
    const onActiveCell = (e) => {
      const id = e.detail?.cellId
      if (!id) return
      // Make this selection authoritative for ~1s so the scroll-sync observer
      // (which fires when focusing scrolls the cell) can't override it.
      clickGuardUntil.current = Date.now() + 1000
      setActiveCellId(id)
      // If the clicked cell is hidden under collapsed parent sections, expand
      // those ancestors so its row is actually visible in the tree.
      const clicked = itemsRef.current.find(it => it.id === id)
      if (clicked && clicked.ancestors && clicked.ancestors.length) {
        setCollapsedSections(prev => {
          if (!clicked.ancestors.some(aid => prev.has(aid))) return prev
          const next = new Set(prev)
          clicked.ancestors.forEach(aid => next.delete(aid))
          return next
        })
      }
      // Scroll the outline row into view (nearest — don't jump if already visible)
      setTimeout(() => {
        const row = document.querySelector(`.outline-item[data-outline-id="${id}"]`)
        if (row) row.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      }, 30)
    }
    window.addEventListener('notebook-active-cell', onActiveCell)
    return () => window.removeEventListener('notebook-active-cell', onActiveCell)
  }, [])

  // Build cell outline items with a heading-depth hierarchy.
  // Markdown cells with # headings define the tree; their heading level (1-6)
  // drives nesting. Code/SQL/plain-markdown cells attach to the current section.
  const cellOutlineItems = useMemo(() => {
    let codeCounter = 0
    const sectionStack = []            // [{ id, level }] — currently-open heading sections
    const headingCounters = [0, 0, 0, 0, 0, 0]  // for 1 / 1.1 / 1.2 numbering

    return cells.map((cell, idx) => {
      let label = ''
      let icon = ''
      const cellType = cell.type || 'code'
      let headingLevel = null

      if (cellType === 'markdown') {
        const firstLine = (cell.code || '').split('\n').find(l => l.trim()) || ''
        const m = firstLine.match(/^(#{1,6})\s+/)
        if (m) {
          headingLevel = m[1].length
          label = firstLine.replace(/^#+\s*/, '')
        } else {
          label = firstLine.slice(0, 60) || '(text)'
        }
        icon = 'M'
      } else if (cellType === 'sql') {
        codeCounter++
        const lines = (cell.code || '').split('\n').filter(l => l.trim() && !l.trim().startsWith('--'))
        label = lines.length > 0 ? lines[0].trim().slice(0, 50) : '(empty)'
        icon = `S${codeCounter}`
      } else {
        codeCounter++
        const lines = (cell.code || '').split('\n').filter(l => l.trim())
        const meaningfulLine = lines.find(l => !l.trim().startsWith('import ') && !l.trim().startsWith('from ') && !l.trim().startsWith('#'))
        if (meaningfulLine) {
          label = meaningfulLine.trim().slice(0, 50)
        } else if (lines.length > 0) {
          const pkgs = lines.filter(l => l.trim().startsWith('import ') || l.trim().startsWith('from '))
            .map(l => l.replace(/^(import |from )/, '').split(/[\s,.]/)[0])
            .slice(0, 3)
          label = `imports: ${pkgs.join(', ')}`
        } else {
          label = '(empty)'
        }
        icon = `${codeCounter}`
      }

      // Compute hierarchy: depth, ancestor section ids, and section number
      let depth, ancestors, sectionNumber = ''
      if (headingLevel != null) {
        // Close any open sections at the same or deeper level
        while (sectionStack.length && sectionStack[sectionStack.length - 1].level >= headingLevel) {
          sectionStack.pop()
        }
        ancestors = sectionStack.map(s => s.id)
        depth = sectionStack.length
        // Numbering: bump this level, reset deeper levels
        headingCounters[headingLevel - 1]++
        for (let l = headingLevel; l < 6; l++) headingCounters[l] = 0
        sectionNumber = headingCounters.slice(0, headingLevel).filter(n => n > 0).join('.')
        sectionStack.push({ id: cell.id, level: headingLevel })
      } else {
        // Code / SQL / plain-markdown: nest under the current open section
        ancestors = sectionStack.map(s => s.id)
        depth = sectionStack.length
      }

      return {
        id: cell.id, idx, label, icon, cellType,
        headingLevel, isSection: headingLevel != null, depth, ancestors, sectionNumber,
        code: cell.code || '',            // full source — searched in addition to the label
        hasOutput: !!(cell.output || cell.html || cell.image),
        hasError: !!cell.error,
        isRunning: cell.status === 'running',
        isStale: cell.lastExecutedCode != null && cell.code !== cell.lastExecutedCode,
        aiExplanation: cell.aiExplanation || null,
        executionTime: cell.executionTime,
      }
    })
  }, [cells])

  // Keep the ref current so the mount-only click listener sees fresh items.
  itemsRef.current = cellOutlineItems

  // Summary stats
  const stats = useMemo(() => {
    const executed = cellOutlineItems.filter(i => i.hasOutput || i.hasError)
    const errors = cellOutlineItems.filter(i => i.hasError)
    const totalTime = cellOutlineItems.reduce((sum, i) => sum + (i.executionTime || 0), 0)
    return { executedCount: executed.length, errorCount: errors.length, totalTime }
  }, [cellOutlineItems])

  // An item is visible if none of its ancestor sections are collapsed.
  const isItemVisible = useCallback((item) => {
    return !item.ancestors.some(aid => collapsedSections.has(aid))
  }, [collapsedSections])

  // Subtree of a section = all items that list it as an ancestor.
  const getSubtree = useCallback((sectionId) => {
    return cellOutlineItems.filter(i => i.ancestors.includes(sectionId))
  }, [cellOutlineItems])

  const toggleSection = (sectionId) => {
    setCollapsedSections(prev => {
      const next = new Set(prev)
      if (next.has(sectionId)) next.delete(sectionId)
      else next.add(sectionId)
      return next
    })
  }

  // Ids of every heading section — used by the expand/collapse-all toggle.
  const sectionIds = useMemo(
    () => cellOutlineItems.filter(i => i.isSection).map(i => i.id),
    [cellOutlineItems]
  )
  const hasSections = sectionIds.length > 0
  const anyCollapsed = sectionIds.some(id => collapsedSections.has(id))

  // One smart toggle: expand everything if anything is collapsed, otherwise
  // collapse every section.
  const toggleExpandAll = () => {
    setCollapsedSections(anyCollapsed ? new Set() : new Set(sectionIds))
  }

  // Apply type/status filter predicate
  const matchesTypeFilter = useCallback((item) => {
    switch (typeFilter) {
      case 'code': return item.cellType === 'code'
      case 'markdown': return item.cellType === 'markdown'
      case 'sql': return item.cellType === 'sql'
      case 'errors': return item.hasError
      default: return true
    }
  }, [typeFilter])

  // A flat filtered list is used when EITHER a text search or a non-"all"
  // type filter is active (both break the section grouping into a flat view).
  const isFiltering = !!outlineSearch || typeFilter !== 'all'
  const searchLc = outlineSearch.toLowerCase()
  const filteredOutline = isFiltering
    ? cellOutlineItems.filter(item =>
        // Match the label OR the full cell source (find a variable defined deeper
        // in the cell, not just the first meaningful line shown as the label).
        (!outlineSearch || item.label.toLowerCase().includes(searchLc) || item.code.toLowerCase().includes(searchLc)) &&
        matchesTypeFilter(item)
      )
    : null

  const formatTime = (ms) => {
    if (ms >= 60000) return `${(ms / 60000).toFixed(1)}m`
    if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`
    return `${Math.round(ms)}ms`
  }

  // Selection handlers
  const toggleSelect = useCallback((id, e) => {
    if (e?.shiftKey && selectedCells.size > 0) {
      // Shift-click: range select
      const allIds = cellOutlineItems.map(i => i.id)
      const lastSelected = [...selectedCells].pop()
      const lastIdx = allIds.indexOf(lastSelected)
      const currentIdx = allIds.indexOf(id)
      const [start, end] = lastIdx < currentIdx ? [lastIdx, currentIdx] : [currentIdx, lastIdx]
      setSelectedCells(prev => {
        const next = new Set(prev)
        for (let i = start; i <= end; i++) next.add(allIds[i])
        return next
      })
    } else {
      // If this is a heading section, select/deselect its entire subtree too
      const item = cellOutlineItems.find(i => i.id === id)
      const subtree = item?.isSection ? getSubtree(id) : []
      setSelectedCells(prev => {
        const next = new Set(prev)
        const wasSelected = next.has(id)
        if (wasSelected) {
          next.delete(id)
          subtree.forEach(c => next.delete(c.id))
        } else {
          next.add(id)
          subtree.forEach(c => next.add(c.id))
        }
        return next
      })
    }
  }, [cellOutlineItems, selectedCells, getSubtree])

  const selectAll = () => setSelectedCells(new Set(cellOutlineItems.map(i => i.id)))
  const selectNone = () => setSelectedCells(new Set())

  const handleBulkDelete = () => {
    if (selectedCells.size === 0) return
    setPendingDelete({ ids: [...selectedCells], fromBulk: true })
  }

  const confirmDeletion = () => {
    if (!pendingDelete) return
    if (onDeleteCells && pendingDelete.ids.length > 0) {
      onDeleteCells(pendingDelete.ids)
    }
    if (pendingDelete.fromBulk) {
      setSelectedCells(new Set())
      setSelectMode(false)
    }
    setPendingDelete(null)
  }

  const handleDeleteSingle = (id) => {
    if (onDeleteCells) onDeleteCells([id])
  }

  // Tree-aware block move. The selected contiguous block moves as a unit and
  // steps over the ADJACENT SIBLING UNIT at the same tree level (same depth and
  // same parent). Sections move past whole sibling subtrees; leaf cells move
  // past adjacent leaf siblings within their parent and never cross the heading.
  // Returns the new ordered id array, or null if the move isn't possible.
  const sameParent = (a, b) => a.length === b.length && a.every((v, i) => v === b[i])

  const computeBlockMove = useCallback((direction) => {
    if (selectedCells.size === 0) return null
    const items = cellOutlineItems
    const selIdx = items.filter(i => selectedCells.has(i.id)).map(i => i.idx).sort((a, b) => a - b)
    const s = selIdx[0]
    const e = selIdx[selIdx.length - 1]
    // Must be a contiguous block — otherwise the move is ambiguous.
    if (e - s + 1 !== selIdx.length) return null

    const top = items[s]
    const anchorDepth = top.depth
    const parent = top.ancestors
    const order = items.map(i => i.id)
    const block = order.slice(s, e + 1)

    if (direction === 'up') {
      // Find the start of the previous sibling unit (scan up until same depth+parent).
      let j = -1
      for (let k = s - 1; k >= 0; k--) {
        if (items[k].depth < anchorDepth) break            // reached parent/ancestor — no prior sibling
        if (items[k].depth === anchorDepth && sameParent(items[k].ancestors, parent)) { j = k; break }
        // depth > anchorDepth → inside a previous sibling's subtree, keep scanning up
      }
      if (j < 0) return null
      const sibling = order.slice(j, s)                    // [j .. s-1] = whole previous sibling unit
      return [...order.slice(0, j), ...block, ...sibling, ...order.slice(e + 1)]
    } else {
      // Find the start of the next sibling unit (scan down until same depth+parent).
      let k = -1
      for (let m = e + 1; m < items.length; m++) {
        if (items[m].depth < anchorDepth) break            // reached parent boundary — no next sibling
        if (items[m].depth === anchorDepth && sameParent(items[m].ancestors, parent)) { k = m; break }
      }
      if (k < 0) return null
      // Next sibling unit spans [k .. end) where end = next item at depth <= anchorDepth.
      let end = items.length
      for (let m = k + 1; m < items.length; m++) {
        if (items[m].depth <= anchorDepth) { end = m; break }
      }
      const sibling = order.slice(k, end)
      return [...order.slice(0, s), ...sibling, ...block, ...order.slice(end)]
    }
  }, [cellOutlineItems, selectedCells])

  const canMoveUp = useMemo(() => computeBlockMove('up') !== null, [computeBlockMove])
  const canMoveDown = useMemo(() => computeBlockMove('down') !== null, [computeBlockMove])

  const handleMoveSelected = (direction) => {
    const newOrder = computeBlockMove(direction)
    if (!newOrder) return
    if (onReorderCellIds) onReorderCellIds(newOrder)
  }

  // Tree-aware drag: dragging a section heading moves its ENTIRE subtree as a
  // unit; dragging a leaf cell moves just that cell. Drop inserts the block
  // before/after the target row depending on drag direction (so you can also
  // drop at the very end). Returns the new ordered id array, or null for a no-op.
  const computeDragMove = useCallback((draggedId, targetId) => {
    if (!draggedId || draggedId === targetId) return null
    const items = cellOutlineItems
    const order = items.map(i => i.id)
    const dragItem = items.find(i => i.id === draggedId)
    const targetItem = items.find(i => i.id === targetId)
    if (!dragItem || !targetItem) return null

    const blockIds = dragItem.isSection
      ? [draggedId, ...getSubtree(draggedId).map(i => i.id)]
      : [draggedId]
    const blockSet = new Set(blockIds)
    if (blockSet.has(targetId)) return null   // can't drop a section into its own subtree

    const remaining = order.filter(id => !blockSet.has(id))
    let insertAt = remaining.indexOf(targetId)
    if (insertAt < 0) return null
    // Dragging downward drops AFTER the target; upward drops BEFORE it.
    if (dragItem.idx < targetItem.idx) insertAt += 1
    return [...remaining.slice(0, insertAt), ...blockIds, ...remaining.slice(insertAt)]
  }, [cellOutlineItems, getSubtree])

  // Run every executable (code/SQL) cell in a section's subtree, in order.
  const runSection = (sectionId) => {
    if (!onRunCells) return
    const indices = getSubtree(sectionId)
      .filter(i => i.cellType !== 'markdown')
      .map(i => i.idx)
      .sort((a, b) => a - b)
    if (indices.length) onRunCells(indices)
  }

  // Delete a section heading together with all of its descendants (with confirm).
  const requestDeleteSection = (sectionId) => {
    const ids = [sectionId, ...getSubtree(sectionId).map(i => i.id)]
    setPendingDelete({ ids, fromBulk: false })
  }

  const toggleSelectMode = () => {
    if (selectMode) {
      setSelectedCells(new Set())
    }
    setSelectMode(!selectMode)
  }

  const renderItem = (item) => (
    <div
      key={item.id}
      data-outline-id={item.id}
      style={{ paddingLeft: `${10 + (isFiltering ? 0 : item.depth) * 14}px` }}
      className={`outline-item outline-item-${item.cellType}${item.isSection ? ` outline-item-h${item.headingLevel}` : ''}${outlineDragOverId === item.id ? ' outline-item-dragover' : ''}${item.isSection ? ' outline-item-section' : ''}${selectedCells.has(item.id) ? ' outline-item-selected' : ''}${activeCellId === item.id && !selectMode ? ' outline-item-active' : ''}`}
      onClick={(e) => {
        if (selectMode) {
          toggleSelect(item.id, e)
        } else if (item.isSection) {
          toggleSection(item.id)
        } else {
          onScrollToCell && onScrollToCell(item.idx)
        }
      }}
      draggable={!isFiltering && !selectMode}
      onDragStart={() => setOutlineDragId(item.id)}
      onDragOver={(e) => { e.preventDefault(); if (outlineDragId && outlineDragId !== item.id) setOutlineDragOverId(item.id) }}
      onDrop={() => {
        const newOrder = computeDragMove(outlineDragId, item.id)
        if (newOrder && onReorderCellIds) onReorderCellIds(newOrder)
        setOutlineDragId(null)
        setOutlineDragOverId(null)
      }}
      onDragEnd={() => { setOutlineDragId(null); setOutlineDragOverId(null) }}
      title={item.aiExplanation || item.label}
    >
      {/* Indent guide rails — one vertical line per nesting level (absolute) */}
      {!isFiltering && item.depth > 0 && Array.from({ length: item.depth }).map((_, i) => (
        <span key={`guide-${i}`} className="outline-indent-guide" style={{ left: `${16 + i * 14}px` }} />
      ))}
      {/* Checkbox in select mode */}
      {selectMode && (
        <input
          type="checkbox"
          className="outline-checkbox"
          checked={selectedCells.has(item.id)}
          onChange={() => toggleSelect(item.id)}
          onClick={(e) => e.stopPropagation()}
        />
      )}
      {!selectMode && (
        item.isSection
          ? <span className="outline-section-chevron">{collapsedSections.has(item.id) ? '▸' : '▾'}</span>
          : <span className="outline-chevron-spacer" />
      )}
      <span className={`outline-item-icon outline-icon-${item.cellType}`}>
        {item.cellType === 'markdown' ? 'M' : <>{item.icon}</>}
      </span>
      {item.isSection && item.sectionNumber && !isFiltering && (
        <span className="outline-section-number">{item.sectionNumber}</span>
      )}
      <span className="outline-item-label">{item.label}</span>
      {item.isRunning ? (
        <IconLoader width={12} height={12} className="outline-status-running" />
      ) : (
        <>
          {item.isStale && <span className="outline-item-status outline-status-stale" title="Modified since last run">●</span>}
          {item.hasError && <span className="outline-item-status outline-status-error">✗</span>}
          {!item.hasError && item.hasOutput && (
            <span className="outline-item-status outline-status-success" title={item.executionTime ? `Executed in ${formatTime(item.executionTime)}` : 'Executed'}>
              ✓{item.executionTime != null && <span className="outline-exec-time">{formatTime(item.executionTime)}</span>}
            </span>
          )}
        </>
      )}
      {/* Hover actions (only in non-select mode) */}
      {!selectMode && (
        <div className="outline-hover-actions">
          {item.isSection ? (
            <>
              {onRunCells && (
                <button
                  className="outline-action-btn outline-run-from"
                  onClick={(e) => { e.stopPropagation(); runSection(item.id) }}
                  title="Run all cells in this section"
                >▶</button>
              )}
              {onDeleteCells && (
                <button
                  className="outline-action-btn outline-delete-btn"
                  onClick={(e) => { e.stopPropagation(); requestDeleteSection(item.id) }}
                  title="Delete section and its contents"
                >✕</button>
              )}
            </>
          ) : (
            <>
              {onRunFromCell && (
                <button
                  className="outline-action-btn outline-run-from"
                  onClick={(e) => { e.stopPropagation(); onRunFromCell(item.idx) }}
                  title="Run from here"
                >▶</button>
              )}
              {onDeleteCells && (
                <button
                  className="outline-action-btn outline-delete-btn"
                  onClick={(e) => { e.stopPropagation(); handleDeleteSingle(item.id) }}
                  title="Delete cell"
                >✕</button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )

  return (
    <div className="sidebar-panel-content">
      <div className="sidebar-panel-header">
        <span className="sidebar-panel-title">Outline</span>
        <span className="sidebar-panel-count">{cells.length} cells</span>
        {stats.errorCount > 0 && (
          <span className="outline-error-badge">{stats.errorCount} error{stats.errorCount > 1 ? 's' : ''}</span>
        )}
        {hasSections && !selectMode && (
          <button
            className="outline-expand-toggle"
            onClick={toggleExpandAll}
            title={anyCollapsed ? 'Expand all sections' : 'Collapse all sections'}
          >
            {anyCollapsed ? <IconChevronDown width={12} height={12} /> : <IconChevronRight width={12} height={12} />}
          </button>
        )}
        <button
          className={`outline-select-toggle ${selectMode ? 'active' : ''}`}
          onClick={toggleSelectMode}
          title={selectMode ? 'Exit select mode' : 'Multi-select mode'}
        >
          ☑
        </button>
        <button className="sidebar-panel-close" onClick={onClose} title="Close panel"><IconX width={12} height={12} /></button>
      </div>
      {activeTab && <div className="sidebar-scope-pill"><IconNotebook width={12} height={12} /> {activeTab.name}</div>}

      {/* Bulk action bar (visible when cells selected) */}
      {selectMode && selectedCells.size > 0 && (
        <div className="outline-bulk-bar">
          <span className="outline-bulk-count">{selectedCells.size} selected</span>
          <button className="outline-bulk-btn" onClick={selectAll} title="Select all">All</button>
          <button className="outline-bulk-btn" onClick={selectNone} title="Deselect all">None</button>
          <button className="outline-bulk-btn" onClick={() => handleMoveSelected('up')} disabled={!canMoveUp} title={canMoveUp ? 'Move up (past previous sibling)' : 'No sibling above'}>
            <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="18 15 12 9 6 15"/></svg>
          </button>
          <button className="outline-bulk-btn" onClick={() => handleMoveSelected('down')} disabled={!canMoveDown} title={canMoveDown ? 'Move down (past next sibling)' : 'No sibling below'}>
            <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
          </button>
          {onRunCells && (
            <button className="outline-bulk-btn outline-bulk-run" onClick={() => {
              const indices = cellOutlineItems.filter(i => selectedCells.has(i.id) && i.cellType !== 'markdown').map(i => i.idx).sort((a, b) => a - b)
              if (indices.length > 0) onRunCells(indices)
            }} title="Run selected cells">
              <svg width={10} height={10} viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="5 3 19 12 5 21 5 3"/></svg> Run
            </button>
          )}
          {onClearOutputs && (
            <button className="outline-bulk-btn" onClick={() => {
              onClearOutputs([...selectedCells])
            }} title="Clear outputs of selected cells">
              <IconEraser width={10} height={10} /> Clear
            </button>
          )}
          <button className="outline-bulk-btn outline-bulk-delete" onClick={handleBulkDelete} title="Delete selected">
            <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg> Delete
          </button>
        </div>
      )}

      {/* Summary bar */}
      {stats.totalTime > 0 && !selectMode && (
        <div className="outline-summary">
          <span>{stats.executedCount} executed</span>
          <span>·</span>
          <span>Total: {formatTime(stats.totalTime)}</span>
        </div>
      )}

      {/* Type/status filter chips */}
      {!selectMode && (
        <div className="outline-filter-chips">
          {[
            { key: 'all', label: 'All' },
            { key: 'code', label: 'Code' },
            { key: 'sql', label: 'SQL' },
            { key: 'markdown', label: 'MD' },
            { key: 'errors', label: `Errors${stats.errorCount > 0 ? ` (${stats.errorCount})` : ''}` },
          ].map(chip => (
            <button
              key={chip.key}
              className={`outline-filter-chip${typeFilter === chip.key ? ' active' : ''}${chip.key === 'errors' && stats.errorCount > 0 ? ' has-errors' : ''}`}
              onClick={() => setTypeFilter(chip.key)}
              title={`Show ${chip.label}`}
            >
              {chip.label}
            </button>
          ))}
        </div>
      )}

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
        {(filteredOutline || cellOutlineItems).length === 0 && (
          <div className="sidebar-empty">
            {cells.length === 0
              ? 'No cells in this notebook'
              : (typeFilter === 'errors' ? 'No cells with errors' : 'No matching cells')}
          </div>
        )}
        {/* Filter/search mode: flat list (no nesting) */}
        {filteredOutline && filteredOutline.map(item => renderItem(item))}
        {/* Normal mode: nested hierarchy — hide items under collapsed sections
            (unless in select mode, where everything stays visible for bulk ops) */}
        {!filteredOutline && cellOutlineItems
          .filter(item => selectMode || isItemVisible(item))
          .map(item => renderItem(item))}
      </div>

      {/* Confirm delete modal (bulk selection or a whole section) */}
      {pendingDelete && (
        <div className="outline-confirm-overlay" onClick={() => setPendingDelete(null)}>
          <div className="outline-confirm-modal" onClick={e => e.stopPropagation()}>
            <p>Delete <strong>{pendingDelete.ids.length}</strong> cell{pendingDelete.ids.length > 1 ? 's' : ''}?</p>
            <p className="outline-confirm-hint">This cannot be undone.</p>
            <div className="outline-confirm-actions">
              <button className="outline-confirm-cancel" onClick={() => setPendingDelete(null)}>Cancel</button>
              <button className="outline-confirm-delete" onClick={confirmDeletion}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
