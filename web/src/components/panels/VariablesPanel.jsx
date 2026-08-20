import { useState } from 'react'
import {
  IconX, IconChevronDown, IconChevronRight, IconNotebook,
  IconBarChart, IconChartLine, IconTable, IconSparkles, IconBraces, IconCode, IconTrash,
} from '../Icons'
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

export default function VariablesPanel({ variables, activeTab, onInsertCode, onDeleteVariable, onClose }) {
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
                {(onInsertCode || onDeleteVariable) && (
                  <div className="var-actions">
                    {onInsertCode && (['DataFrame', 'Series'].includes(info.type) ? (
                      <>
                        <button className="var-action-btn" onClick={() => onInsertCode(`${name}.describe()`)} title="Statistical summary"><IconBarChart width={11} height={11} /> Describe</button>
                        <button className="var-action-btn" onClick={() => onInsertCode(`${name}.head(10)`)} title="First 10 rows"><IconTable width={11} height={11} /> Head</button>
                        <button className="var-action-btn" onClick={() => onInsertCode(`import matplotlib.pyplot as plt\n\n${name}.plot(figsize=(10, 5), title='${name}')\nplt.tight_layout()\nplt.show()`)} title="Quick visualization"><IconChartLine width={11} height={11} /> Plot</button>
                        <button className="var-action-btn" onClick={() => onInsertCode(`print(f"Shape: {${name}.shape}")\nprint(f"\\nDtypes:\\n{${name}.dtypes}")\nprint(f"\\nNull counts:\\n{${name}.isnull().sum()}")\nprint(f"\\nMemory: {${name}.memory_usage(deep=True).sum() / 1024:.1f} KB")`)} title="Data quality profile"><IconSparkles width={11} height={11} /> Profile</button>
                        <button className="var-action-btn" onClick={() => onInsertCode(`${name}.info()`)} title="Column info"><IconBraces width={11} height={11} /> Info</button>
                      </>
                    ) : info.type === 'ndarray' ? (
                      <>
                        <button className="var-action-btn" onClick={() => onInsertCode(`print(f"Shape: {${name}.shape}, Dtype: {${name}.dtype}")\nprint(f"Min: {${name}.min():.4f}, Max: {${name}.max():.4f}, Mean: {${name}.mean():.4f}")`)} title="Array stats"><IconBarChart width={11} height={11} /> Stats</button>
                        <button className="var-action-btn" onClick={() => onInsertCode(`import matplotlib.pyplot as plt\nplt.hist(${name}.flatten(), bins=30)\nplt.title('${name} distribution')\nplt.show()`)} title="Histogram"><IconChartLine width={11} height={11} /> Hist</button>
                      </>
                    ) : (
                      <button className="var-action-btn" onClick={() => onInsertCode(`print(${name})`)} title="Print value"><IconCode width={11} height={11} /> Print</button>
                    ))}
                    {onDeleteVariable && (
                      <button
                        className="var-action-btn var-action-delete"
                        onClick={() => onDeleteVariable(name)}
                        title={`Delete '${name}' from the session namespace`}
                      ><IconTrash width={11} height={11} /> Delete</button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}

        {/* Environment Variables section */}
        {activeTab?._envVars && activeTab._envVars.length > 0 && (
          <>
            <div className="sidebar-subheader" style={{ marginTop: '12px' }}>
              🔐 Environment Variables
              <span className="sidebar-subheader-count">{activeTab._envVars.length}</span>
            </div>
            {activeTab._envVars.map((env, idx) => (
              <div key={idx} className="var-item">
                <div
                  className="var-item-row"
                  onClick={() => onInsertCode(`import os\n${env.key.toLowerCase()} = os.environ.get('${env.key}', '')`)}
                  title="Click to insert os.environ.get() code"
                >
                  <span className="var-type-icon" style={{ color: '#f9e2af' }}>🔑</span>
                  <span className="var-name">{env.key}</span>
                  <span className="var-type" style={{ color: 'var(--text-muted)' }}>
                    {env.source === 'sm' ? `SM` : 'direct'}
                  </span>
                  {env.secretName && <span className="var-shape">{env.secretName.split('/').pop()}</span>}
                </div>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  )
}
