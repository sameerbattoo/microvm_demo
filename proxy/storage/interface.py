"""
Abstract storage interface for the MicroVM Notebook proxy.

All storage backends must implement this class. The proxy code interacts
only with these methods — never with database-specific APIs directly.

To add a new backend (e.g., MySQL, DynamoDB):
  1. Create a new file (e.g., mysql_db.py)
  2. Create a class that extends StorageBackend
  3. Implement all abstract methods
  4. Register it in __init__.py
"""

from abc import ABC, abstractmethod
from typing import Optional


class StorageBackend(ABC):
    """Abstract interface for all storage operations."""

    # ============================================================
    # LIFECYCLE
    # ============================================================

    @abstractmethod
    def initialize(self, connection_string: str = "") -> None:
        """Initialize the storage backend.
        
        Args:
            connection_string: Database connection URL. Empty for SQLite (uses local file).
                             For MySQL: "mysql://user:pass@host:3306/db_name"
                             For Postgres: "postgresql://user:pass@host:5432/db_name"
        """
        ...

    # ============================================================
    # NOTEBOOKS
    # ============================================================

    @abstractmethod
    def notebook_create(self, notebook_id: str, name: str, description: str = "",
                        tag: str = "Drafts", cells: list = None) -> dict:
        """Create a new notebook. Returns the created notebook dict."""
        ...

    @abstractmethod
    def notebook_update(self, notebook_id: str, **kwargs) -> bool:
        """Update notebook fields. Returns True if a row was modified."""
        ...

    @abstractmethod
    def notebook_get(self, notebook_id: str) -> Optional[dict]:
        """Get a single notebook by ID. Returns None if not found."""
        ...

    @abstractmethod
    def notebook_list(self) -> list[dict]:
        """List all notebooks, ordered by updated_at descending."""
        ...

    @abstractmethod
    def notebook_delete(self, notebook_id: str) -> bool:
        """Delete a notebook. Returns True if deleted."""
        ...

    # ============================================================
    # VM SESSIONS
    # ============================================================

    @abstractmethod
    def vm_session_create(self, microvm_id: str, notebook_id: str = None,
                          session_id: str = None, memory_mib: int = None,
                          endpoint: str = None, idle_timeout_sec: int = None,
                          max_duration_sec: int = None,
                          checkpoint_enabled: bool = False) -> dict:
        """Record a new VM session on launch. Returns session dict."""
        ...

    @abstractmethod
    def vm_session_update_state(self, microvm_id: str, new_state: str) -> None:
        """Update VM state and log the transition."""
        ...

    @abstractmethod
    def vm_session_update_cost(self, microvm_id: str, running_secs: float,
                               suspended_secs: float, total_cost: float) -> None:
        """Update accumulated cost for a VM session."""
        ...

    @abstractmethod
    def vm_session_get(self, microvm_id: str) -> Optional[dict]:
        """Get a VM session by microvm_id. Returns None if not found."""
        ...

    @abstractmethod
    def vm_session_list_active(self) -> list[dict]:
        """List all non-terminated VM sessions."""
        ...

    # ============================================================
    # METRICS
    # ============================================================

    @abstractmethod
    def metrics_record(self, microvm_id: str, cpu_pct: float, mem_pct: float,
                       mem_used_mb: float, disk_pct: float, disk_used_mb: float,
                       net_bytes_sent: int, net_bytes_recv: int,
                       processes: int, uptime_sec: float) -> None:
        """Record a metrics snapshot for a VM."""
        ...

    @abstractmethod
    def metrics_get_latest(self, microvm_id: str) -> Optional[dict]:
        """Get the most recent metrics snapshot for a VM."""
        ...

    @abstractmethod
    def metrics_get_history(self, microvm_id: str, minutes: int = 5) -> list[dict]:
        """Get metrics history for sparkline charts."""
        ...

    @abstractmethod
    def metrics_cleanup(self, hours: int = 24) -> None:
        """Delete metrics older than N hours."""
        ...

    # ============================================================
    # AI SESSIONS
    # ============================================================

    @abstractmethod
    def ai_session_get(self, session_id: str) -> list:
        """Get AI chat messages for a session."""
        ...

    @abstractmethod
    def ai_session_save(self, session_id: str, notebook_id: str, messages: list) -> None:
        """Save AI chat messages for a session."""
        ...

    @abstractmethod
    def ai_session_delete(self, session_id: str) -> None:
        """Clear AI chat for a session."""
        ...
