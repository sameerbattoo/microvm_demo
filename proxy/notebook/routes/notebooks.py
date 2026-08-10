"""
Notebook CRUD API routes.

Part of: proxy.notebook (Notebook application layer)

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


@router.post("/import-from-url")
async def import_notebook_from_url(request: Request):
    """
    Import a notebook from a GitHub (or raw) URL.
    
    Accepts:
      - GitHub blob URLs: https://github.com/user/repo/blob/main/notebook.ipynb
      - Raw URLs: https://raw.githubusercontent.com/user/repo/main/notebook.ipynb
      - Any direct URL to a .ipynb or .notebook.json file
    
    Returns parsed cells in our format, ready to open as a new tab.
    """
    import httpx
    import re

    body = await request.json()
    url = body.get("url", "").strip()

    if not url:
        return Response(status_code=400, content='{"error": "url required"}', media_type="application/json")

    # Convert GitHub blob URLs to raw URLs
    # https://github.com/user/repo/blob/main/file.ipynb → https://raw.githubusercontent.com/user/repo/main/file.ipynb
    github_blob_pattern = r"https?://github\.com/([^/]+)/([^/]+)/blob/(.+)"
    match = re.match(github_blob_pattern, url)
    if match:
        user, repo, path = match.groups()
        url = f"https://raw.githubusercontent.com/{user}/{repo}/{path}"

    # Fetch the file
    try:
        async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
            resp = await client.get(url)
            if resp.status_code != 200:
                return Response(
                    status_code=400,
                    content=f'{{"error": "Failed to fetch: HTTP {resp.status_code}"}}',
                    media_type="application/json",
                )
            content = resp.text
    except Exception as e:
        return Response(
            status_code=500,
            content=f'{{"error": "Fetch error: {str(e)}"}}',
            media_type="application/json",
        )

    # Parse the notebook
    try:
        data = json.loads(content)
    except json.JSONDecodeError:
        return Response(status_code=400, content='{"error": "Not valid JSON"}', media_type="application/json")

    # Detect format: Jupyter .ipynb vs our .notebook.json
    cells = []
    name = url.rsplit("/", 1)[-1].rsplit(".", 1)[0]  # filename without extension

    if "nbformat" in data and "cells" in data:
        # Jupyter .ipynb format
        for cell in data["cells"]:
            cell_type = cell.get("cell_type", "code")
            source = cell.get("source", [])
            code = "".join(source) if isinstance(source, list) else (source or "")

            if cell_type == "markdown":
                cells.append({"type": "markdown", "code": code})
            elif cell_type == "code":
                # Detect %%sql magic
                if code.strip().startswith("%%sql"):
                    cells.append({"type": "sql", "code": code.strip().replace("%%sql\n", "").replace("%%sql", "")})
                else:
                    cells.append({"type": "code", "code": code})
            # Skip raw cells

        name = data.get("metadata", {}).get("title", name)

    elif "cells" in data and isinstance(data["cells"], list):
        # Our .notebook.json format
        cells = data["cells"]
        name = data.get("name", name)

    else:
        return Response(status_code=400, content='{"error": "Unrecognized notebook format"}', media_type="application/json")

    return {
        "name": name,
        "description": data.get("description", ""),
        "cells": cells,
        "source_url": url,
    }
