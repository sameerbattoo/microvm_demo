"""
Python code execution engine.

Part of: app.notebook (application layer)

Endpoint:
  POST /execute - Execute Python code in the persistent sandbox namespace
"""

import asyncio
import logging

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

logger = logging.getLogger(__name__)

router = APIRouter(tags=["code-engine"])


def _get_execute_lock(request: Request) -> asyncio.Lock:
    """Get or create the shared execution lock on app.state.
    Ensures only one code/SQL execution runs at a time on the single-threaded
    SandboxExecutor (which redirects sys.stdout — not safe for concurrent use)."""
    if not hasattr(request.app.state, '_execute_lock'):
        request.app.state._execute_lock = asyncio.Lock()
    return request.app.state._execute_lock


@router.post("/execute")
async def execute_code(request: Request):
    """Execute Python code in the persistent sandbox namespace."""
    executor = request.app.state.executor
    session_state = request.app.state.session_state
    session_state["request_count"] += 1

    body = await request.json()
    code = body.get("code", "")
    cell_id = body.get("cell_id")  # frontend cell id, recorded as variable provenance
    if not code.strip():
        return JSONResponse(status_code=400, content={"error": "No code provided. Send {\"code\": \"...\"}"})

    logger.info(f"▶ Executing code (len={len(code)})")
    lock = _get_execute_lock(request)
    async with lock:
        result = await asyncio.to_thread(executor.execute, code, cell_id)

    # Log outcome with context for CloudWatch observability
    # Find the first meaningful line (skip @param annotations and blank lines)
    code_lines = code.strip().split('\n')
    snippet_lines = [l for l in code_lines if l.strip() and not l.strip().startswith('# @param')]
    first_line = snippet_lines[0][:80] if snippet_lines else code_lines[0][:80]
    if result.success:
        vars_info = f" vars={result.variables_created}" if result.variables_created else ""
        logger.info(f"  ✓ OK ({result.execution_time_ms:.0f}ms){vars_info} | {first_line}")
    else:
        logger.warning(f"  ✗ ERROR ({result.execution_time_ms:.0f}ms) | {first_line}")
        logger.warning(f"    {result.error}")

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
