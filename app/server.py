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
      platform/
        hooks.py        ← MicroVM lifecycle hooks (run, suspend, resume, terminate)
        checkpoint.py   ← S3 checkpoint/restore with timing
      notebook/
        executor.py     ← SandboxExecutor class (code execution engine)
        code_engine.py  ← Python execution: /execute endpoint
        sql_engine.py   ← SQL execution: /execute-sql with auto-routing
        routes.py       ← Utility: /install, /variables, /health, /metrics, /upload, /checkpoint-timings
"""

import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.notebook.executor import SandboxExecutor

# --- Logging ---
# Unified log format for all loggers (app + uvicorn access + uvicorn error)
# This ensures consistent output in CloudWatch for the logs panel.
LOG_FORMAT = "%(asctime)s [%(levelname)s] %(message)s"
logging.basicConfig(
    level=logging.INFO,
    format=LOG_FORMAT,
)

# Override uvicorn's formatters to match our format
for _logger_name in ("uvicorn", "uvicorn.access", "uvicorn.error"):
    _uv_logger = logging.getLogger(_logger_name)
    _uv_logger.handlers = []  # Remove uvicorn's default handlers
    _handler = logging.StreamHandler()
    _handler.setFormatter(logging.Formatter(LOG_FORMAT))
    _uv_logger.addHandler(_handler)
    _uv_logger.propagate = False

# Filter out noisy "Invalid HTTP request received" warnings (platform health probes)
class _InvalidHttpFilter(logging.Filter):
    def filter(self, record):
        return "Invalid HTTP request received" not in record.getMessage()

logging.getLogger("uvicorn.error").addFilter(_InvalidHttpFilter())

logger = logging.getLogger(__name__)

# =============================================================================
# PRE-LOADED LIBRARIES (Hot-loaded into the MicroVM image snapshot)
# =============================================================================
# Everything imported here is captured in the Firecracker memory snapshot at
# image build time. When a MicroVM launches, these are already in memory —
# eliminating first-cell import latency.
#
# ADD NEW LIBRARIES HERE if they're:
#   - Large (>100ms import time)
#   - Commonly used in notebook cells
#   - Pre-installed in requirements.txt
#
# DO NOT add libraries here that are only used by the proxy or internal code.
# This section is ONLY for user-facing notebook performance.
# =============================================================================

# Data manipulation
import pandas
import pandas.io.parsers       # read_csv (lazy-loaded by default)
import pandas.io.excel         # read_excel (lazy-loaded by default)
import numpy
import numpy.random
import numpy.linalg

# Visualization
import matplotlib
matplotlib.use('Agg')          # Non-interactive backend (required before pyplot import)
import matplotlib.pyplot
import matplotlib.figure
import plotly
import plotly.express
import plotly.graph_objects

# SQL engine
import duckdb

# AWS SDK
import boto3
import boto3.session

# DuckDB httpfs extension (S3 access from SQL cells)
# Pre-install so first SQL query against S3 doesn't pay the 3-4s cold start
_duckdb_warmup = duckdb.connect()
try:
    _duckdb_warmup.execute("INSTALL httpfs; LOAD httpfs;")
except Exception as e:
    logger.warning(f"Failed to pre-install httpfs extension: {e}")
_duckdb_warmup.close()
del _duckdb_warmup

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
from app.platform.checkpoint import CheckpointManager
app.state.checkpoint_manager = CheckpointManager(executor, session_state)

# --- Register route modules ---
from app.platform.hooks import router as hooks_router, proxy_router as hooks_proxy_router
from app.notebook.routes import router as routes_router
from app.notebook.code_engine import router as code_router
from app.notebook.sql_engine import router as sql_router

app.include_router(hooks_router)
app.include_router(hooks_proxy_router)
app.include_router(routes_router)
app.include_router(code_router)
app.include_router(sql_router)
