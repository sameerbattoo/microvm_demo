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
        _lambda_client = boto3.client("lambda-microvms", region_name="us-west-2")
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
                "maxIdleDurationSeconds": 1800,
                "suspendedDurationSeconds": 28800,
            },
            "maximumDurationInSeconds": 28800,
            "runHookPayload": notebook_name,
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
        }

        logger.info(f"MicroVM launched: {microvm_id} at {endpoint}")

        # Poll until running (max 60s)
        for _ in range(12):
            state_resp = client.get_microvm(microvmIdentifier=microvm_id)
            state = state_resp.get("state", "PENDING")
            if state == "RUNNING":
                break
            time.sleep(5)

        return {
            "microvmId": microvm_id,
            "endpoint": endpoint,
            "name": notebook_name,
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

            # If no endpoint cached, fetch it from get_microvm
            if not endpoint and state in ("RUNNING", "SUSPENDED"):
                try:
                    detail = client.get_microvm(microvmIdentifier=microvm_id)
                    endpoint = detail.get("endpoint", "")
                except Exception:
                    pass

            instances[microvm_id] = {
                "endpoint": endpoint,
                "name": local_info.get("name", ""),
                "state": state,
                "launched_at": local_info.get("launched_at"),
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
            time.sleep(5)
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
