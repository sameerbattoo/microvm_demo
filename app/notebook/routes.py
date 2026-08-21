"""
Sandbox utility routes — package management, variables, health, metrics, files.

Part of: app.notebook (application layer)

Endpoints:
  POST /install            - Install a pip package
  GET  /variables          - List namespace variables
  POST /variable-detail    - Rich detail for one variable (schema + full table)
  POST /introspect         - Get attributes/methods of a variable (for autocomplete)
  POST /reset              - Clear namespace
  POST /interrupt          - Interrupt running execution
  GET  /health             - Health check + session stats
  GET  /metrics            - Real-time system metrics (CPU, memory, disk, network)
  POST /upload             - Upload and load a data file
  GET  /files              - List uploaded files in /tmp/
  GET  /checkpoint-timings - Timing breakdown from last checkpoint save/restore
"""

import os
import base64
import logging
import glob

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

logger = logging.getLogger(__name__)

router = APIRouter(tags=["sandbox"])


@router.post("/install")
async def install_package(request: Request):
    """Install or uninstall a Python package in this sandbox."""
    executor = request.app.state.executor
    session_state = request.app.state.session_state
    session_state["request_count"] += 1

    body = await request.json()
    package = body.get("package", "")
    uninstall = body.get("uninstall", False)
    if not package.strip():
        return JSONResponse(status_code=400, content={"error": "No package specified. Send {\"package\": \"...\"}"})

    if uninstall:
        logger.info(f"📦 Uninstalling package: {package}")
        import subprocess, sys
        try:
            result = subprocess.run(
                [sys.executable, "-m", "pip", "uninstall", "-y", package],
                capture_output=True, text=True, timeout=30
            )
            if result.returncode == 0:
                logger.info(f"  ✓ Uninstalled {package}")
                # Drop it from the checkpoint list so it doesn't reappear on restore.
                request.app.state.checkpoint_manager.record_package_uninstall(package)
                return {"success": True, "output": result.stdout.strip()}
            else:
                logger.warning(f"  ✗ Uninstall failed: {package} — {result.stderr.strip()[:100]}")
                return {"success": False, "error": result.stderr.strip() or "Uninstall failed"}
        except Exception as e:
            logger.warning(f"  ✗ Uninstall error: {package} — {e}")
            return {"success": False, "error": str(e)}
    else:
        logger.info(f"📦 Installing package: {package}")
        result = executor.install_package(package)

        # Track the installed package (pinned to the resolved version) for checkpoint.
        if result.success:
            spec = result.installed_spec or package
            logger.info(f"  ✓ Installed {spec}")
            request.app.state.checkpoint_manager.record_package_install(spec)
        else:
            logger.warning(f"  ✗ Install failed: {package} — {result.error[:100]}")

        return {
            "success": result.success,
            "output": result.output,
            "error": result.error,
            "installed_spec": result.installed_spec,
        }


@router.get("/variables")
async def list_variables(request: Request):
    """List all variables in the sandbox namespace."""
    executor = request.app.state.executor
    request.app.state.session_state["request_count"] += 1
    try:
        variables = executor.get_variables()
        return {"variables": variables, "count": len(variables)}
    except Exception as e:
        import traceback
        logger.error(f"Failed to list variables: {e}\n{traceback.format_exc()}")
        return JSONResponse(status_code=500, content={"error": f"Failed to inspect variables: {str(e)}"})


@router.post("/introspect")
async def introspect_variable(request: Request):
    """
    Get attributes/methods of a variable for autocomplete dot-completion.
    Request body: { "variable": "df", "partial": "hea" }
    Returns: { "completions": [{"name": "head", "type": "method", "detail": "(...)"}, ...] }
    """
    executor = request.app.state.executor
    body = await request.json()
    var_name = body.get("variable", "")
    partial = body.get("partial", "").lower()

    ns = executor._namespace
    if var_name not in ns:
        return {"completions": []}

    obj = ns[var_name]
    try:
        attrs = dir(obj)
    except Exception:
        return {"completions": []}

    completions = []
    for attr in attrs:
        # Skip dunder attributes unless user explicitly types __
        if attr.startswith("__") and not partial.startswith("__"):
            continue
        # Filter by partial match
        if partial and not attr.lower().startswith(partial):
            continue

        # Determine type (method vs property)
        try:
            val = getattr(obj, attr, None)
            if callable(val):
                comp_type = "method"
                detail = "()"
            else:
                comp_type = "property"
                detail = type(val).__name__ if val is not None else ""
        except Exception:
            comp_type = "property"
            detail = ""

        completions.append({"name": attr, "type": comp_type, "detail": detail})

        # Cap at 50 to avoid overwhelming the UI
        if len(completions) >= 50:
            break

    return {"completions": completions}


@router.post("/variable-detail")
async def variable_detail(request: Request):
    """
    Lazy, on-demand rich detail for ONE variable (Variables panel viewer).
    Request body: { "name": "df" }

    For a DataFrame/Series: returns a column schema (name/dtype/null%/unique) and a
    full head(N) table_html (N = NOTEBOOK_MAX_DISPLAY_ROWS) the UI renders in a grid.
    For ndarray: shape/dtype + a table for 1D/2D. Other types: a longer repr.
    """
    from .executor import max_display_rows
    from .dtypes import normalize_dtype

    executor = request.app.state.executor
    body = await request.json()
    name = body.get("name", "")
    ns = executor._namespace
    if not name or name not in ns:
        return JSONResponse(status_code=404, content={"error": f"Variable not found: {name}"})

    obj = ns[name]
    try:
        max_rows = max_display_rows()
        type_name = type(obj).__name__
        module = getattr(type(obj), "__module__", "") or ""
        result = {"name": name, "type": type_name}

        if "pandas" in module and type_name == "DataFrame":
            total_rows, total_cols = int(obj.shape[0]), int(obj.shape[1])
            result["total_rows"] = total_rows
            result["total_cols"] = total_cols
            # nunique can be expensive on very large frames — skip beyond a threshold.
            compute_unique = total_rows <= 100_000
            try:
                null_counts = obj.isnull().sum()
            except Exception:
                null_counts = None
            schema = []
            for col in obj.columns:
                nnull = 0
                if null_counts is not None:
                    try:
                        nnull = int(null_counts[col])
                    except Exception:
                        nnull = 0
                nunique = None
                if compute_unique:
                    try:
                        nunique = int(obj[col].nunique(dropna=True))
                    except Exception:
                        nunique = None
                schema.append({
                    "column": str(col),
                    "dtype": str(obj[col].dtype),
                    "display_dtype": normalize_dtype(str(obj[col].dtype)),
                    "null_count": nnull,
                    "null_pct": round(nnull / total_rows * 100, 1) if total_rows else 0.0,
                    "unique": nunique,
                })
            result["schema"] = schema
            # Show the index when it's meaningful (named / MultiIndex).
            df_disp = obj
            try:
                if obj.index.name or (hasattr(obj.index, "names") and any(n for n in obj.index.names if n)):
                    df_disp = obj.reset_index()
            except Exception:
                pass
            result["table_html"] = df_disp.head(max_rows).to_html(classes="df-table", max_rows=max_rows, max_cols=50)
            result["truncated"] = total_rows > max_rows

        elif "pandas" in module and type_name == "Series":
            total_rows = int(len(obj))
            result["total_rows"] = total_rows
            result["total_cols"] = 1
            try:
                nnull = int(obj.isnull().sum())
            except Exception:
                nnull = 0
            result["schema"] = [{
                "column": str(obj.name) if obj.name is not None else "value",
                "dtype": str(obj.dtype),
                "display_dtype": normalize_dtype(str(obj.dtype)),
                "null_count": nnull,
                "null_pct": round(nnull / total_rows * 100, 1) if total_rows else 0.0,
                "unique": int(obj.nunique(dropna=True)) if total_rows <= 100_000 else None,
            }]
            # Render as a clean 2-column table: the (named) index becomes a real
            # column and the values get a sensible column name — instead of pandas'
            # default "0" for an unnamed Series plus an awkward index-name header
            # (common for groupby().size() results indexed by e.g. product_id).
            _value_name = str(obj.name) if obj.name is not None else "value"
            _series_frame = obj.head(max_rows).rename(_value_name).reset_index()
            result["table_html"] = _series_frame.to_html(classes="df-table", index=False, max_rows=max_rows)
            result["truncated"] = total_rows > max_rows

        elif "numpy" in module and hasattr(obj, "shape"):
            result["shape"] = str(obj.shape)
            result["dtype"] = str(getattr(obj, "dtype", ""))
            try:
                import pandas as pd
                if getattr(obj, "ndim", None) == 1:
                    result["table_html"] = pd.DataFrame(obj[:max_rows], columns=["value"]).to_html(classes="df-table")
                    result["total_rows"] = int(obj.shape[0])
                    result["truncated"] = int(obj.shape[0]) > max_rows
                elif getattr(obj, "ndim", None) == 2:
                    result["table_html"] = pd.DataFrame(obj[:max_rows]).to_html(classes="df-table", max_cols=50)
                    result["total_rows"] = int(obj.shape[0])
                    result["truncated"] = int(obj.shape[0]) > max_rows
                else:
                    result["text"] = repr(obj)[:5000]
            except Exception:
                result["text"] = repr(obj)[:5000]

        elif module.startswith("plotly") and type_name == "Figure":
            # Don't dump the huge figure spec — the chart is already in the cell output.
            try:
                traces = list(getattr(obj, "data", []) or [])
                kinds = ", ".join(sorted({(getattr(t, "type", None) or "?") for t in traces})) or "—"
                summary = f"Plotly Figure · {len(traces)} trace(s) · {kinds}"
                try:
                    title = (obj.layout.title.text or "") if (obj.layout and obj.layout.title) else ""
                except Exception:
                    title = ""
                if title:
                    summary += f"\nTitle: {title}"
                result["text"] = summary + "\n\nThe chart is rendered in the cell's output."
            except Exception:
                result["text"] = "Plotly Figure\n\nThe chart is rendered in the cell's output."

        elif module.startswith("matplotlib") and type_name == "Figure":
            result["text"] = "Matplotlib Figure\n\nThe chart is rendered in the cell's output."

        elif "pandas" in module and type_name.endswith("Index"):
            # Index types (Index, DatetimeIndex, RangeIndex, MultiIndex, ...) are
            # 1-D sequences — render as a compact table, not a wrapped repr.
            import pandas as pd
            total = int(len(obj))
            result["total_rows"] = total
            result["total_cols"] = 1
            try:
                result["dtype"] = str(obj.dtype)
            except Exception:
                pass
            _freq = getattr(obj, "freqstr", None)
            if _freq:
                result["index_freq"] = _freq
            try:
                if type_name == "MultiIndex":
                    _frame = obj[:max_rows].to_frame(index=False)
                    result["total_cols"] = int(_frame.shape[1])
                else:
                    _col = str(obj.name) if obj.name is not None else "value"
                    _frame = pd.DataFrame({_col: obj[:max_rows]})
                result["table_html"] = _frame.to_html(classes="df-table", index=False, max_rows=max_rows)
                result["truncated"] = total > max_rows
            except Exception:
                result["text"] = repr(obj)[:5000]

        elif isinstance(obj, (dict, list, tuple)):
            # Nested containers → a bounded, JSON-safe structure for a collapsible
            # tree view on the frontend. Depth/element/string caps keep it cheap.
            def _to_json_safe(value, depth=0):
                _MAX_DEPTH, _MAX_ITEMS, _MAX_STR = 6, 200, 500
                if depth >= _MAX_DEPTH:
                    return "… (max depth)"
                if value is None or isinstance(value, bool) or isinstance(value, (int, float)):
                    return value
                if isinstance(value, str):
                    return value if len(value) <= _MAX_STR else value[:_MAX_STR] + "…"
                if isinstance(value, dict):
                    out = {}
                    for i, (k, v) in enumerate(value.items()):
                        if i >= _MAX_ITEMS:
                            out["…"] = f"({len(value) - _MAX_ITEMS} more keys)"
                            break
                        out[str(k)] = _to_json_safe(v, depth + 1)
                    return out
                if isinstance(value, (list, tuple, set, frozenset)):
                    seq = list(value)
                    out = []
                    for i, v in enumerate(seq):
                        if i >= _MAX_ITEMS:
                            out.append(f"… ({len(seq) - _MAX_ITEMS} more items)")
                            break
                        out.append(_to_json_safe(v, depth + 1))
                    return out
                try:
                    return str(value)[:_MAX_STR]
                except Exception:
                    return f"<{type(value).__name__}>"

            result["json_tree"] = _to_json_safe(obj)
            result["json_root_type"] = "object" if isinstance(obj, dict) else "array"

        else:
            try:
                result["text"] = repr(obj)[:5000]
            except Exception:
                result["text"] = f"<{type_name}>"

        return result
    except Exception as e:
        import traceback
        logger.error(f"variable-detail failed for {name}: {e}\n{traceback.format_exc()}")
        return JSONResponse(status_code=500, content={"error": str(e)})


@router.post("/reset")
async def reset_sandbox(request: Request):
    """Clear the sandbox namespace."""
    executor = request.app.state.executor
    request.app.state.session_state["request_count"] += 1
    executor.reset()
    logger.info("🔄 Sandbox namespace reset")
    return {"status": "reset", "message": "Namespace cleared"}


@router.post("/interrupt")
async def interrupt_execution(request: Request):
    """Interrupt a running code execution."""
    executor = request.app.state.executor
    interrupted = executor.interrupt()
    if interrupted:
        logger.info("⛔ Execution interrupted by user")
        return {"status": "interrupted", "message": "Execution interrupted"}
    return {"status": "idle", "message": "Nothing running to interrupt"}


@router.get("/health")
async def health(request: Request):
    """Health check with session metadata."""
    executor = request.app.state.executor
    session_state = request.app.state.session_state
    stats = executor.get_stats()
    return {
        "status": "healthy",
        "microvm_id": session_state["microvm_id"],
        "session_id": session_state["session_id"],
        "started_at": session_state["started_at"],
        "request_count": session_state["request_count"],
        "execution_count": stats["execution_count"],
        "variables_count": stats["variables_count"],
        "suspend_count": session_state["suspend_count"],
        "resume_count": session_state["resume_count"],
    }


@router.get("/metrics")
async def metrics(request: Request):
    """Real-time system metrics for this MicroVM."""
    import psutil
    import time

    executor = request.app.state.executor
    cpu_percent = psutil.cpu_percent(interval=None)

    mem = psutil.virtual_memory()
    proc = psutil.Process()
    proc_mem = proc.memory_info()
    proc_mem_pct = (proc_mem.rss / mem.total * 100) if mem.total > 0 else 0
    effective_mem_pct = max(mem.percent, proc_mem_pct)

    try:
        disk = psutil.disk_usage('/tmp')
    except Exception:
        disk = None

    net = psutil.net_io_counters()
    proc_count = len(psutil.pids())
    uptime_sec = time.time() - psutil.boot_time()
    stats = executor.get_stats()

    return {
        "cpu": {"percent": round(cpu_percent, 1), "count": psutil.cpu_count() or 1},
        "memory": {
            "total_mb": round(mem.total / (1024 * 1024), 1),
            "used_mb": round(proc_mem.rss / (1024 * 1024), 1),
            "percent": round(effective_mem_pct, 1),
        },
        "disk": {
            "total_mb": round(disk.total / (1024 * 1024), 1) if disk else 0,
            "used_mb": round(disk.used / (1024 * 1024), 1) if disk else 0,
            "free_mb": round(disk.free / (1024 * 1024), 1) if disk else 0,
            "percent": round(disk.percent, 1) if disk else 0,
        },
        "network": {"bytes_sent": net.bytes_sent, "bytes_recv": net.bytes_recv},
        "processes": proc_count,
        "uptime_sec": round(uptime_sec, 1),
        "executor": stats,
    }


@router.post("/upload")
async def upload_file(request: Request):
    """Upload a data file and load it into a pandas DataFrame."""
    executor = request.app.state.executor
    request.app.state.session_state["request_count"] += 1

    body = await request.json()
    filename = body.get("filename", "")
    data_b64 = body.get("data", "")
    var_name = body.get("variable_name", "")

    if not filename or not data_b64:
        return JSONResponse(status_code=400, content={"error": "Provide 'filename' and 'data' (base64-encoded)"})

    # SECURITY: Strip path components
    filename = os.path.basename(filename)
    if not filename:
        return JSONResponse(status_code=400, content={"error": "Invalid filename"})

    # SECURITY: Validate extension
    ALLOWED_EXTENSIONS = {".csv", ".xlsx", ".xls", ".parquet", ".json"}
    ext = os.path.splitext(filename)[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        return JSONResponse(status_code=400, content={"error": f"Unsupported file type: {ext}"})

    # Determine variable name
    if not var_name:
        stem = os.path.splitext(filename)[0]
        var_name = stem.replace(" ", "_").replace("-", "_").replace(".", "_")
        var_name = "".join(c for c in var_name if c.isalnum() or c == "_")
        if var_name and var_name[0].isdigit():
            var_name = "df_" + var_name

    if not var_name or not var_name.isidentifier():
        var_name = "df_upload"

    # Decode and save
    try:
        file_bytes = base64.b64decode(data_b64)
    except Exception:
        return JSONResponse(status_code=400, content={"error": "Invalid base64 data"})

    tmp_path = os.path.join("/tmp", filename)
    with open(tmp_path, "wb") as f:
        f.write(file_bytes)

    # Load via variable injection (prevents code injection)
    path_var = f"__upload_path_{id(tmp_path)}"
    executor._namespace[path_var] = tmp_path

    if ext == ".csv":
        load_code = f"import pandas as pd; {var_name} = pd.read_csv({path_var})"
    elif ext in (".xlsx", ".xls"):
        load_code = f"import pandas as pd; {var_name} = pd.read_excel({path_var})"
    elif ext == ".parquet":
        load_code = f"import pandas as pd; {var_name} = pd.read_parquet({path_var})"
    elif ext == ".json":
        load_code = f"import pandas as pd; {var_name} = pd.read_json({path_var})"
    else:
        return JSONResponse(status_code=400, content={"error": f"Unsupported: {ext}"})

    logger.info(f"📄 Uploading {filename} → {var_name}")
    result = executor.execute(load_code)
    executor._namespace.pop(path_var, None)

    if result.success:
        shape_result = executor.execute(f"print(f'{{{var_name}}}.shape = {{{var_name}.shape}}')")
        logger.info(f"  ✓ Loaded {filename} as '{var_name}' {shape_result.output.strip() if shape_result.success else ''}")
        # Refresh data catalog with newly uploaded file
        request.app.state.data_catalog.refresh_local_files()
        return {
            "success": True,
            "variable_name": var_name,
            "filename": filename,
            "message": f"Loaded '{filename}' as DataFrame '{var_name}'",
            "shape": shape_result.output.strip() if shape_result.success else "",
        }
    logger.warning(f"  ✗ Upload failed: {filename} — {result.error[:100]}")
    return {"success": False, "error": result.error}


@router.get("/files")
async def list_files():
    """List data files in /tmp/ (recursive, includes subdirectories)."""
    extensions = ['*.csv', '*.xlsx', '*.xls', '*.parquet', '*.json', '*.txt']
    files = []
    for ext in extensions:
        for filepath in glob.glob(f'/tmp/**/{ext}', recursive=True):
            # Show path relative to /tmp/ (preserves folder structure)
            rel_path = os.path.relpath(filepath, '/tmp')
            size = os.path.getsize(filepath)
            if size < 1024:
                size_str = f"{size} B"
            elif size < 1024 * 1024:
                size_str = f"{size / 1024:.1f} KB"
            else:
                size_str = f"{size / (1024 * 1024):.1f} MB"
            files.append({"name": rel_path, "path": filepath, "size": size_str, "size_bytes": size})
    files.sort(key=lambda f: f["name"])
    return {"files": files}


@router.get("/checkpoint-timings")
async def checkpoint_timings(request: Request):
    """Return timing breakdown from the last checkpoint save/restore operation."""
    cm = request.app.state.checkpoint_manager
    return {
        "last_save": cm.last_save_timings,
        "last_restore": cm.last_restore_timings,
    }

@router.get("/packages")
async def list_packages():
    """
    List installed Python packages.

    Uses subprocess (pip list) — does NOT go through the executor.
    This avoids stdout race conditions with code execution cells.
    """
    import subprocess
    import json as json_mod

    try:
        result = subprocess.run(
            ["pip", "list", "--format=json"],
            capture_output=True, text=True, timeout=15
        )
        if result.returncode == 0:
            packages = json_mod.loads(result.stdout)
        else:
            packages = []
    except Exception:
        packages = []

    pkg_list = [{"name": p.get("name", ""), "version": p.get("version", "")} for p in packages]
    pkg_list.sort(key=lambda p: p["name"].lower())
    return {"packages": pkg_list, "count": len(pkg_list)}


@router.get("/data-catalog")
async def get_data_catalog(request: Request):
    """
    Return the full data catalog with discovered schemas.
    
    Progressive: returns whatever has been discovered so far.
    Entries have status: "pending" (not yet discovered), "discovered" (schema available), "error".
    
    Query params:
        source_id: (optional) return schema for a single source only
    """
    catalog = request.app.state.data_catalog
    source_id = request.query_params.get("source_id")
    
    if source_id:
        schema = catalog.get_schema(source_id)
        if schema:
            return schema
        return JSONResponse(status_code=404, content={"error": f"Source not found: {source_id}"})
    
    return catalog.get_all()


@router.post("/data-catalog/refresh-local")
async def refresh_local_catalog(request: Request):
    """Re-scan local /tmp files after a file upload."""
    catalog = request.app.state.data_catalog
    catalog.refresh_local_files()
    return {"status": "refreshing"}
