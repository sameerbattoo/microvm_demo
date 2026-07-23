"""
SQL execution engine with intelligent auto-routing.

Part of: app.notebook (application layer)

Transparently routes SQL queries to the appropriate engine:
- DuckDB: local DataFrames, files (/tmp/), S3 via httpfs
- Athena: tables detected in the Glue catalog (database.table format)
- DynamoDB: tables referenced as dynamodb."table-name" (PartiQL first, scan fallback)
- Mixed: materializes remote tables into DataFrames, then DuckDB handles the full query

Endpoint:
  POST /execute-sql - Execute SQL with auto-routing
"""

import os
import re
import logging

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

logger = logging.getLogger(__name__)

router = APIRouter(tags=["sql-engine"])


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
    import time
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

    start = time.perf_counter()
    try:
        # --- Step 1: Discover Athena tables from Glue catalog ---
        athena_db = os.environ.get("ATHENA_DB", "microvm_demo_db")
        athena_workgroup = os.environ.get("ATHENA_WORKGROUP", "microvm-demo")
        aws_region = os.environ.get("AWS_REGION", "us-west-2")

        athena_catalog = {}  # { "database.table": "bare_table_name" }
        try:
            glue = boto3.client("glue", region_name=aws_region)
            resp = glue.get_tables(DatabaseName=athena_db)
            for t in resp.get("TableList", []):
                table_name = t["Name"]
                athena_catalog[f"{athena_db}.{table_name}"] = table_name
                athena_catalog[table_name] = table_name
        except Exception as e:
            logger.warning(f"Could not fetch Athena catalog: {e}")

        # --- Step 2: Parse table references from SQL ---
        table_pattern = re.compile(
            r'(?:FROM|JOIN)\s+'
            r'(?!read_csv|read_parquet|read_json)'
            r"(?!['\"/])"
            r'([a-zA-Z_]\w*(?:\.[a-zA-Z_][\w\-]*|(?:\."[^"]+"))?)',
            re.IGNORECASE
        )
        referenced_tables = set(table_pattern.findall(sql))

        # --- Step 2b: Detect DynamoDB references (dynamodb."table-name") ---
        dynamo_pattern = re.compile(
            r'(?:FROM|JOIN)\s+dynamodb\.(?:"([^"]+)"|([a-zA-Z_][\w\-]*))',
            re.IGNORECASE
        )
        dynamo_refs = {}
        for m in dynamo_pattern.finditer(sql):
            table_name = m.group(1) or m.group(2)
            full_ref = m.group(0).split(None, 1)[1]
            dynamo_refs[full_ref] = table_name

        # --- Step 3: Classify references ---
        namespace_vars = set(executor._namespace.keys())
        athena_refs = {}
        local_refs = set()

        for ref in referenced_tables:
            if ref.lower().startswith('dynamodb.'):
                continue
            if ref in athena_catalog:
                athena_refs[ref] = athena_catalog[ref]
            elif ref in namespace_vars:
                local_refs.add(ref)

        # --- Step 4: Route execution ---
        engine_used = "duckdb"
        has_local_sources = bool(re.search(r"'/tmp/|read_csv\(|read_json\(|read_parquet\(|'s3://", sql, re.IGNORECASE))
        has_dynamo = bool(dynamo_refs)

        if athena_refs and not local_refs and not has_local_sources and not has_dynamo and not any(r in namespace_vars for r in referenced_tables - set(athena_refs.keys())):
            # Pure Athena
            engine_used = "athena"
            result_df = await _run_athena_query(sql, athena_workgroup, aws_region)
        elif athena_refs or has_dynamo:
            # Mixed — materialize remote tables, then DuckDB
            engine_used = "duckdb+athena" if athena_refs else "duckdb+dynamodb"
            if athena_refs and has_dynamo:
                engine_used = "duckdb+athena+dynamodb"
            materialized = {}
            rewritten_sql = sql

            # Materialize Athena tables
            for ref, bare_name in athena_refs.items():
                athena_sql = f"SELECT * FROM {athena_db}.{bare_name}"
                safe_alias = f"_athena_{bare_name}"
                materialized[safe_alias] = await _run_athena_query(athena_sql, athena_workgroup, aws_region)
                rewritten_sql = re.sub(r'\b' + re.escape(ref) + r'\b', safe_alias, rewritten_sql)

            # Materialize DynamoDB tables (PartiQL first, scan fallback)
            for ref, table_name in dynamo_refs.items():
                safe_alias = f"_dynamo_{table_name.replace('-', '_')}"

                # Try PartiQL for pure single-DynamoDB queries
                logger.info(f"🔶 DynamoDB routing: dynamo_refs={len(dynamo_refs)}, athena_refs={bool(athena_refs)}, local_refs={local_refs}, has_local_sources={has_local_sources}, ref='{ref}'")
                if len(dynamo_refs) == 1 and not athena_refs and not local_refs and not has_local_sources:
                    partiql_sql = rewritten_sql.replace(ref, f'"{table_name}"')
                    logger.info(f"🔶 Trying PartiQL: '{partiql_sql[:100]}'")
                    partiql_result = _try_partiql(partiql_sql, table_name, aws_region)
                    if partiql_result is not None:
                        result_df = partiql_result
                        engine_used = "dynamodb-partiql"
                        materialized = None
                        break

                # Fallback: scan + DuckDB
                dynamo_limit = None
                if len(dynamo_refs) == 1 and not athena_refs and not local_refs:
                    limit_match = re.search(r'\bLIMIT\s+(\d+)\s*$', sql, re.IGNORECASE)
                    if limit_match:
                        dynamo_limit = int(limit_match.group(1))
                materialized[safe_alias] = _scan_dynamodb_table(table_name, aws_region, limit=dynamo_limit)
                rewritten_sql = rewritten_sql.replace(ref, safe_alias)

            # Run in DuckDB (unless PartiQL handled it)
            if materialized is not None:
                result_df = _run_duckdb_query(rewritten_sql, executor, materialized)
        else:
            # Pure DuckDB
            result_df = _run_duckdb_query(sql, executor)

        elapsed_ms = (time.perf_counter() - start) * 1000

        # Store result in namespace
        if output_var and output_var.isidentifier():
            executor._namespace[output_var] = result_df

        # Generate HTML table output
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

        # Large table warning
        if dynamo_refs:
            for ref, table_name in dynamo_refs.items():
                cache_key = f"{table_name}:{aws_region}"
                if hasattr(_scan_dynamodb_table, '_cache') and cache_key in _scan_dynamodb_table._cache:
                    cached_size = len(_scan_dynamodb_table._cache[cache_key])
                    if cached_size > 10000:
                        output += f"\n⚠️ DynamoDB '{table_name}' has {cached_size:,} rows — consider adding LIMIT"

        # Execution count (shared with Python cells)
        executor._execution_count += 1

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
        elapsed_ms = (time.perf_counter() - start) * 1000
        error_msg = str(e)
        logger.warning(f"SQL execution error: {error_msg}")
        return {
            "success": False,
            "output": None,
            "html": None,
            "error": error_msg,
            "execution_time_ms": round(elapsed_ms, 1),
        }


# --- Helper functions ---


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

    # Register extra materialized DataFrames
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

    for col in df.columns:
        try:
            df[col] = pd.to_numeric(df[col])
        except (ValueError, TypeError):
            pass

    return df


def _scan_dynamodb_table(table_name: str, region: str, limit: int = None):
    """
    Scan a DynamoDB table and return all items as a DataFrame.
    Supports LIMIT pushdown and caching.
    """
    import boto3
    import pandas as pd
    from decimal import Decimal

    cache_key = f"{table_name}:{region}"
    if not hasattr(_scan_dynamodb_table, '_cache'):
        _scan_dynamodb_table._cache = {}

    if cache_key in _scan_dynamodb_table._cache and not limit:
        cached = _scan_dynamodb_table._cache[cache_key]
        logger.info(f"🔶 DynamoDB cache hit: {table_name} ({len(cached)} rows)")
        return cached

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
        logger.info(f"🔶 DynamoDB scanned & cached: {table_name} ({len(df)} rows)")
    else:
        logger.info(f"🔶 DynamoDB scanned (limit={limit}): {table_name} ({len(df)} rows)")

    return df


def _try_partiql(sql: str, table_name: str, region: str):
    """
    Try executing SQL via DynamoDB PartiQL.
    Returns a DataFrame on success, or None if PartiQL can't handle it.
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
