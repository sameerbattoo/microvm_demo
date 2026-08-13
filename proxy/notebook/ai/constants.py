"""
Constants for the AI module.

All tunable parameters, truncation limits, and model configuration
are defined here to avoid hardcoded values throughout the codebase.
"""

# ============================================================
# MODEL CONFIGURATION
# ============================================================

# Default model for the notebook agent and one-shot calls
DEFAULT_MODEL_ID = "us.anthropic.claude-sonnet-4-6"
DEFAULT_REGION = "us-west-2"

# Generation parameters
AGENT_TEMPERATURE = 0.2          # Low temperature for code generation (deterministic)
AGENT_MAX_TOKENS = 32768          # Max output tokens (model supports up to 64K)
TAG_TEMPERATURE = 0.0            # Zero temperature for tag suggestion (single-word answers)
TAG_MAX_TOKENS = 10              # Very short response for tag suggestions
EXPLAIN_MAX_TOKENS = 512         # Explanation should be concise
FIX_MAX_TOKENS = 4096            # Must be large enough for full cell replacement (long cells with charts)

# ============================================================
# CONTEXT TRUNCATION LIMITS
#
# These control how much text we send to the LLM to stay within
# reasonable token budgets while preserving relevant context.
# Claude Sonnet supports 200K tokens, but shorter context = faster
# inference and more focused responses.
# ============================================================

# Per-cell truncation when building notebook state for the agent
CELL_CODE_MAX_CHARS = 200        # First 200 chars of code (captures imports + key logic)
CELL_OUTPUT_MAX_CHARS = 150      # First 150 chars of output (captures key result)
CELL_ERROR_MAX_CHARS = 150       # First 150 chars of error (captures the traceback line)
MARKDOWN_PREVIEW_MAX_CHARS = 100 # First 100 chars of markdown (captures heading/summary)

# Variable preview truncation
VARIABLE_PREVIEW_MAX_CHARS = 200 # Variable value preview sent to agent

# HTTP error response truncation
HTTP_ERROR_BODY_MAX_CHARS = 500  # Truncate HTTP error bodies for readability

# Max cells to include in notebook context sent to agent
MAX_CELLS_IN_CONTEXT = 10       # Send at most 10 cells (keeps context focused)

# Max cells sent for tag suggestion (lightweight call)
MAX_CELLS_FOR_TAG = 4           # 4 cells is enough to classify notebook topic

# Tag suggestion max length
TAG_MAX_LENGTH = 25             # Max characters for a suggested tag

# Chat message cell context truncation (frontend → backend)
CHAT_CELL_CODE_MAX_CHARS = 300  # More generous for chat (user may reference specific code)
CHAT_CELL_OUTPUT_MAX_CHARS = 200

# ============================================================
# BEDROCK CLIENT CONFIGURATION
# ============================================================

BEDROCK_MAX_RETRIES = 5          # Retry attempts for transient errors
BEDROCK_READ_TIMEOUT = 120       # 2 min read timeout for model responses
BEDROCK_CONNECT_TIMEOUT = 10     # 10s connection timeout

# ============================================================
# SESSION CONFIGURATION
# ============================================================

# Auto-tag trigger threshold
AUTO_TAG_MIN_EXECUTED_CELLS = 2  # Minimum cells with output to trigger auto-tagging

# Agent conversation window
AGENT_CONVERSATION_WINDOW_SIZE = 10  # Keep last 10 messages (5 user + 5 assistant turns)
