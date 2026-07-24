"""
MicroVM lifecycle routes — launch, terminate, suspend, resume, proxy, instances.

Part of: proxy.platform (Smart MicroVM Service layer)

Endpoints:
  POST      /launch                       - Launch a new MicroVM
  POST      /terminate/{id}               - Terminate a MicroVM
  POST      /suspend/{id}                 - Suspend a running MicroVM
  POST      /resume/{id}                  - Resume a suspended MicroVM
  POST      /terminate-timer/cancel/{id}  - Cancel pre-termination timer
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
    INGRESS_CONNECTOR, EGRESS_CONNECTOR,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["microvm"])


@router.api_route("/proxy/{path:path}", methods=["GET", "POST", "PUT", "DELETE"])
async def proxy_request(path: str, request: Request):
    """Proxy a request to the MicroVM with auth token injected."""
    vm_manager = request.app.state.vm_manager
    microvm_id = request.headers.get("X-MicroVM-Id")
    microvm_endpoint = request.headers.get("X-MicroVM-Endpoint")

    if not microvm_id or not microvm_endpoint:
        return Response(
            content='{"error": "X-MicroVM-Id and X-MicroVM-Endpoint headers required"}',
            status_code=400,
            media_type="application/json",
        )

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
                health = vm_manager.active_microvms.get(microvm_id, {})
                strikes = health.get("_502_strikes", 0) + 1
                if microvm_id in vm_manager.active_microvms:
                    vm_manager.active_microvms[microvm_id]["_502_strikes"] = strikes
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
    valid_memories = [512, 1024, 2048, 4096, 8192]
    if memory_mib not in valid_memories:
        memory_mib = min(valid_memories, key=lambda x: abs(x - memory_mib))
    idle_timeout_sec = body.get("idleTimeoutSeconds", 1800)
    max_duration_sec = body.get("maxDurationSeconds", 28800)
    checkpoint_enabled = body.get("checkpointEnabled", False)
    restore_from = body.get("restoreFromSession")
    session_id = body.get("sessionId", f"{notebook_name}-{int(time.time())}")

    image_arn = f"{IMAGE_ARN}-{memory_mib}" if IMAGE_ARN else ""
    if not image_arn:
        return Response(
            content='{"error": "MICROVM_IMAGE_ARN not configured"}',
            status_code=500,
            media_type="application/json",
        )

    logger.info(f"Launching MicroVM for: {notebook_name} (memory: {memory_mib} MiB, image: {image_arn})")

    try:
        client = vm_manager.get_lambda_client()
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
                "artifacts_bucket": vm_manager.get_artifacts_bucket(),
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

        if checkpoint_enabled and max_duration_sec:
            vm_manager.schedule_pre_terminate(microvm_id, max_duration_sec)

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


@router.post("/terminate/{microvm_id}")
async def terminate_microvm(microvm_id: str, request: Request):
    """Terminate a MicroVM instance."""
    vm_manager = request.app.state.vm_manager
    try:
        vm_manager.cancel_pre_terminate(microvm_id)
        client = vm_manager.get_lambda_client()
        client.terminate_microvm(microvmIdentifier=microvm_id)
        vm_manager.active_microvms.pop(microvm_id, None)
        vm_manager.token_cache.pop(microvm_id)
        logger.info(f"MicroVM terminated: {microvm_id}")
        return {"status": "terminated", "microvmId": microvm_id}
    except Exception as e:
        logger.error(f"Failed to terminate: {e}")
        return Response(
            content=f'{{"error": "Terminate failed: {str(e)}"}}',
            status_code=502,
            media_type="application/json",
        )


@router.post("/suspend/{microvm_id}")
async def suspend_microvm(microvm_id: str, request: Request):
    """Suspend a running MicroVM instance."""
    vm_manager = request.app.state.vm_manager
    try:
        client = vm_manager.get_lambda_client()
        client.suspend_microvm(microvmIdentifier=microvm_id)
        logger.info(f"MicroVM suspend requested: {microvm_id}")
        return {"status": "suspended", "microvmId": microvm_id}
    except Exception as e:
        logger.error(f"Failed to suspend: {e}")
        return Response(
            content=f'{{"error": "Suspend failed: {str(e)}"}}',
            status_code=502,
            media_type="application/json",
        )


@router.post("/terminate-timer/cancel/{microvm_id}")
async def cancel_terminate_timer(microvm_id: str, request: Request):
    """Cancel the pre-termination timer for a VM."""
    vm_manager = request.app.state.vm_manager
    vm_manager.cancel_pre_terminate(microvm_id)
    return {"status": "cancelled", "microvmId": microvm_id}


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
                "idle_timeout_sec": local_info.get("idle_timeout_sec") or (db_session or {}).get("idle_timeout_sec"),
                "max_duration_sec": local_info.get("max_duration_sec") or (db_session or {}).get("max_duration_sec"),
                "cost": vm_manager.cost_tracker.get_cost(microvm_id),
                "unhealthy": local_info.get("_502_strikes", 0) >= 3,
            }
            vm_manager.cost_tracker.record(microvm_id, state, memory_mib=memory_mib)
            # Persist cost to DB periodically
            vm_manager.cost_tracker.persist_cost(microvm_id, storage)

        # Include recently launched VMs not yet in AWS API response
        for microvm_id, local_info in list(vm_manager.active_microvms.items()):
            if microvm_id not in instances:
                launched_at = local_info.get("launched_at", 0)
                if time.time() - launched_at <= 60:
                    memory_mib = local_info.get("memory_mib", 4096)
                    instances[microvm_id] = {
                        "endpoint": local_info.get("endpoint", ""),
                        "name": local_info.get("name", ""),
                        "state": "RUNNING",
                        "launched_at": launched_at,
                        "memory_mib": memory_mib,
                        "idle_timeout_sec": local_info.get("idle_timeout_sec"),
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

        return {"instances": instances, "total_cost": vm_manager.cost_tracker.get_total_cost()}
    except Exception as e:
        logger.error(f"Failed to list instances: {e}")
        return {"instances": vm_manager.active_microvms, "total_cost": vm_manager.cost_tracker.get_total_cost()}


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


@router.post("/resume/{microvm_id}")
async def resume_microvm(microvm_id: str, request: Request):
    """Resume a suspended MicroVM."""
    vm_manager = request.app.state.vm_manager
    try:
        client = vm_manager.get_lambda_client()
        client.resume_microvm(microvmIdentifier=microvm_id)
        logger.info(f"MicroVM resume requested: {microvm_id}")

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
