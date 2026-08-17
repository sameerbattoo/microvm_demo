"""
Canonical dtype normalization — single source of truth.

Used by:
  - app/notebook/data_catalog.py (VM-side schema discovery)
  - proxy/notebook/ai/entity_discovery.py (proxy-side profiling)
  - proxy/platform/routes/sessions.py (catalog endpoint enrichment)

Converts raw pandas/numpy/pyarrow dtype strings into user-friendly labels
suitable for display in the Data Sources panel. Ensures every code path
that produces dtype labels uses the same mapping — eliminates inconsistencies
like "float64" vs "float" or "object" vs "string".
"""

# Mapping from raw pandas/numpy dtype strings → user-friendly labels.
# Order matters: checked with startswith(), so more specific prefixes go first.
_DTYPE_PREFIXES = [
    ("float", "float"),
    ("int", "int"),
    ("uint", "int"),
    ("bool", "bool"),
    ("datetime", "datetime"),
    ("timedelta", "duration"),
    ("category", "category"),
    ("complex", "complex"),
]

_DTYPE_EXACT = {
    "object": "string",
    "string": "string",
    "str": "string",
    "String": "string",
    "boolean": "bool",
    "bool": "bool",
}


def normalize_dtype(raw: str) -> str:
    """
    Convert a raw pandas/numpy/pyarrow dtype name into a user-friendly label.

    Examples:
        normalize_dtype("float64")   → "float"
        normalize_dtype("int32")     → "int"
        normalize_dtype("object")    → "string"
        normalize_dtype("datetime64[ns]") → "datetime"
        normalize_dtype("bool")      → "bool"
        normalize_dtype("string")    → "string"
        normalize_dtype("number")    → "number"   (DynamoDB inferred)
        normalize_dtype("map")       → "map"      (DynamoDB inferred, pass-through)
    """
    if not raw:
        return "unknown"

    raw_lower = raw.lower().strip()

    # Exact matches first (most common: "object" → "string")
    if raw_lower in _DTYPE_EXACT:
        return _DTYPE_EXACT[raw_lower]

    # Prefix matches (float64, int32, datetime64[ns], etc.)
    for prefix, friendly in _DTYPE_PREFIXES:
        if raw_lower.startswith(prefix):
            return friendly

    # Pass-through for already-friendly or source-specific types
    # (e.g. DynamoDB's "number", "list", "map", Glue's "bigint", "varchar")
    glue_map = {"bigint": "int", "smallint": "int", "tinyint": "int",
                "double": "float", "decimal": "float", "varchar": "string",
                "char": "string", "binary": "bytes", "varbinary": "bytes",
                "date": "date", "timestamp": "datetime"}
    if raw_lower in glue_map:
        return glue_map[raw_lower]

    return raw_lower  # pass-through (e.g. "number", "list", "map")
