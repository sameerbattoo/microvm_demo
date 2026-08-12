"""
Tools for interacting with the MicroVM execution environment.

These tools make HTTP calls to the connected MicroVM via the proxy's
existing auth mechanism to execute code, inspect variables, etc.
"""

import json
import httpx
import threading
from strands import tool
from ..constants import (
    CELL_CODE_MAX_CHARS, CELL_OUTPUT_MAX_CHARS, CELL_ERROR_MAX_CHARS,
    MARKDOWN_PREVIEW_MAX_CHARS, VARIABLE_PREVIEW_MAX_CHARS,
    HTTP_ERROR_BODY_MAX_CHARS,
)

# Thread-local context so concurrent agent sessions don't leak between each other
# Also maintain a module-level fallback for cases where tools run in the async event loop thread
_thread_context = threading.local()
_fallback_context: dict = {}
_fallback_lock = threading.Lock()


def set_execution_context(context: dict):
    """Set the execution context for the current thread AND module-level fallback."""
    global _fallback_context
    _thread_context.context = context.copy()
    with _fallback_lock:
        _fallback_context = context.copy()


def _get_context() -> dict:
    """Get the current execution context (thread-local first, fallback if not set)."""
    ctx = getattr(_thread_context, 'context', None)
    if ctx:
        return ctx
    with _fallback_lock:
        return _fallback_context


def _get_headers() -> dict:
    """Build headers for MicroVM proxy requests using session_id."""
    ctx = _get_context()
    headers = {"Content-Type": "application/json"}
    if ctx.get("session_id"):
        headers["X-Session-Id"] = ctx["session_id"]
    return headers


@tool
def execute_code(code: str) -> str:
    """
    Execute Python code on the connected MicroVM and return the result.
    Use this to test code, verify fixes, or check data before suggesting changes to the user.

    IMPORTANT: When the user asks about files, ONLY look in /tmp/ for data files
    (.csv, .xlsx, .xls, .parquet, .json). Do NOT run 'ls /' or list system directories.
    Use: import glob; glob.glob('/tmp/*.csv') + glob.glob('/tmp/*.json') + glob.glob('/tmp/*.parquet')

    Args:
        code: Python code to execute.

    Returns:
        The execution output (stdout), or the error message if it failed.
    """
    proxy_url = _get_context().get("proxy_url", "http://localhost:8081")
    headers = _get_headers()

    try:
        with httpx.Client(timeout=120.0) as client:
            resp = client.post(
                f"{proxy_url}/proxy/execute",
                headers=headers,
                json={"code": code},
            )
            if resp.status_code == 200:
                data = resp.json()
                if data.get("success"):
                    output = data.get("output", "").strip()
                    html = data.get("html", "")
                    if html:
                        return f"Output:\n{output}\n\n[DataFrame table rendered in notebook]"
                    return output or "(no output)"
                else:
                    return f"Error: {data.get('error', 'Unknown error')}"
            else:
                return f"HTTP error {resp.status_code}: {resp.text[:HTTP_ERROR_BODY_MAX_CHARS]}"
    except Exception as e:
        return f"Execution failed: {str(e)}"


@tool
def get_variables() -> str:
    """
    Get all Python variables currently defined in the MicroVM namespace.
    Returns variable names, types, shapes, and preview values.
    Use this to understand what data the user has available.

    Returns:
        JSON-formatted list of variables with their types and previews.
    """
    proxy_url = _get_context().get("proxy_url", "http://localhost:8081")
    headers = _get_headers()

    try:
        with httpx.Client(timeout=30.0) as client:
            resp = client.get(
                f"{proxy_url}/proxy/variables",
                headers=headers,
            )
            if resp.status_code == 200:
                data = resp.json()
                variables = data.get("variables", {})
                if not variables:
                    return "No variables defined yet."

                # Format for the agent
                lines = []
                for name, info in variables.items():
                    type_name = info.get("type", "unknown")
                    shape = info.get("shape", "")
                    preview = info.get("preview", info.get("value", ""))[:VARIABLE_PREVIEW_MAX_CHARS]
                    line = f"  {name}: {type_name}"
                    if shape:
                        line += f" {shape}"
                    if preview:
                        line += f" = {preview}"
                    lines.append(line)
                return "Current variables:\n" + "\n".join(lines)
            else:
                return "Could not fetch variables."
    except Exception as e:
        return f"Failed to get variables: {str(e)}"


@tool
def get_notebook_state() -> str:
    """
    Get the full state of the current notebook: all cells with their code, outputs, and errors.
    Use this to understand what the user has done so far before making suggestions.

    Returns:
        Formatted summary of all notebook cells.
    """
    notebook_context = _get_context().get("notebook_cells", [])
    if not notebook_context:
        return "Notebook is empty (no cells)."

    lines = []
    code_num = 0
    for i, cell in enumerate(notebook_context):
        cell_type = cell.get("type", "code")
        code = cell.get("code", "").strip()
        output = cell.get("output", "")
        error = cell.get("error", "")

        if cell_type == "markdown":
            lines.append(f"[Cell {i}] Markdown: {code[:MARKDOWN_PREVIEW_MAX_CHARS]}")
        else:
            code_num += 1
            lines.append(f"[Cell {i}] Code [{code_num}]:")
            lines.append(f"  {code[:CELL_CODE_MAX_CHARS]}")
            if output:
                lines.append(f"  → Output: {output[:CELL_OUTPUT_MAX_CHARS]}")
            if error:
                lines.append(f"  → ERROR: {error[:CELL_ERROR_MAX_CHARS]}")
        lines.append("")

    return "\n".join(lines)


@tool
def install_package(package_name: str) -> str:
    """
    Install a Python package on the connected MicroVM using pip.
    Use this when the user needs a library that isn't already installed.

    Args:
        package_name: The pip package name to install (e.g. "scikit-learn", "prophet", "seaborn").

    Returns:
        Success or failure message from pip install.
    """
    proxy_url = _get_context().get("proxy_url", "http://localhost:8081")
    headers = _get_headers()

    try:
        with httpx.Client(timeout=120.0) as client:
            resp = client.post(
                f"{proxy_url}/proxy/install",
                headers=headers,
                json={"package": package_name},
            )
            if resp.status_code == 200:
                data = resp.json()
                if data.get("success"):
                    return f"Successfully installed {package_name}"
                else:
                    return f"Install failed: {data.get('error', 'Unknown error')}"
            else:
                return f"Install request failed: HTTP {resp.status_code}"
    except Exception as e:
        return f"Install failed: {str(e)}"


@tool
def get_available_data_sources() -> str:
    """
    Get the list of available data sources with full schema information (columns, types, samples).
    Use this to understand what data the user can access and the exact column names/types.
    Call this BEFORE generating code that references data sources — it gives you exact column names.

    Returns:
        Formatted list of data sources with column schemas where discovered.
    """
    import httpx

    context = _get_context()
    session_id = context.get("session_id", "")
    proxy_url = context.get("proxy_url", "http://localhost:8081")

    # Try fetching the full data catalog from the VM (has schema info)
    catalog = None
    if session_id:
        try:
            resp = httpx.get(
                f"{proxy_url}/datasources/catalog",
                headers={"X-Session-Id": session_id},
                timeout=5.0,
            )
            if resp.status_code == 200:
                catalog = resp.json()
        except Exception:
            pass

    # If we got the catalog with discovered schemas, use it
    if catalog and catalog.get("entries"):
        lines = []
        # Group by source type
        by_type = {}
        for entry in catalog["entries"]:
            st = entry["source_type"]
            if st not in by_type:
                by_type[st] = []
            by_type[st].append(entry)

        type_labels = {"s3": "S3 Files", "dynamodb": "DynamoDB Tables", "athena": "Athena Tables", "local": "Local Files (/tmp/)"}

        for src_type, label in type_labels.items():
            entries = by_type.get(src_type, [])
            if not entries:
                continue
            lines.append(f"{label}:")
            for entry in entries:
                name = entry.get("display_name", entry["source_id"])
                size = entry.get("size", "")
                row_count = entry.get("row_count")
                status = entry.get("status", "pending")
                size_info = f" ({size})" if size else ""
                row_info = f", {row_count} rows" if row_count else ""

                if status == "discovered" and entry.get("columns"):
                    cols = entry["columns"]
                    col_summary = ", ".join(f"{c['name']}:{c['dtype']}" for c in cols[:12])
                    if len(cols) > 12:
                        col_summary += f", ... ({len(cols)} total)"
                    lines.append(f"  - {entry['source_id']}{size_info}{row_info}")
                    lines.append(f"    Columns: [{col_summary}]")
                else:
                    lines.append(f"  - {entry['source_id']}{size_info}{row_info} [{status}]")
            lines.append("")

        return "\n".join(lines) if lines else "No data sources found."

    # Fallback: basic info from frontend-passed context (no schema)
    data_sources = context.get("data_sources")
    uploaded_files = context.get("uploaded_files", [])

    if not data_sources and not uploaded_files:
        return "No data source information available."

    lines = []

    if uploaded_files:
        lines.append("Local Data Files (in /tmp/ on this VM):")
        for f in uploaded_files:
            name = f.get('name', '')
            size = f.get('size', '')
            schema = f.get('schema', '')
            line = f"  - /tmp/{name} ({size})"
            if schema:
                line += f"\n    Columns: {schema}"
            lines.append(line)
        lines.append("")

    if data_sources:
        s3 = data_sources.get("s3", [])
        dynamo = data_sources.get("dynamodb", [])
        athena = data_sources.get("athena", [])

        if s3:
            lines.append("S3 Files:")
            for f in s3:
                lines.append(f"  - s3://{f.get('bucket', '')}/{f.get('key', '')} ({f.get('size', '')})")
            lines.append("")

        if dynamo:
            lines.append("DynamoDB Tables:")
            for t in dynamo:
                lines.append(f"  - {t.get('name', '')} ({t.get('item_count', 0)} items)")
            lines.append("")

        if athena:
            lines.append("Athena Tables:")
            for t in athena:
                cols = t.get('columns', [])
                if cols and isinstance(cols[0], dict):
                    col_names = [c.get('name', '') for c in cols[:10]]
                else:
                    col_names = cols[:10]
                col_info = f" — columns: {', '.join(col_names)}" if col_names else ""
                lines.append(f"  - {t.get('database', '')}.{t.get('name', '')} ({t.get('column_count', 0)} cols){col_info}")
            lines.append("")

    return "\n".join(lines) if lines else "No data sources found."
