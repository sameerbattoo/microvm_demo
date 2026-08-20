"""
Athena schema provider — uses AWS Glue catalog for fast schema discovery.
"""

import os
import time
import logging
from typing import Optional

import boto3

from .interface import DataSourceProvider, SourceSchema, ColumnInfo, SourceRef

logger = logging.getLogger(__name__)

# Cache TTL for Glue catalog lookups
CACHE_TTL_SEC = 300  # 5 minutes


class AthenaSchemaProvider(DataSourceProvider):
    """Schema provider for Athena tables via Glue catalog."""

    display_name = "Athena"
    icon = "athena"
    supports_sql = True

    def __init__(self):
        self._region = os.environ.get("AWS_REGION", "us-west-2")
        # ATHENA_DB is the DEFAULT database for query execution (db.table prefix,
        # read_athena default, SQL engine catalog) — a single value.
        self._database = os.environ.get("ATHENA_DB", "microvm_demo_db")
        # Discovery scope is separate: an optional comma-separated allowlist of
        # Glue databases to surface. When empty, discovery auto-lists EVERY Glue
        # database the role can access (a role may have many).
        self._database_allowlist = [
            d.strip() for d in os.environ.get("DATASOURCE_ATHENA_DATABASES", "").split(",")
            if d.strip()
        ]
        self._workgroup = os.environ.get("ATHENA_WORKGROUP", "microvm-demo")
        self._cache: dict[str, tuple[float, SourceSchema]] = {}

    def _databases_to_scan(self, glue) -> list[str]:
        """Resolve which Glue databases discovery should enumerate.
        Explicit allowlist wins; otherwise auto-list all accessible databases,
        falling back to the default ATHENA_DB if listing isn't permitted."""
        if self._database_allowlist:
            return self._database_allowlist
        try:
            databases = []
            paginator = glue.get_paginator("get_databases")
            for page in paginator.paginate():
                databases.extend(db["Name"] for db in page.get("DatabaseList", []))
            return databases or [self._database]
        except Exception as e:
            logger.warning(f"Athena get_databases failed; falling back to ATHENA_DB: {e}")
            return [self._database]

    @property
    def source_type(self) -> str:
        return "athena"

    async def discover(self, session_id: str = None) -> list[SourceRef]:
        """Enumerate tables across every in-scope Glue database (see _databases_to_scan)."""
        refs: list[SourceRef] = []
        try:
            glue = boto3.client("glue", region_name=self._region)
            for database in self._databases_to_scan(glue):
                try:
                    paginator = glue.get_paginator("get_tables")
                    tables = []
                    for page in paginator.paginate(DatabaseName=database):
                        tables.extend(page.get("TableList", []))
                except Exception as e:
                    logger.warning(f"Athena discovery failed for database {database}: {e}")
                    continue
                for table in tables:
                    columns = table.get("StorageDescriptor", {}).get("Columns", [])
                    name = table["Name"]
                    update_time = table.get("UpdateTime")
                    refs.append(SourceRef(
                        source_type="athena",
                        source_id=f"{database}.{name}",
                        display_name=name,
                        detail=f"{len(columns)} cols",
                        extra={
                            "name": name,
                            "table_name": name,
                            "database": database,
                            "columns": [{"name": c["Name"], "type": c["Type"]} for c in columns],
                            "column_count": len(columns),
                            "region": self._region,
                            # Change-signal metadata consumed by entity discovery:
                            "s3_location": table.get("StorageDescriptor", {}).get("Location", ""),
                            "glue_update_time": update_time.isoformat() if update_time else None,
                        },
                    ))
        except Exception as e:
            logger.warning(f"Athena discovery failed: {e}")
        return refs

    def reader_docs(self) -> list[str]:
        return [
            f'read_athena(sql, database="{self._database}") -> df  # Run Athena SQL, return DataFrame',
        ]

    def sql_syntax_docs(self) -> list[str]:
        return [
            f"Athena tables: SELECT * FROM {self._database}.table_name LIMIT 10 (uses database.table format)",
        ]

    async def get_schema(self, source_id: str, session_id: str = None) -> Optional[SourceSchema]:
        """
        Get schema for an Athena table.
        source_id: 'table_name' or 'database.table_name'
        """
        # Check cache
        if source_id in self._cache:
            ts, schema = self._cache[source_id]
            if time.time() - ts < CACHE_TTL_SEC:
                return schema

        # Parse database.table
        if '.' in source_id:
            database, table_name = source_id.split('.', 1)
        else:
            database = self._database
            table_name = source_id

        try:
            glue = boto3.client("glue", region_name=self._region)
            resp = glue.get_table(DatabaseName=database, Name=table_name)
            table = resp["Table"]

            columns = []
            for col in table.get("StorageDescriptor", {}).get("Columns", []):
                columns.append(ColumnInfo(
                    name=col["Name"],
                    dtype=self._map_athena_type(col.get("Type", "string")),
                    nullable=True,
                ))
            # Partition keys are also columns
            for col in table.get("PartitionKeys", []):
                columns.append(ColumnInfo(
                    name=col["Name"],
                    dtype=self._map_athena_type(col.get("Type", "string")),
                    nullable=True,
                ))

            # Try to get row count from table parameters
            params = table.get("Parameters", {})
            row_count = None
            if "recordCount" in params:
                try:
                    row_count = int(params["recordCount"])
                except (ValueError, TypeError):
                    pass

            size = params.get("sizeKey", params.get("totalSize", ""))
            if size:
                try:
                    size_bytes = int(size)
                    if size_bytes < 1024:
                        size = f"{size_bytes} B"
                    elif size_bytes < 1024 * 1024:
                        size = f"{size_bytes / 1024:.1f} KB"
                    else:
                        size = f"{size_bytes / (1024 * 1024):.1f} MB"
                except (ValueError, TypeError):
                    size = ""

            schema = SourceSchema(
                source_type="athena",
                source_id=f"{database}.{table_name}",
                display_name=table_name,
                columns=columns,
                row_count=row_count,
                size=size,
            )

            # Populate sample values from a quick query
            try:
                preview = await self.get_preview(source_id, limit=1)
                if preview:
                    row = preview[0]
                    for col in schema.columns:
                        if col.name in row and row[col.name] is not None:
                            col.sample = str(row[col.name])[:50]
            except Exception:
                pass

            self._cache[source_id] = (time.time(), schema)
            return schema

        except Exception as e:
            logger.warning(f"Athena schema lookup failed for {source_id}: {e}")
            return None

    async def get_preview(self, source_id: str, limit: int = 5) -> list[dict]:
        """Run a LIMIT query via Athena and return rows."""
        if '.' in source_id:
            database, table_name = source_id.split('.', 1)
        else:
            database = self._database
            table_name = source_id

        try:
            import asyncio
            athena = boto3.client("athena", region_name=self._region)

            sql = f'SELECT * FROM "{database}"."{table_name}" LIMIT {limit}'
            exec_resp = athena.start_query_execution(
                QueryString=sql,
                WorkGroup=self._workgroup,
            )
            execution_id = exec_resp["QueryExecutionId"]

            # Poll for completion (max 15s)
            for _ in range(30):
                status = athena.get_query_execution(QueryExecutionId=execution_id)
                state = status["QueryExecution"]["Status"]["State"]
                if state in ("SUCCEEDED", "FAILED", "CANCELLED"):
                    break
                await asyncio.sleep(0.5)

            if state != "SUCCEEDED":
                return []

            results = athena.get_query_results(QueryExecutionId=execution_id)
            rows_data = results.get("ResultSet", {}).get("Rows", [])
            if len(rows_data) < 2:
                return []

            # First row is headers
            headers = [col.get("VarCharValue", "") for col in rows_data[0].get("Data", [])]
            rows = []
            for row in rows_data[1:]:
                row_dict = {}
                for i, cell in enumerate(row.get("Data", [])):
                    if i < len(headers):
                        row_dict[headers[i]] = cell.get("VarCharValue", "")
                rows.append(row_dict)
            return rows

        except Exception as e:
            logger.warning(f"Athena preview failed for {source_id}: {e}")
            return []

    def get_python_snippet(self, source_id: str) -> str:
        if '.' in source_id:
            database, table_name = source_id.split('.', 1)
        else:
            database = self._database
            table_name = source_id
        return (
            f"# Query Athena table\n"
            f"{table_name} = read_athena(\"SELECT * FROM {database}.{table_name} LIMIT 100\")\n"
            f"{table_name}.head()"
        )

    def get_sql_snippet(self, source_id: str) -> str:
        if '.' in source_id:
            return f"SELECT * FROM {source_id} LIMIT 100"
        return f"SELECT * FROM {self._database}.{source_id} LIMIT 100"

    @staticmethod
    def _map_athena_type(athena_type: str) -> str:
        """Map Athena/Hive types to simple display types."""
        t = athena_type.lower()
        if t in ("string", "varchar", "char"):
            return "string"
        if t in ("int", "integer", "bigint", "smallint", "tinyint"):
            return "int"
        if t in ("double", "float", "decimal"):
            return "float"
        if t in ("date",):
            return "date"
        if t in ("timestamp",):
            return "datetime"
        if t in ("boolean",):
            return "boolean"
        if t.startswith("array") or t.startswith("map") or t.startswith("struct"):
            return "json"
        return t
