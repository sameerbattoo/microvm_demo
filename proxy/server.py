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

from fastapi import FastAPI
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
