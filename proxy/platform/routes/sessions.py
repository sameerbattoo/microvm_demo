"""
Session checkpoint management and data source discovery routes.

Part of: proxy.platform (Smart MicroVM Service layer)

Endpoints:
  GET    /sessions            - List S3 session checkpoints
  DELETE /sessions/{id}       - Delete a session checkpoint from S3
  GET    /datasources         - List accessible data sources (S3, DynamoDB, Athena)
"""

import os
import json
import functools
import logging

import boto3
from fastapi import APIRouter, Request, Response

from proxy.platform.microvm_manager import AWS_REGION

logger = logging.getLogger(__name__)

# Athena workgroup is surfaced in the /datasources response so the frontend can
# show it. The Glue database + all source enumeration now live in the data source
# provider registry (proxy/platform/datasources), not here.
ATHENA_WORKGROUP = os.environ.get("ATHENA_WORKGROUP", "microvm-demo")

router = APIRouter(tags=["sessions"])


@router.get("/sessions")
async def list_sessions(request: Request):
    """List available session checkpoints from S3."""
    vm_manager = request.app.state.vm_manager
    try:
        s3 = boto3.client("s3", region_name=AWS_REGION)
        bucket_name = vm_manager.get_artifacts_bucket()

        if not bucket_name:
            return {"sessions": []}

        sessions = []
        paginator = s3.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=bucket_name, Prefix="sessions/", Delimiter="/"):
            for prefix_obj in page.get("CommonPrefixes", []):
                session_prefix = prefix_obj["Prefix"]
                session_id = session_prefix.replace("sessions/", "").rstrip("/")

                metadata = {}
                try:
                    meta_resp = s3.get_object(Bucket=bucket_name, Key=f"{session_prefix}metadata.json")
                    metadata = json.loads(meta_resp["Body"].read())
                except Exception:
                    pass

                sessions.append({
                    "session_id": session_id,
                    "checkpointed_at": metadata.get("checkpointed_at"),
                    "execution_count": metadata.get("execution_count", 0),
                    "variables_count": metadata.get("variables_count", 0),
                    "files_count": metadata.get("files_count", 0),
                    "checkpoint_size_kb": metadata.get("checkpoint_size_kb", 0),
                    "save_timings_ms": metadata.get("save_timings_ms", {}),
                })

        sessions.sort(key=lambda s: s.get("checkpointed_at") or "", reverse=True)
        return {"sessions": sessions}

    except Exception as e:
        logger.error(f"Failed to list sessions: {e}")
        return {"sessions": []}


@router.delete("/sessions/{session_id}")
async def delete_session(session_id: str, request: Request):
    """Delete a session checkpoint from S3."""
    vm_manager = request.app.state.vm_manager
    try:
        s3 = boto3.client("s3", region_name=AWS_REGION)
        bucket_name = vm_manager.get_artifacts_bucket()
        if not bucket_name:
            return {"error": "Bucket not found"}

        prefix = f"sessions/{session_id}/"
        resp = s3.list_objects_v2(Bucket=bucket_name, Prefix=prefix)
        for obj in resp.get("Contents", []):
            s3.delete_object(Bucket=bucket_name, Key=obj["Key"])

        return {"status": "deleted", "session_id": session_id}
    except Exception as e:
        return Response(
            content=f'{{"error": "Delete failed: {str(e)}"}}',
            status_code=500,
            media_type="application/json",
        )


@router.get("/datasources")
async def list_datasources(request: Request):
    """
    List external data sources accessible from the MicroVM.

    Registry-driven: enumeration is delegated to each provider's discover().
    Returns a generic `sources` array (+ `source_types` metadata) that the panel
    renders generically, plus legacy grouped arrays (s3/dynamodb/athena) kept for
    backward compatibility.
    """
    from proxy.platform.datasources import registry

    vm_manager = request.app.state.vm_manager
    bucket_name = None
    try:
        bucket_name = vm_manager.get_artifacts_bucket()
    except Exception:
        pass

    refs = await registry.discover_all()

    # Generic, type-agnostic list (the data-driven panel consumes this).
    sources = [r.to_dict() for r in refs]

    # Legacy grouped arrays rebuilt from the same discovery results.
    s3_files, dynamodb_tables, athena_tables = [], [], []
    for r in refs:
        if r.source_type == "s3":
            s3_files.append({
                "key": r.extra.get("key"),
                "bucket": r.extra.get("bucket"),
                "size": r.extra.get("size"),
                "size_bytes": r.extra.get("size_bytes"),
                "uri": r.extra.get("uri"),
            })
        elif r.source_type == "dynamodb":
            dynamodb_tables.append({
                "name": r.extra.get("name"),
                "item_count": r.extra.get("item_count", 0),
                "region": r.extra.get("region"),
            })
        elif r.source_type == "athena":
            athena_tables.append({
                "name": r.extra.get("name"),
                "database": r.extra.get("database"),
                "columns": r.extra.get("columns", []),
                "column_count": r.extra.get("column_count", 0),
                "region": r.extra.get("region"),
            })

    return {
        "sources": sources,
        "source_types": registry.provider_metadata(),
        "s3": s3_files,
        "dynamodb": dynamodb_tables,
        "athena": athena_tables,
        "artifact_bucket": bucket_name,
        "athena_workgroup": ATHENA_WORKGROUP,
    }


@router.get("/datasources/schema")
async def get_datasource_schema(source_type: str, source_id: str, request: Request, session_id: str = None):
    """
    Get column schema for a specific data source.

    First tries the VM's data catalog (pre-discovered schemas) for instant response.
    Falls back to direct AWS API calls if the VM catalog doesn't have it.

    Args:
        source_type: 'athena', 'dynamodb', 's3', 'local'
        source_id: Table name, S3 URI, or file path
        session_id: Required for 'local' type (to forward request to the VM)

    Returns:
        {
            "source_type": "athena",
            "source_id": "microvm_demo_db.customers",
            "display_name": "customers",
            "columns": [{"name": "customer_id", "dtype": "string", "sample": "CUST-0100"}, ...],
            "row_count": 200,
            "size": "13 KB"
        }
    """
    from proxy.platform.datasources import registry
    import httpx

    vm_manager = request.app.state.vm_manager

    # --- Try VM data catalog first (instant, pre-discovered) ---
    if session_id:
        session_vm = vm_manager.get_session_vm(session_id)
        if session_vm:
            try:
                token = vm_manager.get_auth_token(session_vm["vm_id"])
                async with httpx.AsyncClient(timeout=5.0) as client:
                    resp = await client.get(
                        f"https://{session_vm['endpoint']}/data-catalog",
                        headers={"X-aws-proxy-auth": token},
                        params={"source_id": source_id},
                    )
                    if resp.status_code == 200:
                        data = resp.json()
                        # Only return if schema has been discovered (not pending)
                        if data.get("status") == "discovered" and data.get("columns"):
                            # Normalize dtypes at proxy boundary (VM may still
                            # report raw pandas names until image is rebuilt)
                            for col in data.get("columns", []):
                                if "dtype" in col:
                                    col["dtype"] = _normalize_col_dtype(col["dtype"])
                            return data
            except Exception:
                pass  # Fall through to direct provider

    # --- Fallback: direct provider via the registry ---
    meta = {m["source_type"]: m for m in registry.provider_metadata()}
    if source_type not in meta:
        return Response(
            content=f'{{"error": "Unknown source type: {source_type}"}}',
            status_code=400,
            media_type="application/json",
        )

    # Providers that need VM execution (local files) require a session + endpoint,
    # so build an execute_fn that forwards code to the session's VM.
    execute_on_vm = None
    if meta[source_type]["requires_vm_execution"]:
        if not session_id:
            return Response(
                content='{"error": "session_id required for this source type"}',
                status_code=400,
                media_type="application/json",
            )
        session_vm = vm_manager.get_session_vm(session_id)
        if not session_vm:
            return Response(
                content='{"error": "Session not found"}',
                status_code=404,
                media_type="application/json",
            )

        async def execute_on_vm(sid, code):
            token = vm_manager.get_auth_token(session_vm["vm_id"])
            async with httpx.AsyncClient(timeout=15.0) as client:
                resp = await client.post(
                    f"https://{session_vm['endpoint']}/execute",
                    headers={"X-aws-proxy-auth": token, "Content-Type": "application/json"},
                    json={"code": code},
                )
                if resp.status_code == 200:
                    return resp.json()
                return None

    provider = registry.get_provider(source_type, execute_fn=execute_on_vm)
    schema = await provider.get_schema(source_id, session_id=session_id)
    if not schema:
        return Response(
            content=f'{{"error": "Schema not found for {source_id}"}}',
            status_code=404,
            media_type="application/json",
        )

    return {
        "source_type": schema.source_type,
        "source_id": schema.source_id,
        "display_name": schema.display_name,
        "columns": [{"name": c.name, "dtype": _normalize_col_dtype(c.dtype), "sample": c.sample, "nullable": c.nullable} for c in schema.columns],
        "row_count": schema.row_count,
        "size": schema.size,
    }


def _normalize_col_dtype(raw: str) -> str:
    """Normalize dtype at the API boundary — ensures consistent labels even if
    the upstream provider (VM catalog, fallback provider) hasn't been updated yet."""
    from app.notebook.dtypes import normalize_dtype
    return normalize_dtype(raw)


def _enrich_catalog_entries(entries: list[dict], session_id: str = None) -> None:
    """
    In-place enrichment: for each catalog entry, check if a pre-computed entity
    doc exists (from batch/entity_discovery.py for global sources, or from the
    per-session local_file_entities table for local /tmp files) and if so, attach
    lightweight metadata (business_description, quality_flags summary) so the
    frontend can show an indicator and popover without fetching the full doc.
    """
    from proxy.storage import storage

    for entry in entries:
        source_id = entry.get("source_id", "")
        source_type = entry.get("source_type", "")
        if not source_id:
            entry["has_entity_doc"] = False
            continue

        meta = None
        if source_type == "local" and session_id:
            # Local files are session-scoped — check the local_file_entities table
            meta = storage.local_entity_get(session_id, source_id)
        else:
            # Global entities (S3, DynamoDB, Athena) — check data_source_entities table
            meta = storage.entity_get(source_id)

        if meta and meta.get("status") == "ready" and meta.get("doc_s3_key"):
            entry["has_entity_doc"] = True
            doc = _load_entity_doc_json_cached(meta["doc_s3_key"])
            if doc:
                entry["business_description"] = doc.get("business_description", "")
                entry["quality_flags"] = doc.get("quality_flags", [])
            else:
                entry["business_description"] = ""
                entry["quality_flags"] = []
        else:
            entry["has_entity_doc"] = False

        # Also normalize column dtypes at this enrichment boundary
        for col in entry.get("columns", []):
            if "dtype" in col:
                col["dtype"] = _normalize_col_dtype(col["dtype"])


def _load_entity_doc_json(s3_key: str) -> dict | None:
    """Load the full entity doc JSON from S3. Returns None on any failure."""
    import boto3
    region = os.environ.get("AWS_REGION", "us-west-2")
    bucket = os.environ.get(
        "ARTIFACT_BUCKET",
        f"microvm-sandbox-artifacts-{os.environ.get('ACCOUNT_ID', 'unknown')}-{region}"
    )
    try:
        s3 = boto3.client("s3", region_name=region)
        resp = s3.get_object(Bucket=bucket, Key=s3_key)
        return json.loads(resp["Body"].read().decode("utf-8"))
    except Exception:
        return None


# Cached wrapper — entity docs change rarely (only when batch/entity_discovery reruns).
# Avoids hitting S3 on every panel open (~12 calls per render otherwise).
@functools.lru_cache(maxsize=64)
def _load_entity_doc_json_cached(s3_key: str) -> dict | None:
    return _load_entity_doc_json(s3_key)


@router.get("/datasources/entity-doc")
async def get_entity_doc(source_id: str, request: Request):
    """
    Get the full entity profile document (markdown + metadata) for a data source.
    
    Returns the complete discovery result including business_description,
    quality_flags, and the full markdown profile. Called on-demand when the
    user clicks "View Full Profile" — NOT on every panel render.
    
    Works for both global entities (S3/Athena/DynamoDB) and local files
    (session-scoped /tmp files) — checks both tables.
    """
    from proxy.storage import storage

    session_id = request.headers.get("X-Session-Id", "")

    # Try global entity first
    meta = storage.entity_get(source_id)
    # If not found globally and we have a session_id, try local file entity
    if (not meta or meta.get("status") != "ready") and session_id:
        meta = storage.local_entity_get(session_id, source_id)

    if not meta or meta.get("status") != "ready" or not meta.get("doc_s3_key"):
        return Response(
            content=f'{{"error": "No entity doc found for source_id: {source_id}"}}',
            status_code=404,
            media_type="application/json",
        )

    doc = _load_entity_doc_json(meta["doc_s3_key"])
    if not doc:
        return Response(
            content='{"error": "Entity doc exists in DB but failed to load from S3"}',
            status_code=502,
            media_type="application/json",
        )

    return {
        "source_id": source_id,
        "business_description": doc.get("business_description", ""),
        "quality_flags": doc.get("quality_flags", []),
        "markdown": doc.get("markdown", ""),
    }


@router.get("/datasources/catalog")
async def get_full_catalog(request: Request):
    """
    Get the full data catalog from the VM (all sources with discovered schemas).
    Proxies GET /data-catalog from the active VM for the given session.
    Returns the progressive catalog — entries may still be "pending" if discovery is in progress.
    """
    import asyncio
    import httpx

    session_id = request.headers.get("X-Session-Id", "")
    if not session_id:
        return Response(content='{"error": "X-Session-Id header required"}', status_code=400, media_type="application/json")

    vm_manager = request.app.state.vm_manager
    session_vm = vm_manager.get_session_vm(session_id)
    if not session_vm:
        return Response(content='{"error": "No active VM for this session"}', status_code=404, media_type="application/json")

    # The VM's Lambda endpoint can return a transient 502/503 while the MicroVM is
    # still cold-starting or being rotated. If we returned that straight through,
    # enrichment (has_entity_doc → entity intel icons) would be silently skipped and
    # the frontend would show no icons until a manual refresh. Retry a few times with
    # a short backoff so a warming VM resolves without user intervention.
    RETRY_STATUSES = {502, 503, 504}
    MAX_ATTEMPTS = 4
    BACKOFF_SECONDS = 1.0

    last_resp = None
    last_error = None
    for attempt in range(MAX_ATTEMPTS):
        try:
            token = vm_manager.get_auth_token(session_vm["vm_id"])
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(
                    f"https://{session_vm['endpoint']}/data-catalog",
                    headers={"X-aws-proxy-auth": token},
                )
            if resp.status_code == 200:
                catalog = resp.json()
                # Enrich entries with entity doc metadata where available
                _enrich_catalog_entries(catalog.get("entries", []), session_id=session_id)
                return catalog

            last_resp = resp
            if resp.status_code not in RETRY_STATUSES:
                # Non-transient (e.g. 404/400) — no point retrying.
                return Response(content=resp.text, status_code=resp.status_code, media_type="application/json")
        except Exception as e:
            last_error = e

        if attempt < MAX_ATTEMPTS - 1:
            await asyncio.sleep(BACKOFF_SECONDS)

    if last_resp is not None:
        return Response(content=last_resp.text, status_code=last_resp.status_code, media_type="application/json")
    return Response(content=f'{{"error": "Failed to reach VM: {str(last_error)}"}}', status_code=502, media_type="application/json")


@router.get("/datasources/snippet")
async def get_datasource_snippet(source_type: str, source_id: str, language: str = "python"):
    """
    Get a ready-to-run code snippet for a data source.

    Args:
        source_type: 'athena', 'dynamodb', 's3', 'local'
        source_id: Table name, S3 URI, or file path
        language: 'python' or 'sql'

    Returns:
        {"code": "...", "cell_type": "code" or "sql"}
    """
    from proxy.platform.datasources import registry

    provider = registry.get_provider(source_type)
    if not provider:
        return Response(
            content=f'{{"error": "Unknown source type: {source_type}"}}',
            status_code=400,
            media_type="application/json",
        )

    if language == "sql":
        code = provider.get_sql_snippet(source_id)
        cell_type = "sql"
    else:
        code = provider.get_python_snippet(source_id)
        cell_type = "code"

    return {"code": code, "cell_type": cell_type}


@router.delete("/datasources/s3-file")
async def delete_datasource_s3_file(source_id: str, request: Request):
    """
    Delete an S3 file from the artifact bucket. Restricted to keys under a
    configured deletable prefix (DATASOURCE_S3_DELETABLE_PREFIXES, e.g. user-data/)
    so users can't remove sample data or arbitrary objects.

    Args:
        source_id: S3 URI ('s3://bucket/key') of the file to delete.

    Returns:
        {"deleted": "<source_id>"} on success. 403 if the key isn't in a deletable
        prefix; 400 for unknown provider; 500 if the S3 delete fails.
    """
    from proxy.platform.datasources import registry

    provider = registry.get_provider("s3")
    if not provider:
        return Response(
            content='{"error": "S3 provider unavailable"}',
            status_code=400,
            media_type="application/json",
        )

    if not provider.is_deletable(source_id):
        logger.warning(f"Rejected S3 delete (not in a deletable prefix): {source_id}")
        return Response(
            content=json.dumps({"error": "This file is not in a deletable location."}),
            status_code=403,
            media_type="application/json",
        )

    try:
        provider.delete(source_id)
        logger.info(f"Deleted S3 file: {source_id}")
    except Exception as e:
        logger.error(f"S3 delete failed for {source_id}: {e}")
        return Response(
            content=json.dumps({"error": f"Delete failed: {e}"}),
            status_code=500,
            media_type="application/json",
        )

    return {"deleted": source_id}


@router.get("/secrets")
async def list_secrets(request: Request):
    """List available secrets from AWS Secrets Manager (names only, not values)."""
    try:
        sm = boto3.client("secretsmanager", region_name=AWS_REGION)
        secrets = []
        paginator = sm.get_paginator("list_secrets")
        for page in paginator.paginate(MaxResults=50):
            for secret in page.get("SecretList", []):
                secrets.append({
                    "name": secret["Name"],
                    "arn": secret["ARN"],
                    "description": secret.get("Description", ""),
                    "last_changed": secret.get("LastChangedDate", "").isoformat() if secret.get("LastChangedDate") else None,
                })
        return {"secrets": secrets}
    except Exception as e:
        logger.warning(f"Failed to list secrets: {e}")
        return {"secrets": [], "error": str(e)}


@router.get("/secrets/keys")
async def list_secret_keys(secret_id: str = "", request: Request = None):
    """Fetch keys from a JSON secret (returns key names only, not values)."""
    if not secret_id:
        return {"keys": [], "error": "secret_id query param required"}
    try:
        sm = boto3.client("secretsmanager", region_name=AWS_REGION)
        resp = sm.get_secret_value(SecretId=secret_id)
        secret_str = resp.get("SecretString", "")
        try:
            data = json.loads(secret_str)
            if isinstance(data, dict):
                return {"keys": list(data.keys()), "type": "json"}
            else:
                return {"keys": [], "type": "plaintext"}
        except (json.JSONDecodeError, TypeError):
            return {"keys": [], "type": "plaintext"}
    except Exception as e:
        logger.warning(f"Failed to get secret keys: {e}")
        return {"keys": [], "error": str(e)}
