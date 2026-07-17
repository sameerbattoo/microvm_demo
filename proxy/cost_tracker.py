"""
MicroVM Cost Tracker

Tracks state transitions per MicroVM and computes estimated cost
based on time spent in each state (RUNNING vs SUSPENDED).

Persists across browser page refreshes (lives in proxy process memory).
Does not survive proxy restarts — acceptable since a restart means
a fresh session.

Pricing is based on published Lambda MicroVM rates (us-west-2, 2026).
"""

import time
from dataclasses import dataclass, field


# Pricing constants (per GB-second)
PRICE_RUNNING_PER_GB_SEC = 0.0000133       # compute while RUNNING
PRICE_SUSPENDED_PER_GB_SEC = 0.0000000309  # snapshot storage while SUSPENDED


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

    @property
    def memory_gb(self) -> float:
        return self.memory_mib / 1024.0

    def record_state(self, state: str):
        """Record a state transition (only if state actually changed)."""
        if self.transitions and self.transitions[-1].state == state:
            return  # No change
        self.transitions.append(StateTransition(state=state, timestamp=time.time()))

    def compute(self) -> dict:
        """
        Compute estimated cost breakdown.

        Returns:
            {
                "running_secs": int,
                "suspended_secs": int,
                "running_cost_usd": float,
                "suspended_cost_usd": float,
                "total_cost_usd": float,
                "memory_gb": float,
            }
        """
        if not self.transitions:
            return {
                "running_secs": 0,
                "suspended_secs": 0,
                "running_cost_usd": 0.0,
                "suspended_cost_usd": 0.0,
                "total_cost_usd": 0.0,
                "memory_gb": self.memory_gb,
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

        running_cost = self.memory_gb * running_secs * PRICE_RUNNING_PER_GB_SEC
        suspended_cost = self.memory_gb * suspended_secs * PRICE_SUSPENDED_PER_GB_SEC
        total_cost = running_cost + suspended_cost

        return {
            "running_secs": round(running_secs),
            "suspended_secs": round(suspended_secs),
            "running_cost_usd": round(running_cost, 6),
            "suspended_cost_usd": round(suspended_cost, 6),
            "total_cost_usd": round(total_cost, 6),
            "memory_gb": self.memory_gb,
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

        for record in self._records.values():
            cost = record.compute()
            total_running_secs += cost["running_secs"]
            total_suspended_secs += cost["suspended_secs"]
            total_running_cost += cost["running_cost_usd"]
            total_suspended_cost += cost["suspended_cost_usd"]

        return {
            "running_secs": total_running_secs,
            "suspended_secs": total_suspended_secs,
            "running_cost_usd": round(total_running_cost, 6),
            "suspended_cost_usd": round(total_suspended_cost, 6),
            "total_cost_usd": round(total_running_cost + total_suspended_cost, 6),
            "microvm_count": len(self._records),
        }

    @property
    def tracked_ids(self) -> list[str]:
        """List all tracked MicroVM IDs."""
        return list(self._records.keys())
