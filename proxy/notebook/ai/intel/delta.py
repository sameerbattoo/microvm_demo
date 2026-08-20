"""
Incremental (delta) + deletion updates for Workbook Intelligence.

Part of: proxy.notebook.ai.intel

When a workbook already has an intel report and a single local file is added or
removed, these paths avoid the full agent-with-tools loop: a single STREAMED
Bedrock call returns only the small JSON patch (new items to append, or keys to
prune), which Python merges into / prunes from the existing report.
"""

import os
import json
import logging

from batch.entity_discovery import discover_all_local_files, get_entity_doc_markdown
from ..constants import INTEL_MODEL_ID
from .parsing import _extract_intel_json, _extract_json_object
from .context import _fetch_relevant_entity_docs

logger = logging.getLogger(__name__)

PROXY_PORT = int(os.environ.get("PROXY_PORT", "8081"))
AWS_REGION = os.environ.get("AWS_REGION", "us-west-2")


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
    from ..prompts import INTEL_INCREMENTAL_PROMPT
    from ..constants import (
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
        from ..constants import BEDROCK_MAX_RETRIES, BEDROCK_READ_TIMEOUT, BEDROCK_CONNECT_TIMEOUT

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
    from ..prompts import INTEL_DELETION_PROMPT
    from ..constants import (
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
