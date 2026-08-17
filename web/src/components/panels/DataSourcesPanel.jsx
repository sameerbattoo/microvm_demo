import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { IconUpload, IconFile, IconDatabase, IconBucket, IconRefresh, IconX, IconNotebook, IconTable, IconCode, IconSparkles } from '../Icons'
import { marked } from 'marked'
import { PROXY_URL } from '../../config'

// File type icon with color based on extension
function FileTypeIcon({ filename, width = 13, height = 13 }) {
  const ext = (filename || '').split('.').pop().toLowerCase()
  switch (ext) {
    case 'csv':
      return (
        <svg width={width} height={height} viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/>
        </svg>
      )
    case 'parquet':
      return (
        <svg width={width} height={height} viewBox="0 0 24 24" fill="none" stroke="#a78bfa" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><rect x="8" y="12" width="8" height="6" rx="1"/>
        </svg>
      )
    case 'json':
      return (
        <svg width={width} height={height} viewBox="0 0 24 24" fill="none" stroke="#fbbf24" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M8 16s.5-2 2-2 2 2 2 2 .5 2 2 2"/>
        </svg>
      )
    case 'xlsx': case 'xls':
      return (
        <svg width={width} height={height} viewBox="0 0 24 24" fill="none" stroke="#34d399" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M8 13h2l2 4 2-4h2"/>
        </svg>
      )
    default:
      return <IconFile width={width} height={height} />
  }
}

/**
 * SchemaExpander — lazy-loads and displays column schema for a data source.
 * Click the expand arrow to fetch schema from /datasources/schema endpoint.
 */
function SchemaExpander({ sourceType, sourceId, onInsertCode, sessionId }) {
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

/**
 * Small popover that appears on a datasource item click to let user choose Python or SQL insertion.
 * Fetches the code snippet from the backend DataSourceProvider.
 */
function InsertChoicePopover({ sourceType, sourceId, onInsert, onClose }) {
  const popRef = useRef(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const handleClick = (e) => {
      if (popRef.current && !popRef.current.contains(e.target)) onClose()
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [onClose])

  const handleInsert = async (language) => {
    setLoading(true)
    try {
      const resp = await fetch(
        `${PROXY_URL}/datasources/snippet?source_type=${encodeURIComponent(sourceType)}&source_id=${encodeURIComponent(sourceId)}&language=${language}`
      )
      if (resp.ok) {
        const data = await resp.json()
        onInsert(data.code, data.cell_type)
      }
    } catch (e) {
      console.warn('Snippet fetch failed:', e)
    }
    setLoading(false)
    onClose()
  }

  return (
    <div className="ds-insert-popover" ref={popRef}>
      <button className="ds-insert-btn ds-insert-python" onClick={() => handleInsert('python')} disabled={loading}>
        <IconCode width={11} height={11} /> Python
      </button>
      <button className="ds-insert-btn ds-insert-sql" onClick={() => handleInsert('sql')} disabled={loading}>
        <IconDatabase width={11} height={11} /> SQL
      </button>
    </div>
  )
}

/**
 * Strip the title heading (# entity_name) and "Data Quality" section from entity
 * markdown — title is already in the modal header, and quality flags are rendered
 * separately with colored indicators below the schema.
 */
function _stripTitleAndDataQuality(md) {
  if (!md) return ''
  // Remove the first # heading (entity name — already in modal header)
  let result = md.replace(/^#[^#\n].*\n+/, '')
  // Remove "## Data Quality" section (rendered separately with colored dots)
  result = result.replace(/## Data Quality[\s\S]*?(?=\n## |\n# |$)/, '')
  return result.trim()
}

/**
 * EntityDocBadge — shows a sparkle icon for entities that have AI-generated profiles.
 * Clicking shows a popover with business description and quality flags.
 * "View Full Profile" opens a modal with the full markdown.
 */
function EntityDocBadge({ sourceId, businessDescription, qualityFlags, sessionId }) {
  const [showPopover, setShowPopover] = useState(false)
  const [showModal, setShowModal] = useState(false)
  const [fullDoc, setFullDoc] = useState(null)
  const [loadingFull, setLoadingFull] = useState(false)
  const popRef = useRef(null)

  useEffect(() => {
    if (!showPopover) return
    const handleClick = (e) => {
      if (popRef.current && !popRef.current.contains(e.target)) setShowPopover(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [showPopover])

  const loadFullDoc = async () => {
    setLoadingFull(true)
    try {
      const resp = await fetch(`${PROXY_URL}/datasources/entity-doc?source_id=${encodeURIComponent(sourceId)}`, {
        headers: sessionId ? { 'X-Session-Id': sessionId } : {},
      })
      if (resp.ok) {
        const data = await resp.json()
        setFullDoc(data)
      }
    } catch (e) {
      console.warn('Failed to load entity doc:', e)
    }
    setLoadingFull(false)
    setShowModal(true)
    setShowPopover(false)
  }

  const severityColor = (sev) => {
    if (sev === 'high') return 'var(--accent-danger, #ff5c5c)'
    if (sev === 'medium') return 'var(--accent-warning, #f9a825)'
    return 'var(--text-muted)'
  }

  return (
    <>
      <button
        className="ds-entity-doc-badge"
        onClick={(e) => { e.stopPropagation(); setShowPopover(!showPopover) }}
        title="AI-profiled entity — click for details"
      >
        <IconSparkles width={12} height={12} />
      </button>
      {showPopover && (
        <div className="ds-entity-popover" ref={popRef} onClick={(e) => e.stopPropagation()}>
          <div className="ds-entity-popover-header">{sourceId.split('/').pop() || sourceId}</div>
          <div className="ds-entity-popover-desc">{businessDescription || 'No description available.'}</div>
          {qualityFlags && qualityFlags.length > 0 && (
            <div className="ds-entity-popover-flags">
              {qualityFlags.slice(0, 4).map((flag, i) => (
                <div key={i} className="ds-entity-flag">
                  <span className="ds-entity-flag-dot" style={{ background: severityColor(flag.severity) }} />
                  <span className="ds-entity-flag-text">{flag.detail || flag.type}</span>
                </div>
              ))}
              {qualityFlags.length > 4 && <div className="ds-entity-flag-more">+{qualityFlags.length - 4} more</div>}
            </div>
          )}
          <button className="ds-entity-popover-full" onClick={loadFullDoc} disabled={loadingFull}>
            {loadingFull ? 'Loading...' : 'View Full Profile'}
          </button>
        </div>
      )}
      {showModal && (
        <div className="ds-entity-modal-overlay" onClick={() => setShowModal(false)}>
          <div className="ds-entity-modal" onClick={(e) => e.stopPropagation()}>
            <div className="ds-entity-modal-header">
              <span>{sourceId.split('/').pop() || sourceId}</span>
              <button onClick={() => setShowModal(false)}><IconX width={14} height={14} /></button>
            </div>
            <div className="ds-entity-modal-body">
              <div dangerouslySetInnerHTML={{ __html: marked(_stripTitleAndDataQuality(fullDoc?.markdown || '')) }} />
              {fullDoc?.quality_flags && fullDoc.quality_flags.length > 0 && (
                <div className="ds-entity-modal-flags">
                  <div className="ds-entity-modal-flags-title">Data Quality</div>
                  {fullDoc.quality_flags.map((flag, i) => (
                    <div key={i} className="ds-entity-modal-flag">
                      <span className="ds-entity-flag-dot" style={{ background: severityColor(flag.severity) }} />
                      <span className="ds-entity-modal-flag-text">
                        <strong>{flag.column ? `${flag.column}` : flag.type}</strong> — {flag.detail}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}

const PUBLIC_APIS = [
  { id: 'worldbank', name: 'World Bank', icon: '🌍', desc: 'Country indicators & economics', code: `import pandas as pd, requests\n\n# Indicators: NY.GDP.MKTP.CD=GDP($), SP.POP.TOTL=Population, EN.ATM.CO2E.KT=CO2 emissions\ndef world_bank(indicator='NY.GDP.MKTP.CD', country='all', date='2018:2023'):\n    url = f'https://api.worldbank.org/v2/country/{country}/indicator/{indicator}?date={date}&format=json&per_page=300'\n    resp = requests.get(url, timeout=60).json()\n    df = pd.DataFrame(resp[1])[['country','date','value']]\n    df['country'] = df['country'].apply(lambda x: x['value'])\n    return df.dropna(subset=['value'])\n\ndf = world_bank()  # GDP in current US$ for all countries\ndf.head(20)` },
  { id: 'countries', name: 'World Countries', icon: '🗺️', desc: '200+ countries with region, income, capital', code: `import pandas as pd, requests\n\nresp = requests.get('https://api.worldbank.org/v2/country/all?format=json&per_page=300', timeout=60).json()\ndf = pd.DataFrame(resp[1])[['name','region','capitalCity','incomeLevel','longitude','latitude']]\ndf['region'] = df['region'].apply(lambda x: x['value'])\ndf['incomeLevel'] = df['incomeLevel'].apply(lambda x: x['value'])\ndf = df[df['capitalCity'] != '']  # Filter out aggregates\ndf.head(20)` },
  { id: 'coingecko', name: 'CoinGecko', icon: '💰', desc: 'Cryptocurrency market data', code: `import pandas as pd, requests\n\nresp = requests.get('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=50', timeout=60).json()\ndf = pd.DataFrame(resp)[['name','symbol','current_price','market_cap','price_change_percentage_24h','total_volume']]\ndf.head(20)` },
  { id: 'openmeteo', name: 'Open-Meteo', icon: '🌤️', desc: 'Weather forecast & historical data', code: `import pandas as pd, requests\n\ndef weather_forecast(lat, lon, days=7):\n    """Hourly weather forecast. Cities: NYC(40.71,-74.01), London(51.5,-0.12), Tokyo(35.68,139.69)"""\n    url = f'https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&hourly=temperature_2m,precipitation,wind_speed_10m&timezone=auto&forecast_days={days}'\n    data = requests.get(url, timeout=60).json()\n    df = pd.DataFrame(data['hourly'])\n    df['time'] = pd.to_datetime(df['time'])\n    return df\n\ndf = weather_forecast(40.71, -74.01)  # New York\ndf.head(20)` },
  { id: 'earthquakes', name: 'USGS Earthquakes', icon: '🌋', desc: 'Recent seismic activity worldwide', code: `import pandas as pd, requests\n\ndef earthquakes(min_mag='4.5', period='month'):\n    """Seismic activity.\n    min_mag: '1.0', '2.5', '4.5', or 'significant' (only these are valid)\n    period: 'hour', 'day', 'week', or 'month'"""\n    valid_mags = ['1.0', '2.5', '4.5', 'significant']\n    if min_mag not in valid_mags:\n        raise ValueError(f'min_mag must be one of {valid_mags}')\n    url = f'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/{min_mag}_{period}.geojson'\n    data = requests.get(url, timeout=60).json()\n    eqs = pd.json_normalize(data['features'])\n    df = eqs[['properties.mag','properties.place','properties.time']].copy()\n    df.columns = ['magnitude','place','time']\n    df['time'] = pd.to_datetime(df['time'], unit='ms')\n    return df.sort_values('magnitude', ascending=False)\n\ndf = earthquakes('4.5', 'month')\ndf.head(20)` },
  { id: 'nasa', name: 'NASA APOD', icon: '🚀', desc: 'Astronomy Picture of the Day', code: `import pandas as pd, requests\n\ndef nasa_apod(count=20):\n    """Astronomy Picture of the Day. count: number of random entries to fetch"""\n    resp = requests.get(f'https://api.nasa.gov/planetary/apod?api_key=DEMO_KEY&count={count}', timeout=60).json()\n    return pd.DataFrame(resp)[['date','title','url','explanation']]\n\ndf = nasa_apod(20)\ndf` },
  { id: 'openlibrary', name: 'Open Library', icon: '📚', desc: 'Search books and authors', code: `import pandas as pd, requests\n\ndef search_books(query='machine learning', limit=20):\n    """Search Open Library. Returns title, author, year, editions."""\n    resp = requests.get(f'https://openlibrary.org/search.json?q={query}&limit={limit}', timeout=60).json()\n    df = pd.DataFrame(resp['docs'])[['title','author_name','first_publish_year','edition_count']]\n    df['author_name'] = df['author_name'].apply(lambda x: x[0] if isinstance(x, list) and x else None)\n    return df.sort_values('edition_count', ascending=False)\n\ndf = search_books('machine learning', 20)\ndf` },
  { id: 'publicholidays', name: 'Public Holidays', icon: '📅', desc: 'Holidays by country and year', code: `import pandas as pd, requests\n\ndef public_holidays(country='US', year=2025):\n    """Get holidays. Countries: US, GB, DE, FR, JP, IN, AU, CA"""\n    resp = requests.get(f'https://date.nager.at/api/v3/publicholidays/{year}/{country}', timeout=60).json()\n    return pd.DataFrame(resp)[['date','localName','name','countryCode']]\n\ndf = public_holidays('US', 2025)\ndf` },
]



export default function DataSourcesPanel({
  uploadedFiles,
  onUploadFile,
  onDeleteFile,
  onInsertCode,
  activeTab,
  s3Files,
  dynamoTables,
  athenaTables,
  athenaWorkgroup,
  dsLoading,
  catalogEntries = [],
  fetchDataSources,
  onClose,
}) {
  const [sandboxExpanded, setSandboxExpanded] = useState(true)
  const [s3Expanded, setS3Expanded] = useState(true)
  const [dynamoExpanded, setDynamoExpanded] = useState(true)
  const [athenaExpanded, setAthenaExpanded] = useState(true)
  const [publicApisExpanded, setPublicApisExpanded] = useState(true)
  const [activePopover, setActivePopover] = useState(null) // key of item with open popover

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



        {/* S3 Bucket */}
        <div className="sidebar-subheader sidebar-subheader-toggle" onClick={() => setS3Expanded(!s3Expanded)}>
          <IconBucket width={11} height={11} className="sidebar-icon-s3" /> S3 Bucket
          {s3Files.length > 0 && <span className="sidebar-subheader-count">{s3Files.length} files</span>}
          <span className="sidebar-subheader-chevron">{s3Expanded ? '▾' : '▸'}</span>
        </div>
        {s3Expanded && (
          <>
            {dsLoading && <div className="sidebar-empty-inline">Loading...</div>}
            {!dsLoading && s3Files.length === 0 && <div className="sidebar-empty-inline">No S3 files found.</div>}
            {s3Files.map(file => (
              <div
                key={file.key}
                className="sidebar-file-item sidebar-ds-clickable"
                onClick={() => setActivePopover(activePopover === `s3-${file.key}` ? null : `s3-${file.key}`)}
                title={`Click to insert code: read '${file.key}' from S3`}
              >
                <span className="sidebar-file-icon sidebar-icon-s3"><FileTypeIcon filename={file.key} /></span>
                <div className="sidebar-file-info">
                  <span className="sidebar-file-name">{file.key}</span>
                  <span className="sidebar-file-meta">{file.size}</span>
                </div>
                <SchemaExpander sourceType="s3" sourceId={file.uri} onInsertCode={onInsertCode} />
                {entityDocMap[file.uri] && (
                  <EntityDocBadge
                    sourceId={file.uri}
                    businessDescription={entityDocMap[file.uri].business_description}
                    qualityFlags={entityDocMap[file.uri].quality_flags}
                    sessionId={activeTab?.sessionId}
                  />
                )}
                {activePopover === `s3-${file.key}` && (
                  <InsertChoicePopover
                    sourceType="s3"
                    sourceId={file.uri}
                    onInsert={onInsertCode}
                    onClose={() => setActivePopover(null)}
                  />
                )}
              </div>
            ))}
          </>
        )}

        {/* DynamoDB */}
        <div className="sidebar-subheader sidebar-subheader-toggle" onClick={() => setDynamoExpanded(!dynamoExpanded)}>
          <IconDatabase width={11} height={11} className="sidebar-icon-dynamodb" /> DynamoDB
          {dynamoTables.length > 0 && <span className="sidebar-subheader-count">{dynamoTables.length} tables</span>}
          <span className="sidebar-subheader-chevron">{dynamoExpanded ? '▾' : '▸'}</span>
        </div>
        {dynamoExpanded && (
          <>
            {dsLoading && <div className="sidebar-empty-inline">Loading...</div>}
            {!dsLoading && dynamoTables.length === 0 && <div className="sidebar-empty-inline">No DynamoDB tables found.</div>}
            {dynamoTables.map(table => (
              <div
                key={table.name}
                className="sidebar-file-item sidebar-ds-clickable"
                onClick={() => setActivePopover(activePopover === `dynamo-${table.name}` ? null : `dynamo-${table.name}`)}
                title={`Click to insert code for table '${table.name}'`}
              >
                <span className="sidebar-file-icon sidebar-icon-dynamodb"><IconDatabase width={13} height={13} /></span>
                <div className="sidebar-file-info">
                  <span className="sidebar-file-name">{table.name}</span>
                  <span className="sidebar-file-meta">{table.item_count} items · {table.region}</span>
                </div>
                <SchemaExpander sourceType="dynamodb" sourceId={table.name} onInsertCode={onInsertCode} />
                {entityDocMap[`dynamodb.${table.name}`] && (
                  <EntityDocBadge
                    sourceId={`dynamodb.${table.name}`}
                    businessDescription={entityDocMap[`dynamodb.${table.name}`].business_description}
                    qualityFlags={entityDocMap[`dynamodb.${table.name}`].quality_flags}
                    sessionId={activeTab?.sessionId}
                  />
                )}
                {activePopover === `dynamo-${table.name}` && (
                  <InsertChoicePopover
                    sourceType="dynamodb"
                    sourceId={table.name}
                    onInsert={onInsertCode}
                    onClose={() => setActivePopover(null)}
                  />
                )}
              </div>
            ))}
          </>
        )}

        {/* Athena */}
        <div className="sidebar-subheader sidebar-subheader-toggle" onClick={() => setAthenaExpanded(!athenaExpanded)}>
          <IconTable width={11} height={11} className="sidebar-icon-athena" /> Athena
          {athenaTables.length > 0 && <span className="sidebar-subheader-count">{athenaTables.length} tables</span>}
          <span className="sidebar-subheader-chevron">{athenaExpanded ? '▾' : '▸'}</span>
        </div>
        {athenaExpanded && (
          <>
            {dsLoading && <div className="sidebar-empty-inline">Loading...</div>}
            {!dsLoading && athenaTables.length === 0 && <div className="sidebar-empty-inline">No Athena tables found.</div>}
            {athenaTables.map(table => (
              <div
                key={`${table.database}.${table.name}`}
                className="sidebar-file-item sidebar-ds-clickable"
                onClick={() => setActivePopover(activePopover === `athena-${table.database}.${table.name}` ? null : `athena-${table.database}.${table.name}`)}
                title={`Click to query ${table.database}.${table.name} (${table.column_count} columns)`}
              >
                <span className="sidebar-file-icon sidebar-icon-athena"><IconTable width={13} height={13} /></span>
                <div className="sidebar-file-info">
                  <span className="sidebar-file-name">{table.name}</span>
                  <span className="sidebar-file-meta">{table.column_count} cols · {table.database}</span>
                </div>
                <SchemaExpander sourceType="athena" sourceId={`${table.database}.${table.name}`} onInsertCode={onInsertCode} />
                {entityDocMap[`${table.database}.${table.name}`] && (
                  <EntityDocBadge
                    sourceId={`${table.database}.${table.name}`}
                    businessDescription={entityDocMap[`${table.database}.${table.name}`].business_description}
                    qualityFlags={entityDocMap[`${table.database}.${table.name}`].quality_flags}
                    sessionId={activeTab?.sessionId}
                  />
                )}
                {activePopover === `athena-${table.database}.${table.name}` && (
                  <InsertChoicePopover
                    sourceType="athena"
                    sourceId={`${table.database}.${table.name}`}
                    onInsert={onInsertCode}
                    onClose={() => setActivePopover(null)}
                  />
                )}
              </div>
            ))}
          </>
        )}

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
