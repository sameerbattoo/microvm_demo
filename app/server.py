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
import base64
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

    The runHookPayload contains a JSON string with session config:
    - notebook_name: display name
    - session_id: unique session ID for checkpoint/restore
    - restore_from: session_id to restore state from (optional)

    IMPORTANT: No external traffic reaches the app until this returns 200.
    """
    body = await request.json() if await request.body() else {}

    session_state["microvm_id"] = body.get("microvmId", "unknown")
    run_payload = body.get("runHookPayload", "")
    session_state["started_at"] = datetime.now(timezone.utc).isoformat()
    session_state["request_count"] = 0

    # Parse the run hook payload (may be JSON or plain string)
    restore_from = None
    try:
        import json
        payload = json.loads(run_payload)
        session_state["session_id"] = payload.get("session_id", run_payload)
        session_state["checkpoint_enabled"] = payload.get("checkpoint_enabled", False)
        restore_from = payload.get("restore_from")
    except (json.JSONDecodeError, TypeError):
        session_state["session_id"] = run_payload
        session_state["checkpoint_enabled"] = False

    logger.info(f"🚀 HOOK /run — Sandbox started")
    logger.info(f"   MicroVM ID: {session_state['microvm_id']}")
    logger.info(f"   Session: {session_state['session_id']}")
    logger.info(f"   Checkpoint enabled: {session_state['checkpoint_enabled']}")

    # Restore from a previous session checkpoint if requested
    if restore_from:
        logger.info(f"   Restoring from session: {restore_from}")
        _restore_from_s3(restore_from)

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
    Called BEFORE termination (max lifetime hit, or explicit terminate call).
    Timeout: 60 seconds to complete.

    If checkpoint is enabled, serializes the executor namespace and local files
    to S3 so the session can be restored on a new MicroVM.
    """
    stats = executor.get_stats()
    logger.info(f"🔴 HOOK /terminate — Shutting down")
    logger.info(f"   Total executions: {stats['execution_count']}")
    logger.info(f"   Total suspends: {session_state['suspend_count']}")
    logger.info(f"   Total resumes: {session_state['resume_count']}")

    # Checkpoint state to S3 if enabled
    if session_state.get("checkpoint_enabled") and session_state.get("session_id"):
        logger.info(f"   📦 Checkpointing session to S3...")
        try:
            _checkpoint_to_s3(session_state["session_id"])
            logger.info(f"   ✅ Checkpoint saved: sessions/{session_state['session_id']}/")
        except Exception as e:
            logger.error(f"   ❌ Checkpoint failed: {e}")

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


@app.post("/interrupt")
async def interrupt_execution():
    """Interrupt a running code execution."""
    interrupted = executor.interrupt()
    if interrupted:
        logger.info("⛔ Execution interrupted by user")
        return {"status": "interrupted", "message": "Execution interrupted"}
    else:
        return {"status": "idle", "message": "Nothing running to interrupt"}


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


# ============================================================
# SESSION CHECKPOINT / RESTORE
# Saves executor state + local files to S3 on termination,
# restores them on a new MicroVM launch.
# ============================================================

# Discover the artifacts bucket (same one used for images)
_checkpoint_bucket = None


def _get_checkpoint_bucket():
    """Find the microvm-sandbox-artifacts bucket."""
    global _checkpoint_bucket
    if _checkpoint_bucket:
        return _checkpoint_bucket

    import boto3
    s3 = boto3.client("s3")
    resp = s3.list_buckets()
    for b in resp.get("Buckets", []):
        if b["Name"].startswith("microvm-sandbox-artifacts-"):
            _checkpoint_bucket = b["Name"]
            return _checkpoint_bucket

    # Fallback: construct from environment if available
    region = os.environ.get("AWS_REGION", "us-west-2")
    import boto3
    sts = boto3.client("sts")
    account_id = sts.get_caller_identity()["Account"]
    _checkpoint_bucket = f"microvm-sandbox-artifacts-{account_id}-{region}"
    return _checkpoint_bucket


def _checkpoint_to_s3(session_id: str):
    """
    Serialize executor namespace + local files and upload to S3.

    S3 structure:
      sessions/{session_id}/checkpoint.pkl   — dill-serialized namespace
      sessions/{session_id}/files.tar.gz     — /tmp/ data files
      sessions/{session_id}/requirements.txt — runtime-installed packages
      sessions/{session_id}/metadata.json    — session info
    """
    import io
    import tarfile
    import glob
    import json
    import subprocess

    import boto3
    import dill

    bucket = _get_checkpoint_bucket()
    s3 = boto3.client("s3")
    prefix = f"sessions/{session_id}"

    # 1. Serialize the executor namespace
    logger.info("   Serializing namespace...")
    namespace_to_save = {}
    for key, value in executor._namespace.items():
        if key.startswith("__") and key.endswith("__"):
            continue
        try:
            dill.dumps(value)  # Test if serializable
            namespace_to_save[key] = value
        except Exception:
            logger.warning(f"   Skipping non-serializable: {key} ({type(value).__name__})")

    checkpoint_bytes = dill.dumps(namespace_to_save)
    s3.put_object(Bucket=bucket, Key=f"{prefix}/checkpoint.pkl", Body=checkpoint_bytes)
    logger.info(f"   Namespace: {len(namespace_to_save)} vars, {len(checkpoint_bytes) / 1024:.1f} KB")

    # 2. Archive local data files from /tmp/
    logger.info("   Archiving local files...")
    data_extensions = ['*.csv', '*.xlsx', '*.xls', '*.parquet', '*.json', '*.txt']
    data_files = []
    for ext in data_extensions:
        data_files.extend(glob.glob(f'/tmp/{ext}'))

    if data_files:
        tar_buffer = io.BytesIO()
        with tarfile.open(fileobj=tar_buffer, mode='w:gz') as tar:
            for filepath in data_files:
                tar.add(filepath, arcname=os.path.basename(filepath))
        tar_buffer.seek(0)
        s3.put_object(Bucket=bucket, Key=f"{prefix}/files.tar.gz", Body=tar_buffer.read())
        logger.info(f"   Files: {len(data_files)} archived")

    # 3. Save runtime package list
    logger.info("   Saving package list...")
    try:
        import sys
        result = subprocess.run(
            [sys.executable, "-m", "pip", "freeze"],
            capture_output=True, text=True, timeout=10
        )
        if result.returncode == 0:
            s3.put_object(Bucket=bucket, Key=f"{prefix}/requirements.txt", Body=result.stdout)
    except Exception:
        pass

    # 4. Save metadata
    metadata = {
        "session_id": session_id,
        "microvm_id": session_state.get("microvm_id"),
        "checkpointed_at": datetime.now(timezone.utc).isoformat(),
        "execution_count": executor.get_stats()["execution_count"],
        "variables_count": len(namespace_to_save),
        "files_count": len(data_files),
    }
    s3.put_object(
        Bucket=bucket,
        Key=f"{prefix}/metadata.json",
        Body=json.dumps(metadata, indent=2),
        ContentType="application/json",
    )
    logger.info(f"   ✅ Checkpoint complete: s3://{bucket}/{prefix}/")


def _restore_from_s3(session_id: str):
    """
    Restore executor namespace + local files from a previous S3 checkpoint.
    """
    import io
    import tarfile
    import json
    import subprocess

    import boto3
    import dill

    bucket = _get_checkpoint_bucket()
    s3 = boto3.client("s3")
    prefix = f"sessions/{session_id}"

    # 1. Restore namespace
    try:
        logger.info("   Restoring namespace...")
        resp = s3.get_object(Bucket=bucket, Key=f"{prefix}/checkpoint.pkl")
        namespace = dill.loads(resp["Body"].read())
        executor._namespace.update(namespace)
        logger.info(f"   Restored {len(namespace)} variables")
    except Exception as e:
        logger.error(f"   Failed to restore namespace: {e}")

    # 2. Restore local files
    try:
        logger.info("   Restoring files...")
        resp = s3.get_object(Bucket=bucket, Key=f"{prefix}/files.tar.gz")
        tar_buffer = io.BytesIO(resp["Body"].read())
        with tarfile.open(fileobj=tar_buffer, mode='r:gz') as tar:
            tar.extractall(path="/tmp/")
        logger.info("   Files restored to /tmp/")
    except s3.exceptions.NoSuchKey:
        logger.info("   No files archive found (skipping)")
    except Exception as e:
        logger.error(f"   Failed to restore files: {e}")

    # 3. Install runtime packages (if any were added beyond pre-baked)
    try:
        resp = s3.get_object(Bucket=bucket, Key=f"{prefix}/requirements.txt")
        requirements = resp["Body"].read().decode("utf-8")
        if requirements.strip():
            logger.info("   Installing saved packages...")
            import sys
            import tempfile
            req_file = tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False)
            req_file.write(requirements)
            req_file.close()
            subprocess.run(
                [sys.executable, "-m", "pip", "install", "--quiet", "-r", req_file.name],
                timeout=45
            )
            os.unlink(req_file.name)
            logger.info("   Packages restored")
    except s3.exceptions.NoSuchKey:
        pass
    except Exception as e:
        logger.warning(f"   Package restore warning: {e}")

    logger.info(f"   ✅ Session restored from: {session_id}")
