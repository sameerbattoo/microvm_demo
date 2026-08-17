"""
Sandboxed Python Code Executor

Part of: app.notebook (application layer)

Maintains a persistent namespace across executions — variables, functions,
imports all survive between calls. This is the core of the agent sandbox:
AI-generated code runs here, accumulating state like a notebook kernel.
"""

import io
import os
import sys
import ctypes
import threading
import traceback
import subprocess
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

# Maximum time (seconds) a single cell execution is allowed to run before
# being forcefully interrupted. Configurable via environment variable.
EXECUTION_TIMEOUT_SECONDS = int(os.environ.get("EXECUTION_TIMEOUT_SECONDS", "60"))


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
        # Pre-import heavy packages to reduce first-cell execution time
        self._preload_packages()
        # Inject helper functions into the namespace (available in every cell)
        self._inject_helpers()
        # Set default Plotly dark theme (matches the notebook UI)
        self._set_plotly_defaults()

    def _preload_packages(self):
        """Pre-import heavy packages into the interpreter cache (not the namespace).
        This makes the first user cell that imports these packages much faster."""
        import importlib
        for pkg in ['pandas', 'numpy', 'matplotlib', 'matplotlib.pyplot', 'boto3', 'requests']:
            try:
                importlib.import_module(pkg)
            except ImportError:
                pass

    def _inject_helpers(self):
        """Inject helper functions into the namespace so they're available in every cell."""
        try:
            from app.notebook import helpers
            # Add all public functions from helpers to the namespace
            for name in dir(helpers):
                if not name.startswith('_'):
                    obj = getattr(helpers, name)
                    if callable(obj):
                        self._namespace[name] = obj
        except ImportError:
            pass  # Helpers not available (shouldn't happen in normal operation)

    def _set_plotly_defaults(self):
        """Set Plotly default template to dark theme (matches the notebook UI).
        Users can override with: pio.templates.default = 'plotly' (for light)."""
        try:
            import plotly.io as pio
            pio.templates.default = 'plotly_dark'
        except ImportError:
            pass

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

        # Provide a display() function (like Jupyter's IPython.display.display)
        # that allows users to explicitly render objects from anywhere in the code
        # (inside if/else blocks, loops, functions, etc.)
        display_outputs = []  # collects (type, value) tuples

        def _display_fn(*objs):
            """Display objects — works from inside conditionals, loops, and functions."""
            for obj in objs:
                display_outputs.append(obj)

        self._namespace['display'] = _display_fn

        # Track current thread for interrupt support
        self._exec_thread_id = threading.current_thread().ident

        # Clear any lingering matplotlib figure from previous execution
        # (prevents plots from bleeding into subsequent cells)
        try:
            import matplotlib.pyplot as plt
            plt.close('all')
        except (ImportError, Exception):
            pass

        # Execution timeout — prevents infinite loops from hanging the VM
        timed_out = threading.Event()

        def _timeout_trigger():
            timed_out.set()
            # Raise KeyboardInterrupt in the executing thread to break out
            tid = self._exec_thread_id
            if tid:
                ctypes.pythonapi.PyThreadState_SetAsyncExc(
                    ctypes.c_ulong(tid),
                    ctypes.py_object(KeyboardInterrupt)
                )

        timer = threading.Timer(EXECUTION_TIMEOUT_SECONDS, _timeout_trigger)
        timer.start()

        try:
            # Try exec first (statements), fall back to eval (expressions)
            # If the last line is an expression, capture its value
            compiled = compile(code, "<sandbox>", "exec")
            exec(compiled, self._namespace)
            success = True
            error = ""
        except KeyboardInterrupt:
            success = False
            if timed_out.is_set():
                error = f"Execution timed out after {EXECUTION_TIMEOUT_SECONDS}s — possible infinite loop or long-running computation"
            else:
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
            timer.cancel()
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
            # If no DataFrame/Plotly captured, check for any new Plotly figures in namespace
            if not html_output:
                html_output = self._capture_plotly_figure(code, variables_before)
            # Check explicit display() calls (works from inside if/else, loops, functions)
            if not html_output and display_outputs:
                html_output = self._capture_display_outputs(display_outputs)
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
        """If the last top-level expression is a DataFrame/Plotly figure, return its HTML.
        
        Uses Python's AST to correctly identify the last top-level expression,
        avoiding false matches from expressions inside if/else, for, while blocks.
        """
        import ast
        try:
            tree = ast.parse(code)
            if not tree.body:
                return ""
            
            last_node = tree.body[-1]
            
            # Only capture if the last top-level statement is a bare expression (Expr node)
            if not isinstance(last_node, ast.Expr):
                return ""
            
            # Compile and eval just the expression
            expr_code = ast.Expression(body=last_node.value)
            ast.fix_missing_locations(expr_code)
            
            try:
                val = eval(compile(expr_code, "<sandbox>", "eval"), self._namespace)
            except Exception:
                return ""
            
            if val is None:
                return ""

            type_name = type(val).__name__
            module = type(val).__module__ or ""

            # Check for pandas DataFrame or Series
            if 'pandas' in module and type_name in ('DataFrame', 'Series'):
                MAX_DISPLAY_ROWS = 50
                total_rows = len(val)

                if type_name == 'DataFrame' and hasattr(val, 'columns'):
                    if hasattr(val.columns, 'nlevels') and val.columns.nlevels > 1:
                        val = val.copy()
                        val.columns = ['_'.join(str(c) for c in col).strip('_') for col in val.columns]
                    if val.index.name or (hasattr(val.index, 'names') and any(n for n in val.index.names if n)):
                        val = val.reset_index()

                if hasattr(val, 'head') and total_rows > MAX_DISPLAY_ROWS:
                    display_val = val.head(MAX_DISPLAY_ROWS)
                    html = display_val.to_html(classes='df-table', max_rows=MAX_DISPLAY_ROWS, max_cols=20)
                    html += f'<div class="df-truncation-note">Showing {MAX_DISPLAY_ROWS} of {total_rows} rows</div>'
                    return self._linkify_urls(html)
                else:
                    return self._linkify_urls(val.to_html(classes='df-table', max_rows=MAX_DISPLAY_ROWS, max_cols=20))

            # Check for polars DataFrame
            if 'polars' in module and type_name in ('DataFrame', 'LazyFrame'):
                MAX_DISPLAY_ROWS = 50
                total_rows = len(val) if hasattr(val, '__len__') else 0
                if hasattr(val, 'head') and total_rows > MAX_DISPLAY_ROWS:
                    display_val = val.head(MAX_DISPLAY_ROWS)
                    html = display_val.to_pandas().to_html(classes='df-table', max_rows=MAX_DISPLAY_ROWS, max_cols=20)
                    html += f'<div class="df-truncation-note">Showing {MAX_DISPLAY_ROWS} of {total_rows} rows</div>'
                    return self._linkify_urls(html)
                elif hasattr(val, 'head'):
                    display_val = val.head(MAX_DISPLAY_ROWS)
                    return self._linkify_urls(display_val.to_pandas().to_html(classes='df-table', max_rows=MAX_DISPLAY_ROWS, max_cols=20))

            # Check for Plotly figures — render as interactive HTML
            if 'plotly' in module and type_name == 'Figure':
                try:
                    html = val.to_html(
                        full_html=False,
                        include_plotlyjs='cdn',
                        config={'responsive': True, 'displayModeBar': True},
                    )
                    return f'<div class="plotly-chart" data-plotly="true">{html}</div>'
                except Exception:
                    return ""

        except Exception:
            pass
        return ""

    @staticmethod
    def _linkify_urls(html: str) -> str:
        """Enhance table cells: clickable URLs, formatted numbers, truncated text, styled NaN/bools."""
        import re

        def enhance_cell(match):
            content = match.group(1)

            # Skip empty cells
            if not content.strip():
                return match.group(0)

            # NaN / None — muted italic
            if content.strip() in ('NaN', 'nan', 'None', 'NaT', ''):
                return f'<td class="df-cell-null">{content.strip()}</td>'

            # Booleans — colored badges
            if content.strip() == 'True':
                return '<td><span class="df-cell-bool df-bool-true">True</span></td>'
            if content.strip() == 'False':
                return '<td><span class="df-cell-bool df-bool-false">False</span></td>'

            # Image URLs — render as thumbnail
            if re.match(r'https?://\S+\.(png|jpg|jpeg|gif|svg|webp)(\?\S*)?$', content.strip(), re.IGNORECASE):
                url = content.strip()
                return f'<td><a href="{url}" target="_blank" rel="noopener"><img src="{url}" class="df-cell-img" alt="img"/></a></td>'

            # URLs — clickable links
            if re.match(r'https?://\S+$', content.strip()):
                url = content.strip()
                short = url if len(url) <= 60 else url[:57] + '...'
                return f'<td><a href="{url}" target="_blank" rel="noopener">{short}</a></td>'

            # Email addresses — mailto links
            if re.match(r'^[\w.+-]+@[\w-]+\.[\w.-]+$', content.strip()):
                email = content.strip()
                return f'<td><a href="mailto:{email}">{email}</a></td>'

            # Numbers — format with commas, color negatives red
            num_match = re.match(r'^-?\d[\d,]*\.?\d*$', content.strip())
            if num_match:
                try:
                    num = float(content.strip().replace(',', ''))
                    if num < 0:
                        formatted = f'{num:,.2f}' if '.' in content else f'{int(num):,}'
                        return f'<td class="df-cell-negative">{formatted}</td>'
                    elif abs(num) >= 1000:
                        formatted = f'{num:,.2f}' if '.' in content else f'{int(num):,}'
                        return f'<td>{formatted}</td>'
                except (ValueError, OverflowError):
                    pass

            # Long text — truncate with title tooltip
            if len(content) > 80:
                escaped = content.replace('"', '&quot;')
                truncated = content[:77] + '...'
                return f'<td title="{escaped}">{truncated}</td>'

            return match.group(0)

        return re.sub(r'<td>([^<]*)</td>', enhance_cell, html)

    def _capture_display_outputs(self, display_outputs: list) -> str:
        """Process objects passed to the display() function.
        
        Handles Plotly figures, DataFrames, and other rich objects — just like
        Jupyter's IPython.display.display(). This allows charts to render from
        inside if/else blocks, loops, and function calls.
        """
        for obj in display_outputs:
            try:
                type_name = type(obj).__name__
                module = type(obj).__module__ or ""

                # Plotly Figure
                if 'plotly' in module and type_name == 'Figure':
                    html = obj.to_html(
                        full_html=False,
                        include_plotlyjs='cdn',
                        config={'responsive': True, 'displayModeBar': True},
                    )
                    return f'<div class="plotly-chart" data-plotly="true">{html}</div>'

                # Pandas DataFrame/Series
                if 'pandas' in module and type_name in ('DataFrame', 'Series'):
                    MAX_DISPLAY_ROWS = 50
                    total_rows = len(obj)
                    if type_name == 'DataFrame' and hasattr(obj, 'columns'):
                        if hasattr(obj.columns, 'nlevels') and obj.columns.nlevels > 1:
                            obj = obj.copy()
                            obj.columns = ['_'.join(str(c) for c in col).strip('_') for col in obj.columns]
                        if obj.index.name or (hasattr(obj.index, 'names') and any(n for n in obj.index.names if n)):
                            obj = obj.reset_index()
                    if hasattr(obj, 'head') and total_rows > MAX_DISPLAY_ROWS:
                        display_val = obj.head(MAX_DISPLAY_ROWS)
                        html = display_val.to_html(classes='df-table', max_rows=MAX_DISPLAY_ROWS, max_cols=20)
                        html += f'<div class="df-truncation-note">Showing {MAX_DISPLAY_ROWS} of {total_rows} rows</div>'
                        return self._linkify_urls(html)
                    else:
                        return self._linkify_urls(obj.to_html(classes='df-table', max_rows=MAX_DISPLAY_ROWS, max_cols=20))
            except Exception:
                continue
        return ""

    def _capture_plotly_figure(self, code: str, variables_before: set) -> str:
        """Check namespace for any Plotly Figure created or reassigned during this execution.

        This handles cases where a Plotly figure is created inside an if/else block
        or stored in a variable but not returned as the last expression.

        For well-known names ('fig', 'figure', 'chart'), the namespace persists across
        cells, so those names are frequently REUSED (e.g. every chart cell writes
        `fig = px.something(...)`). Checking "is this variable name new?" would skip
        every figure after the first cell that happens to use one of these names,
        silently dropping the chart. Instead, we parse the code that just ran (via ast)
        to see whether it actually assigns one of these names anywhere — including
        inside if/else/for blocks — and only then treat the current value as this
        execution's output. This avoids relying on object identity/memory-address
        comparisons, which are unreliable in CPython due to id() reuse after garbage
        collection.
        """
        try:
            import plotly.graph_objects as go

            # Look for entirely new variables that are Plotly Figures
            for var_name in set(self._namespace.keys()) - variables_before - {'__builtins__'}:
                val = self._namespace.get(var_name)
                if isinstance(val, go.Figure):
                    return self._render_plotly_html(val)

            # Also check well-known figure variable names, but only if THIS cell's
            # code actually assigned to that name (at any nesting level).
            assigned_names = self._assigned_names(code)
            for var_name in ('fig', 'figure', 'chart'):
                if var_name not in assigned_names:
                    continue  # this cell didn't touch the name — don't re-show a stale figure
                val = self._namespace.get(var_name)
                if isinstance(val, go.Figure):
                    return self._render_plotly_html(val)
        except ImportError:
            pass
        except Exception:
            pass
        return ""

    @staticmethod
    def _render_plotly_html(fig) -> str:
        """Render a Plotly Figure to the HTML snippet used for cell output."""
        html = fig.to_html(
            full_html=False,
            include_plotlyjs='cdn',
            config={'responsive': True, 'displayModeBar': True},
        )
        return f'<div class="plotly-chart" data-plotly="true">{html}</div>'

    @staticmethod
    def _assigned_names(code: str) -> set:
        """Return every simple name assigned anywhere in the code (any nesting level,
        including inside if/else/for/while/functions). Used to detect whether a cell
        writes to a well-known variable name like `fig`, without relying on
        before/after namespace diffing (which breaks when the same name is reused
        across cells) or object identity (which is unreliable due to id() reuse).
        """
        import ast
        names = set()
        try:
            tree = ast.parse(code)
        except SyntaxError:
            return names
        for node in ast.walk(tree):
            targets = []
            if isinstance(node, ast.Assign):
                targets = node.targets
            elif isinstance(node, ast.AnnAssign):
                targets = [node.target]
            elif isinstance(node, ast.AugAssign):
                targets = [node.target]
            elif isinstance(node, ast.NamedExpr):  # walrus operator: fig := ...
                targets = [node.target]
            for target in targets:
                for n in ast.walk(target):
                    if isinstance(n, ast.Name):
                        names.add(n.id)
        return names

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
        import re

        # SECURITY: Validate package name to prevent command injection and flag injection.
        # Valid pip package names: letters, digits, hyphens, dots, underscores.
        # Optionally with version specifier (e.g. pandas==2.0, requests>=2.28).
        PACKAGE_NAME_PATTERN = re.compile(
            r'^[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?'  # package name
            r'(\[([a-zA-Z0-9._-]+,?\s*)*\])?'  # optional extras like [dev,test]
            r'([><=!~]=?[a-zA-Z0-9.*]+)?$'  # optional version specifier
        )

        package = package.strip()
        if not package or not PACKAGE_NAME_PATTERN.match(package):
            return ExecutionResult(
                success=False,
                error=f"Invalid package name: '{package}'. Use a valid PyPI package name (e.g. 'pandas', 'requests>=2.28').",
            )

        # SECURITY: Reject anything that looks like pip flags
        if package.startswith('-') or '--' in package or ' ' in package:
            return ExecutionResult(
                success=False,
                error=f"Invalid package name: '{package}'. Package names cannot contain flags or spaces.",
            )

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
        for name, value in list(self._namespace.items()):  # list() = snapshot to avoid mutation during iteration
            if name.startswith("__") and name.endswith("__"):
                continue
            if name.startswith("_"):
                continue  # skip private/internal vars (display, _auto_display, etc.)
            # Skip modules, functions, classes
            try:
                type_name = type(value).__name__
                module = getattr(type(value), '__module__', '') or ''
            except Exception:
                continue
            if type_name in ('module', 'function', 'builtin_function_or_method', 'type'):
                continue

            try:
                # Basic repr (short) — with safety timeout
                try:
                    val_repr = repr(value)
                    if len(val_repr) > 100:
                        val_repr = val_repr[:100] + "..."
                except Exception:
                    val_repr = f"<{type_name}>"

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
                    try:
                        shape = f"{value.shape[0]} rows × {value.shape[1]} cols"
                    except Exception:
                        shape = "DataFrame"
                    try:
                        preview = value.head(3).to_html(classes='var-df-preview', max_cols=6, max_rows=3)
                        preview_type = "html"
                    except Exception:
                        preview_type = "text"
                elif 'pandas' in module and type_name == 'Series':
                    try:
                        shape = f"{len(value)} items"
                    except Exception:
                        shape = "Series"
                    try:
                        preview = value.head(5).to_frame().to_html(classes='var-df-preview', max_rows=5)
                        preview_type = "html"
                    except Exception:
                        preview_type = "text"
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
