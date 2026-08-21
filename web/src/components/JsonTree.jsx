import { useState } from 'react'

// Collapsible JSON tree viewer for nested dict/list variables. Expects an
// already JSON-safe value (the backend bounds depth/size and stringifies any
// non-JSON leaves), so this only has to handle object / array / primitive.

function kindOf(v) {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  if (typeof v === 'object') return 'object'
  return typeof v // 'string' | 'number' | 'boolean'
}

function Leaf({ value }) {
  const k = kindOf(value)
  const text = k === 'string' ? `"${value}"` : k === 'null' ? 'null' : String(value)
  return <span className={`json-val json-${k}`}>{text}</span>
}

function Node({ label, value, depth, defaultOpen }) {
  const k = kindOf(value)
  const isContainer = k === 'object' || k === 'array'
  const [open, setOpen] = useState(defaultOpen)
  const indent = { paddingLeft: `${depth * 14}px` }

  if (!isContainer) {
    return (
      <div className="json-row" style={indent}>
        {label != null && <span className="json-key">{label}:</span>}
        <Leaf value={value} />
      </div>
    )
  }

  const entries = k === 'array'
    ? value.map((v, i) => [i, v])
    : Object.entries(value)
  const count = entries.length
  const summary = k === 'array'
    ? `[ ] ${count} item${count === 1 ? '' : 's'}`
    : `{ } ${count} key${count === 1 ? '' : 's'}`

  return (
    <div className="json-node">
      <div className="json-row json-row-toggle" style={indent} onClick={() => setOpen(o => !o)}>
        <span className={`json-toggle ${open ? 'open' : ''}`}>▶</span>
        {label != null && <span className="json-key">{label}:</span>}
        <span className="json-summary">{summary}</span>
      </div>
      {open && entries.map(([childKey, childVal]) => (
        <Node
          key={childKey}
          label={String(childKey)}
          value={childVal}
          depth={depth + 1}
          defaultOpen={false}
        />
      ))}
    </div>
  )
}

export default function JsonTree({ data }) {
  return (
    <div className="json-tree">
      <Node label={null} value={data} depth={0} defaultOpen />
    </div>
  )
}
