"""
JSON extraction helpers for Workbook Intelligence.

Part of: proxy.notebook.ai.intel

Agent / model responses may wrap the structured intel JSON in markdown fences,
preamble text, trailing prose, or ASCII-art diagrams (which contain braces).
These helpers robustly recover the intended JSON object.
"""

import json
import logging

logger = logging.getLogger(__name__)


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
