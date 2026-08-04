import { useState, useMemo } from 'react'
import { IconX, IconNotebook } from '../Icons'

export default function OutlinePanel({
  cells,
  activeTab,
  onScrollToCell,
  onReorderCells,
  onRunFromCell,
  onClose,
}) {
  const [outlineSearch, setOutlineSearch] = useState('')
  const [outlineDragIdx, setOutlineDragIdx] = useState(null)
  const [outlineDragOverIdx, setOutlineDragOverIdx] = useState(null)
  const [collapsedSections, setCollapsedSections] = useState(new Set())

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

  // Group items into sections (markdown headers group subsequent code cells)
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
    : null // null = use grouped view

  const formatTime = (ms) => {
    if (ms >= 60000) return `${(ms / 60000).toFixed(1)}m`
    if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`
    return `${Math.round(ms)}ms`
  }

  const renderItem = (item) => (
    <div
      key={item.id}
      className={`outline-item outline-item-${item.cellType}${outlineDragOverIdx === item.idx ? ' outline-item-dragover' : ''}${item.isSection ? ' outline-item-section' : ''}`}
      onClick={() => item.isSection ? toggleSection(item.id) : onScrollToCell && onScrollToCell(item.idx)}
      draggable={!outlineSearch}
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
      {item.isSection && (
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
      {!item.isSection && onRunFromCell && (
        <button
          className="outline-run-from"
          onClick={(e) => { e.stopPropagation(); onRunFromCell(item.idx) }}
          title="Run from here"
        >⏩</button>
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
        <button className="sidebar-panel-close" onClick={onClose} title="Close panel"><IconX width={12} height={12} /></button>
      </div>
      {activeTab && <div className="sidebar-scope-pill"><IconNotebook width={12} height={12} /> {activeTab.name}</div>}

      {/* Summary bar */}
      {stats.totalTime > 0 && (
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
                {!isCollapsed && item.children.map(child => renderItem(child))}
              </div>
            )
          }
          return renderItem(item)
        })}
      </div>
    </div>
  )
}
