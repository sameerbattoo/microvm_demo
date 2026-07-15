import { useState } from 'react'
import './Sidebar.css'

export default function Sidebar({
  tabs,
  activeTabId,
  instances,
  attachedIds,
  uploadedFiles,
  onSelectTab,
  onNewNotebook,
  onCloseTab,
  onRenameTab,
  onAttachInstance,
  onResumeInstance,
  onTerminateInstance,
  onRefreshInstances,
  onUploadFile,
  onDeleteFile,
  onLoadSample,
  onUploadSampleData,
  onShowInstances,
}) {
  const [notebooksExpanded, setNotebooksExpanded] = useState(true)
  const [filesExpanded, setFilesExpanded] = useState(false)
  const [samplesExpanded, setSamplesExpanded] = useState(true)
  const [editingId, setEditingId] = useState(null)
  const [editValue, setEditValue] = useState('')

  const startRename = (e, tab) => {
    e.stopPropagation()
    setEditingId(tab.id)
    setEditValue(tab.name)
  }

  const commitRename = () => {
    if (editingId && editValue.trim()) {
      onRenameTab(editingId, editValue.trim())
    }
    setEditingId(null)
  }

  const instanceList = Object.entries(instances)

  const samples = [
    { id: 'sales_analysis', name: 'Sales Data Analysis', icon: '📊', file: '/samples/sales_analysis.notebook.json' },
    { id: 'time_series', name: 'Time Series Forecasting', icon: '📈', file: '/samples/time_series.notebook.json' },
    { id: 'data_cleaning', name: 'Data Cleaning & Transform', icon: '🧹', file: '/samples/data_cleaning.notebook.json' },
    { id: 'statistical_analysis', name: 'Statistical Analysis', icon: '🔬', file: '/samples/statistical_analysis.notebook.json' },
    { id: 'public_apis', name: 'Public API Data Analysis', icon: '🌐', file: '/samples/public_apis.notebook.json' },
    { id: 'aws_data_sources', name: 'AWS Data Sources', icon: '☁️', file: '/samples/aws_data_sources.notebook.json' },
  ]

  const handleFileUpload = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.csv,.xlsx,.xls,.parquet,.json,.txt'
    input.multiple = true
    input.onchange = (e) => {
      Array.from(e.target.files || []).forEach(file => {
        onUploadFile(file)
      })
    }
    input.click()
  }

  return (
    <aside className="sidebar">
      {/* Notebooks Section */}
      <div className="sidebar-section">
        <div className="sidebar-section-header" onClick={() => setNotebooksExpanded(!notebooksExpanded)}>
          <span className="sidebar-chevron">{notebooksExpanded ? '▾' : '▸'}</span>
          <span className="sidebar-section-icon">📓</span>
          <span className="sidebar-section-title">Notebooks</span>
          <button
            className="sidebar-section-action"
            onClick={(e) => { e.stopPropagation(); onNewNotebook() }}
            title="New notebook"
          >
            +
          </button>
        </div>
        {notebooksExpanded && (
          <div className="sidebar-section-body">
            {tabs.map(tab => (
              <div
                key={tab.id}
                className={`sidebar-item ${tab.id === activeTabId ? 'sidebar-item-active' : ''}`}
                onClick={() => onSelectTab(tab.id)}
                onDoubleClick={(e) => startRename(e, tab)}
                title={tab.description || ''}
              >
                <span className={`sidebar-item-dot sidebar-dot-${tab.status}`} />
                {editingId === tab.id ? (
                  <input
                    className="sidebar-rename-input"
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename()
                      if (e.key === 'Escape') setEditingId(null)
                    }}
                    onClick={(e) => e.stopPropagation()}
                    autoFocus
                  />
                ) : (
                  <span className="sidebar-item-label">{tab.name}</span>
                )}
                <button
                  className="sidebar-item-close"
                  onClick={(e) => { e.stopPropagation(); onCloseTab(tab.id) }}
                  title="Close"
                >
                  ×
                </button>
              </div>
            ))}
            {tabs.length === 0 && (
              <div className="sidebar-empty">No notebooks open</div>
            )}
          </div>
        )}
      </div>

      {/* Files Section */}
      <div className="sidebar-section">
        <div className="sidebar-section-header" onClick={() => setFilesExpanded(!filesExpanded)}>
          <span className="sidebar-chevron">{filesExpanded ? '▾' : '▸'}</span>
          <span className="sidebar-section-icon">📁</span>
          <span className="sidebar-section-title">Files</span>
          <button
            className="sidebar-section-action"
            onClick={(e) => { e.stopPropagation(); handleFileUpload() }}
            title="Upload file"
          >
            ↑
          </button>
        </div>
        {filesExpanded && (
          <div className="sidebar-section-body">
            {uploadedFiles.map(file => (
              <div key={file.name} className="sidebar-file-item">
                <span className="sidebar-file-icon">
                  {file.name.endsWith('.csv') ? '📄' :
                   file.name.match(/\.xlsx?$/) ? '📊' :
                   file.name.endsWith('.parquet') ? '🗂' :
                   file.name.endsWith('.json') ? '{ }' : '📎'}
                </span>
                <div className="sidebar-file-info">
                  <span className="sidebar-file-name" title={file.name}>{file.name}</span>
                  <span className="sidebar-file-meta">
                    {file.size} · {file.variable || 'uploading...'}
                  </span>
                </div>
                <button
                  className="sidebar-file-delete"
                  onClick={() => onDeleteFile(file.name)}
                  title="Remove"
                >
                  ×
                </button>
              </div>
            ))}
            {uploadedFiles.length === 0 && (
              <div className="sidebar-empty">
                No files uploaded.
                <br />
                <span className="sidebar-hint">Upload CSV, Excel, Parquet, or JSON files to use in your code.</span>
              </div>
            )}
            {uploadedFiles.length > 0 && (
              <div className="sidebar-file-hint">
                Use in code: <code>df = pd.read_csv('/tmp/filename.csv')</code>
              </div>
            )}
            <div className="sidebar-subheader">Sample Data</div>
            {[
              { name: 'sales_data.csv', size: '500 rows', desc: 'Orders with products, regions, discounts' },
              { name: 'customers.csv', size: '200 rows', desc: 'Customer data (some messy values)' },
              { name: 'web_traffic.csv', size: '730 rows', desc: 'Daily visitors over 2 years' },
              { name: 'ab_test_results.csv', size: '1000 rows', desc: 'A/B test conversion data' },
            ].map(sample => (
              <div
                key={sample.name}
                className="sidebar-file-item sidebar-sample-data"
                onClick={() => onUploadSampleData(sample.name)}
                title={sample.desc}
              >
                <span className="sidebar-file-icon">📄</span>
                <div className="sidebar-file-info">
                  <span className="sidebar-file-name">{sample.name}</span>
                  <span className="sidebar-file-meta">{sample.size}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Samples Section */}
      <div className="sidebar-section">
        <div className="sidebar-section-header" onClick={() => setSamplesExpanded(!samplesExpanded)}>
          <span className="sidebar-chevron">{samplesExpanded ? '▾' : '▸'}</span>
          <span className="sidebar-section-icon">💡</span>
          <span className="sidebar-section-title">Samples</span>
        </div>
        {samplesExpanded && (
          <div className="sidebar-section-body">
            {samples.map(sample => (
              <div
                key={sample.id}
                className="sidebar-item sidebar-sample-item"
                onClick={() => onLoadSample(sample.file, sample.name)}
              >
                <span className="sidebar-file-icon">{sample.icon}</span>
                <span className="sidebar-item-label">{sample.name}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* MicroVM Footer */}
      <div className="sidebar-footer" onClick={onShowInstances}>
        <span className="sidebar-footer-icon">☁️</span>
        <span className="sidebar-footer-text">MicroVMs</span>
        <span className="sidebar-footer-count">
          {instanceList.filter(([,i]) => i.state === 'RUNNING').length} running
          {instanceList.filter(([,i]) => i.state === 'SUSPENDED').length > 0 &&
            ` · ${instanceList.filter(([,i]) => i.state === 'SUSPENDED').length} suspended`}
        </span>
      </div>
    </aside>
  )
}
