"""
Session management for AI chat conversations.

Stores per-notebook conversation history in proxy process memory.
Keyed by session_id (UUID) for future AgentCore compatibility.
"""

from typing import Optional
from strands import Agent

# Session store: session_id -> Agent instance (which holds conversation history)
_sessions: dict[str, Agent] = {}


def get_session(session_id: str) -> Optional[Agent]:
    """Get an existing agent session by session ID."""
    return _sessions.get(session_id)


def save_session(session_id: str, agent: Agent) -> None:
    """Store an agent session."""
    _sessions[session_id] = agent


def clear_session(session_id: str) -> None:
    """Clear a session (new thread)."""
    _sessions.pop(session_id, None)


def list_sessions() -> list[str]:
    """List all active session IDs."""
    return list(_sessions.keys())
