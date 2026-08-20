"""
Workbook Intelligence — AI-generated data insights using the notebook agent.

Part of: proxy.notebook.ai

⚠️  FACADE MODULE.  The implementation now lives in the `intel/` package
    (proxy.notebook.ai.intel): parsing / store / context / delta / generate.
    This module re-exports the public API so existing imports keep working:

        from proxy.notebook.ai.workbook_intel import generate_intel_async, ...

    New code may import from `proxy.notebook.ai.intel` directly.

Uses a dedicated AI agent instance (unique session ID per generation) to
perform actual data profiling and generate actionable intelligence.

Storage: S3 (sessions/{session_id}/workbook-intel.json)
Metadata: SQLite (workbook_intel table)

Triggers:
  1. Auto: Frontend triggers after catalog discovery completes
  2. Manual: User clicks "Refresh" in the UI
"""

from .intel import (  # noqa: F401
    # generation
    generate_intel,
    generate_full_report,
    generate_intel_async,
    generate_intel_incremental,
    generate_intel_deletion,
    # state
    is_generating,
    get_generating_trigger,
    # storage
    save_intel_to_s3,
    load_intel_from_s3,
    # context
    _fetch_relevant_entity_docs,
    _fetch_session_catalog,
    # parsing
    _extract_intel_json,
    _extract_json_object,
    _looks_like_intel,
    _strip_code_fences,
)

__all__ = [
    "generate_intel",
    "generate_full_report",
    "generate_intel_async",
    "generate_intel_incremental",
    "generate_intel_deletion",
    "is_generating",
    "get_generating_trigger",
    "save_intel_to_s3",
    "load_intel_from_s3",
    "_fetch_relevant_entity_docs",
    "_fetch_session_catalog",
    "_extract_intel_json",
    "_extract_json_object",
    "_looks_like_intel",
    "_strip_code_fences",
]
