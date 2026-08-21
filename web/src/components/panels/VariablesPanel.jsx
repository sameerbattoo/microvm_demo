import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import {
  IconX, IconChevronDown, IconChevronRight, IconNotebook, IconSearch,
  IconBarChart, IconChartLine, IconTable, IconSparkles, IconBraces, IconCode, IconTrash,
} from '../Icons'
import VariablePreviewRenderer from '../VariablePreviewRenderer'
import VariableDetailModal from '../VariableDetailModal'

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

// Types that support the tabular "View data" viewer + column schema.
const TABULAR_TYPES = new Set(['DataFrame', 'Series', 'ndarray'])

// A signature that changes whenever a variable's value changes, used to
// invalidate the per-name detail cache (schema + table) on reassignment.
// last_exec (the provenance clock) bumps on EVERY write — including a SQL
// reassignment to a same-shape/same-size DataFrame, which is the case that
// type/shape/size alone can't detect. The rest are fallbacks when provenance
// is unavailable (older VM image without provenance fields).
function varSignature(info) {
  return `${info?.type || ''}|${info?.shape || ''}|${info?.size || ''}|${info?.last_exec ?? ''}`
}

// Group a variable's type into a coarse kind for the group-by-kind view.
const KIND_ORDER = ['Data', 'Collections', 'Scalars', 'Other']
function kindOf(type) {
  if (['DataFrame', 'Series', 'ndarray'].includes(type)) return 'Data'
  if (['list', 'tuple', 'dict', 'set', 'frozenset'].includes(type)) return 'Collections'
  if (['int', 'float', 'complex', 'bool', 'str', 'NoneType'].includes(type)) return 'Scalars'
  return 'Other'
}

// Parse a human size string ("1.2 KB", "3 MB", "512 B") into bytes for sorting.
function sizeToBytes(sizeStr) {
  if (!sizeStr) return 0
  const m = String(sizeStr).match(/([\d.]+)\s*(B|KB|MB|GB)?/i)
  if (!m) return 0
  const n = parseFloat(m[1]) || 0
  const unit = (m[2] || 'B').toUpperCase()
  const mult = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }[unit] || 1
  return n * mult
}

export default function VariablesPanel({ variables, activeTab, cells = [], onScrollToCell, onInsertCode, onDeleteVariable, onClose }) {
  const [expandedVar, setExpandedVar] = useState(null)
  const [search, setSearch] = useState('')
  const [sortBy, setSortBy] = useState('name') // 'name' | 'type' | 'size'
  const [grouped, setGrouped] = useState(true)
  // Lazily-fetched rich detail per variable: { [name]: { loading, data, error } }
  const [detailCache, setDetailCache] = useState({})
  const [viewerVar, setViewerVar] = useState(null) // name shown in the full-grid modal

  const canFetch = activeTab?.microvmEndpoint && activeTab?.status === 'connected'

  // Fetch rich detail (schema + full table) for ONE variable, on demand.
  const fetchDetail = useCallback(async (name) => {
    if (!canFetch) return
    setDetailCache(prev => {
      // Skip if already loaded or in-flight.
      if (prev[name] && (prev[name].loading || prev[name].data)) return prev
      return { ...prev, [name]: { loading: true, data: null, error: null } }
    })
    try {
      const headers = { 'Content-Type': 'application/json' }
      if (activeTab.sessionId) headers['X-Session-Id'] = activeTab.sessionId
      const resp = await fetch(`${activeTab.microvmEndpoint}/variable-detail`, {
        method: 'POST', headers, body: JSON.stringify({ name }),
      })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const data = await resp.json()
      setDetailCache(prev => ({ ...prev, [name]: { loading: false, data, error: null } }))
    } catch (err) {
      setDetailCache(prev => ({ ...prev, [name]: { loading: false, data: null, error: err.message } }))
    }
  }, [canFetch, activeTab?.microvmEndpoint, activeTab?.sessionId])

  const toggleExpand = useCallback((name, type) => {
    const next = expandedVar === name ? null : name
    setExpandedVar(next)
    if (next && TABULAR_TYPES.has(type) && canFetch) fetchDetail(name)
  }, [expandedVar, canFetch, fetchDetail])

  // The viewer modal now fetches its own detail, so opening it just needs the name.
  const openViewer = useCallback((name) => {
    setViewerVar(name)
  }, [])

  // Filter + sort (and optionally group) the variable entries.
  const entries = useMemo(() => Object.entries(variables), [variables])

  // --- Provenance: jump-to-cell + new/changed badges ---
  const cellIndexById = useMemo(() => {
    const m = new Map()
    cells.forEach((c, i) => m.set(c.id, i))
    return m
  }, [cells])

  // "Cell N" label (1-based) for a provenance cell id, or null if the cell is gone.
  const cellLabel = useCallback((cellId) => {
    if (cellId == null || cellId === '') return null
    const idx = cellIndexById.get(cellId)
    return idx == null ? null : `Cell ${idx + 1}`
  }, [cellIndexById])

  const jumpToCell = useCallback((cellId) => {
    const idx = cellIndexById.get(cellId)
    if (idx != null && onScrollToCell) onScrollToCell(idx)
  }, [cellIndexById, onScrollToCell])

  // Highlight variables touched in the most recent execution. Baseline is captured
  // once on first load so nothing is badged until the user actually runs something
  // this session (avoids lighting up everything after a checkpoint restore).
  const maxExec = useMemo(
    () => entries.reduce((m, [, i]) => Math.max(m, i.last_exec || 0), 0),
    [entries],
  )
  const baselineExecRef = useRef(null)
  if (baselineExecRef.current === null && entries.length > 0) baselineExecRef.current = maxExec
  const badgeActive = maxExec > (baselineExecRef.current ?? maxExec)
  const badgeFor = (info) => {
    if (!badgeActive || (info.last_exec || 0) !== maxExec) return null
    return (info.defined_at || 0) === maxExec ? 'new' : 'changed'
  }

  // Invalidate cached rich detail when a variable's value changes. detailCache is
  // keyed by name only and never re-fetches once loaded, so a reassignment (e.g.
  // `df = <a different query>`) would otherwise keep showing the old schema. We
  // diff each variable's signature against the last render and evict changed ones;
  // if a changed variable is currently on screen we re-fetch its detail right away.
  const sigRef = useRef({})
  useEffect(() => {
    const stale = []
    const nextSigs = {}
    for (const [name, info] of entries) {
      const sig = varSignature(info)
      nextSigs[name] = sig
      const prevSig = sigRef.current[name]
      if (prevSig !== undefined && prevSig !== sig) stale.push(name)
    }
    sigRef.current = nextSigs
    if (stale.length === 0) return
    setDetailCache(prev => {
      if (!stale.some(n => prev[n])) return prev
      const next = { ...prev }
      for (const n of stale) delete next[n]
      return next
    })
    // Re-fetch immediately for any changed variable that's currently visible.
    for (const n of stale) {
      if ((n === expandedVar || n === viewerVar) && canFetch) {
        const info = variables[n]
        if (info && TABULAR_TYPES.has(info.type)) fetchDetail(n)
      }
    }
  }, [entries, variables, expandedVar, viewerVar, canFetch, fetchDetail])

  const filteredSorted = useMemo(() => {
    const q = search.trim().toLowerCase()
    let list = entries
    if (q) list = list.filter(([name, info]) =>
      name.toLowerCase().includes(q) || (info.type || '').toLowerCase().includes(q))
    const cmp = {
      name: (a, b) => a[0].localeCompare(b[0], undefined, { sensitivity: 'base' }),
      type: (a, b) => (a[1].type || '').localeCompare(b[1].type || '') || a[0].localeCompare(b[0]),
      size: (a, b) => sizeToBytes(b[1].size) - sizeToBytes(a[1].size),
    }[sortBy]
    return [...list].sort(cmp)
  }, [entries, search, sortBy])

  const groups = useMemo(() => {
    if (!grouped) return null
    const byKind = {}
    for (const entry of filteredSorted) {
      const k = kindOf(entry[1].type)
      ;(byKind[k] ||= []).push(entry)
    }
    return KIND_ORDER.filter(k => byKind[k]?.length).map(k => [k, byKind[k]])
  }, [grouped, filteredSorted])

  const renderRow = ([name, info]) => {
    const badge = badgeFor(info)
    return (
    <div key={name} className="var-item">
      <div className="var-item-row" onClick={() => toggleExpand(name, info.type)}>
        <span className="var-expand-icon">
          {expandedVar === name ? <IconChevronDown width={10} height={10} /> : <IconChevronRight width={10} height={10} />}
        </span>
        <span className={`var-type-icon ${getTypeColor(info.type)}`}>{getTypeIcon(info.type)}</span>
        <span className="var-name">{name}</span>
        {badge && <span className={`var-badge-dot var-badge-${badge}`} title={badge === 'new' ? 'Created in the last run' : 'Changed in the last run'} />}
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
          {/* Shape intentionally omitted here — already shown in the row header. */}

          {/* Provenance: jump to the cell that created / last modified this variable */}
          {cellLabel(info.defined_by) && (
            <div className="var-detail-row">
              <span className="var-detail-label">Defined in</span>
              <button className="var-prov-link" onClick={() => jumpToCell(info.defined_by)} title="Jump to the cell that created this variable">
                {cellLabel(info.defined_by)}
              </button>
            </div>
          )}
          {info.last_cell && info.last_cell !== info.defined_by && cellLabel(info.last_cell) && (
            <div className="var-detail-row">
              <span className="var-detail-label">Last modified in</span>
              <button className="var-prov-link" onClick={() => jumpToCell(info.last_cell)} title="Jump to the cell that last modified this variable">
                {cellLabel(info.last_cell)}
              </button>
            </div>
          )}

          {/* Column schema (DataFrame/Series) — lazily fetched */}
          {TABULAR_TYPES.has(info.type) && (() => {
            const d = detailCache[name]
            if (d?.loading) return <div className="var-schema-loading">Loading schema…</div>
            const schema = d?.data?.schema
            if (!schema || schema.length === 0) return null
            return (
              <div className="var-schema">
                <div className="var-schema-head">
                  <span className="var-schema-title">Columns</span>
                  <span className="var-schema-count">{schema.length}</span>
                </div>
                {schema.slice(0, 30).map((c, i) => (
                  <div key={i} className="var-schema-row">
                    <span className="var-schema-col" title={c.column}>{c.column}</span>
                    <span className="var-schema-dtype" title={c.display_dtype && c.display_dtype !== c.dtype ? `pandas dtype: ${c.dtype}` : undefined}>{c.display_dtype || c.dtype}</span>
                    <span className="var-schema-meta">
                      {c.null_pct > 0 ? `${c.null_pct}% null` : 'no nulls'}
                      {c.unique != null ? ` · ${c.unique.toLocaleString()} uniq` : ''}
                    </span>
                  </div>
                ))}
                {schema.length > 30 && <div className="var-schema-more">… {schema.length - 30} more columns</div>}
              </div>
            )
          })()}

          {/* Inline preview only for non-tabular types — DataFrames/Series/arrays
              have the column schema above + the "View data" grid, so the small
              head(3) preview would just be redundant clutter. */}
          {!TABULAR_TYPES.has(info.type) && (
            <div className="var-detail-preview">
              <VariablePreviewRenderer info={info} />
            </div>
          )}

          <div className="var-actions">
            {TABULAR_TYPES.has(info.type) && (
              <button className="var-action-btn var-action-view" onClick={() => openViewer(name, info.type)} title="Open full data grid">
                <IconTable width={11} height={11} /> View data
              </button>
            )}
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
        </div>
      )}
    </div>
    )
  }



  return (
    <div className="sidebar-panel-content">
      <div className="sidebar-panel-header">
        <span className="sidebar-panel-title">Variables</span>
        <span className="sidebar-panel-count">{entries.length}</span>
        <button className="sidebar-panel-close" onClick={onClose} title="Close panel"><IconX width={12} height={12} /></button>
      </div>
      {activeTab && <div className="sidebar-scope-pill"><IconNotebook width={12} height={12} /> {activeTab.name}</div>}

      {entries.length > 0 && (
        <div className="var-controls">
          <div className="var-search">
            <IconSearch width={12} height={12} />
            <input
              className="var-search-input"
              type="text"
              placeholder="Filter variables…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && <button className="var-search-clear" onClick={() => setSearch('')} title="Clear"><IconX width={10} height={10} /></button>}
          </div>
          <select className="var-sort-select" value={sortBy} onChange={(e) => setSortBy(e.target.value)} title="Sort by">
            <option value="name">Name</option>
            <option value="type">Type</option>
            <option value="size">Size</option>
          </select>
          <button
            className={`var-group-btn ${grouped ? 'active' : ''}`}
            onClick={() => setGrouped(g => !g)}
            title="Group by kind"
          ><IconBraces width={12} height={12} /></button>
        </div>
      )}

      <div className="sidebar-panel-body">
        {entries.length === 0 && (
          <div className="sidebar-empty">
            No variables defined yet. Execute a cell to see variables here.
          </div>
        )}
        {entries.length > 0 && filteredSorted.length === 0 && (
          <div className="sidebar-empty">No variables match “{search}”.</div>
        )}

        {grouped
          ? groups.map(([kind, items]) => (
              <div key={kind}>
                <div className="var-group-header">{kind}<span className="var-group-count">{items.length}</span></div>
                {items.map(renderRow)}
              </div>
            ))
          : filteredSorted.map(renderRow)}

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

      {/* Full data-grid viewer modal */}
      {viewerVar && (
        <VariableDetailModal
          name={viewerVar}
          endpoint={activeTab?.microvmEndpoint}
          sessionId={activeTab?.sessionId}
          onClose={() => setViewerVar(null)}
        />
      )}
    </div>
  )
}
