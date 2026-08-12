"""
MicroVM Manager — encapsulates all MicroVM lifecycle state.

Part of: proxy.platform (Smart MicroVM Service layer)

This class manages:
- AWS Lambda MicroVMs client
- Auth token cache (bounded LRU) — both HTTP and shell tokens
- Shell auth tokens for WebSocket terminal access (SHELL_INGRESS connector)
- Active MicroVM tracking (endpoint, session, memory tier)
- Pre-termination wake timers (workaround for suspended VM terminate hook issue)
- Cost tracking (baseline + burst metering)
- Artifacts bucket discovery
- Session-to-VM mapping for request routing

Network connectors:
- HTTP_INGRESS: Standard HTTPS endpoint for API requests
- SHELL_INGRESS: WebSocket-based interactive shell (platform-managed PTY)
- INTERNET_EGRESS: Outbound internet access for pip install, git clone, etc.

All route modules access this via app.state.vm_manager.
"""

import os
import time
import asyncio
import logging
import httpx
from collections import OrderedDict
from datetime import datetime, timezone

import boto3

from proxy.storage import storage
from proxy.platform.cost_tracker import CostTracker

logger = logging.getLogger(__name__)

# --- Configuration (from environment) ---
AWS_REGION = os.environ.get("AWS_REGION", "us-west-2")
IMAGE_ARN = os.environ.get("MICROVM_IMAGE_ARN", "")
EXEC_ROLE_ARN = os.environ.get("MICROVM_EXEC_ROLE_ARN", "")
POLL_INTERVAL_MS = int(os.environ.get("POLL_INTERVAL_MS", "10000"))
INGRESS_CONNECTOR = os.environ.get("MICROVM_INGRESS_CONNECTOR",
    f"arn:aws:lambda:{AWS_REGION}:aws:network-connector:aws-network-connector:HTTP_INGRESS")
SHELL_INGRESS_CONNECTOR = os.environ.get("MICROVM_SHELL_INGRESS_CONNECTOR",
    f"arn:aws:lambda:{AWS_REGION}:aws:network-connector:aws-network-connector:SHELL_INGRESS")
EGRESS_CONNECTOR = os.environ.get("MICROVM_EGRESS_CONNECTOR",
    f"arn:aws:lambda:{AWS_REGION}:aws:network-connector:aws-network-connector:INTERNET_EGRESS")

TOKEN_CACHE_MAX_SIZE = 100


class BoundedTokenCache:
    """
    LRU-bounded token cache to prevent unbounded memory growth. Thread-safe.

    Eviction policy: Least-Recently-Used (LRU).
    - get() promotes the accessed item to most-recent (move_to_end).
    - set() promotes updated items to most-recent.
    - When capacity is exceeded, popitem(last=False) evicts from the front
      (the item that hasn't been accessed/updated the longest).
    """

    def __init__(self, max_size: int = TOKEN_CACHE_MAX_SIZE):
        self._cache: OrderedDict[str, dict] = OrderedDict()
        self._max_size = max_size
        self._lock = __import__('threading').Lock()

    def get(self, key: str) -> dict | None:
        with self._lock:
            if key in self._cache:
                self._cache.move_to_end(key)
                return self._cache[key]
            return None

    def set(self, key: str, value: dict):
        with self._lock:
            if key in self._cache:
                self._cache.move_to_end(key)
            self._cache[key] = value
            while len(self._cache) > self._max_size:
                self._cache.popitem(last=False)

    def __len__(self):
        return len(self._cache)

    def pop(self, key: str, default=None):
        with self._lock:
            return self._cache.pop(key, default)


class MicrovmManager:
    """
    Central manager for MicroVM lifecycle operations.

    Holds all shared state that route handlers need:
    - Lambda MicroVMs client
    - Token cache
    - Active VM tracking
    - Pre-termination timers
    - Cost tracker
    """

    def __init__(self):
        self.token_cache = BoundedTokenCache()
        self.active_microvms: dict[str, dict] = {}
        self.cost_tracker = CostTracker()
        self._lambda_client = None
        self._artifacts_bucket: str | None = os.environ.get("ARTIFACT_BUCKET")
        self._pre_terminate_timers: dict[str, asyncio.Task] = {}

        # Session rotator — manages automatic VM rotation before max-lifetime
        from proxy.platform.session_rotator import SessionRotator
        self.session_rotator = SessionRotator(self)

        # Session registry — maps session_id → current VM info
        # This is the single source of truth for "which VM serves this session?"
        # Updated on launch, rotation swap, and terminate.
        self._session_registry: dict[str, dict] = {}  # session_id → {vm_id, endpoint}

        # User-installed packages per session (for categorization display)
        self._user_installed: dict[str, list[dict]] = {}  # session_id → [{package, category}]

    # ============================================================
    # SESSION REGISTRY
    # ============================================================

    def register_session(self, session_id: str, vm_id: str, endpoint: str):
        """Register or update a session → VM mapping."""
        self._session_registry[session_id] = {"vm_id": vm_id, "endpoint": endpoint}
        logger.info(f"Session registered: {session_id} → {vm_id}")

    def unregister_session(self, session_id: str):
        """Remove a session from the registry (VM terminated, no rotation)."""
        self._session_registry.pop(session_id, None)
        logger.info(f"Session unregistered: {session_id}")

    def get_session_vm(self, session_id: str) -> dict | None:
        """Look up the current VM for a session. Returns {vm_id, endpoint} or None."""
        return self._session_registry.get(session_id)

    # ============================================================
    # USER-INSTALLED PACKAGE TRACKING
    # ============================================================

    def record_user_install(self, session_id: str, package: str, category: str):
        """Record a user-installed package for a session."""
        if session_id not in self._user_installed:
            self._user_installed[session_id] = []
        # Avoid duplicates
        existing = [p["package"] for p in self._user_installed[session_id]]
        if package.lower() not in [e.lower() for e in existing]:
            self._user_installed[session_id].append({"package": package, "category": category})

    def get_user_installed_packages(self, session_id: str) -> list[dict]:
        """Get list of user-installed packages for a session."""
        return self._user_installed.get(session_id, [])

    # ============================================================
    # AWS CLIENT
    # ============================================================

    def get_lambda_client(self):
        if self._lambda_client is None:
            self._lambda_client = boto3.client("lambda-microvms", region_name=AWS_REGION)
        return self._lambda_client

    # ============================================================
    # AUTH TOKENS
    # ============================================================

    def get_auth_token(self, microvm_id: str) -> str:
        """Get a cached or fresh auth token for a MicroVM."""
        cached = self.token_cache.get(microvm_id)
        if cached and time.time() < cached["expires_at"]:
            return cached["token"]

        logger.info(f"Fetching new auth token for {microvm_id}")
        client = self.get_lambda_client()
        response = client.create_microvm_auth_token(
            microvmIdentifier=microvm_id,
            expirationInMinutes=30,
            allowedPorts=[{"allPorts": {}}],
        )

        token = response["authToken"]["X-aws-proxy-auth"]
        self.token_cache.set(microvm_id, {
            "token": token,
            "expires_at": time.time() + (25 * 60),
        })
        return token

    def get_shell_auth_token(self, microvm_id: str) -> str:
        """Get a shell auth token for WebSocket terminal access.
        
        Shell tokens use the SHELL_INGRESS connector and are passed
        via WebSocket subprotocols (not HTTP headers).
        """
        cache_key = f"shell:{microvm_id}"
        cached = self.token_cache.get(cache_key)
        if cached and time.time() < cached["expires_at"]:
            return cached["token"]

        logger.info(f"Fetching shell auth token for {microvm_id}")
        client = self.get_lambda_client()
        response = client.create_microvm_shell_auth_token(
            microvmIdentifier=microvm_id,
            expirationInMinutes=30,
        )

        token = response["authToken"]["X-aws-proxy-auth"]
        self.token_cache.set(cache_key, {
            "token": token,
            "expires_at": time.time() + (25 * 60),
        })
        return token

    # ============================================================
    # ARTIFACTS BUCKET
    # ============================================================

    def get_artifacts_bucket(self) -> str | None:
        """Get the artifacts bucket name (from env or discovered)."""
        if self._artifacts_bucket:
            return self._artifacts_bucket
        try:
            sts = boto3.client("sts", region_name=AWS_REGION)
            account_id = sts.get_caller_identity()["Account"]
            self._artifacts_bucket = f"microvm-sandbox-artifacts-{account_id}-{AWS_REGION}"
            return self._artifacts_bucket
        except Exception:
            pass
        return None

    # ============================================================
    # VM ROTATION HELPERS
    # ============================================================

    def launch_for_rotation(self, image_arn: str, memory_mib: int, idle_timeout_sec: int, notebook_name: str, session_id: str) -> tuple:
        """
        Launch a bare VM for rotation (no restore payload — state applied separately).
        Uses the same API params as the main launch to ensure identical config.
        Returns (microvm_id, endpoint).
        """
        import json

        client = self.get_lambda_client()
        bucket = self.get_artifacts_bucket()
        max_duration_sec = int(os.environ.get("MAX_LIFETIME_SECONDS", "28800"))

        run_payload = json.dumps({
            "notebook_name": notebook_name,
            "session_id": session_id,
            "checkpoint_enabled": True,
            "persistence_mode": "checkpoint",
            "artifacts_bucket": bucket,
        })

        params = {
            "imageIdentifier": image_arn,
            "ingressNetworkConnectors": [INGRESS_CONNECTOR, SHELL_INGRESS_CONNECTOR],
            "egressNetworkConnectors": [EGRESS_CONNECTOR],
            "idlePolicy": {
                "autoResumeEnabled": True,
                "maxIdleDurationSeconds": idle_timeout_sec,
                "suspendedDurationSeconds": max_duration_sec,
            },
            "maximumDurationInSeconds": max_duration_sec,
            "runHookPayload": run_payload,
        }

        if EXEC_ROLE_ARN:
            params["executionRoleArn"] = EXEC_ROLE_ARN

        resp = client.run_microvm(**params)
        vm_id = resp["microvmId"]
        endpoint = resp["endpoint"]

        # Track locally — no session_id yet (assigned after swap completes)
        self.active_microvms[vm_id] = {
            "endpoint": endpoint,
            "name": notebook_name,
            "launched_at": time.time(),
            "memory_mib": memory_mib,
            "idle_timeout_sec": idle_timeout_sec,
            "max_duration_sec": max_duration_sec,
            "_rotation_pending": True,  # Internal flag: not yet serving traffic
            "_502_strikes": 0,
        }

        logger.info(f"🔄 Rotation: launched bare VM {vm_id} at {endpoint}")
        return vm_id, endpoint

    def terminate(self, microvm_id: str):
        """Terminate a MicroVM via the AWS API."""
        try:
            client = self.get_lambda_client()
            client.terminate_microvm(microvmIdentifier=microvm_id)
            self.active_microvms.pop(microvm_id, None)
            self.cancel_pre_terminate(microvm_id)
            logger.info(f"Terminated VM: {microvm_id}")
        except Exception as e:
            logger.warning(f"Terminate failed for {microvm_id}: {e}")

    # ============================================================
    # PRE-TERMINATION WAKE TIMERS
    # ============================================================
    # WORKAROUND: AWS Lambda MicroVMs does NOT fire the /terminate lifecycle hook
    # when the service auto-terminates a VM that is in SUSPENDED state.
    #
    # However, AWS DOES fire the /terminate hook when it auto-terminates a RUNNING VM.
    #
    # FIX: We set a timer 30 seconds before the VM's max lifetime expires and resume
    # the VM (if suspended). When maximumDurationInSeconds then expires moments later,
    # the VM is in RUNNING state and AWS fires the /terminate hook normally.

    async def _pre_terminate_vm(self, microvm_id: str, delay_seconds: float):
        """Wait, then resume the VM so it's RUNNING when AWS auto-terminates it."""
        try:
            await asyncio.sleep(delay_seconds)
            logger.info(f"⏰ Pre-termination wake timer fired for {microvm_id} — resuming so /terminate hook fires")
            client = self.get_lambda_client()
            try:
                client.resume_microvm(microvmIdentifier=microvm_id)
                logger.info(f"⏰ Resume requested for {microvm_id} — AWS will auto-terminate shortly and fire /terminate hook")
            except Exception as e:
                logger.info(f"⏰ Resume skipped for {microvm_id} (may already be running): {e}")
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.warning(f"⏰ Pre-termination wake failed for {microvm_id}: {e}")
        finally:
            self._pre_terminate_timers.pop(microvm_id, None)

    def schedule_pre_terminate(self, microvm_id: str, max_duration_sec: int, idle_timeout_sec: int = 60):
        """
        Schedule a resume before max_duration expires — safety net so /terminate hook fires.
        Wakes the VM (idle_timeout - 10s) before max lifetime, ensuring it stays RUNNING
        (won't have time to re-suspend before AWS kills it).
        """
        self.cancel_pre_terminate(microvm_id)  # Cancel existing timer if any (dedup)
        # Wake the VM close enough to max_lifetime that it can't re-suspend
        wake_before = max(idle_timeout_sec - 10, 15)  # At least 15s buffer
        delay = max(max_duration_sec - wake_before, 10)
        task = asyncio.create_task(self._pre_terminate_vm(microvm_id, delay))
        self._pre_terminate_timers[microvm_id] = task
        logger.info(f"⏰ Pre-termination wake timer set for {microvm_id}: resumes in {int(delay)}s ({int(delay//60)}m)")

    def cancel_pre_terminate(self, microvm_id: str):
        """Cancel a pre-termination timer (e.g., user manually terminated)."""
        task = self._pre_terminate_timers.pop(microvm_id, None)
        if task and not task.done():
            task.cancel()

    def restore_timers_from_db(self):
        """Restore pre-termination timers and session registry for VMs that are still alive (after proxy restart)."""
        try:
            active_sessions = storage.vm_session_list_active()
            client = self.get_lambda_client()

            for session in active_sessions:
                microvm_id = session.get("microvm_id")
                session_id = session.get("session_id")
                endpoint = session.get("endpoint", "")

                if not microvm_id or not session_id:
                    continue

                # Verify VM is still alive in AWS before re-registering
                try:
                    detail = client.get_microvm(microvmIdentifier=microvm_id)
                    vm_state = detail.get("state", "UNKNOWN")
                    if vm_state in ("TERMINATED", "TERMINATING", "FAILED"):
                        logger.info(f"   Skipping dead VM {microvm_id} (state={vm_state}) — cleaning DB")
                        storage.vm_session_mark_terminated(microvm_id)
                        continue
                    # Update endpoint from AWS if available (may have changed)
                    if detail.get("endpoint"):
                        endpoint = detail["endpoint"]
                except Exception as e:
                    logger.warning(f"   Cannot verify VM {microvm_id}: {e} — skipping")
                    continue

                # Restore session→VM mapping so /proxy/{path} works immediately
                if endpoint:
                    self.register_session(session_id, microvm_id, endpoint)
                    logger.info(f"   Restored session {session_id} → {microvm_id} (state={vm_state})")

                if session.get("checkpoint_enabled") and session.get("max_duration_sec") and session.get("launched_at"):
                    launched_at = session["launched_at"]
                    max_dur = session["max_duration_sec"]
                    if isinstance(launched_at, str):
                        launch_dt = datetime.fromisoformat(launched_at)
                    else:
                        launch_dt = datetime.fromtimestamp(launched_at, tz=timezone.utc)
                    elapsed = (datetime.now(timezone.utc) - launch_dt).total_seconds()
                    buffer = 30
                    remaining = max_dur - buffer - elapsed
                    if remaining > 10:
                        self.schedule_pre_terminate(microvm_id, int(remaining + buffer))
                        logger.info(f"⏰ Restored timer for {microvm_id}: {int(remaining)}s remaining")
        except Exception as e:
            logger.warning(f"Failed to restore sessions from DB: {e}")
