"""
AI Code Generation Utilities

Builds system prompts for code generation and extracts code from AI responses.
Used by the proxy server's /ai/generate endpoint.
"""

import re


def build_ai_system_prompt(notebook_context, cell_index, variables, current_cell_code=""):
    """
    Build a system prompt for the AI code generation model.

    Args:
        notebook_context: List of prior cell dicts with code/output/html
        cell_index: Index of the cell being generated
        variables: List of variable names available in the namespace
        current_cell_code: Existing code in the cell (for modification requests)

    Returns:
        System prompt string
    """
    lines = []
    lines.append("You are a Python code generation assistant embedded in a data science notebook.")
    lines.append("Generate ONLY executable Python code. No explanations, no markdown fences, no comments unless they clarify complex logic.")
    lines.append("The code will be inserted directly into a notebook cell and executed.")
    lines.append("")
    lines.append("RULES:")
    lines.append("- Output raw Python code only (no ```python fences)")
    lines.append("- Use variables and imports from prior cells (they persist)")
    lines.append("- For DataFrames, end with the expression (e.g. df.head()) so it renders as a table")
    lines.append("- For plots, use matplotlib (plt.plot/plt.show) - they render inline")
    lines.append("- For plots, ALWAYS use a dark style: plt.style.use('dark_background') at the top, or set facecolor='#1a1a2e' on the figure and use color='white' for titles, labels, and tick text")
    lines.append("- Keep code concise and idiomatic")
    lines.append("")

    if current_cell_code.strip():
        lines.append("IMPORTANT: This cell already contains code. The user wants to MODIFY the existing code based on their request.")
        lines.append("Return the complete updated code for this cell (not just the changes).")
        lines.append("")
        lines.append("CURRENT CELL CODE:")
        lines.append("```")
        lines.append(current_cell_code.strip())
        lines.append("```")
        lines.append("")

    if variables:
        lines.append(f"AVAILABLE VARIABLES: {', '.join(variables)}")
        lines.append("")

    if notebook_context:
        lines.append("NOTEBOOK CELLS ABOVE (executed in order):")
        lines.append("---")
        for cell in notebook_context:
            idx = cell.get("index", "?")
            code = cell.get("code", "").strip()
            output = cell.get("output", "").strip()
            html = cell.get("html", "").strip()
            if code:
                lines.append(f"Cell [{idx + 1}]:")
                lines.append(code)
                if output:
                    lines.append(f"# Output: {output[:300]}")
                if html:
                    table_text = extract_table_text(html)
                    if table_text:
                        lines.append(f"# DataFrame output (columns and sample rows):")
                        lines.append(f"# {table_text}")
                lines.append("")
        lines.append("---")
        lines.append("")

    lines.append(f"Generate code for Cell [{cell_index + 1}] based on the user's request.")
    return "\n".join(lines)


def extract_code(text):
    """
    Extract Python code from AI model response text.
    Handles markdown code fences and plain code.
    """
    text = text.strip()
    if "```python" in text:
        parts = text.split("```python")
        if len(parts) > 1:
            return parts[1].split("```")[0].strip()
    if text.startswith("```") and text.endswith("```"):
        lines = text.split("\n")
        return "\n".join(lines[1:-1]).strip()
    return text


def extract_table_text(html):
    """Extract column names and first few rows from an HTML table for AI context."""
    try:
        headers = re.findall(r'<th[^>]*>(.*?)</th>', html, re.DOTALL)
        if not headers:
            return ""
        headers = [re.sub(r'<[^>]+>', '', h).strip() for h in headers]

        rows = re.findall(r'<tr[^>]*>(.*?)</tr>', html, re.DOTALL)
        data_rows = []
        for row in rows[:4]:
            cells = re.findall(r'<td[^>]*>(.*?)</td>', row, re.DOTALL)
            if cells:
                cells = [re.sub(r'<[^>]+>', '', c).strip() for c in cells]
                data_rows.append(cells)

        result = f"Columns: {headers}"
        if data_rows:
            result += f"\nFirst rows: {data_rows[:3]}"

        return result[:500]
    except Exception:
        return ""
