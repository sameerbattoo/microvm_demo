import { useState, useCallback } from 'react'
import { PROXY_URL } from '../../../config'

/**
 * SchemaExpander — lazy-loads and displays column schema for a data source.
 * Click the expand arrow to fetch schema from /datasources/schema endpoint.
 */
export default function SchemaExpander({ sourceType, sourceId, onInsertCode, sessionId }) {
  const [expanded, setExpanded] = useState(false)
  const [schema, setSchema] = useState(null)
  const [loading, setLoading] = useState(false)

  const loadSchema = useCallback(async () => {
    if (schema) { setExpanded(!expanded); return }
    setLoading(true)
    setExpanded(true)
    try {
      let url = `${PROXY_URL}/datasources/schema?source_type=${encodeURIComponent(sourceType)}&source_id=${encodeURIComponent(sourceId)}`
      if (sessionId) url += `&session_id=${encodeURIComponent(sessionId)}`
      const resp = await fetch(url)
      if (resp.ok) {
        setSchema(await resp.json())
      }
    } catch (e) {
      console.warn('Schema load failed:', e)
    }
    setLoading(false)
  }, [sourceType, sourceId, sessionId, schema, expanded])

  const handleColumnClick = (e, colName) => {
    e.stopPropagation()
    if (sourceType === 'athena') {
      onInsertCode(`SELECT ${colName} FROM ${sourceId} LIMIT 100`, 'sql')
    } else if (sourceType === 'dynamodb') {
      onInsertCode(`SELECT ${colName} FROM dynamodb."${sourceId}" LIMIT 10`, 'sql')
    } else {
      onInsertCode(`SELECT ${colName} FROM '${sourceId}' LIMIT 100`, 'sql')
    }
  }

  return (
    <>
      <button className="ds-schema-toggle" onClick={(e) => { e.stopPropagation(); loadSchema() }} title="Show columns">
        {expanded ? '▾' : '▸'}
      </button>
      {expanded && (
        <div className="ds-schema-panel" onClick={(e) => e.stopPropagation()}>
          {loading && <div className="ds-schema-loading">Loading schema...</div>}
          {schema && schema.columns && (
            <>
              {schema.row_count != null && (
                <div className="ds-schema-meta">{schema.row_count.toLocaleString()} rows · {schema.size || ''}</div>
              )}
              <div className="ds-schema-columns">
                {schema.columns.map((col, i) => (
                  <div key={i} className="ds-schema-col" onClick={(e) => handleColumnClick(e, col.name)} title={`Click to query ${col.name}`}>
                    <span className="ds-col-name">{col.name}</span>
                    <span className={`ds-col-type ds-type-${col.dtype}`}>{col.dtype}</span>
                    {col.sample && <span className="ds-col-sample">{col.sample}</span>}
                  </div>
                ))}
              </div>
            </>
          )}
          {schema && (!schema.columns || schema.columns.length === 0) && (
            <div className="ds-schema-loading">No columns found</div>
          )}
        </div>
      )}
    </>
  )
}
