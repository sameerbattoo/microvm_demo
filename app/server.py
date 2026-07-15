"""
Lambda MicroVM Agent Sandbox Server

This FastAPI app runs inside a Lambda MicroVM and provides:
1. Code execution endpoints (the agent sends code here)
2. Lifecycle hooks (AWS calls these during MicroVM state transitions)

The key insight: this is a STATEFUL server. The executor namespace persists
across HTTP requests AND across suspend/resume cycles. When the MicroVM
suspends, all memory is snapshotted. On resume, it's exactly as it was.

This is what makes MicroVMs ideal for agent sandboxes — the AI agent can
build up state (define functions, load data, install packages) across many
interactions without losing context.
"""

import logging
import time
import base64
import tempfile
import os
from datetime import datetime, timezone

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.executor import SandboxExecutor

# --- Logging ---
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger(__name__)

# --- Persistent State ---
# These survive across requests AND across suspend/resume.
executor = SandboxExecutor()

# Pre-import heavy libraries so they're in the snapshot
# (eliminates first-cell import latency on MicroVM launch)
import pandas
import numpy
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot

session_state = {
    "microvm_id": None,
    "session_id": None,
    "started_at": None,
    "request_count": 0,
    "suspend_count": 0,
    "resume_count": 0,
}

# --- FastAPI App ---
app = FastAPI(
    title="Agent Code Sandbox",
    description="Isolated code execution environment for AI agents",
    version="1.0.0",
)

# CORS — allows the web notebook UI to talk to this backend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============================================================
# LIFECYCLE HOOKS
# Path prefix: /aws/lambda-microvms/runtime/v1/
# These are called by the Lambda MicroVM runtime, not by your
# agent. They manage the sandbox lifecycle.
# ============================================================


# --- Build-time hooks (called during image creation) ---

@app.post("/aws/lambda-microvms/runtime/v1/ready")
async def hook_ready():
    """
    Called during image build to signal the app is initialized.
    Returning 200 tells Lambda to snapshot the current state.
    """
    logger.info("🔧 HOOK /ready — App initialized, ready for snapshot")
    return {"status": "ready"}


@app.post("/aws/lambda-microvms/runtime/v1/validate")
async def hook_validate():
    """
    Called during image build to validate the app works correctly.
    Lambda uses this to pre-fetch hot paths for faster startup.
    """
    logger.info("🔧 HOOK /validate — Validation passed")
    return {"status": "valid"}


# --- Runtime hooks (called during MicroVM lifecycle) ---


@app.post("/aws/lambda-microvms/runtime/v1/run")
async def hook_run(request: Request):
    """
    Called when this MicroVM starts from snapshot.

    The runHookPayload (passed via run-microvm API) contains session
    config — e.g., which user/tenant this sandbox belongs to, what
    packages to pre-install, etc.

    IMPORTANT: No external traffic reaches the app until this returns 200.
    """
    body = await request.json() if await request.body() else {}

    session_state["microvm_id"] = body.get("microvmId", "unknown")
    session_state["session_id"] = body.get("runHookPayload")
    session_state["started_at"] = datetime.now(timezone.utc).isoformat()
    session_state["request_count"] = 0

    logger.info(f"🚀 HOOK /run — Sandbox started")
    logger.info(f"   MicroVM ID: {session_state['microvm_id']}")
    logger.info(f"   Session: {session_state['session_id']}")

    return {"status": "ready"}


@app.post("/aws/lambda-microvms/runtime/v1/suspend")
async def hook_suspend():
    """
    Called BEFORE suspend. Memory + disk will be snapshotted.

    The executor namespace, all variables, installed packages —
    everything in memory survives the suspend. But open network
    connections (DB, Redis, WebSocket) won't reconnect automatically.

    For the Hex POC: this is where you'd flush any buffered cell
    output back to the frontend before the kernel goes to sleep.
    """
    session_state["suspend_count"] += 1

    stats = executor.get_stats()
    logger.info(f"💤 HOOK /suspend — Going to sleep")
    logger.info(f"   Executions so far: {stats['execution_count']}")
    logger.info(f"   Variables in namespace: {stats['variables_count']}")

    return {"status": "ready_to_suspend"}


@app.post("/aws/lambda-microvms/runtime/v1/resume")
async def hook_resume():
    """
    Called AFTER resume. Memory is restored from snapshot.

    All Python state is intact — executor namespace, variables,
    imported modules. This hook is for re-establishing external
    connections only.

    Resume latency: ~1 second per 500MB of snapshot size.
    """
    session_state["resume_count"] += 1

    stats = executor.get_stats()
    logger.info(f"⏰ HOOK /resume — Waking up")
    logger.info(f"   State intact: {stats['variables_count']} variables, "
                f"{stats['execution_count']} prior executions")

    return {"status": "resumed"}


@app.post("/aws/lambda-microvms/runtime/v1/terminate")
async def hook_terminate():
    """
    Called BEFORE termination (8hr max hit, or explicit terminate call).

    For the Hex checkpoint pattern: this is where you would serialize
    the executor namespace to S3/EFS so a new MicroVM can restore it.

    Example checkpoint flow:
    1. pickle/dill the namespace → bytes
    2. Upload to s3://sessions/{session_id}/checkpoint.pkl
    3. New MicroVM loads it in /run hook via runHookPayload pointing to S3
    """
    stats = executor.get_stats()
    logger.info(f"🔴 HOOK /terminate — Shutting down")
    logger.info(f"   Total executions: {stats['execution_count']}")
    logger.info(f"   Total suspends: {session_state['suspend_count']}")
    logger.info(f"   Total resumes: {session_state['resume_count']}")

    # TODO: In production, checkpoint state to S3 here
    # checkpoint_to_s3(executor, session_state["session_id"])

    return {"status": "terminated"}


# ============================================================
# SANDBOX API
# These are the endpoints your AI agent calls to execute code,
# install packages, and inspect state.
# ============================================================


@app.post("/execute")
async def execute_code(request: Request):
    """
    Execute Python code in the sandbox.

    The namespace is persistent — variables defined in one call
    are available in the next. This is how agents build up context
    across multi-step tasks.

    Request body:
        {"code": "x = 42\nprint(x * 2)"}

    Response:
        {
            "success": true,
            "output": "84\n",
            "error": "",
            "variables_created": ["x"],
            "execution_time_ms": 1.23,
            "execution_number": 1
        }
    """
    session_state["request_count"] += 1
    body = await request.json()

    code = body.get("code", "")
    if not code.strip():
        return JSONResponse(
            status_code=400,
            content={"error": "No code provided. Send {\"code\": \"...\"}"},
        )

    logger.info(f"▶ Executing code (len={len(code)})")
    result = executor.execute(code)

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


@app.post("/install")
async def install_package(request: Request):
    """
    Install a Python package into this sandbox.

    Installed packages persist across requests AND across
    suspend/resume — they're part of the disk state that gets
    snapshotted.

    Request body:
        {"package": "pandas"}

    Response:
        {"success": true, "output": "Successfully installed pandas"}
    """
    session_state["request_count"] += 1
    body = await request.json()

    package = body.get("package", "")
    if not package.strip():
        return JSONResponse(
            status_code=400,
            content={"error": "No package specified. Send {\"package\": \"...\"}"},
        )

    logger.info(f"📦 Installing package: {package}")
    result = executor.install_package(package)

    return {
        "success": result.success,
        "output": result.output,
        "error": result.error,
    }


@app.get("/variables")
async def list_variables():
    """
    List all variables in the sandbox namespace.

    This lets the agent introspect what state has been built up
    across prior executions — useful for context when deciding
    what code to generate next.
    """
    session_state["request_count"] += 1
    return {
        "variables": executor.get_variables(),
        "count": len(executor.get_variables()),
    }


@app.post("/reset")
async def reset_sandbox():
    """Clear the sandbox namespace. Fresh start."""
    session_state["request_count"] += 1
    executor.reset()
    logger.info("🔄 Sandbox namespace reset")
    return {"status": "reset", "message": "Namespace cleared"}


@app.get("/health")
async def health():
    """Health check with session metadata."""
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


@app.post("/upload")
async def upload_file(request: Request):
    """
    Upload a CSV or Excel file and load it into a pandas DataFrame.

    Request body:
        {
            "filename": "sales.csv",
            "data": "<base64-encoded file content>",
            "variable_name": "df"  (optional, defaults to filename stem)
        }

    The file is decoded, saved to a temp path, then loaded with pandas
    into the executor namespace as a DataFrame.
    """
    session_state["request_count"] += 1
    body = await request.json()

    filename = body.get("filename", "")
    data_b64 = body.get("data", "")
    var_name = body.get("variable_name", "")

    if not filename or not data_b64:
        return JSONResponse(
            status_code=400,
            content={"error": "Provide 'filename' and 'data' (base64-encoded)"},
        )

    # Determine variable name from filename if not provided
    if not var_name:
        stem = os.path.splitext(filename)[0]
        # Clean up to valid Python identifier
        var_name = stem.replace(" ", "_").replace("-", "_").replace(".", "_")
        var_name = "".join(c for c in var_name if c.isalnum() or c == "_")
        if var_name and var_name[0].isdigit():
            var_name = "df_" + var_name

    ext = os.path.splitext(filename)[1].lower()

    # Decode and save to temp file
    try:
        file_bytes = base64.b64decode(data_b64)
    except Exception:
        return JSONResponse(status_code=400, content={"error": "Invalid base64 data"})

    tmp_path = f"/tmp/{filename}"
    with open(tmp_path, "wb") as f:
        f.write(file_bytes)

    # Build the load code based on file type
    if ext == ".csv":
        load_code = f"import pandas as pd; {var_name} = pd.read_csv('{tmp_path}')"
    elif ext in (".xlsx", ".xls"):
        load_code = f"import pandas as pd; {var_name} = pd.read_excel('{tmp_path}')"
    elif ext == ".parquet":
        load_code = f"import pandas as pd; {var_name} = pd.read_parquet('{tmp_path}')"
    elif ext == ".json":
        load_code = f"import pandas as pd; {var_name} = pd.read_json('{tmp_path}')"
    else:
        return JSONResponse(
            status_code=400,
            content={"error": f"Unsupported file type: {ext}. Use .csv, .xlsx, .xls, .parquet, or .json"},
        )

    logger.info(f"📄 Uploading {filename} → {var_name}")
    result = executor.execute(load_code)

    if result.success:
        # Get shape info
        shape_result = executor.execute(f"print(f'{{{var_name}}}.shape = {{{var_name}.shape}}')")
        shape_output = shape_result.output.strip() if shape_result.success else ""

        return {
            "success": True,
            "variable_name": var_name,
            "filename": filename,
            "message": f"Loaded '{filename}' as DataFrame '{var_name}'",
            "shape": shape_output,
        }
    else:
        return {
            "success": False,
            "error": result.error,
        }


@app.get("/files")
async def list_files():
    """List uploaded files in /tmp/ that are likely user data files."""
    import glob
    
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
            files.append({
                "name": filename,
                "path": filepath,
                "size": size_str,
                "size_bytes": size,
            })
    
    # Sort by name
    files.sort(key=lambda f: f["name"])
    
    return {"files": files}
