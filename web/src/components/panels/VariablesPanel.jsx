import { useState } from 'react'
import { IconX, IconChevronDown, IconChevronRight, IconNotebook } from '../Icons'
import VariablePreviewRenderer from '../VariablePreviewRenderer'

const TYPE_ICONS = {
  DataFrame: '📊', Series: '📈', ndarray: '🔢', list: '[ ]', dict: '{ }',
  tuple: '( )', str: 'abc', int: '#', float: '#.', bool: '⊘', NoneType: '∅',
}

function getTypeIcon(type) { return TYPE_ICONS[type] || '◇' }

function getTypeColor(type) {
  if (['DataFrame', 'Series'].includes(type)) return 'var-type-dataframe'
  if (['list', 'tuple', 'set'].includes(type)) return 'var-type-collection'
  if (['dict'].includes(type)) return 'var-type-dict'
  if (['int', 'float', 'complex'].includes(type)) return 'var-type-number'
  if (['str'].includes(type)) return 'var-type-string'
  if (['bool', 'NoneType'].includes(type)) return 'var-type-bool'
  return 'var-type-other'
}

export default function VariablesPanel({ variables, activeTab, onClose }) {
  const [expandedVar, setExpandedVar] = useState(null)

  return (
    <div className="sidebar-panel-content">
      <div className="sidebar-panel-header">
        <span className="sidebar-panel-title">Variables</span>
        <span className="sidebar-panel-count">{Object.keys(variables).length}</span>
        <button className="sidebar-panel-close" onClick={onClose} title="Close panel"><IconX width={12} height={12} /></button>
      </div>
      {activeTab && <div className="sidebar-scope-pill"><IconNotebook width={12} height={12} /> {activeTab.name}</div>}
      <div className="sidebar-panel-body">
        {Object.keys(variables).length === 0 && (
          <div className="sidebar-empty">
            No variables defined yet. Execute a cell to see variables here.
          </div>
        )}
        {Object.entries(variables).map(([name, info]) => (
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
