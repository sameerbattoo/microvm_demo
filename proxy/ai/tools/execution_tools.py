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

# Module-level context set before each agent invocation
_context: dict = {}
_context_lock = threading.Lock()


def set_execution_context(context: dict):
    """Set the execution context (endpoint, microvm_id, etc.) for tools to use."""
    global _context
    with _context_lock:
        _context = context.copy()


def _get_headers() -> dict:
    """Build headers for MicroVM proxy requests."""
    headers = {"Content-Type": "application/json"}
    if _context.get("microvm_id"):
        headers["X-MicroVM-Id"] = _context["microvm_id"]
    if _context.get("microvm_endpoint"):
        headers["X-MicroVM-Endpoint"] = _context["microvm_endpoint"]
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
    proxy_url = _context.get("proxy_url", "http://localhost:8081")
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
    proxy_url = _context.get("proxy_url", "http://localhost:8081")
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
    notebook_context = _context.get("notebook_cells", [])
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
    proxy_url = _context.get("proxy_url", "http://localhost:8081")
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
    Get the list of available data sources (S3 files, DynamoDB tables, Athena tables, local files).
    Use this to understand what data the user can access from this notebook.
    ONLY reports user data files in /tmp/ — never system files.

    Returns:
        Formatted list of available data sources with schema info where available.
    """
    data_sources = _context.get("data_sources")
    uploaded_files = _context.get("uploaded_files", [])

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
            lines.append("Athena Tables (query via boto3 or awswrangler):")
            for t in athena:
                cols = t.get('columns', [])
                col_info = f" — columns: {', '.join(cols[:10])}" if cols else ""
                lines.append(f"  - {t.get('database', '')}.{t.get('name', '')} ({t.get('column_count', 0)} cols){col_info}")
            lines.append("")

    return "\n".join(lines) if lines else "No data sources found."
