"""
Notebook Helper Functions — Pre-loaded utility library.

These functions are available in every notebook cell without importing.
They wrap common data operations (load, save, plot, profile) into
simple one-liners that handle AWS auth, error formatting, and defaults.

Usage (in any cell):
    df = read_s3_csv("my-bucket", "data/sales.csv")
    df = read_dynamodb("my-table")
    plot_bar(df, x='product', y='revenue', title='Sales')
    to_s3_csv(df, "my-bucket", "exports/output.csv")
"""

import os
import io
import json

import boto3
import pandas as pd
import plotly.express as px

# Default AWS region from the execution role
_REGION = os.environ.get("AWS_REGION", "us-west-2")


# =============================================================================
# DATA LOADING — Read from various sources
# =============================================================================

def read_local(path: str) -> pd.DataFrame:
    """
    Read a local file into a DataFrame. Auto-detects format from extension.
    
    Supports: .csv, .parquet, .json, .xlsx, .xls
    
    Example:
        df = read_local('/tmp/sales_data.csv')
        df = read_local('/tmp/report.parquet')
    """
    ext = path.rsplit('.', 1)[-1].lower() if '.' in path else ''
    if ext == 'csv':
        return pd.read_csv(path)
    elif ext == 'parquet':
        return pd.read_parquet(path)
    elif ext == 'json':
        return pd.read_json(path)
    elif ext in ('xlsx', 'xls'):
        return pd.read_excel(path)
    else:
        # Try CSV as default
        return pd.read_csv(path)


def read_s3_csv(bucket: str, key: str, **kwargs) -> pd.DataFrame:
    """
    Read a CSV file from S3 into a DataFrame.
    
    Example:
        df = read_s3_csv("my-bucket", "data/sales.csv")
        df = read_s3_csv("my-bucket", "exports/report.csv", delimiter=';')
    """
    s3 = boto3.client('s3', region_name=_REGION)
    obj = s3.get_object(Bucket=bucket, Key=key)
    return pd.read_csv(obj['Body'], **kwargs)


def read_s3_parquet(bucket: str, key: str) -> pd.DataFrame:
    """
    Read a Parquet file from S3 into a DataFrame.
    
    Example:
        df = read_s3_parquet("my-bucket", "data/events.parquet")
    """
    s3 = boto3.client('s3', region_name=_REGION)
    obj = s3.get_object(Bucket=bucket, Key=key)
    return pd.read_parquet(io.BytesIO(obj['Body'].read()))


def read_s3_json(bucket: str, key: str, lines: bool = True) -> pd.DataFrame:
    """
    Read a JSON file from S3 into a DataFrame.
    
    Example:
        df = read_s3_json("my-bucket", "data/events.jsonl")
        df = read_s3_json("my-bucket", "data/config.json", lines=False)
    """
    s3 = boto3.client('s3', region_name=_REGION)
    obj = s3.get_object(Bucket=bucket, Key=key)
    return pd.read_json(obj['Body'], lines=lines)


def read_dynamodb(table_name: str, limit: int = None, region: str = None) -> pd.DataFrame:
    """
    Scan a DynamoDB table and return as a DataFrame.
    
    Example:
        df = read_dynamodb("microvm-demo-data")
        df = read_dynamodb("users-table", limit=100)
    """
    dynamodb = boto3.resource('dynamodb', region_name=region or _REGION)
    table = dynamodb.Table(table_name)
    
    items = []
    params = {}
    if limit:
        params['Limit'] = limit
    
    response = table.scan(**params)
    items.extend(response.get('Items', []))
    
    # Paginate if no limit set
    while 'LastEvaluatedKey' in response and not limit:
        response = table.scan(ExclusiveStartKey=response['LastEvaluatedKey'])
        items.extend(response.get('Items', []))
    
    return pd.DataFrame(items)


def read_dynamodb_query(table_name: str, key_condition: str, values: dict, region: str = None) -> pd.DataFrame:
    """
    Query a DynamoDB table with a key condition expression.
    
    Example:
        df = read_dynamodb_query(
            "orders-table",
            "customer_id = :cid",
            {":cid": "CUST-001"}
        )
    """
    dynamodb = boto3.resource('dynamodb', region_name=region or _REGION)
    table = dynamodb.Table(table_name)
    
    from boto3.dynamodb.conditions import Key
    response = table.query(
        KeyConditionExpression=key_condition,
        ExpressionAttributeValues=values,
    )
    return pd.DataFrame(response.get('Items', []))


def read_athena(sql: str, database: str = "microvm_demo_db", region: str = None) -> pd.DataFrame:
    """
    Run an Athena SQL query and return results as a DataFrame.
    
    Example:
        df = read_athena("SELECT * FROM sales_data LIMIT 100")
        df = read_athena("SELECT country, COUNT(*) FROM customers GROUP BY country")
    """
    import time
    
    athena = boto3.client('athena', region_name=region or _REGION)
    bucket = f"microvm-sandbox-artifacts-{boto3.client('sts').get_caller_identity()['Account']}-{region or _REGION}"
    
    response = athena.start_query_execution(
        QueryString=sql,
        QueryExecutionContext={'Database': database},
        WorkGroup='microvm-demo',
        ResultConfiguration={'OutputLocation': f's3://{bucket}/athena-results/'},
    )
    
    query_id = response['QueryExecutionId']
    
    # Wait for completion
    while True:
        status = athena.get_query_execution(QueryExecutionId=query_id)
        state = status['QueryExecution']['Status']['State']
        if state in ('SUCCEEDED', 'FAILED', 'CANCELLED'):
            break
        time.sleep(0.5)
    
    if state != 'SUCCEEDED':
        reason = status['QueryExecution']['Status'].get('StateChangeReason', 'Unknown')
        raise RuntimeError(f"Athena query failed: {reason}")
    
    # Fetch results
    results = athena.get_query_results(QueryExecutionId=query_id)
    columns = [col['Name'] for col in results['ResultSet']['ResultSetMetadata']['ColumnInfo']]
    rows = []
    for row in results['ResultSet']['Rows'][1:]:  # Skip header
        rows.append([field.get('VarCharValue', '') for field in row['Data']])
    
    return pd.DataFrame(rows, columns=columns)


def read_url(url: str, format: str = 'csv', **kwargs) -> pd.DataFrame:
    """
    Fetch data from a URL and return as a DataFrame.
    
    Example:
        df = read_url("https://raw.githubusercontent.com/datasets/iris/master/data/iris.csv")
        df = read_url("https://api.example.com/data.json", format='json')
    """
    if format == 'csv':
        return pd.read_csv(url, **kwargs)
    elif format == 'json':
        import requests
        data = requests.get(url).json()
        return pd.DataFrame(data)
    elif format == 'parquet':
        return pd.read_parquet(url)
    else:
        return pd.read_csv(url, **kwargs)


# =============================================================================
# DATA EXPORT — Write to S3 and local
# =============================================================================

def to_s3_csv(df: pd.DataFrame, bucket: str, key: str, index: bool = False) -> str:
    """
    Upload a DataFrame as CSV to S3.
    
    Example:
        to_s3_csv(df, "my-bucket", "user-data/output.csv")
    
    Returns the S3 URI of the uploaded file.
    """
    s3 = boto3.client('s3', region_name=_REGION)
    csv_buffer = io.StringIO()
    df.to_csv(csv_buffer, index=index)
    s3.put_object(Bucket=bucket, Key=key, Body=csv_buffer.getvalue(), ContentType='text/csv')
    return f"s3://{bucket}/{key}"


def to_s3_parquet(df: pd.DataFrame, bucket: str, key: str) -> str:
    """
    Upload a DataFrame as Parquet to S3.
    
    Example:
        to_s3_parquet(df, "my-bucket", "user-data/output.parquet")
    
    Returns the S3 URI of the uploaded file.
    """
    s3 = boto3.client('s3', region_name=_REGION)
    parquet_buffer = io.BytesIO()
    df.to_parquet(parquet_buffer, index=False)
    s3.put_object(Bucket=bucket, Key=key, Body=parquet_buffer.getvalue(), ContentType='application/octet-stream')
    return f"s3://{bucket}/{key}"


def to_s3_json(df: pd.DataFrame, bucket: str, key: str, orient: str = 'records') -> str:
    """
    Upload a DataFrame as JSON to S3.
    
    Example:
        to_s3_json(df, "my-bucket", "user-data/output.json")
    
    Returns the S3 URI of the uploaded file.
    """
    s3 = boto3.client('s3', region_name=_REGION)
    json_str = df.to_json(orient=orient, indent=2)
    s3.put_object(Bucket=bucket, Key=key, Body=json_str, ContentType='application/json')
    return f"s3://{bucket}/{key}"


def to_local(df: pd.DataFrame, path: str, index: bool = False) -> str:
    """
    Save a DataFrame to a local file. Auto-detects format from extension.
    
    Example:
        to_local(df, '/tmp/output.csv')
        to_local(df, '/tmp/output.parquet')
    """
    ext = path.rsplit('.', 1)[-1].lower() if '.' in path else 'csv'
    if ext == 'csv':
        df.to_csv(path, index=index)
    elif ext == 'parquet':
        df.to_parquet(path, index=False)
    elif ext == 'json':
        df.to_json(path, orient='records', indent=2)
    elif ext in ('xlsx', 'xls'):
        df.to_excel(path, index=index)
    else:
        df.to_csv(path, index=index)
    return path


# =============================================================================
# VISUALIZATION — One-liner Plotly charts
# =============================================================================

def _apply_dark_theme(fig):
    """Apply dark theme to a Plotly figure to match the notebook's dark UI."""
    fig.update_layout(
        template='plotly_dark',
        paper_bgcolor='rgba(0,0,0,0)',
        plot_bgcolor='rgba(0,0,0,0)',
    )
    return fig


def _auto_display(fig):
    """Auto-register a Plotly figure with the display system if available.
    
    This allows plot helpers to render charts even when called inside
    if/else blocks, loops, or functions (where the return value isn't
    captured as the cell's last expression).
    """
    import inspect
    # Walk up the entire call stack to find the executor-injected `display`
    frame = inspect.currentframe()
    try:
        f = frame.f_back  # skip _auto_display itself
        while f:
            display_fn = f.f_locals.get('display') or f.f_globals.get('display')
            if callable(display_fn):
                display_fn(fig)
                break
            f = f.f_back
    except Exception:
        pass
    finally:
        del frame


def plot_line(df: pd.DataFrame, x: str, y: str, color: str = None, title: str = None):
    """
    Interactive line chart.
    
    Example:
        plot_line(df, x='date', y='revenue', color='product', title='Revenue Over Time')
    """
    fig = px.line(df, x=x, y=y, color=color, title=title)
    _apply_dark_theme(fig)
    _auto_display(fig)
    return fig


def plot_bar(df: pd.DataFrame, x: str, y: str, color: str = None, title: str = None):
    """
    Interactive bar chart.
    
    Example:
        plot_bar(df, x='product', y='revenue', color='region', title='Revenue by Product')
    """
    fig = px.bar(df, x=x, y=y, color=color, title=title)
    _apply_dark_theme(fig)
    _auto_display(fig)
    return fig


def plot_scatter(df: pd.DataFrame, x: str, y: str, size: str = None, color: str = None, title: str = None):
    """
    Interactive scatter plot.
    
    Example:
        plot_scatter(df, x='age', y='revenue', size='quantity', color='country')
    """
    fig = px.scatter(df, x=x, y=y, size=size, color=color, title=title)
    _apply_dark_theme(fig)
    _auto_display(fig)
    return fig


def plot_histogram(df: pd.DataFrame, column: str, bins: int = 30, title: str = None):
    """
    Interactive histogram.
    
    Example:
        plot_histogram(df, 'revenue', bins=20, title='Revenue Distribution')
    """
    fig = px.histogram(df, x=column, nbins=bins, title=title)
    _apply_dark_theme(fig)
    _auto_display(fig)
    return fig


def plot_heatmap(df: pd.DataFrame, x: str, y: str, value: str, title: str = None):
    """
    Pivot and display as heatmap.
    
    Example:
        plot_heatmap(df, x='month', y='product', value='revenue', title='Sales Heatmap')
    """
    pivot = df.pivot_table(values=value, index=y, columns=x, aggfunc='sum')
    fig = px.imshow(pivot, title=title, color_continuous_scale='Blues', aspect='auto')
    _apply_dark_theme(fig)
    _auto_display(fig)
    return fig


# =============================================================================
# UTILITIES
# =============================================================================

def profile(df: pd.DataFrame) -> pd.DataFrame:
    """
    Quick data profiling: types, nulls, unique values, and basic stats.
    
    Example:
        profile(df)
    """
    stats = pd.DataFrame({
        'dtype': df.dtypes,
        'non_null': df.count(),
        'null_count': df.isnull().sum(),
        'null_pct': (df.isnull().sum() / len(df) * 100).round(1),
        'unique': df.nunique(),
        'sample': df.iloc[0] if len(df) > 0 else None,
    })
    
    print(f"Shape: {df.shape[0]} rows x {df.shape[1]} columns")
    print(f"Memory: {df.memory_usage(deep=True).sum() / 1024:.1f} KB")
    print()
    return stats


def whoami() -> dict:
    """
    Show current AWS identity: account, region, role, and artifacts bucket.
    
    Example:
        whoami()
    """
    sts = boto3.client('sts', region_name=_REGION)
    identity = sts.get_caller_identity()
    
    account = identity['Account']
    arn = identity['Arn']
    role = arn.split('/')[-2] if '/role/' in arn else arn.split('/')[-1]
    bucket = f"microvm-sandbox-artifacts-{account}-{_REGION}"
    
    info = {
        'account': account,
        'region': _REGION,
        'role': role,
        'arn': arn,
        'bucket': bucket,
    }
    
    print(f"  Account:  {account}")
    print(f"  Region:   {_REGION}")
    print(f"  Role:     {role}")
    print(f"  Bucket:   {bucket}")
    print(f"  ARN:      {arn}")
    
    return info


def sample_data(name: str = None) -> pd.DataFrame:
    """
    Load a built-in sample dataset from S3.
    
    Available: 'sales', 'customers', 'web_traffic', 'ab_test'
    
    Example:
        df = sample_data('sales')
        df = sample_data()  # lists available datasets
    """
    # Discover bucket from account
    try:
        sts = boto3.client('sts', region_name=_REGION)
        account = sts.get_caller_identity()['Account']
        bucket = f"microvm-sandbox-artifacts-{account}-{_REGION}"
    except Exception:
        bucket = None

    datasets = {
        'sales': {'local': '/tmp/sales_data.csv', 's3_key': 'samples/sales_data.csv'},
        'customers': {'local': '/tmp/customers.csv', 's3_key': 'samples/customers.csv'},
        'web_traffic': {'local': '/tmp/web_traffic.csv', 's3_key': 'samples/web_traffic.csv'},
        'ab_test': {'local': '/tmp/ab_test_results.csv', 's3_key': 'samples/ab_test_results.csv'},
    }
    
    if name is None:
        print("Available datasets:", ', '.join(datasets.keys()))
        print("Usage: df = sample_data('sales')")
        return None
    
    if name not in datasets:
        print(f"Dataset '{name}' not found. Available: {', '.join(datasets.keys())}")
        return None

    info = datasets[name]

    # Try local first (faster if already downloaded)
    if os.path.exists(info['local']):
        return pd.read_csv(info['local'])

    # Fall back to S3
    if bucket:
        try:
            df = read_s3_csv(bucket, info['s3_key'])
            # Cache locally for next time
            df.to_csv(info['local'], index=False)
            return df
        except Exception as e:
            print(f"  Warning: Could not load from S3: {e}")

    print(f"  Dataset '{name}' not available locally or from S3.")
    return None


def timer(func):
    """
    Decorator that prints execution time of a function.
    
    Example:
        @timer
        def heavy_computation():
            return sum(range(10**7))
        
        heavy_computation()
        # → heavy_computation took 0.42s
    """
    import functools
    import time as _time
    
    @functools.wraps(func)
    def wrapper(*args, **kwargs):
        start = _time.perf_counter()
        result = func(*args, **kwargs)
        elapsed = _time.perf_counter() - start
        print(f"  {func.__name__} took {elapsed:.2f}s")
        return result
    return wrapper


def compare_df(df1: pd.DataFrame, df2: pd.DataFrame, name1: str = "df1", name2: str = "df2") -> pd.DataFrame:
    """
    Compare two DataFrames and show differences in shape, columns, and values.
    
    Example:
        compare_df(before, after, "before_cleaning", "after_cleaning")
    """
    print(f"  {'':20s} {name1:>15s}  {name2:>15s}")
    print(f"  {'Rows':20s} {df1.shape[0]:>15,}  {df2.shape[0]:>15,}")
    print(f"  {'Columns':20s} {df1.shape[1]:>15,}  {df2.shape[1]:>15,}")
    print(f"  {'Memory (KB)':20s} {df1.memory_usage(deep=True).sum()/1024:>15.1f}  {df2.memory_usage(deep=True).sum()/1024:>15.1f}")
    print(f"  {'Null cells':20s} {df1.isnull().sum().sum():>15,}  {df2.isnull().sum().sum():>15,}")
    print(f"  {'Duplicated rows':20s} {df1.duplicated().sum():>15,}  {df2.duplicated().sum():>15,}")
    
    # Column differences
    cols1 = set(df1.columns)
    cols2 = set(df2.columns)
    added = cols2 - cols1
    removed = cols1 - cols2
    if added:
        print(f"\n  Added columns: {', '.join(sorted(added))}")
    if removed:
        print(f"\n  Removed columns: {', '.join(sorted(removed))}")
    
    return pd.DataFrame({
        'metric': ['rows', 'columns', 'memory_kb', 'nulls', 'duplicates'],
        name1: [df1.shape[0], df1.shape[1], df1.memory_usage(deep=True).sum()/1024, df1.isnull().sum().sum(), df1.duplicated().sum()],
        name2: [df2.shape[0], df2.shape[1], df2.memory_usage(deep=True).sum()/1024, df2.isnull().sum().sum(), df2.duplicated().sum()],
    })


def list_s3(bucket: str, prefix: str = "", max_keys: int = 100) -> pd.DataFrame:
    """
    List objects in an S3 bucket/prefix and return as a DataFrame.
    
    Example:
        files = list_s3("my-bucket", "data/")
        files = list_s3("my-bucket")  # list root
    """
    s3 = boto3.client('s3', region_name=_REGION)
    response = s3.list_objects_v2(Bucket=bucket, Prefix=prefix, MaxKeys=max_keys)
    
    items = []
    for obj in response.get('Contents', []):
        items.append({
            'key': obj['Key'],
            'size_mb': round(obj['Size'] / (1024 * 1024), 2),
            'last_modified': obj['LastModified'].strftime('%Y-%m-%d %H:%M'),
        })
    
    df = pd.DataFrame(items)
    if len(df) > 0:
        print(f"  {len(df)} objects in s3://{bucket}/{prefix} ({df['size_mb'].sum():.1f} MB total)")
    return df


def head_s3(bucket: str, key: str, n: int = 5) -> pd.DataFrame:
    """
    Preview first N rows of a CSV/Parquet file in S3 without downloading the full file.
    
    Example:
        head_s3("my-bucket", "data/large_file.csv")
        head_s3("my-bucket", "data/file.csv", n=10)
    """
    ext = key.rsplit('.', 1)[-1].lower()
    s3 = boto3.client('s3', region_name=_REGION)
    
    if ext == 'csv':
        obj = s3.get_object(Bucket=bucket, Key=key, Range='bytes=0-65536')  # First 64KB
        return pd.read_csv(io.BytesIO(obj['Body'].read()), nrows=n)
    elif ext == 'parquet':
        obj = s3.get_object(Bucket=bucket, Key=key)
        return pd.read_parquet(io.BytesIO(obj['Body'].read())).head(n)
    else:
        obj = s3.get_object(Bucket=bucket, Key=key, Range='bytes=0-65536')
        return pd.read_csv(io.BytesIO(obj['Body'].read()), nrows=n)
