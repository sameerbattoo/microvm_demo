"""
SQLite database for the MicroVM Notebook proxy.

Stores notebooks, VM sessions, metrics time-series, state transitions,
and AI chat history. Replaces in-memory dicts and browser localStorage.

Database file: proxy/data/microvm.db (auto-created on first use)
"""

import os
import json
import sqlite3
import threading
import logging
from datetime import datetime, timezone
from contextlib import contextmanager

logger = logging.getLogger(__name__)

# Database file path (relative to project root)
DB_DIR = os.path.join(os.path.dirname(__file__), "data")
DB_PATH = os.path.join(DB_DIR, "microvm.db")

# Thread-local connections (SQLite doesn't allow cross-thread sharing)
_local = threading.local()


def _get_conn() -> sqlite3.Connection:
    """Get a thread-local SQLite connection."""
    if not hasattr(_local, "conn") or _local.conn is None:
        os.makedirs(DB_DIR, exist_ok=True)
        _local.conn = sqlite3.connect(DB_PATH, check_same_thread=False)
        _local.conn.row_factory = sqlite3.Row
        _local.conn.execute("PRAGMA journal_mode=WAL")
        _local.conn.execute("PRAGMA foreign_keys=ON")
    return _local.conn


@contextmanager
def get_db():
    """Context manager for database operations with auto-commit."""
    conn = _get_conn()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def init_db():
    """Create all tables if they don't exist."""
    os.makedirs(DB_DIR, exist_ok=True)
    with get_db() as conn:
        conn.executescript(SCHEMA)
    logger.info(f"Database initialized: {DB_PATH}")


# ============================================================
# SCHEMA
# ============================================================

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
    total_cost_usd REAL DEFAULT 0.0,
    running_secs REAL DEFAULT 0.0,
    suspended_secs REAL DEFAULT 0.0
);

-- VM Metrics: time-series data polled every 10s
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

-- Index for fast metrics queries (sparklines)
CREATE INDEX IF NOT EXISTS idx_vm_metrics_lookup
    ON vm_metrics(microvm_id, timestamp DESC);

-- Index for notebook lookups
CREATE INDEX IF NOT EXISTS idx_vm_sessions_notebook
    ON vm_sessions(notebook_id);
"""


# ============================================================
# NOTEBOOK OPERATIONS
# ============================================================

def notebook_create(notebook_id: str, name: str, description: str = "", tag: str = "Drafts", cells: list = None) -> dict:
    """Create a new notebook."""
    cells_json = json.dumps(cells or [])
    now = datetime.now(timezone.utc).isoformat()
    with get_db() as conn:
        conn.execute(
            "INSERT INTO notebooks (id, name, description, tag, cells_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (notebook_id, name, description, tag, cells_json, now, now)
        )
    return {"id": notebook_id, "name": name, "description": description, "tag": tag, "cells": cells or [], "created_at": now}


def notebook_update(notebook_id: str, **kwargs) -> bool:
    """Update notebook fields. Pass only the fields you want to change."""
    allowed = {"name", "description", "tag", "cells_json", "session_id", "microvm_id", "checkpoint_enabled"}
    updates = {k: v for k, v in kwargs.items() if k in allowed}
    if not updates:
        return False

    # If cells are passed as a list, serialize to JSON
    if "cells" in kwargs:
        updates["cells_json"] = json.dumps(kwargs["cells"])
        updates.pop("cells", None)

    updates["updated_at"] = datetime.now(timezone.utc).isoformat()
    set_clause = ", ".join(f"{k} = ?" for k in updates)
    values = list(updates.values()) + [notebook_id]

    with get_db() as conn:
        cursor = conn.execute(f"UPDATE notebooks SET {set_clause} WHERE id = ?", values)
    return cursor.rowcount > 0


def notebook_get(notebook_id: str) -> dict | None:
    """Get a single notebook by ID."""
    with get_db() as conn:
        row = conn.execute("SELECT * FROM notebooks WHERE id = ?", (notebook_id,)).fetchone()
    if not row:
        return None
    return _row_to_notebook(row)


def notebook_list() -> list[dict]:
    """List all notebooks (sorted by updated_at DESC)."""
    with get_db() as conn:
        rows = conn.execute("SELECT * FROM notebooks ORDER BY updated_at DESC").fetchall()
    return [_row_to_notebook(r) for r in rows]


def notebook_delete(notebook_id: str) -> bool:
    """Delete a notebook."""
    with get_db() as conn:
        cursor = conn.execute("DELETE FROM notebooks WHERE id = ?", (notebook_id,))
    return cursor.rowcount > 0


def _row_to_notebook(row) -> dict:
    """Convert a database row to a notebook dict."""
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
# VM SESSION OPERATIONS
# ============================================================

def vm_session_create(microvm_id: str, notebook_id: str = None, session_id: str = None,
                      memory_mib: int = None, endpoint: str = None,
                      idle_timeout_sec: int = None, max_duration_sec: int = None) -> dict:
    """Record a new VM session (on launch)."""
    now = datetime.now(timezone.utc).isoformat()
    with get_db() as conn:
        conn.execute(
            """INSERT OR REPLACE INTO vm_sessions
               (microvm_id, notebook_id, session_id, memory_mib, state, endpoint, launched_at, idle_timeout_sec, max_duration_sec)
               VALUES (?, ?, ?, ?, 'RUNNING', ?, ?, ?, ?)""",
            (microvm_id, notebook_id, session_id, memory_mib, endpoint, now, idle_timeout_sec, max_duration_sec)
        )
        conn.execute(
            "INSERT INTO vm_state_log (microvm_id, timestamp, old_state, new_state) VALUES (?, ?, NULL, 'RUNNING')",
            (microvm_id, now)
        )
    return {"microvm_id": microvm_id, "state": "RUNNING", "launched_at": now}


def vm_session_update_state(microvm_id: str, new_state: str):
    """Update VM state and log the transition."""
    now = datetime.now(timezone.utc).isoformat()
    with get_db() as conn:
        row = conn.execute("SELECT state FROM vm_sessions WHERE microvm_id = ?", (microvm_id,)).fetchone()
        old_state = row["state"] if row else None

        if old_state == new_state:
            return  # No change

        conn.execute("UPDATE vm_sessions SET state = ? WHERE microvm_id = ?", (new_state, microvm_id))
        conn.execute(
            "INSERT INTO vm_state_log (microvm_id, timestamp, old_state, new_state) VALUES (?, ?, ?, ?)",
            (microvm_id, now, old_state, new_state)
        )

        if new_state == "TERMINATED":
            conn.execute("UPDATE vm_sessions SET terminated_at = ? WHERE microvm_id = ?", (now, microvm_id))


def vm_session_update_cost(microvm_id: str, running_secs: float, suspended_secs: float, total_cost: float):
    """Update accumulated cost for a VM session."""
    with get_db() as conn:
        conn.execute(
            "UPDATE vm_sessions SET running_secs = ?, suspended_secs = ?, total_cost_usd = ? WHERE microvm_id = ?",
            (running_secs, suspended_secs, total_cost, microvm_id)
        )


def vm_session_get(microvm_id: str) -> dict | None:
    """Get a VM session."""
    with get_db() as conn:
        row = conn.execute("SELECT * FROM vm_sessions WHERE microvm_id = ?", (microvm_id,)).fetchone()
    return dict(row) if row else None


def vm_session_list_active() -> list[dict]:
    """List all non-terminated VM sessions."""
    with get_db() as conn:
        rows = conn.execute("SELECT * FROM vm_sessions WHERE state != 'TERMINATED' ORDER BY launched_at DESC").fetchall()
    return [dict(r) for r in rows]


# ============================================================
# METRICS OPERATIONS
# ============================================================

def metrics_record(microvm_id: str, cpu_pct: float, mem_pct: float, mem_used_mb: float,
                   disk_pct: float, disk_used_mb: float, net_bytes_sent: int, net_bytes_recv: int,
                   processes: int, uptime_sec: float):
    """Record a metrics snapshot for a VM."""
    now = datetime.now(timezone.utc).isoformat()
    with get_db() as conn:
        conn.execute(
            """INSERT INTO vm_metrics (microvm_id, timestamp, cpu_pct, mem_pct, mem_used_mb,
               disk_pct, disk_used_mb, net_bytes_sent, net_bytes_recv, processes, uptime_sec)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (microvm_id, now, cpu_pct, mem_pct, mem_used_mb, disk_pct, disk_used_mb,
             net_bytes_sent, net_bytes_recv, processes, uptime_sec)
        )


def metrics_get_latest(microvm_id: str) -> dict | None:
    """Get the most recent metrics snapshot for a VM."""
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM vm_metrics WHERE microvm_id = ? ORDER BY timestamp DESC LIMIT 1",
            (microvm_id,)
        ).fetchone()
    return dict(row) if row else None


def metrics_get_history(microvm_id: str, minutes: int = 5) -> list[dict]:
    """Get metrics history for a VM (for sparkline charts)."""
    with get_db() as conn:
        rows = conn.execute(
            """SELECT timestamp, cpu_pct, mem_pct, disk_pct, net_bytes_sent, net_bytes_recv
               FROM vm_metrics
               WHERE microvm_id = ? AND timestamp >= datetime('now', ?)
               ORDER BY timestamp ASC""",
            (microvm_id, f"-{minutes} minutes")
        ).fetchall()
    return [dict(r) for r in rows]


def metrics_cleanup(hours: int = 24):
    """Delete metrics older than N hours to prevent unbounded growth."""
    with get_db() as conn:
        conn.execute(
            "DELETE FROM vm_metrics WHERE timestamp < datetime('now', ?)",
            (f"-{hours} hours",)
        )


# ============================================================
# AI SESSION OPERATIONS
# ============================================================

def ai_session_get(session_id: str) -> list:
    """Get AI chat messages for a session."""
    with get_db() as conn:
        row = conn.execute("SELECT messages_json FROM ai_sessions WHERE id = ?", (session_id,)).fetchone()
    if not row:
        return []
    return json.loads(row["messages_json"] or "[]")


def ai_session_save(session_id: str, notebook_id: str, messages: list):
    """Save AI chat messages for a session."""
    now = datetime.now(timezone.utc).isoformat()
    messages_json = json.dumps(messages)
    with get_db() as conn:
        conn.execute(
            """INSERT INTO ai_sessions (id, notebook_id, messages_json, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET messages_json = ?, updated_at = ?""",
            (session_id, notebook_id, messages_json, now, now, messages_json, now)
        )


def ai_session_delete(session_id: str):
    """Clear AI chat for a session."""
    with get_db() as conn:
        conn.execute("DELETE FROM ai_sessions WHERE id = ?", (session_id,))
