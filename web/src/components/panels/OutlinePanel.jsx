import { useState } from 'react'
import { IconX, IconNotebook } from '../Icons'

export default function OutlinePanel({
  cells,
  activeTab,
  onScrollToCell,
  onReorderCells,
  onClose,
}) {
  const [outlineSearch, setOutlineSearch] = useState('')
  const [outlineDragIdx, setOutlineDragIdx] = useState(null)
  const [outlineDragOverIdx, setOutlineDragOverIdx] = useState(null)

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

    return { id: cell.id, idx, label, icon, cellType, hasOutput: !!(cell.output || cell.html || cell.image), hasError: !!cell.error, isStale: cell.lastExecutedCode != null && cell.code !== cell.lastExecutedCode, aiExplanation: cell.aiExplanation || null }
  })

  const filteredOutline = outlineSearch
    ? cellOutlineItems.filter(item => item.label.toLowerCase().includes(outlineSearch.toLowerCase()))
    : cellOutlineItems

  return (
    <div className="sidebar-panel-content">
      <div className="sidebar-panel-header">
        <span className="sidebar-panel-title">Outline</span>
        <span className="sidebar-panel-count">{cells.length} cells</span>
        <button className="sidebar-panel-close" onClick={onClose} title="Close panel"><IconX width={12} height={12} /></button>
      </div>
      {activeTab && <div className="sidebar-scope-pill"><IconNotebook width={12} height={12} /> {activeTab.name}</div>}
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
        {filteredOutline.length === 0 && (
          <div className="sidebar-empty">
            {cells.length === 0 ? 'No cells in this notebook' : 'No matching cells'}
          </div>
        )}
        {filteredOutline.map(item => (
          <div
            key={item.id}
            className={`outline-item outline-item-${item.cellType}${outlineDragOverIdx === item.idx ? ' outline-item-dragover' : ''}`}
            onClick={() => onScrollToCell && onScrollToCell(item.idx)}
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
            <span className={`outline-item-icon outline-icon-${item.cellType}`}>
              {item.cellType === 'markdown' ? 'M' : <>{item.icon}</>}
            </span>
            <span className="outline-item-label">{item.label}</span>
            {item.isStale && <span className="outline-item-status outline-status-stale" title="Modified since last run">●</span>}
            {item.hasError && <span className="outline-item-status outline-status-error">✗</span>}
            {!item.hasError && item.hasOutput && <span className="outline-item-status outline-status-success">✓</span>}
          </div>
        ))}
      </div>
    </div>
  )
}
