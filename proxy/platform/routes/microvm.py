"""
MicroVM lifecycle routes — launch, terminate, suspend, resume, proxy, instances.

Part of: proxy.platform (Smart MicroVM Service layer)

Endpoints:
  POST      /launch                       - Launch a new MicroVM
  POST      /terminate                    - Terminate (X-Session-Id header)
  POST      /suspend                      - Suspend (X-Session-Id header)
  POST      /resume                       - Resume (X-Session-Id header)
  GET       /instances                    - List all active MicroVMs with state
  GET       /instances/metrics            - Get live metrics for a specific VM
  ANY       /proxy/{path}                 - Proxy requests to a MicroVM with auth
"""

import os
import time
import json
import asyncio
import logging

import boto3
import httpx
from fastapi import APIRouter, Request, Response

from proxy.storage import storage
from proxy.platform.microvm_manager import (
    AWS_REGION, IMAGE_ARN, EXEC_ROLE_ARN,
    INGRESS_CONNECTOR, SHELL_INGRESS_CONNECTOR, EGRESS_CONNECTOR,
)

ATHENA_DB = os.environ.get("ATHENA_DB", "microvm_demo_db")

logger = logging.getLogger(__name__)

router = APIRouter(tags=["microvm"])


@router.api_route("/proxy/{path:path}", methods=["GET", "POST", "PUT", "DELETE"])
async def proxy_request(path: str, request: Request):
    """
    Proxy requests to the MicroVM serving a session.

    The caller sends only `X-Session-Id` — the proxy resolves the current VM
    endpoint internally from the session registry. This is stable across
    VM rotations (eternal mode) and works identically in checkpoint mode.

    If the session is mid-rotation (quiesced), requests are queued and replayed
    on the new VM after the swap completes.
    """
    vm_manager = request.app.state.vm_manager
    session_id = request.headers.get("X-Session-Id")

    if not session_id:
        return Response(
            content='{"error": "X-Session-Id header required"}',
            status_code=400,
            media_type="application/json",
        )

    # --- Resolve session → VM from the session registry ---
    session_vm = vm_manager.get_session_vm(session_id)
    if not session_vm:
        return Response(
            content='{"error": "Session not found — VM may have been terminated"}',
            status_code=404,
            media_type="application/json",
        )

    microvm_id = session_vm["vm_id"]
    microvm_endpoint = session_vm["endpoint"]

    # --- Check if session is quiesced (rotation in progress) ---
    if vm_manager.session_rotator.is_quiesced(session_id):
        future = asyncio.get_event_loop().create_future()
        body = await request.body()
        request_data = {
            "method": request.method,
            "path": f"/{path}",
            "headers": {"Content-Type": request.headers.get("Content-Type", "application/json")},
            "body": body,
        }
        vm_manager.session_rotator.queue_request(session_id, request_data, future)
        try:
            response = await asyncio.wait_for(asyncio.wrap_future(future), timeout=30)
            return Response(
                content=response.content,
                status_code=response.status_code,
                media_type=response.headers.get("content-type", "application/json"),
            )
        except asyncio.TimeoutError:
            return Response(content='{"error": "Request timed out during VM rotation"}', status_code=503, media_type="application/json")

    # --- Get auth token and forward the request ---
    try:
        token = vm_manager.get_auth_token(microvm_id)
    except Exception as e:
        logger.error(f"Failed to get auth token: {e}")
        return Response(
            content=f'{{"error": "Token generation failed: {str(e)}"}}',
            status_code=502,
            media_type="application/json",
        )

    target_url = f"https://{microvm_endpoint}/{path}"
    body = await request.body()
    headers = {
        "X-aws-proxy-auth": token,
        "Content-Type": request.headers.get("Content-Type", "application/json"),
    }

    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            response = await client.request(
                method=request.method, url=target_url, headers=headers, content=body,
            )

            # Retry on 502 — VM may be auto-resuming from suspended state
            if response.status_code == 502:
                for retry in range(2):
                    wait = 2 + retry
                    logger.info(f"Got 502 from {microvm_id}, retry {retry + 1}/2 in {wait}s...")
                    await asyncio.sleep(wait)
                    response = await client.request(
                        method=request.method, url=target_url, headers=headers, content=body,
                    )
                    if response.status_code != 502:
                        break

            # Track health: consecutive failures
            if response.status_code >= 502:
                if microvm_id in vm_manager.active_microvms:
                    vm_manager.active_microvms[microvm_id]["_502_strikes"] = \
                        vm_manager.active_microvms[microvm_id].get("_502_strikes", 0) + 1
            else:
                if microvm_id in vm_manager.active_microvms:
                    vm_manager.active_microvms[microvm_id]["_502_strikes"] = 0

        if response.status_code < 500 and microvm_id in vm_manager.active_microvms:
            vm_manager.active_microvms[microvm_id]["last_active"] = time.time()

        return Response(
            content=response.content,
            status_code=response.status_code,
            media_type=response.headers.get("content-type", "application/json"),
        )
    except Exception as e:
        logger.error(f"Proxy request failed: {e}")
        if microvm_id in vm_manager.active_microvms:
            vm_manager.active_microvms[microvm_id]["_502_strikes"] = \
                vm_manager.active_microvms[microvm_id].get("_502_strikes", 0) + 1
        return Response(
            content=f'{{"error": "Proxy request failed: {str(e)}"}}',
            status_code=502,
            media_type="application/json",
        )


@router.post("/launch")
async def launch_microvm(request: Request):
    """Launch a new MicroVM sandbox instance."""
    vm_manager = request.app.state.vm_manager
    body = await request.json() if await request.body() else {}
    notebook_name = body.get("name", f"notebook-{int(time.time())}")
    memory_mib = body.get("memoryMiB", 4096)
    # Valid memory tiers from config (IMAGE_SIZES env var)
    valid_memories = [int(s) for s in os.environ.get("IMAGE_SIZES", "1024 2048 4096 8192").split()]
    if memory_mib not in valid_memories:
        memory_mib = min(valid_memories, key=lambda x: abs(x - memory_mib))
    idle_timeout_sec = body.get("idleTimeoutSeconds", 1800)
    # Max duration: use frontend value if provided, otherwise fall back to config
    config_max = int(os.environ.get("MAX_LIFETIME_SECONDS", "28800"))
    max_duration_sec = min(int(body.get("maxDurationSeconds", config_max)), 28800)  # Cap at AWS max (8h)
    # Checkpoint is always enabled — rotation logic depends on it
    checkpoint_enabled = True
    restore_from = body.get("restoreFromSession")
    session_id = body.get("sessionId", f"{notebook_name}-{int(time.time())}")
    # Secrets & env vars (passed to /run hook for injection into os.environ)
    secrets = body.get("secrets", [])  # [{name, arn, envVar}]
    env_vars = body.get("envVars", {})  # {KEY: value}

    image_arn = f"{IMAGE_ARN}-{memory_mib}" if IMAGE_ARN else ""
    if not image_arn:
        return Response(
            content='{"error": "MICROVM_IMAGE_ARN not configured"}',
            status_code=500,
            media_type="application/json",
        )

    persistence_mode = os.environ.get("SESSION_PERSISTENCE_MODE", "checkpoint")
    logger.info(f"Launching MicroVM for: {notebook_name} (memory: {memory_mib} MiB, image: {image_arn})")

    # Pre-fetch data source list to pass to VM for background schema discovery
    data_sources = {"s3": [], "dynamodb": [], "athena": []}
    try:
        s3_client = boto3.client("s3", region_name=AWS_REGION)
        bucket_name = vm_manager.get_artifacts_bucket()
        if bucket_name:
            data_sources["artifact_bucket"] = bucket_name
            paginator = s3_client.get_paginator("list_objects_v2")
            for prefix in ["samples/", "user-data/"]:
                for page in paginator.paginate(Bucket=bucket_name, Prefix=prefix, MaxKeys=50):
                    for obj in page.get("Contents", []):
                        key = obj["Key"]
                        if key.endswith("/") or '/' in key[len(prefix):]:
                            continue
                        data_sources["s3"].append({"key": key, "bucket": bucket_name, "uri": f"s3://{bucket_name}/{key}", "size_bytes": obj["Size"]})
        ddb_client = boto3.client("dynamodb", region_name=AWS_REGION)
        for t in ddb_client.list_tables().get("TableNames", []):
            if "microvm" in t or "demo" in t or "ecommerce" in t:
                data_sources["dynamodb"].append({"name": t, "region": AWS_REGION})
        glue_client = boto3.client("glue", region_name=AWS_REGION)
        for t in glue_client.get_tables(DatabaseName=ATHENA_DB).get("TableList", []):
            data_sources["athena"].append({"name": t["Name"], "database": ATHENA_DB, "region": AWS_REGION})
    except Exception as e:
        logger.warning(f"Failed to pre-fetch datasources for VM: {e}")

    try:
        client = vm_manager.get_lambda_client()
        params = {
            "imageIdentifier": image_arn,
            "ingressNetworkConnectors": [INGRESS_CONNECTOR, SHELL_INGRESS_CONNECTOR],
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
                "persistence_mode": persistence_mode,
                "restore_from": restore_from,
                "artifacts_bucket": vm_manager.get_artifacts_bucket(),
                "secrets": secrets,
                "env_vars": env_vars,
                "data_sources": data_sources,
            }),
        }
        if EXEC_ROLE_ARN:
            params["executionRoleArn"] = EXEC_ROLE_ARN

        response = client.run_microvm(**params)
        microvm_id = response["microvmId"]
        endpoint = response["endpoint"]

        vm_manager.active_microvms[microvm_id] = {
            "endpoint": endpoint,
            "name": notebook_name,
            "launched_at": time.time(),
            "memory_mib": memory_mib,
            "idle_timeout_sec": idle_timeout_sec,
            "max_duration_sec": max_duration_sec,
            "session_id": session_id,
            "_502_strikes": 0,
        }
        vm_manager.cost_tracker.record(microvm_id, "RUNNING", memory_mib=memory_mib)

        storage.vm_session_create(
            microvm_id=microvm_id,
            notebook_id=notebook_name,
            session_id=session_id,
            memory_mib=memory_mib,
            endpoint=endpoint,
            idle_timeout_sec=idle_timeout_sec,
            max_duration_sec=max_duration_sec,
            checkpoint_enabled=checkpoint_enabled,
        )

        logger.info(f"MicroVM launched: {microvm_id} at {endpoint}")

        # Register session → VM mapping (the single source of truth for routing)
        vm_manager.register_session(session_id, microvm_id, endpoint)

        # Mode-dependent lifecycle registration
        if persistence_mode == "eternal" and session_id:
            # Eternal mode: register with rotator for seamless VM swap
            vm_manager.session_rotator.register(
                session_id=session_id,
                vm_id=microvm_id,
                endpoint=endpoint,
                memory_mib=memory_mib,
                image_arn=image_arn,
                idle_timeout_sec=idle_timeout_sec,
                notebook_name=notebook_name,
                max_lifetime=max_duration_sec,
            )
            # Also schedule pre-terminate resume (safety net if rotator fails)
            vm_manager.schedule_pre_terminate(microvm_id, max_duration_sec, idle_timeout_sec)
        elif persistence_mode == "checkpoint" and session_id:
            # Checkpoint mode: rely on AWS /terminate hook to save state.
            # No pre-checkpoint timer — ensures the LATEST state is always saved.
            logger.info(f"Checkpoint mode: session {session_id} will save on terminate hook")

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


@router.post("/terminate")
async def terminate_session(request: Request):
    """Terminate the VM serving a session."""
    vm_manager = request.app.state.vm_manager
    session_id = request.headers.get("X-Session-Id")
    if not session_id:
        return Response(content='{"error": "X-Session-Id header required"}', status_code=400, media_type="application/json")

    session_vm = vm_manager.get_session_vm(session_id)
    if not session_vm:
        # Fallback: session registry lost (proxy restart). Find VM by session_id in active_microvms or DB.
        for vm_id, info in vm_manager.active_microvms.items():
            if info.get("session_id") == session_id:
                session_vm = {"vm_id": vm_id, "endpoint": info.get("endpoint")}
                break
    if not session_vm:
        # Last resort: check the database
        from proxy.storage import storage
        active_sessions = storage.vm_session_list_active()
        for s in active_sessions:
            if s.get("session_id") == session_id:
                vm_id = s["microvm_id"]
                endpoint = s.get("endpoint", "")
                session_vm = {"vm_id": vm_id, "endpoint": endpoint}
                break
    if not session_vm:
        return Response(content='{"error": "Session not found"}', status_code=404, media_type="application/json")

    microvm_id = session_vm["vm_id"]
    try:
        vm_manager.cancel_pre_terminate(microvm_id)
        vm_manager.session_rotator.unregister(session_id)
        vm_manager.unregister_session(session_id)

        client = vm_manager.get_lambda_client()
        client.terminate_microvm(microvmIdentifier=microvm_id)
        vm_manager.active_microvms.pop(microvm_id, None)
        vm_manager.token_cache.pop(microvm_id)
        logger.info(f"MicroVM terminated: {microvm_id} (session={session_id})")
        return {"status": "terminated", "microvmId": microvm_id, "sessionId": session_id}
    except Exception as e:
        logger.error(f"Failed to terminate: {e}")
        return Response(content=f'{{"error": "Terminate failed: {str(e)}"}}', status_code=502, media_type="application/json")


@router.post("/suspend")
async def suspend_session(request: Request):
    """Suspend the VM serving a session."""
    vm_manager = request.app.state.vm_manager
    session_id = request.headers.get("X-Session-Id")
    if not session_id:
        return Response(content='{"error": "X-Session-Id header required"}', status_code=400, media_type="application/json")

    session_vm = vm_manager.get_session_vm(session_id)
    if not session_vm:
        return Response(content='{"error": "Session not found"}', status_code=404, media_type="application/json")

    microvm_id = session_vm["vm_id"]
    try:
        client = vm_manager.get_lambda_client()
        client.suspend_microvm(microvmIdentifier=microvm_id)
        logger.info(f"MicroVM suspend requested: {microvm_id} (session={session_id})")
        return {"status": "suspended", "microvmId": microvm_id, "sessionId": session_id}
    except Exception as e:
        logger.error(f"Failed to suspend: {e}")
        return Response(content=f'{{"error": "Suspend failed: {str(e)}"}}', status_code=502, media_type="application/json")


@router.post("/resume")
async def resume_session(request: Request):
    """Resume the suspended VM serving a session."""
    vm_manager = request.app.state.vm_manager
    session_id = request.headers.get("X-Session-Id")
    if not session_id:
        return Response(content='{"error": "X-Session-Id header required"}', status_code=400, media_type="application/json")

    session_vm = vm_manager.get_session_vm(session_id)
    if not session_vm:
        return Response(content='{"error": "Session not found"}', status_code=404, media_type="application/json")

    microvm_id = session_vm["vm_id"]
    try:
        client = vm_manager.get_lambda_client()
        client.resume_microvm(microvmIdentifier=microvm_id)
        logger.info(f"MicroVM resume requested: {microvm_id} (session={session_id})")

        for _ in range(6):
            await asyncio.sleep(5)
            state_resp = client.get_microvm(microvmIdentifier=microvm_id)
            state = state_resp.get("state", "PENDING")
            if state == "RUNNING":
                return {"status": "running", "microvmId": microvm_id, "sessionId": session_id}

        return {"status": "resuming", "microvmId": microvm_id, "sessionId": session_id}
    except Exception as e:
        logger.error(f"Failed to resume: {e}")
        return Response(content=f'{{"error": "Resume failed: {str(e)}"}}', status_code=502, media_type="application/json")



@router.get("/instances")
async def list_instances(request: Request):
    """List all MicroVMs in the account (running + suspended), with live state from AWS."""
    vm_manager = request.app.state.vm_manager
    try:
        client = vm_manager.get_lambda_client()
        response = client.list_microvms()
        items = response.get("items", [])

        instances = {}
        for item in items:
            microvm_id = item.get("microvmId", "")
            state = item.get("state", "UNKNOWN")
            if state == "TERMINATED":
                continue

            local_info = vm_manager.active_microvms.get(microvm_id, {})
            endpoint = local_info.get("endpoint", "")

            # Always check SQLite DB for authoritative metadata (launch time, lifecycle config)
            # The local cache may have stale values after proxy restarts
            db_session = storage.vm_session_get(microvm_id)

            # Only fetch endpoint from AWS if we don't have it
            detail = None
            if not endpoint and state in ("RUNNING", "SUSPENDED"):
                if db_session and db_session.get("endpoint"):
                    endpoint = db_session["endpoint"]
                else:
                    try:
                        detail = client.get_microvm(microvmIdentifier=microvm_id)
                        endpoint = detail.get("endpoint", "")
                    except Exception:
                        pass

            # Determine memory
            memory_mib = local_info.get("memory_mib")
            if not memory_mib and detail:
                image_arn = detail.get("imageArn", "")
                if image_arn:
                    image_name = image_arn.split(":")[-1]
                    parts = image_name.rsplit("-", 1)
                    if len(parts) == 2 and parts[1].isdigit():
                        memory_mib = int(parts[1])
            if not memory_mib and db_session:
                memory_mib = db_session.get("memory_mib")
            if not memory_mib:
                memory_mib = 4096

            instances[microvm_id] = {
                "endpoint": endpoint,
                "name": local_info.get("name", "") or (db_session or {}).get("notebook_id", ""),
                "state": state,
                "launched_at": (db_session or {}).get("launched_at") or local_info.get("launched_at"),
                "memory_mib": memory_mib,
                "session_id": local_info.get("session_id") or (db_session or {}).get("session_id") if not local_info.get("_rotation_pending") else None,
                "idle_timeout_sec": local_info.get("idle_timeout_sec") or (db_session or {}).get("idle_timeout_sec"),
                "last_active": local_info.get("last_active"),
                "max_duration_sec": local_info.get("max_duration_sec") or (db_session or {}).get("max_duration_sec"),
                "cost": vm_manager.cost_tracker.get_cost(microvm_id),
                "session_cost": vm_manager.cost_tracker.get_session_cost(
                    vm_manager.session_rotator.get_session_vm_history(
                        local_info.get("session_id") or (db_session or {}).get("session_id") or ""
                    )
                ) if not local_info.get("_rotation_pending") else None,
                "rotation_count": getattr(vm_manager.session_rotator._sessions.get(
                    local_info.get("session_id") or (db_session or {}).get("session_id") or ""
                ), 'rotation_count', 0),
                "unhealthy": local_info.get("_502_strikes", 0) >= 3,
            }
            vm_manager.cost_tracker.record(microvm_id, state, memory_mib=memory_mib)
            # Persist cost to DB periodically
            vm_manager.cost_tracker.persist_cost(microvm_id, storage)

        # Include recently launched VMs not yet in AWS API response
        # (exclude VMs mid-rotation that haven't completed swap yet)
        for microvm_id, local_info in list(vm_manager.active_microvms.items()):
            if microvm_id not in instances and not local_info.get("_rotation_pending"):
                launched_at = local_info.get("launched_at", 0)
                if time.time() - launched_at <= 60:
                    memory_mib = local_info.get("memory_mib", 4096)
                    instances[microvm_id] = {
                        "endpoint": local_info.get("endpoint", ""),
                        "name": local_info.get("name", ""),
                        "state": "RUNNING",
                        "launched_at": launched_at,
                        "memory_mib": memory_mib,
                        "session_id": local_info.get("session_id"),
                        "idle_timeout_sec": local_info.get("idle_timeout_sec"),
                        "last_active": local_info.get("last_active"),
                        "max_duration_sec": local_info.get("max_duration_sec"),
                        "cost": vm_manager.cost_tracker.get_cost(microvm_id),
                    }
                    vm_manager.cost_tracker.record(microvm_id, "RUNNING", memory_mib=memory_mib)

        # Mark DB sessions as TERMINATED if they've disappeared from AWS
        try:
            active_sessions = storage.vm_session_list_active()
            for session in active_sessions:
                mid = session["microvm_id"]
                if mid not in instances and (time.time() - (session.get("launched_at_epoch") or 0)) > 120:
                    storage.vm_session_update_state(mid, "TERMINATED")
        except Exception:
            pass

        return {
            "instances": instances,
            "total_cost": vm_manager.cost_tracker.get_total_cost(),
            "persistence_mode": os.environ.get("SESSION_PERSISTENCE_MODE", "checkpoint"),
        }
    except Exception as e:
        logger.error(f"Failed to list instances: {e}")
        return {
            "instances": vm_manager.active_microvms,
            "total_cost": vm_manager.cost_tracker.get_total_cost(),
            "persistence_mode": os.environ.get("SESSION_PERSISTENCE_MODE", "checkpoint"),
        }


@router.get("/rotation-history/{session_id}")
async def get_rotation_history(session_id: str, request: Request):
    """Get step-by-step timing for all rotations of a session."""
    vm_manager = request.app.state.vm_manager
    history = vm_manager.session_rotator.get_rotation_history(session_id)
    return {"session_id": session_id, "rotations": history, "count": len(history)}


@router.get("/instances/metrics")
async def get_instance_metrics(microvm_id: str = None, request: Request = None):
    """Fetch real-time metrics from a specific running MicroVM."""
    vm_manager = request.app.state.vm_manager

    if not microvm_id:
        result = {}
        for mid in vm_manager.active_microvms:
            latest = storage.metrics_get_latest(mid)
            if latest:
                result[mid] = latest
        return {"metrics": result}

    info = vm_manager.active_microvms.get(microvm_id)
    endpoint = info.get("endpoint") if info else None

    if not endpoint:
        try:
            client = vm_manager.get_lambda_client()
            detail = client.get_microvm(microvmIdentifier=microvm_id)
            endpoint = detail.get("endpoint", "")
            if endpoint:
                vm_manager.active_microvms[microvm_id] = {
                    "endpoint": endpoint, "launched_at": time.time(), "memory_mib": 2048,
                }
        except Exception:
            pass

    if not endpoint:
        return {"metrics": {}}

    try:
        token = vm_manager.get_auth_token(microvm_id)
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(
                f"https://{endpoint}/metrics",
                headers={"X-aws-proxy-auth": token},
            )
            if resp.status_code == 200:
                m = resp.json()
                storage.metrics_record(
                    microvm_id=microvm_id,
                    cpu_pct=m.get("cpu", {}).get("percent", 0),
                    mem_pct=m.get("memory", {}).get("percent", 0),
                    mem_used_mb=m.get("memory", {}).get("used_mb", 0),
                    disk_pct=m.get("disk", {}).get("percent", 0),
                    disk_used_mb=m.get("disk", {}).get("used_mb", 0),
                    net_bytes_sent=m.get("network", {}).get("bytes_sent", 0),
                    net_bytes_recv=m.get("network", {}).get("bytes_recv", 0),
                    processes=m.get("processes", 0),
                    uptime_sec=m.get("uptime_sec", 0),
                )
                # Track burst usage for cost calculation
                used_mb = m.get("memory", {}).get("used_mb", 0)
                if used_mb > 0:
                    vm_manager.cost_tracker.record_burst(microvm_id, used_mb)
                return {"metrics": {microvm_id: m}}
            else:
                logger.warning(f"Metrics endpoint for {microvm_id} returned {resp.status_code}")
    except Exception:
        pass

    return {"metrics": {}}



