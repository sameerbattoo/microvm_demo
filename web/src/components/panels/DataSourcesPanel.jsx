import { useState } from 'react'
import { IconUpload, IconFile, IconDatabase, IconBucket, IconRefresh, IconX, IconNotebook, IconTable } from '../Icons'

const PUBLIC_APIS = [
  { id: 'worldbank', name: 'World Bank', icon: '🌍', desc: 'Country indicators & economics', code: `import pandas as pd, requests\n\n# Indicators: NY.GDP.MKTP.CD=GDP($), SP.POP.TOTL=Population, EN.ATM.CO2E.KT=CO2 emissions\ndef world_bank(indicator='NY.GDP.MKTP.CD', country='all', date='2018:2023'):\n    url = f'https://api.worldbank.org/v2/country/{country}/indicator/{indicator}?date={date}&format=json&per_page=300'\n    resp = requests.get(url).json()\n    df = pd.DataFrame(resp[1])[['country','date','value']]\n    df['country'] = df['country'].apply(lambda x: x['value'])\n    return df.dropna(subset=['value'])\n\ndf = world_bank()  # GDP in current US$ for all countries\ndf.head(20)` },
  { id: 'countries', name: 'World Countries', icon: '🗺️', desc: '200+ countries with region, income, capital', code: `import pandas as pd, requests\n\nresp = requests.get('https://api.worldbank.org/v2/country/all?format=json&per_page=300').json()\ndf = pd.DataFrame(resp[1])[['name','region','capitalCity','incomeLevel','longitude','latitude']]\ndf['region'] = df['region'].apply(lambda x: x['value'])\ndf['incomeLevel'] = df['incomeLevel'].apply(lambda x: x['value'])\ndf = df[df['capitalCity'] != '']  # Filter out aggregates\ndf.head(20)` },
  { id: 'coingecko', name: 'CoinGecko', icon: '💰', desc: 'Cryptocurrency market data', code: `import pandas as pd, requests\n\nresp = requests.get('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=50').json()\ndf = pd.DataFrame(resp)[['name','symbol','current_price','market_cap','price_change_percentage_24h','total_volume']]\ndf.head(20)` },
  { id: 'openmeteo', name: 'Open-Meteo', icon: '🌤️', desc: 'Weather forecast & historical data', code: `import pandas as pd, requests\n\ndef weather_forecast(lat, lon, days=7):\n    """Hourly weather forecast. Cities: NYC(40.71,-74.01), London(51.5,-0.12), Tokyo(35.68,139.69)"""\n    url = f'https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&hourly=temperature_2m,precipitation,wind_speed_10m&timezone=auto&forecast_days={days}'\n    data = requests.get(url).json()\n    df = pd.DataFrame(data['hourly'])\n    df['time'] = pd.to_datetime(df['time'])\n    return df\n\ndf = weather_forecast(40.71, -74.01)  # New York\ndf.head(20)` },
  { id: 'earthquakes', name: 'USGS Earthquakes', icon: '🌋', desc: 'Recent seismic activity worldwide', code: `import pandas as pd, requests\n\ndef earthquakes(min_mag='4.5', period='month'):\n    """Seismic activity.\n    min_mag: '1.0', '2.5', '4.5', or 'significant' (only these are valid)\n    period: 'hour', 'day', 'week', or 'month'"""\n    valid_mags = ['1.0', '2.5', '4.5', 'significant']\n    if min_mag not in valid_mags:\n        raise ValueError(f'min_mag must be one of {valid_mags}')\n    url = f'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/{min_mag}_{period}.geojson'\n    data = requests.get(url).json()\n    eqs = pd.json_normalize(data['features'])\n    df = eqs[['properties.mag','properties.place','properties.time']].copy()\n    df.columns = ['magnitude','place','time']\n    df['time'] = pd.to_datetime(df['time'], unit='ms')\n    return df.sort_values('magnitude', ascending=False)\n\ndf = earthquakes('4.5', 'month')\ndf.head(20)` },
  { id: 'nasa', name: 'NASA APOD', icon: '🚀', desc: 'Astronomy Picture of the Day', code: `import pandas as pd, requests\n\ndef nasa_apod(count=20):\n    """Astronomy Picture of the Day. count: number of random entries to fetch"""\n    resp = requests.get(f'https://api.nasa.gov/planetary/apod?api_key=DEMO_KEY&count={count}').json()\n    return pd.DataFrame(resp)[['date','title','url','explanation']]\n\ndf = nasa_apod(20)\ndf` },
  { id: 'openlibrary', name: 'Open Library', icon: '📚', desc: 'Search books and authors', code: `import pandas as pd, requests\n\ndef search_books(query='machine learning', limit=20):\n    """Search Open Library. Returns title, author, year, editions."""\n    resp = requests.get(f'https://openlibrary.org/search.json?q={query}&limit={limit}').json()\n    df = pd.DataFrame(resp['docs'])[['title','author_name','first_publish_year','edition_count']]\n    df['author_name'] = df['author_name'].apply(lambda x: x[0] if isinstance(x, list) and x else None)\n    return df.sort_values('edition_count', ascending=False)\n\ndf = search_books('machine learning', 20)\ndf` },
  { id: 'publicholidays', name: 'Public Holidays', icon: '📅', desc: 'Holidays by country and year', code: `import pandas as pd, requests\n\ndef public_holidays(country='US', year=2025):\n    """Get holidays. Countries: US, GB, DE, FR, JP, IN, AU, CA"""\n    resp = requests.get(f'https://date.nager.at/api/v3/publicholidays/{year}/{country}').json()\n    return pd.DataFrame(resp)[['date','localName','name','countryCode']]\n\ndf = public_holidays('US', 2025)\ndf` },
]

const SAMPLE_DATA_FILES = [
  { name: 'sales_data.csv', size: '500 rows', desc: 'Orders with products, regions, discounts' },
  { name: 'customers.csv', size: '200 rows', desc: 'Customer data (some messy values)' },
  { name: 'web_traffic.csv', size: '730 rows', desc: 'Daily visitors over 2 years' },
  { name: 'ab_test_results.csv', size: '1000 rows', desc: 'A/B test conversion data' },
]

export default function DataSourcesPanel({
  uploadedFiles,
  onUploadFile,
  onDeleteFile,
  onUploadSampleData,
  onInsertCode,
  activeTab,
  s3Files,
  dynamoTables,
  athenaTables,
  athenaWorkgroup,
  dsLoading,
  fetchDataSources,
  onClose,
}) {
  const [sampleDataExpanded, setSampleDataExpanded] = useState(true)
  const [s3Expanded, setS3Expanded] = useState(true)
  const [dynamoExpanded, setDynamoExpanded] = useState(true)
  const [athenaExpanded, setAthenaExpanded] = useState(true)
  const [publicApisExpanded, setPublicApisExpanded] = useState(true)

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
                  <span className="sidebar-file-meta">{file.size} · {file.variable || 'uploading...'}</span>
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
          <div className="sidebar-empty-inline">No files in sandbox.</div>
        )}

        {/* Sample Data */}
        <div className="sidebar-subheader sidebar-subheader-toggle" onClick={() => setSampleDataExpanded(!sampleDataExpanded)}>
          <IconFile width={11} height={11} /> Sample Data
          <span className="sidebar-subheader-chevron">{sampleDataExpanded ? '▾' : '▸'}</span>
        </div>
        {sampleDataExpanded && SAMPLE_DATA_FILES.map(sample => (
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
                onClick={() => onInsertCode && onInsertCode(`import boto3, pandas as pd\n\ndef read_s3_csv(bucket, key):\n    obj = boto3.client('s3').get_object(Bucket=bucket, Key=key)\n    return pd.read_csv(obj['Body'])\n\ndf = read_s3_csv('${file.bucket}', '${file.key}')\ndf.head()`)}
                title={`Click to insert code: read '${file.key}' from S3`}
              >
                <span className="sidebar-file-icon sidebar-icon-s3"><IconFile width={13} height={13} /></span>
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
                onClick={() => onInsertCode && onInsertCode(`import boto3, pandas as pd\n\ndef scan_dynamodb(table_name, region='${table.region}'):\n    table = boto3.resource('dynamodb', region_name=region).Table(table_name)\n    return pd.DataFrame(table.scan()['Items'])\n\ndf = scan_dynamodb('${table.name}')\ndf.head()`)}
                title={`Click to insert code for table '${table.name}'`}
              >
                <span className="sidebar-file-icon sidebar-icon-dynamodb"><IconDatabase width={13} height={13} /></span>
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
                onClick={() => onInsertCode && onInsertCode(`import boto3, pandas as pd, time\n\ndef athena_query(sql, workgroup='${athenaWorkgroup}', region='${table.region}'):\n    c = boto3.client('athena', region_name=region)\n    eid = c.start_query_execution(QueryString=sql, WorkGroup=workgroup)['QueryExecutionId']\n    while c.get_query_execution(QueryExecutionId=eid)['QueryExecution']['Status']['State'] in ('QUEUED','RUNNING'): time.sleep(0.5)\n    rows = c.get_query_results(QueryExecutionId=eid)['ResultSet']['Rows']\n    header = [col['VarCharValue'] for col in rows[0]['Data']]\n    data = [[col.get('VarCharValue','') for col in row['Data']] for row in rows[1:]]\n    return pd.DataFrame(data, columns=header)\n\ndf = athena_query("SELECT * FROM ${table.database}.${table.name} LIMIT 100")\ndf`)}
                title={`Click to query ${table.database}.${table.name} (${table.column_count} columns)`}
              >
                <span className="sidebar-file-icon sidebar-icon-athena"><IconTable width={13} height={13} /></span>
                <div className="sidebar-file-info">
                  <span className="sidebar-file-name">{table.name}</span>
                  <span className="sidebar-file-meta">{table.column_count} cols · {table.database}</span>
                </div>
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
            onClick={() => onInsertCode && onInsertCode(api.code)}
            title={api.desc}
          >
            <span className="sidebar-file-icon">{api.icon}</span>
            <div className="sidebar-file-info">
              <span className="sidebar-file-name">{api.name}</span>
              <span className="sidebar-file-meta">{api.desc}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
