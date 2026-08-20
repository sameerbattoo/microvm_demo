"""
Workbook Intelligence — AI-generated data insights using the notebook agent.

Part of: proxy.notebook.ai

This package splits the former single-file `workbook_intel.py` into cohesive
modules while preserving the exact public API (re-exported below). Callers can
import from either `proxy.notebook.ai.workbook_intel` (facade) or this package.

Modules:
  - parsing   : robust JSON extraction from model/agent responses
  - store     : in-memory generation-state registry + S3 read/write
  - context   : precomputed entity-doc gathering for the intel prompt
  - delta     : incremental (file added) + deletion (file removed) updates
  - generate  : full agent-with-tools generation + background orchestrator

Storage: S3 (sessions/{session_id}/workbook-intel.json)
Metadata: SQLite (workbook_intel table)

Triggers:
  1. Auto: Frontend triggers after catalog discovery completes
  2. Manual: User clicks "Refresh" in the UI
"""

from .parsing import (
    _extract_intel_json,
    _looks_like_intel,
    _strip_code_fences,
    _extract_json_object,
)
from .store import (
    is_generating,
    get_generating_trigger,
    _mark_generating_start,
    _mark_generating_done,
    save_intel_to_s3,
    load_intel_from_s3,
    _generating_lock,
    _generating_sessions,
)
from .context import (
    _fetch_session_catalog,
    _fetch_relevant_entity_docs,
)
from .delta import (
    _summarize_existing_intel,
    _dedup_key,
    _merge_delta_into_intel,
    _remove_from_intel,
    generate_intel_incremental,
    generate_intel_deletion,
)
from .generate import (
    generate_intel,
    generate_full_report,
    generate_intel_async,
)

__all__ = [
    # generation
    "generate_intel",
    "generate_full_report",
    "generate_intel_async",
    "generate_intel_incremental",
    "generate_intel_deletion",
    # state
    "is_generating",
    "get_generating_trigger",
    # storage
    "save_intel_to_s3",
    "load_intel_from_s3",
    # context
    "_fetch_relevant_entity_docs",
    "_fetch_session_catalog",
    # parsing
    "_extract_intel_json",
    "_extract_json_object",
    "_looks_like_intel",
    "_strip_code_fences",
]
