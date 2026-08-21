import { useState, useEffect, useMemo, memo } from 'react'
import { marked } from 'marked'
import { sanitizeMarkdown } from '../services/sanitize'
import MarkdownCell from './MarkdownCell'
import CellEditor from './CellEditor'
import { IconPlay, IconTrash, IconX, IconStop, IconChevronDown, IconChevronRight, IconGripVertical, IconEraser, IconCode, IconDatabase, IconPencil } from './Icons'
import ParamWidgets from './ParamWidgets'
import CellOutput from './CellOutput'
import VariableDetailModal from './VariableDetailModal'
import { useCellAI } from '../hooks/useCellAI'
import './Cell.css'
import './CellEditor.css'

// Compact type icons for the per-cell "variables defined here" chips.
const VAR_TYPE_ICONS = {
  DataFrame: '📊', Series: '📈', ndarray: '🔢', list: '[ ]', dict: '{ }',
  tuple: '( )', str: 'abc', int: '#', float: '#.', bool: '⊘', NoneType: '∅',
}
function getVarTypeIcon(type) { return VAR_TYPE_ICONS[type] || '◇' }

// Derive a default variable name from SQL (based on the primary table being queried)
function deriveSqlVarName(sql) {
  if (!sql || !sql.trim()) return 'result'
  // Try to extract table name from FROM clause
  const fromMatch = sql.match(/\bFROM\s+dynamodb\."?([a-zA-Z_][\w\-]*)"?/i)
    || sql.match(/\bFROM\s+'\/tmp\/([^']+)'/i)
    || sql.match(/\bFROM\s+read_(?:csv|json|parquet)\('[^']*\/([^'/]+)'\)/i)
    || sql.match(/\bFROM\s+[a-zA-Z_]\w*\.([a-zA-Z_]\w*)/i)
    || sql.match(/\bFROM\s+([a-zA-Z_]\w*)/i)
  if (fromMatch) {
    const raw = fromMatch[1] || 'result'
    // Sanitize: remove extension, replace non-identifier chars with underscore
    const cleaned = raw.replace(/\.\w+$/, '').replace(/[^a-zA-Z0-9_]/g, '_').replace(/^_+|_+$/g, '')
    if (cleaned && /^[a-zA-Z_]/.test(cleaned)) return cleaned
  }
  return 'result'
}

// Ticking timer component for running cells
function ElapsedTimer() {
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    const start = Date.now()
    const interval = setInterval(() => {
      setElapsed(((Date.now() - start) / 1000).toFixed(1))
    }, 500)
    return () => clearInterval(interval)
  }, [])
  return <span className="cell-timer">{elapsed}s</span>
}

export default memo(function Cell({
  cell,
  index,
  isConnected,
  isActive,
  isDragOver,
  hasSearchMatch,
  onFocus,
  onExecute,
  onInterrupt,
  onCodeChange,
  onOutputVarChange,
  onAddBelow,
  onInsertAbove,
  onSetAiExplanation,
  onDelete,
  onClearOutput,
  onTypeChange,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  searchQuery,
  searchActiveOccurrence,
  notebookContext,
  notebookName,
  microvmId,
  sessionId,
  aiAvailable,
  variables = {},
  microvmEndpoint,
  dataSources = null,
}) {
  const [codeCollapsed, setCodeCollapsed] = useState(false)
  const [outputCollapsed, setOutputCollapsed] = useState(false)
  const [varsCollapsed, setVarsCollapsed] = useState(false)
  // Inline editing of the AI comment (✨ note). When saved with changes we mark the
  // cell aiExplanationEdited so a "Manually edited" badge shows next to the AI badge.
  const [editingExplain, setEditingExplain] = useState(false)
  const [explainDraft, setExplainDraft] = useState('')

  // Variable names for autocomplete
  const variableNames = useMemo(() => Object.keys(variables || {}), [variables])

  // --- Per-cell variables (Option A): what this cell defined/modified. ---
  // Derived from provenance (defined_by / modified_by / last_cell) so it survives
  // reload/restore and stays consistent with the Variables panel. A chip is
  // "openable" only when this cell still owns the variable's current value
  // (last_cell === cell.id); otherwise the value was replaced by a later cell, so
  // we grey it out and show a jump link to the cell that owns the value now.
  const [cellViewerVar, setCellViewerVar] = useState(null)

  const cellIndexById = useMemo(() => {
    const m = new Map()
    ;(notebookContext || []).forEach((c, i) => m.set(String(c.id), i))
    return m
  }, [notebookContext])

  const cellVars = useMemo(() => {
    if (cell.type === 'sql' || cell.type === 'markdown') return []
    const cid = String(cell.id)
    const out = []
    for (const [name, info] of Object.entries(variables || {})) {
      const definedHere = String(info.defined_by) === cid
      const modifiedHere = Array.isArray(info.modified_by) && info.modified_by.some(c => String(c) === cid)
      const ownsNow = String(info.last_cell) === cid
      if (!definedHere && !modifiedHere && !ownsNow) continue
      const ownerIdx = cellIndexById.get(String(info.last_cell))
      out.push({
        name,
        type: info.type,
        shape: info.shape,
        kind: definedHere ? 'defined' : 'modified',
        ownsNow,
        replacedById: info.last_cell,
        replacedByLabel: ownsNow || ownerIdx == null ? null : `Cell ${ownerIdx + 1}`,
      })
    }
    // Defined first, then modified; alphabetical within each group.
    out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : (a.kind === 'defined' ? -1 : 1)))
    return out
  }, [variables, cell.id, cell.type, cellIndexById])

  const jumpToCell = (targetId) => {
    const el = document.querySelector(`[data-cell-id="${targetId}"]`)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  // Datasource identifiers for autocomplete (table names, file paths, schemas)
  const dataSourceNames = useMemo(() => {
    if (!dataSources) return { items: [], schemas: {} }
    const items = []
    const schemas = {} // schema_name → [table_names]

    // S3 files — suggest the read_csv('s3://...') pattern
    if (dataSources.s3) {
      dataSources.s3.forEach(f => {
        const uri = f.uri || `s3://${f.bucket}/${f.key}`
        items.push({ label: uri, type: 's3', detail: 'S3 file' })
      })
    }

    // Local sandbox files — suggest '/tmp/filename'
    // (uploadedFiles come separately but we get them from the sidebar sync)

    // DynamoDB tables — schema is "dynamodb", table names need quotes
    if (dataSources.dynamodb) {
      items.push({ label: 'dynamodb', type: 'schema', detail: 'DynamoDB schema' })
      const dynTables = []
      dataSources.dynamodb.forEach(t => {
        const name = t.name || t.table_name || t
        const label = typeof name === 'string' ? name : String(name)
        dynTables.push(label)
        items.push({ label: `dynamodb."${label}"`, type: 'dynamodb', detail: 'DynamoDB table' })
      })
      schemas['dynamodb'] = dynTables
    }

    // Athena tables — schema is the database name (from API response)
    if (dataSources.athena && dataSources.athena.length > 0) {
      const dbName = dataSources.athena[0]?.database
      if (dbName) {
        items.push({ label: dbName, type: 'schema', detail: 'Athena database' })
        const athenaTables = []
        dataSources.athena.forEach(t => {
          const name = t.name || t.table_name || t
          const label = typeof name === 'string' ? name : String(name)
          athenaTables.push(label)
          items.push({ label, type: 'athena', detail: 'Athena table' })
          items.push({ label: `${dbName}.${label}`, type: 'athena', detail: 'Athena (qualified)' })
        })
        schemas[dbName] = athenaTables
      } else {
        // No database name — just add raw table names
        dataSources.athena.forEach(t => {
          const name = t.name || t.table_name || t
          const label = typeof name === 'string' ? name : String(name)
          items.push({ label, type: 'athena', detail: 'Athena table' })
        })
      }
    }

    // Build column map from catalog entries (for column-level autocomplete)
    // columns: { "table_name": ["col1", "col2", ...], "dynamodb.table": [...], ... }
    const columns = {}
    if (dataSources._catalog?.entries) {
      for (const entry of dataSources._catalog.entries) {
        if (entry.status === 'discovered' && entry.columns?.length > 0) {
          const colNames = entry.columns.map(c => c.name)
          // Key by display_name (bare table name) for easy lookup
          columns[entry.display_name] = colNames
          // Also key by source_id for qualified references
          columns[entry.source_id] = colNames
        }
      }
    }
    // Also extract Athena columns from the basic /datasources response (always available)
    if (dataSources.athena) {
      dataSources.athena.forEach(t => {
        if (t.columns?.length > 0 && !columns[t.name]) {
          columns[t.name] = t.columns.map(c => c.name || c)
        }
      })
    }

    return { items, schemas, columns }
  }, [dataSources])

  // AI + execution routing (smart execute / explain / fix / generate) lives in a hook.
  const {
    aiResult, setAiResult, generating, editorVersion,
    smartExecute, handleAiFix, handleAiCancel, handleApplyFix,
  } = useCellAI({
    cell, index, isConnected, aiAvailable, microvmId, sessionId,
    variables, dataSources, notebookContext,
    onExecute, onCodeChange, onClearOutput, onInsertAbove,
  })

  const statusColor =
    cell.status === 'running' ? 'cell-running'
    : cell.status === 'success' ? 'cell-success'
    : cell.status === 'error' ? 'cell-error'
    : 'cell-idle'

  // --- MARKDOWN CELL ---
  if (cell.type === 'markdown') {
    return (
      <MarkdownCell
        cell={cell}
        isActive={isActive}
        isDragOver={isDragOver}
        hasSearchMatch={hasSearchMatch}
        searchQuery={searchQuery}
        onFocus={onFocus}
        onCodeChange={onCodeChange}
        onAddBelow={onAddBelow}
        onDelete={onDelete}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onDragEnd={onDragEnd}
      />
    )
  }

  // --- CODE CELL ---

  return (
    <div
      className={`cell ${statusColor} ${isActive ? 'cell-active' : ''} ${isDragOver ? 'cell-drag-over' : ''} ${hasSearchMatch ? 'cell-search-match' : ''} ${cell.type === 'sql' ? 'cell-sql' : ''}`}
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
        <button
          className="cell-collapse-btn"
          onClick={() => setCodeCollapsed(!codeCollapsed)}
          title={codeCollapsed ? 'Expand code' : 'Collapse code'}
        >
          {codeCollapsed ? <IconChevronRight width={12} height={12} /> : <IconChevronDown width={12} height={12} />}
        </button>
        <span className="cell-number">
          {cell.executionNumber ? `[${cell.executionNumber}]` : `[${index + 1}]`}
        </span>
        <span className={`cell-type-badge ${cell.type === 'sql' ? 'cell-type-sql' : cell.type === 'markdown' ? 'cell-type-md' : 'cell-type-code'}`} title={cell.type === 'sql' ? 'SQL cell' : cell.type === 'markdown' ? 'Markdown cell' : 'Python cell'}>
          {cell.type === 'sql'
            ? <><IconDatabase width={10} height={10} /><span className="cell-type-label">SQL</span></>
            : cell.type === 'markdown'
              ? <><IconPencil width={10} height={10} /><span className="cell-type-label">MD</span></>
              : <><IconCode width={10} height={10} /><span className="cell-type-label">PY</span></>
          }
        </span>
        {cell.status === 'running' && <ElapsedTimer />}
        {cell.lastExecutedCode != null && cell.code !== cell.lastExecutedCode && cell.status !== 'running' && (
          <span className="cell-stale-badge" title="Code modified since last execution — re-run to update output">●</span>
        )}
      </div>

      <div className="cell-content">
        {/* Collapsed code summary */}
        {codeCollapsed && (
          <div className="cell-collapsed-summary" onClick={() => setCodeCollapsed(false)}>
            <span className="cell-collapsed-text">
              {cell.code.split('\n')[0].slice(0, 80)}{cell.code.split('\n').length > 1 ? '...' : ''}
            </span>
            <span className="cell-collapsed-lines">{cell.code.split('\n').length} lines</span>
          </div>
        )}

        {/* Code editor */}
        {!codeCollapsed && cell.type !== 'markdown' && cell.code && cell.code.includes('@param') && (
          <ParamWidgets
            code={cell.code}
            onCodeChange={onCodeChange}
            onExecute={smartExecute}
          />
        )}
        {/* SQL result-variable bar — full-width row above the editor */}
        {!codeCollapsed && cell.type === 'sql' && (
          <div className="sql-output-var">
            <span className="sql-output-var-label">→</span>
            <input
              className="sql-output-var-input"
              type="text"
              value={cell.outputVariable || ''}
              onChange={(e) => onOutputVarChange && onOutputVarChange(e.target.value)}
              placeholder={deriveSqlVarName(cell.code)}
              title="Variable name for the query result (accessible in subsequent cells)"
              spellCheck={false}
            />
          </div>
        )}
        {!codeCollapsed && (
          <div className="cell-input">
            <CellEditor
              key={editorVersion}
              code={cell.code}
              language={cell.type === 'sql' ? 'sql' : 'python'}
              placeholder={cell.type === 'sql'
                ? 'Write SQL or describe what you want... (Shift+Enter runs or generates)'
                : 'Type Python code or describe what you want in plain English... (Shift+Enter runs code or generates from NLP)'}
              onCodeChange={onCodeChange}
              onExecute={smartExecute}
              onFocus={onFocus}
              variables={variableNames}
              dataSources={dataSourceNames}
              sessionId={sessionId}
              searchQuery={searchQuery}
              searchActiveOccurrence={searchActiveOccurrence}
            />
            <div className="cell-actions">
              {cell.status === 'running' || generating ? (
                <button
                  className="cell-run-btn cell-stop-btn"
                  onClick={generating ? () => {} : onInterrupt}
                  title={generating ? 'Generating code...' : 'Stop execution'}
                >
                  {generating ? <span className="cell-gen-spinner" /> : <IconStop width={12} height={12} />}
                </button>
              ) : (
                <button
                  className="cell-run-btn"
                  onClick={smartExecute}
                  disabled={!isConnected || cell.status === 'running'}
                  title="Run cell (Shift+Enter)"
                >
                  <IconPlay width={12} height={12} />
                </button>
              )}
              <button className="cell-action-btn" onClick={(e) => { e.stopPropagation(); onAddBelow('code') }} title="Add code cell below">
                <IconCode width={14} height={14} />
              </button>
              <button className="cell-action-btn cell-add-sql-btn" onClick={(e) => { e.stopPropagation(); onAddBelow('sql') }} title="Add SQL cell below">
                <IconDatabase width={12} height={12} />
              </button>
              <button className="cell-action-btn cell-add-md-btn" onClick={(e) => { e.stopPropagation(); onAddBelow('markdown') }} title="Add text cell below">
                M
              </button>
              <button className="cell-action-btn cell-delete-btn" onClick={(e) => { e.stopPropagation(); onDelete() }} title="Delete cell">
                <IconTrash width={14} height={14} />
              </button>
              {aiAvailable && cell.code?.trim() && cell.error && (
                <button
                  className="cell-action-btn cell-ai-action-btn cell-ai-fix-btn"
                  onClick={(e) => { e.stopPropagation(); handleAiFix() }}
                  disabled={aiResult?.loading}
                  title="Fix error with AI"
                >🔧</button>
              )}
            </div>
          </div>
        )}

        {(cell.output || cell.error || cell.html || cell.image) && (
          <div className={`cell-output ${cell.error ? 'cell-output-error' : ''} ${outputCollapsed ? 'cell-output-collapsed' : ''}`}>
            {outputCollapsed ? (
              <div className="cell-output-collapse-bar" onClick={() => setOutputCollapsed(false)}>
                <IconChevronRight width={10} height={10} />
                <span>Output hidden — click to expand</span>
              </div>
            ) : (
              <>
                <div className="cell-output-collapse-bar" onClick={() => setOutputCollapsed(true)}>
                  <IconChevronDown width={10} height={10} />
                  <span>Output</span>
                  <div className="cell-output-actions" onClick={(e) => e.stopPropagation()}>
                    <div className="cell-output-export-wrap">
                      <button className="cell-output-action-btn" title="Export output" onClick={(e) => {
                        e.stopPropagation()
                        const menu = e.currentTarget.nextElementSibling
                        menu.style.display = menu.style.display === 'block' ? 'none' : 'block'
                      }}>
                        <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Export
                      </button>
                      <div className="cell-output-export-menu" style={{ display: 'none' }}>
                        <button onClick={() => {
                          const filename = `${(notebookName || 'notebook').replace(/\s+/g, '-')}-cell-${index + 1}-output.html`
                          let htmlContent = `<html><head><meta charset="UTF-8"><title>${notebookName || 'Notebook'} — Cell ${index + 1}</title><style>body{font-family:system-ui;padding:20px;max-width:900px;margin:0 auto}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:8px;text-align:left}th{background:#f5f5f5;font-weight:600}pre{background:#f5f5f5;padding:12px;border-radius:4px;overflow-x:auto;font-size:13px}details{margin-bottom:16px;border:1px solid #e0e0e0;border-radius:4px}summary{padding:8px 12px;cursor:pointer;font-weight:600;font-size:13px;color:#555}details pre{margin:0;border-radius:0 0 4px 4px;border-top:1px solid #e0e0e0}img{max-width:100%}h3{color:#333;margin-top:0}</style></head><body>`
                          htmlContent += `<h3>${notebookName || 'Notebook'} — Cell ${index + 1} Output</h3>`
                          htmlContent += `<p style="color:#888;font-size:12px">Generated: ${new Date().toLocaleString()}</p>`
                          htmlContent += `<details><summary>Code</summary><pre>${(cell.code || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre></details>`
                          if (cell.output) htmlContent += `<pre>${cell.output}</pre>`
                          if (cell.html) htmlContent += cell.html
                          if (cell.image) htmlContent += `<img src="${cell.image}" alt="Plot output"/>`
                          htmlContent += `<hr style="margin-top:32px;border:none;border-top:1px solid #e0e0e0"><footer style="text-align:center;padding:12px;color:#888;font-size:11px"><strong>Lambda MicroVM Notebook</strong><br>Developed by the AWS Startup SA Team<br>&copy; ${new Date().getFullYear()} Amazon Web Services, Inc.</footer>`
                          htmlContent += '</body></html>'
                          const blob = new Blob([htmlContent], { type: 'text/html' })
                          const url = URL.createObjectURL(blob)
                          const a = document.createElement('a')
                          a.href = url; a.download = filename; a.click()
                          URL.revokeObjectURL(url)
                        }}>HTML</button>
                        <button onClick={() => {
                          const filename = `${(notebookName || 'notebook').replace(/\s+/g, '-')}-cell-${index + 1}-output.md`
                          let md = `# ${notebookName || 'Notebook'} — Cell ${index + 1}\n\n`
                          md += `*Generated: ${new Date().toLocaleString()}*\n\n`
                          md += `<details><summary>Code</summary>\n\n\`\`\`python\n${cell.code || ''}\n\`\`\`\n</details>\n\n`
                          md += `## Output\n\n`
                          if (cell.output) md += `\`\`\`\n${cell.output}\n\`\`\`\n\n`
                          if (cell.html) md += `*(DataFrame table — export as HTML for full rendering)*\n\n`
                          if (cell.image) md += `![Plot output](plot.png)\n\n`
                          if (!cell.output && !cell.html && !cell.image) md += '*(empty output)*\n'
                          md += `\n---\n\n*Lambda MicroVM Notebook — Developed by the AWS Startup SA Team*\n`
                          const blob = new Blob([md], { type: 'text/markdown' })
                          const url = URL.createObjectURL(blob)
                          const a = document.createElement('a')
                          a.href = url; a.download = filename; a.click()
                          URL.revokeObjectURL(url)
                        }}>Markdown</button>
                      </div>
                    </div>
                    {onClearOutput && (
                      <button className="cell-output-action-btn" onClick={() => onClearOutput()} title="Clear output">
                        <IconEraser width={11} height={11} /> Clear
                      </button>
                    )}
                    {cell.output && (
                      <button className="cell-output-action-btn" onClick={() => navigator.clipboard.writeText(cell.output)} title="Copy output">
                        <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg> Copy
                      </button>
                    )}
                  </div>
                </div>
                <CellOutput
                  cell={cell}
                  isConnected={isConnected}
                  onFix={handleAiFix}
                  aiBusy={aiResult?.loading}
                  aiFixing={aiResult?.loading && aiResult?.type === 'fix'}
                />
              </>
            )}
          </div>
        )}

        {/* Variables this cell defined/modified (code cells only). Clicking an
            owned variable opens the full tabular viewer; a variable whose value
            was later replaced is greyed with a jump link to the owning cell. */}
        {cellVars.length > 0 && (
          <div className={`cell-output ${varsCollapsed ? 'cell-output-collapsed' : ''}`}>
            {varsCollapsed ? (
              <div className="cell-output-collapse-bar" onClick={() => setVarsCollapsed(false)}>
                <IconChevronRight width={10} height={10} />
                <span>Variables hidden — click to expand</span>
              </div>
            ) : (
              <>
                <div className="cell-output-collapse-bar" onClick={() => setVarsCollapsed(true)}>
                  <IconChevronDown width={10} height={10} />
                  <span>Variables</span>
                </div>
                <div className="cell-vars-chips">
                  {cellVars.map(v => (
                v.ownsNow ? (
                  <button
                    key={v.name}
                    className={`cell-var-chip cell-var-${v.kind}`}
                    onClick={(e) => { e.stopPropagation(); setCellViewerVar(v.name) }}
                    title={`${v.kind === 'defined' ? 'Defined' : 'Modified'} here${v.type ? ` · ${v.type}` : ''}${v.shape ? ` · ${v.shape}` : ''} — click to inspect`}
                  >
                    <span className="cell-var-chip-icon">{getVarTypeIcon(v.type)}</span>
                    <span className="cell-var-chip-name">{v.name}</span>
                  </button>
                ) : (
                  <span
                    key={v.name}
                    className={`cell-var-chip cell-var-${v.kind} cell-var-replaced`}
                    title={`${v.name} was set here, but its current value was later replaced${v.replacedByLabel ? ` in ${v.replacedByLabel}` : ''}`}
                  >
                    <span className="cell-var-chip-icon">{getVarTypeIcon(v.type)}</span>
                    <span className="cell-var-chip-name">{v.name}</span>
                    {v.replacedByLabel && (
                      <>
                        <span className="cell-var-replaced-arrow">→</span>
                        <button
                          className="cell-var-replaced-link"
                          onClick={(e) => { e.stopPropagation(); jumpToCell(v.replacedById) }}
                          title={`Current value of ${v.name} is set in ${v.replacedByLabel} — jump there`}
                        >{v.replacedByLabel}</button>
                      </>
                    )}
                  </span>
                )
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {cellViewerVar && (
          <VariableDetailModal
            name={cellViewerVar}
            endpoint={microvmEndpoint}
            sessionId={sessionId}
            onClose={() => setCellViewerVar(null)}
          />
        )}

        {/* AI Result (explain or fix preview) — shown outside output section */}
        {aiResult?.loading && (
          <div className="cell-ai-result cell-ai-loading">
            <span className="cell-ai-spinner" />
            <span className="cell-ai-loading-text">{aiResult.type === 'fix' ? 'Fixing...' : 'Explaining...'}</span>
            <button className="cell-ai-cancel-btn" onClick={handleAiCancel}>Cancel</button>
          </div>
        )}
        {aiResult && !aiResult.loading && (
          <div className={`cell-ai-result cell-ai-result-${aiResult.type}`}>
            <div className="cell-ai-result-header">
              <span className="cell-ai-badge">✨ AI</span>
              {aiResult.type === 'explain' && cell.aiExplanationEdited && (
                <span className="cell-ai-badge cell-ai-badge-edited" title="This comment was manually edited">
                  <IconPencil width={9} height={9} /> Manually edited
                </span>
              )}
              <div className="cell-ai-header-actions">
                {aiResult.type === 'explain' && !editingExplain && (
                  <button
                    className="cell-ai-edit"
                    title="Edit comment"
                    onClick={() => { setExplainDraft(aiResult.content || ''); setEditingExplain(true) }}
                  >
                    <IconPencil width={11} height={11} />
                  </button>
                )}
                <button className="cell-ai-dismiss" onClick={() => { setEditingExplain(false); setAiResult(null); if (onSetAiExplanation) onSetAiExplanation(null) }}>
                  <IconX width={10} height={10} />
                </button>
              </div>
            </div>
            {aiResult.type === 'explain' && (
              editingExplain ? (
                <div className="cell-ai-explain-edit">
                  <textarea
                    className="cell-ai-explain-textarea"
                    value={explainDraft}
                    onChange={(e) => setExplainDraft(e.target.value)}
                    autoFocus
                    rows={Math.min(12, Math.max(3, explainDraft.split('\n').length + 1))}
                    placeholder="Describe this cell… (Markdown supported)"
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') { e.preventDefault(); setEditingExplain(false) }
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault()
                        const text = explainDraft.trim()
                        const changed = text !== (aiResult.content || '').trim()
                        setEditingExplain(false)
                        if (onSetAiExplanation) onSetAiExplanation(text || null, text ? (changed || !!cell.aiExplanationEdited) : false)
                      }
                    }}
                  />
                  <div className="cell-ai-explain-edit-actions">
                    <button
                      className="cell-ai-apply-btn"
                      onClick={() => {
                        const text = explainDraft.trim()
                        const changed = text !== (aiResult.content || '').trim()
                        setEditingExplain(false)
                        if (onSetAiExplanation) onSetAiExplanation(text || null, text ? (changed || !!cell.aiExplanationEdited) : false)
                      }}
                    >Save</button>
                    <button className="cell-ai-dismiss-btn" onClick={() => setEditingExplain(false)}>Cancel</button>
                  </div>
                </div>
              ) : (
                <div className="cell-ai-explain-text" dangerouslySetInnerHTML={{ __html: sanitizeMarkdown(marked.parse(aiResult.content, { breaks: true })) }} />
              )
            )}
            {aiResult.type === 'fix' && aiResult.content && (
              <div className="cell-ai-fix-preview">
                <pre className="cell-ai-fix-code">{aiResult.content}</pre>
                <div className="cell-ai-fix-actions">
                  <button className="cell-ai-apply-btn" onClick={handleApplyFix}>Apply Fix</button>
                  <button className="cell-ai-dismiss-btn" onClick={() => setAiResult(null)}>Dismiss</button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
})
