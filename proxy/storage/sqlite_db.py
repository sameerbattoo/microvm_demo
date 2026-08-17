"""
SQLite implementation of the StorageBackend interface.

This is the default backend for local development. Stores data in a single
SQLite file at proxy/data/microvm.db.

For cloud deployment, create a new backend (e.g., mysql_db.py) that extends
StorageBackend with the same method signatures.
"""

import os
import json
import sqlite3
import threading
import logging
from typing import Optional
from datetime import datetime, timezone
from contextlib import contextmanager

from proxy.storage.interface import StorageBackend

logger = logging.getLogger(__name__)

# Database file path
DB_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data")
DB_PATH = os.path.join(DB_DIR, "microvm.db")

# Thread-local connections (SQLite doesn't allow cross-thread sharing)
_local = threading.local()


SCHEMA = """
-- Notebooks: replaces browser localStorage
CREATE TABLE IF NOT EXISTS notebooks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    tag TEXT DEFAULT 'Drafts',
    cells_json TEXT DEFAULT '[]',
    session_id TEXT,
    microvm_id TEXT,
    checkpoint_enabled INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- VM Sessions: tracks each MicroVM lifecycle
CREATE TABLE IF NOT EXISTS vm_sessions (
    microvm_id TEXT PRIMARY KEY,
    notebook_id TEXT,
    session_id TEXT,
    memory_mib INTEGER,
    state TEXT DEFAULT 'PENDING',
    endpoint TEXT,
    image_arn TEXT,
    launched_at TEXT,
    terminated_at TEXT,
    idle_timeout_sec INTEGER,
    max_duration_sec INTEGER,
    checkpoint_enabled INTEGER DEFAULT 0,
    total_cost_usd REAL DEFAULT 0.0,
    running_secs REAL DEFAULT 0.0,
    suspended_secs REAL DEFAULT 0.0,
    burst_mb_seconds REAL DEFAULT 0.0
);

-- VM Metrics: time-series data
CREATE TABLE IF NOT EXISTS vm_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    microvm_id TEXT NOT NULL,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    cpu_pct REAL,
    mem_pct REAL,
    mem_used_mb REAL,
    disk_pct REAL,
    disk_used_mb REAL,
    net_bytes_sent INTEGER,
    net_bytes_recv INTEGER,
    processes INTEGER,
    uptime_sec REAL
);

-- VM State Log: audit trail of state transitions
CREATE TABLE IF NOT EXISTS vm_state_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    microvm_id TEXT NOT NULL,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    old_state TEXT,
    new_state TEXT NOT NULL
);

-- AI Sessions: chat history per notebook
CREATE TABLE IF NOT EXISTS ai_sessions (
    id TEXT PRIMARY KEY,
    notebook_id TEXT,
    messages_json TEXT DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS workbook_intel (
    session_id TEXT PRIMARY KEY,
    s3_key TEXT NOT NULL,
    generated_at TEXT NOT NULL DEFAULT (datetime('now')),
    version INTEGER NOT NULL DEFAULT 1
);

-- Global data-source entities: S3 files, Athena tables, DynamoDB tables.
-- Shared across all sessions/users — NOT session-scoped like workbook_intel.
CREATE TABLE IF NOT EXISTS data_source_entities (
    source_id TEXT PRIMARY KEY,
    source_type TEXT NOT NULL,
    doc_s3_key TEXT,
    change_signal TEXT,
    status TEXT DEFAULT 'pending',
    last_discovered_at TEXT
);

-- Local file entities: uploaded /tmp files, unique per session (NOT shared
-- like data_source_entities). Same shape/purpose, scoped by session_id.
CREATE TABLE IF NOT EXISTS local_file_entities (
    session_id TEXT NOT NULL,
    filepath TEXT NOT NULL,
    doc_s3_key TEXT,
    change_signal TEXT,
    status TEXT DEFAULT 'pending',
    last_discovered_at TEXT,
    PRIMARY KEY (session_id, filepath)
);

CREATE INDEX IF NOT EXISTS idx_vm_metrics_lookup
    ON vm_metrics(microvm_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_vm_sessions_notebook
    ON vm_sessions(notebook_id);
"""


class SqliteStorage(StorageBackend):
    """SQLite-based storage backend for local development."""

    def _get_conn(self) -> sqlite3.Connection:
        """Get a thread-local SQLite connection."""
        if not hasattr(_local, "conn") or _local.conn is None:
            os.makedirs(DB_DIR, exist_ok=True)
            _local.conn = sqlite3.connect(DB_PATH, check_same_thread=False)
            _local.conn.row_factory = sqlite3.Row
            _local.conn.execute("PRAGMA journal_mode=WAL")
            _local.conn.execute("PRAGMA foreign_keys=ON")
        return _local.conn

    @contextmanager
    def _db(self):
        """Context manager for database operations with auto-commit."""
        conn = self._get_conn()
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise

    # ============================================================
    # LIFECYCLE
    # ============================================================

    def initialize(self, connection_string: str = "") -> None:
        """Initialize SQLite database. connection_string is ignored (uses local file)."""
        os.makedirs(DB_DIR, exist_ok=True)
        with self._db() as conn:
            conn.executescript(SCHEMA)
        logger.info(f"Database initialized: {DB_PATH}")

    # ============================================================
    # NOTEBOOKS
    # ============================================================

    def notebook_create(self, notebook_id: str, name: str, description: str = "",
                        tag: str = "Drafts", cells: list = None) -> dict:
        cells_json = json.dumps(cells or [])
        now = datetime.now(timezone.utc).isoformat()
        with self._db() as conn:
            conn.execute(
                "INSERT INTO notebooks (id, name, description, tag, cells_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (notebook_id, name, description, tag, cells_json, now, now)
            )
        return {"id": notebook_id, "name": name, "description": description, "tag": tag, "cells": cells or [], "created_at": now}

    def notebook_update(self, notebook_id: str, **kwargs) -> bool:
        allowed = {"name", "description", "tag", "cells_json", "session_id", "microvm_id", "checkpoint_enabled"}
        updates = {k: v for k, v in kwargs.items() if k in allowed}
        if "cells" in kwargs:
            updates["cells_json"] = json.dumps(kwargs["cells"])
        if not updates:
            return False
        updates["updated_at"] = datetime.now(timezone.utc).isoformat()
        set_clause = ", ".join(f"{k} = ?" for k in updates)
        values = list(updates.values()) + [notebook_id]
        with self._db() as conn:
            cursor = conn.execute(f"UPDATE notebooks SET {set_clause} WHERE id = ?", values)
        return cursor.rowcount > 0

    def notebook_get(self, notebook_id: str) -> Optional[dict]:
        with self._db() as conn:
            row = conn.execute("SELECT * FROM notebooks WHERE id = ?", (notebook_id,)).fetchone()
        return self._row_to_notebook(row) if row else None

    def notebook_list(self) -> list[dict]:
        with self._db() as conn:
            rows = conn.execute("SELECT * FROM notebooks ORDER BY updated_at DESC").fetchall()
        return [self._row_to_notebook(r) for r in rows]

    def notebook_delete(self, notebook_id: str) -> bool:
        with self._db() as conn:
            cursor = conn.execute("DELETE FROM notebooks WHERE id = ?", (notebook_id,))
        return cursor.rowcount > 0

    @staticmethod
    def _row_to_notebook(row) -> dict:
        return {
            "id": row["id"],
            "name": row["name"],
            "description": row["description"],
            "tag": row["tag"],
            "cells": json.loads(row["cells_json"] or "[]"),
            "session_id": row["session_id"],
            "microvm_id": row["microvm_id"],
            "checkpoint_enabled": bool(row["checkpoint_enabled"]),
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    # ============================================================
    # VM SESSIONS
    # ============================================================

    def vm_session_create(self, microvm_id: str, notebook_id: str = None,
                          session_id: str = None, memory_mib: int = None,
                          endpoint: str = None, idle_timeout_sec: int = None,
                          max_duration_sec: int = None,
                          checkpoint_enabled: bool = False) -> dict:
        now = datetime.now(timezone.utc).isoformat()
        with self._db() as conn:
            conn.execute(
                """INSERT OR REPLACE INTO vm_sessions
                   (microvm_id, notebook_id, session_id, memory_mib, state, endpoint, launched_at, idle_timeout_sec, max_duration_sec, checkpoint_enabled)
                   VALUES (?, ?, ?, ?, 'RUNNING', ?, ?, ?, ?, ?)""",
                (microvm_id, notebook_id, session_id, memory_mib, endpoint, now, idle_timeout_sec, max_duration_sec, 1 if checkpoint_enabled else 0)
            )
            conn.execute(
                "INSERT INTO vm_state_log (microvm_id, timestamp, old_state, new_state) VALUES (?, ?, NULL, 'RUNNING')",
                (microvm_id, now)
            )
        return {"microvm_id": microvm_id, "state": "RUNNING", "launched_at": now}

    def vm_session_update_state(self, microvm_id: str, new_state: str) -> None:
        now = datetime.now(timezone.utc).isoformat()
        with self._db() as conn:
            row = conn.execute("SELECT state FROM vm_sessions WHERE microvm_id = ?", (microvm_id,)).fetchone()
            old_state = row["state"] if row else None
            if old_state == new_state:
                return
            conn.execute("UPDATE vm_sessions SET state = ? WHERE microvm_id = ?", (new_state, microvm_id))
            conn.execute(
                "INSERT INTO vm_state_log (microvm_id, timestamp, old_state, new_state) VALUES (?, ?, ?, ?)",
                (microvm_id, now, old_state, new_state)
            )
            if new_state == "TERMINATED":
                conn.execute("UPDATE vm_sessions SET terminated_at = ? WHERE microvm_id = ?", (now, microvm_id))

    def vm_session_update_cost(self, microvm_id: str, running_secs: float,
                               suspended_secs: float, total_cost: float,
                               burst_mb_seconds: float = 0.0) -> None:
        with self._db() as conn:
            conn.execute(
                "UPDATE vm_sessions SET running_secs = ?, suspended_secs = ?, total_cost_usd = ?, burst_mb_seconds = ? WHERE microvm_id = ?",
                (running_secs, suspended_secs, total_cost, burst_mb_seconds, microvm_id)
            )

    def vm_session_get(self, microvm_id: str) -> Optional[dict]:
        with self._db() as conn:
            row = conn.execute("SELECT * FROM vm_sessions WHERE microvm_id = ?", (microvm_id,)).fetchone()
        return dict(row) if row else None

    def vm_session_list_active(self) -> list[dict]:
        with self._db() as conn:
            rows = conn.execute("SELECT * FROM vm_sessions WHERE state != 'TERMINATED' ORDER BY launched_at DESC").fetchall()
        return [dict(r) for r in rows]

    def vm_state_log_get(self, microvm_id: str) -> list[dict]:
        with self._db() as conn:
            rows = conn.execute(
                "SELECT new_state, timestamp FROM vm_state_log WHERE microvm_id = ? ORDER BY id ASC",
                (microvm_id,)
            ).fetchall()
        return [dict(r) for r in rows]

    # ============================================================
    # METRICS
    # ============================================================

    def metrics_record(self, microvm_id: str, cpu_pct: float, mem_pct: float,
                       mem_used_mb: float, disk_pct: float, disk_used_mb: float,
                       net_bytes_sent: int, net_bytes_recv: int,
                       processes: int, uptime_sec: float) -> None:
        now = datetime.now(timezone.utc).isoformat()
        with self._db() as conn:
            conn.execute(
                """INSERT INTO vm_metrics (microvm_id, timestamp, cpu_pct, mem_pct, mem_used_mb,
                   disk_pct, disk_used_mb, net_bytes_sent, net_bytes_recv, processes, uptime_sec)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (microvm_id, now, cpu_pct, mem_pct, mem_used_mb, disk_pct, disk_used_mb,
                 net_bytes_sent, net_bytes_recv, processes, uptime_sec)
            )

    def metrics_get_latest(self, microvm_id: str) -> Optional[dict]:
        with self._db() as conn:
            row = conn.execute(
                "SELECT * FROM vm_metrics WHERE microvm_id = ? ORDER BY timestamp DESC LIMIT 1",
                (microvm_id,)
            ).fetchone()
        return dict(row) if row else None

    def metrics_get_history(self, microvm_id: str, minutes: int = 5) -> list[dict]:
        with self._db() as conn:
            rows = conn.execute(
                """SELECT timestamp, cpu_pct, mem_pct, disk_pct, net_bytes_sent, net_bytes_recv
                   FROM vm_metrics
                   WHERE microvm_id = ? AND timestamp >= datetime('now', ?)
                   ORDER BY timestamp ASC""",
                (microvm_id, f"-{minutes} minutes")
            ).fetchall()
        return [dict(r) for r in rows]

    def metrics_cleanup(self, hours: int = 24) -> None:
        with self._db() as conn:
            conn.execute(
                "DELETE FROM vm_metrics WHERE timestamp < datetime('now', ?)",
                (f"-{hours} hours",)
            )

    # ============================================================
    # AI SESSIONS
    # ============================================================

    def ai_session_get(self, session_id: str) -> list:
        with self._db() as conn:
            row = conn.execute("SELECT messages_json FROM ai_sessions WHERE id = ?", (session_id,)).fetchone()
        if not row:
            return []
        return json.loads(row["messages_json"] or "[]")

    def ai_session_save(self, session_id: str, notebook_id: str, messages: list) -> None:
        now = datetime.now(timezone.utc).isoformat()
        messages_json = json.dumps(messages)
        with self._db() as conn:
            conn.execute(
                """INSERT INTO ai_sessions (id, notebook_id, messages_json, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?)
                   ON CONFLICT(id) DO UPDATE SET messages_json = ?, updated_at = ?""",
                (session_id, notebook_id, messages_json, now, now, messages_json, now)
            )

    def ai_session_delete(self, session_id: str) -> None:
        with self._db() as conn:
            conn.execute("DELETE FROM ai_sessions WHERE id = ?", (session_id,))

    # ============================================================
    # WORKBOOK INTEL
    # ============================================================

    def workbook_intel_save(self, session_id: str, s3_key: str) -> None:
        """Save or update workbook intel metadata."""
        now = datetime.now(timezone.utc).isoformat()
        with self._db() as conn:
            conn.execute(
                """INSERT INTO workbook_intel (session_id, s3_key, generated_at, version)
                   VALUES (?, ?, ?, 1)
                   ON CONFLICT(session_id) DO UPDATE SET s3_key = ?, generated_at = ?, version = version + 1""",
                (session_id, s3_key, now, s3_key, now)
            )

    def workbook_intel_get(self, session_id: str) -> dict | None:
        """Get workbook intel metadata for a session."""
        with self._db() as conn:
            row = conn.execute(
                "SELECT session_id, s3_key, generated_at, version FROM workbook_intel WHERE session_id = ?",
                (session_id,)
            ).fetchone()
            if row:
                return {"session_id": row[0], "s3_key": row[1], "generated_at": row[2], "version": row[3]}
            return None

    # ============================================================
    # GLOBAL DATA SOURCE ENTITIES
    # ============================================================

    def entity_upsert(self, source_id: str, source_type: str, doc_s3_key: str = None,
                      change_signal: dict = None, status: str = None) -> None:
        """Create or partially update a global entity's discovery metadata.
        Only fields explicitly passed (non-None) are changed on an existing row —
        this lets callers mark status='discovering' without clobbering a
        previously-saved doc_s3_key/change_signal if that attempt later fails."""
        now = datetime.now(timezone.utc).isoformat()
        with self._db() as conn:
            existing = conn.execute(
                "SELECT 1 FROM data_source_entities WHERE source_id = ?", (source_id,)
            ).fetchone()

            if existing:
                updates = {"source_type": source_type, "last_discovered_at": now}
                if doc_s3_key is not None:
                    updates["doc_s3_key"] = doc_s3_key
                if change_signal is not None:
                    updates["change_signal"] = json.dumps(change_signal)
                if status is not None:
                    updates["status"] = status
                set_clause = ", ".join(f"{k} = ?" for k in updates)
                conn.execute(
                    f"UPDATE data_source_entities SET {set_clause} WHERE source_id = ?",
                    list(updates.values()) + [source_id]
                )
            else:
                conn.execute(
                    """INSERT INTO data_source_entities
                       (source_id, source_type, doc_s3_key, change_signal, status, last_discovered_at)
                       VALUES (?, ?, ?, ?, ?, ?)""",
                    (source_id, source_type, doc_s3_key,
                     json.dumps(change_signal) if change_signal is not None else None,
                     status or "pending", now)
                )

    def entity_get(self, source_id: str) -> Optional[dict]:
        with self._db() as conn:
            row = conn.execute(
                "SELECT * FROM data_source_entities WHERE source_id = ?", (source_id,)
            ).fetchone()
        if not row:
            return None
        d = dict(row)
        d["change_signal"] = json.loads(d["change_signal"]) if d.get("change_signal") else None
        return d

    def entity_list(self, source_type: str = None) -> list[dict]:
        with self._db() as conn:
            if source_type:
                rows = conn.execute(
                    "SELECT * FROM data_source_entities WHERE source_type = ? ORDER BY source_id",
                    (source_type,)
                ).fetchall()
            else:
                rows = conn.execute("SELECT * FROM data_source_entities ORDER BY source_id").fetchall()
        result = []
        for row in rows:
            d = dict(row)
            d["change_signal"] = json.loads(d["change_signal"]) if d.get("change_signal") else None
            result.append(d)
        return result

    # ============================================================
    # LOCAL FILE ENTITIES (session-scoped — uploaded /tmp files)
    # ============================================================

    def local_entity_upsert(self, session_id: str, filepath: str, doc_s3_key: str = None,
                            change_signal: dict = None, status: str = None) -> None:
        """Create or partially update a local file's discovery metadata for one session.
        Same partial-update semantics as entity_upsert."""
        now = datetime.now(timezone.utc).isoformat()
        with self._db() as conn:
            existing = conn.execute(
                "SELECT 1 FROM local_file_entities WHERE session_id = ? AND filepath = ?",
                (session_id, filepath)
            ).fetchone()

            if existing:
                updates = {"last_discovered_at": now}
                if doc_s3_key is not None:
                    updates["doc_s3_key"] = doc_s3_key
                if change_signal is not None:
                    updates["change_signal"] = json.dumps(change_signal)
                if status is not None:
                    updates["status"] = status
                set_clause = ", ".join(f"{k} = ?" for k in updates)
                conn.execute(
                    f"UPDATE local_file_entities SET {set_clause} WHERE session_id = ? AND filepath = ?",
                    list(updates.values()) + [session_id, filepath]
                )
            else:
                conn.execute(
                    """INSERT INTO local_file_entities
                       (session_id, filepath, doc_s3_key, change_signal, status, last_discovered_at)
                       VALUES (?, ?, ?, ?, ?, ?)""",
                    (session_id, filepath, doc_s3_key,
                     json.dumps(change_signal) if change_signal is not None else None,
                     status or "pending", now)
                )

    def local_entity_get(self, session_id: str, filepath: str) -> Optional[dict]:
        with self._db() as conn:
            row = conn.execute(
                "SELECT * FROM local_file_entities WHERE session_id = ? AND filepath = ?",
                (session_id, filepath)
            ).fetchone()
        if not row:
            return None
        d = dict(row)
        d["change_signal"] = json.loads(d["change_signal"]) if d.get("change_signal") else None
        return d

    def local_entity_list(self, session_id: str) -> list[dict]:
        with self._db() as conn:
            rows = conn.execute(
                "SELECT * FROM local_file_entities WHERE session_id = ? ORDER BY filepath",
                (session_id,)
            ).fetchall()
        result = []
        for row in rows:
            d = dict(row)
            d["change_signal"] = json.loads(d["change_signal"]) if d.get("change_signal") else None
            result.append(d)
        return result
