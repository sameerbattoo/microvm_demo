"""
SQL execution engine with intelligent auto-routing.

Part of: app.notebook (application layer)

Transparently routes SQL queries to the appropriate engine based on
unambiguous source detection:

Source Detection Rules (each source type has a unique syntax pattern):
  - LOCAL_FILE:  FROM '/tmp/file.csv'           — quoted path with extension
  - S3_FILE:     FROM read_csv('s3://...')       — read_* function with s3:// URL
  - ATHENA:      FROM database.table_name       — dot-separated, matches Glue catalog
  - DYNAMODB:    FROM dynamodb."table-name"     — explicit dynamodb. prefix
  - DATAFRAME:   FROM variable_name             — bare name matching namespace DataFrame

Routing Logic:
  - All sources are DuckDB-compatible (local, S3, DataFrame) → Pure DuckDB
  - All sources are Athena tables                             → Pure Athena (send SQL as-is)
  - Single DynamoDB table (simple query)                     → PartiQL (server-side)
  - Mixed (any remote + any local)                           → Materialize remote → DuckDB

Endpoint:
  POST /execute-sql - Execute SQL with auto-routing
"""

import os
import re
import time as _time
import logging
from enum import Enum
from dataclasses import dataclass

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

logger = logging.getLogger(__name__)

router = APIRouter(tags=["sql-engine"])


# ─── Source Classification ────────────────────────────────────────────────────

class SourceType(Enum):
    LOCAL_FILE = "local_file"      # '/tmp/file.csv' — DuckDB handles directly
    S3_FILE = "s3_file"            # read_csv('s3://...') — DuckDB handles via httpfs
    ATHENA = "athena"              # database.table — needs Athena or materialization
    DYNAMODB = "dynamodb"          # dynamodb."table" — needs PartiQL or scan
    DATAFRAME = "dataframe"        # bare variable name — DuckDB handles directly


@dataclass
class SourceRef:
    """A detected source reference in the SQL."""
    source_type: SourceType
    full_ref: str       # As it appears in the SQL (for rewriting)
    table_name: str     # Bare table/file name (for materialization aliases)


# ─── Glue Catalog Cache ──────────────────────────────────────────────────────

_glue_cache: dict = {}       # { "database": {"table1", "table2", ...} }
_glue_cache_ts: float = 0    # Unix timestamp of last fetch
GLUE_CACHE_TTL = 300         # 5 minutes


def _get_athena_catalog(athena_db: str, aws_region: str) -> set[str]:
    """
    Get table names from the Glue catalog (cached with 5-min TTL).
    Returns a set of bare table names for the given database.
    """
    global _glue_cache, _glue_cache_ts
    import boto3

    now = _time.time()
    if athena_db in _glue_cache and (now - _glue_cache_ts) < GLUE_CACHE_TTL:
        return _glue_cache[athena_db]

    try:
        glue = boto3.client("glue", region_name=aws_region)
        tables = set()
        paginator = glue.get_paginator("get_tables")
        for page in paginator.paginate(DatabaseName=athena_db):
            for t in page.get("TableList", []):
                tables.add(t["Name"])
        _glue_cache[athena_db] = tables
        _glue_cache_ts = now
        logger.info(f"Glue catalog refreshed: {athena_db} ({len(tables)} tables)")
        return tables
    except Exception as e:
        logger.warning(f"Could not fetch Athena catalog: {e}")
        return _glue_cache.get(athena_db, set())


# ─── Source Detection ─────────────────────────────────────────────────────────

def _classify_sources(sql: str, athena_db: str, athena_tables: set[str], namespace_dataframes: set[str]) -> list[SourceRef]:
    """
    Parse the SQL and classify every FROM/JOIN source into its type.

    Detection is deterministic because each source type has a unique syntax:
      - Local file:  quoted path '/tmp/...' with file extension
      - S3 file:     read_csv/read_json/read_parquet('s3://...')
      - DynamoDB:    dynamodb."table-name" or dynamodb.table_name
      - Athena:      database.table (dot-separated, matches Glue catalog)
      - DataFrame:   bare identifier matching a namespace DataFrame
    """
    sources: list[SourceRef] = []

    # Strip SQL comments before classification to avoid false detections
    # Remove single-line comments (-- ...)
    sql_clean = re.sub(r'--[^\n]*', '', sql)
    # Remove multi-line comments (/* ... */)
    sql_clean = re.sub(r'/\*.*?\*/', '', sql_clean, flags=re.DOTALL)

    # 1. Detect S3 files: read_csv('s3://...'), read_json('s3://...'), read_parquet('s3://...')
    s3_pattern = re.compile(
        r'\bread_(csv|json|parquet)\s*\(\s*[\'"]s3://[^\'"]+[\'"]\s*\)',
        re.IGNORECASE
    )
    for m in s3_pattern.finditer(sql_clean):
        sources.append(SourceRef(
            source_type=SourceType.S3_FILE,
            full_ref=m.group(0),
            table_name=m.group(0),  # DuckDB handles the full expression
        ))

    # 1b. Detect local files via DuckDB function: read_csv('/tmp/...'), read_json('/tmp/...')
    local_func_pattern = re.compile(
        r'\bread_(csv|json|parquet)\s*\(\s*[\'"](/tmp/[^\'"]+)[\'"]\s*\)',
        re.IGNORECASE
    )
    for m in local_func_pattern.finditer(sql_clean):
        sources.append(SourceRef(
            source_type=SourceType.LOCAL_FILE,
            full_ref=m.group(0),
            table_name=os.path.basename(m.group(2)),
        ))

    # 2. Detect local files: '/tmp/file.ext'
    local_file_pattern = re.compile(
        r"(?:FROM|JOIN)\s+['\"](/tmp/[^'\"]+)['\"]",
        re.IGNORECASE
    )
    for m in local_file_pattern.finditer(sql_clean):
        sources.append(SourceRef(
            source_type=SourceType.LOCAL_FILE,
            full_ref=f"'{m.group(1)}'",
            table_name=os.path.basename(m.group(1)),
        ))

    # 3. Detect DynamoDB: dynamodb."table-name" or dynamodb.table_name
    dynamo_pattern = re.compile(
        r'(?:FROM|JOIN)\s+(dynamodb\.(?:"[^"]+"|[a-zA-Z_][\w\-]*))',
        re.IGNORECASE
    )
    for m in dynamo_pattern.finditer(sql_clean):
        full_ref = m.group(1)
        name_part = full_ref.split('.', 1)[1]
        table_name = name_part.strip('"')
        sources.append(SourceRef(
            source_type=SourceType.DYNAMODB,
            full_ref=full_ref,
            table_name=table_name,
        ))

    # 4. Detect Athena tables: database.table_name (must match Glue catalog)
    athena_pattern = re.compile(
        r'(?:FROM|JOIN)\s+(' + re.escape(athena_db) + r'\.([a-zA-Z_]\w*))',
        re.IGNORECASE
    )
    for m in athena_pattern.finditer(sql_clean):
        full_ref = m.group(1)   # e.g. "microvm_demo_db.sales_data"
        bare_name = m.group(2)  # e.g. "sales_data"
        if bare_name in athena_tables:
            sources.append(SourceRef(
                source_type=SourceType.ATHENA,
                full_ref=full_ref,
                table_name=bare_name,
            ))

    # 5. Detect DataFrames: bare identifier after FROM/JOIN (not already classified)
    # Excludes: paths, function calls, dynamodb., database.table
    bare_ref_pattern = re.compile(
        r'(?:FROM|JOIN)\s+([a-zA-Z_]\w*)\b'
        r'(?!\s*\()'           # Not followed by ( → not a function call
        r'(?!\s*\.)',          # Not followed by . → not database.table
        re.IGNORECASE
    )
    already_classified = {s.full_ref.lower() for s in sources}
    for m in bare_ref_pattern.finditer(sql_clean):
        ref = m.group(1)
        # Skip SQL keywords and already-classified refs
        if ref.lower() in ('select', 'from', 'join', 'where', 'group', 'order', 'having',
                           'limit', 'offset', 'union', 'intersect', 'except', 'as',
                           'on', 'and', 'or', 'not', 'in', 'between', 'like',
                           'dynamodb', 'read_csv', 'read_json', 'read_parquet'):
            continue
        if ref.lower() in already_classified:
            continue
        if ref in namespace_dataframes:
            sources.append(SourceRef(
                source_type=SourceType.DATAFRAME,
                full_ref=ref,
                table_name=ref,
            ))

    return sources


# ─── Main Endpoint ────────────────────────────────────────────────────────────

@router.post("/execute-sql")
async def execute_sql(request: Request):
    """
    Execute a SQL query with intelligent auto-routing between DuckDB, Athena, and DynamoDB.

    Request body:
        {
            "sql": "SELECT * FROM microvm_demo_db.sales_data LIMIT 10",
            "output_variable": "result"  (optional, name for the result DataFrame)
        }
    """
    import duckdb
    import pandas as pd
    import boto3

    executor = request.app.state.executor
    session_state = request.app.state.session_state
    session_state["request_count"] += 1

    body = await request.json()
    sql = body.get("sql", "").strip()
    output_var = body.get("output_variable", "result")

    if not sql:
        return JSONResponse(status_code=400, content={"error": "No SQL provided"})

    logger.info(f"▶ Executing SQL (len={len(sql)})")

    start = _time.perf_counter()
    try:
        # --- Configuration ---
        athena_db = os.environ.get("ATHENA_DB", "microvm_demo_db")
        athena_workgroup = os.environ.get("ATHENA_WORKGROUP", "microvm-demo")
        aws_region = os.environ.get("AWS_REGION", "us-west-2")

        # --- Step 1: Get Athena catalog (cached) ---
        athena_tables = _get_athena_catalog(athena_db, aws_region)

        # --- Step 2: Classify all sources in the SQL ---
        namespace_dataframes = {k for k, v in executor._namespace.items() if isinstance(v, pd.DataFrame)}
        sources = _classify_sources(sql, athena_db, athena_tables, namespace_dataframes)

        # Group by type
        source_types = {s.source_type for s in sources}
        athena_sources = [s for s in sources if s.source_type == SourceType.ATHENA]
        dynamo_sources = [s for s in sources if s.source_type == SourceType.DYNAMODB]
        duckdb_types = {SourceType.LOCAL_FILE, SourceType.S3_FILE, SourceType.DATAFRAME}

        # --- Step 3: Route execution ---
        engine_used = "duckdb"
        result_df = None

        if source_types <= duckdb_types or len(sources) == 0:
            # Pure DuckDB: all sources are local files, S3 files, or DataFrames
            engine_used = "duckdb"
            result_df = _run_duckdb_query(sql, executor)

        elif source_types == {SourceType.ATHENA}:
            # Pure Athena: all sources are Athena tables, send SQL directly
            engine_used = "athena"
            result_df = await _run_athena_query(sql, athena_workgroup, aws_region)

        elif source_types == {SourceType.DYNAMODB} and len(dynamo_sources) == 1:
            # Single DynamoDB table — try PartiQL first
            table_name = dynamo_sources[0].table_name
            full_ref = dynamo_sources[0].full_ref
            partiql_sql = sql.replace(full_ref, f'"{table_name}"')

            partiql_result = _try_partiql(partiql_sql, table_name, aws_region)
            if partiql_result is not None:
                engine_used = "dynamodb-partiql"
                result_df = partiql_result
            else:
                # Fallback: scan table into DataFrame, then DuckDB
                engine_used = "duckdb+dynamodb"
                dynamo_limit = None
                limit_match = re.search(r'\bLIMIT\s+(\d+)\s*$', sql, re.IGNORECASE)
                if limit_match:
                    dynamo_limit = int(limit_match.group(1))
                safe_alias = f"_dynamo_{table_name.replace('-', '_')}"
                materialized = {safe_alias: _scan_dynamodb_table(table_name, aws_region, limit=dynamo_limit)}
                rewritten_sql = sql.replace(full_ref, safe_alias)
                result_df = _run_duckdb_query(rewritten_sql, executor, materialized)

        else:
            # Mixed sources — materialize remote tables (Athena, DynamoDB) into DataFrames, then DuckDB
            engine_parts = []
            materialized = {}
            rewritten_sql = sql

            # Materialize Athena tables
            if athena_sources:
                engine_parts.append("athena")
                for src in athena_sources:
                    athena_sql = f"SELECT * FROM {athena_db}.{src.table_name}"
                    safe_alias = f"_athena_{src.table_name}"
                    materialized[safe_alias] = await _run_athena_query(athena_sql, athena_workgroup, aws_region)
                    rewritten_sql = re.sub(r'\b' + re.escape(src.full_ref) + r'\b', safe_alias, rewritten_sql)

            # Materialize DynamoDB tables
            if dynamo_sources:
                engine_parts.append("dynamodb")
                for src in dynamo_sources:
                    safe_alias = f"_dynamo_{src.table_name.replace('-', '_')}"
                    dynamo_limit = None
                    if len(dynamo_sources) == 1 and not athena_sources:
                        limit_match = re.search(r'\bLIMIT\s+(\d+)\s*$', sql, re.IGNORECASE)
                        if limit_match:
                            dynamo_limit = int(limit_match.group(1))
                    materialized[safe_alias] = _scan_dynamodb_table(src.table_name, aws_region, limit=dynamo_limit)
                    rewritten_sql = rewritten_sql.replace(src.full_ref, safe_alias)

            engine_used = "duckdb+" + "+".join(engine_parts)
            result_df = _run_duckdb_query(rewritten_sql, executor, materialized)

        elapsed_ms = (_time.perf_counter() - start) * 1000

        # --- Step 4: Store result and format output ---
        if output_var and output_var.isidentifier():
            executor._namespace[output_var] = result_df

        row_count = len(result_df)
        col_count = len(result_df.columns)
        max_rows = 50
        if row_count > max_rows:
            html = result_df.head(max_rows).to_html(index=True, classes='dataframe', border=0)
            output = f"{row_count} rows × {col_count} columns (showing first {max_rows})"
        else:
            html = result_df.to_html(index=True, classes='dataframe', border=0)
            output = f"{row_count} rows × {col_count} columns"

        # Engine indicator
        engine_label = {
            "duckdb": "🦆 DuckDB",
            "athena": "⚡ Athena",
            "duckdb+athena": "⚡🦆 Athena → DuckDB",
            "duckdb+dynamodb": "🔶🦆 DynamoDB (scan) → DuckDB",
            "dynamodb-partiql": "🔶 DynamoDB (PartiQL)",
            "duckdb+athena+dynamodb": "⚡🔶🦆 Athena+DynamoDB → DuckDB",
        }
        output = f"{output}  •  {engine_label.get(engine_used, engine_used)}"

        # Large DynamoDB table warning
        for src in dynamo_sources:
            cache_key = f"{src.table_name}:{aws_region}"
            if hasattr(_scan_dynamodb_table, '_cache') and cache_key in _scan_dynamodb_table._cache:
                cached_size = len(_scan_dynamodb_table._cache[cache_key])
                if cached_size > 10000:
                    output += f"\n⚠️ DynamoDB '{src.table_name}' has {cached_size:,} rows — consider adding LIMIT"

        executor._execution_count += 1

        # Log SQL success with context
        sql_lines = sql.strip().split('\n')
        snippet_lines = [l for l in sql_lines if l.strip() and not l.strip().startswith('--')]
        first_line = snippet_lines[0][:80] if snippet_lines else sql_lines[0][:80]
        logger.info(f"  ✓ SQL OK ({elapsed_ms:.0f}ms) {row_count}×{col_count} engine={engine_used} → {output_var} | {first_line}")

        return {
            "success": True,
            "output": output,
            "html": html,
            "error": None,
            "execution_time_ms": round(elapsed_ms, 1),
            "execution_number": executor._execution_count,
            "row_count": row_count,
            "column_count": col_count,
            "output_variable": output_var,
            "engine": engine_used,
        }

    except Exception as e:
        elapsed_ms = (_time.perf_counter() - start) * 1000
        error_msg = str(e)
        sql_lines = sql.strip().split('\n')
        snippet_lines = [l for l in sql_lines if l.strip() and not l.strip().startswith('--')]
        first_line = snippet_lines[0][:80] if snippet_lines else sql_lines[0][:80]
        logger.warning(f"  ✗ SQL ERROR ({elapsed_ms:.0f}ms) | {first_line}")
        logger.warning(f"    {error_msg}")
        return {
            "success": False,
            "output": None,
            "html": None,
            "error": error_msg,
            "execution_time_ms": round(elapsed_ms, 1),
        }


# ─── Execution Engines ────────────────────────────────────────────────────────


def _run_duckdb_query(sql: str, executor, extra_dataframes: dict = None):
    """Execute SQL via DuckDB with namespace DataFrames + optional extras registered."""
    import duckdb
    import pandas as pd
    import boto3

    con = duckdb.connect()

    # Enable S3 access via httpfs with explicit credentials
    try:
        con.execute("INSTALL httpfs; LOAD httpfs;")
        region = os.environ.get('AWS_REGION', 'us-west-2')
        con.execute(f"SET s3_region = '{region}';")

        session = boto3.Session()
        creds = session.get_credentials()
        if creds:
            frozen = creds.get_frozen_credentials()
            con.execute(f"SET s3_access_key_id = '{frozen.access_key}';")
            con.execute(f"SET s3_secret_access_key = '{frozen.secret_key}';")
            if frozen.token:
                con.execute(f"SET s3_session_token = '{frozen.token}';")
    except Exception as e:
        logger.warning(f"httpfs setup warning: {e}")

    # Register namespace DataFrames
    for name, value in executor._namespace.items():
        if isinstance(value, pd.DataFrame):
            con.register(name, value)

    # Register extra materialized DataFrames (from Athena/DynamoDB)
    if extra_dataframes:
        for name, df in extra_dataframes.items():
            con.register(name, df)

    result = con.execute(sql).fetchdf()
    con.close()
    return result


async def _run_athena_query(sql: str, workgroup: str, region: str):
    """Execute SQL via Athena and return result as a DataFrame."""
    import boto3
    import pandas as pd
    import asyncio

    athena = boto3.client("athena", region_name=region)

    exec_resp = athena.start_query_execution(QueryString=sql, WorkGroup=workgroup)
    execution_id = exec_resp["QueryExecutionId"]

    for _ in range(120):
        status_resp = athena.get_query_execution(QueryExecutionId=execution_id)
        state = status_resp["QueryExecution"]["Status"]["State"]
        if state == "SUCCEEDED":
            break
        if state in ("FAILED", "CANCELLED"):
            reason = status_resp["QueryExecution"]["Status"].get("StateChangeReason", "Unknown error")
            raise RuntimeError(f"Athena query {state}: {reason}")
        await asyncio.sleep(0.5)
    else:
        raise RuntimeError("Athena query timed out after 60 seconds")

    results = athena.get_query_results(QueryExecutionId=execution_id)
    rows = results["ResultSet"]["Rows"]

    if not rows:
        return pd.DataFrame()

    header = [col.get("VarCharValue", f"col_{i}") for i, col in enumerate(rows[0]["Data"])]
    data = [[col.get("VarCharValue", "") for col in row["Data"]] for row in rows[1:]]

    while "NextToken" in results:
        results = athena.get_query_results(QueryExecutionId=execution_id, NextToken=results["NextToken"])
        data.extend([[col.get("VarCharValue", "") for col in row["Data"]] for row in results["ResultSet"]["Rows"]])

    df = pd.DataFrame(data, columns=header)

    # Auto-convert numeric columns
    for col in df.columns:
        try:
            df[col] = pd.to_numeric(df[col])
        except (ValueError, TypeError):
            pass

    return df


def _scan_dynamodb_table(table_name: str, region: str, limit: int = None):
    """
    Scan a DynamoDB table and return all items as a DataFrame.
    Supports LIMIT pushdown and caching with 5-minute TTL.
    """
    import boto3
    import pandas as pd
    from decimal import Decimal

    CACHE_TTL_SECONDS = 300  # 5 minutes

    cache_key = f"{table_name}:{region}"
    if not hasattr(_scan_dynamodb_table, '_cache'):
        _scan_dynamodb_table._cache = {}
    if not hasattr(_scan_dynamodb_table, '_cache_ts'):
        _scan_dynamodb_table._cache_ts = {}

    # Check cache (with TTL)
    if cache_key in _scan_dynamodb_table._cache and not limit:
        cached_at = _scan_dynamodb_table._cache_ts.get(cache_key, 0)
        if _time.time() - cached_at < CACHE_TTL_SECONDS:
            cached = _scan_dynamodb_table._cache[cache_key]
            logger.info(f"🔶 DynamoDB cache hit: {table_name} ({len(cached)} rows)")
            return cached
        else:
            del _scan_dynamodb_table._cache[cache_key]
            del _scan_dynamodb_table._cache_ts[cache_key]

    dynamodb = boto3.resource("dynamodb", region_name=region)
    table = dynamodb.Table(table_name)

    try:
        desc = table.item_count
        if desc and desc > 10000 and not limit:
            logger.warning(f"⚠️ DynamoDB table '{table_name}' has ~{desc:,} items — full scan may be slow")
    except Exception:
        pass

    items = []
    scan_kwargs = {}
    if limit and limit > 0:
        scan_kwargs['Limit'] = limit

    response = table.scan(**scan_kwargs)
    items.extend(response.get("Items", []))

    if not limit:
        while "LastEvaluatedKey" in response:
            response = table.scan(ExclusiveStartKey=response["LastEvaluatedKey"])
            items.extend(response.get("Items", []))

    if not items:
        return pd.DataFrame()

    df = pd.DataFrame(items)

    for col in df.columns:
        if df[col].apply(lambda x: isinstance(x, Decimal)).any():
            df[col] = df[col].astype(float)

    if not limit:
        _scan_dynamodb_table._cache[cache_key] = df
        _scan_dynamodb_table._cache_ts[cache_key] = _time.time()
        logger.info(f"🔶 DynamoDB scanned & cached: {table_name} ({len(df)} rows, TTL=5m)")
    else:
        logger.info(f"🔶 DynamoDB scanned (limit={limit}): {table_name} ({len(df)} rows)")

    return df


def _try_partiql(sql: str, table_name: str, region: str):
    """
    Try executing SQL via DynamoDB PartiQL.
    Returns a DataFrame on success, or None if PartiQL can't handle it.

    PartiQL supports: SELECT, WHERE (with partition/sort key), LIMIT (via API param).
    PartiQL does NOT support: JOIN, GROUP BY, HAVING, UNION, ORDER BY (without WHERE).
    """
    import boto3
    import pandas as pd
    from decimal import Decimal

    # Skip unsupported patterns
    unsupported = re.search(r'\b(JOIN|GROUP\s+BY|HAVING|UNION|INTERSECT|EXCEPT)\b', sql, re.IGNORECASE)
    if unsupported:
        logger.info(f"🔶 PartiQL skip: unsupported keyword '{unsupported.group()}'")
        return None

    if re.search(r'\bORDER\s+BY\b', sql, re.IGNORECASE) and not re.search(r'\bWHERE\b', sql, re.IGNORECASE):
        logger.info("🔶 PartiQL skip: ORDER BY without WHERE not supported")
        return None

    # Extract LIMIT (PartiQL uses API param, not SQL syntax)
    limit_value = None
    limit_match = re.search(r'\bLIMIT\s+(\d+)\s*$', sql, re.IGNORECASE)
    if limit_match:
        limit_value = int(limit_match.group(1))
        sql = sql[:limit_match.start()].strip()

    try:
        client = boto3.client("dynamodb", region_name=region)

        params = {"Statement": sql}
        if limit_value:
            params["Limit"] = limit_value

        response = client.execute_statement(**params)
        items = response.get("Items", [])

        if not limit_value:
            while "NextToken" in response:
                response = client.execute_statement(Statement=sql, NextToken=response["NextToken"])
                items.extend(response.get("Items", []))

        if not items:
            return pd.DataFrame()

        from boto3.dynamodb.types import TypeDeserializer
        deserializer = TypeDeserializer()

        rows = []
        for item in items:
            row = {k: deserializer.deserialize(v) for k, v in item.items()}
            rows.append(row)

        df = pd.DataFrame(rows)

        for col in df.columns:
            if df[col].apply(lambda x: isinstance(x, Decimal)).any():
                df[col] = df[col].astype(float)

        logger.info(f"🔶 PartiQL success: {table_name} ({len(df)} rows)")
        return df

    except Exception as e:
        logger.info(f"🔶 PartiQL failed for '{table_name}': {e} — falling back to scan")
        return None
