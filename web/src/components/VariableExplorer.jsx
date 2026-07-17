import { useState, useRef, useCallback } from 'react'
import { IconChevronRight, IconChevronDown, IconX } from './Icons'
import VariablePreviewRenderer from './VariablePreviewRenderer'
import './VariableExplorer.css'

const TYPE_ICONS = {
  DataFrame: '📊',
  Series: '📈',
  ndarray: '🔢',
  list: '[ ]',
  dict: '{ }',
  tuple: '( )',
  str: 'abc',
  int: '#',
  float: '#.',
  bool: '⊘',
  NoneType: '∅',
}

function getTypeIcon(type) {
  return TYPE_ICONS[type] || '◇'
}

function getTypeColor(type) {
  if (['DataFrame', 'Series'].includes(type)) return 'var-type-dataframe'
  if (['list', 'tuple', 'set'].includes(type)) return 'var-type-collection'
  if (['dict'].includes(type)) return 'var-type-dict'
  if (['int', 'float', 'complex'].includes(type)) return 'var-type-number'
  if (['str'].includes(type)) return 'var-type-string'
  if (['bool', 'NoneType'].includes(type)) return 'var-type-bool'
  return 'var-type-other'
}

export default function VariableExplorer({ variables, isOpen, onClose }) {
  const [expandedVar, setExpandedVar] = useState(null)
  const [width, setWidth] = useState(280)
  const isResizing = useRef(false)

  const DEFAULT_WIDTH = 280
  const MIN_WIDTH = DEFAULT_WIDTH * 0.5  // 140px
  const MAX_WIDTH = DEFAULT_WIDTH * 2    // 560px

  const handleMouseDown = useCallback((e) => {
    e.preventDefault()
    isResizing.current = true
    const startX = e.clientX
    const startWidth = width

    const handleMouseMove = (e) => {
      if (!isResizing.current) return
      const delta = startX - e.clientX  // dragging left = bigger panel
      const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + delta))
      setWidth(newWidth)
    }

    const handleMouseUp = () => {
      isResizing.current = false
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [width])

  if (!isOpen) return null

  const varEntries = Object.entries(variables || {})

  return (
    <div className="var-explorer" style={{ width: `${width}px`, minWidth: `${width}px` }}>
      <div className="var-explorer-resize-handle" onMouseDown={handleMouseDown} />
      <div className="var-explorer-header">
        <span className="var-explorer-title">Variables</span>
        <span className="var-explorer-count">{varEntries.length}</span>
        <button className="var-explorer-close" onClick={onClose} title="Close panel">
          <IconX width={14} height={14} />
        </button>
      </div>

      <div className="var-explorer-body">
        {varEntries.length === 0 && (
          <div className="var-explorer-empty">
            No variables defined yet. Execute a cell to see variables here.
          </div>
        )}

        {varEntries.map(([name, info]) => (
          <div key={name} className="var-item">
            <div
              className="var-item-row"
              onClick={() => setExpandedVar(expandedVar === name ? null : name)}
            >
              <span className="var-expand-icon">
                {expandedVar === name ? <IconChevronDown width={10} height={10} /> : <IconChevronRight width={10} height={10} />}
              </span>
              <span className={`var-type-icon ${getTypeColor(info.type)}`}>
                {getTypeIcon(info.type)}
              </span>
              <span className="var-name">{name}</span>
              <span className="var-type">{info.type}</span>
              {info.shape && <span className="var-shape">{info.shape}</span>}
            </div>

            {expandedVar === name && (
              <div className="var-detail">
                {info.size && (
                  <div className="var-detail-row">
                    <span className="var-detail-label">Size</span>
                    <span className="var-detail-value">{info.size}</span>
                  </div>
                )}
                {info.shape && (
                  <div className="var-detail-row">
                    <span className="var-detail-label">Shape</span>
                    <span className="var-detail-value">{info.shape}</span>
                  </div>
                )}
                <div className="var-detail-preview">
                  <VariablePreviewRenderer info={info} />
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
