"""
Notebook CRUD API routes.

Endpoints:
  GET    /notebooks           - List all notebooks
  GET    /notebooks/{id}      - Get a notebook
  POST   /notebooks           - Create a notebook
  PUT    /notebooks/{id}      - Update a notebook (upsert)
  DELETE /notebooks/{id}      - Delete a notebook
"""

import json
from datetime import datetime, timezone

from fastapi import APIRouter, Request, Response

from proxy.storage import storage

router = APIRouter(tags=["notebooks"])


@router.get("/notebooks")
async def notebook_list():
    """List all notebooks."""
    return {"notebooks": storage.notebook_list()}


@router.get("/notebooks/{notebook_id}")
async def notebook_get(notebook_id: str):
    """Get a single notebook by ID."""
    nb = storage.notebook_get(notebook_id)
    if not nb:
        return Response(status_code=404, content='{"error": "Notebook not found"}', media_type="application/json")
    return nb


@router.post("/notebooks")
async def notebook_create(request: Request):
    """Create a new notebook."""
    body = await request.json()
    notebook_id = body.get("id", str(int(datetime.now(timezone.utc).timestamp() * 1000)))
    name = body.get("name", f"Notebook {notebook_id}")
    description = body.get("description", "")
    tag = body.get("tag", "Drafts")
    cells = body.get("cells", [])
    result = storage.notebook_create(notebook_id, name, description, tag, cells)
    return result


@router.put("/notebooks/{notebook_id}")
async def notebook_update(notebook_id: str, request: Request):
    """Update a notebook (partial update — only send changed fields)."""
    body = await request.json()
    if "cells" in body:
        body["cells_json"] = json.dumps(body.pop("cells"))
    success = storage.notebook_update(notebook_id, **body)
    if not success:
        # Notebook doesn't exist yet — create it (upsert behavior)
        name = body.get("name", f"Notebook {notebook_id}")
        desc = body.get("description", "")
        tag = body.get("tag", "Drafts")
        cells = json.loads(body.get("cells_json", "[]"))
        storage.notebook_create(notebook_id, name, desc, tag, cells)
    return {"success": True}


@router.delete("/notebooks/{notebook_id}")
async def notebook_delete(notebook_id: str):
    """Delete a notebook."""
    success = storage.notebook_delete(notebook_id)
    return {"success": success}
