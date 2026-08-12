"""
MicroVM Lifecycle Hooks.

Part of: app.platform (infrastructure layer)

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
import os
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Request

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/aws/lambda-microvms/runtime/v1", tags=["lifecycle"])

# Separate router for proxy-facing endpoints (no prefix — called directly by our proxy)
proxy_router = APIRouter(tags=["rotation"])


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
    payload = {}
    try:
        payload = json.loads(run_payload)
        session_state["session_id"] = payload.get("session_id", run_payload)
        session_state["checkpoint_enabled"] = payload.get("checkpoint_enabled", False)
        session_state["persistence_mode"] = payload.get("persistence_mode", "checkpoint")
        session_state["artifacts_bucket"] = payload.get("artifacts_bucket")
        restore_from = payload.get("restore_from")
    except (json.JSONDecodeError, TypeError):
        session_state["session_id"] = run_payload
        session_state["checkpoint_enabled"] = False
        session_state["persistence_mode"] = "checkpoint"

    logger.info(f"🚀 HOOK /run — Sandbox started")
    logger.info(f"   MicroVM ID: {session_state['microvm_id']}")
    logger.info(f"   Session: {session_state['session_id']}")
    logger.info(f"   Checkpoint enabled: {session_state['checkpoint_enabled']}")

    # Restore from a previous session checkpoint if requested
    if restore_from:
        logger.info(f"   Restoring from session: {restore_from}")
        request.app.state.checkpoint_manager.restore(restore_from)

    # Inject environment variables (direct values + secrets from Secrets Manager)
    try:
        env_vars = payload.get("env_vars", {})
        secrets = payload.get("secrets", [])

        # Direct env vars — inject immediately
        for key, value in env_vars.items():
            os.environ[key] = str(value)
            logger.info(f"   ENV: {key} = ****")

        # Secrets Manager — fetch values and inject
        if secrets:
            import boto3
            sm = boto3.client("secretsmanager", region_name=os.environ.get("AWS_REGION", "us-west-2"))
            # Group by ARN to avoid fetching the same secret multiple times
            secret_cache = {}
            for secret in secrets:
                env_var_name = secret.get("envVar", "")
                arn = secret.get("arn", "")
                secret_key = secret.get("secretKey", "")
                if env_var_name and arn:
                    try:
                        # Fetch and cache
                        if arn not in secret_cache:
                            resp = sm.get_secret_value(SecretId=arn)
                            secret_cache[arn] = resp.get("SecretString", "")

                        secret_value = secret_cache[arn]

                        if secret_key:
                            # Extract specific key from JSON secret
                            try:
                                data = json.loads(secret_value)
                                os.environ[env_var_name] = str(data.get(secret_key, ""))
                                logger.info(f"   SECRET: {env_var_name} ← {secret.get('name', arn)}[{secret_key}]")
                            except (json.JSONDecodeError, TypeError):
                                os.environ[env_var_name] = secret_value
                                logger.info(f"   SECRET: {env_var_name} ← {secret.get('name', arn)} (plain)")
                        else:
                            # No key specified — inject entire value
                            os.environ[env_var_name] = secret_value
                            logger.info(f"   SECRET: {env_var_name} ← {secret.get('name', arn)}")
                    except Exception as e:
                        logger.warning(f"   Failed to fetch secret {arn}: {e}")
    except Exception as e:
        logger.warning(f"   Failed to inject env vars/secrets: {e}")

    # Start background data catalog schema discovery
    data_sources = payload.get("data_sources", {})
    if data_sources:
        logger.info(f"   📊 Starting data catalog discovery ({len(data_sources.get('s3', []))} S3, {len(data_sources.get('dynamodb', []))} DynamoDB, {len(data_sources.get('athena', []))} Athena)")
        request.app.state.data_catalog.start_discovery(data_sources)

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
        # Only save on terminate in checkpoint mode.
        # In eternal mode, the rotator owns state transfer (/checkpoint-save + /restore-state)
        # and the /terminate hook should never waste time re-serializing.
        if session_state.get("persistence_mode") == "checkpoint":
            logger.info(f"   📦 Checkpointing session to S3...")
            try:
                checkpoint_manager = request.app.state.checkpoint_manager
                checkpoint_manager.save(session_state["session_id"])
                logger.info(f"   ✅ Checkpoint saved: sessions/{session_state['session_id']}/")
            except Exception as e:
                import traceback
                logger.error(f"   ❌ Checkpoint failed: {e}\n{traceback.format_exc()}")
        else:
            logger.info(f"   ⏭️  Eternal mode — rotator handles state transfer, skipping checkpoint")

    return {"status": "terminated"}


@proxy_router.post("/checkpoint-save")
async def checkpoint_save(request: Request):
    """
    On-demand checkpoint save — saves state to S3 WITHOUT terminating.
    Called by the proxy's rotation logic before swapping to a new VM.

    Request body (optional):
        {"session_id": "override-session-id"}
    """
    session_state = request.app.state.session_state
    checkpoint_manager = request.app.state.checkpoint_manager

    body = await request.json() if request.headers.get("content-type") == "application/json" else {}
    session_id = body.get("session_id") or session_state.get("session_id")

    if not session_id:
        return {"success": False, "error": "No session_id available"}

    logger.info(f"📦 /checkpoint-save — Saving state on demand (session={session_id})")
    try:
        checkpoint_manager.save(session_id)
        logger.info(f"   ✅ Checkpoint saved: sessions/{session_id}/")
        return {
            "success": True,
            "session_id": session_id,
            "save_timings_ms": checkpoint_manager.last_save_timings,
        }
    except Exception as e:
        import traceback
        tb = traceback.format_exc()
        logger.error(f"   ❌ Checkpoint save failed: {e}\n{tb}")
        return {"success": False, "error": str(e), "traceback": tb}


@proxy_router.post("/restore-state")
async def restore_state(request: Request):
    """
    On-demand state restore — loads state from S3 onto this running VM.
    Called by the proxy's rotation logic after launching a new VM.

    Request body:
        {"session_id": "session-to-restore-from"}
    """
    checkpoint_manager = request.app.state.checkpoint_manager
    session_state = request.app.state.session_state

    body = await request.json()
    session_id = body.get("session_id")

    if not session_id:
        return {"success": False, "error": "session_id required"}

    logger.info(f"♻️ /restore-state — Restoring from S3 (session={session_id})")
    try:
        checkpoint_manager.restore(session_id)
        # Update session state to reflect the restored session
        session_state["session_id"] = session_id
        session_state["checkpoint_enabled"] = True
        logger.info(f"   ✅ State restored from: {session_id}")
        return {
            "success": True,
            "session_id": session_id,
            "restore_timings": checkpoint_manager.last_restore_timings,
        }
    except Exception as e:
        import traceback
        logger.error(f"   ❌ Restore failed: {e}\n{traceback.format_exc()}")
        return {"success": False, "error": str(e)}
