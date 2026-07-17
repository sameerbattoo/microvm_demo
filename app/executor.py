"""
Sandboxed Python Code Executor

Maintains a persistent namespace across executions — variables, functions,
imports all survive between calls. This is the core of the agent sandbox:
AI-generated code runs here, accumulating state like a notebook kernel.
"""

import io
import sys
import ctypes
import threading
import traceback
import subprocess
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any


@dataclass
class ExecutionResult:
    """Result of a code execution."""
    success: bool
    output: str = ""
    error: str = ""
    variables_created: list[str] = field(default_factory=list)
    execution_time_ms: float = 0.0
    html: str = ""      # HTML table output (for DataFrames)
    image: str = ""     # Base64 PNG image (for matplotlib plots)


class SandboxExecutor:
    """
    Executes Python code in a persistent namespace.

    Key properties:
    - Variables persist across executions (stateful, like a Jupyter kernel)
    - stdout/stderr are captured and returned
    - Exceptions are caught and reported without crashing the sandbox
    - The namespace can be introspected (list variables, get types/values)
    """

    def __init__(self):
        self._namespace: dict[str, Any] = {}
        self._execution_count: int = 0
        self._history: list[dict] = []
        self._created_at = datetime.now(timezone.utc)
        self._exec_thread: threading.Thread | None = None
        self._exec_thread_id: int | None = None

    def interrupt(self) -> bool:
        """
        Interrupt a running execution by raising KeyboardInterrupt in the exec thread.
        Returns True if an interrupt was sent, False if nothing was running.
        """
        tid = self._exec_thread_id
        if tid is None:
            return False
        # Raise KeyboardInterrupt in the target thread
        res = ctypes.pythonapi.PyThreadState_SetAsyncExc(
            ctypes.c_ulong(tid),
            ctypes.py_object(KeyboardInterrupt)
        )
        return res > 0

    def execute(self, code: str) -> ExecutionResult:
        """
        Execute Python code in the persistent namespace.

        All variables defined will be available in subsequent executions.
        This is how AI agents build up state across multi-step tasks.
        """
        self._execution_count += 1
        start = datetime.now(timezone.utc)

        # Capture stdout/stderr
        stdout_capture = io.StringIO()
        stderr_capture = io.StringIO()

        old_stdout = sys.stdout
        old_stderr = sys.stderr
        sys.stdout = stdout_capture
        sys.stderr = stderr_capture

        variables_before = set(self._namespace.keys())

        # Track current thread for interrupt support
        self._exec_thread_id = threading.current_thread().ident

        # Clear any lingering matplotlib figure from previous execution
        # (prevents plots from bleeding into subsequent cells)
        try:
            import matplotlib.pyplot as plt
            plt.close('all')
        except (ImportError, Exception):
            pass

        try:
            # Try exec first (statements), fall back to eval (expressions)
            # If the last line is an expression, capture its value
            compiled = compile(code, "<sandbox>", "exec")
            exec(compiled, self._namespace)
            success = True
            error = ""
        except KeyboardInterrupt:
            success = False
            error = "Execution interrupted by user"
        except Exception as e:
            success = False
            # Show only the user-friendly error, not internal traceback
            error_type = type(e).__name__
            error_msg = str(e)
            # Extract the relevant line from the traceback
            tb = traceback.extract_tb(e.__traceback__)
            user_frames = [f for f in tb if f.filename == "<sandbox>"]
            if user_frames:
                frame = user_frames[-1]
                error = f"{error_type}: {error_msg} (line {frame.lineno})"
            else:
                error = f"{error_type}: {error_msg}"
        finally:
            self._exec_thread_id = None
            sys.stdout = old_stdout
            sys.stderr = old_stderr

        elapsed_ms = (datetime.now(timezone.utc) - start).total_seconds() * 1000
        variables_after = set(self._namespace.keys())
        new_vars = list(variables_after - variables_before)

        output = stdout_capture.getvalue()
        if stderr_capture.getvalue():
            output += stderr_capture.getvalue()

        html_output = ""
        image_output = ""

        if success:
            # Detect DataFrame as last expression result
            html_output = self._capture_dataframe(code)
            # Detect matplotlib plot
            image_output = self._capture_plot()

        result = ExecutionResult(
            success=success,
            output=output,
            error=error,
            variables_created=new_vars,
            execution_time_ms=round(elapsed_ms, 2),
            html=html_output,
            image=image_output,
        )

        # Record history (capped at 1000 entries to prevent unbounded memory growth)
        self._history.append({
            "execution_number": self._execution_count,
            "code": code[:500],  # truncate for history
            "success": success,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })
        if len(self._history) > 1000:
            self._history = self._history[-1000:]

        return result

    def _capture_dataframe(self, code: str) -> str:
        """If the last expression is a DataFrame, return its HTML table representation."""
        try:
            # Get the last line of code to check if it's an expression that yields a DataFrame
            lines = [l.strip() for l in code.strip().split('\n') if l.strip() and not l.strip().startswith('#')]
            if not lines:
                return ""
            last_line = lines[-1]

            # Skip assignments, imports, print statements, function calls that don't return
            if '=' in last_line and not last_line.startswith('=') and '==' not in last_line:
                return ""
            if last_line.startswith(('import ', 'from ', 'print(', 'def ', 'class ', 'for ', 'if ', 'while ')):
                return ""

            # Try to eval the last line and check if it's a DataFrame
            try:
                val = eval(last_line, self._namespace)
            except Exception:
                return ""

            # Check for pandas DataFrame or Series
            type_name = type(val).__name__
            module = type(val).__module__ or ""

            if 'pandas' in module and type_name in ('DataFrame', 'Series'):
                MAX_DISPLAY_ROWS = 50
                total_rows = len(val)
                if hasattr(val, 'head') and total_rows > MAX_DISPLAY_ROWS:
                    display_val = val.head(MAX_DISPLAY_ROWS)
                    html = display_val.to_html(classes='df-table', max_rows=MAX_DISPLAY_ROWS, max_cols=20)
                    html += f'<div class="df-truncation-note">Showing {MAX_DISPLAY_ROWS} of {total_rows} rows</div>'
                    return html
                else:
                    return val.to_html(classes='df-table', max_rows=MAX_DISPLAY_ROWS, max_cols=20)

            # Check for polars DataFrame
            if 'polars' in module and type_name in ('DataFrame', 'LazyFrame'):
                MAX_DISPLAY_ROWS = 50
                total_rows = len(val) if hasattr(val, '__len__') else 0
                if hasattr(val, 'head') and total_rows > MAX_DISPLAY_ROWS:
                    display_val = val.head(MAX_DISPLAY_ROWS)
                    html = display_val.to_pandas().to_html(classes='df-table', max_rows=MAX_DISPLAY_ROWS, max_cols=20)
                    html += f'<div class="df-truncation-note">Showing {MAX_DISPLAY_ROWS} of {total_rows} rows</div>'
                    return html
                elif hasattr(val, 'head'):
                    display_val = val.head(MAX_DISPLAY_ROWS)
                    return display_val.to_pandas().to_html(classes='df-table', max_rows=MAX_DISPLAY_ROWS, max_cols=20)

        except Exception:
            pass
        return ""

    def _capture_plot(self) -> str:
        """If matplotlib has an active figure, capture it as base64 PNG and close it."""
        try:
            import matplotlib
            matplotlib.use('Agg')  # Ensure non-interactive backend
            import matplotlib.pyplot as plt

            fig = plt.gcf()
            if fig.get_axes():  # Only if there are actual axes/plots
                buf = io.BytesIO()
                fig.savefig(buf, format='png', dpi=100, bbox_inches='tight',
                           facecolor='#1e1e2e', edgecolor='none')
                buf.seek(0)
                import base64
                img_b64 = base64.b64encode(buf.read()).decode('utf-8')
                plt.close(fig)
                return f"data:image/png;base64,{img_b64}"
        except ImportError:
            pass
        except Exception:
            pass
        return ""

    def install_package(self, package: str) -> ExecutionResult:
        """Install a pip package into the sandbox runtime."""
        try:
            result = subprocess.run(
                [sys.executable, "-m", "pip", "install", "--quiet", package],
                capture_output=True,
                text=True,
                timeout=120,
            )
            if result.returncode == 0:
                return ExecutionResult(
                    success=True,
                    output=f"Successfully installed {package}",
                )
            else:
                return ExecutionResult(
                    success=False,
                    error=result.stderr,
                )
        except subprocess.TimeoutExpired:
            return ExecutionResult(
                success=False,
                error=f"Installation of {package} timed out (120s limit)",
            )
        except Exception as e:
            return ExecutionResult(
                success=False,
                error=str(e),
            )

    def get_variables(self) -> dict[str, dict]:
        """
        Return all user-defined variables with type, preview, and metadata.

        Provides rich info for the variable explorer:
        - type: Python type name
        - value: short repr (truncated to 100 chars)
        - size: human-readable memory size
        - shape: for DataFrames/arrays/lists (e.g. "500 rows × 8 cols")
        - preview: first few items or .head() for collections
        """
        variables = {}
        for name, value in self._namespace.items():
            if name.startswith("__") and name.endswith("__"):
                continue
            # Skip modules, functions, classes
            type_name = type(value).__name__
            module = getattr(type(value), '__module__', '') or ''
            if type_name in ('module', 'function', 'builtin_function_or_method', 'type'):
                continue

            try:
                # Basic repr (short)
                val_repr = repr(value)
                if len(val_repr) > 100:
                    val_repr = val_repr[:100] + "..."

                # Size
                try:
                    size_bytes = sys.getsizeof(value)
                    if size_bytes < 1024:
                        size_str = f"{size_bytes} B"
                    elif size_bytes < 1024 * 1024:
                        size_str = f"{size_bytes / 1024:.1f} KB"
                    else:
                        size_str = f"{size_bytes / (1024 * 1024):.1f} MB"
                except Exception:
                    size_str = ""

                # Shape / length
                shape = ""
                preview = val_repr
                preview_type = "text"  # "text" or "html"
                if 'pandas' in module and type_name == 'DataFrame':
                    shape = f"{value.shape[0]} rows × {value.shape[1]} cols"
                    try:
                        preview = value.head(3).to_html(classes='var-df-preview', max_cols=6, max_rows=3)
                    except Exception:
                        pass
                    preview_type = "html"
                elif 'pandas' in module and type_name == 'Series':
                    shape = f"{len(value)} items"
                    try:
                        preview = value.head(5).to_frame().to_html(classes='var-df-preview', max_rows=5)
                        preview_type = "html"
                    except Exception:
                        pass
                elif 'numpy' in module and hasattr(value, 'shape'):
                    shape = f"shape {value.shape}"
                elif isinstance(value, (list, tuple)):
                    shape = f"{len(value)} items"
                    if len(value) > 5:
                        preview = repr(value[:5])[:-1] + ", ...]"
                        if len(preview) > 100:
                            preview = preview[:100] + "..."
                elif isinstance(value, dict):
                    shape = f"{len(value)} keys"
                    if len(value) > 3:
                        keys = list(value.keys())[:3]
                        preview = "{" + ", ".join(f"{repr(k)}: ..." for k in keys) + ", ...}"
                elif isinstance(value, str) and len(value) > 50:
                    shape = f"{len(value)} chars"

                variables[name] = {
                    "type": type_name,
                    "value": val_repr,
                    "size": size_str,
                    "shape": shape,
                    "preview": preview,
                    "preview_type": preview_type,
                }
            except Exception:
                variables[name] = {
                    "type": type_name,
                    "value": "<unable to inspect>",
                    "size": "",
                    "shape": "",
                    "preview": "",
                }
        return variables

    def reset(self):
        """Clear the namespace — fresh sandbox state."""
        self._namespace.clear()
        self._execution_count = 0
        self._history.clear()

    def get_stats(self) -> dict:
        """Return executor statistics."""
        return {
            "execution_count": self._execution_count,
            "variables_count": len(self.get_variables()),
            "created_at": self._created_at.isoformat(),
            "history_length": len(self._history),
        }
