"""
Workbook Intelligence routes — generate and retrieve AI data insights reports.

Part of: proxy.notebook (Notebook application layer)

Endpoints:
  GET  /workbook-intel           - Get the current intel report for a session
  POST /workbook-intel/generate  - Trigger (re)generation of the intel report
"""

import os
import logging

from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse

from proxy.storage import storage
from proxy.notebook.ai.workbook_intel import (
    generate_intel_async,
    load_intel_from_s3,
    is_generating,
    get_generating_trigger,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["workbook-intel"])

ARTIFACT_BUCKET = os.environ.get(
    "ARTIFACT_BUCKET",
    f"microvm-sandbox-artifacts-{os.environ.get('ACCOUNT_ID', 'unknown')}-{os.environ.get('AWS_REGION', 'us-west-2')}"
)


@router.get("/workbook-intel")
async def get_workbook_intel(request: Request):
    """
    Get the workbook intelligence report for the current session.
    
    Returns the markdown report if available, or status if generation is in progress.
    
    Headers:
        X-Session-Id: session UUID (required)
    """
    session_id = request.headers.get("X-Session-Id", "")
    if not session_id:
        return JSONResponse(status_code=400, content={"error": "X-Session-Id header required"})

    # Report real in-progress state first — this is the key fix for reliable
    # auto-popup: without it, callers can't tell "hasn't started" apart from
    # "actively running", and are forced to poll on a blind guessed schedule.
    if is_generating(session_id):
        # If a report already exists, this run is an incremental UPDATE (delta) that
        # extends/prunes it — signal that so the UI keeps the current report visible with
        # an "updating" indicator instead of blanking it and showing a bare spinner.
        existing_meta = storage.workbook_intel_get(session_id)
        has_existing = existing_meta is not None
        gen_trigger = get_generating_trigger(session_id)
        is_deletion = gen_trigger == "file_delete"
        if not has_existing:
            message = "Workbook intelligence report is being generated..."
        elif is_deletion:
            message = "Updating the report — removing insights tied to the deleted file..."
        else:
            message = "Updating the report with the newly uploaded data..."
        # Include the CURRENT (pre-update) report so a fresh panel mount (e.g. user
        # navigated away to Logs and back mid-update) can still render it under the
        # "updating" strip instead of showing a bare spinner. The report is replaced
        # once the update finishes and status flips to "ready".
        current_intel = load_intel_from_s3(session_id, ARTIFACT_BUCKET) if has_existing else None
        return {
            "status": "generating",
            "intel": current_intel,
            "generated_at": existing_meta.get("generated_at") if has_existing else None,
            "mode": "update" if has_existing else "full",
            "reason": "deletion" if is_deletion else ("addition" if has_existing else "full"),
            "has_existing": has_existing,
            "message": message,
        }

    # Check DB for existing intel
    intel_meta = storage.workbook_intel_get(session_id)
    if not intel_meta:
        return {"status": "not_generated", "intel": None, "message": "No intelligence report yet. Generate one or wait for auto-generation."}

    # Load from S3
    intel_data = load_intel_from_s3(session_id, ARTIFACT_BUCKET)
    if intel_data:
        return {
            "status": "ready",
            "intel": intel_data,
            "generated_at": intel_meta["generated_at"],
            "version": intel_meta["version"],
            "report_status": intel_data.get("report_status", "ready"),
        }

    return {"status": "error", "intel": None, "message": "Intel metadata exists but S3 content not found"}


@router.post("/workbook-intel/generate")
async def generate_workbook_intel(request: Request):
    """
    Trigger generation (or regeneration) of the workbook intelligence report.
    
    Can be called:
      1. By the VM after catalog discovery completes (trigger: "catalog_ready")
      2. By the user manually (trigger: "manual")
    
    Non-blocking — returns immediately, generation happens in background.
    
    Headers:
        X-Session-Id: session UUID (required)
    
    Body (optional):
        {"trigger": "catalog_ready" | "manual"}
    """
    session_id = request.headers.get("X-Session-Id", "")
    if not session_id:
        return JSONResponse(status_code=400, content={"error": "X-Session-Id header required"})

    body = {}
    try:
        body = await request.json()
    except Exception:
        pass

    trigger = body.get("trigger", "manual")
    deleted_source = body.get("deleted_source")  # required for trigger="file_delete"
    vm_manager = request.app.state.vm_manager

    # Verify session has an active VM
    session_vm = vm_manager.get_session_vm(session_id)
    if not session_vm:
        return JSONResponse(status_code=404, content={"error": "No active VM for this session"})

    logger.info(f"[intel] Generation triggered: session={session_id[:8]}... trigger={trigger}"
                + (f" deleted_source={deleted_source}" if deleted_source else ""))

    # Start async generation — de-duplicated: if one is already running for this
    # session (e.g. file-upload auto-trigger and a manual click landed close together),
    # this returns False and no second agent thread is spawned.
    started = generate_intel_async(
        session_id, vm_manager, ARTIFACT_BUCKET, storage,
        trigger=trigger, deleted_source=deleted_source,
    )

    if not started:
        return {"status": "generating", "message": "A workbook intelligence report is already being generated for this session."}

    return {"status": "generating", "message": "Workbook intelligence report is being generated..."}
