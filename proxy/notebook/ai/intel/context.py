"""
Entity-doc context gathering for Workbook Intelligence.

Part of: proxy.notebook.ai.intel

Pulls the pre-computed markdown profile for every data source known to a
session (global entities from batch discovery + local files profiled this
session) into the text fed to the intel prompt.
"""

import os
import logging

import httpx

from batch.entity_discovery import get_entity_doc_markdown

logger = logging.getLogger(__name__)

AWS_REGION = os.environ.get("AWS_REGION", "us-west-2")


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
