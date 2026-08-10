import { useState } from 'react'
import { IconX, IconCode } from '../Icons'

const SNIPPETS = [
  {
    category: 'Data Loading',
    icon: '📦',
    items: [
      {
        name: 'read_local',
        desc: 'Read local file (CSV, Parquet, JSON, Excel)',
        code: `# Read a local file into a DataFrame\n# Supports: .csv, .parquet, .json, .xlsx\ndf = read_local('/tmp/your_file.csv')\ndf.head()`,
      },
      {
        name: 'read_s3_csv',
        desc: 'Read CSV from S3 bucket',
        code: `# Read a CSV file from S3\ndf = read_s3_csv("your-bucket", "path/to/file.csv")\ndf.head()`,
      },
      {
        name: 'read_s3_parquet',
        desc: 'Read Parquet from S3 bucket',
        code: `# Read a Parquet file from S3\ndf = read_s3_parquet("your-bucket", "path/to/file.parquet")\ndf.head()`,
      },
      {
        name: 'read_s3_json',
        desc: 'Read JSON/JSONL from S3',
        code: `# Read a JSON Lines file from S3\ndf = read_s3_json("your-bucket", "path/to/file.jsonl")\ndf.head()`,
      },
      {
        name: 'read_dynamodb',
        desc: 'Scan DynamoDB table',
        code: `# Scan a DynamoDB table into a DataFrame\ndf = read_dynamodb("your-table-name")\nprint(f"Loaded {len(df)} rows")\ndf.head()`,
      },
      {
        name: 'read_dynamodb_query',
        desc: 'Query DynamoDB with key condition',
        code: `# Query DynamoDB with a key condition\ndf = read_dynamodb_query(\n    "your-table-name",\n    "customer_id = :cid",\n    {":cid": "CUST-001"}\n)\ndf.head()`,
      },
      {
        name: 'read_athena',
        desc: 'Run Athena SQL query',
        code: `# Run an Athena SQL query\ndf = read_athena("SELECT * FROM sales_data LIMIT 100")\ndf.head()`,
      },
      {
        name: 'read_url',
        desc: 'Fetch data from URL',
        code: `# Fetch CSV data from a public URL\ndf = read_url("https://raw.githubusercontent.com/datasets/iris/master/data/iris.csv")\ndf.head()`,
      },
    ],
  },
  {
    category: 'Data Export',
    icon: '💾',
    items: [
      {
        name: 'to_s3_csv',
        desc: 'Upload DataFrame as CSV to S3',
        code: `# Upload DataFrame as CSV to S3\nuri = to_s3_csv(df, "your-bucket", "user-data/output.csv")\nprint(f"Uploaded to: {uri}")`,
      },
      {
        name: 'to_s3_parquet',
        desc: 'Upload DataFrame as Parquet to S3',
        code: `# Upload DataFrame as Parquet to S3 (smaller, faster)\nuri = to_s3_parquet(df, "your-bucket", "user-data/output.parquet")\nprint(f"Uploaded to: {uri}")`,
      },
      {
        name: 'to_s3_json',
        desc: 'Upload DataFrame as JSON to S3',
        code: `# Upload DataFrame as JSON to S3\nuri = to_s3_json(df, "your-bucket", "user-data/output.json")\nprint(f"Uploaded to: {uri}")`,
      },
      {
        name: 'to_local',
        desc: 'Save DataFrame to local file',
        code: `# Save DataFrame to a local file (auto-detects format)\nto_local(df, '/tmp/output.csv')\nto_local(df, '/tmp/output.parquet')`,
      },
    ],
  },
  {
    category: 'Visualization',
    icon: '📊',
    items: [
      {
        name: 'plot_line',
        desc: 'Interactive line chart',
        code: `# Interactive line chart with Plotly\nplot_line(df, x='date', y='revenue', color='product', title='Revenue Over Time')`,
      },
      {
        name: 'plot_bar',
        desc: 'Interactive bar chart',
        code: `# Interactive bar chart with Plotly\nplot_bar(df, x='product', y='revenue', color='region', title='Revenue by Product')`,
      },
      {
        name: 'plot_scatter',
        desc: 'Interactive scatter plot',
        code: `# Interactive scatter plot (size + color encoding)\nplot_scatter(df, x='age', y='revenue', size='quantity', color='country')`,
      },
      {
        name: 'plot_histogram',
        desc: 'Interactive histogram',
        code: `# Interactive histogram\nplot_histogram(df, 'revenue', bins=20, title='Revenue Distribution')`,
      },
      {
        name: 'plot_heatmap',
        desc: 'Pivot heatmap',
        code: `# Heatmap from a pivot table\nplot_heatmap(df, x='month', y='product', value='revenue', title='Sales Heatmap')`,
      },
    ],
  },
  {
    category: 'Utilities',
    icon: '🔧',
    items: [
      {
        name: 'get_env / secret',
        desc: 'Access an injected secret or env var',
        code: `# Access a secret or env var injected at launch\nimport os\n\n# Get a secret (configured in Connection Panel → Secrets & Env Vars)\napi_key = os.environ.get('MY_SECRET_NAME', '')\nprint(f"Secret loaded: {'✓' if api_key else '✗ not set'}")`,
      },
      {
        name: 'profile',
        desc: 'Quick data profiling (types, nulls, stats)',
        code: `# Profile a DataFrame: types, nulls, unique counts\nprofile(df)`,
      },
      {
        name: 'whoami',
        desc: 'Show current AWS account, region, role, bucket',
        code: `# Show current AWS identity and environment\ninfo = whoami()`,
      },
      {
        name: 'compare_df',
        desc: 'Compare two DataFrames (shape, nulls, columns)',
        code: `# Compare two DataFrames side-by-side\n# Useful for before/after cleaning checks\ncompare_df(df_raw, df_clean, "raw", "cleaned")`,
      },
      {
        name: 'list_s3',
        desc: 'List files in an S3 bucket/prefix',
        code: `# List objects in an S3 bucket\nfiles = list_s3("your-bucket", "data/")\nfiles`,
      },
      {
        name: 'head_s3',
        desc: 'Preview first N rows from S3 file',
        code: `# Preview first 5 rows of an S3 file without full download\nhead_s3("your-bucket", "data/large_file.csv", n=5)`,
      },
      {
        name: 'timer',
        desc: 'Decorator to measure function execution time',
        code: `# Time a function's execution\n@timer\ndef my_computation():\n    return sum(range(10**7))\n\nresult = my_computation()`,
      },
      {
        name: 'sample_data',
        desc: 'Load built-in sample dataset',
        code: `# Load a built-in sample dataset\n# Available: 'sales', 'customers', 'web_traffic', 'ab_test'\ndf = sample_data('sales')\ndf.head()`,
      },
    ],
  },
]

export default function SnippetsPanel({ onInsertCode, onClose }) {
  const [expanded, setExpanded] = useState({})

  const toggleCategory = (cat) => {
    setExpanded(prev => ({ ...prev, [cat]: !prev[cat] }))
  }

  return (
    <div className="sidebar-panel-content">
      <div className="sidebar-panel-header">
        <span className="sidebar-panel-title">Snippets</span>
        <span className="sidebar-panel-count">{SNIPPETS.reduce((n, c) => n + c.items.length, 0)} functions</span>
        <button className="sidebar-panel-close" onClick={onClose} title="Close panel">
          <IconX width={12} height={12} />
        </button>
      </div>
      <div className="sidebar-panel-body">
        <div className="sidebar-panel-hint" style={{ padding: '6px 12px', fontSize: '11px', color: 'var(--text-muted)' }}>
          Pre-loaded helper functions — click to insert into current cell.
        </div>
        {SNIPPETS.map(category => (
          <div key={category.category}>
            <div
              className="sidebar-subheader sidebar-subheader-toggle"
              onClick={() => toggleCategory(category.category)}
            >
              <span>{category.icon}</span>
              <span>{category.category}</span>
              <span className="sidebar-subheader-count">{category.items.length}</span>
              <span className="sidebar-subheader-chevron">{expanded[category.category] !== false ? '▾' : '▸'}</span>
            </div>
            {expanded[category.category] !== false && (
              <div className="snippets-list">
                {category.items.map(snippet => (
                  <div
                    key={snippet.name}
                    className="snippet-item"
                    onClick={() => onInsertCode(snippet.code)}
                    title={`Insert ${snippet.name}()`}
                  >
                    <div className="snippet-name">
                      <IconCode width={11} height={11} />
                      <code>{snippet.name}()</code>
                    </div>
                    <div className="snippet-desc">{snippet.desc}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
