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
import logging

import boto3
from fastapi import APIRouter, Request, Response

from proxy.platform.microvm_manager import AWS_REGION

logger = logging.getLogger(__name__)

ATHENA_DB = os.environ.get("ATHENA_DB", "microvm_demo_db")
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
    """List external data sources accessible from the MicroVM."""
    vm_manager = request.app.state.vm_manager
    s3_files = []
    dynamodb_tables = []
    athena_tables = []
    bucket_name = None

    try:
        s3 = boto3.client("s3", region_name=AWS_REGION)
        bucket_name = vm_manager.get_artifacts_bucket()

        if bucket_name:
            paginator = s3.get_paginator("list_objects_v2")
            for prefix in ["samples/", "user-data/"]:
                for page in paginator.paginate(Bucket=bucket_name, Prefix=prefix, MaxKeys=50):
                    for obj in page.get("Contents", []):
                        key = obj["Key"]
                        if key.endswith("/"):
                            continue
                        # Skip Athena per-table subfolders (e.g., samples/sales_data/sales_data.csv)
                        # Only show files directly under the prefix (one level deep)
                        relative = key[len(prefix):]
                        if '/' in relative:
                            continue
                        size = obj["Size"]
                        if size < 1024:
                            size_str = f"{size} B"
                        elif size < 1024 * 1024:
                            size_str = f"{size / 1024:.1f} KB"
                        else:
                            size_str = f"{size / (1024 * 1024):.1f} MB"
                        s3_files.append({
                            "key": key,
                            "bucket": bucket_name,
                            "size": size_str,
                            "size_bytes": size,
                            "uri": f"s3://{bucket_name}/{key}",
                        })
    except Exception as e:
        logger.warning(f"Failed to list S3 sources: {e}")

    try:
        ddb = boto3.client("dynamodb", region_name=AWS_REGION)
        resp = ddb.list_tables()
        for table_name in resp.get("TableNames", []):
            if "microvm" in table_name or "demo" in table_name or "ecommerce" in table_name:
                desc = ddb.describe_table(TableName=table_name)
                item_count = desc["Table"].get("ItemCount", 0)
                dynamodb_tables.append({
                    "name": table_name,
                    "item_count": item_count,
                    "region": AWS_REGION,
                })
    except Exception as e:
        logger.warning(f"Failed to list DynamoDB sources: {e}")

    try:
        glue = boto3.client("glue", region_name=AWS_REGION)
        resp = glue.get_tables(DatabaseName=ATHENA_DB)
        for table in resp.get("TableList", []):
            columns = table.get("StorageDescriptor", {}).get("Columns", [])
            athena_tables.append({
                "name": table["Name"],
                "database": ATHENA_DB,
                "columns": [{"name": c["Name"], "type": c["Type"]} for c in columns],
                "column_count": len(columns),
                "region": AWS_REGION,
            })
    except Exception as e:
        logger.warning(f"Failed to list Athena sources: {e}")

    return {
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
    from proxy.platform.datasources import (
        AthenaSchemaProvider,
        DynamoDBSchemaProvider,
        S3SchemaProvider,
        LocalFileSchemaProvider,
    )
    from dataclasses import asdict
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
                            return data
            except Exception:
                pass  # Fall through to direct provider

    # --- Fallback: direct provider (original approach) ---

    # For local files, we need to execute code on the VM
    if source_type == "local":
        if not session_id:
            return Response(
                content='{"error": "session_id required for local file schema"}',
                status_code=400,
                media_type="application/json",
            )
        vm_manager = request.app.state.vm_manager
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

        provider = LocalFileSchemaProvider(execute_fn=execute_on_vm)
        schema = await provider.get_schema(source_id, session_id=session_id)
    else:
        providers = {
            "athena": AthenaSchemaProvider(),
            "dynamodb": DynamoDBSchemaProvider(),
            "s3": S3SchemaProvider(),
        }

        provider = providers.get(source_type)
        if not provider:
            return Response(
                content=f'{{"error": "Unknown source type: {source_type}"}}',
                status_code=400,
                media_type="application/json",
            )

        schema = await provider.get_schema(source_id)
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
        "columns": [asdict(col) for col in schema.columns],
        "row_count": schema.row_count,
        "size": schema.size,
    }


@router.get("/datasources/catalog")
async def get_full_catalog(request: Request):
    """
    Get the full data catalog from the VM (all sources with discovered schemas).
    Proxies GET /data-catalog from the active VM for the given session.
    Returns the progressive catalog — entries may still be "pending" if discovery is in progress.
    """
    import httpx

    session_id = request.headers.get("X-Session-Id", "")
    if not session_id:
        return Response(content='{"error": "X-Session-Id header required"}', status_code=400, media_type="application/json")

    vm_manager = request.app.state.vm_manager
    session_vm = vm_manager.get_session_vm(session_id)
    if not session_vm:
        return Response(content='{"error": "No active VM for this session"}', status_code=404, media_type="application/json")

    try:
        token = vm_manager.get_auth_token(session_vm["vm_id"])
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                f"https://{session_vm['endpoint']}/data-catalog",
                headers={"X-aws-proxy-auth": token},
            )
            if resp.status_code == 200:
                return resp.json()
            return Response(content=resp.text, status_code=resp.status_code, media_type="application/json")
    except Exception as e:
        return Response(content=f'{{"error": "Failed to reach VM: {str(e)}"}}', status_code=502, media_type="application/json")


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
    from proxy.platform.datasources import (
        AthenaSchemaProvider,
        DynamoDBSchemaProvider,
        S3SchemaProvider,
        LocalFileSchemaProvider,
    )

    providers = {
        "athena": AthenaSchemaProvider(),
        "dynamodb": DynamoDBSchemaProvider(),
        "s3": S3SchemaProvider(),
        "local": LocalFileSchemaProvider(),
    }

    provider = providers.get(source_type)
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
