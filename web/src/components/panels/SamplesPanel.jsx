import { useState, useEffect } from 'react'
import { IconX } from '../Icons'

export default function SamplesPanel({ onLoadSample, onClose }) {
  const [samples, setSamples] = useState([])

  useEffect(() => {
    fetch('/samples/index.json')
      .then(r => r.json())
      .then(setSamples)
      .catch(() => {})
  }, [])

  return (
    <div className="sidebar-panel-content">
      <div className="sidebar-panel-header">
        <span className="sidebar-panel-title">Samples</span>
        <span className="sidebar-panel-count">{samples.length}</span>
        <button className="sidebar-panel-close" onClick={onClose} title="Close panel"><IconX width={12} height={12} /></button>
      </div>
      <div className="sidebar-panel-body">
        {samples.length === 0 && (
          <div className="app-empty-samples-loading">Loading samples…</div>
        )}
        <div className="sidebar-samples-list">
          {samples.map(sample => (
            <button
              key={sample.id}
              className="sample-card"
              onClick={() => onLoadSample(`/samples/${sample.file}`, sample.name)}
              title={sample.description || sample.name}
            >
              <span className="sample-card-icon">{sample.icon}</span>
              <span className="sample-card-text">
                <span className="sample-card-name">{sample.name}</span>
                {sample.description && <span className="sample-card-desc">{sample.description}</span>}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
