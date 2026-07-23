"""
Session checkpoint management and data source discovery routes.

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

from proxy.microvm_manager import AWS_REGION

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
            for page in paginator.paginate(Bucket=bucket_name, Prefix="samples/", MaxKeys=50):
                for obj in page.get("Contents", []):
                    key = obj["Key"]
                    if key.endswith("/"):
                        continue
                    parts = key.replace("samples/", "", 1).split("/")
                    if len(parts) > 1:
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
            if "microvm" in table_name or "demo" in table_name:
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
