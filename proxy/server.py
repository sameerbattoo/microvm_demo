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
INGRESS_CONNECTOR = os.environ.get("MICROVM_INGRESS_CONNECTOR",
    f"arn:aws:lambda:{AWS_REGION}:aws:network-connector:aws-network-connector:ALL_INGRESS")
EGRESS_CONNECTOR = os.environ.get("MICROVM_EGRESS_CONNECTOR",
    f"arn:aws:lambda:{AWS_REGION}:aws:network-connector:aws-network-connector:INTERNET_EGRESS")

# Token cache: microvm_id -> {"token": str, "expires_at": float}
_token_cache: dict[str, dict] = {}

# Track active MicroVMs launched by this proxy
_active_microvms: dict[str, dict] = {}  # id -> {"endpoint": str, "launched_at": float}

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
            }

        return {"instances": instances}
    except Exception as e:
        logger.error(f"Failed to list instances: {e}")
        return {"instances": _active_microvms}


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
    }


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

        # Find artifacts bucket
        bucket_name = None
        resp = s3.list_buckets()
        for b in resp.get("Buckets", []):
            if b["Name"].startswith("microvm-sandbox-artifacts-"):
                bucket_name = b["Name"]
                break

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

        bucket_name = None
        resp = s3.list_buckets()
        for b in resp.get("Buckets", []):
            if b["Name"].startswith("microvm-sandbox-artifacts-"):
                bucket_name = b["Name"]
                break

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
# DATA SOURCES (S3 + DynamoDB discovery)
# ============================================================

@app.get("/datasources")
async def list_datasources():
    """
    List external data sources accessible from the MicroVM:
    - S3 objects in the artifacts bucket (samples/ prefix)
    - DynamoDB tables matching the demo pattern
    """
    s3_files = []
    dynamodb_tables = []

    try:
        s3 = boto3.client("s3", region_name=AWS_REGION)
        # Find the artifacts bucket
        bucket_name = None
        resp = s3.list_buckets()
        for b in resp.get("Buckets", []):
            if b["Name"].startswith("microvm-sandbox-artifacts-"):
                bucket_name = b["Name"]
                break

        if bucket_name:
            # List objects in samples/ prefix
            paginator = s3.get_paginator("list_objects_v2")
            for page in paginator.paginate(Bucket=bucket_name, Prefix="samples/", MaxKeys=50):
                for obj in page.get("Contents", []):
                    key = obj["Key"]
                    if key.endswith("/"):
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

    return {
        "s3": s3_files,
        "dynamodb": dynamodb_tables,
    }


# ============================================================
# AI CODE GENERATION (runs locally on the proxy, calls Bedrock)
# ============================================================

AI_MODEL_ID = os.environ.get("BEDROCK_MODEL_ID", "us.anthropic.claude-sonnet-4-6")
AI_REGION = os.environ.get("BEDROCK_REGION", AWS_REGION)

_bedrock_client = None


def get_bedrock_client():
    global _bedrock_client
    if _bedrock_client is None:
        _bedrock_client = boto3.client("bedrock-runtime", region_name=AI_REGION)
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

    system_prompt = _build_ai_system_prompt(notebook_context, cell_index, variables, current_cell_code)

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

        code = _extract_code(generated_text)

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


def _build_ai_system_prompt(notebook_context, cell_index, variables, current_cell_code=""):
    lines = []
    lines.append("You are a Python code generation assistant embedded in a data science notebook.")
    lines.append("Generate ONLY executable Python code. No explanations, no markdown fences, no comments unless they clarify complex logic.")
    lines.append("The code will be inserted directly into a notebook cell and executed.")
    lines.append("")
    lines.append("RULES:")
    lines.append("- Output raw Python code only (no ```python fences)")
    lines.append("- Use variables and imports from prior cells (they persist)")
    lines.append("- For DataFrames, end with the expression (e.g. df.head()) so it renders as a table")
    lines.append("- For plots, use matplotlib (plt.plot/plt.show) - they render inline")
    lines.append("- For plots, ALWAYS use a dark style: plt.style.use('dark_background') at the top, or set facecolor='#1a1a2e' on the figure and use color='white' for titles, labels, and tick text")
    lines.append("- Keep code concise and idiomatic")
    lines.append("")

    if current_cell_code.strip():
        lines.append("IMPORTANT: This cell already contains code. The user wants to MODIFY the existing code based on their request.")
        lines.append("Return the complete updated code for this cell (not just the changes).")
        lines.append("")
        lines.append("CURRENT CELL CODE:")
        lines.append("```")
        lines.append(current_cell_code.strip())
        lines.append("```")
        lines.append("")

    if variables:
        lines.append(f"AVAILABLE VARIABLES: {', '.join(variables)}")
        lines.append("")

    if notebook_context:
        lines.append("NOTEBOOK CELLS ABOVE (executed in order):")
        lines.append("---")
        for cell in notebook_context:
            idx = cell.get("index", "?")
            code = cell.get("code", "").strip()
            output = cell.get("output", "").strip()
            html = cell.get("html", "").strip()
            if code:
                lines.append(f"Cell [{idx + 1}]:")
                lines.append(code)
                if output:
                    lines.append(f"# Output: {output[:300]}")
                if html:
                    # Extract a text representation from HTML table for context
                    table_text = _extract_table_text(html)
                    if table_text:
                        lines.append(f"# DataFrame output (columns and sample rows):")
                        lines.append(f"# {table_text}")
                lines.append("")
        lines.append("---")
        lines.append("")

    lines.append(f"Generate code for Cell [{cell_index + 1}] based on the user's request.")
    return "\n".join(lines)


def _extract_code(text):
    text = text.strip()
    if "```python" in text:
        parts = text.split("```python")
        if len(parts) > 1:
            return parts[1].split("```")[0].strip()
    if text.startswith("```") and text.endswith("```"):
        lines = text.split("\n")
        return "\n".join(lines[1:-1]).strip()
    return text


def _extract_table_text(html):
    """Extract column names and first few rows from an HTML table for AI context."""
    import re
    try:
        # Extract header cells
        headers = re.findall(r'<th[^>]*>(.*?)</th>', html, re.DOTALL)
        if not headers:
            return ""
        # Clean HTML tags from headers
        headers = [re.sub(r'<[^>]+>', '', h).strip() for h in headers]

        # Extract first few data rows
        rows = re.findall(r'<tr[^>]*>(.*?)</tr>', html, re.DOTALL)
        data_rows = []
        for row in rows[:4]:  # First 3-4 data rows
            cells = re.findall(r'<td[^>]*>(.*?)</td>', row, re.DOTALL)
            if cells:
                cells = [re.sub(r'<[^>]+>', '', c).strip() for c in cells]
                data_rows.append(cells)

        # Build text summary
        result = f"Columns: {headers}"
        if data_rows:
            result += f"\nFirst rows: {data_rows[:3]}"

        # Limit to 500 chars
        return result[:500]
    except Exception:
        return ""
