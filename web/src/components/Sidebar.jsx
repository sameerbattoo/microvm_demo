import { useState, useEffect, useCallback } from 'react'
import { IconUpload, IconFile, IconDatabase, IconBucket, IconRefresh, IconPlus, IconX, IconChevronDown, IconChevronRight, IconNotebook, IconServer, IconTable } from './Icons'
import { PROXY_URL } from '../config'
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
  onInsertCode,
  onShowInstances,
}) {
  const [notebooksExpanded, setNotebooksExpanded] = useState(true)
  const [dataSourcesExpanded, setDataSourcesExpanded] = useState(true)
  const [sampleNotebooksExpanded, setSampleNotebooksExpanded] = useState(true)
  const [sampleDataExpanded, setSampleDataExpanded] = useState(false)
  const [s3Expanded, setS3Expanded] = useState(false)
  const [dynamoExpanded, setDynamoExpanded] = useState(false)
  const [athenaExpanded, setAthenaExpanded] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [editValue, setEditValue] = useState('')

  // External data sources state
  const [s3Files, setS3Files] = useState([])
  const [dynamoTables, setDynamoTables] = useState([])
  const [athenaTables, setAthenaTables] = useState([])
  const [artifactBucket, setArtifactBucket] = useState('')
  const [athenaWorkgroup, setAthenaWorkgroup] = useState('microvm-demo')
  const [dsLoading, setDsLoading] = useState(false)
  const [dsFetched, setDsFetched] = useState(false)

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

  const fetchDataSources = useCallback(async () => {
    setDsLoading(true)
    try {
      const resp = await fetch(`${PROXY_URL}/datasources`)
      if (resp.ok) {
        const data = await resp.json()
        setS3Files(data.s3 || [])
        setDynamoTables(data.dynamodb || [])
        setAthenaTables(data.athena || [])
        setArtifactBucket(data.artifact_bucket || '')
        setAthenaWorkgroup(data.athena_workgroup || 'microvm-demo')
      }
    } catch {}
    setDsLoading(false)
    setDsFetched(true)
  }, [])

  // Lazy-load data sources when section is expanded
  useEffect(() => {
    if (dataSourcesExpanded && !dsFetched) {
      fetchDataSources()
    }
  }, [dataSourcesExpanded, dsFetched, fetchDataSources])

  const instanceList = Object.entries(instances)

  const samples = [
    { id: 'sales_analysis', name: 'Sales Data Analysis', icon: '📊', file: '/samples/sales_analysis.notebook.json' },
    { id: 'time_series', name: 'Time Series Forecasting', icon: '📈', file: '/samples/time_series.notebook.json' },
    { id: 'data_cleaning', name: 'Data Cleaning & Transform', icon: '🧹', file: '/samples/data_cleaning.notebook.json' },
    { id: 'statistical_analysis', name: 'Statistical Analysis', icon: '🔬', file: '/samples/statistical_analysis.notebook.json' },
    { id: 'public_apis', name: 'Public API Data Analysis', icon: '🌐', file: '/samples/public_apis.notebook.json' },
    { id: 'aws_data_sources', name: 'AWS Data Sources', icon: '☁️', file: '/samples/aws_data_sources.notebook.json' },
  ]

  const sampleDataFiles = [
    { name: 'sales_data.csv', size: '500 rows', desc: 'Orders with products, regions, discounts' },
    { name: 'customers.csv', size: '200 rows', desc: 'Customer data (some messy values)' },
    { name: 'web_traffic.csv', size: '730 rows', desc: 'Daily visitors over 2 years' },
    { name: 'ab_test_results.csv', size: '1000 rows', desc: 'A/B test conversion data' },
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
          <span className="sidebar-chevron">
            {notebooksExpanded ? <IconChevronDown /> : <IconChevronRight />}
          </span>
          <span className="sidebar-section-icon sidebar-icon-notebooks"><IconNotebook width={14} height={14} /></span>
          <span className="sidebar-section-title">Notebooks</span>
          <button
            className="sidebar-section-action"
            onClick={(e) => { e.stopPropagation(); onNewNotebook() }}
            title="New notebook"
          >
            <IconPlus width={14} height={14} />
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
                  <IconX width={12} height={12} />
                </button>
              </div>
            ))}
            {tabs.length === 0 && (
              <div className="sidebar-empty">No notebooks open</div>
            )}
          </div>
        )}
      </div>

      {/* Data Sources Section (unified: uploads + samples + S3 + DynamoDB) */}
      <div className="sidebar-section">
        <div className="sidebar-section-header" onClick={() => setDataSourcesExpanded(!dataSourcesExpanded)}>
          <span className="sidebar-chevron">
            {dataSourcesExpanded ? <IconChevronDown /> : <IconChevronRight />}
          </span>
          <span className="sidebar-section-icon sidebar-icon-datasources"><IconDatabase width={14} height={14} /></span>
          <span className="sidebar-section-title">Data Sources</span>
          <button
            className="sidebar-section-action"
            onClick={(e) => { e.stopPropagation(); fetchDataSources() }}
            title="Refresh data sources"
          >
            <IconRefresh width={14} height={14} />
          </button>
          <button
            className="sidebar-section-action"
            onClick={(e) => { e.stopPropagation(); handleFileUpload() }}
            title="Upload file"
          >
            <IconUpload width={14} height={14} />
          </button>
        </div>
        {dataSourcesExpanded && (
          <div className="sidebar-section-body">
            {/* Sandbox Files (local to VM) */}
            <div className="sidebar-subheader sidebar-subheader-toggle">
              <IconUpload width={11} height={11} className="sidebar-icon-file-csv" /> Sandbox Files <span className="sidebar-subheader-hint">local to VM</span>
            </div>
            {uploadedFiles.length > 0 ? (
              <>
                {uploadedFiles.map(file => (
                  <div
                    key={file.name}
                    className="sidebar-file-item sidebar-ds-clickable"
                    onClick={() => onInsertCode && onInsertCode(`import pandas as pd\n\n${file.variable || 'df'} = pd.read_csv('/tmp/${file.name}')\n${file.variable || 'df'}.head()`)}
                    title={`Click to insert: pd.read_csv('/tmp/${file.name}')`}
                  >
                    <span className="sidebar-file-icon sidebar-icon-file-csv">
                      <IconFile width={13} height={13} />
                    </span>
                    <div className="sidebar-file-info">
                      <span className="sidebar-file-name" title={file.name}>{file.name}</span>
                      <span className="sidebar-file-meta">
                        {file.size} · {file.variable || 'uploading...'}
                      </span>
                    </div>
                    <button
                      className="sidebar-file-delete"
                      onClick={(e) => { e.stopPropagation(); onDeleteFile(file.name) }}
                      title="Remove"
                    >
                      <IconX width={11} height={11} />
                    </button>
                  </div>
                ))}
              </>
            ) : (
              <div className="sidebar-empty-inline">
                No files in sandbox. Upload files to the VM's /tmp/ directory.
              </div>
            )}

            {/* Sample Data */}
            <div className="sidebar-subheader sidebar-subheader-toggle" onClick={() => setSampleDataExpanded(!sampleDataExpanded)}>
              <IconFile width={11} height={11} /> Sample Data
              <span className="sidebar-subheader-chevron">{sampleDataExpanded ? '▾' : '▸'}</span>
            </div>
            {sampleDataExpanded && (
              <>
                {sampleDataFiles.map(sample => (
                  <div
                    key={sample.name}
                    className="sidebar-file-item sidebar-sample-data"
                    onClick={() => onUploadSampleData(sample.name)}
                    title={sample.desc}
                  >
                    <span className="sidebar-file-icon sidebar-icon-file-csv">
                      <IconFile width={13} height={13} />
                    </span>
                    <div className="sidebar-file-info">
                      <span className="sidebar-file-name">{sample.name}</span>
                      <span className="sidebar-file-meta">{sample.size}</span>
                    </div>
                  </div>
                ))}
              </>
            )}

            {/* S3 Bucket */}
            <div className="sidebar-subheader sidebar-subheader-toggle" onClick={() => setS3Expanded(!s3Expanded)}>
              <IconBucket width={11} height={11} className="sidebar-icon-s3" /> S3 Bucket
              {s3Files.length > 0 && <span className="sidebar-subheader-count">{s3Files.length} {s3Files.length === 1 ? 'file' : 'files'}</span>}
              <span className="sidebar-subheader-chevron">{s3Expanded ? '▾' : '▸'}</span>
            </div>
            {s3Expanded && (
              <>
                {dsLoading && <div className="sidebar-empty-inline">Loading...</div>}
                {!dsLoading && s3Files.length === 0 && (
                  <div className="sidebar-empty-inline">No S3 files found.</div>
                )}
                {s3Files.map(file => (
                  <div
                    key={file.key}
                    className="sidebar-file-item sidebar-ds-clickable"
                    onClick={() => onInsertCode && onInsertCode(`import boto3, pandas as pd\n\ndef read_s3_csv(bucket, key):\n    obj = boto3.client('s3').get_object(Bucket=bucket, Key=key)\n    return pd.read_csv(obj['Body'])\n\ndf = read_s3_csv('${file.bucket}', '${file.key}')\ndf.head()`)}
                    title={`Click to insert code: read '${file.key}' from S3`}
                  >
                    <span className="sidebar-file-icon sidebar-icon-s3">
                      <IconFile width={13} height={13} />
                    </span>
                    <div className="sidebar-file-info">
                      <span className="sidebar-file-name">{file.key}</span>
                      <span className="sidebar-file-meta">{file.size}</span>
                    </div>
                  </div>
                ))}
              </>
            )}

            {/* DynamoDB */}
            <div className="sidebar-subheader sidebar-subheader-toggle" onClick={() => setDynamoExpanded(!dynamoExpanded)}>
              <IconDatabase width={11} height={11} className="sidebar-icon-dynamodb" /> DynamoDB
              {dynamoTables.length > 0 && <span className="sidebar-subheader-count">{dynamoTables.length} {dynamoTables.length === 1 ? 'table' : 'tables'}</span>}
              <span className="sidebar-subheader-chevron">{dynamoExpanded ? '▾' : '▸'}</span>
            </div>
            {dynamoExpanded && (
              <>
                {dsLoading && <div className="sidebar-empty-inline">Loading...</div>}
                {!dsLoading && dynamoTables.length === 0 && (
                  <div className="sidebar-empty-inline">No DynamoDB tables found.</div>
                )}
                {dynamoTables.map(table => (
                  <div
                    key={table.name}
                    className="sidebar-file-item sidebar-ds-clickable"
                    onClick={() => onInsertCode && onInsertCode(`import boto3, pandas as pd\n\ndef scan_dynamodb(table_name, region='${table.region}'):\n    table = boto3.resource('dynamodb', region_name=region).Table(table_name)\n    return pd.DataFrame(table.scan()['Items'])\n\ndf = scan_dynamodb('${table.name}')\ndf.head()`)}
                    title={`Click to insert code for table '${table.name}'`}
                  >
                    <span className="sidebar-file-icon sidebar-icon-dynamodb">
                      <IconDatabase width={13} height={13} />
                    </span>
                    <div className="sidebar-file-info">
                      <span className="sidebar-file-name">{table.name}</span>
                      <span className="sidebar-file-meta">{table.item_count} items · {table.region}</span>
                    </div>
                  </div>
                ))}
              </>
            )}

            {/* Athena */}
            <div className="sidebar-subheader sidebar-subheader-toggle" onClick={() => setAthenaExpanded(!athenaExpanded)}>
              <IconTable width={11} height={11} className="sidebar-icon-athena" /> Athena
              {athenaTables.length > 0 && <span className="sidebar-subheader-count">{athenaTables.length} {athenaTables.length === 1 ? 'table' : 'tables'}</span>}
              <span className="sidebar-subheader-chevron">{athenaExpanded ? '▾' : '▸'}</span>
            </div>
            {athenaExpanded && (
              <>
                {dsLoading && <div className="sidebar-empty-inline">Loading...</div>}
                {!dsLoading && athenaTables.length === 0 && (
                  <div className="sidebar-empty-inline">No Athena tables found.</div>
                )}
                {athenaTables.map(table => (
                  <div
                    key={`${table.database}.${table.name}`}
                    className="sidebar-file-item sidebar-ds-clickable"
                    onClick={() => onInsertCode && onInsertCode(`import boto3, pandas as pd, time\n\ndef athena_query(sql, workgroup='${athenaWorkgroup}', region='${table.region}'):\n    c = boto3.client('athena', region_name=region)\n    eid = c.start_query_execution(QueryString=sql, WorkGroup=workgroup)['QueryExecutionId']\n    while c.get_query_execution(QueryExecutionId=eid)['QueryExecution']['Status']['State'] in ('QUEUED','RUNNING'): time.sleep(0.5)\n    rows = c.get_query_results(QueryExecutionId=eid)['ResultSet']['Rows']\n    header = [col['VarCharValue'] for col in rows[0]['Data']]\n    data = [[col.get('VarCharValue','') for col in row['Data']] for row in rows[1:]]\n    return pd.DataFrame(data, columns=header)\n\ndf = athena_query("SELECT * FROM ${table.database}.${table.name} LIMIT 100")\ndf`)}
                    title={`Click to query ${table.database}.${table.name} (${table.column_count} columns)`}
                  >
                    <span className="sidebar-file-icon sidebar-icon-athena">
                      <IconTable width={13} height={13} />
                    </span>
                    <div className="sidebar-file-info">
                      <span className="sidebar-file-name">{table.name}</span>
                      <span className="sidebar-file-meta">{table.column_count} cols · {table.database}</span>
                    </div>
                  </div>
                ))}
              </>
            )}

          </div>
        )}
      </div>

      {/* Sample Notebooks Section */}
      <div className="sidebar-section">
        <div className="sidebar-section-header" onClick={() => setSampleNotebooksExpanded(!sampleNotebooksExpanded)}>
          <span className="sidebar-chevron">
            {sampleNotebooksExpanded ? <IconChevronDown /> : <IconChevronRight />}
          </span>
          <span className="sidebar-section-icon">💡</span>
          <span className="sidebar-section-title">Sample Notebooks</span>
        </div>
        {sampleNotebooksExpanded && (
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
        <span className="sidebar-footer-icon sidebar-icon-microvms">
          <IconServer width={14} height={14} />
        </span>
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
