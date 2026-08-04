"""
MicroVM Notebook Proxy — Application Entrypoint

A lightweight proxy that:
1. Manages MicroVM lifecycle (launch, suspend, resume, terminate, rotation)
2. Proxies requests to MicroVMs with auth tokens injected
3. Serves notebook CRUD, metrics, session management, and AI chat APIs
4. Keeps AWS credentials server-side (never exposed to the browser)

Usage:
    python3 -m uvicorn proxy.server:app --port 8081

Architecture:
    proxy/
      server.py                 ← This file (app setup, startup, health, router registration)
      storage/                  ← Shared storage layer (interface + SQLite impl)
      platform/                 ← Smart MicroVM Service layer (reusable, app-agnostic)
        microvm_manager.py      ← VM lifecycle state (tokens, timers, cost, rotation)
        cost_tracker.py         ← Burst + baseline cost tracking with DB persistence
        routes/
          microvm.py            ← Launch, terminate, suspend, resume, proxy, instances
          sessions.py           ← S3 session checkpoints, data sources
          metrics.py            ← VM metrics, image tiers
      notebook/                 ← Notebook application layer (specific to this project)
        ai/                     ← AI agent module (Strands SDK + Bedrock)
        routes/
          ai.py                 ← AI chat, explain, fix, suggest-tag
          notebooks.py          ← Notebook CRUD
"""

import os
import asyncio
import logging

from fastapi import FastAPI, Request
from fastapi.responses import Response
from fastapi.middleware.cors import CORSMiddleware

from proxy.storage import storage, _connection_string
from proxy.platform.microvm_manager import MicrovmManager, POLL_INTERVAL_MS, AWS_REGION, IMAGE_ARN

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# --- FastAPI App ---
app = FastAPI(title="MicroVM Token Proxy")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Initialize storage ---
storage.initialize(connection_string=_connection_string)

# --- Initialize MicroVM manager (shared state) ---
app.state.vm_manager = MicrovmManager()

# --- Register route modules ---
# Platform layer (MicroVM lifecycle, sessions, metrics)
from proxy.platform.routes.microvm import router as microvm_router
from proxy.platform.routes.sessions import router as sessions_router
from proxy.platform.routes.metrics import router as metrics_router

# Notebook layer (AI, notebook CRUD)
from proxy.notebook.routes.notebooks import router as notebooks_router
from proxy.notebook.routes.ai import router as ai_router

app.include_router(microvm_router)
app.include_router(notebooks_router)
app.include_router(metrics_router)
app.include_router(sessions_router)
app.include_router(ai_router)


# --- Background tasks ---
METRICS_RETENTION_HOURS = int(os.environ.get("METRICS_RETENTION_HOURS", "24"))


async def _housekeeping_loop():
    """Periodic cleanup: old metrics data."""
    while True:
        await asyncio.sleep(60)
        try:
            storage.metrics_cleanup(hours=METRICS_RETENTION_HOURS)
        except Exception:
            pass


@app.on_event("startup")
async def _on_startup():
    """Start background tasks and restore state from DB."""
    asyncio.create_task(_housekeeping_loop())
    app.state.vm_manager.restore_timers_from_db()
    # Restore cost tracking state from database
    app.state.vm_manager.cost_tracker.load_from_db(storage)

    # Set up rotation swap callback — updates session registry + active_microvms when VMs are swapped
    def on_rotation_swap(session_id: str, new_vm_id: str, new_endpoint: str):
        """Called by SessionRotator after a successful VM swap."""
        vm_manager = app.state.vm_manager
        # Update session registry to point to new VM
        vm_manager.register_session(session_id, new_vm_id, new_endpoint)
        # Assign session_id to the new VM's active_microvms entry
        if new_vm_id in vm_manager.active_microvms:
            vm_manager.active_microvms[new_vm_id]["session_id"] = session_id
            vm_manager.active_microvms[new_vm_id].pop("_rotation_pending", None)
        logger.info(f"🔄 Swap callback: session {session_id} → VM {new_vm_id}")

    app.state.vm_manager.session_rotator.set_swap_callback(on_rotation_swap)


# --- Health endpoint ---
@app.get("/health")
async def health():
    vm_manager = app.state.vm_manager
    return {
        "status": "proxy running",
        "region": AWS_REGION,
        "image_arn": IMAGE_ARN or "(not configured)",
        "cached_tokens": len(vm_manager.token_cache),
        "active_instances": len(vm_manager.active_microvms),
        "poll_interval_ms": POLL_INTERVAL_MS,
        "persistence_mode": os.environ.get("SESSION_PERSISTENCE_MODE", "eternal"),
        "max_lifetime_seconds": int(os.environ.get("MAX_LIFETIME_SECONDS", "28800")),
        "rotation_lead_seconds": int(os.environ.get("ROTATION_LEAD_SECONDS", "60")),
    }


# --- Package categories endpoint ---
@app.get("/package-categories")
async def package_categories(session_id: str = None):
    """
    Return package categorization data for the frontend.
    - categories: static mapping of package → category
    - import_aliases: recommended import statements
    - category_order: display order for category groups
    - user_installed: packages installed by the user in this session (with categories)
    """
    from proxy.platform.package_classifier import get_all_categories, get_all_import_aliases, get_category_order

    vm_manager = app.state.vm_manager
    user_packages = []
    if session_id:
        user_packages = vm_manager.get_user_installed_packages(session_id)

    return {
        "categories": get_all_categories(),
        "import_aliases": get_all_import_aliases(),
        "category_order": get_category_order(),
        "user_installed": user_packages,
    }


@app.post("/track-install")
async def track_install(request: Request):
    """
    Track a user-installed package for categorization.
    Called by the frontend after a successful pip install.
    Body: { "session_id": "...", "package": "seaborn" }
    """
    from proxy.platform.package_classifier import classify_and_cache, get_import_alias

    body = await request.json()
    session_id = body.get("session_id", "")
    package = body.get("package", "")

    if not package:
        return Response(status_code=400, content='{"error": "package required"}', media_type="application/json")

    # Classify the package (static first, then PyPI lookup)
    category = await classify_and_cache(package)
    import_alias = get_import_alias(package)

    # Store in vm_manager (only if session provided)
    if session_id:
        vm_manager = app.state.vm_manager
        vm_manager.record_user_install(session_id, package, category)

    return {"package": package, "category": category, "import_alias": import_alias}
