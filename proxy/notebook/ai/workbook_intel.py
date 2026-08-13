"""
Workbook Intelligence — AI-generated data insights using the notebook agent.

Part of: proxy.notebook.ai

Uses a dedicated AI agent instance (unique session ID per generation) to
perform actual data profiling and generate actionable intelligence.

The agent can:
  - Run df.describe(), df.isnull().sum(), df.nunique() via execute_code
  - Inspect schemas via get_available_data_sources  
  - Check what the user has done via get_variables

Storage: S3 (sessions/{session_id}/workbook-intel.json)
Metadata: SQLite (workbook_intel table)

Triggers:
  1. Auto: Frontend triggers after catalog discovery completes
  2. Manual: User clicks "Refresh" in the UI
"""

import os
import json
import time
import uuid
import logging
import threading

import boto3

from .prompts import INTEL_PROMPT
from .notebook_agent import set_execution_context, get_or_create_agent

logger = logging.getLogger(__name__)

PROXY_PORT = int(os.environ.get("PROXY_PORT", "8081"))


def generate_intel(session_id: str, vm_manager) -> dict | None:
    """
    Generate workbook intelligence using a dedicated AI agent with tools.
    
    Creates a new agent with a unique session ID each time (avoids concurrency
    conflicts with the user's chat agent).
    
    Returns structured dict or None on failure.
    """
    session_vm = vm_manager.get_session_vm(session_id)
    if not session_vm:
        logger.warning(f"[intel] No VM found for session {session_id[:8]}...")
        return None

    vm_id = session_vm["vm_id"]
    endpoint = session_vm["endpoint"]

    try:
        # Build context for the agent tools
        context = {
            "proxy_url": f"http://localhost:{PROXY_PORT}",
            "session_id": session_id,
            "notebook_cells": [],
            "memory_mib": vm_manager.active_microvms.get(vm_id, {}).get("memory_mib"),
            "data_sources": None,  # Agent will fetch via tool
            "packages": [],
            "uploaded_files": [],
        }

        # Use a unique session ID so get_or_create_agent creates a fresh agent
        intel_session_id = f"intel-{uuid.uuid4().hex[:8]}-{session_id}"

        # Set context for tools
        set_execution_context(context)

        # Create a brand new agent (unique ID = never conflicts with user's chat)
        agent = get_or_create_agent(intel_session_id, context)

        # Send the intel prompt
        logger.info(f"[intel] Calling agent for session {session_id[:8]}... (dedicated agent: {intel_session_id[:20]}...)")
        
        result = agent(INTEL_PROMPT.format(
            catalog_json="[Call get_available_data_sources tool to get full catalog with schemas]",
            notebook_state="[Call get_variables tool to see current namespace state]",
            variables="[Use execute_code to run quick profiling — MAX 5 calls: shape, nulls, dtypes]",
        ))

        raw_text = str(result).strip()
        logger.info(f"[intel] Agent response received ({len(raw_text)} chars)")

        # Parse JSON from agent response
        # Strip markdown code fences if present
        if "```json" in raw_text:
            raw_text = raw_text.split("```json")[1].split("```")[0].strip()
        elif "```" in raw_text:
            parts = raw_text.split("```")
            if len(parts) >= 3:
                raw_text = parts[1].strip()
                if raw_text.startswith("json"):
                    raw_text = raw_text[4:].strip()

        # Try to extract JSON object from response (agent may include preamble text)
        json_text = raw_text
        if not json_text.startswith("{"):
            # Find the first { and last } — extract the JSON object
            first_brace = json_text.find("{")
            last_brace = json_text.rfind("}")
            if first_brace != -1 and last_brace > first_brace:
                json_text = json_text[first_brace:last_brace + 1]

        try:
            intel_data = json.loads(json_text)
            logger.info(f"[intel] Parsed structured intel: "
                       f"{len(intel_data.get('suggested_analyses', []))} analyses, "
                       f"{len(intel_data.get('alerts', []))} alerts")
            return intel_data
        except json.JSONDecodeError as e:
            # Fallback: if agent didn't return valid JSON, wrap as full_report
            logger.warning(f"[intel] JSON parse failed ({e}), using raw text as report")
            return {
                "suggested_analyses": [],
                "visualizations": [],
                "investigations": [],
                "alerts": [],
                "data_landscape": {"source_summary": "See full report for details"},
                "relationships": [],
                "full_report": raw_text,
            }

    except Exception as e:
        logger.error(f"[intel] Generation failed for session {session_id[:8]}...: {e}")
        import traceback
        logger.error(traceback.format_exc())

    return None


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
    logger.info(f"[intel] Saved to s3://{bucket}/{s3_key}")
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


def generate_intel_async(session_id: str, vm_manager, bucket: str, storage):
    """
    Generate intel in a background thread using the AI agent.
    Non-blocking — returns immediately.
    """
    def _worker():
        logger.info(f"[intel] Starting agent-based generation for session {session_id[:8]}...")
        start = time.time()
        intel_data = generate_intel(session_id, vm_manager)
        elapsed = time.time() - start
        if intel_data:
            s3_key = save_intel_to_s3(session_id, intel_data, bucket)
            try:
                storage.workbook_intel_save(session_id, s3_key)
            except Exception as e:
                logger.warning(f"[intel] Failed to save metadata to DB: {e}")
            logger.info(f"[intel] Complete for session {session_id[:8]}... ({elapsed:.1f}s)")
        else:
            logger.warning(f"[intel] No intel generated for session {session_id[:8]}... ({elapsed:.1f}s)")

    thread = threading.Thread(target=_worker, daemon=True, name=f"intel-{session_id[:8]}")
    thread.start()
    return thread
