"""
Local file schema provider — reads file headers from the MicroVM's /tmp/ directory.
Requires forwarding requests to the running MicroVM via the proxy.
"""

import logging
from typing import Optional

from .interface import DataSourceProvider, SourceSchema, ColumnInfo

logger = logging.getLogger(__name__)


class LocalFileSchemaProvider(DataSourceProvider):
    """
    Schema provider for local files on the MicroVM (/tmp/).
    
    Unlike other providers, this one needs to execute code on the VM
    to read the file header. It delegates to the MicroVM via execute_code.
    """

    def __init__(self, execute_fn=None):
        """
        Args:
            execute_fn: Async callable(session_id, code) → result dict.
                        Used to run Python on the MicroVM to read file schema.
        """
        self._execute_fn = execute_fn

    @property
    def source_type(self) -> str:
        return "local"

    async def get_schema(self, source_id: str, session_id: str = None) -> Optional[SourceSchema]:
        """
        Get schema for a local file on the MicroVM.
        source_id: file path (e.g., '/tmp/sales_data.csv')
        session_id: required to forward the request to the correct VM.
        """
        if not self._execute_fn or not session_id:
            return None

        ext = source_id.rsplit('.', 1)[-1].lower() if '.' in source_id else ""
        display_name = source_id.rsplit('/', 1)[-1] if '/' in source_id else source_id

        code = f"""
import os, json
import pandas as pd

path = '{source_id}'
if not os.path.exists(path):
    print(json.dumps({{"error": "File not found"}}))
else:
    size = os.path.getsize(path)
    ext = path.rsplit('.', 1)[-1].lower()
    if ext == 'csv':
        df = pd.read_csv(path, nrows=5)
    elif ext == 'parquet':
        df = pd.read_parquet(path).head(5)
    elif ext in ('json',):
        df = pd.read_json(path, lines=True, nrows=5)
    elif ext in ('xlsx', 'xls'):
        df = pd.read_excel(path, nrows=5)
    else:
        df = pd.DataFrame()
    
    cols = []
    for col in df.columns:
        dtype = str(df[col].dtype)
        if 'int' in dtype: dtype = 'int'
        elif 'float' in dtype: dtype = 'float'
        elif 'datetime' in dtype: dtype = 'datetime'
        elif 'bool' in dtype: dtype = 'boolean'
        else: dtype = 'string'
        sample = str(df[col].iloc[0])[:50] if len(df) > 0 else ''
        cols.append({{"name": str(col), "dtype": dtype, "sample": sample}})
    
    print(json.dumps({{
        "columns": cols,
        "row_count": len(pd.read_csv(path)) if ext == 'csv' else None,
        "size_bytes": size,
    }}))
"""
        try:
            result = await self._execute_fn(session_id, code)
            if not result or not result.get("success"):
                return None

            import json
            data = json.loads(result.get("output", "").strip())
            if "error" in data:
                return None

            size_bytes = data.get("size_bytes", 0)
            if size_bytes < 1024:
                size = f"{size_bytes} B"
            elif size_bytes < 1024 * 1024:
                size = f"{size_bytes / 1024:.1f} KB"
            else:
                size = f"{size_bytes / (1024 * 1024):.1f} MB"

            columns = [
                ColumnInfo(name=c["name"], dtype=c["dtype"], sample=c.get("sample", ""))
                for c in data.get("columns", [])
            ]

            return SourceSchema(
                source_type="local",
                source_id=source_id,
                display_name=display_name,
                columns=columns,
                row_count=data.get("row_count"),
                size=size,
            )

        except Exception as e:
            logger.warning(f"Local file schema failed for {source_id}: {e}")
            return None

    async def get_preview(self, source_id: str, limit: int = 5) -> list[dict]:
        """Not implemented for local files (would need session context)."""
        return []

    def get_python_snippet(self, source_id: str) -> str:
        ext = source_id.rsplit('.', 1)[-1].lower() if '.' in source_id else "csv"
        var_name = source_id.rsplit('/', 1)[-1].rsplit('.', 1)[0].replace('-', '_').replace(' ', '_')

        if ext == "csv":
            return f"import pandas as pd\n\n{var_name} = pd.read_csv('{source_id}')\n{var_name}.head()"
        elif ext == "parquet":
            return f"import pandas as pd\n\n{var_name} = pd.read_parquet('{source_id}')\n{var_name}.head()"
        elif ext in ("xlsx", "xls"):
            return f"import pandas as pd\n\n{var_name} = pd.read_excel('{source_id}')\n{var_name}.head()"
        elif ext == "json":
            return f"import pandas as pd\n\n{var_name} = pd.read_json('{source_id}', lines=True)\n{var_name}.head()"
        return f"# Read {source_id}"

    def get_sql_snippet(self, source_id: str) -> str:
        return f"SELECT * FROM '{source_id}' LIMIT 100"
