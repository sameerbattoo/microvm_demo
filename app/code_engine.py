"""
Python code execution engine.

Endpoint:
  POST /execute - Execute Python code in the persistent sandbox namespace
"""

import asyncio
import logging

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

logger = logging.getLogger(__name__)

router = APIRouter(tags=["code-engine"])


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
