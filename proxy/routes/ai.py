"""
AI Notebook Agent routes — chat, explain, fix, suggest-tag.

Endpoints:
  GET    /ai/config             - AI availability and model info
  POST   /ai/chat               - Conversational chat (SSE streaming)
  POST   /ai/chat/sync          - Conversational chat (JSON response)
  DELETE /ai/chat/{session_id}  - Clear conversation history
  POST   /ai/explain            - Explain cell output
  POST   /ai/fix                - Fix cell error
  POST   /ai/suggest-tag        - Suggest notebook category tag
"""

import os
import json
import asyncio
import logging

import boto3
from fastapi import APIRouter, Request, Response
from starlette.responses import StreamingResponse

from proxy.ai.constants import (
    TAG_TEMPERATURE, TAG_MAX_TOKENS, TAG_MAX_LENGTH, MAX_CELLS_FOR_TAG,
    BEDROCK_MAX_RETRIES, BEDROCK_READ_TIMEOUT, BEDROCK_CONNECT_TIMEOUT,
)
from proxy.ai.notebook_agent import (
    chat as agent_chat,
    chat_stream as agent_chat_stream,
    explain as agent_explain,
    fix_error as agent_fix_error,
    new_thread as agent_new_thread,
)
from proxy.microvm_manager import AWS_REGION
from proxy.storage import storage

logger = logging.getLogger(__name__)

AI_MODEL_ID = os.environ.get("BEDROCK_MODEL_ID", "us.anthropic.claude-sonnet-4-6")
AI_REGION = os.environ.get("BEDROCK_REGION", AWS_REGION)

_bedrock_client = None

router = APIRouter(tags=["ai"])


def _get_bedrock_client():
    """Get a Bedrock Runtime client for lightweight calls (tag suggestion)."""
    global _bedrock_client
    if _bedrock_client is None:
        from botocore.config import Config
        bedrock_config = Config(
            retries={'max_attempts': BEDROCK_MAX_RETRIES, 'mode': 'standard'},
            read_timeout=BEDROCK_READ_TIMEOUT,
            connect_timeout=BEDROCK_CONNECT_TIMEOUT,
        )
        _bedrock_client = boto3.client(
            "bedrock-runtime",
            region_name=AI_REGION,
            config=bedrock_config,
        )
    return _bedrock_client


@router.get("/ai/config")
async def ai_config():
    """Return AI configuration and availability."""
    ai_available = False
    try:
        session = boto3.Session(region_name=AI_REGION)
        credentials = session.get_credentials()
        if credentials and credentials.get_frozen_credentials().access_key:
            ai_available = True
    except Exception:
        pass
    return {"model_id": AI_MODEL_ID, "region": AI_REGION, "ai_available": ai_available}


@router.post("/ai/chat")
async def ai_chat(request: Request):
    """Conversational chat with the notebook AI agent (SSE streaming)."""
    vm_manager = request.app.state.vm_manager
    body = await request.json()
    session_id = body.get("session_id", "")
    message = body.get("message", "").strip()
    notebook_cells = body.get("cells", [])
    microvm_id = body.get("microvm_id", "")
    microvm_endpoint = body.get("microvm_endpoint", "")
    packages = body.get("packages", [])
    data_sources = body.get("data_sources")

    if not message:
        return Response(status_code=400, content='{"error": "No message provided"}', media_type="application/json")
    if not session_id:
        return Response(status_code=400, content='{"error": "No session_id provided"}', media_type="application/json")

    context = {
        "proxy_url": f"http://localhost:{os.environ.get('PROXY_PORT', '8081')}",
        "microvm_id": microvm_id,
        "microvm_endpoint": microvm_endpoint,
        "notebook_cells": notebook_cells,
        "memory_mib": vm_manager.active_microvms.get(microvm_id, {}).get("memory_mib"),
        "data_sources": data_sources,
        "packages": packages,
        "uploaded_files": body.get("uploaded_files", []),
    }

    logger.info(f"AI chat: session={session_id[:8]}... message={message[:60]}...")

    async def event_stream():
        try:
            async for event in agent_chat_stream(session_id, message, context):
                yield f"data: {json.dumps(event)}\n\n"
            yield f"data: {json.dumps({'type': 'done'})}\n\n"
        except Exception as e:
            logger.error(f"AI chat stream error: {e}")
            yield f"data: {json.dumps({'type': 'error', 'content': str(e)})}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@router.post("/ai/chat/sync")
async def ai_chat_sync(request: Request):
    """Non-streaming chat (JSON response)."""
    vm_manager = request.app.state.vm_manager
    body = await request.json()
    session_id = body.get("session_id", "")
    message = body.get("message", "").strip()
    notebook_cells = body.get("cells", [])
    microvm_id = body.get("microvm_id", "")
    microvm_endpoint = body.get("microvm_endpoint", "")
    active_cell_index = body.get("active_cell_index")
    packages = body.get("packages", [])
    data_sources = body.get("data_sources")

    if not message or not session_id:
        return Response(status_code=400, content='{"error": "session_id and message required"}', media_type="application/json")

    if active_cell_index is not None and notebook_cells and active_cell_index < len(notebook_cells):
        active_cell = notebook_cells[active_cell_index]
        message = f"[User is currently focused on Cell {active_cell_index} which contains: {(active_cell.get('code', ''))[:150]}]\n\n" + message

    pkg_list = body.get("packages", [])
    if pkg_list:
        pkg_names = [p.get("name", "") for p in pkg_list[:30]]
        message = f"[Installed packages: {', '.join(pkg_names)}]\n\n" + message

    context = {
        "proxy_url": f"http://localhost:{os.environ.get('PROXY_PORT', '8081')}",
        "microvm_id": microvm_id,
        "microvm_endpoint": microvm_endpoint,
        "notebook_cells": notebook_cells,
        "data_sources": data_sources,
        "packages": packages,
        "uploaded_files": body.get("uploaded_files", []),
        "memory_mib": vm_manager.active_microvms.get(microvm_id, {}).get("memory_mib"),
    }

    try:
        response_text = await asyncio.to_thread(agent_chat, session_id, message, context)
        return {"response": response_text, "session_id": session_id}
    except Exception as e:
        logger.error(f"AI chat error: {e}")
        return Response(status_code=500, content=f'{{"error": "AI chat failed: {str(e)}"}}', media_type="application/json")


@router.delete("/ai/chat/{session_id}")
async def ai_clear_chat(session_id: str):
    """Clear conversation history for a session (agent memory + DB)."""
    agent_new_thread(session_id)
    storage.ai_session_delete(session_id)
    return {"status": "cleared", "session_id": session_id}


@router.post("/ai/explain")
async def ai_explain_output(request: Request):
    """Explain a cell's output in plain language."""
    body = await request.json()
    code = body.get("code", "")
    output = body.get("output", "")
    microvm_id = body.get("microvm_id", "")
    microvm_endpoint = body.get("microvm_endpoint", "")

    if not code and not output:
        return Response(status_code=400, content='{"error": "code and/or output required"}', media_type="application/json")

    context = {
        "proxy_url": f"http://localhost:{os.environ.get('PROXY_PORT', '8081')}",
        "microvm_id": microvm_id,
        "microvm_endpoint": microvm_endpoint,
    }

    try:
        result = await asyncio.to_thread(agent_explain, code, output, context)
        # agent_explain returns {"summary": str, "explanation": str}
        return {
            "summary": result.get("summary", "") if isinstance(result, dict) else "",
            "explanation": result.get("explanation", str(result)) if isinstance(result, dict) else str(result),
        }
    except Exception as e:
        logger.error(f"AI explain error: {e}")
        return Response(status_code=500, content=f'{{"error": "Explain failed: {str(e)}"}}', media_type="application/json")


@router.post("/ai/fix")
async def ai_fix_error(request: Request):
    """Fix a cell's error and return corrected code."""
    body = await request.json()
    code = body.get("code", "")
    error = body.get("error", "")
    microvm_id = body.get("microvm_id", "")
    microvm_endpoint = body.get("microvm_endpoint", "")

    if not code or not error:
        return Response(status_code=400, content='{"error": "code and error required"}', media_type="application/json")

    context = {
        "proxy_url": f"http://localhost:{os.environ.get('PROXY_PORT', '8081')}",
        "microvm_id": microvm_id,
        "microvm_endpoint": microvm_endpoint,
    }

    try:
        fixed_code = await asyncio.to_thread(agent_fix_error, code, error, context)
        return {"fixed_code": fixed_code}
    except Exception as e:
        logger.error(f"AI fix error: {e}")
        return Response(status_code=500, content=f'{{"error": "Fix failed: {str(e)}"}}', media_type="application/json")


@router.post("/ai/suggest-tag")
async def ai_suggest_tag(request: Request):
    """Suggest a category tag for a notebook based on its cells."""
    body = await request.json()
    notebook_name = body.get("name", "")
    description = body.get("description", "")
    cells = body.get("cells", [])

    if not cells:
        return {"tag": "Drafts"}

    cell_summaries = []
    for cell in cells[:MAX_CELLS_FOR_TAG]:
        code = (cell.get("code", "") or "")[:200]
        cell_type = cell.get("type", "code")
        cell_summaries.append(f"[{cell_type}] {code}")

    context = "\n".join(cell_summaries)
    desc_line = f'\nDescription: "{description}"' if description else ""

    prompt = f"""Given this notebook titled "{notebook_name}"{desc_line} with these cells:
{context}

Respond with ONLY a single short category tag (1-2 words) for this notebook.
Examples: Analytics, ML Training, Data Cleaning, API Integration, Visualization, ETL, Exploration, Finance, Statistics, Web Scraping, NLP, Time Series, Geospatial.
Tag:"""

    try:
        client = _get_bedrock_client()
        response = client.converse(
            modelId=AI_MODEL_ID,
            messages=[{"role": "user", "content": [{"text": prompt}]}],
            inferenceConfig={"maxTokens": TAG_MAX_TOKENS, "temperature": TAG_TEMPERATURE},
        )
        output = response["output"]["message"]["content"][0]["text"].strip()
        tag = " ".join(output.split()[:2]).strip(".,;:!\"'")
        if not tag or len(tag) > TAG_MAX_LENGTH:
            tag = "Exploration"
        logger.info(f"AI suggested tag: '{tag}' for notebook '{notebook_name}'")
        return {"tag": tag}
    except Exception as e:
        logger.warning(f"AI tag suggestion failed: {e}")
        return {"tag": "Exploration"}


# ============================================================
# AI CHAT HISTORY (persisted to DB)
# ============================================================

@router.get("/ai/chat/{session_id}/messages")
async def ai_get_messages(session_id: str):
    """Get saved chat messages for a session."""
    messages = storage.ai_session_get(session_id)
    return {"messages": messages}


@router.put("/ai/chat/{session_id}/messages")
async def ai_save_messages(session_id: str, request: Request):
    """Save chat messages for a session."""
    body = await request.json()
    messages = body.get("messages", [])
    notebook_id = body.get("notebook_id", "")
    storage.ai_session_save(session_id, notebook_id, messages)
    return {"status": "saved"}
