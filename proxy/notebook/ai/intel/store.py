"""
Generation-state tracking + S3 persistence for Workbook Intelligence.

Part of: proxy.notebook.ai.intel

Owns:
  - the in-memory "is a generation actively running" registry (so callers can
    report status="generating" and de-duplicate concurrent requests), and
  - reading/writing the intel report JSON to S3
    (sessions/{session_id}/workbook-intel.json).
"""

import os
import json
import time
import logging
import threading

import boto3

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# In-memory "is generation actively running" tracking.
#
# Without this, GET /workbook-intel could only ever report "not_generated"
# (no DB row yet) or "ready" (DB row + S3 content found) — there was no way
# to distinguish "hasn't started" from "is actively running right now".
# That ambiguity forced clients to poll on a blind fixed schedule and guess
# when generation was probably done, which is unreliable for a variable-
# duration AI agent call. Tracking real state here lets callers report
# status="generating" truthfully, and lets us de-duplicate concurrent
# generation requests for the same session (e.g. file-upload auto-trigger
# and a manual "Generate" click firing close together).
# ---------------------------------------------------------------------------
_generating_lock = threading.Lock()
# session_id -> {"started": ts, "trigger": str}. trigger lets the UI show the right
# "updating" message (added data vs removed data) while a delta/deletion runs.
_generating_sessions: dict[str, dict] = {}


def is_generating(session_id: str) -> bool:
    """True if a generation is currently in progress for this session."""
    with _generating_lock:
        return session_id in _generating_sessions


def get_generating_trigger(session_id: str) -> str | None:
    """The trigger of the in-progress generation ('file_upload'|'file_delete'|'manual'|...), or None."""
    with _generating_lock:
        entry = _generating_sessions.get(session_id)
        return entry.get("trigger") if entry else None


def _mark_generating_start(session_id: str, trigger: str = "manual") -> None:
    with _generating_lock:
        _generating_sessions[session_id] = {"started": time.time(), "trigger": trigger}


def _mark_generating_done(session_id: str) -> None:
    with _generating_lock:
        _generating_sessions.pop(session_id, None)


def save_intel_to_s3(session_id: str, intel_data: dict, bucket: str) -> str:
    """Save the intel data (JSON with structured cards + full report) to S3."""
    s3 = boto3.client("s3", region_name=os.environ.get("AWS_REGION", "us-west-2"))
    s3_key = f"sessions/{session_id}/workbook-intel.json"
    s3.put_object(
        Bucket=bucket,
        Key=s3_key,
        Body=json.dumps(intel_data, indent=2).encode("utf-8"),
        ContentType="application/json",
    )
    logger.info(f"[intel]    → Saved to s3://{bucket}/{s3_key}")
    return s3_key


def load_intel_from_s3(session_id: str, bucket: str) -> dict | None:
    """Load the intel data from S3. Returns None if not found."""
    s3 = boto3.client("s3", region_name=os.environ.get("AWS_REGION", "us-west-2"))
    s3_key = f"sessions/{session_id}/workbook-intel.json"
    try:
        resp = s3.get_object(Bucket=bucket, Key=s3_key)
        return json.loads(resp["Body"].read().decode("utf-8"))
    except s3.exceptions.NoSuchKey:
        return None
    except Exception as e:
        logger.warning(f"[intel] Failed to load from S3: {e}")
        return None
