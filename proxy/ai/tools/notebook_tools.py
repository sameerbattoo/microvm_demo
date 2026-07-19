"""
Tools for modifying the notebook structure.

NOTE: These tools are currently NOT used by the agent (removed to prevent
auto-modification without user consent). They are kept for future "Option B"
implementation where the agent proposes changes as pending actions.

These tools return JSON action objects that the frontend would interpret
and apply to the notebook DOM with user confirmation.
"""

import json
from strands import tool


@tool
def insert_cell(code: str, cell_type: str = "code", position: str = "after_active") -> str:
    """
    Insert a new cell into the notebook.

    Args:
        code: The Python code or markdown content for the cell.
        cell_type: Either "code" or "markdown". Use "markdown" for explanatory text.
        position: Where to insert. Options: "after_active" (after currently selected cell),
                  "end" (at the bottom), or a number like "3" for a specific index.

    Returns:
        Confirmation of the pending cell insertion.
    """
    action = {
        "action": "insert_cell",
        "code": code,
        "type": cell_type,
        "position": position,
    }
    return json.dumps(action)


@tool
def edit_cell(cell_index: int, new_code: str) -> str:
    """
    Replace the code in an existing notebook cell with new code.
    Use this to fix errors or improve existing cells.

    Args:
        cell_index: The 0-based index of the cell to edit.
        new_code: The complete new code to replace the cell's content with.

    Returns:
        Confirmation of the pending cell edit.
    """
    action = {
        "action": "edit_cell",
        "index": cell_index,
        "code": new_code,
    }
    return json.dumps(action)


@tool
def delete_cell(cell_index: int) -> str:
    """
    Delete a cell from the notebook.
    Use sparingly — only when explicitly asked to remove a cell.

    Args:
        cell_index: The 0-based index of the cell to delete.

    Returns:
        Confirmation of the pending cell deletion.
    """
    action = {
        "action": "delete_cell",
        "index": cell_index,
    }
    return json.dumps(action)
