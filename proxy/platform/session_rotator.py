"""
Session Rotator — Transparent VM rotation before max-lifetime.

Part of: proxy.platform (Smart MicroVM Service layer)

When a VM approaches its max lifetime (8h default), this module:
1. Launches a bare replacement VM (VM2)
2. Waits for VM2 to be healthy
3. Quiesces traffic (buffers incoming requests)
4. Saves VM1 state to S3 via /checkpoint-save
5. Restores state onto VM2 via /restore-state
6. Swaps routing (session → VM2)
7. Replays buffered requests
8. Terminates VM1

Total user-visible pause: ~1.4 seconds (quiesce window)
"""

import os
import time
import asyncio
import logging
import threading
from typing import Optional, Callable
from dataclasses import dataclass, field

import httpx

logger = logging.getLogger(__name__)

MAX_LIFETIME_SECONDS = int(os.environ.get("MAX_LIFETIME_SECONDS", "28800"))
ROTATION_LEAD_SECONDS = int(os.environ.get("ROTATION_LEAD_SECONDS", "60"))


@dataclass
class RotationState:
    """Tracks rotation state for a single session."""
    session_id: str
    vm_id: str
    endpoint: str
    memory_mib: int
    image_arn: str
    idle_timeout_sec: int
    notebook_name: str
    launched_at: float
    max_lifetime: int
    rotation_count: int = 0
    quiesced: bool = False
    request_queue: list = field(default_factory=list)


class SessionRotator:
    """
    Manages automatic VM rotation for all active sessions.

    Usage:
        rotator = SessionRotator(vm_manager)
        rotator.register(session_id, vm_id, endpoint, ...)
        # Later, when timer fires:
        rotator._rotate(session_id)  # internal, triggered by timer
    """

    def __init__(self, vm_manager):
        self._vm_manager = vm_manager
        self._sessions: dict[str, RotationState] = {}
        self._timers: dict[str, threading.Timer] = {}
        self._on_swap_callback: Optional[Callable] = None
        # Track all VMs that served each session (for cost aggregation)
        self._session_vm_history: dict[str, list[str]] = {}
        # Rotation step timings history per session (for reporting)
        self._rotation_history: dict[str, list[dict]] = {}

    def set_swap_callback(self, callback: Callable):
        """
        Set callback invoked when routing needs to swap.
        callback(session_id, new_vm_id, new_endpoint)
        """
        self._on_swap_callback = callback

    def register(
        self,
        session_id: str,
        vm_id: str,
        endpoint: str,
        memory_mib: int,
        image_arn: str,
        idle_timeout_sec: int = 300,
        notebook_name: str = "",
        max_lifetime: Optional[int] = None,
    ):
        """Register a session for rotation tracking."""
        lifetime = max_lifetime or MAX_LIFETIME_SECONDS

        state = RotationState(
            session_id=session_id,
            vm_id=vm_id,
            endpoint=endpoint,
            memory_mib=memory_mib,
            image_arn=image_arn,
            idle_timeout_sec=idle_timeout_sec,
            notebook_name=notebook_name,
            launched_at=time.time(),
            max_lifetime=lifetime,
        )
        self._sessions[session_id] = state

        # Track VM history for session cost aggregation
        if session_id not in self._session_vm_history:
            self._session_vm_history[session_id] = []
        self._session_vm_history[session_id].append(vm_id)

        # Schedule rotation
        delay = lifetime - ROTATION_LEAD_SECONDS
        if delay > 0:
            timer = threading.Timer(delay, self._trigger_rotation, args=[session_id])
            timer.daemon = True
            timer.start()
            self._timers[session_id] = timer
            logger.info(f"🔄 Rotation scheduled for session {session_id}: fires in {delay}s (max={lifetime}s, lead={ROTATION_LEAD_SECONDS}s)")
        else:
            logger.warning(f"Max lifetime ({lifetime}s) too short for rotation lead ({ROTATION_LEAD_SECONDS}s)")

    def unregister(self, session_id: str):
        """Remove a session from rotation tracking (user terminated)."""
        if session_id in self._timers:
            self._timers[session_id].cancel()
            del self._timers[session_id]
        self._sessions.pop(session_id, None)
        logger.info(f"🔄 Session {session_id} unregistered from rotation")

    def is_quiesced(self, session_id: str) -> bool:
        """Check if a session is currently in quiesce mode."""
        state = self._sessions.get(session_id)
        return state.quiesced if state else False

    def queue_request(self, session_id: str, request_data: dict, future: asyncio.Future):
        """Queue a request during quiesce window."""
        state = self._sessions.get(session_id)
        if state:
            state.request_queue.append((request_data, future))

    def get_active_endpoint(self, session_id: str) -> Optional[str]:
        """Get the current active endpoint for a session."""
        state = self._sessions.get(session_id)
        return state.endpoint if state else None

    def get_active_vm_id(self, session_id: str) -> Optional[str]:
        """Get the current active VM ID for a session."""
        state = self._sessions.get(session_id)
        return state.vm_id if state else None

    def get_session_vm_history(self, session_id: str) -> list[str]:
        """Get all VM IDs that have served this session (for cost tracking)."""
        return self._session_vm_history.get(session_id, [])

    def get_rotation_history(self, session_id: str) -> list[dict]:
        """Get step-by-step timing for all rotations of this session."""
        return self._rotation_history.get(session_id, [])

    # ─── Internal Rotation Logic ─────────────────────────────────

    def _trigger_rotation(self, session_id: str):
        """Timer fired — start rotation in a new thread."""
        logger.info(f"🔄 Rotation timer fired for session {session_id}")
        # Run rotation in a background thread (it does blocking I/O)
        thread = threading.Thread(target=self._rotate, args=[session_id], daemon=True)
        thread.start()

    def _rotate(self, session_id: str):
        """
        Execute the full rotation sequence.
        Runs in a background thread.
        """
        state = self._sessions.get(session_id)
        if not state:
            logger.warning(f"Rotation: session {session_id} not found (may have been terminated)")
            return

        old_vm_id = state.vm_id
        old_endpoint = state.endpoint

        logger.info(f"🔄 ROTATION START: session={session_id}, vm={old_vm_id}")
        rotation_start = time.time()
        step_timings = {}
        new_vm_id = None
        new_endpoint = None

        try:
            # Step 1: Launch bare VM2
            t0 = time.time()
            logger.info(f"  Step 1: Launching replacement VM...")
            new_vm_id, new_endpoint = self._vm_manager.launch_for_rotation(
                image_arn=state.image_arn,
                memory_mib=state.memory_mib,
                idle_timeout_sec=state.idle_timeout_sec,
                notebook_name=state.notebook_name,
                session_id=session_id,
            )
            step_timings["launch"] = time.time() - t0
            logger.info(f"  Step 1 done ({step_timings['launch']:.1f}s): VM2={new_vm_id}")

            # Step 2: Wait for VM2 healthy
            t0 = time.time()
            logger.info(f"  Step 2: Waiting for VM2 healthy...")
            self._wait_for_healthy(new_vm_id, new_endpoint)
            step_timings["healthy"] = time.time() - t0
            logger.info(f"  Step 2 done ({step_timings['healthy']:.1f}s)")

            # Step 3: Quiesce
            logger.info(f"  Step 3: Quiescing traffic...")
            state.quiesced = True

            # Step 4: Checkpoint VM1
            t0 = time.time()
            logger.info(f"  Step 4: Checkpoint VM1 → S3...")
            self._checkpoint_vm(old_vm_id, old_endpoint, session_id)
            step_timings["checkpoint"] = time.time() - t0
            logger.info(f"  Step 4 done ({step_timings['checkpoint']:.1f}s)")

            # Step 5: Restore → VM2
            t0 = time.time()
            logger.info(f"  Step 5: Restore S3 → VM2...")
            self._restore_vm(new_vm_id, new_endpoint, session_id)
            step_timings["restore"] = time.time() - t0
            logger.info(f"  Step 5 done ({step_timings['restore']:.1f}s)")

            # Step 6: Swap routing
            logger.info(f"  Step 6: Switching routing...")
            state.vm_id = new_vm_id
            state.endpoint = new_endpoint
            state.launched_at = time.time()
            state.rotation_count += 1
            state.quiesced = False

            # Track new VM in session history
            if session_id not in self._session_vm_history:
                self._session_vm_history[session_id] = []
            self._session_vm_history[session_id].append(new_vm_id)

            # Notify proxy to update its routing table
            if self._on_swap_callback:
                self._on_swap_callback(session_id, new_vm_id, new_endpoint)

            # Replay queued requests
            self._replay_queue(state, new_vm_id, new_endpoint)

            # Schedule next rotation
            self._schedule_next(session_id, state)

            # Step 7: Terminate old VM
            logger.info(f"  Step 7: Terminating old VM ({old_vm_id})...")
            self._vm_manager.terminate(old_vm_id)

            elapsed = time.time() - rotation_start
            logger.info(f"🔄 ROTATION COMPLETE: {old_vm_id} → {new_vm_id} ({elapsed:.1f}s, rotation #{state.rotation_count})")

            # Store rotation history for reporting
            step_timings["total"] = elapsed
            step_timings["from_vm"] = old_vm_id
            step_timings["to_vm"] = new_vm_id
            step_timings["rotation_number"] = state.rotation_count
            if session_id not in self._rotation_history:
                self._rotation_history[session_id] = []
            self._rotation_history[session_id].append(step_timings)

        except Exception as e:
            logger.error(f"🔄 ROTATION FAILED for {session_id}: {e}")
            # Recovery: If VM2 is alive AND checkpoint exists in S3, retry restore+swap.
            # This handles the case where rotation took > ROTATION_LEAD_SECONDS
            # (e.g., large state or network latency) and old VM was killed by AWS.
            recovered = False
            if new_vm_id and new_endpoint:
                # Check if VM2 is still reachable
                try:
                    token = self._vm_manager.get_auth_token(new_vm_id)
                    with httpx.Client(timeout=5.0) as client:
                        health_resp = client.get(
                            f"https://{new_endpoint}/health",
                            headers={"X-aws-proxy-auth": token},
                        )
                    vm2_alive = health_resp.status_code == 200
                except Exception:
                    vm2_alive = False

                if vm2_alive:
                    # Try restore on VM2 from whatever checkpoint exists in S3
                    try:
                        logger.info(f"🔄 Recovery: VM2 alive, attempting restore from S3...")
                        self._restore_vm(new_vm_id, new_endpoint, session_id)

                        # Swap routing to VM2
                        state.vm_id = new_vm_id
                        state.endpoint = new_endpoint
                        state.launched_at = time.time()
                        state.rotation_count += 1
                        state.quiesced = False

                        if session_id not in self._session_vm_history:
                            self._session_vm_history[session_id] = []
                        self._session_vm_history[session_id].append(new_vm_id)

                        if self._on_swap_callback:
                            self._on_swap_callback(session_id, new_vm_id, new_endpoint)

                        self._replay_queue(state, new_vm_id, new_endpoint)
                        self._schedule_next(session_id, state)

                        recovered = True
                        logger.info(f"🔄 Recovery SUCCEEDED: session {session_id} → VM2 {new_vm_id}")
                    except Exception as recovery_err:
                        logger.error(f"🔄 Recovery FAILED (restore/swap): {recovery_err}")

            if not recovered:
                logger.error(f"🔄 Recovery not possible — VM2 dead or no S3 checkpoint. Session {session_id} is lost.")
                # Un-quiesce and replay on old VM (best effort — it may also be dead)
                state.quiesced = False
                self._replay_queue(state, old_vm_id, old_endpoint)

    def _wait_for_healthy(self, vm_id: str, endpoint: str, timeout: int = 30):
        """Poll until VM responds to /health."""
        start = time.time()
        while time.time() - start < timeout:
            try:
                token = self._vm_manager.get_auth_token(vm_id)
                with httpx.Client(timeout=5.0) as client:
                    resp = client.get(
                        f"https://{endpoint}/health",
                        headers={"X-aws-proxy-auth": token},
                    )
                    if resp.status_code == 200:
                        return
            except Exception:
                pass
            time.sleep(1)
        raise TimeoutError(f"VM {vm_id} did not become healthy in {timeout}s")

    def _checkpoint_vm(self, vm_id: str, endpoint: str, session_id: str):
        """Call /checkpoint-save on the VM."""
        # Resume the VM first in case it's suspended (idle timeout).
        # If we don't, the /checkpoint-save request triggers auto-resume which
        # may restore from image snapshot instead of the last suspend point.
        try:
            client = self._vm_manager.get_lambda_client()
            client.resume_microvm(microvmIdentifier=vm_id)
            time.sleep(2)  # Brief wait for resume to complete
        except Exception:
            pass  # May already be running — that's fine

        token = self._vm_manager.get_auth_token(vm_id)
        with httpx.Client(timeout=30.0) as client:
            resp = client.post(
                f"https://{endpoint}/checkpoint-save",
                headers={"X-aws-proxy-auth": token, "Content-Type": "application/json"},
                json={"session_id": session_id},
            )
            if resp.status_code != 200:
                raise RuntimeError(f"Checkpoint save failed: {resp.status_code} {resp.text[:500]}")
            data = resp.json()
            if not data.get("success"):
                error = data.get('error', 'unknown')
                tb = data.get('traceback', '')
                if tb:
                    logger.error(f"    VM traceback:\n{tb}")
                raise RuntimeError(f"Checkpoint save failed: {error}")
            # Log internal timings from the VM
            timings = data.get("save_timings_ms", {})
            if timings:
                logger.info(f"    VM-internal breakdown: serialize={timings.get('serialize', 0):.0f}ms, upload_pkl={timings.get('upload_pkl', 0):.0f}ms, archive={timings.get('archive_files', 0):.0f}ms, packages={timings.get('packages', 0):.0f}ms, total={timings.get('total_ms', 0):.0f}ms")

    def _restore_vm(self, vm_id: str, endpoint: str, session_id: str):
        """Call /restore-state on the VM."""
        token = self._vm_manager.get_auth_token(vm_id)
        with httpx.Client(timeout=30.0) as client:
            resp = client.post(
                f"https://{endpoint}/restore-state",
                headers={"X-aws-proxy-auth": token, "Content-Type": "application/json"},
                json={"session_id": session_id},
            )
            if resp.status_code != 200:
                raise RuntimeError(f"Restore failed: {resp.status_code} {resp.text}")
            data = resp.json()
            if not data.get("success"):
                raise RuntimeError(f"Restore failed: {data.get('error')}")
            # Log internal timings from the VM
            timings = data.get("restore_timings", {})
            if timings:
                logger.info(f"    VM-internal breakdown: download_pkl={timings.get('download_pkl', 0):.0f}ms, deserialize={timings.get('deserialize', 0):.0f}ms, download_files={timings.get('download_files', 0):.0f}ms, packages={timings.get('packages', 0):.0f}ms, total={timings.get('total_ms', 0):.0f}ms")

    def _replay_queue(self, state: RotationState, vm_id: str, endpoint: str):
        """Replay all buffered requests."""
        if not state.request_queue:
            return
        logger.info(f"  Replaying {len(state.request_queue)} queued requests...")
        for request_data, future in state.request_queue:
            try:
                token = self._vm_manager.get_auth_token(vm_id)
                with httpx.Client(timeout=120.0) as client:
                    resp = client.request(
                        method=request_data["method"],
                        url=f"https://{endpoint}{request_data['path']}",
                        headers={**request_data.get("headers", {}), "X-aws-proxy-auth": token},
                        content=request_data.get("body"),
                    )
                    if not future.done():
                        future.set_result(resp)
            except Exception as e:
                if not future.done():
                    future.set_exception(e)
        state.request_queue.clear()

    def _schedule_next(self, session_id: str, state: RotationState):
        """Schedule the next rotation timer."""
        delay = state.max_lifetime - ROTATION_LEAD_SECONDS
        if delay > 0:
            timer = threading.Timer(delay, self._trigger_rotation, args=[session_id])
            timer.daemon = True
            timer.start()
            self._timers[session_id] = timer
            logger.info(f"  Next rotation in {delay}s")
