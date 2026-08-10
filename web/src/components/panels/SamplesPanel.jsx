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
        {samples.map(sample => (
          <div
            key={sample.id}
            className="sidebar-item sidebar-sample-item"
            onClick={() => onLoadSample(`/samples/${sample.file}`, sample.name)}
          >
            <span className="sidebar-file-icon">{sample.icon}</span>
            <span className="sidebar-item-label">{sample.name}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
