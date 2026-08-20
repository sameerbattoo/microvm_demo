"""
Full-generation pipeline + background orchestrator for Workbook Intelligence.

Part of: proxy.notebook.ai.intel

  - generate_intel: the dedicated agent-with-tools loop (Phase 1 — structured
    arrays), plus generate_full_report (Phase 2 — the prose full_report).
  - generate_intel_async: the non-blocking entry point that picks the right path
    (full / incremental / deletion) and runs it in a background thread.
"""

import os
import json
import time
import uuid
import logging
import threading

import boto3

from ..prompts import INTEL_PROMPT, INTEL_REPORT_PROMPT
from ..notebook_agent import set_execution_context, get_or_create_agent, AgentTraceCallbackHandler, _get_direct_client
from ..constants import INTEL_MODEL_ID, AGENT_TEMPERATURE, AGENT_MAX_TOKENS
from batch.entity_discovery import discover_all_local_files

from .parsing import _extract_intel_json, _looks_like_intel, _extract_json_object
from .context import _fetch_relevant_entity_docs
from .store import (
    save_intel_to_s3,
    load_intel_from_s3,
    is_generating,
    _mark_generating_start,
    _mark_generating_done,
)
from .delta import generate_intel_incremental, generate_intel_deletion

logger = logging.getLogger(__name__)

PROXY_PORT = int(os.environ.get("PROXY_PORT", "8081"))
AWS_REGION = os.environ.get("AWS_REGION", "us-west-2")


def generate_intel(session_id: str, vm_manager, bucket: str, storage) -> dict | None:
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
    proxy_url = f"http://localhost:{PROXY_PORT}"

    try:
        # Ensure every local /tmp file in this session has an up-to-date profile
        # doc before we read them — this is the "notebook-level per-local-file
        # discovery" step. Cheap no-op if nothing changed (see entity_discovery.py).
        # NOTE: this is the main cost between "Initiating COMPLETE" and "Invoking agent" —
        # each newly-uploaded local file is profiled on the VM + gets an LLM-generated doc.
        _t0 = time.time()
        try:
            local_summary = discover_all_local_files(session_id, proxy_url, bucket, AWS_REGION, storage)
            if local_summary["total"] > 0:
                logger.info(f"[intel]    → Local file discovery for session {session_id[:8]}...: "
                           f"{local_summary['discovered']} discovered, "
                           f"{local_summary['skipped_unchanged']} unchanged, "
                           f"{local_summary['errors']} errors "
                           f"({time.time() - _t0:.1f}s)")
        except Exception as e:
            logger.warning(f"[intel] Local file discovery failed for session {session_id[:8]}...: {e}")

        # Pull every pre-computed entity profile relevant to this session (global
        # sources from Phase 1 discovery + the local files just ensured above)
        _t1 = time.time()
        entity_docs = _fetch_relevant_entity_docs(session_id, proxy_url, bucket, storage)
        logger.info(f"[intel]    → Fetched entity profiles ({len(entity_docs)} chars) in {time.time() - _t1:.1f}s; "
                    f"pre-agent prep total {time.time() - _t0:.1f}s")

        # Build context for the agent tools
        context = {
            "proxy_url": proxy_url,
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

        # Create a brand new agent (unique ID = never conflicts with user's chat).
        # Attach a tracing callback so we can see the agent's tool calls / inputs /
        # results step by step (COMPLETE flow only — the interactive chat agent stays silent).
        tracer = AgentTraceCallbackHandler(log_prefix=f"[intel] {session_id[:8]}")

        # Create a dedicated intel agent using INTEL_MODEL_ID (Haiku) — separate from the
        # user's chat agent (Sonnet). Uses prompt caching for the multi-turn tool loop.
        from strands import Agent
        from strands.models import BedrockModel
        from strands.models.bedrock import CacheConfig
        from strands.agent.conversation_manager import SlidingWindowConversationManager

        intel_model = BedrockModel(
            model_id=os.environ.get("INTEL_MODEL_ID", INTEL_MODEL_ID),
            region_name=AWS_REGION,
            temperature=AGENT_TEMPERATURE,
            max_tokens=AGENT_MAX_TOKENS,
            cache_config=CacheConfig(strategy="auto"),
            cache_tools="default",
        )

        from datetime import datetime as _dt, timezone as _tz
        _now = _dt.now(_tz.utc)
        from ..prompts import NOTEBOOK_AGENT_PROMPT
        _system_prompt = NOTEBOOK_AGENT_PROMPT.format(
            current_time=_now.strftime("%Y-%m-%d %H:%M UTC (%A)"),
            aws_region=AWS_REGION,
            memory_tier=f"{context.get('memory_mib', 2048)} MB",
            athena_workgroup=os.environ.get("ATHENA_WORKGROUP", "microvm-demo"),
            athena_db=os.environ.get("ATHENA_DB", "microvm_demo_db"),
            s3_bucket=os.environ.get("ARTIFACT_BUCKET", "unknown"),
            dynamo_table_prefix=os.environ.get("DYNAMO_TABLE", "microvm-demo").rsplit("-", 1)[0] + "-",
        )

        from ..tools.execution_tools import (
            execute_code, get_variables, get_notebook_state, install_package, get_available_data_sources
        )
        agent = Agent(
            model=intel_model,
            system_prompt=_system_prompt,
            tools=[execute_code, get_variables, get_notebook_state, install_package, get_available_data_sources],
            conversation_manager=SlidingWindowConversationManager(window_size=10),
            callback_handler=tracer,
        )

        # Send the intel prompt
        logger.info(f"[intel]    → Invoking analysis agent for session {session_id[:8]}... (dedicated agent: {intel_session_id[:20]}...)")

        agent_start = time.time()
        result = agent(INTEL_PROMPT.format(
            entity_docs=entity_docs,
            catalog_json="[Call get_available_data_sources tool if you need anything not already covered above]",
            notebook_state="[Call get_variables tool to see current namespace state]",
            variables="[Use execute_code SPARINGLY — only for cross-source verification or sources not covered above]",
        ))

        raw_text = str(result).strip()
        logger.info(f"[intel]    → Agent finished in {time.time() - agent_start:.1f}s "
                    f"({tracer.tool_count} tool call(s)); response {len(raw_text)} chars")

        intel_data = _extract_intel_json(raw_text)
        if intel_data:
            logger.info(f"[intel]    → Parsed structured intel: "
                       f"{len(intel_data.get('suggested_analyses', []))} analyses, "
                       f"{len(intel_data.get('alerts', []))} alerts")
            # Phase 1 complete — structured arrays are ready (no full_report yet)
            intel_data["report_status"] = "generating"
            return intel_data, entity_docs
        else:
            # Final fallback: wrap entire response as a narrative full_report
            logger.warning(f"[intel] All JSON extraction strategies failed — using raw text as report")
            return {
                "suggested_analyses": [],
                "visualizations": [],
                "investigations": [],
                "alerts": [],
                "data_landscape": {"source_summary": "See full report for details"},
                "relationships": [],
                "full_report": raw_text[:8000],
                "report_status": "ready",
            }, entity_docs

    except Exception as e:
        logger.error(f"[intel] Generation failed for session {session_id[:8]}...: {e}")
        import traceback
        logger.error(traceback.format_exc())

    return None, None


def generate_full_report(session_id: str, intel_data: dict, entity_docs: str, bucket: str, storage) -> None:
    """
    Phase 2: Generate the full_report markdown + enrich structured arrays with
    prompt/action/join_suggestion fields.
    
    Single-shot Bedrock call (no tools, no agent loop). Runs in background after
    Phase 1 results are already saved and visible to the user.
    Updates the existing S3 intel JSON with enriched data + sets report_status='ready'.
    """
    from ..constants import AGENT_MAX_TOKENS
    
    _t0 = time.time()
    try:
        # Build a compact representation of Phase 1 findings for the report prompt
        structured_findings = json.dumps({
            "suggested_analyses": intel_data.get("suggested_analyses", []),
            "visualizations": intel_data.get("visualizations", []),
            "investigations": intel_data.get("investigations", []),
            "alerts": intel_data.get("alerts", []),
            "data_landscape": intel_data.get("data_landscape", {}),
            "relationships": intel_data.get("relationships", []),
        }, indent=2)

        prompt_text = INTEL_REPORT_PROMPT.format(
            entity_docs=entity_docs,
            structured_findings=structured_findings,
        )

        # Single-shot Bedrock converse call (no agent, no tools)
        client = _get_direct_client()
        response = client.converse(
            modelId=os.environ.get("INTEL_MODEL_ID", INTEL_MODEL_ID),
            messages=[{"role": "user", "content": [{"text": prompt_text}]}],
            inferenceConfig={"maxTokens": AGENT_MAX_TOKENS, "temperature": 0.2},
        )

        raw_text = response["output"]["message"]["content"][0]["text"].strip()
        logger.info(f"[intel]    → Phase 2 response in {time.time() - _t0:.1f}s ({len(raw_text)} chars)")

        # Parse the Phase 2 JSON (enriched arrays + full_report)
        phase2_data = _extract_intel_json(raw_text) if _looks_like_intel != None else None
        # Try direct JSON parse first, then extraction
        try:
            phase2_data = json.loads(raw_text)
        except (json.JSONDecodeError, ValueError):
            # Try extracting from markdown fences or preamble
            phase2_data = _extract_json_object(raw_text)

        if phase2_data and isinstance(phase2_data, dict):
            # Merge Phase 2 results: relationships + full_report
            if phase2_data.get("relationships"):
                intel_data["relationships"] = phase2_data["relationships"]
            if phase2_data.get("full_report"):
                intel_data["full_report"] = phase2_data["full_report"]
            else:
                intel_data["full_report"] = ""
        else:
            # Fallback: treat the entire response as the full_report markdown
            logger.warning(f"[intel] Phase 2 JSON parse failed — using raw text as full_report")
            intel_data["full_report"] = raw_text[:15000]

        intel_data["report_status"] = "ready"

        # Re-save to S3
        save_intel_to_s3(session_id, intel_data, bucket)
        logger.info(f"[intel]    → Phase 2 complete for session {session_id[:8]}... "
                    f"(full_report: {len(intel_data.get('full_report', ''))} chars)")

    except Exception as e:
        logger.error(f"[intel] Phase 2 (full_report) failed for session {session_id[:8]}...: {e}")
        # Mark as ready anyway (user just won't get the prose report)
        intel_data["report_status"] = "ready"
        intel_data["full_report"] = ""
        try:
            save_intel_to_s3(session_id, intel_data, bucket)
        except Exception:
            pass


def generate_intel_async(session_id: str, vm_manager, bucket: str, storage, trigger: str = "manual",
                         deleted_source: str = None) -> bool:
    """
    Generate intel in a background thread using the AI agent.
    Non-blocking — returns immediately.

    If trigger is "file_upload" and intel already exists for this session,
    uses the faster incremental path (single LLM call, no tool loop).
    Otherwise falls back to the full generation pipeline.

    Returns True if a new generation was started, False if one was already
    in progress for this session (in which case no duplicate thread is spawned —
    the caller should just let the existing generation finish).
    """
    if is_generating(session_id):
        logger.info(f"[intel] Generation already in progress for session {session_id[:8]}... — skipping duplicate request")
        return False

    _mark_generating_start(session_id, trigger=trigger)

    def _worker():
        start = time.time()
        entity_docs_for_report = None  # Only set by the COMPLETE path (Phase 1)
        try:
            intel_data = None

            # Deletion path: a local file was removed. If intel exists, prune everything
            # tied to that file (removal delta). If no intel exists, there's nothing to
            # prune — skip entirely (don't do a full regen just because a file was deleted).
            if trigger == "file_delete":
                existing_meta = storage.workbook_intel_get(session_id)
                if existing_meta and existing_meta.get("s3_key"):
                    existing_intel = load_intel_from_s3(session_id, bucket)
                    if existing_intel:
                        logger.info(f"[intel] ▶ Initiating DELETION Notebook Intel for session {session_id[:8]}... "
                                    f"(trigger=file_delete, source='{os.path.basename(deleted_source) if deleted_source else '?'}')")
                        intel_data = generate_intel_deletion(session_id, bucket, storage, existing_intel, deleted_source)
                if not intel_data:
                    # Either there was no existing report to prune, or the deletion pass
                    # produced no usable result. Either way, do NOT fall through to a full
                    # regen for a deletion — leave the current report as-is.
                    logger.info(f"[intel] Deletion trigger for session {session_id[:8]}...: nothing pruned — leaving report unchanged")
                    return

            # Incremental path: if this is a file_upload trigger and intel already exists,
            # just update the existing report with the new file info (much faster)
            if not intel_data and trigger == "file_upload":
                existing_meta = storage.workbook_intel_get(session_id)
                if existing_meta and existing_meta.get("s3_key"):
                    existing_intel = load_intel_from_s3(session_id, bucket)
                    if existing_intel:
                        logger.info(f"[intel] ▶ Initiating DELTA Notebook Intel for session {session_id[:8]}... (trigger=file_upload, existing intel found — incremental update)")
                        intel_data = generate_intel_incremental(session_id, vm_manager, bucket, storage, existing_intel)

            # Full path: either no existing intel, or non-file-upload trigger, or incremental failed.
            # (A file_delete that reached here already returned above, so it never does a full regen.)
            if not intel_data:
                logger.info(f"[intel] ▶ Initiating COMPLETE Notebook Intel for session {session_id[:8]}... (trigger={trigger})")
                intel_data, entity_docs_for_report = generate_intel(session_id, vm_manager, bucket, storage)

            elapsed = time.time() - start
            if intel_data:
                s3_key = save_intel_to_s3(session_id, intel_data, bucket)
                try:
                    storage.workbook_intel_save(session_id, s3_key)
                except Exception as e:
                    logger.warning(f"[intel] Failed to save metadata to DB: {e}")

                # If Phase 1 returned without a full_report, kick off Phase 2 in-thread
                # (we're already in a background thread, so just continue sequentially)
                if intel_data.get("report_status") == "generating" and entity_docs_for_report:
                    # Mark generating DONE so frontend sees Phase 1 content immediately
                    _mark_generating_done(session_id)
                    logger.info(f"[intel]    → Phase 1 complete ({elapsed:.1f}s). Starting Phase 2 (full_report)...")
                    generate_full_report(session_id, intel_data, entity_docs_for_report, bucket, storage)
                    elapsed = time.time() - start

                logger.info(f"[intel] Complete for session {session_id[:8]}... ({elapsed:.1f}s)")
            else:
                logger.warning(f"[intel] No intel generated for session {session_id[:8]}... ({elapsed:.1f}s)")
        finally:
            _mark_generating_done(session_id)

    thread = threading.Thread(target=_worker, daemon=True, name=f"intel-{session_id[:8]}")
    thread.start()
    return True
