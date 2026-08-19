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
import httpx

from .prompts import INTEL_PROMPT, INTEL_REPORT_PROMPT
from .notebook_agent import set_execution_context, get_or_create_agent, AgentTraceCallbackHandler, _get_direct_client
from .constants import INTEL_MODEL_ID, AGENT_TEMPERATURE, AGENT_MAX_TOKENS
from batch.entity_discovery import discover_all_local_files, get_entity_doc_markdown

logger = logging.getLogger(__name__)

PROXY_PORT = int(os.environ.get("PROXY_PORT", "8081"))
AWS_REGION = os.environ.get("AWS_REGION", "us-west-2")

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


def _extract_intel_json(raw_text: str) -> dict | None:
    """
    Robustly extract the structured intel JSON object from an agent response
    that may contain markdown fences, preamble text, trailing prose, ASCII art
    diagrams (which contain braces), or other noise.

    Strategy (tried in order, first success wins):
      1. Whole text is valid JSON — parse directly.
      2. Strip markdown code fences (```json ... ``` or ``` ... ```) and parse.
      3. Find the outermost balanced {…} that contains at least one expected
         key ("suggested_analyses", "full_report", etc.) — this handles
         preamble + trailing prose and is resilient to nested braces inside
         string values (the JSON spec guarantees that braces inside quoted
         strings don't break a compliant decoder).
      4. Regex for a ```json code block anywhere in the text.
      5. Give up → return None so the caller can fall back to raw-text mode.
    """
    if not raw_text or not raw_text.strip():
        return None

    text = raw_text.strip()

    # --- Strategy 1: raw text IS valid JSON ---
    try:
        d = json.loads(text)
        if isinstance(d, dict) and _looks_like_intel(d):
            return d
    except (json.JSONDecodeError, ValueError):
        pass

    # --- Strategy 2: strip markdown code fences ---
    stripped = _strip_code_fences(text)
    if stripped != text:
        try:
            d = json.loads(stripped)
            if isinstance(d, dict) and _looks_like_intel(d):
                return d
        except (json.JSONDecodeError, ValueError):
            pass

    # --- Strategy 3: find outermost balanced {…} containing expected keys ---
    # Scan for every '{' at a potential JSON-object start and try to parse
    # from that position. json.JSONDecoder.raw_decode is ideal here: it
    # returns (object, end_index) and ignores trailing garbage after the
    # closing brace. We iterate through potential start positions from the
    # beginning of the text, trying each one.
    import re as _re
    decoder = json.JSONDecoder()
    # Find all positions where '{' appears that could start our object
    # (skip { inside quoted strings by looking for "suggested_analyses" near
    # each candidate — a quick heuristic filter to avoid parsing every { in
    # a 26K response)
    for match in _re.finditer(r'\{', text):
        start = match.start()
        # Quick filter: the next 200 chars should contain one of our expected keys
        snippet = text[start:start + 200]
        if not any(k in snippet for k in ('"suggested_analyses"', '"full_report"', '"data_landscape"', '"alerts"')):
            continue
        try:
            obj, end = decoder.raw_decode(text, start)
            if isinstance(obj, dict) and _looks_like_intel(obj):
                return obj
        except (json.JSONDecodeError, ValueError):
            continue

    # --- Strategy 4: regex for ```json block anywhere ---
    fence_match = _re.search(r'```json\s*\n(.*?)```', text, _re.DOTALL)
    if fence_match:
        try:
            d = json.loads(fence_match.group(1).strip())
            if isinstance(d, dict) and _looks_like_intel(d):
                return d
        except (json.JSONDecodeError, ValueError):
            pass

    # --- All strategies exhausted ---
    logger.warning("[intel] Could not extract valid JSON from agent response "
                   f"({len(text)} chars, first 120: {text[:120]!r})")
    return None


def _looks_like_intel(d: dict) -> bool:
    """Does this dict look like a valid intel report? (has at least 2 expected top-level keys)"""
    expected = {"suggested_analyses", "visualizations", "investigations", "alerts", "full_report", "data_landscape", "relationships"}
    return len(expected.intersection(d.keys())) >= 2


def _strip_code_fences(text: str) -> str:
    """Remove the outermost markdown code fence if present."""
    if "```json" in text:
        parts = text.split("```json", 1)
        if "```" in parts[1]:
            return parts[1].split("```", 1)[0].strip()
    if text.startswith("```"):
        lines = text.split("\n")
        if lines[-1].strip() == "```":
            inner = "\n".join(lines[1:-1])
            if inner.startswith("json"):
                inner = inner[4:]
            return inner.strip()
    return text


def _extract_json_object(raw_text: str) -> dict | None:
    """Parse the first balanced JSON object from a model response — WITHOUT the
    intel-report shape check. Used for responses that are valid JSON but not intel
    reports (e.g. the deletion/removal response with remove_* keys). Handles raw JSON,
    markdown-fenced JSON, and trailing prose after the closing brace.
    """
    if not raw_text or not raw_text.strip():
        return None
    text = raw_text.strip()

    for candidate in (text, _strip_code_fences(text)):
        try:
            d = json.loads(candidate)
            if isinstance(d, dict):
                return d
        except (json.JSONDecodeError, ValueError):
            pass

    # Fallback: decode from the first '{' and ignore any trailing garbage.
    decoder = json.JSONDecoder()
    brace = text.find("{")
    while brace != -1:
        try:
            obj, _ = decoder.raw_decode(text, brace)
            if isinstance(obj, dict):
                return obj
        except (json.JSONDecodeError, ValueError):
            pass
        brace = text.find("{", brace + 1)
    return None


def _fetch_session_catalog(proxy_url: str, session_id: str) -> list[dict]:
    """Fetch this session's VM data catalog entries (all source types)."""
    try:
        resp = httpx.get(
            f"{proxy_url}/datasources/catalog",
            headers={"X-Session-Id": session_id},
            timeout=10.0,
        )
        if resp.status_code == 200:
            return resp.json().get("entries", [])
    except Exception as e:
        logger.warning(f"[intel] Failed to fetch catalog for session {session_id[:8]}...: {e}")
    return []


def _fetch_relevant_entity_docs(session_id: str, proxy_url: str, bucket: str, storage) -> str:
    """
    Pull the pre-computed markdown profile for every data source known to this
    session (global entities from proxy.notebook.ai.entity_discovery's Phase 1,
    plus local files already profiled this session), and concatenate them for
    the INTEL_PROMPT's precomputed_entity_profiles section.

    Entities without a ready doc yet (never discovered, or discovery failed)
    are simply omitted — the agent's own execute_code/get_available_data_sources
    tools remain the fallback for anything not covered here.
    """
    entries = _fetch_session_catalog(proxy_url, session_id)
    if not entries:
        return "(No precomputed profiles available — this session's data catalog hasn't finished discovery yet. Use get_available_data_sources and execute_code as usual.)"

    sections = []
    for entry in entries:
        source_type = entry.get("source_type")
        source_id = entry.get("source_id", "")
        if not source_id:
            continue
        is_local = source_type == "local"
        doc = get_entity_doc_markdown(
            source_id, bucket, AWS_REGION, storage,
            session_id=session_id if is_local else None,
        )
        if doc:
            sections.append(doc.strip())

    if not sections:
        return "(No precomputed profiles are ready yet for this session's sources. Use get_available_data_sources and execute_code as usual.)"

    return "\n\n---\n\n".join(sections)


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
        from .prompts import NOTEBOOK_AGENT_PROMPT
        _system_prompt = NOTEBOOK_AGENT_PROMPT.format(
            current_time=_now.strftime("%Y-%m-%d %H:%M UTC (%A)"),
            aws_region=AWS_REGION,
            memory_tier=f"{context.get('memory_mib', 2048)} MB",
            athena_workgroup=os.environ.get("ATHENA_WORKGROUP", "microvm-demo"),
            athena_db=os.environ.get("ATHENA_DB", "microvm_demo_db"),
            s3_bucket=os.environ.get("ARTIFACT_BUCKET", "unknown"),
            dynamo_table_prefix=os.environ.get("DYNAMO_TABLE", "microvm-demo").rsplit("-", 1)[0] + "-",
        )

        from .tools.execution_tools import (
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


def generate_full_report(session_id: str, intel_data: dict, entity_docs: str, bucket: str, storage) -> None:
    """
    Phase 2: Generate the full_report markdown + enrich structured arrays with
    prompt/action/join_suggestion fields.
    
    Single-shot Bedrock call (no tools, no agent loop). Runs in background after
    Phase 1 results are already saved and visible to the user.
    Updates the existing S3 intel JSON with enriched data + sets report_status='ready'.
    """
    from .constants import AGENT_MAX_TOKENS
    
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


# ============================================================
# Incremental (delta) helpers
# ============================================================

def _summarize_existing_intel(existing: dict) -> str:
    """Build a COMPACT text summary of the existing report for the delta prompt.

    Lists just the identifying text of each existing item (titles / alert messages /
    relationship endpoints) so the model knows what's already covered and returns only
    genuinely new items. Deliberately omits full_report and prompts to keep tokens low.
    """
    lines = []

    def _add(header, items, fmt):
        if not items:
            return
        lines.append(header)
        for it in items:
            try:
                lines.append("  - " + fmt(it))
            except Exception:
                continue

    _add("EXISTING ANALYSES:", existing.get("suggested_analyses", []),
         lambda x: str(x.get("title", "")))
    _add("EXISTING VISUALIZATIONS:", existing.get("visualizations", []),
         lambda x: str(x.get("title", "")))
    _add("EXISTING INVESTIGATIONS:", existing.get("investigations", []),
         lambda x: str(x.get("title", "")))
    _add("EXISTING ALERTS:", existing.get("alerts", []),
         lambda x: f"[{x.get('type','')}/{x.get('severity','')}] {x.get('message','')}")
    _add("EXISTING RELATIONSHIPS:", existing.get("relationships", []),
         lambda x: f"{x.get('from_source','')}.{x.get('from_column','')} -> {x.get('to_source','')}.{x.get('to_column','')}")

    return "\n".join(lines) if lines else "(existing report is empty)"


def _dedup_key(kind: str, item: dict) -> tuple:
    """Stable content-based key for dedup (no id field exists on items)."""
    def norm(s):
        return str(s or "").strip().lower()
    if kind == "alerts":
        return (norm(item.get("type")), norm(item.get("message")))
    if kind == "relationships":
        return (norm(item.get("from_source")), norm(item.get("from_column")),
                norm(item.get("to_source")), norm(item.get("to_column")))
    # analyses / visualizations / investigations keyed on title
    return (norm(item.get("title")),)


def _merge_delta_into_intel(existing: dict, delta: dict, new_source_ids: list) -> dict:
    """Merge the delta's NEW items into the existing report, appending (with dedup).

    - Existing items are preserved and kept first (stable order for the UI).
    - New items are appended after them, skipping any that duplicate existing content.
    - data_landscape.total_sources is bumped by the number of new sources.
    - delta_summary is appended to full_report under a "Recent additions" section.
    """
    merged = dict(existing) if existing else {}

    ARRAY_KEYS = ["suggested_analyses", "visualizations", "investigations", "alerts", "relationships"]
    for key in ARRAY_KEYS:
        existing_items = list(existing.get(key, []) or []) if existing else []
        seen = {_dedup_key(key, it) for it in existing_items}
        appended = []
        for it in (delta.get(key, []) or []):
            if not isinstance(it, dict):
                continue
            k = _dedup_key(key, it)
            if k in seen:
                continue
            seen.add(k)
            appended.append(it)
        merged[key] = existing_items + appended

    # Bump source count for any genuinely new sources
    landscape = dict(existing.get("data_landscape", {}) or {}) if existing else {}
    if new_source_ids:
        try:
            landscape["total_sources"] = int(landscape.get("total_sources", 0) or 0) + len(new_source_ids)
        except (TypeError, ValueError):
            pass
    merged["data_landscape"] = landscape

    # Append the delta narrative to the existing full_report (don't regenerate it)
    delta_summary = (delta.get("delta_summary") or "").strip()
    if delta_summary:
        label = delta.get("new_source_label") or (
            os.path.basename(new_source_ids[0]) if new_source_ids else "new file")
        addition = f"\n\n## Recent additions — {label}\n\n{delta_summary}\n"
        merged["full_report"] = (existing.get("full_report", "") or "") + addition if existing else delta_summary

    return merged


def _remove_from_intel(existing: dict, removal: dict, deleted_label: str) -> dict:
    """Prune items flagged for removal (because their data source was deleted).

    The LLM returns identifying keys of items to drop (titles for analyses/viz/
    investigations; type+message for alerts; endpoints for relationships). We match
    those against the existing report using the same content-based keys as dedup and
    keep everything else. Also decrements total_sources and appends a deletion note.
    """
    def norm(s):
        return str(s or "").strip().lower()

    pruned = dict(existing) if existing else {}

    # Build the set of keys to remove per array, from the LLM's removal list.
    removal_specs = [
        ("suggested_analyses", "remove_analyses", lambda t: (norm(t),)),
        ("visualizations", "remove_visualizations", lambda t: (norm(t),)),
        ("investigations", "remove_investigations", lambda t: (norm(t),)),
        ("alerts", "remove_alerts", lambda o: (norm(o.get("type")), norm(o.get("message"))) if isinstance(o, dict) else (norm(o),)),
        ("relationships", "remove_relationships",
         lambda o: (norm(o.get("from_source")), norm(o.get("from_column")),
                    norm(o.get("to_source")), norm(o.get("to_column"))) if isinstance(o, dict) else (norm(o),)),
    ]

    total_removed = 0
    for array_key, removal_key, key_fn in removal_specs:
        to_remove = set()
        for entry in (removal.get(removal_key, []) or []):
            try:
                to_remove.add(key_fn(entry))
            except Exception:
                continue
        if not to_remove:
            continue
        kept = []
        for it in (existing.get(array_key, []) or []) if existing else []:
            if _dedup_key(array_key, it) in to_remove:
                total_removed += 1
                continue
            kept.append(it)
        pruned[array_key] = kept

    # Decrement source count (floor at 0)
    landscape = dict(existing.get("data_landscape", {}) or {}) if existing else {}
    try:
        landscape["total_sources"] = max(0, int(landscape.get("total_sources", 0) or 0) - 1)
    except (TypeError, ValueError):
        pass
    pruned["data_landscape"] = landscape

    # Append the deletion narrative to full_report
    deletion_summary = (removal.get("deletion_summary") or "").strip()
    if deletion_summary:
        addition = f"\n\n## Removed source — {deleted_label}\n\n{deletion_summary}\n"
        pruned["full_report"] = (existing.get("full_report", "") or "") + addition if existing else deletion_summary

    pruned["_last_removed_count"] = total_removed  # transient hint for logging (not rendered)
    return pruned


def generate_intel_incremental(session_id: str, vm_manager, bucket: str, storage, existing_intel: dict) -> dict | None:
    """
    Fast incremental intel update — used when a file is uploaded to a workbook
    that already has an intel report. Instead of the full agent-with-tools loop,
    this:
      1. Discovers any new/changed local files (creates their entity docs)
      2. Fetches the new file's profile + entity summaries for join context
      3. Makes a single STREAMED Bedrock call that returns ONLY the new delta items
         (a small JSON patch — not the whole report)
      4. Merges the delta into the existing report (append + dedup) and returns it

    Returning only the delta keeps the model output tiny, so this completes in a few
    seconds and can never hang on a read timeout the way regenerating the full report did.
    """
    from .prompts import INTEL_INCREMENTAL_PROMPT
    from .constants import (
        AGENT_TEMPERATURE,
        INTEL_DELTA_ENTITY_SUMMARIES_MAX_CHARS,
        INTEL_DELTA_NEW_FILE_DOC_MAX_CHARS,
        INTEL_DELTA_EXISTING_SUMMARY_MAX_CHARS,
    )

    session_vm = vm_manager.get_session_vm(session_id)
    if not session_vm:
        logger.warning(f"[intel]    → No VM found for session {session_id[:8]}... (delta)")
        return None

    proxy_url = f"http://localhost:{PROXY_PORT}"

    try:
        # Step 1: Discover any new local files (quick — skips unchanged ones).
        # Capture the source_ids that were actually (re)discovered this pass — these
        # are the file(s) the user just uploaded and are what the delta must focus on.
        new_source_ids = []
        try:
            local_summary = discover_all_local_files(session_id, proxy_url, bucket, AWS_REGION, storage)
            new_source_ids = [
                r["source_id"] for r in local_summary.get("results", [])
                if r.get("status") == "discovered" and r.get("source_id")
            ]
            if local_summary["discovered"] > 0:
                logger.info(f"[intel]    → Discovered {local_summary['discovered']} new local file(s) for delta: "
                            f"{', '.join(os.path.basename(s) for s in new_source_ids)}")
        except Exception as e:
            logger.warning(f"[intel]    → Local file discovery failed: {e}")

        # Step 2: Fetch entity summaries (global + local) for the full-context section.
        logger.info(f"[intel]    → [delta] fetching entity summaries...")
        entity_docs = _fetch_relevant_entity_docs(session_id, proxy_url, bucket, storage)
        logger.info(f"[intel]    → [delta] entity summaries fetched ({len(entity_docs)} chars)")

        # Step 2b: Fetch the doc(s) for the newly-uploaded file(s) SPECIFICALLY, so the
        # delta prompt highlights them rather than a truncated slice of the (global-first)
        # concatenated docs — which previously dropped the new file entirely.
        new_file_sections = []
        for sid in new_source_ids:
            doc = get_entity_doc_markdown(sid, bucket, AWS_REGION, storage, session_id=session_id)
            if doc:
                new_file_sections.append(doc.strip())
        new_file_doc = "\n\n---\n\n".join(new_file_sections)
        logger.info(f"[intel]    → [delta] new-file doc assembled ({len(new_file_doc)} chars)")
        if not new_file_doc:
            # No freshly-discovered doc resolved (e.g. discovery skipped as unchanged).
            # Fall back to a clear note so the model doesn't silently ignore the trigger.
            new_file_doc = ("(No distinct new-file profile resolved for this update. Re-examine the "
                            "entity summaries below for any source not already reflected in the existing report.)")
            logger.warning(f"[intel]    → No new-file doc resolved for delta (new_source_ids={new_source_ids})")

        # Step 3: Single Bedrock call — no agent, no tools
        import boto3
        from botocore.config import Config
        from .constants import BEDROCK_MAX_RETRIES, BEDROCK_READ_TIMEOUT, BEDROCK_CONNECT_TIMEOUT

        bedrock = boto3.client(
            "bedrock-runtime",
            region_name=AWS_REGION,
            config=Config(
                retries={"max_attempts": BEDROCK_MAX_RETRIES, "mode": "standard"},
                read_timeout=BEDROCK_READ_TIMEOUT,
                connect_timeout=BEDROCK_CONNECT_TIMEOUT,
            ),
        )

        model_id = os.environ.get("INTEL_MODEL_ID", INTEL_MODEL_ID)

        # Pass a COMPACT summary of the existing report (titles/messages only, no
        # full_report). This keeps the prompt small and tells the model what already
        # exists so it won't repeat it — the delta only needs to return NEW items.
        existing_summary = _summarize_existing_intel(existing_intel)

        # entity_summaries carries the "## Schema" tables of the OTHER sources — the model
        # needs these IN FULL to ground join suggestions in real column names (see COLUMN
        # GROUNDING rule in the prompt). The model supports ~1M input tokens, so we do NOT
        # tightly truncate — the caps below are generous SAFETY bounds against a pathological
        # runaway prompt, well above realistic content (~60K chars). Truncating schemas here
        # is exactly what previously caused hallucinated join column names.
        prompt = INTEL_INCREMENTAL_PROMPT.format(
            existing_report_json=existing_summary[:INTEL_DELTA_EXISTING_SUMMARY_MAX_CHARS],
            new_file_doc=new_file_doc[:INTEL_DELTA_NEW_FILE_DOC_MAX_CHARS],       # the newly-uploaded file's profile
            entity_summaries=entity_docs[:INTEL_DELTA_ENTITY_SUMMARIES_MAX_CHARS],  # all other sources' schemas
        )
        # Warn (don't silently drop) if any input actually hit its safety cap.
        if (len(existing_summary) > INTEL_DELTA_EXISTING_SUMMARY_MAX_CHARS
                or len(new_file_doc) > INTEL_DELTA_NEW_FILE_DOC_MAX_CHARS
                or len(entity_docs) > INTEL_DELTA_ENTITY_SUMMARIES_MAX_CHARS):
            logger.warning(
                f"[intel]    → [delta] an input exceeded its safety cap and was truncated "
                f"(existing={len(existing_summary)}, new_file={len(new_file_doc)}, summaries={len(entity_docs)})"
            )
        logger.info(f"[intel]    → [delta] invoking Bedrock ({model_id}, prompt={len(prompt)} chars)...")

        # Stream the response. The delta output is small, but streaming guarantees we
        # never block on a read timeout waiting for the whole body (the old non-stream
        # converse could hang for minutes when the model produced a large report).
        raw_parts = []
        stream_resp = bedrock.converse_stream(
            modelId=model_id,
            messages=[{"role": "user", "content": [{"text": prompt}]}],
            inferenceConfig={"maxTokens": 4096, "temperature": AGENT_TEMPERATURE},
        )
        for event in stream_resp["stream"]:
            if "contentBlockDelta" in event:
                raw_parts.append(event["contentBlockDelta"]["delta"].get("text", ""))
        raw_text = "".join(raw_parts).strip()
        logger.info(f"[intel]    → [delta] response received ({len(raw_text)} chars)")

        # Step 4: Parse the delta JSON, then MERGE it into the existing report.
        delta = _extract_intel_json(raw_text)
        if not delta:
            logger.warning(f"[intel]    → Delta JSON extraction failed — falling back to full generation")
            return None

        merged = _merge_delta_into_intel(existing_intel, delta, new_source_ids)
        n_new = (len(delta.get("suggested_analyses", [])) + len(delta.get("visualizations", []))
                 + len(delta.get("investigations", [])) + len(delta.get("alerts", []))
                 + len(delta.get("relationships", [])))
        logger.info(f"[intel]    → [delta] merged {n_new} new item(s); report now "
                    f"{len(merged.get('suggested_analyses', []))} analyses, "
                    f"{len(merged.get('alerts', []))} alerts")
        return merged

    except Exception as e:
        logger.error(f"[intel]    → Delta failed for session {session_id[:8]}...: {e}")
        import traceback
        logger.error(traceback.format_exc())
        return None


def generate_intel_deletion(session_id: str, bucket: str, storage, existing_intel: dict,
                            deleted_source: str) -> dict | None:
    """
    Removal delta — used when a local file is DELETED from a workbook that already has
    an intel report. Feeds the FULL existing report + the deleted file name to the model
    (single STREAMED call) and asks it to identify every item DIRECTLY or INDIRECTLY
    dependent on that file. The model returns only the identifying keys to remove; Python
    prunes them from the existing report and returns the updated (smaller) report.

    Fast + safe: small model output, no agent loop, can't hang on a read timeout.
    """
    from .prompts import INTEL_DELETION_PROMPT
    from .constants import (
        AGENT_TEMPERATURE,
        BEDROCK_MAX_RETRIES, BEDROCK_READ_TIMEOUT, BEDROCK_CONNECT_TIMEOUT,
        INTEL_DELTA_EXISTING_SUMMARY_MAX_CHARS,
    )

    deleted_label = os.path.basename(deleted_source) if deleted_source else (deleted_source or "deleted file")

    try:
        import boto3
        from botocore.config import Config

        bedrock = boto3.client(
            "bedrock-runtime",
            region_name=AWS_REGION,
            config=Config(
                retries={"max_attempts": BEDROCK_MAX_RETRIES, "mode": "standard"},
                read_timeout=BEDROCK_READ_TIMEOUT,
                connect_timeout=BEDROCK_CONNECT_TIMEOUT,
            ),
        )
        model_id = os.environ.get("INTEL_MODEL_ID", INTEL_MODEL_ID)

        # Pass the FULL existing report so the model can reason about indirect dependencies
        # (a large context is fine — the model supports ~1M tokens; the OUTPUT stays tiny).
        prompt = INTEL_DELETION_PROMPT.format(
            deleted_source_label=deleted_label,
            existing_report_json=json.dumps(existing_intel, indent=2, default=str)[:INTEL_DELTA_EXISTING_SUMMARY_MAX_CHARS],
        )
        logger.info(f"[intel]    → [deletion] invoking Bedrock ({model_id}, prompt={len(prompt)} chars) "
                    f"for deleted source '{deleted_label}'...")

        raw_parts = []
        stream_resp = bedrock.converse_stream(
            modelId=model_id,
            messages=[{"role": "user", "content": [{"text": prompt}]}],
            inferenceConfig={"maxTokens": 4096, "temperature": AGENT_TEMPERATURE},
        )
        for event in stream_resp["stream"]:
            if "contentBlockDelta" in event:
                raw_parts.append(event["contentBlockDelta"]["delta"].get("text", ""))
        raw_text = "".join(raw_parts).strip()
        logger.info(f"[intel]    → [deletion] response received ({len(raw_text)} chars)")

        removal = _extract_json_object(raw_text)
        if not removal:
            logger.warning(f"[intel]    → [deletion] JSON extraction failed — leaving report unchanged")
            return None

        pruned = _remove_from_intel(existing_intel, removal, deleted_label)
        removed = pruned.pop("_last_removed_count", 0)
        logger.info(f"[intel]    → [deletion] pruned {removed} item(s) tied to '{deleted_label}'; report now "
                    f"{len(pruned.get('suggested_analyses', []))} analyses, "
                    f"{len(pruned.get('alerts', []))} alerts")
        return pruned

    except Exception as e:
        logger.error(f"[intel]    → Deletion delta failed for session {session_id[:8]}...: {e}")
        import traceback
        logger.error(traceback.format_exc())
        return None


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
