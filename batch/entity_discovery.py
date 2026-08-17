"""
Global Data Source Entity Discovery.

Part of: proxy.notebook.ai

Phase 1 of the Data Intel redesign (see design discussion): enumerates the
data sources available to all users — S3 files, Athena tables, DynamoDB
tables — and generates one markdown profile document per entity: an
AI-inferred business description, schema, describe()-style stats, null/
duplicate checks, and other data quality flags.

Also includes the local-file counterpart (further down in this file): local
/tmp files are workbook-scoped (unique to one session), so they're profiled
separately — via the session's own live VM instead of independent boto3
calls — but reuse the exact same markdown-generation step. See the "LOCAL
FILE ENTITIES" section below. Both feed into Workbook Intel generation
(proxy/notebook/ai/workbook_intel.py, "Plan A").

Global entity discovery is entirely independent of any user session or
MicroVM — it runs directly in the proxy process using boto3 + pandas on
small samples, plus a single one-shot Bedrock call per entity (no agent/
tool-calling loop) to turn the computed stats into a readable profile.

Storage:
    Global:  S3 data-catalog/entities/{sanitized_source_id}.md
             SQLite data_source_entities table (see proxy/storage/sqlite_db.py)
    Local:   S3 sessions/{session_id}/local-entities/{filename}.md
             SQLite local_file_entities table, keyed by (session_id, filepath)
    Both track a per-source-type "change signal" so re-running this only
    re-profiles entities that are missing or have changed since last discovered.

Concurrency: bounded by a small thread pool (default 8 for global, 3 for
local since local discovery shares the session's own live VM) so we never
fire more than a handful of concurrent Bedrock/VM calls at once. Bedrock
throttling (not thread count) is the real ceiling; the client retries with
backoff, so occasional throttles self-heal.

Run standalone:
    python -m proxy.notebook.ai.entity_discovery
    FORCE_REDISCOVER=1 python -m proxy.notebook.ai.entity_discovery   # ignore change signals

Or import discover_all_global_entities() from a route or future scheduler.
"""

import os
import io
import json
import logging
import concurrent.futures
from decimal import Decimal
from datetime import datetime, timezone

import boto3

from proxy.notebook.ai.prompts import ENTITY_DISCOVERY_PROMPT

logger = logging.getLogger(__name__)

AI_MODEL_ID = os.environ.get("BEDROCK_MODEL_ID", "us.anthropic.claude-sonnet-4-6")
AI_REGION = os.environ.get("BEDROCK_REGION", os.environ.get("AWS_REGION", "us-west-2"))

# Bounded concurrency for parallel per-entity discovery. Each task makes one Bedrock
# call (the dominant cost), so the practical ceiling is Bedrock throttling, not threads.
# 8 clears the ~12-entity workload in ~2 waves while staying under Claude's per-account
# TPS (firing all 12 at once tends to trigger ThrottlingException + backoff, which is
# slower, not faster). Override with ENTITY_DISCOVERY_CONCURRENCY if your account has
# higher/lower Bedrock limits.
MAX_CONCURRENT_DISCOVERY = int(os.environ.get("ENTITY_DISCOVERY_CONCURRENCY", "8"))

# How many rows/items to sample per entity for profiling (keeps this cheap and fast —
# we're profiling for a catalog description, not doing exhaustive analysis)
SAMPLE_ROW_LIMIT = 500

# S3 prefixes to scan for entity files — mirrors the enumeration already used
# when building the data_sources payload for VM launch
# (see proxy/platform/routes/microvm.py)
S3_ENTITY_PREFIXES = ["samples/", "user-data/"]

# DynamoDB table name filter — mirrors the heuristic used elsewhere in the proxy
# to distinguish demo/app tables from unrelated tables that might exist in the
# same AWS account
_DYNAMO_NAME_HINTS = ("microvm", "demo", "ecommerce")

_bedrock_client = None


def _get_bedrock_client():
    """Cached Bedrock runtime client for one-shot (non-agent) calls."""
    global _bedrock_client
    if _bedrock_client is None:
        from botocore.config import Config
        from proxy.notebook.ai.constants import BEDROCK_MAX_RETRIES, BEDROCK_READ_TIMEOUT, BEDROCK_CONNECT_TIMEOUT
        _bedrock_client = boto3.client(
            "bedrock-runtime",
            region_name=AI_REGION,
            config=Config(
                retries={"max_attempts": BEDROCK_MAX_RETRIES, "mode": "standard"},
                read_timeout=BEDROCK_READ_TIMEOUT,
                connect_timeout=BEDROCK_CONNECT_TIMEOUT,
            ),
        )
    return _bedrock_client


# =============================================================================
# STEP 1: ENUMERATE GLOBAL ENTITIES (pure boto3 — no VM, no pandas needed)
# =============================================================================

def list_global_entities(bucket: str, athena_db: str, region: str) -> list[dict]:
    """
    Enumerate all user-non-specific data sources: S3 files, Athena tables,
    DynamoDB tables. Does NOT include local /tmp files.

    Returns a list of entity dicts: {source_id, source_type, ...type-specific fields}
    """
    entities: list[dict] = []

    # --- S3 files ---
    try:
        s3 = boto3.client("s3", region_name=region)
        paginator = s3.get_paginator("list_objects_v2")
        for prefix in S3_ENTITY_PREFIXES:
            for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
                for obj in page.get("Contents", []):
                    key = obj["Key"]
                    ext = key.rsplit(".", 1)[-1].lower() if "." in key else ""
                    if ext not in ("csv", "parquet", "json"):
                        continue
                    entities.append({
                        "source_id": f"s3://{bucket}/{key}",
                        "source_type": "s3",
                        "bucket": bucket,
                        "key": key,
                        "extension": ext,
                    })
    except Exception as e:
        logger.warning(f"[entity-discovery] S3 enumeration failed: {e}")

    # --- DynamoDB tables ---
    try:
        ddb_client = boto3.client("dynamodb", region_name=region)
        for name in ddb_client.list_tables().get("TableNames", []):
            if any(hint in name for hint in _DYNAMO_NAME_HINTS):
                entities.append({
                    "source_id": f"dynamodb.{name}",
                    "source_type": "dynamodb",
                    "table_name": name,
                })
    except Exception as e:
        logger.warning(f"[entity-discovery] DynamoDB enumeration failed: {e}")

    # --- Athena tables ---
    # NOTE: source_id intentionally matches the VM-side data catalog's convention
    # ({database}.{table}, e.g. "microvm_demo_db.orders" — no "athena." prefix)
    # so step 2 can cross-reference entity docs against the catalog by exact
    # source_id. See app/notebook/data_catalog.py's _discover_athena_table.
    try:
        glue = boto3.client("glue", region_name=region)
        for t in glue.get_tables(DatabaseName=athena_db).get("TableList", []):
            update_time = t.get("UpdateTime")
            entities.append({
                "source_id": f"{athena_db}.{t['Name']}",
                "source_type": "athena",
                "database": athena_db,
                "table_name": t["Name"],
                "s3_location": t.get("StorageDescriptor", {}).get("Location", ""),
                "glue_update_time": update_time.isoformat() if update_time else None,
            })
    except Exception as e:
        logger.warning(f"[entity-discovery] Athena/Glue enumeration failed: {e}")

    return entities


# =============================================================================
# STEP 2: CHEAP CHANGE-SIGNAL FINGERPRINTING (no data read required)
# =============================================================================

def compute_change_signal(entity: dict, region: str) -> dict:
    """
    Compute a cheap, source-type-specific fingerprint used to detect whether
    an entity needs re-discovery, without reading/profiling the actual data.

    - S3: ETag + LastModified (the same signal AWS Glue's own incremental
      crawler uses to detect changed objects cheaply).
    - Athena: Glue's table UpdateTime only reflects DDL/table-definition
      changes, not new data files, so we also check the underlying S3
      location's most recent object LastModified — without running a
      (billed) Athena query.
    - DynamoDB: no cheap native "changed since" signal exists without
      enabling DynamoDB Streams (a heavier CDC mechanism, worth adding when
      this moves to the cloud). ItemCount/TableSizeBytes from describe_table
      are free but only refresh ~every 6h — a weak best-effort proxy.
    """
    source_type = entity["source_type"]

    if source_type == "s3":
        s3 = boto3.client("s3", region_name=region)
        head = s3.head_object(Bucket=entity["bucket"], Key=entity["key"])
        return {
            "etag": head.get("ETag", "").strip('"'),
            "last_modified": head["LastModified"].isoformat(),
            "size_bytes": head.get("ContentLength", 0),
        }

    if source_type == "athena":
        signal = {"glue_update_time": entity.get("glue_update_time")}
        location = entity.get("s3_location", "")
        if location.startswith("s3://"):
            loc_bucket, _, prefix = location[5:].partition("/")
            try:
                s3 = boto3.client("s3", region_name=region)
                resp = s3.list_objects_v2(Bucket=loc_bucket, Prefix=prefix, MaxKeys=100)
                latest = max((o["LastModified"] for o in resp.get("Contents", [])), default=None)
                signal["data_last_modified"] = latest.isoformat() if latest else None
            except Exception:
                signal["data_last_modified"] = None
        return signal

    if source_type == "dynamodb":
        ddb = boto3.client("dynamodb", region_name=region)
        desc = ddb.describe_table(TableName=entity["table_name"])["Table"]
        return {
            "item_count": desc.get("ItemCount", 0),
            "table_size_bytes": desc.get("TableSizeBytes", 0),
        }

    return {}


def _entity_needs_discovery(entity: dict, region: str, storage, force: bool) -> tuple[bool, dict]:
    """Returns (needs_discovery, current_change_signal)."""
    current_signal = compute_change_signal(entity, region)
    if force:
        return True, current_signal
    existing = storage.entity_get(entity["source_id"])
    if not existing or existing.get("status") != "ready":
        return True, current_signal
    stored_signal = existing.get("change_signal") or {}
    return (stored_signal != current_signal), current_signal


# =============================================================================
# STEP 3: PROFILE A SAMPLE OF THE ENTITY'S DATA
# =============================================================================

def _convert_dynamo_decimals(items: list[dict]) -> list[dict]:
    """DynamoDB returns Decimal for all numeric attributes — convert to
    float/int so pandas treats them as numeric columns instead of object,
    otherwise describe()/numeric profiling silently skips them."""
    def convert(v):
        if isinstance(v, Decimal):
            return float(v) if v % 1 else int(v)
        if isinstance(v, list):
            return [convert(x) for x in v]
        if isinstance(v, dict):
            return {k: convert(x) for k, x in v.items()}
        return v
    return [{k: convert(v) for k, v in item.items()} for item in items]


def _profile_dataframe(df) -> dict:
    """Compute describe/nulls/duplicates/dtypes stats for a sampled DataFrame.
    All values are cast to native Python types so the result is directly
    JSON-serializable (numpy scalar types are not)."""
    total_rows = len(df)
    null_counts = df.isnull().sum()

    from app.notebook.dtypes import normalize_dtype

    stats = {
        "sampled_rows": total_rows,
        "columns": [
            {
                "name": col,
                "dtype": normalize_dtype(str(df[col].dtype)),
                "null_pct": round(float(null_counts[col]) / total_rows * 100, 1) if total_rows else 0.0,
                "unique_count": int(df[col].nunique()),
                "sample_values": [str(v) for v in df[col].dropna().unique()[:5].tolist()],
            }
            for col in df.columns
        ],
        "duplicate_row_pct": round(float(df.duplicated().sum()) / total_rows * 100, 1) if total_rows else 0.0,
    }

    numeric_df = df.select_dtypes(include="number")
    if not numeric_df.empty:
        desc = numeric_df.describe().to_dict()
        stats["numeric_describe"] = {
            col: {k: (round(float(v), 3) if isinstance(v, (int, float)) else v) for k, v in vals.items()}
            for col, vals in desc.items()
        }

    return stats


def _query_athena_sample(database: str, table: str, region: str):
    """Run a bounded Athena query and return the result as a DataFrame."""
    import time
    import pandas as pd

    athena = boto3.client("athena", region_name=region)
    sts = boto3.client("sts", region_name=region)
    account = sts.get_caller_identity()["Account"]
    bucket = os.environ.get("ARTIFACT_BUCKET", f"microvm-sandbox-artifacts-{account}-{region}")
    workgroup = os.environ.get("ATHENA_WORKGROUP", "microvm-demo")

    response = athena.start_query_execution(
        QueryString=f"SELECT * FROM {database}.{table} LIMIT {SAMPLE_ROW_LIMIT}",
        QueryExecutionContext={"Database": database},
        WorkGroup=workgroup,
        ResultConfiguration={"OutputLocation": f"s3://{bucket}/athena-results/"},
    )
    query_id = response["QueryExecutionId"]

    state = "RUNNING"
    status = None
    for _ in range(60):  # up to ~30s
        status = athena.get_query_execution(QueryExecutionId=query_id)
        state = status["QueryExecution"]["Status"]["State"]
        if state in ("SUCCEEDED", "FAILED", "CANCELLED"):
            break
        time.sleep(0.5)

    if state != "SUCCEEDED":
        reason = (status["QueryExecution"]["Status"].get("StateChangeReason", "Unknown")
                  if status else "Timed out waiting for query")
        raise RuntimeError(f"Athena query failed: {reason}")

    results = athena.get_query_results(QueryExecutionId=query_id)
    col_info = results["ResultSet"]["ResultSetMetadata"]["ColumnInfo"]
    columns = [c["Name"] for c in col_info]
    col_types = {c["Name"]: c.get("Type", "varchar") for c in col_info}
    rows = [[f.get("VarCharValue", "") for f in row["Data"]] for row in results["ResultSet"]["Rows"][1:]]
    df = pd.DataFrame(rows, columns=columns)

    # Cast columns to their declared Athena types so profiling sees correct dtypes
    # (Athena query results return everything as strings — without this, the entity
    # profile would flag every numeric column as "type mismatch: stored as string")
    for col, atype in col_types.items():
        atype_lower = atype.lower()
        try:
            if atype_lower in ("integer", "int", "bigint", "smallint", "tinyint"):
                df[col] = pd.to_numeric(df[col], errors="coerce").astype("Int64")
            elif atype_lower in ("double", "float", "decimal", "real"):
                df[col] = pd.to_numeric(df[col], errors="coerce")
            elif atype_lower in ("boolean",):
                df[col] = df[col].map({"true": True, "false": False})
            elif atype_lower in ("date", "timestamp") or atype_lower.startswith("timestamp"):
                # Athena DATE/TIMESTAMP columns arrive as strings in query results; cast to
                # native datetime so the profile reports a datetime dtype (not a false
                # "stored as string" type_mismatch).
                df[col] = pd.to_datetime(df[col], errors="coerce")
        except Exception:
            pass  # leave as string if cast fails

    return df


def fetch_and_profile(entity: dict, region: str) -> dict:
    """Fetch a bounded sample of the entity's data and compute profiling stats."""
    import pandas as pd

    source_type = entity["source_type"]

    if source_type == "s3":
        s3 = boto3.client("s3", region_name=region)
        obj = s3.get_object(Bucket=entity["bucket"], Key=entity["key"])
        body = obj["Body"].read()
        ext = entity["extension"]
        if ext == "csv":
            df = pd.read_csv(io.BytesIO(body), nrows=SAMPLE_ROW_LIMIT)
        elif ext == "parquet":
            df = pd.read_parquet(io.BytesIO(body)).head(SAMPLE_ROW_LIMIT)
        elif ext == "json":
            df = pd.read_json(io.BytesIO(body), lines=True)
            if len(df) > SAMPLE_ROW_LIMIT:
                df = df.head(SAMPLE_ROW_LIMIT)
        else:
            raise ValueError(f"Unsupported S3 extension: {ext}")
        row_count_note = f"Profile based on a sample of up to {SAMPLE_ROW_LIMIT} rows (file size: {obj.get('ContentLength', 0):,} bytes)."

    elif source_type == "athena":
        df = _query_athena_sample(entity["database"], entity["table_name"], region)
        row_count_note = f"Profile based on a sample of up to {SAMPLE_ROW_LIMIT} rows queried via Athena."

    elif source_type == "dynamodb":
        ddb = boto3.resource("dynamodb", region_name=region)
        table = ddb.Table(entity["table_name"])
        resp = table.scan(Limit=SAMPLE_ROW_LIMIT)
        df = pd.DataFrame(_convert_dynamo_decimals(resp.get("Items", [])))
        row_count_note = f"Profile based on a sample of up to {SAMPLE_ROW_LIMIT} items via DynamoDB scan."

    else:
        raise ValueError(f"Unsupported source_type: {source_type}")

    stats = _profile_dataframe(df)
    stats["sample_note"] = row_count_note
    return stats


# =============================================================================
# STEP 4: GENERATE THE PER-ENTITY MARKDOWN (one-shot Bedrock call, no tools)
# =============================================================================

def generate_entity_markdown(entity: dict, stats: dict) -> dict:
    """
    Call Bedrock once (no agent/tool loop — all facts are already computed
    and handed in as text) to turn the stats into a business-readable
    profile. Returns {"business_description", "quality_flags", "markdown"}.
    """
    from proxy.notebook.ai.constants import AGENT_TEMPERATURE

    prompt = ENTITY_DISCOVERY_PROMPT.format(
        source_id=entity["source_id"],
        source_type=entity["source_type"],
        stats_json=json.dumps(stats, indent=2, default=str),
    )

    client = _get_bedrock_client()
    response = client.converse(
        modelId=AI_MODEL_ID,
        messages=[{"role": "user", "content": [{"text": prompt}]}],
        inferenceConfig={"maxTokens": 2048, "temperature": AGENT_TEMPERATURE},
    )
    raw_text = response["output"]["message"]["content"][0]["text"].strip()

    # Strip markdown code fences if present (same pattern used in workbook_intel.py)
    if "```json" in raw_text:
        raw_text = raw_text.split("```json")[1].split("```")[0].strip()
    elif raw_text.startswith("```"):
        lines = raw_text.split("\n")
        raw_text = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:]).strip()

    json_text = raw_text
    if not json_text.startswith("{"):
        first, last = json_text.find("{"), json_text.rfind("}")
        if first != -1 and last > first:
            json_text = json_text[first:last + 1]

    try:
        return json.loads(json_text)
    except json.JSONDecodeError as e:
        logger.warning(f"[entity-discovery] JSON parse failed for {entity['source_id']}: {e}")
        return {"business_description": "", "quality_flags": [], "markdown": raw_text}


# =============================================================================
# STEP 5: SAVE DOC TO S3 + METADATA TO SQLITE
# =============================================================================

def _sanitize_source_id(source_id: str) -> str:
    return "".join(c if c.isalnum() or c in "._-" else "_" for c in source_id)


def save_entity_doc(source_id: str, result: dict, bucket: str, region: str) -> str:
    """Save the full entity discovery result (business_description + quality_flags +
    markdown) as JSON to S3. Consumers can fetch the full doc or just the lightweight
    fields (business_description, quality_flags) depending on their use case."""
    s3 = boto3.client("s3", region_name=region)
    s3_key = f"data-catalog/entities/{_sanitize_source_id(source_id)}.json"
    payload = {
        "source_id": source_id,
        "business_description": result.get("business_description", ""),
        "quality_flags": result.get("quality_flags", []),
        "markdown": result.get("markdown", ""),
    }
    s3.put_object(
        Bucket=bucket, Key=s3_key,
        Body=json.dumps(payload, indent=2).encode("utf-8"),
        ContentType="application/json",
    )
    return s3_key


# =============================================================================
# ORCHESTRATION
# =============================================================================

def discover_entity(entity: dict, bucket: str, region: str, storage, force: bool = False) -> dict:
    """Discover (or skip, if unchanged) a single entity end to end."""
    source_id = entity["source_id"]
    try:
        needs_discovery, change_signal = _entity_needs_discovery(entity, region, storage, force)
        if not needs_discovery:
            return {"source_id": source_id, "status": "skipped_unchanged"}

        storage.entity_upsert(source_id, entity["source_type"], status="discovering")

        stats = fetch_and_profile(entity, region)
        result = generate_entity_markdown(entity, stats)
        doc_s3_key = save_entity_doc(source_id, result, bucket, region)

        storage.entity_upsert(
            source_id, entity["source_type"],
            doc_s3_key=doc_s3_key, change_signal=change_signal, status="ready",
        )
        logger.info(f"[entity-discovery] Discovered {source_id} -> {doc_s3_key}")
        return {"source_id": source_id, "status": "discovered", "doc_s3_key": doc_s3_key}

    except Exception as e:
        logger.error(f"[entity-discovery] Failed for {source_id}: {e}")
        try:
            storage.entity_upsert(source_id, entity["source_type"], status="error")
        except Exception:
            pass
        return {"source_id": source_id, "status": "error", "error": str(e)}


def discover_all_global_entities(bucket: str, athena_db: str, region: str, storage,
                                  force: bool = False,
                                  max_workers: int = MAX_CONCURRENT_DISCOVERY) -> dict:
    """
    Enumerate all global entities and discover (or skip) each one, bounded by
    a small thread pool so we never fire more than max_workers concurrent
    Bedrock calls at once.
    """
    entities = list_global_entities(bucket, athena_db, region)
    logger.info(f"[entity-discovery] Found {len(entities)} global entities")

    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = {pool.submit(discover_entity, e, bucket, region, storage, force): e for e in entities}
        for future in concurrent.futures.as_completed(futures):
            results.append(future.result())

    summary = {
        "total": len(results),
        "discovered": sum(1 for r in results if r["status"] == "discovered"),
        "skipped_unchanged": sum(1 for r in results if r["status"] == "skipped_unchanged"),
        "errors": sum(1 for r in results if r["status"] == "error"),
        "results": results,
    }
    logger.info(f"[entity-discovery] Done: {summary['discovered']} discovered, "
                f"{summary['skipped_unchanged']} unchanged, {summary['errors']} errors")
    return summary


# =============================================================================
# LOCAL FILE ENTITIES (session-scoped — uploaded /tmp files)
#
# Same overall shape as global entity discovery, but:
#   - Enumerated via the session's own VM catalog (GET /datasources/catalog),
#     not boto3, since these files only exist on that one VM's disk.
#   - Profiled by running a deterministic pandas snippet on that SAME VM via
#     the existing generic execute endpoint (the same mechanism the agent's
#     execute_code tool uses) — no new VM-side code or image rebuild needed.
#   - Saved under sessions/{session_id}/local-entities/ in S3 and tracked in
#     the local_file_entities table, keyed by (session_id, filepath) instead
#     of a global source_id.
# =============================================================================

# Local files share a single VM's executor. That executor redirects sys.stdout and
# is NOT thread-safe, which historically forced sequential profiling (concurrency=1)
# to avoid interleaved /execute calls returning empty/garbled output.
#
# This is now safe to parallelize: the VM-side /execute endpoint (app/notebook/
# code_engine.py) serializes every execution under an asyncio.Lock, so even if the
# proxy fires concurrent profiling requests, the VM runs them one at a time (no stdout
# race). The parallelism still wins because the per-file Bedrock doc-generation calls
# (the slow part) overlap across threads while VM execution is serialized VM-side.
LOCAL_DISCOVERY_CONCURRENCY = 3


def _list_local_files_from_catalog(proxy_url: str, session_id: str) -> list[dict]:
    """Fetch the session's VM data catalog and return only local (/tmp) file entries."""
    import httpx
    try:
        resp = httpx.get(
            f"{proxy_url}/datasources/catalog",
            headers={"X-Session-Id": session_id},
            timeout=10.0,
        )
        if resp.status_code != 200:
            return []
        catalog = resp.json()
        return [e for e in catalog.get("entries", []) if e.get("source_type") == "local"]
    except Exception as e:
        logger.warning(f"[entity-discovery] Failed to fetch catalog for local files: {e}")
        return []


def _execute_on_vm(proxy_url: str, session_id: str, code: str, timeout: float = 60.0) -> str:
    """Run code on the session's VM via the proxy's generic execute endpoint (the
    same mechanism the agent's execute_code tool uses) and return stdout. Raises on failure."""
    import httpx
    resp = httpx.post(
        f"{proxy_url}/proxy/execute",
        headers={"X-Session-Id": session_id, "Content-Type": "application/json"},
        json={"code": code},
        timeout=timeout,
    )
    if resp.status_code != 200:
        raise RuntimeError(f"VM execute HTTP {resp.status_code}: {resp.text[:300]}")
    data = resp.json()
    if not data.get("success"):
        raise RuntimeError(f"VM execute failed: {data.get('error', 'unknown error')}")
    output = data.get("output", "")
    # If success=True but output is empty and there's an error field, the code
    # partially failed (e.g. exception on the last line after some output)
    if not output and data.get("error"):
        raise RuntimeError(f"VM execute returned empty output with error: {data['error']}")
    return output


_STATS_MARKER = "__ENTITY_STATS_JSON__"


def _build_local_profile_code(filepath: str, sample_limit: int) -> str:
    """Deterministic pandas snippet (no LLM involved) that computes the same
    profiling shape as _profile_dataframe, run remotely on the session's VM."""
    return f'''
import pandas as _pd, json as _json
_path = {filepath!r}
_ext = _path.rsplit(".", 1)[-1].lower() if "." in _path else ""
if _ext == "csv":
    _df = _pd.read_csv(_path, nrows={sample_limit})
elif _ext == "parquet":
    _df = _pd.read_parquet(_path).head({sample_limit})
elif _ext == "json":
    try:
        _df = _pd.read_json(_path, lines=True).head({sample_limit})
    except Exception:
        _df = _pd.read_json(_path).head({sample_limit})
elif _ext in ("xlsx", "xls"):
    _df = _pd.read_excel(_path).head({sample_limit})
else:
    _df = _pd.read_csv(_path, nrows={sample_limit})

def _norm_dtype(_d):
    _d = str(_d).lower().strip()
    if _d == "object": return "string"
    if _d.startswith("float"): return "float"
    if _d.startswith("int") or _d.startswith("uint"): return "int"
    if _d.startswith("bool"): return "bool"
    if _d.startswith("datetime"): return "datetime"
    if _d in ("string", "str"): return "string"
    return _d

_total = len(_df)
_nulls = _df.isnull().sum()
_stats = {{
    "sampled_rows": _total,
    "columns": [
        {{
            "name": _c,
            "dtype": _norm_dtype(_df[_c].dtype),
            "null_pct": round(float(_nulls[_c]) / _total * 100, 1) if _total else 0.0,
            "unique_count": int(_df[_c].nunique()),
            "sample_values": [str(_v) for _v in _df[_c].dropna().unique()[:5].tolist()],
        }}
        for _c in _df.columns
    ],
    "duplicate_row_pct": round(float(_df.duplicated().sum()) / _total * 100, 1) if _total else 0.0,
}}
_numeric = _df.select_dtypes(include="number")
if not _numeric.empty:
    _desc = _numeric.describe().to_dict()
    _stats["numeric_describe"] = {{
        _col: {{_k: (round(float(_v), 3) if isinstance(_v, (int, float)) else _v) for _k, _v in _vals.items()}}
        for _col, _vals in _desc.items()
    }}
print({_STATS_MARKER!r} + _json.dumps(_stats, default=str))
'''


def profile_local_file_via_vm(proxy_url: str, session_id: str, filepath: str) -> dict:
    """Profile a local /tmp file by running a deterministic pandas snippet on the
    session's own VM. Requires no new VM-side code — reuses the generic execute endpoint.
    Retries once if the first attempt returns empty output (can happen if the VM
    executor is momentarily busy from a prior request)."""
    import time as _time
    code = _build_local_profile_code(filepath, SAMPLE_ROW_LIMIT)

    for attempt in range(2):
        output = _execute_on_vm(proxy_url, session_id, code)
        idx = output.find(_STATS_MARKER)
        if idx != -1:
            break
        if attempt == 0:
            logger.warning(f"[entity-discovery] Profiling {filepath}: empty output on first attempt, retrying in 2s...")
            _time.sleep(2)

    if idx == -1:
        raise RuntimeError(f"Profiling output missing expected marker after 2 attempts: {output[:300]}")

    json_str = output[idx + len(_STATS_MARKER):].strip()
    decoder = json.JSONDecoder()
    try:
        stats, _ = decoder.raw_decode(json_str)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"Failed to parse profiling stats JSON: {e}\nRaw: {json_str[:500]}")
    stats["sample_note"] = (
        f"Profile based on a sample of up to {SAMPLE_ROW_LIMIT} rows read directly "
        f"from this workbook's VM."
    )
    return stats


def _local_change_signal(entry: dict) -> dict:
    """Cheap fingerprint for a local file, sourced from the VM catalog entry
    (already computed by app/notebook/data_catalog.py — no extra VM round-trip)."""
    return {"size": entry.get("size"), "row_count": entry.get("row_count")}


def save_local_entity_doc(session_id: str, filepath: str, result: dict, bucket: str, region: str) -> str:
    """Save local file entity doc as JSON (same format as global entities)."""
    s3 = boto3.client("s3", region_name=region)
    s3_key = f"sessions/{session_id}/local-entities/{_sanitize_source_id(os.path.basename(filepath))}.json"
    payload = {
        "source_id": filepath,
        "business_description": result.get("business_description", ""),
        "quality_flags": result.get("quality_flags", []),
        "markdown": result.get("markdown", ""),
    }
    s3.put_object(
        Bucket=bucket, Key=s3_key,
        Body=json.dumps(payload, indent=2).encode("utf-8"),
        ContentType="application/json",
    )
    return s3_key


def discover_local_file(entry: dict, session_id: str, proxy_url: str, bucket: str, region: str,
                        storage, force: bool = False) -> dict:
    """Discover (or skip, if unchanged) one local file end to end."""
    filepath = entry["source_id"]  # the VM catalog uses the raw /tmp path as source_id for local files
    try:
        current_signal = _local_change_signal(entry)
        if not force:
            existing = storage.local_entity_get(session_id, filepath)
            if (existing and existing.get("status") == "ready"
                    and (existing.get("change_signal") or {}) == current_signal):
                return {"source_id": filepath, "status": "skipped_unchanged"}

        storage.local_entity_upsert(session_id, filepath, status="discovering")

        stats = profile_local_file_via_vm(proxy_url, session_id, filepath)
        pseudo_entity = {"source_id": f"local.{os.path.basename(filepath)}", "source_type": "local"}
        result = generate_entity_markdown(pseudo_entity, stats)
        doc_s3_key = save_local_entity_doc(session_id, filepath, result, bucket, region)

        storage.local_entity_upsert(session_id, filepath, doc_s3_key=doc_s3_key,
                                    change_signal=current_signal, status="ready")
        logger.info(f"[entity-discovery] Discovered local file {filepath} "
                    f"(session {session_id[:8]}...) -> {doc_s3_key}")
        return {"source_id": filepath, "status": "discovered", "doc_s3_key": doc_s3_key}

    except Exception as e:
        logger.error(f"[entity-discovery] Local file discovery failed for {filepath}: {e}")
        try:
            storage.local_entity_upsert(session_id, filepath, status="error")
        except Exception:
            pass
        return {"source_id": filepath, "status": "error", "error": str(e)}


def discover_all_local_files(session_id: str, proxy_url: str, bucket: str, region: str, storage,
                             force: bool = False, max_workers: int = LOCAL_DISCOVERY_CONCURRENCY) -> dict:
    """
    Ensure every local /tmp file in this session has an up-to-date profile doc.
    Call this before generating a workbook's insight so local-file docs are
    fresh by the time they're read.
    """
    entries = _list_local_files_from_catalog(proxy_url, session_id)
    if not entries:
        return {"total": 0, "discovered": 0, "skipped_unchanged": 0, "errors": 0, "results": []}

    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = {
            pool.submit(discover_local_file, e, session_id, proxy_url, bucket, region, storage, force): e
            for e in entries
        }
        for future in concurrent.futures.as_completed(futures):
            results.append(future.result())

    return {
        "total": len(results),
        "discovered": sum(1 for r in results if r["status"] == "discovered"),
        "skipped_unchanged": sum(1 for r in results if r["status"] == "skipped_unchanged"),
        "errors": sum(1 for r in results if r["status"] == "error"),
        "results": results,
    }


# =============================================================================
# SHARED DOC-FETCHING HELPER — used by proxy.notebook.ai.workbook_intel to pull
# already-discovered docs (global or local) into the Workbook Intel prompt.
# =============================================================================

def get_entity_doc_markdown(source_id: str, bucket: str, region: str, storage,
                            session_id: str = None) -> str | None:
    """
    Fetch the markdown content for one entity doc, global or local.

    Pass session_id to look up a local /tmp file (scoped to that session);
    omit it to look up a global entity (S3/Athena/DynamoDB).
    Returns None if the doc doesn't exist yet or isn't ready.
    """
    meta = storage.local_entity_get(session_id, source_id) if session_id else storage.entity_get(source_id)
    if not meta or meta.get("status") != "ready" or not meta.get("doc_s3_key"):
        return None
    try:
        s3 = boto3.client("s3", region_name=region)
        obj = s3.get_object(Bucket=bucket, Key=meta["doc_s3_key"])
        return obj["Body"].read().decode("utf-8")
    except Exception as e:
        logger.warning(f"[entity-discovery] Failed to fetch doc for {source_id}: {e}")
        return None


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    region = os.environ.get("AWS_REGION", "us-west-2")
    account_id = os.environ.get("ACCOUNT_ID", "")
    if not account_id:
        try:
            account_id = boto3.client("sts", region_name=region).get_caller_identity()["Account"]
        except Exception:
            account_id = "unknown"
    bucket = os.environ.get("ARTIFACT_BUCKET", f"microvm-sandbox-artifacts-{account_id}-{region}")
    athena_db = os.environ.get("ATHENA_DB", "microvm_demo_db")
    force = os.environ.get("FORCE_REDISCOVER", "").lower() in ("1", "true", "yes")

    from proxy.storage import storage as _storage
    _storage.initialize()

    print(f"Discovering global entities in bucket={bucket}, athena_db={athena_db}, region={region} (force={force})")
    summary = discover_all_global_entities(bucket, athena_db, region, _storage, force=force)
    print(json.dumps({k: v for k, v in summary.items() if k != "results"}, indent=2))
    for r in summary["results"]:
        suffix = f" -> {r.get('doc_s3_key')}" if r.get("doc_s3_key") else (f" ({r.get('error')})" if r.get("error") else "")
        print(f"  [{r['status']}] {r['source_id']}{suffix}")
