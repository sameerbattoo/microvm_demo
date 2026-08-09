"""
MicroVM Notebook Proxy — Application Entrypoint

A lightweight proxy that:
1. Manages MicroVM lifecycle (launch, suspend, resume, terminate, rotation)
2. Proxies requests to MicroVMs with auth tokens injected
3. Relays WebSocket terminal sessions to MicroVM shell (SHELL_INGRESS)
4. Serves notebook CRUD, metrics, session management, and AI chat APIs
5. Keeps AWS credentials server-side (never exposed to the browser)

Usage:
    python3 -m uvicorn proxy.server:app --port 8081

Architecture:
    proxy/
      server.py                 ← This file (app setup, startup, health, WS terminal relay)
      storage/                  ← Shared storage layer (interface + SQLite impl)
      platform/                 ← Smart MicroVM Service layer (reusable, app-agnostic)
        microvm_manager.py      ← VM lifecycle state (tokens, timers, cost, rotation)
        cost_tracker.py         ← Burst + baseline cost tracking with DB persistence
        session_rotator.py      ← Transparent VM rotation before max-lifetime
        package_classifier.py   ← PyPI-based package category detection
        datasources/            ← Schema discovery (S3, DynamoDB, Athena, local files)
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

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
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


# --- WebSocket Terminal Relay ---
@app.websocket("/ws/terminal")
async def ws_terminal_relay(websocket: WebSocket, session_id: str = ""):
    """
    WebSocket relay: browser ← WS → proxy ← WS → MicroVM (platform shell).
    
    Uses Lambda MicroVM's built-in SHELL_INGRESS connector for interactive
    terminal access. Auth is passed via WebSocket subprotocols (not headers).
    
    The session_id is passed as a query parameter.
    Example: ws://localhost:8081/ws/terminal?session_id=abc-123
    """
    import websockets
    import asyncio

    if not session_id:
        await websocket.close(code=4001, reason="session_id query param required")
        return

    vm_manager = app.state.vm_manager
    session_vm = vm_manager.get_session_vm(session_id)
    if not session_vm:
        await websocket.close(code=4004, reason="Session not found")
        return

    endpoint = session_vm["endpoint"]
    microvm_id = session_vm["vm_id"]

    # Get shell-specific auth token (requires SHELL_INGRESS connector)
    try:
        token = vm_manager.get_shell_auth_token(microvm_id)
    except Exception as e:
        await websocket.close(code=4003, reason=f"Shell token error: {e}")
        return

    # Lambda MicroVM WebSocket auth uses subprotocols (not headers)
    # See: https://docs.aws.amazon.com/lambda/latest/dg/microvms-launching.html
    ws_url = f"wss://{endpoint}/ws/shell"
    subprotocols = [
        "lambda-microvms",
        f"lambda-microvms.authentication.{token}",
    ]

    await websocket.accept()
    logger.info(f"Terminal WebSocket: browser connected for session {session_id}")

    try:
        import ssl
        ssl_context = ssl.create_default_context()
        ssl_context.check_hostname = False
        ssl_context.verify_mode = ssl.CERT_NONE

        # Retry connection up to 3 times (VM may be resuming from suspend)
        vm_ws = None
        for attempt in range(3):
            try:
                vm_ws = await websockets.connect(
                    ws_url, subprotocols=subprotocols, ssl=ssl_context, open_timeout=10
                )
                # Check for immediate error message (shell not ready)
                first_msg = await asyncio.wait_for(vm_ws.recv(), timeout=5)
                if isinstance(first_msg, str) and '"session_error"' in first_msg:
                    logger.warning(f"Terminal shell not ready (attempt {attempt+1}/3): {first_msg[:100]}")
                    await vm_ws.close()
                    vm_ws = None
                    if attempt < 2:
                        await asyncio.sleep(2 * (attempt + 1))  # Exponential: 2s, 4s
                        continue
                    else:
                        # Forward error to browser
                        await websocket.send_text(first_msg)
                        return
                else:
                    # Forward the first message (session_init) to browser
                    if isinstance(first_msg, bytes):
                        await websocket.send_bytes(first_msg)
                    else:
                        await websocket.send_text(first_msg)
                    break
            except Exception as e:
                logger.warning(f"Terminal connect attempt {attempt+1}/3 failed: {e}")
                if vm_ws:
                    await vm_ws.close()
                    vm_ws = None
                if attempt < 2:
                    await asyncio.sleep(2)
                else:
                    raise

        if not vm_ws:
            return

        logger.info(f"Terminal WebSocket: connected to VM {microvm_id} shell")

        async def browser_to_vm():
            """Relay browser → VM (text input from xterm.js)."""
            try:
                while True:
                    msg = await websocket.receive()
                    if msg.get("text"):
                        await vm_ws.send(msg["text"])
                    elif msg.get("bytes"):
                        await vm_ws.send(msg["bytes"])
            except (WebSocketDisconnect, Exception):
                pass

        async def vm_to_browser():
            """Relay VM → browser (binary PTY output from platform shell)."""
            try:
                async for message in vm_ws:
                    if isinstance(message, bytes):
                        await websocket.send_bytes(message)
                    else:
                        await websocket.send_text(message)
            except Exception:
                pass

        # Run both directions — cancel the other when one ends
        tasks = [
            asyncio.create_task(browser_to_vm()),
            asyncio.create_task(vm_to_browser()),
        ]
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for t in pending:
            t.cancel()
        await vm_ws.close()
    except Exception as e:
        logger.warning(f"Terminal WebSocket error: {e}")
    finally:
        try:
            await websocket.close()
        except Exception:
            pass
        logger.info(f"Terminal WebSocket: closed for session {session_id}")
