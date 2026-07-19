import { useState, useRef, useEffect } from 'react'
import { marked } from 'marked'
import { sanitizeMarkdown } from '../services/sanitize'
import { IconCode, IconCheck, IconPlus, IconTrash, IconGripVertical } from './Icons'
import './Cell.css'

/**
 * Markdown/text cell with edit/render modes.
 * Double-click rendered view to edit. Shift+Enter or Esc to render.
 */
export default function MarkdownCell({
  cell,
  isActive,
  isDragOver,
  hasSearchMatch,
  onFocus,
  onCodeChange,
  onAddBelow,
  onDelete,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}) {
  const mdTextareaRef = useRef(null)
  const [mdEditing, setMdEditing] = useState(!cell.code)

  // Auto-resize markdown textarea
  useEffect(() => {
    const el = mdTextareaRef.current
    if (el && mdEditing) {
      el.style.height = 'auto'
      el.style.height = `${el.scrollHeight}px`
    }
  }, [cell.code, mdEditing])

  return (
    <div
      className={`cell cell-markdown ${isActive ? 'cell-active' : ''} ${isDragOver ? 'cell-drag-over' : ''} ${hasSearchMatch ? 'cell-search-match' : ''}`}
      data-cell-id={cell.id}
      onClick={onFocus}
      onDragOver={(e) => { e.preventDefault(); onDragOver?.() }}
      onDrop={(e) => { e.preventDefault(); onDrop?.() }}
      onDragEnd={onDragEnd}
    >
      <div className="cell-gutter">
        <span
          className="cell-drag-handle"
          draggable
          onDragStart={onDragStart}
          title="Drag to reorder"
        >
          <IconGripVertical width={12} height={12} />
        </span>
        <span className="cell-type-badge">MD</span>
      </div>
      <div className="cell-content">
        {mdEditing ? (
          <div className="md-edit-area">
            <textarea
              ref={mdTextareaRef}
              className="md-textarea"
              value={cell.code}
              onChange={(e) => onCodeChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' || (e.key === 'Enter' && e.shiftKey)) {
                  e.preventDefault()
                  setMdEditing(false)
                }
              }}
              placeholder="Write markdown here... (Shift+Enter or Esc to render)"
              spellCheck={true}
              autoFocus
            />
            <div className="md-edit-hint">Shift+Enter to render · Esc to close</div>
          </div>
        ) : (
          <div
            className="md-rendered"
            onDoubleClick={() => setMdEditing(true)}
            dangerouslySetInnerHTML={{ __html: cell.code ? sanitizeMarkdown(marked.parse(cell.code)) : '<p class="md-placeholder">Double-click to edit markdown</p>' }}
          />
        )}
        <div className="cell-actions md-actions">
          {mdEditing ? (
            <button className="cell-action-btn" onClick={() => setMdEditing(false)} title="Render markdown">
              <IconCheck width={14} height={14} />
            </button>
          ) : (
            <button className="cell-action-btn" onClick={() => setMdEditing(true)} title="Edit markdown">
              <IconCode width={14} height={14} />
            </button>
          )}
          <button className="cell-action-btn" onClick={(e) => { e.stopPropagation(); onAddBelow('code') }} title="Add code cell below">
            <IconPlus width={14} height={14} />
          </button>
          <button className="cell-action-btn cell-add-md-btn" onClick={(e) => { e.stopPropagation(); onAddBelow('markdown') }} title="Add text cell below">
            M
          </button>
          <button className="cell-action-btn cell-delete-btn" onClick={(e) => { e.stopPropagation(); onDelete() }} title="Delete cell">
            <IconTrash width={14} height={14} />
          </button>
        </div>
      </div>
    </div>
  )
}
