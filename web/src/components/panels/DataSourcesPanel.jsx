import { useState, useMemo } from 'react'
import { IconUpload, IconDatabase, IconBucket, IconRefresh, IconX, IconNotebook, IconTable, IconCode, IconFolderOpen } from '../Icons'
import FileTypeIcon from './datasources/FileTypeIcon'
import SchemaExpander from './datasources/SchemaExpander'
import InsertChoicePopover from './datasources/InsertChoicePopover'
import EntityDocBadge from './datasources/EntityDocBadge'
import { PUBLIC_APIS } from './datasources/publicApis'

// Icon for a source-type group header, keyed by the provider's metadata `icon`.
// A new/unknown icon key falls back to a generic database glyph.
function GroupIcon({ iconKey, ...props }) {
  switch (iconKey) {
    case 's3': return <IconBucket {...props} className="sidebar-icon-s3" />
    case 'dynamodb': return <IconDatabase {...props} className="sidebar-icon-dynamodb" />
    case 'athena': return <IconTable {...props} className="sidebar-icon-athena" />
    case 'local': return <IconUpload {...props} className="sidebar-icon-file-csv" />
    default: return <IconDatabase {...props} />
  }
}

// Icon for an individual source row (S3 uses a file-type icon based on extension).
function RowIcon({ src }) {
  if (src.source_type === 's3') {
    return <span className="sidebar-file-icon sidebar-icon-s3"><FileTypeIcon filename={src.display_name} /></span>
  }
  if (src.source_type === 'athena') {
    return <span className="sidebar-file-icon sidebar-icon-athena"><IconTable width={13} height={13} /></span>
  }
  if (src.source_type === 'dynamodb') {
    return <span className="sidebar-file-icon sidebar-icon-dynamodb"><IconDatabase width={13} height={13} /></span>
  }
  return <span className="sidebar-file-icon"><IconDatabase width={13} height={13} /></span>
}

// Secondary meta line for a source row, composed from the generic detail plus a
// type-specific hint (region for DynamoDB, database for Athena).
function sourceMeta(src) {
  let meta = src.detail || src.size || ''
  if (src.source_type === 'dynamodb' && src.region) meta = meta ? `${meta} · ${src.region}` : src.region
  else if (src.source_type === 'athena' && src.database) meta = meta ? `${meta} · ${src.database}` : src.database
  return meta
}

// Entity-doc lookup key — matches the source_id convention used by
// batch/entity_discovery.py (DynamoDB docs are keyed "dynamodb.<table>").
function entityDocKey(src) {
  return src.source_type === 'dynamodb' ? `dynamodb.${src.source_id}` : src.source_id
}

// Build a nested folder tree from S3 sources using their key path (display_name,
// e.g. "samples/clickstream_events.csv"). Each node has { folders: Map, files: [] }.
// Files carry a _fileName (leaf label). Handles arbitrary nesting depth.
function buildS3Tree(srcs) {
  const root = { folders: new Map(), files: [] }
  for (const src of srcs) {
    const parts = (src.display_name || src.source_id || '').split('/').filter(Boolean)
    const fileName = parts.length ? parts.pop() : (src.display_name || src.source_id)
    let node = root
    for (const part of parts) {
      if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), files: [] })
      node = node.folders.get(part)
    }
    node.files.push({ ...src, _fileName: fileName })
  }
  return root
}

// Count all files in a tree node (recursively) — for the folder file-count badge.
function countS3Files(node) {
  let n = node.files.length
  for (const child of node.folders.values()) n += countS3Files(child)
  return n
}

export default function DataSourcesPanel({
  uploadedFiles,
  onUploadFile,
  onDeleteFile,
  onDeleteS3File,
  onInsertCode,
  activeTab,
  sources = [],
  sourceTypes = [],
  dsLoading,
  catalogEntries = [],
  fetchDataSources,
  onClose,
}) {
  const [sandboxExpanded, setSandboxExpanded] = useState(true)
  const [publicApisExpanded, setPublicApisExpanded] = useState(true)
  // Collapse state for the registry-driven cloud source groups, keyed by source_type.
  const [collapsedGroups, setCollapsedGroups] = useState(() => new Set())
  // Collapse state for S3 folder nodes in the tree view, keyed by full folder path.
  const [collapsedFolders, setCollapsedFolders] = useState(() => new Set())
  const [activePopover, setActivePopover] = useState(null) // key of item with open popover

  const toggleGroup = (st) => setCollapsedGroups(prev => {
    const next = new Set(prev)
    next.has(st) ? next.delete(st) : next.add(st)
    return next
  })

  const toggleFolder = (path) => setCollapsedFolders(prev => {
    const next = new Set(prev)
    next.has(path) ? next.delete(path) : next.add(path)
    return next
  })

  // Group discovered sources by source_type for generic rendering.
  const sourcesByType = useMemo(() => {
    const map = {}
    for (const src of sources) {
      (map[src.source_type] ||= []).push(src)
    }
    return map
  }, [sources])

  // Build a lookup map from source_id → entity doc metadata (from the enriched catalog)
  const entityDocMap = useMemo(() => {
    const map = {}
    for (const entry of catalogEntries) {
      if (entry.has_entity_doc) {
        map[entry.source_id] = {
          business_description: entry.business_description || '',
          quality_flags: entry.quality_flags || [],
        }
      }
    }
    return map
  }, [catalogEntries])

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

  // Render a single discovered-source row (shared by flat groups + S3 tree leaves).
  // displayName overrides the visible label (e.g. just the filename in the tree);
  // indentPx adds left padding for tree nesting.
  const renderSourceRow = (src, displayName = null, indentPx = 0) => {
    const key = `${src.source_type}-${src.source_id}`
    const eKey = entityDocKey(src)
    return (
      <div
        key={key}
        className="sidebar-file-item sidebar-ds-clickable"
        style={indentPx ? { paddingLeft: `${indentPx}px` } : undefined}
        onClick={() => setActivePopover(activePopover === key ? null : key)}
        title={`Click to insert code for ${src.display_name}`}
      >
        <RowIcon src={src} />
        <div className="sidebar-file-info">
          <span className="sidebar-file-name">{displayName || src.display_name}</span>
          <span className="sidebar-file-meta">{sourceMeta(src)}</span>
        </div>
        {src.source_type === 's3' && src.deletable && onDeleteS3File && (
          <button
            className="sidebar-file-delete"
            onClick={(e) => { e.stopPropagation(); onDeleteS3File(src) }}
            title="Delete file from S3"
          >
            <IconX width={11} height={11} />
          </button>
        )}
        <SchemaExpander sourceType={src.source_type} sourceId={src.source_id} onInsertCode={onInsertCode} />
        {entityDocMap[eKey] && (
          <EntityDocBadge
            sourceId={eKey}
            businessDescription={entityDocMap[eKey].business_description}
            qualityFlags={entityDocMap[eKey].quality_flags}
            sessionId={activeTab?.sessionId}
          />
        )}
        {activePopover === key && (
          <InsertChoicePopover
            sourceType={src.source_type}
            sourceId={src.source_id}
            onInsert={onInsertCode}
            onClose={() => setActivePopover(null)}
          />
        )}
      </div>
    )
  }

  // Render an S3 folder tree node recursively: folders (collapsible) then files.
  const renderS3Node = (node, pathPrefix, depth) => {
    const els = []
    for (const [folderName, child] of node.folders) {
      const fullPath = pathPrefix ? `${pathPrefix}/${folderName}` : folderName
      const collapsed = collapsedFolders.has(fullPath)
      els.push(
        <div
          key={`fold-${fullPath}`}
          className="ds-tree-folder"
          style={{ paddingLeft: `${12 + depth * 14}px` }}
          onClick={() => toggleFolder(fullPath)}
          title={`${fullPath}/`}
        >
          <span className="ds-tree-chevron">{collapsed ? '▸' : '▾'}</span>
          <IconFolderOpen width={12} height={12} className="sidebar-icon-s3" />
          <span className="ds-tree-folder-name">{folderName}/</span>
          <span className="ds-tree-folder-count">{countS3Files(child)}</span>
        </div>
      )
      if (!collapsed) els.push(...renderS3Node(child, fullPath, depth + 1))
    }
    for (const src of node.files) {
      els.push(renderSourceRow(src, src._fileName, 12 + depth * 14 + 16))
    }
    return els
  }

  return (
    <div className="sidebar-panel-content">
      <div className="sidebar-panel-header">
        <span className="sidebar-panel-title">Data Sources</span>
        <button className="sidebar-panel-action" onClick={fetchDataSources} title="Refresh">
          <IconRefresh width={14} height={14} />
        </button>
        <button className="sidebar-panel-action" onClick={handleFileUpload} title="Upload file">
          <IconUpload width={14} height={14} />
        </button>
        <button className="sidebar-panel-close" onClick={onClose} title="Close panel"><IconX width={12} height={12} /></button>
      </div>
      {activeTab && <div className="sidebar-scope-pill"><IconNotebook width={12} height={12} /> {activeTab.name}</div>}
      <div className="sidebar-panel-body">
        {/* Sandbox Files */}
        <div className="sidebar-subheader sidebar-subheader-toggle" onClick={() => setSandboxExpanded(!sandboxExpanded)}>
          <IconUpload width={11} height={11} className="sidebar-icon-file-csv" /> Sandbox Files <span className="sidebar-subheader-hint">local to VM</span>
          {uploadedFiles.length > 0 && <span className="sidebar-subheader-count">{uploadedFiles.length} files</span>}
          <span className="sidebar-subheader-chevron">{sandboxExpanded ? '▾' : '▸'}</span>
        </div>
        {sandboxExpanded && uploadedFiles.length > 0 ? (
          <>
            {uploadedFiles.map(file => (
              <div
                key={file.name}
                className="sidebar-file-item sidebar-ds-clickable"
                onClick={() => setActivePopover(activePopover === `file-${file.name}` ? null : `file-${file.name}`)}
                title={`Click to insert code for '/tmp/${file.name}'`}
              >
                <span className="sidebar-file-icon sidebar-icon-file-csv">
                  <FileTypeIcon filename={file.name} />
                </span>
                <div className="sidebar-file-info">
                  <span className="sidebar-file-name" title={file.name}>{file.name}</span>
                  <span className="sidebar-file-meta">{file.size} · {file.variable || 'uploading...'}</span>
                </div>
                <button
                  className="sidebar-file-delete"
                  onClick={(e) => { e.stopPropagation(); onDeleteFile(file.name) }}
                  title="Remove"
                >
                  <IconX width={11} height={11} />
                </button>
                {activeTab?.sessionId && (
                  <SchemaExpander sourceType="local" sourceId={`/tmp/${file.name}`} onInsertCode={onInsertCode} sessionId={activeTab.sessionId} />
                )}
                {entityDocMap[`/tmp/${file.name}`] && (
                  <EntityDocBadge
                    sourceId={`/tmp/${file.name}`}
                    businessDescription={entityDocMap[`/tmp/${file.name}`].business_description}
                    qualityFlags={entityDocMap[`/tmp/${file.name}`].quality_flags}
                    sessionId={activeTab?.sessionId}
                  />
                )}
                {activePopover === `file-${file.name}` && (
                  <InsertChoicePopover
                    sourceType="local"
                    sourceId={`/tmp/${file.name}`}
                    onInsert={onInsertCode}
                    onClose={() => setActivePopover(null)}
                  />
                )}
              </div>
            ))}
          </>
        ) : sandboxExpanded ? (
          <div className="sidebar-empty-inline">
            No files in sandbox.
            {activeTab?.status === 'connected' && (
              <span
                className="sidebar-load-samples-pill"
                onClick={async () => {
                  try {
                    const filenames = ['sales_targets_q3.csv', 'competitor_prices.csv']
                    for (const name of filenames) {
                      const resp = await fetch(`/samples/data/${name}`)
                      if (resp.ok) {
                        const blob = await resp.blob()
                        const file = new File([blob], name, { type: 'text/csv' })
                        onUploadFile(file)
                      }
                    }
                  } catch (err) {
                    console.error('Failed to load sample files:', err)
                  }
                }}
                title="Upload bundled sample data files to the sandbox"
              >
                Load samples
              </span>
            )}
          </div>
        ) : null}



        {/* Cloud data sources — rendered generically from the provider registry.
            Adding a new source type on the backend makes a new group appear here
            with no frontend change. 'local' is handled by the Sandbox section above. */}
        {sourceTypes.filter(st => st.source_type !== 'local').map(st => {
          const groupSources = sourcesByType[st.source_type] || []
          const collapsed = collapsedGroups.has(st.source_type)
          return (
            <div key={st.source_type}>
              <div className="sidebar-subheader sidebar-subheader-toggle" onClick={() => toggleGroup(st.source_type)}>
                <GroupIcon iconKey={st.icon} width={11} height={11} /> {st.display_name}
                {groupSources.length > 0 && <span className="sidebar-subheader-count">{groupSources.length}</span>}
                <span className="sidebar-subheader-chevron">{collapsed ? '▸' : '▾'}</span>
              </div>
              {!collapsed && (
                <>
                  {dsLoading && <div className="sidebar-empty-inline">Loading...</div>}
                  {!dsLoading && groupSources.length === 0 && (
                    <div className="sidebar-empty-inline">No {st.display_name} found.</div>
                  )}
                  {/* S3 renders a collapsible folder tree (grouped by prefix);
                      other source types render a flat list. */}
                  {st.source_type === 's3'
                    ? renderS3Node(buildS3Tree(groupSources), '', 0)
                    : groupSources.map(src => renderSourceRow(src))}
                </>
              )}
            </div>
          )
        })}

        {/* Public APIs */}
        <div className="sidebar-subheader sidebar-subheader-toggle" onClick={() => setPublicApisExpanded(!publicApisExpanded)}>
          🌐 Public APIs
          <span className="sidebar-subheader-count">{PUBLIC_APIS.length} sources</span>
          <span className="sidebar-subheader-chevron">{publicApisExpanded ? '▾' : '▸'}</span>
        </div>
        {publicApisExpanded && PUBLIC_APIS.map(api => (
          <div
            key={api.id}
            className="sidebar-file-item sidebar-ds-clickable"
            onClick={() => setActivePopover(activePopover === `api-${api.id}` ? null : `api-${api.id}`)}
            title={api.desc}
          >
            <span className="sidebar-file-icon">{api.icon}</span>
            <div className="sidebar-file-info">
              <span className="sidebar-file-name">{api.name}</span>
              <span className="sidebar-file-meta">{api.desc}</span>
            </div>
            {activePopover === `api-${api.id}` && (
              <div className="ds-insert-popover" ref={null}>
                <button className="ds-insert-btn ds-insert-python" onClick={(e) => { e.stopPropagation(); onInsertCode(api.code, 'code'); setActivePopover(null) }}>
                  <IconCode width={11} height={11} /> Python
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
