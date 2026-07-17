"""
MicroVM Auth Token Proxy

A lightweight proxy that:
1. Accepts requests from the browser (no auth needed on this side)
2. Fetches/caches a JWE auth token for the target MicroVM
3. Forwards the request to the MicroVM with the auth token injected

This keeps AWS credentials server-side (never exposed to the browser).

Usage:
    python3 -m uvicorn proxy.server:app --port 8081

The browser sends:
    POST http://localhost:8081/proxy/execute
    Headers: X-MicroVM-Id: mvm-xxxxx
             X-MicroVM-Endpoint: abc123.lambda-microvm.us-west-2.on.aws
    Body: {"code": "print(42)"}

The proxy:
    1. Calls create-microvm-auth-token (cached for 25 min)
    2. Forwards to https://{endpoint}/execute with X-aws-proxy-auth header
    3. Returns the MicroVM's response to the browser
"""

import os
import time
import asyncio
import json
import logging
import httpx
import boto3
from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="MicroVM Token Proxy")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Configuration ---
AWS_REGION = os.environ.get("AWS_REGION", "us-west-2")
IMAGE_ARN = os.environ.get("MICROVM_IMAGE_ARN", "")
EXEC_ROLE_ARN = os.environ.get("MICROVM_EXEC_ROLE_ARN", "")
POLL_INTERVAL_MS = int(os.environ.get("POLL_INTERVAL_MS", "10000"))
INGRESS_CONNECTOR = os.environ.get("MICROVM_INGRESS_CONNECTOR",
    f"arn:aws:lambda:{AWS_REGION}:aws:network-connector:aws-network-connector:ALL_INGRESS")
EGRESS_CONNECTOR = os.environ.get("MICROVM_EGRESS_CONNECTOR",
    f"arn:aws:lambda:{AWS_REGION}:aws:network-connector:aws-network-connector:INTERNET_EGRESS")

# Token cache: microvm_id -> {"token": str, "expires_at": float}
_token_cache: dict[str, dict] = {}

# Cached artifacts bucket name (discovered once, reused)
_artifacts_bucket: str | None = None


def _get_artifacts_bucket() -> str | None:
    """Find the microvm-sandbox-artifacts bucket (cached after first call)."""
    global _artifacts_bucket
    if _artifacts_bucket:
        return _artifacts_bucket
    try:
        s3 = boto3.client("s3", region_name=AWS_REGION)
        resp = s3.list_buckets()
        for b in resp.get("Buckets", []):
            if b["Name"].startswith("microvm-sandbox-artifacts-"):
                _artifacts_bucket = b["Name"]
                return _artifacts_bucket
    except Exception:
        pass
    return None

# Track active MicroVMs launched by this proxy
_active_microvms: dict[str, dict] = {}  # id -> {"endpoint": str, "launched_at": float}

# Cost tracker instance (persists across page refreshes, resets on proxy restart)
from proxy.cost_tracker import CostTracker
from proxy.ai_utils import build_ai_system_prompt, extract_code
_cost_tracker = CostTracker()

# AWS client (uses default credentials from environment/profile)
# IMPORTANT: Requires boto3 >= 1.43.40 for lambda-microvms service client
_lambda_client = None


def get_lambda_client():
    global _lambda_client
    if _lambda_client is None:
        _lambda_client = boto3.client("lambda-microvms", region_name=AWS_REGION)
    return _lambda_client


def get_auth_token(microvm_id: str) -> str:
    """Get a cached or fresh auth token for a MicroVM."""
    cached = _token_cache.get(microvm_id)
    if cached and time.time() < cached["expires_at"]:
        return cached["token"]

    logger.info(f"Fetching new auth token for {microvm_id}")
    client = get_lambda_client()
    response = client.create_microvm_auth_token(
        microvmIdentifier=microvm_id,
        expirationInMinutes=30,
        allowedPorts=[{"allPorts": {}}],
    )

    token = response["authToken"]["X-aws-proxy-auth"]
    _token_cache[microvm_id] = {
        "token": token,
        "expires_at": time.time() + (25 * 60),  # Cache for 25 min (token lasts 30)
    }
    return token


@app.api_route("/proxy/{path:path}", methods=["GET", "POST", "PUT", "DELETE"])
async def proxy_request(path: str, request: Request):
    """
    Proxy a request to the MicroVM with auth token injected.

    Required headers from browser:
      X-MicroVM-Id: the MicroVM identifier
      X-MicroVM-Endpoint: the MicroVM's HTTPS endpoint domain
    """
    microvm_id = request.headers.get("X-MicroVM-Id")
    microvm_endpoint = request.headers.get("X-MicroVM-Endpoint")

    if not microvm_id or not microvm_endpoint:
        return Response(
            content='{"error": "X-MicroVM-Id and X-MicroVM-Endpoint headers required"}',
            status_code=400,
            media_type="application/json",
        )

    # Get auth token
    try:
        token = get_auth_token(microvm_id)
    except Exception as e:
        logger.error(f"Failed to get auth token: {e}")
        return Response(
            content=f'{{"error": "Token generation failed: {str(e)}"}}',
            status_code=502,
            media_type="application/json",
        )

    # Forward request to MicroVM
    target_url = f"https://{microvm_endpoint}/{path}"
    body = await request.body()

    headers = {
        "X-aws-proxy-auth": token,
        "Content-Type": request.headers.get("Content-Type", "application/json"),
    }

    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            response = await client.request(
                method=request.method,
                url=target_url,
                headers=headers,
                content=body,
            )

        return Response(
            content=response.content,
            status_code=response.status_code,
            media_type=response.headers.get("content-type", "application/json"),
        )
    except Exception as e:
        logger.error(f"Proxy request failed: {e}")
        return Response(
            content=f'{{"error": "Proxy request failed: {str(e)}"}}',
            status_code=502,
            media_type="application/json",
        )


@app.post("/launch")
async def launch_microvm(request: Request):
    """
    Launch a new MicroVM sandbox instance.

    Called by the UI when a new notebook tab is created.
    Returns the MicroVM ID and endpoint for the UI to connect.
    """
    body = await request.json() if await request.body() else {}
    notebook_name = body.get("name", f"notebook-{int(time.time())}")
    memory_mib = body.get("memoryMiB", 4096)
    idle_timeout_sec = body.get("idleTimeoutSeconds", 1800)       # Default: 30 min
    max_duration_sec = body.get("maxDurationSeconds", 28800)      # Default: 8 hours
    checkpoint_enabled = body.get("checkpointEnabled", False)     # Enable S3 checkpoint on terminate
    restore_from = body.get("restoreFromSession")                 # Session ID to restore from
    session_id = body.get("sessionId", f"{notebook_name}-{int(time.time())}")  # Client-provided or generated

    # Select the image ARN based on requested memory size
    image_arn = f"{IMAGE_ARN}-{memory_mib}" if IMAGE_ARN else ""

    if not image_arn:
        return Response(
            content='{"error": "MICROVM_IMAGE_ARN not configured. Set it in environment or run aws_microvm_run.sh"}',
            status_code=500,
            media_type="application/json",
        )

    logger.info(f"Launching MicroVM for: {notebook_name} (memory: {memory_mib} MiB, image: {image_arn})")

    try:
        client = get_lambda_client()

        params = {
            "imageIdentifier": image_arn,
            "ingressNetworkConnectors": [INGRESS_CONNECTOR],
            "egressNetworkConnectors": [EGRESS_CONNECTOR],
            "idlePolicy": {
                "autoResumeEnabled": True,
                "maxIdleDurationSeconds": idle_timeout_sec,
                "suspendedDurationSeconds": max_duration_sec,
            },
            "maximumDurationInSeconds": max_duration_sec,
            "runHookPayload": json.dumps({
                "notebook_name": notebook_name,
                "session_id": session_id,
                "checkpoint_enabled": checkpoint_enabled,
                "restore_from": restore_from,
            }),
        }

        if EXEC_ROLE_ARN:
            params["executionRoleArn"] = EXEC_ROLE_ARN

        response = client.run_microvm(**params)

        microvm_id = response["microvmId"]
        endpoint = response["endpoint"]

        _active_microvms[microvm_id] = {
            "endpoint": endpoint,
            "name": notebook_name,
            "launched_at": time.time(),
            "memory_mib": memory_mib,
        }

        # Start cost tracking from launch
        _cost_tracker.record(microvm_id, "RUNNING", memory_mib=memory_mib)

        logger.info(f"MicroVM launched: {microvm_id} at {endpoint}")

        # Poll until running (max 60s)
        for _ in range(12):
            state_resp = client.get_microvm(microvmIdentifier=microvm_id)
            state = state_resp.get("state", "PENDING")
            if state == "RUNNING":
                break
            await asyncio.sleep(5)

        return {
            "microvmId": microvm_id,
            "endpoint": endpoint,
            "name": notebook_name,
            "sessionId": session_id,
            "status": "running",
        }

    except Exception as e:
        logger.error(f"Failed to launch MicroVM: {e}")
        return Response(
            content=f'{{"error": "Launch failed: {str(e)}"}}',
            status_code=502,
            media_type="application/json",
        )


@app.post("/terminate/{microvm_id}")
async def terminate_microvm(microvm_id: str):
    """Terminate a MicroVM instance."""
    try:
        client = get_lambda_client()
        client.terminate_microvm(microvmIdentifier=microvm_id)
        _active_microvms.pop(microvm_id, None)
        _token_cache.pop(microvm_id, None)
        logger.info(f"MicroVM terminated: {microvm_id}")
        return {"status": "terminated", "microvmId": microvm_id}
    except Exception as e:
        logger.error(f"Failed to terminate: {e}")
        return Response(
            content=f'{{"error": "Terminate failed: {str(e)}"}}',
            status_code=502,
            media_type="application/json",
        )


@app.get("/instances")
async def list_instances():
    """List all MicroVMs in the account (running + suspended), with live state from AWS."""
    try:
        client = get_lambda_client()
        response = client.list_microvms()
        items = response.get("items", [])

        instances = {}
        for item in items:
            microvm_id = item.get("microvmId", "")
            state = item.get("state", "UNKNOWN")

            # Skip terminated ones
            if state == "TERMINATED":
                continue

            # Check if we have local info (name, endpoint) from launching
            local_info = _active_microvms.get(microvm_id, {})
            endpoint = local_info.get("endpoint", "")

            # Fetch full detail from AWS if needed (endpoint or memory)
            detail = None
            if state in ("RUNNING", "SUSPENDED"):
                try:
                    detail = client.get_microvm(microvmIdentifier=microvm_id)
                    if not endpoint:
                        endpoint = detail.get("endpoint", "")
                except Exception:
                    pass

            # Determine memory from local cache or from imageArn
            memory_mib = local_info.get("memory_mib")
            if not memory_mib and detail:
                image_arn = detail.get("imageArn", "")
                if image_arn:
                    # Parse trailing number from image name (e.g. agent-sandbox-4096)
                    image_name = image_arn.split(":")[-1]
                    parts = image_name.rsplit("-", 1)
                    if len(parts) == 2 and parts[1].isdigit():
                        memory_mib = int(parts[1])
            if not memory_mib:
                memory_mib = 4096  # fallback

            instances[microvm_id] = {
                "endpoint": endpoint,
                "name": local_info.get("name", ""),
                "state": state,
                "launched_at": local_info.get("launched_at"),
                "memory_mib": memory_mib,
                "cost": _cost_tracker.get_cost(microvm_id),
            }

            # Track state transitions for cost
            _cost_tracker.record(microvm_id, state, memory_mib=memory_mib)

        return {"instances": instances, "total_cost": _cost_tracker.get_total_cost()}
    except Exception as e:
        logger.error(f"Failed to list instances: {e}")
        return {"instances": _active_microvms, "total_cost": _cost_tracker.get_total_cost()}


@app.post("/resume/{microvm_id}")
async def resume_microvm(microvm_id: str):
    """Resume a suspended MicroVM."""
    try:
        client = get_lambda_client()
        client.resume_microvm(microvmIdentifier=microvm_id)
        logger.info(f"MicroVM resume requested: {microvm_id}")

        # Poll until running (max 30s)
        for _ in range(6):
            await asyncio.sleep(5)
            state_resp = client.get_microvm(microvmIdentifier=microvm_id)
            state = state_resp.get("state", "PENDING")
            if state == "RUNNING":
                return {"status": "running", "microvmId": microvm_id}

        return {"status": "resuming", "microvmId": microvm_id}
    except Exception as e:
        logger.error(f"Failed to resume: {e}")
        return Response(
            content=f'{{"error": "Resume failed: {str(e)}"}}',
            status_code=502,
            media_type="application/json",
        )


@app.get("/health")
async def health():
    return {
        "status": "proxy running",
        "region": AWS_REGION,
        "image_arn": IMAGE_ARN or "(not configured)",
        "cached_tokens": len(_token_cache),
        "active_instances": len(_active_microvms),
        "poll_interval_ms": POLL_INTERVAL_MS,
    }


@app.get("/image-tiers")
async def list_image_tiers():
    """
    Discover available MicroVM image size tiers by listing images matching
    the configured image name pattern. Returns memory/vCPU options for the UI.
    """
    if not IMAGE_ARN:
        return {"tiers": []}

    try:
        client = get_lambda_client()
        # Image ARN base name (e.g. "agent-sandbox")
        image_base = IMAGE_ARN.split(":")[-1]  # e.g. "agent-sandbox"

        # List all images and filter by our naming pattern
        response = client.list_microvm_images()
        tiers = []
        for img in response.get("items", []):
            name = img.get("name", "")
            state = img.get("state", "")
            # Match pattern: {image_base}-{memoryMiB}
            if name.startswith(f"{image_base}-") and state in ("CREATED", "UPDATED"):
                suffix = name.replace(f"{image_base}-", "")
                if suffix.isdigit():
                    mem = int(suffix)
                    vcpu = mem / 2048
                    tiers.append({
                        "memory_mib": mem,
                        "memory_gb": mem / 1024,
                        "vcpu": vcpu,
                        "label": f"{mem / 1024:.1f} GB · {vcpu} vCPU",
                        "image_name": name,
                    })

        # Sort by memory size
        tiers.sort(key=lambda t: t["memory_mib"])
        return {"tiers": tiers}
    except Exception as e:
        logger.warning(f"Failed to list image tiers: {e}")
        # Fallback: return standard tiers based on the IMAGE_ARN pattern
        return {"tiers": []}


@app.get("/packages")
async def list_packages():
    """
    List installed packages on the proxy machine (fallback for local dev mode).
    In MicroVM mode, the frontend fetches packages via /execute on the MicroVM directly.
    """
    import subprocess

    try:
        result = subprocess.run(
            ["pip3", "list", "--format=json"],
            capture_output=True, text=True, timeout=15
        )
        if result.returncode != 0:
            result = subprocess.run(
                ["pip", "list", "--format=json"],
                capture_output=True, text=True, timeout=15
            )
        if result.returncode == 0:
            packages = json.loads(result.stdout)
        else:
            packages = []
    except Exception:
        packages = []

    pkg_list = [{"name": p.get("name", ""), "version": p.get("version", "")} for p in packages]
    pkg_list.sort(key=lambda p: p["name"].lower())

    return {"packages": pkg_list, "count": len(pkg_list)}


# ============================================================
# SESSION MANAGEMENT (checkpoint/restore)
# ============================================================

@app.get("/sessions")
async def list_sessions():
    """List available session checkpoints from S3."""
    try:
        s3 = boto3.client("s3", region_name=AWS_REGION)
        bucket_name = _get_artifacts_bucket()

        if not bucket_name:
            return {"sessions": []}

        # List session checkpoints
        sessions = []
        paginator = s3.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=bucket_name, Prefix="sessions/", Delimiter="/"):
            for prefix_obj in page.get("CommonPrefixes", []):
                session_prefix = prefix_obj["Prefix"]  # e.g. "sessions/abc123/"
                session_id = session_prefix.replace("sessions/", "").rstrip("/")

                # Try to load metadata
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
                })

        # Sort by checkpoint time (most recent first)
        sessions.sort(key=lambda s: s.get("checkpointed_at") or "", reverse=True)
        return {"sessions": sessions}

    except Exception as e:
        logger.error(f"Failed to list sessions: {e}")
        return {"sessions": []}


@app.delete("/sessions/{session_id}")
async def delete_session(session_id: str):
    """Delete a session checkpoint from S3."""
    try:
        s3 = boto3.client("s3", region_name=AWS_REGION)

        bucket_name = _get_artifacts_bucket()
        if not bucket_name:
            return {"error": "Bucket not found"}

        # Delete all objects under sessions/{session_id}/
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


# ============================================================
# DATA SOURCES (S3 + DynamoDB + Athena discovery)
# ============================================================

ATHENA_DB = os.environ.get("ATHENA_DB", "microvm_demo_db")
ATHENA_WORKGROUP = os.environ.get("ATHENA_WORKGROUP", "microvm-demo")


@app.get("/datasources")
async def list_datasources():
    """
    List external data sources accessible from the MicroVM:
    - S3 objects in the artifacts bucket (samples/ prefix)
    - DynamoDB tables matching the demo pattern
    - Athena tables in the microvm_demo_db database
    """
    s3_files = []
    dynamodb_tables = []
    athena_tables = []
    bucket_name = None

    try:
        s3 = boto3.client("s3", region_name=AWS_REGION)
        bucket_name = _get_artifacts_bucket()

        if bucket_name:
            # List objects in samples/ prefix (only flat files, skip per-table subfolders)
            paginator = s3.get_paginator("list_objects_v2")
            for page in paginator.paginate(Bucket=bucket_name, Prefix="samples/", MaxKeys=50):
                for obj in page.get("Contents", []):
                    key = obj["Key"]
                    if key.endswith("/"):
                        continue
                    # Only show top-level samples (e.g. samples/sales_data.csv)
                    # Skip files inside per-table subfolders (e.g. samples/sales_data/sales_data.csv)
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
                # Get item count
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


# ============================================================
# AI CODE GENERATION (runs locally on the proxy, calls Bedrock)
# ============================================================

AI_MODEL_ID = os.environ.get("BEDROCK_MODEL_ID", "us.anthropic.claude-sonnet-4-6")
AI_REGION = os.environ.get("BEDROCK_REGION", AWS_REGION)

_bedrock_client = None


def get_bedrock_client():
    """
    Get a Bedrock Runtime client with retry and timeout configuration.
    Uses boto3's built-in exponential backoff with jitter for transient errors.
    """
    global _bedrock_client
    if _bedrock_client is None:
        from botocore.config import Config
        bedrock_config = Config(
            retries={
                'max_attempts': 5,
                'mode': 'standard',  # exponential backoff with jitter for 429/5xx
            },
            read_timeout=120,       # 2 min read timeout for large model responses
            connect_timeout=10,     # 10s connection timeout
        )
        _bedrock_client = boto3.client(
            "bedrock-runtime",
            region_name=AI_REGION,
            config=bedrock_config,
        )
    return _bedrock_client


@app.get("/ai/config")
async def ai_config():
    """Return AI configuration and availability (checks for valid AWS credentials)."""
    ai_available = False
    try:
        session = boto3.Session(region_name=AI_REGION)
        credentials = session.get_credentials()
        if credentials and credentials.get_frozen_credentials().access_key:
            ai_available = True
    except Exception:
        pass

    return {
        "model_id": AI_MODEL_ID,
        "region": AI_REGION,
        "ai_available": ai_available,
    }


@app.post("/ai/generate")
async def ai_generate_code(request: Request):
    """
    Generate Python code from a natural language prompt using Amazon Bedrock.
    Receives full notebook context for accurate code generation.
    """
    body = await request.json()

    prompt = body.get("prompt", "").strip()
    if not prompt:
        return Response(
            status_code=400,
            content='{"error": "No prompt provided"}',
            media_type="application/json",
        )

    notebook_context = body.get("notebook_context", [])
    current_cell_code = body.get("current_cell_code", "")
    cell_index = body.get("cell_index", 0)
    variables = body.get("variables", [])

    logger.info(f"--- /ai/generate request ---")
    logger.info(f"  prompt: {prompt}")
    logger.info(f"  cell_index: {cell_index}")
    logger.info(f"  current_cell_code: {current_cell_code[:80]}...")
    logger.info(f"  notebook_context cells: {len(notebook_context)}")
    for i, ctx in enumerate(notebook_context):
        code_preview = (ctx.get('code', '') or '')[:80].replace('\n', '\\n')
        logger.info(f"    [{i}] code: {code_preview}...")
    logger.info(f"  variables: {variables}")
    logger.info(f"---")

    system_prompt = build_ai_system_prompt(notebook_context, cell_index, variables, current_cell_code)

    try:
        client = get_bedrock_client()

        response = client.converse(
            modelId=AI_MODEL_ID,
            system=[{"text": system_prompt}],
            messages=[
                {
                    "role": "user",
                    "content": [{"text": prompt}],
                }
            ],
            inferenceConfig={
                "maxTokens": 2048,
                "temperature": 0.2,
            },
        )

        output_message = response["output"]["message"]
        generated_text = ""
        for block in output_message["content"]:
            if "text" in block:
                generated_text += block["text"]

        code = extract_code(generated_text)

        logger.info(f"AI generated code (model={AI_MODEL_ID}, prompt_len={len(prompt)}, code_len={len(code)})")

        return {
            "success": True,
            "code": code,
            "model_id": AI_MODEL_ID,
        }

    except Exception as e:
        logger.error(f"AI generation failed: {e}")
        return Response(
            status_code=500,
            content=f'{{"error": "AI generation failed: {str(e)}"}}',
            media_type="application/json",
        )


