"""
MicroVM Cost Tracker

Part of: proxy.platform (Smart MicroVM Service layer)

Tracks state transitions per MicroVM and computes estimated cost
based on time spent in each state (RUNNING vs SUSPENDED).

Persists across browser page refreshes (lives in proxy process memory).
Does not survive proxy restarts — acceptable since a restart means
a fresh session.

Pricing is based on published Lambda MicroVM rates (Graviton/ARM64, us-east-1, 2026).
AWS bills on two axes: vCPU (per vCPU-second) + Memory (per GB-second).
CPU is allocated at 2 GB : 1 vCPU ratio.
"""

import os
import time
from dataclasses import dataclass, field


# Pricing constants — override via env vars
PRICE_VCPU_PER_SEC = float(os.environ.get("PRICE_VCPU_PER_SEC", "0.0000276944"))
PRICE_MEMORY_PER_GB_SEC = float(os.environ.get("PRICE_MEMORY_PER_GB_SEC", "0.0000036667"))
PRICE_SNAPSHOT_PER_GB_MONTH = float(os.environ.get("PRICE_SNAPSHOT_PER_GB_MONTH", "0.08"))
# Derived: snapshot per GB-second (for suspended state tracking)
PRICE_SNAPSHOT_PER_GB_SEC = PRICE_SNAPSHOT_PER_GB_MONTH / (30 * 24 * 3600)


@dataclass
class StateTransition:
    """A recorded state change for a MicroVM."""
    state: str
    timestamp: float


@dataclass
class MicroVMCostRecord:
    """Cost tracking record for a single MicroVM."""
    microvm_id: str
    memory_mib: int = 4096
    transitions: list[StateTransition] = field(default_factory=list)
    # Burst tracking: accumulates MB-seconds above baseline
    burst_mb_seconds: float = 0.0
    _last_burst_poll: float = 0.0

    @property
    def memory_gb(self) -> float:
        return self.memory_mib / 1024.0

    @property
    def vcpus(self) -> float:
        """vCPUs allocated (2 GB : 1 vCPU ratio)."""
        return self.memory_gb / 2.0

    def record_state(self, state: str):
        """Record a state transition (only if state actually changed)."""
        if self.transitions and self.transitions[-1].state == state:
            return  # No change
        self.transitions.append(StateTransition(state=state, timestamp=time.time()))

    def record_burst_sample(self, used_mb: float):
        """
        Record a memory usage sample for burst cost tracking.
        Called each time metrics are polled from the VM.
        Accumulates (used_mb - baseline_mb) × elapsed_seconds when above baseline.
        """
        now = time.time()
        if self._last_burst_poll > 0 and used_mb > self.memory_mib:
            elapsed = now - self._last_burst_poll
            overage_mb = used_mb - self.memory_mib
            self.burst_mb_seconds += overage_mb * elapsed
        self._last_burst_poll = now

    def compute(self) -> dict:
        """
        Compute estimated cost breakdown.

        Returns:
            {
                "running_secs": int,
                "suspended_secs": int,
                "running_cost_usd": float,
                "suspended_cost_usd": float,
                "burst_cost_usd": float,
                "total_cost_usd": float,
                "memory_gb": float,
                "burst_mb_seconds": float,
            }
        """
        if not self.transitions:
            return {
                "running_secs": 0,
                "suspended_secs": 0,
                "running_cost_usd": 0.0,
                "suspended_cost_usd": 0.0,
                "burst_cost_usd": 0.0,
                "total_cost_usd": 0.0,
                "memory_gb": self.memory_gb,
                "burst_mb_seconds": 0.0,
            }

        now = time.time()
        running_secs = 0.0
        suspended_secs = 0.0

        for i, t in enumerate(self.transitions):
            # Duration until next transition, or until now if last entry
            if i + 1 < len(self.transitions):
                duration = self.transitions[i + 1].timestamp - t.timestamp
            elif t.state == "TERMINATED":
                duration = 0
            else:
                duration = now - t.timestamp

            if t.state == "RUNNING":
                running_secs += duration
            elif t.state == "SUSPENDED":
                suspended_secs += duration

        running_cost = (
            self.vcpus * running_secs * PRICE_VCPU_PER_SEC +
            self.memory_gb * running_secs * PRICE_MEMORY_PER_GB_SEC
        )
        suspended_cost = self.memory_gb * suspended_secs * PRICE_SNAPSHOT_PER_GB_SEC
        # Burst cost: overage MB-seconds converted to GB-seconds, billed at combined rate
        burst_gb_seconds = self.burst_mb_seconds / 1024.0
        burst_vcpu_seconds = burst_gb_seconds / 2.0  # same 2GB:1vCPU ratio for burst
        burst_cost = (
            burst_vcpu_seconds * PRICE_VCPU_PER_SEC +
            burst_gb_seconds * PRICE_MEMORY_PER_GB_SEC
        )
        total_cost = running_cost + suspended_cost + burst_cost

        return {
            "running_secs": round(running_secs),
            "suspended_secs": round(suspended_secs),
            "running_cost_usd": round(running_cost, 6),
            "suspended_cost_usd": round(suspended_cost, 6),
            "burst_cost_usd": round(burst_cost, 6),
            "total_cost_usd": round(total_cost, 6),
            "memory_gb": self.memory_gb,
            "burst_mb_seconds": round(self.burst_mb_seconds, 1),
        }


class CostTracker:
    """
    Tracks cost across all MicroVMs managed by this proxy session.

    Usage:
        tracker = CostTracker()
        tracker.record("microvm-abc", "RUNNING", memory_mib=4096)
        tracker.record("microvm-abc", "SUSPENDED")
        cost = tracker.get_cost("microvm-abc")
        total = tracker.get_total_cost()
    """

    def __init__(self):
        self._records: dict[str, MicroVMCostRecord] = {}

    def record(self, microvm_id: str, state: str, memory_mib: int = None):
        """
        Record a state observation for a MicroVM.
        Only creates a new transition if the state actually changed.

        Args:
            microvm_id: The MicroVM identifier
            state: Current state (RUNNING, SUSPENDED, TERMINATED, etc.)
            memory_mib: Memory in MiB (only needed on first call per MicroVM)
        """
        if microvm_id not in self._records:
            self._records[microvm_id] = MicroVMCostRecord(
                microvm_id=microvm_id,
                memory_mib=memory_mib or 4096,
            )
        record = self._records[microvm_id]

        # Update memory if provided and different
        if memory_mib and memory_mib != record.memory_mib:
            record.memory_mib = memory_mib

        record.record_state(state)

    def record_burst(self, microvm_id: str, used_mb: float):
        """
        Record a memory usage sample for burst cost tracking.
        Call this each time metrics are polled from the VM.

        Args:
            microvm_id: The MicroVM identifier
            used_mb: Current memory usage in MB (from psutil)
        """
        record = self._records.get(microvm_id)
        if record:
            record.record_burst_sample(used_mb)

    def get_cost(self, microvm_id: str) -> dict:
        """Get cost breakdown for a specific MicroVM."""
        record = self._records.get(microvm_id)
        if not record:
            return {
                "running_secs": 0,
                "suspended_secs": 0,
                "running_cost_usd": 0.0,
                "suspended_cost_usd": 0.0,
                "total_cost_usd": 0.0,
                "memory_gb": 0,
            }
        return record.compute()

    def get_total_cost(self) -> dict:
        """Get aggregated cost across all tracked MicroVMs."""
        total_running_secs = 0
        total_suspended_secs = 0
        total_running_cost = 0.0
        total_suspended_cost = 0.0
        total_burst_cost = 0.0

        for record in self._records.values():
            cost = record.compute()
            total_running_secs += cost["running_secs"]
            total_suspended_secs += cost["suspended_secs"]
            total_running_cost += cost["running_cost_usd"]
            total_suspended_cost += cost["suspended_cost_usd"]
            total_burst_cost += cost["burst_cost_usd"]

        return {
            "running_secs": total_running_secs,
            "suspended_secs": total_suspended_secs,
            "running_cost_usd": round(total_running_cost, 6),
            "suspended_cost_usd": round(total_suspended_cost, 6),
            "burst_cost_usd": round(total_burst_cost, 6),
            "total_cost_usd": round(total_running_cost + total_suspended_cost + total_burst_cost, 6),
            "microvm_count": len(self._records),
        }

    def get_session_cost(self, session_vm_ids: list[str]) -> dict:
        """
        Get aggregated cost for a session (sum of all VMs that served it).
        
        Args:
            session_vm_ids: List of all MicroVM IDs that served this session
                           (including terminated ones from rotation)
        """
        total_running_secs = 0
        total_suspended_secs = 0
        total_running_cost = 0.0
        total_suspended_cost = 0.0
        total_burst_cost = 0.0

        for vm_id in session_vm_ids:
            record = self._records.get(vm_id)
            if record:
                cost = record.compute()
                total_running_secs += cost["running_secs"]
                total_suspended_secs += cost["suspended_secs"]
                total_running_cost += cost["running_cost_usd"]
                total_suspended_cost += cost["suspended_cost_usd"]
                total_burst_cost += cost["burst_cost_usd"]

        return {
            "running_secs": total_running_secs,
            "suspended_secs": total_suspended_secs,
            "running_cost_usd": round(total_running_cost, 6),
            "suspended_cost_usd": round(total_suspended_cost, 6),
            "burst_cost_usd": round(total_burst_cost, 6),
            "total_cost_usd": round(total_running_cost + total_suspended_cost + total_burst_cost, 6),
            "vm_count": len(session_vm_ids),
        }

    @property
    def tracked_ids(self) -> list[str]:
        """List all tracked MicroVM IDs."""
        return list(self._records.keys())

    def persist_cost(self, microvm_id: str, storage) -> None:
        """Persist current cost data to the database."""
        record = self._records.get(microvm_id)
        if not record:
            return
        try:
            cost = record.compute()
            storage.vm_session_update_cost(
                microvm_id=microvm_id,
                running_secs=cost["running_secs"],
                suspended_secs=cost["suspended_secs"],
                total_cost=cost["total_cost_usd"],
                burst_mb_seconds=cost["burst_mb_seconds"],
            )
        except Exception:
            pass  # Non-critical — cost data is also in memory

    def load_from_db(self, storage) -> None:
        """
        Load cost state from the database on startup.
        Reconstructs CostTracker records from vm_sessions + vm_state_log.
        """
        try:
            active_sessions = storage.vm_session_list_active()

            for session in active_sessions:
                microvm_id = session["microvm_id"]
                memory_mib = session.get("memory_mib") or 4096
                db_burst_mb_sec = session.get("burst_mb_seconds") or 0

                # Create record with stored burst data
                record = MicroVMCostRecord(
                    microvm_id=microvm_id,
                    memory_mib=memory_mib,
                    burst_mb_seconds=db_burst_mb_sec,
                )

                # Reconstruct transitions from state_log
                log_entries = storage.vm_state_log_get(microvm_id)
                if log_entries:
                    from datetime import datetime, timezone
                    for entry in log_entries:
                        try:
                            ts = datetime.fromisoformat(entry["timestamp"].replace("Z", "+00:00"))
                            record.transitions.append(StateTransition(
                                state=entry["new_state"],
                                timestamp=ts.timestamp()
                            ))
                        except (ValueError, TypeError):
                            pass

                if record.transitions:
                    self._records[microvm_id] = record

        except Exception:
            pass  # Silently fail — fresh start is acceptable
