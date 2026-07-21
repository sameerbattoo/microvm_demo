"""
Sandbox API routes — code execution, package management, file operations.

These are the endpoints the AI agent and notebook UI call to interact
with the persistent Python sandbox inside the MicroVM.

Endpoints:
  POST /execute      - Execute Python code
  POST /install      - Install a pip package
  GET  /variables    - List namespace variables
  POST /reset        - Clear namespace
  POST /interrupt    - Interrupt running execution
  GET  /health       - Health check + session stats
  GET  /metrics      - Real-time system metrics (CPU, memory, disk, network)
  POST /upload       - Upload and load a data file
  GET  /files        - List uploaded files in /tmp/
"""

import os
import base64
import asyncio
import logging
import glob

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

logger = logging.getLogger(__name__)

router = APIRouter(tags=["sandbox"])


@router.post("/execute")
async def execute_code(request: Request):
    """Execute Python code in the persistent sandbox namespace."""
    executor = request.app.state.executor
    session_state = request.app.state.session_state
    session_state["request_count"] += 1

    body = await request.json()
    code = body.get("code", "")
    if not code.strip():
        return JSONResponse(status_code=400, content={"error": "No code provided. Send {\"code\": \"...\"}"})

    logger.info(f"▶ Executing code (len={len(code)})")
    result = await asyncio.to_thread(executor.execute, code)

    return {
        "success": result.success,
        "output": result.output,
        "error": result.error,
        "html": result.html,
        "image": result.image,
        "variables_created": result.variables_created,
        "execution_time_ms": result.execution_time_ms,
        "execution_number": executor.get_stats()["execution_count"],
    }


@router.post("/install")
async def install_package(request: Request):
    """Install a Python package into this sandbox (persists across suspend/resume)."""
    executor = request.app.state.executor
    session_state = request.app.state.session_state
    session_state["request_count"] += 1

    body = await request.json()
    package = body.get("package", "")
    if not package.strip():
        return JSONResponse(status_code=400, content={"error": "No package specified. Send {\"package\": \"...\"}"})

    logger.info(f"📦 Installing package: {package}")
    result = executor.install_package(package)
    return {"success": result.success, "output": result.output, "error": result.error}


@router.get("/variables")
async def list_variables(request: Request):
    """List all variables in the sandbox namespace."""
    executor = request.app.state.executor
    request.app.state.session_state["request_count"] += 1
    return {"variables": executor.get_variables(), "count": len(executor.get_variables())}


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
        return {
            "success": True,
            "variable_name": var_name,
            "filename": filename,
            "message": f"Loaded '{filename}' as DataFrame '{var_name}'",
            "shape": shape_result.output.strip() if shape_result.success else "",
        }
    return {"success": False, "error": result.error}


@router.get("/files")
async def list_files():
    """List uploaded files in /tmp/."""
    extensions = ['*.csv', '*.xlsx', '*.xls', '*.parquet', '*.json', '*.txt']
    files = []
    for ext in extensions:
        for filepath in glob.glob(f'/tmp/{ext}'):
            filename = os.path.basename(filepath)
            size = os.path.getsize(filepath)
            if size < 1024:
                size_str = f"{size} B"
            elif size < 1024 * 1024:
                size_str = f"{size / 1024:.1f} KB"
            else:
                size_str = f"{size / (1024 * 1024):.1f} MB"
            files.append({"name": filename, "path": filepath, "size": size_str, "size_bytes": size})
    files.sort(key=lambda f: f["name"])
    return {"files": files}
