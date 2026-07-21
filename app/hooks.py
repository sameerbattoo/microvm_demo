"""
MicroVM Lifecycle Hooks.

These endpoints are called by the Lambda MicroVM runtime (not by user code)
at key points in the MicroVM lifecycle:

  /ready     — Image build: app is ready for snapshot
  /validate  — Image build: validation hook
  /run       — MicroVM started: initialize per-session state
  /suspend   — Going idle: flush state, prepare for freeze
  /resume    — Waking up: restore connections, validate state
  /terminate — Shutting down: checkpoint to S3 if enabled
"""

import json
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Request

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/aws/lambda-microvms/runtime/v1", tags=["lifecycle"])


@router.post("/ready")
async def hook_ready(request: Request):
    """Called during image build — signals app is ready for snapshot."""
    logger.info("🔧 HOOK /ready — App initialized, ready for snapshot")
    return {"status": "ready"}


@router.post("/validate")
async def hook_validate(request: Request):
    """Called during image build — validates the image."""
    executor = request.app.state.executor
    session_state = request.app.state.session_state
    logger.info("🔧 HOOK /validate — Running validation")
    result = executor.execute("print('Sandbox validation: OK')")
    executor.reset()
    return {
        "status": "valid",
        "validation_output": result.output,
    }


@router.post("/run")
async def hook_run(request: Request):
    """
    Called when this MicroVM starts from snapshot.

    The runHookPayload contains a JSON string with session config:
    - notebook_name: display name
    - session_id: unique session ID for checkpoint/restore
    - restore_from: session_id to restore state from (optional)
    - artifacts_bucket: S3 bucket name for checkpoint storage

    IMPORTANT: No external traffic reaches the app until this returns 200.
    """
    executor = request.app.state.executor
    session_state = request.app.state.session_state

    body = await request.json()
    session_state["microvm_id"] = body.get("microvmId")
    session_state["started_at"] = datetime.now(timezone.utc).isoformat()

    run_payload = body.get("runHookPayload", "")
    restore_from = None
    try:
        payload = json.loads(run_payload)
        session_state["session_id"] = payload.get("session_id", run_payload)
        session_state["checkpoint_enabled"] = payload.get("checkpoint_enabled", False)
        session_state["artifacts_bucket"] = payload.get("artifacts_bucket")
        restore_from = payload.get("restore_from")
    except (json.JSONDecodeError, TypeError):
        session_state["session_id"] = run_payload
        session_state["checkpoint_enabled"] = False

    logger.info(f"🚀 HOOK /run — Sandbox started")
    logger.info(f"   MicroVM ID: {session_state['microvm_id']}")
    logger.info(f"   Session: {session_state['session_id']}")
    logger.info(f"   Checkpoint enabled: {session_state['checkpoint_enabled']}")

    # Restore from a previous session checkpoint if requested
    if restore_from:
        logger.info(f"   Restoring from session: {restore_from}")
        request.app.state.checkpoint_manager.restore(restore_from)

    return {"status": "running", "session_id": session_state["session_id"]}


@router.post("/suspend")
async def hook_suspend(request: Request):
    """
    Called BEFORE suspend (idle timeout or explicit suspend).
    Memory + disk will be frozen after this returns.
    """
    executor = request.app.state.executor
    session_state = request.app.state.session_state
    session_state["suspend_count"] += 1

    stats = executor.get_stats()
    logger.info(f"💤 HOOK /suspend — Going to sleep")
    logger.info(f"   Executions so far: {stats['execution_count']}")
    logger.info(f"   Variables in namespace: {stats['variables_count']}")

    return {"status": "suspended"}


@router.post("/resume")
async def hook_resume(request: Request):
    """
    Called AFTER resume (traffic arrived or explicit resume).
    Memory + disk are restored from the suspend snapshot.
    """
    executor = request.app.state.executor
    session_state = request.app.state.session_state
    session_state["resume_count"] += 1

    stats = executor.get_stats()
    logger.info(f"⏰ HOOK /resume — Waking up")
    logger.info(f"   State intact: {stats['variables_count']} variables, {stats['execution_count']} prior executions")

    return {"status": "running"}


@router.post("/terminate")
async def hook_terminate(request: Request):
    """
    Called BEFORE termination (max lifetime hit, or explicit terminate call).
    Timeout: 60 seconds to complete.

    If checkpoint is enabled, serializes the executor namespace and local files
    to S3 so the session can be restored on a new MicroVM.
    """
    executor = request.app.state.executor
    session_state = request.app.state.session_state

    stats = executor.get_stats()
    logger.info(f"🔴 HOOK /terminate — Shutting down")
    logger.info(f"   Total executions: {stats['execution_count']}")
    logger.info(f"   Total suspends: {session_state['suspend_count']}")
    logger.info(f"   Total resumes: {session_state['resume_count']}")

    if session_state.get("checkpoint_enabled") and session_state.get("session_id"):
        logger.info(f"   📦 Checkpointing session to S3...")
        try:
            request.app.state.checkpoint_manager.save(session_state["session_id"])
            logger.info(f"   ✅ Checkpoint saved: sessions/{session_state['session_id']}/")
        except Exception as e:
            logger.error(f"   ❌ Checkpoint failed: {e}")

    return {"status": "terminated"}
