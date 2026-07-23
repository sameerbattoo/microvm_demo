"""
MicroVM Notebook Proxy — Application Entrypoint

A lightweight proxy that:
1. Manages MicroVM lifecycle (launch, suspend, resume, terminate)
2. Proxies requests to MicroVMs with auth tokens injected
3. Serves notebook CRUD, metrics, session management, and AI chat APIs
4. Keeps AWS credentials server-side (never exposed to the browser)

Usage:
    python3 -m uvicorn proxy.server:app --port 8081

Architecture:
    proxy/
      server.py              ← This file (app setup, startup, health)
      microvm_manager.py     ← MicroVM lifecycle state (tokens, timers, cost)
      routes/
        microvm.py           ← Launch, terminate, suspend, resume, proxy, instances
        notebooks.py         ← Notebook CRUD
        metrics.py           ← Metrics, image tiers, packages
        sessions.py          ← S3 session checkpoints, data sources
        ai.py                ← AI chat, explain, fix, suggest-tag
      storage/
        __init__.py          ← Storage backend selection
        interface.py         ← Abstract storage contract
        sqlite_db.py         ← SQLite implementation
"""

import os
import asyncio
import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from proxy.storage import storage, _connection_string
from proxy.microvm_manager import MicrovmManager, POLL_INTERVAL_MS, AWS_REGION, IMAGE_ARN

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
from proxy.routes.microvm import router as microvm_router
from proxy.routes.notebooks import router as notebooks_router
from proxy.routes.metrics import router as metrics_router
from proxy.routes.sessions import router as sessions_router
from proxy.routes.ai import router as ai_router

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
    }
