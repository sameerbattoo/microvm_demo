"""
WebSocket terminal relay — interactive shell access to MicroVMs.

Part of: proxy.platform (Smart MicroVM Service layer)

Architecture:
  Browser (xterm.js) ←WS→ Proxy (this relay) ←WSS→ Lambda MicroVM (SHELL_INGRESS)

The SHELL_INGRESS connector provides a platform-managed bash PTY inside the VM.
Auth is passed via WebSocket subprotocols (not HTTP headers) per the Lambda
MicroVM protocol spec.

Protocol:
  1. Browser connects: ws://proxy/ws/terminal?session_id=<uuid>
  2. Proxy resolves session → VM, gets shell auth token
  3. Proxy connects to VM: wss://<endpoint>/ws/shell with subprotocol auth
  4. VM sends session_init JSON → forwarded to browser
  5. Bidirectional relay: browser keystrokes → VM, PTY output → browser
  6. On disconnect (browser or VM): cancel other direction, close both
"""

import asyncio
import logging
import ssl

import certifi
import websockets
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

logger = logging.getLogger(__name__)

router = APIRouter(tags=["terminal"])

# Retry config for connecting to VM shell (VM may be resuming from suspend)
MAX_CONNECT_RETRIES = 3
FIRST_MSG_TIMEOUT = 5  # seconds to wait for session_init or session_error
RETRY_BACKOFF_BASE = 2  # seconds (exponential: 2s, 4s)


def _create_ssl_context() -> ssl.SSLContext:
    """Create SSL context with proper CA verification (Amazon Trust CAs)."""
    return ssl.create_default_context(cafile=certifi.where())


async def _connect_to_vm_shell(
    ws_url: str,
    subprotocols: list[str],
    ssl_context: ssl.SSLContext,
    browser_ws: WebSocket,
) -> websockets.WebSocketClientProtocol | None:
    """
    Connect to the VM's shell endpoint with retry logic.
    
    Retries handle the case where the VM is resuming from suspend —
    the shell isn't available immediately after auto-resume.
    
    Returns the connected VM WebSocket, or None if all retries failed.
    The first message (session_init) is forwarded to the browser.
    """
    vm_ws = None

    for attempt in range(MAX_CONNECT_RETRIES):
        try:
            vm_ws = await websockets.connect(
                ws_url, subprotocols=subprotocols, ssl=ssl_context, open_timeout=10
            )

            # Read first message — either session_init (success) or session_error
            first_msg = await asyncio.wait_for(vm_ws.recv(), timeout=FIRST_MSG_TIMEOUT)

            if isinstance(first_msg, str) and '"session_error"' in first_msg:
                logger.warning(
                    f"Shell not ready (attempt {attempt + 1}/{MAX_CONNECT_RETRIES}): "
                    f"{first_msg[:100]}"
                )
                await vm_ws.close()
                vm_ws = None

                if attempt < MAX_CONNECT_RETRIES - 1:
                    await asyncio.sleep(RETRY_BACKOFF_BASE * (attempt + 1))
                    continue
                else:
                    # Final retry failed — forward error to browser
                    await browser_ws.send_text(first_msg)
                    return None
            else:
                # Success — forward session_init to browser
                if isinstance(first_msg, bytes):
                    await browser_ws.send_bytes(first_msg)
                else:
                    await browser_ws.send_text(first_msg)
                return vm_ws

        except Exception as e:
            logger.warning(f"Shell connect attempt {attempt + 1}/{MAX_CONNECT_RETRIES} failed: {e}")
            if vm_ws:
                await vm_ws.close()
                vm_ws = None
            if attempt < MAX_CONNECT_RETRIES - 1:
                await asyncio.sleep(RETRY_BACKOFF_BASE)
            else:
                raise

    return None


async def _relay_browser_to_vm(
    browser_ws: WebSocket,
    vm_ws: websockets.WebSocketClientProtocol,
):
    """Relay keystrokes from browser (xterm.js) to VM shell."""
    try:
        while True:
            msg = await browser_ws.receive()
            if msg.get("text"):
                await vm_ws.send(msg["text"])
            elif msg.get("bytes"):
                await vm_ws.send(msg["bytes"])
    except (WebSocketDisconnect, Exception):
        pass


async def _relay_vm_to_browser(
    vm_ws: websockets.WebSocketClientProtocol,
    browser_ws: WebSocket,
):
    """Relay PTY output from VM shell to browser (binary or text frames)."""
    try:
        async for message in vm_ws:
            if isinstance(message, bytes):
                await browser_ws.send_bytes(message)
            else:
                await browser_ws.send_text(message)
    except Exception:
        pass


@router.websocket("/ws/terminal")
async def ws_terminal_relay(websocket: WebSocket, session_id: str = ""):
    """
    WebSocket endpoint: relays an interactive terminal session between
    the browser and a MicroVM's platform shell.
    
    Query params:
      session_id — the notebook session (maps to a specific VM)
    """
    if not session_id:
        await websocket.close(code=4001, reason="session_id query param required")
        return

    # Resolve session → VM
    vm_manager = websocket.app.state.vm_manager
    session_vm = vm_manager.get_session_vm(session_id)

    if not session_vm:
        await websocket.close(code=4004, reason="Session not found")
        return

    endpoint = session_vm["endpoint"]
    microvm_id = session_vm["vm_id"]

    # Get shell-specific auth token (requires SHELL_INGRESS connector on the VM)
    try:
        token = vm_manager.get_shell_auth_token(microvm_id)
    except Exception as e:
        await websocket.close(code=4003, reason=f"Shell token error: {e}")
        return

    # Build WebSocket URL and subprotocol auth
    ws_url = f"wss://{endpoint}/ws/shell"
    subprotocols = [
        "lambda-microvms",
        f"lambda-microvms.authentication.{token}",
    ]

    # Accept browser connection
    await websocket.accept()
    logger.info(f"Terminal WebSocket: browser connected for session {session_id}")

    try:
        ssl_context = _create_ssl_context()

        # Connect to VM shell (with retry for suspended VMs)
        vm_ws = await _connect_to_vm_shell(ws_url, subprotocols, ssl_context, websocket)
        if not vm_ws:
            return

        logger.info(f"Terminal WebSocket: connected to VM {microvm_id} shell")

        # Bidirectional relay — cancel the other direction when one ends
        tasks = [
            asyncio.create_task(_relay_browser_to_vm(websocket, vm_ws)),
            asyncio.create_task(_relay_vm_to_browser(vm_ws, websocket)),
        ]
        _done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
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
