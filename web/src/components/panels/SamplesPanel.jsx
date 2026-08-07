import { IconX } from '../Icons'

const SAMPLES = [
  { id: 'sales_analysis', name: 'Sales Data Analysis', icon: '📊', file: '/samples/sales_analysis.notebook.json' },
  { id: 'time_series', name: 'Time Series Forecasting', icon: '📈', file: '/samples/time_series.notebook.json' },
  { id: 'data_cleaning', name: 'Data Cleaning & Transform', icon: '🧹', file: '/samples/data_cleaning.notebook.json' },
  { id: 'statistical_analysis', name: 'Statistical Analysis', icon: '🔬', file: '/samples/statistical_analysis.notebook.json' },
  { id: 'public_apis', name: 'Public API Data Analysis', icon: '🌐', file: '/samples/public_apis.notebook.json' },
  { id: 'aws_data_sources', name: 'AWS Data Sources', icon: '☁️', file: '/samples/aws_data_sources.notebook.json' },
  { id: 'burst_demo', name: 'Memory & CPU Burst Demo', icon: '⚡', file: '/samples/burst_demo.notebook.json' },
]

export default function SamplesPanel({ onLoadSample, onClose }) {
  return (
    <div className="sidebar-panel-content">
      <div className="sidebar-panel-header">
        <span className="sidebar-panel-title">Samples</span>
        <button className="sidebar-panel-close" onClick={onClose} title="Close panel"><IconX width={12} height={12} /></button>
      </div>
      <div className="sidebar-panel-body">
        {SAMPLES.map(sample => (
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
    </div>
  )
}
