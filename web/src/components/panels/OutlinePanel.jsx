import { useState, useMemo, useCallback } from 'react'
import { IconX, IconNotebook } from '../Icons'

export default function OutlinePanel({
  cells,
  activeTab,
  onScrollToCell,
  onReorderCells,
  onRunFromCell,
  onDeleteCells,
  onRunCells,
  onClearOutputs,
  onClose,
}) {
  const [outlineSearch, setOutlineSearch] = useState('')
  const [outlineDragIdx, setOutlineDragIdx] = useState(null)
  const [outlineDragOverIdx, setOutlineDragOverIdx] = useState(null)
  const [collapsedSections, setCollapsedSections] = useState(new Set())
  const [selectMode, setSelectMode] = useState(false)
  const [selectedCells, setSelectedCells] = useState(new Set())
  const [confirmDelete, setConfirmDelete] = useState(false)

  // Build cell outline items
  let codeCounter = 0
  const cellOutlineItems = cells.map((cell, idx) => {
    let label = ''
    let icon = ''
    let cellType = cell.type || 'code'

    if (cellType === 'markdown') {
      const firstLine = (cell.code || '').split('\n').find(l => l.trim()) || ''
      if (firstLine.startsWith('#')) {
        label = firstLine.replace(/^#+\s*/, '')
      } else {
        label = firstLine.slice(0, 60)
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

    return { id: cell.id, idx, label, icon, cellType, hasOutput: !!(cell.output || cell.html || cell.image), hasError: !!cell.error, isStale: cell.lastExecutedCode != null && cell.code !== cell.lastExecutedCode, aiExplanation: cell.aiExplanation || null, executionTime: cell.executionTime }
  })

  // Summary stats
  const stats = useMemo(() => {
    const executed = cellOutlineItems.filter(i => i.hasOutput || i.hasError)
    const errors = cellOutlineItems.filter(i => i.hasError)
    const totalTime = cellOutlineItems.reduce((sum, i) => sum + (i.executionTime || 0), 0)
    return { executedCount: executed.length, errorCount: errors.length, totalTime }
  }, [cellOutlineItems])

  // Group items into sections
  const groupedOutline = useMemo(() => {
    const groups = []
    let currentSection = null

    for (const item of cellOutlineItems) {
      if (item.cellType === 'markdown') {
        currentSection = item.id
        groups.push({ ...item, isSection: true, children: [] })
      } else {
        if (groups.length > 0 && groups[groups.length - 1].isSection) {
          groups[groups.length - 1].children.push(item)
        } else {
          groups.push({ ...item, isSection: false })
        }
      }
    }
    return groups
  }, [cellOutlineItems])

  const toggleSection = (sectionId) => {
    setCollapsedSections(prev => {
      const next = new Set(prev)
      if (next.has(sectionId)) next.delete(sectionId)
      else next.add(sectionId)
      return next
    })
  }

  const filteredOutline = outlineSearch
    ? cellOutlineItems.filter(item => item.label.toLowerCase().includes(outlineSearch.toLowerCase()))
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
      // Check if this is a markdown section — select/deselect children too
      const section = groupedOutline.find(g => g.isSection && g.id === id)
      setSelectedCells(prev => {
        const next = new Set(prev)
        const wasSelected = next.has(id)
        if (wasSelected) {
          next.delete(id)
          if (section) section.children.forEach(c => next.delete(c.id))
        } else {
          next.add(id)
          if (section) section.children.forEach(c => next.add(c.id))
        }
        return next
      })
    }
  }, [cellOutlineItems, selectedCells, groupedOutline])

  const selectAll = () => setSelectedCells(new Set(cellOutlineItems.map(i => i.id)))
  const selectNone = () => setSelectedCells(new Set())

  const handleBulkDelete = () => {
    if (selectedCells.size === 0) return
    setConfirmDelete(true)
  }

  const confirmBulkDelete = () => {
    if (onDeleteCells && selectedCells.size > 0) {
      onDeleteCells([...selectedCells])
    }
    setSelectedCells(new Set())
    setSelectMode(false)
    setConfirmDelete(false)
  }

  const handleDeleteSingle = (id) => {
    if (onDeleteCells) onDeleteCells([id])
  }

  const handleMoveSelected = (direction) => {
    if (!onReorderCells || selectedCells.size === 0) return
    const indices = cellOutlineItems
      .filter(i => selectedCells.has(i.id))
      .map(i => i.idx)
      .sort((a, b) => a - b)

    if (direction === 'up' && indices[0] > 0) {
      // Move the entire group up: swap the cell just above the group into the position after the group
      const aboveIdx = indices[0] - 1
      // Reorder: move the cell above the group to after the last selected
      onReorderCells(aboveIdx, indices[indices.length - 1])
    } else if (direction === 'down' && indices[indices.length - 1] < cells.length - 1) {
      // Move the entire group down: swap the cell just below the group into the position before the group
      const belowIdx = indices[indices.length - 1] + 1
      // Reorder: move the cell below the group to before the first selected
      onReorderCells(belowIdx, indices[0])
    }
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
      className={`outline-item outline-item-${item.cellType}${outlineDragOverIdx === item.idx ? ' outline-item-dragover' : ''}${item.isSection ? ' outline-item-section' : ''}${selectedCells.has(item.id) ? ' outline-item-selected' : ''}`}
      onClick={(e) => {
        if (selectMode) {
          toggleSelect(item.id, e)
        } else if (item.isSection) {
          toggleSection(item.id)
        } else {
          onScrollToCell && onScrollToCell(item.idx)
        }
      }}
      draggable={!outlineSearch && !selectMode}
      onDragStart={() => setOutlineDragIdx(item.idx)}
      onDragOver={(e) => { e.preventDefault(); setOutlineDragOverIdx(item.idx) }}
      onDrop={() => {
        if (outlineDragIdx != null && outlineDragIdx !== item.idx) {
          onReorderCells && onReorderCells(outlineDragIdx, item.idx)
        }
        setOutlineDragIdx(null)
        setOutlineDragOverIdx(null)
      }}
      onDragEnd={() => { setOutlineDragIdx(null); setOutlineDragOverIdx(null) }}
      title={item.aiExplanation || item.label}
    >
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
      {item.isSection && !selectMode && (
        <span className="outline-section-chevron">{collapsedSections.has(item.id) ? '▸' : '▾'}</span>
      )}
      <span className={`outline-item-icon outline-icon-${item.cellType}`}>
        {item.cellType === 'markdown' ? 'M' : <>{item.icon}</>}
      </span>
      <span className="outline-item-label">{item.label}</span>
      {item.isStale && <span className="outline-item-status outline-status-stale" title="Modified since last run">●</span>}
      {item.hasError && <span className="outline-item-status outline-status-error">✗</span>}
      {!item.hasError && item.hasOutput && (
        <span className="outline-item-status outline-status-success" title={item.executionTime ? `Executed in ${formatTime(item.executionTime)}` : 'Executed'}>
          ✓{item.executionTime != null && <span className="outline-exec-time">{formatTime(item.executionTime)}</span>}
        </span>
      )}
      {/* Hover actions (only in non-select mode) */}
      {!selectMode && (
        <div className="outline-hover-actions">
          {!item.isSection && onRunFromCell && (
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
          <button className="outline-bulk-btn" onClick={() => handleMoveSelected('up')} title="Move up">
            <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="18 15 12 9 6 15"/></svg>
          </button>
          <button className="outline-bulk-btn" onClick={() => handleMoveSelected('down')} title="Move down">
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
              <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg> Clear
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
            {cells.length === 0 ? 'No cells in this notebook' : 'No matching cells'}
          </div>
        )}
        {/* Search mode: flat list */}
        {filteredOutline && filteredOutline.map(item => renderItem(item))}
        {/* Normal mode: grouped by markdown sections */}
        {!filteredOutline && groupedOutline.map(item => {
          if (item.isSection) {
            const isCollapsed = collapsedSections.has(item.id)
            return (
              <div key={item.id} className="outline-section-group">
                {renderItem(item)}
                {(!isCollapsed || selectMode) && item.children.map(child => renderItem(child))}
              </div>
            )
          }
          return renderItem(item)
        })}
      </div>

      {/* Confirm delete modal */}
      {confirmDelete && (
        <div className="outline-confirm-overlay" onClick={() => setConfirmDelete(false)}>
          <div className="outline-confirm-modal" onClick={e => e.stopPropagation()}>
            <p>Delete <strong>{selectedCells.size}</strong> cell{selectedCells.size > 1 ? 's' : ''}?</p>
            <p className="outline-confirm-hint">This cannot be undone.</p>
            <div className="outline-confirm-actions">
              <button className="outline-confirm-cancel" onClick={() => setConfirmDelete(false)}>Cancel</button>
              <button className="outline-confirm-delete" onClick={confirmBulkDelete}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
