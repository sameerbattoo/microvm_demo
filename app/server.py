"""
Lambda MicroVM Agent Sandbox — Application Entrypoint

This FastAPI app runs inside a Lambda MicroVM and provides:
1. Code execution endpoints (the agent/UI sends code here)
2. Lifecycle hooks (AWS calls these during MicroVM state transitions)

The key insight: this is a STATEFUL server. The executor namespace persists
across HTTP requests AND across suspend/resume cycles. When the MicroVM
suspends, all memory is snapshotted. On resume, it's exactly as it was.

Architecture:
    app/
      server.py         ← This file (app setup, shared state, pre-loaded libs)
      executor.py       ← SandboxExecutor class (code execution engine)
      hooks.py          ← MicroVM lifecycle hooks (run, suspend, resume, terminate)
      routes.py         ← Sandbox API (execute, install, variables, upload, metrics)
      checkpoint.py     ← S3 checkpoint/restore logic
"""

import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.executor import SandboxExecutor

# --- Logging ---
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger(__name__)

# --- Pre-import heavy libraries so they're in the snapshot ---
# (eliminates first-cell import latency on MicroVM launch)
import pandas
import numpy
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot
import boto3
import boto3.session
import duckdb

# Pre-warm common pandas/numpy sub-modules that are lazy-loaded on first use
import pandas.io.parsers  # read_csv
import pandas.io.excel    # read_excel
import numpy.random
import numpy.linalg
import matplotlib.figure

# --- Persistent State ---
# These survive across requests AND across suspend/resume.
executor = SandboxExecutor()

session_state = {
    "microvm_id": None,
    "session_id": None,
    "started_at": None,
    "request_count": 0,
    "suspend_count": 0,
    "resume_count": 0,
    "checkpoint_enabled": False,
    "artifacts_bucket": None,
}

# --- FastAPI App ---
app = FastAPI(
    title="Agent Code Sandbox",
    description="Isolated code execution environment for AI agents",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Expose shared state via app.state for route modules
app.state.executor = executor
app.state.session_state = session_state

# Checkpoint manager (class-based — holds refs to executor + session_state)
from app.checkpoint import CheckpointManager
app.state.checkpoint_manager = CheckpointManager(executor, session_state)

# --- Register route modules ---
from app.hooks import router as hooks_router
from app.routes import router as routes_router
from app.code_engine import router as code_router
from app.sql_engine import router as sql_router

app.include_router(hooks_router)
app.include_router(routes_router)
app.include_router(code_router)
app.include_router(sql_router)
