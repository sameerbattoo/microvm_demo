"""
CloudWatch Log Streaming — SSE endpoint that tails MicroVM logs in real-time.

Part of: proxy.notebook (Notebook application layer)

Endpoint:
  GET /logs/stream  - Stream CloudWatch logs for the MicroVM linked to the session (SSE)

How it works:
  1. Resolves session_id → microvm_id → log group + log stream
  2. Polls CloudWatch FilterLogEvents every 1.5s (like `aws logs tail --follow`)
  3. Pushes new log events as SSE to the frontend
"""

import asyncio
import json
import time
import logging
from datetime import datetime, timezone

import boto3
from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse, JSONResponse

from proxy.platform.microvm_manager import AWS_REGION

logger = logging.getLogger(__name__)

router = APIRouter(tags=["logs"])

# CloudWatch log group prefix for MicroVM runtime logs
LOG_GROUP_PREFIX = "/aws/lambda-microvms/agent-sandbox"

# Poll interval for CloudWatch (seconds)
POLL_INTERVAL = 1.5

# Maximum time to keep the SSE connection open (seconds)
MAX_STREAM_DURATION = 3600  # 1 hour


def _get_log_group_for_vm(vm_id: str, memory_mib: int) -> str:
    """Determine the CloudWatch log group for a given VM size."""
    return f"{LOG_GROUP_PREFIX}-{memory_mib}"


def _find_log_stream(logs_client, log_group: str, vm_id: str) -> str | None:
    """
    Find the log stream for a specific MicroVM ID.
    Stream name format: {date}[{version}]microvm-{vm_id}
    We search by the vm_id suffix since the date/version prefix varies.
    """
    try:
        # Use log stream name prefix with the microvm ID
        # The stream name contains the vm_id, but prefixed with date — so use describe with ordering
        resp = logs_client.describe_log_streams(
            logGroupName=log_group,
            orderBy="LastEventTime",
            descending=True,
            limit=20,
        )
        for stream in resp.get("logStreams", []):
            if vm_id in stream["logStreamName"]:
                return stream["logStreamName"]
    except Exception as e:
        logger.warning(f"Failed to find log stream for {vm_id}: {e}")
    return None


@router.get("/logs/stream")
async def stream_logs(request: Request):
    """
    Stream CloudWatch logs for the MicroVM linked to the current session.
    
    Uses Server-Sent Events (SSE) — same pattern as `aws logs tail --follow`.
    Polls FilterLogEvents every 1.5s and pushes new events to the client.
    
    Headers:
        X-Session-Id: session UUID (required)
    
    Query params:
        since: Unix timestamp (ms) to start from. Default: VM launch time or last 60s.
    
    SSE events:
        data: {"type": "log", "timestamp": 1234567890, "message": "...", "level": "INFO"}
        data: {"type": "meta", "log_group": "...", "log_stream": "...", "vm_id": "..."}
        data: {"type": "error", "message": "..."}
    """
    session_id = request.headers.get("X-Session-Id", "")
    if not session_id:
        return JSONResponse(status_code=400, content={"error": "X-Session-Id header required"})

    vm_manager = request.app.state.vm_manager
    session_vm = vm_manager.get_session_vm(session_id)

    if not session_vm:
        return JSONResponse(status_code=404, content={"error": "No VM found for this session"})

    vm_id = session_vm["vm_id"]
    vm_details = vm_manager.active_microvms.get(vm_id, {})
    memory_mib = vm_details.get("memory_mib", 2048)

    log_group = _get_log_group_for_vm(vm_id, memory_mib)

    # Determine start time (default: 60s ago or from query param)
    since_param = request.query_params.get("since")
    if since_param:
        start_time = int(since_param)
    else:
        # Start from 60 seconds ago to catch recent logs
        start_time = int((time.time() - 60) * 1000)

    logger.info(f"📋 Log stream started: session={session_id[:8]}... vm={vm_id} group={log_group}")

    async def event_stream():
        logs_client = boto3.client("logs", region_name=AWS_REGION)
        current_start_time = start_time
        stream_name = None
        stream_start = time.time()

        # Send metadata event
        yield f"data: {json.dumps({'type': 'meta', 'log_group': log_group, 'vm_id': vm_id, 'session_id': session_id})}\n\n"

        while True:
            # Check if client disconnected
            if await request.is_disconnected():
                logger.info(f"📋 Log stream closed (client disconnected): session={session_id[:8]}...")
                break

            # Check max duration
            if time.time() - stream_start > MAX_STREAM_DURATION:
                yield f"data: {json.dumps({'type': 'error', 'message': 'Stream duration limit reached (1h)'})}\n\n"
                break

            try:
                # Find log stream on first poll (or if not found yet)
                if not stream_name:
                    stream_name = _find_log_stream(logs_client, log_group, vm_id)
                    if stream_name:
                        yield f"data: {json.dumps({'type': 'meta', 'log_stream': stream_name})}\n\n"
                    else:
                        # VM may not have produced logs yet — wait and retry
                        yield f"data: {json.dumps({'type': 'waiting', 'message': 'Waiting for log stream...'})}\n\n"
                        await asyncio.sleep(POLL_INTERVAL * 2)
                        continue

                # Poll for new log events
                params = {
                    "logGroupName": log_group,
                    "logStreamNames": [stream_name],
                    "startTime": current_start_time,
                    "interleaved": True,
                }

                resp = logs_client.filter_log_events(**params)
                events = resp.get("events", [])

                for event in events:
                    ts = event["timestamp"]
                    msg = event["message"].rstrip("\n")

                    # Classify log level from message content
                    level = "INFO"
                    if "ERROR" in msg or "✗" in msg or "❌" in msg:
                        level = "ERROR"
                    elif "WARNING" in msg or "⚠" in msg:
                        level = "WARN"
                    elif "DEBUG" in msg:
                        level = "DEBUG"

                    log_event = {
                        "type": "log",
                        "timestamp": ts,
                        "time": datetime.fromtimestamp(ts / 1000, tz=timezone.utc).strftime("%H:%M:%S.%f")[:-3],
                        "message": msg,
                        "level": level,
                    }
                    yield f"data: {json.dumps(log_event)}\n\n"

                    # Advance start time past this event
                    current_start_time = max(current_start_time, ts + 1)

            except logs_client.exceptions.ResourceNotFoundException:
                # Log group or stream doesn't exist yet
                yield f"data: {json.dumps({'type': 'waiting', 'message': f'Log group {log_group} not found yet'})}\n\n"
                stream_name = None  # retry finding the stream
            except Exception as e:
                logger.warning(f"Log stream poll error: {e}")
                yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"

            await asyncio.sleep(POLL_INTERVAL)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",  # Disable nginx buffering if proxied
        },
    )


@router.get("/logs/history")
async def get_log_history(request: Request):
    """
    Fetch recent log history (non-streaming) for the current session's MicroVM.
    
    Headers:
        X-Session-Id: session UUID (required)
    
    Query params:
        limit: max events to return (default: 100, max: 500)
        since: Unix timestamp (ms) to start from (default: last 5 minutes)
    
    Returns JSON array of log events.
    """
    session_id = request.headers.get("X-Session-Id", "")
    if not session_id:
        return JSONResponse(status_code=400, content={"error": "X-Session-Id header required"})

    vm_manager = request.app.state.vm_manager
    session_vm = vm_manager.get_session_vm(session_id)

    if not session_vm:
        return JSONResponse(status_code=404, content={"error": "No VM found for this session"})

    vm_id = session_vm["vm_id"]
    vm_details = vm_manager.active_microvms.get(vm_id, {})
    memory_mib = vm_details.get("memory_mib", 2048)
    log_group = _get_log_group_for_vm(vm_id, memory_mib)

    limit = min(int(request.query_params.get("limit", "100")), 500)
    since_param = request.query_params.get("since")
    start_time = int(since_param) if since_param else int((time.time() - 300) * 1000)  # last 5 min

    try:
        logs_client = boto3.client("logs", region_name=AWS_REGION)
        stream_name = _find_log_stream(logs_client, log_group, vm_id)

        if not stream_name:
            return {"events": [], "log_group": log_group, "vm_id": vm_id, "message": "No log stream found yet"}

        resp = logs_client.filter_log_events(
            logGroupName=log_group,
            logStreamNames=[stream_name],
            startTime=start_time,
            limit=limit,
            interleaved=True,
        )

        events = []
        for event in resp.get("events", []):
            ts = event["timestamp"]
            msg = event["message"].rstrip("\n")
            level = "INFO"
            if "ERROR" in msg or "✗" in msg or "❌" in msg:
                level = "ERROR"
            elif "WARNING" in msg or "⚠" in msg:
                level = "WARN"

            events.append({
                "timestamp": ts,
                "time": datetime.fromtimestamp(ts / 1000, tz=timezone.utc).strftime("%H:%M:%S.%f")[:-3],
                "message": msg,
                "level": level,
            })

        return {
            "events": events,
            "log_group": log_group,
            "log_stream": stream_name,
            "vm_id": vm_id,
            "count": len(events),
        }

    except Exception as e:
        logger.warning(f"Log history fetch error: {e}")
        return JSONResponse(status_code=500, content={"error": str(e)})
