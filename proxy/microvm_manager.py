"""
MicroVM Manager — encapsulates all MicroVM lifecycle state.

This class manages:
- AWS Lambda MicroVMs client
- Auth token cache (bounded LRU)
- Active MicroVM tracking
- Pre-termination wake timers (workaround for suspended VM terminate hook issue)
- Cost tracking
- Artifacts bucket discovery

All route modules access this via app.state.vm_manager.
"""

import os
import time
import asyncio
import logging
from collections import OrderedDict
from datetime import datetime, timezone

import boto3

from proxy.storage import storage
from proxy.cost_tracker import CostTracker

logger = logging.getLogger(__name__)

# --- Configuration (from environment) ---
AWS_REGION = os.environ.get("AWS_REGION", "us-west-2")
IMAGE_ARN = os.environ.get("MICROVM_IMAGE_ARN", "")
EXEC_ROLE_ARN = os.environ.get("MICROVM_EXEC_ROLE_ARN", "")
POLL_INTERVAL_MS = int(os.environ.get("POLL_INTERVAL_MS", "10000"))
INGRESS_CONNECTOR = os.environ.get("MICROVM_INGRESS_CONNECTOR",
    f"arn:aws:lambda:{AWS_REGION}:aws:network-connector:aws-network-connector:ALL_INGRESS")
EGRESS_CONNECTOR = os.environ.get("MICROVM_EGRESS_CONNECTOR",
    f"arn:aws:lambda:{AWS_REGION}:aws:network-connector:aws-network-connector:INTERNET_EGRESS")

TOKEN_CACHE_MAX_SIZE = 100


class BoundedTokenCache:
    """LRU-bounded token cache to prevent unbounded memory growth. Thread-safe."""

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

    def schedule_pre_terminate(self, microvm_id: str, max_duration_sec: int):
        """Schedule a resume 30s before max_duration expires."""
        self.cancel_pre_terminate(microvm_id)  # Cancel existing timer if any (dedup)
        buffer = 30
        delay = max(max_duration_sec - buffer, 10)
        task = asyncio.create_task(self._pre_terminate_vm(microvm_id, delay))
        self._pre_terminate_timers[microvm_id] = task
        logger.info(f"⏰ Pre-termination wake timer set for {microvm_id}: resumes in {int(delay)}s ({int(delay//60)}m)")

    def cancel_pre_terminate(self, microvm_id: str):
        """Cancel a pre-termination timer (e.g., user manually terminated)."""
        task = self._pre_terminate_timers.pop(microvm_id, None)
        if task and not task.done():
            task.cancel()

    def restore_timers_from_db(self):
        """Restore pre-termination timers for VMs that are still alive (after proxy restart)."""
        try:
            active_sessions = storage.vm_session_list_active()
            for session in active_sessions:
                if session.get("checkpoint_enabled") and session.get("max_duration_sec") and session.get("launched_at"):
                    microvm_id = session["microvm_id"]
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
            logger.warning(f"Failed to restore pre-termination timers: {e}")
