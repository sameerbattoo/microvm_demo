"""
Notebook AI Agent powered by Strands Agents SDK.

Part of: proxy.notebook.ai (Notebook application layer)

Creates and manages per-session agent instances that can:
- Generate and insert code cells
- Fix errors in existing cells
- Explain outputs
- Execute code to verify solutions
- Inspect the notebook state and variables
"""

import os
import logging
from strands import Agent
from strands.models import BedrockModel
from strands.models.bedrock import CacheConfig
from strands.agent.conversation_manager import SlidingWindowConversationManager

from .prompts import NOTEBOOK_AGENT_PROMPT, FIX_ERROR_PROMPT
from .sessions import get_session, save_session, clear_session
from .constants import AGENT_TEMPERATURE, AGENT_MAX_TOKENS, FIX_MAX_TOKENS, AGENT_CONVERSATION_WINDOW_SIZE
from .tools.execution_tools import (
    execute_code, get_variables, get_notebook_state, set_execution_context,
    install_package, get_available_data_sources
)

logger = logging.getLogger(__name__)

# Model configuration
AI_MODEL_ID = os.environ.get("BEDROCK_MODEL_ID", "us.anthropic.claude-sonnet-4-6")
AI_REGION = os.environ.get("BEDROCK_REGION", os.environ.get("AWS_REGION", "us-west-2"))


class AgentTraceCallbackHandler:
    """Strands callback handler that logs what the agent is doing, step by step.

    Used for tracing long-running agent runs (e.g. the COMPLETE Workbook Intel flow)
    so we can see which tools the agent called, with what inputs, and what came back —
    rather than only the start/end boundaries. Does NOT stream raw text chunks (too
    noisy); it logs tool invocations, tool inputs, tool results (truncated), and
    reasoning summaries.

    Pass an instance as `callback_handler=` when creating the Agent.
    """

    # Keep logged tool inputs/outputs readable in the log
    _MAX_INPUT_CHARS = 600
    _MAX_RESULT_CHARS = 500

    def __init__(self, log_prefix: str):
        self._prefix = log_prefix          # e.g. "[intel] 16666093"
        self.tool_count = 0
        self._seen_tool_ids: set[str] = set()
        self._reasoning_logged = False

    def __call__(self, **kwargs) -> None:
        try:
            self._handle(**kwargs)
        except Exception as e:
            # Tracing must never break the agent run
            logger.debug(f"{self._prefix}    → [trace] callback error (ignored): {e}")

    def _handle(self, **kwargs) -> None:
        # 1) New tool invocation — detected from the raw model stream chunk.
        event = kwargs.get("event") or {}
        tool_use_start = (
            event.get("contentBlockStart", {}).get("start", {}).get("toolUse")
            if isinstance(event, dict) else None
        )
        if tool_use_start:
            tid = tool_use_start.get("toolUseId", "")
            if tid and tid not in self._seen_tool_ids:
                self._seen_tool_ids.add(tid)
                self.tool_count += 1
                logger.info(f"{self._prefix}    → [trace] tool #{self.tool_count}: "
                            f"{tool_use_start.get('name', '?')}")

        # 2) Assistant message committed — log the fully-assembled tool input args,
        #    and any assistant reasoning/text turn boundaries.
        message = kwargs.get("message")
        if isinstance(message, dict):
            role = message.get("role")
            for block in message.get("content", []) or []:
                if not isinstance(block, dict):
                    continue
                if role == "assistant" and "toolUse" in block:
                    tu = block["toolUse"]
                    self._log_kv(f"tool input [{tu.get('name','?')}]", tu.get("input"))
                elif role == "user" and "toolResult" in block:
                    tr = block["toolResult"]
                    status = tr.get("status", "")
                    text = self._extract_result_text(tr)
                    logger.info(f"{self._prefix}    → [trace] tool result "
                                f"({status}): {self._truncate(text, self._MAX_RESULT_CHARS)}")

    def _log_kv(self, label: str, value) -> None:
        import json as _json
        try:
            s = value if isinstance(value, str) else _json.dumps(value, default=str)
        except Exception:
            s = str(value)
        logger.info(f"{self._prefix}    → [trace] {label}: {self._truncate(s, self._MAX_INPUT_CHARS)}")

    @staticmethod
    def _extract_result_text(tool_result: dict) -> str:
        parts = []
        for c in tool_result.get("content", []) or []:
            if isinstance(c, dict):
                if "text" in c:
                    parts.append(str(c["text"]))
                elif "json" in c:
                    parts.append(str(c["json"]))
        return " ".join(parts).replace("\n", " ")

    @staticmethod
    def _truncate(s: str, limit: int) -> str:
        s = s or ""
        return s if len(s) <= limit else s[:limit] + f"… (+{len(s) - limit} chars)"

_model = None
_bedrock_direct_client = None


def get_model() -> BedrockModel:
    """Get or create the Bedrock model instance (singleton)."""
    global _model
    if _model is None:
        _model = BedrockModel(
            model_id=AI_MODEL_ID,
            region_name=AI_REGION,
            temperature=AGENT_TEMPERATURE,
            max_tokens=AGENT_MAX_TOKENS,
            cache_config=CacheConfig(strategy="auto"),
            cache_tools="default",
        )
    return _model


def _get_direct_client():
    """Get a cached Bedrock client for one-shot calls (explain, fix)."""
    global _bedrock_direct_client
    if _bedrock_direct_client is None:
        import boto3
        from botocore.config import Config
        _bedrock_direct_client = boto3.client(
            "bedrock-runtime",
            region_name=AI_REGION,
            config=Config(retries={'max_attempts': 3, 'mode': 'standard'}, read_timeout=60),
        )
    return _bedrock_direct_client


# Tools available to the notebook agent (no direct notebook modification — user applies via "Apply" buttons)
AGENT_TOOLS = [execute_code, get_variables, get_notebook_state, install_package, get_available_data_sources]


def get_or_create_agent(session_id: str, context: dict = None, callback_handler=None) -> Agent:
    """
    Get an existing agent for this session or create a new one.
    Uses SlidingWindowConversationManager to limit context to last 10 messages (5 turns).

    callback_handler: optional Strands callback handler for step-by-step tracing.
        Defaults to None (silent) for the interactive chat agent; the COMPLETE intel
        flow passes an AgentTraceCallbackHandler to log tool calls/inputs/results.
    """
    from datetime import datetime, timezone
    import os

    agent = get_session(session_id)
    if agent is None:
        # Inject dynamic context into the system prompt
        now = datetime.now(timezone.utc)
        aws_region = os.environ.get("AWS_REGION", "us-west-2")

        # Memory tier from context (if available)
        memory_tier = "Unknown"
        if context and context.get("memory_mib"):
            mem_mib = int(context["memory_mib"])
            memory_tier = f"{mem_mib} MB ({mem_mib / 1024:.1f} GB / {mem_mib / 2048:.1f} vCPU)"

        system_prompt = NOTEBOOK_AGENT_PROMPT.format(
            current_time=now.strftime("%Y-%m-%d %H:%M UTC (%A)"),
            aws_region=aws_region,
            memory_tier=memory_tier,
            athena_workgroup=os.environ.get("ATHENA_WORKGROUP", "microvm-demo"),
            athena_db=os.environ.get("ATHENA_DB", "microvm_demo_db"),
            s3_bucket=os.environ.get("ARTIFACT_BUCKET", f"microvm-sandbox-artifacts-{os.environ.get('ACCOUNT_ID', 'unknown')}-{aws_region}"),
            dynamo_table_prefix=os.environ.get("DYNAMO_TABLE", "microvm-demo").rsplit("-", 1)[0] + "-",
        )
        agent = Agent(
            model=get_model(),
            system_prompt=system_prompt,
            tools=AGENT_TOOLS,
            conversation_manager=SlidingWindowConversationManager(window_size=AGENT_CONVERSATION_WINDOW_SIZE),
            callback_handler=callback_handler,
            trace_attributes={"session.id": session_id},
        )
        save_session(session_id, agent)
        logger.info(f"Created new agent session: {session_id} (region={aws_region}, memory={memory_tier})")
    return agent


def chat(session_id: str, message: str, context: dict) -> str:
    """
    Send a message to the notebook agent and get a response.

    Args:
        session_id: UUID session identifier
        message: User's message
        context: Dict with proxy_url, microvm_id, microvm_endpoint, notebook_cells

    Returns:
        Agent's text response (may also include tool actions in the conversation)
    """
    # Set execution context so tools can reach the MicroVM
    set_execution_context(context)

    agent = get_or_create_agent(session_id, context)
    result = agent(message)

    # Extract text response
    return str(result)


async def chat_stream(session_id: str, message: str, context: dict):
    """
    Send a message to the notebook agent and stream the response.

    Args:
        session_id: UUID session identifier
        message: User's message
        context: Dict with proxy_url, microvm_id, microvm_endpoint, notebook_cells

    Yields:
        Dict events: {"type": "text", "content": "..."} or {"type": "action", "data": {...}}
    """
    import json

    # Set execution context so tools can reach the MicroVM
    set_execution_context(context)

    agent = get_or_create_agent(session_id, context)

    async for event in agent.stream_async(message):
        if "data" in event:
            yield {"type": "text", "content": event["data"]}
        elif "current_tool_use" in event:
            tool_use = event["current_tool_use"]
            tool_name = tool_use.get("name", "")
            tool_output = tool_use.get("output", "")

            # If it's a notebook action tool, parse and emit the action
            if tool_name in ("insert_cell", "edit_cell", "delete_cell") and tool_output:
                try:
                    action_data = json.loads(tool_output)
                    yield {"type": "action", "data": action_data}
                except (json.JSONDecodeError, TypeError):
                    pass


def annotate_notebook(cells: list) -> dict:
    """
    One-shot: document a whole notebook in a single pass. Returns
      {"root": str|None,
       "sections": [{"before_index": int, "markdown": str}],
       "comments": [{"index": int, "comment": str}]}
    Cells are referenced by their position in the input list.
    """
    from .prompts import ANNOTATE_PROMPT
    import json as json_mod

    # Build an index-addressable, compact view of the notebook.
    lines = []
    for i, c in enumerate(cells or []):
        ctype = (c.get("type") or "code").lower()
        code = (c.get("code") or "").strip()
        if ctype == "markdown":
            lines.append(f"[{i}] MARKDOWN\n{code[:400]}")
        else:
            out = (c.get("output") or "").strip()
            snippet = f"\n(output: {out[:200]})" if out else ""
            lines.append(f"[{i}] {ctype.upper()}\n{code[:800]}{snippet}")
    cells_repr = "\n\n".join(lines) if lines else "(empty notebook)"

    prompt = ANNOTATE_PROMPT.format(cells=cells_repr)
    client = _get_direct_client()

    response = client.converse(
        modelId=AI_MODEL_ID,
        messages=[{"role": "user", "content": [{"text": prompt}]}],
        inferenceConfig={"maxTokens": AGENT_MAX_TOKENS, "temperature": AGENT_TEMPERATURE},
    )
    text = response["output"]["message"]["content"][0]["text"].strip()

    # Strip markdown fences if present
    if text.startswith("```json"):
        text = text.split("```json", 1)[1].rsplit("```", 1)[0].strip()
    elif text.startswith("```"):
        _l = text.split("\n")
        text = "\n".join(_l[1:-1] if _l[-1].strip() == "```" else _l[1:]).strip()

    try:
        data = json_mod.loads(text)
    except (json_mod.JSONDecodeError, TypeError):
        import re as _re
        m = _re.search(r'\{[\s\S]*\}', text)
        try:
            data = json_mod.loads(m.group(0)) if m else {}
        except (json_mod.JSONDecodeError, TypeError):
            data = {}

    n = len(cells or [])
    sections = [
        {"before_index": s["before_index"], "markdown": s["markdown"]}
        for s in (data.get("sections") or [])
        if isinstance(s, dict) and isinstance(s.get("before_index"), int)
        and 0 <= s["before_index"] <= n and s.get("markdown")
    ]
    comments = [
        {"index": c["index"], "comment": c["comment"]}
        for c in (data.get("comments") or [])
        if isinstance(c, dict) and isinstance(c.get("index"), int)
        and 0 <= c["index"] < n and c.get("comment")
    ]
    return {"root": data.get("root") or None, "sections": sections, "comments": comments}


def fix_error(code: str, error: str, context: dict) -> str:
    """
    One-shot: fix a cell's error and return corrected code.
    Uses a direct model call (no agent loop) for speed.
    """
    from .prompts import FIX_ERROR_PROMPT, FIX_SQL_ERROR_PROMPT

    cell_type = context.get("cell_type", "code")
    if cell_type == "markdown":
        return code  # Markdown cells don't have execution errors to fix

    # Build context section for the prompt
    context_section = ""
    variables = context.get("variables", [])
    data_sources = context.get("data_sources")
    cells = context.get("cells", [])

    if variables:
        context_section += f"\n<available_variables>\n{', '.join(variables[:30])}\n</available_variables>\n"

    if data_sources:
        ds_lines = []
        if data_sources.get("s3"):
            for f in data_sources["s3"][:5]:
                uri = f.get("uri") or f.get("key", "")
                ds_lines.append(f"  S3: {uri}")
        if data_sources.get("dynamodb"):
            for t in data_sources["dynamodb"][:5]:
                ds_lines.append(f"  DynamoDB: {t.get('name', '')}")
        if data_sources.get("athena"):
            for t in data_sources["athena"][:5]:
                db = t.get("database", "")
                cols = t.get("columns", [])
                col_names = ", ".join(c.get("name", "") for c in cols[:8]) if cols and isinstance(cols[0], dict) else ""
                col_info = f" [{col_names}]" if col_names else ""
                ds_lines.append(f"  Athena: {db}.{t.get('name', '')}{col_info}")
        if ds_lines:
            context_section += f"\n<available_data_sources>\n" + "\n".join(ds_lines) + "\n</available_data_sources>\n"

    if cells:
        prev_code = "\n---\n".join(c.get("code", "")[:200] for c in cells[-5:])
        context_section += f"\n<previous_cells>\n{prev_code}\n</previous_cells>\n"

    if cell_type == "sql":
        prompt = FIX_SQL_ERROR_PROMPT.format(code=code, error=error) + context_section
    else:
        prompt = FIX_ERROR_PROMPT.format(code=code, error=error) + context_section

    client = _get_direct_client()

    response = client.converse(
        modelId=AI_MODEL_ID,
        messages=[{"role": "user", "content": [{"text": prompt}]}],
        inferenceConfig={"maxTokens": FIX_MAX_TOKENS, "temperature": 0.1},
    )

    response_text = response["output"]["message"]["content"][0]["text"].strip()

    # Clean markdown fences if present
    if cell_type == "sql":
        if "```sql" in response_text:
            parts = response_text.split("```sql")
            if len(parts) > 1:
                return parts[1].split("```")[0].strip()
    else:
        if "```python" in response_text:
            parts = response_text.split("```python")
            if len(parts) > 1:
                return parts[1].split("```")[0].strip()

    if response_text.startswith("```") and response_text.endswith("```"):
        lines = response_text.split("\n")
        return "\n".join(lines[1:-1]).strip()

    return response_text


def suggest_shell_command(description: str, context: dict) -> str:
    """
    One-shot: convert natural language to a shell command.
    Uses a direct model call for speed (no agent loop).
    """
    from .prompts import TERMINAL_SUGGEST_PROMPT, TERMINAL_ENV_INFO

    cwd = context.get("cwd", "/tmp")
    packages = context.get("packages", [])
    files = context.get("files", [])
    terminal_history = context.get("terminal_history", "")

    # Build environment info with dynamic context
    env_info = list(TERMINAL_ENV_INFO)
    if files:
        env_info.append(f"Files in /tmp: {', '.join(files[:15])}")
    if packages:
        extra_pkgs = [p for p in packages[:10] if p not in ("pandas", "numpy", "matplotlib")]
        if extra_pkgs:
            env_info.append(f"User-installed packages: {', '.join(extra_pkgs)}")

    prompt = TERMINAL_SUGGEST_PROMPT.format(
        env_info=chr(10).join(env_info),
        cwd=cwd,
        description=description,
    )

    # Add terminal history if available (helps with contextual commands)
    if terminal_history.strip():
        # Truncate to last 1500 chars to stay within token budget
        history = terminal_history.strip()[-1500:]
        prompt += f"\n<recent_terminal_output>\n{history}\n</recent_terminal_output>\n"

    client = _get_direct_client()

    response = client.converse(
        modelId=AI_MODEL_ID,
        messages=[{"role": "user", "content": [{"text": prompt}]}],
        inferenceConfig={"maxTokens": 150, "temperature": 0.1},
    )

    command = response["output"]["message"]["content"][0]["text"].strip()

    # Clean markdown fences if model wraps it
    if command.startswith("```") and command.endswith("```"):
        lines = command.split("\n")
        command = "\n".join(lines[1:-1]).strip()
    if command.startswith("```bash"):
        command = command[7:]
    if command.startswith("```"):
        command = command[3:]
    if command.endswith("```"):
        command = command[:-3]

    # Force single line — replace newlines with semicolons or &&
    command = command.strip()
    if "\n" in command:
        lines = [l.strip() for l in command.split("\n") if l.strip()]
        command = " && ".join(lines)

    return command


def new_thread(session_id: str) -> None:
    """Clear conversation history for a session (start fresh thread)."""
    clear_session(session_id)
    logger.info(f"Cleared agent session: {session_id}")
