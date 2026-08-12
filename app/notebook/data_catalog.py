"""
Data Catalog — Background schema discovery for all data sources.

Part of: app.platform (infrastructure layer)

Discovers schemas for:
  - S3 files (CSV, Parquet, JSON) — reads headers/metadata
  - DynamoDB tables — scans a few items to infer columns
  - Athena tables — queries Glue catalog for column definitions
  - Local /tmp files — reads file headers from disk

The catalog is populated asynchronously at VM startup from the data source
list passed in runHookPayload. Results are cached in memory and exposed
via GET /data-catalog.
"""

import os
import io
import glob
import time
import logging
import threading
from typing import Any
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)


@dataclass
class ColumnInfo:
    name: str
    dtype: str = "string"
    sample: str = ""
    nullable: bool = True


@dataclass
class CatalogEntry:
    source_type: str         # "s3", "dynamodb", "athena", "local"
    source_id: str           # unique identifier (uri, table name, file path)
    display_name: str        # human-readable name
    columns: list[ColumnInfo] = field(default_factory=list)
    row_count: int | None = None
    size: str = ""
    status: str = "pending"  # "pending", "discovered", "error"
    error: str = ""
    discovered_at: float = 0.0
    metadata: dict = field(default_factory=dict)  # extra info (bucket, database, etc.)


class DataCatalog:
    """
    In-memory data catalog that discovers schemas in the background.
    
    Usage:
        catalog = DataCatalog()
        catalog.start_discovery(data_sources)  # non-blocking
        catalog.get_all()  # returns whatever has been discovered so far
        catalog.get_schema("s3://bucket/file.csv")  # returns single entry or None
    """

    def __init__(self):
        self._entries: dict[str, CatalogEntry] = {}  # source_id → entry
        self._lock = threading.Lock()
        self._discovery_thread: threading.Thread | None = None
        self._discovery_complete = False

    @property
    def is_discovering(self) -> bool:
        return self._discovery_thread is not None and self._discovery_thread.is_alive()

    @property
    def discovery_complete(self) -> bool:
        return self._discovery_complete

    def start_discovery(self, data_sources: dict):
        """
        Start background schema discovery for the given data sources.
        Non-blocking — returns immediately.
        
        data_sources: {
            "s3": [{"key": "...", "bucket": "...", "uri": "s3://...", "size_bytes": N}],
            "dynamodb": [{"name": "...", "region": "..."}],
            "athena": [{"name": "...", "database": "...", "region": "..."}],
            "artifact_bucket": "bucket-name"
        }
        """
        if self.is_discovering:
            logger.warning("Schema discovery already in progress — skipping")
            return

        # Register all sources as pending first (so UI can show them immediately)
        with self._lock:
            for s3_file in data_sources.get("s3", []):
                uri = s3_file.get("uri", f"s3://{s3_file['bucket']}/{s3_file['key']}")
                size_bytes = s3_file.get("size_bytes", 0)
                size_str = f"{size_bytes / 1024:.1f} KB" if size_bytes < 1024 * 1024 else f"{size_bytes / (1024*1024):.1f} MB"
                self._entries[uri] = CatalogEntry(
                    source_type="s3", source_id=uri,
                    display_name=os.path.basename(s3_file["key"]),
                    size=size_str,
                    metadata={"bucket": s3_file["bucket"], "key": s3_file["key"]},
                )
            for table in data_sources.get("dynamodb", []):
                source_id = f"dynamodb.{table['name']}"
                self._entries[source_id] = CatalogEntry(
                    source_type="dynamodb", source_id=source_id,
                    display_name=table["name"],
                    metadata={"region": table.get("region", "us-west-2")},
                )
            for table in data_sources.get("athena", []):
                db = table.get("database", "microvm_demo_db")
                source_id = f"{db}.{table['name']}"
                self._entries[source_id] = CatalogEntry(
                    source_type="athena", source_id=source_id,
                    display_name=table["name"],
                    metadata={"database": db, "region": table.get("region", "us-west-2")},
                )

        # Start background thread
        self._discovery_complete = False
        self._discovery_thread = threading.Thread(
            target=self._discover_all,
            args=(data_sources,),
            daemon=True,
            name="data-catalog-discovery",
        )
        self._discovery_thread.start()
        logger.info(f"📊 Data catalog: started background discovery ({len(self._entries)} sources)")

    def _discover_all(self, data_sources: dict):
        """Background thread: discover schemas for all registered sources."""
        start = time.time()
        discovered = 0
        errors = 0

        # 1. Local /tmp files (instant — no network)
        try:
            self._discover_local_files()
        except Exception as e:
            logger.warning(f"   Local file discovery failed: {e}")

        # 2. S3 files
        for s3_file in data_sources.get("s3", []):
            try:
                self._discover_s3_file(s3_file)
                discovered += 1
            except Exception as e:
                uri = s3_file.get("uri", "")
                with self._lock:
                    if uri in self._entries:
                        self._entries[uri].status = "error"
                        self._entries[uri].error = str(e)
                errors += 1
                logger.warning(f"   S3 schema error: {uri} — {e}")

        # 3. DynamoDB tables
        for table in data_sources.get("dynamodb", []):
            try:
                self._discover_dynamodb_table(table)
                discovered += 1
            except Exception as e:
                source_id = f"dynamodb.{table['name']}"
                with self._lock:
                    if source_id in self._entries:
                        self._entries[source_id].status = "error"
                        self._entries[source_id].error = str(e)
                errors += 1
                logger.warning(f"   DynamoDB schema error: {table['name']} — {e}")

        # 4. Athena tables
        for table in data_sources.get("athena", []):
            try:
                self._discover_athena_table(table)
                discovered += 1
            except Exception as e:
                db = table.get("database", "")
                source_id = f"{db}.{table['name']}"
                with self._lock:
                    if source_id in self._entries:
                        self._entries[source_id].status = "error"
                        self._entries[source_id].error = str(e)
                errors += 1
                logger.warning(f"   Athena schema error: {table['name']} — {e}")

        elapsed = time.time() - start
        self._discovery_complete = True
        logger.info(f"📊 Data catalog: discovery complete ({discovered} OK, {errors} errors, {elapsed:.1f}s)")

    # ─── Local Files ─────────────────────────────────────────────────────────

    def _discover_local_files(self):
        """Discover schemas for local data files in /tmp."""
        import pandas as pd

        extensions = ['*.csv', '*.parquet', '*.json', '*.xlsx', '*.xls']
        for ext in extensions:
            for filepath in glob.glob(f'/tmp/**/{ext}', recursive=True):
                try:
                    source_id = filepath
                    filename = os.path.basename(filepath)
                    size_bytes = os.path.getsize(filepath)
                    size_str = f"{size_bytes / 1024:.1f} KB" if size_bytes < 1024 * 1024 else f"{size_bytes / (1024*1024):.1f} MB"

                    columns = []
                    row_count = None

                    if filepath.endswith('.csv'):
                        df = pd.read_csv(filepath, nrows=5)
                        columns = [ColumnInfo(name=c, dtype=str(df[c].dtype), sample=str(df[c].iloc[0])[:50] if len(df) > 0 else "") for c in df.columns]
                        # Get full row count efficiently
                        with open(filepath) as f:
                            row_count = sum(1 for _ in f) - 1  # minus header
                    elif filepath.endswith('.parquet'):
                        df = pd.read_parquet(filepath, engine='pyarrow')
                        row_count = len(df)
                        columns = [ColumnInfo(name=c, dtype=str(df[c].dtype), sample=str(df[c].iloc[0])[:50] if len(df) > 0 else "") for c in df.columns]
                    elif filepath.endswith('.json'):
                        df = pd.read_json(filepath, lines=True, nrows=5)
                        columns = [ColumnInfo(name=c, dtype=str(df[c].dtype), sample=str(df[c].iloc[0])[:50] if len(df) > 0 else "") for c in df.columns]
                    elif filepath.endswith(('.xlsx', '.xls')):
                        df = pd.read_excel(filepath, nrows=5)
                        columns = [ColumnInfo(name=c, dtype=str(df[c].dtype), sample=str(df[c].iloc[0])[:50] if len(df) > 0 else "") for c in df.columns]

                    with self._lock:
                        self._entries[source_id] = CatalogEntry(
                            source_type="local", source_id=source_id,
                            display_name=filename, columns=columns,
                            row_count=row_count, size=size_str,
                            status="discovered", discovered_at=time.time(),
                        )
                except Exception as e:
                    logger.debug(f"   Skipping local file {filepath}: {e}")

    # ─── S3 Files ────────────────────────────────────────────────────────────

    def _discover_s3_file(self, s3_file: dict):
        """Discover schema for an S3 file (CSV, Parquet, JSON)."""
        import boto3
        import pandas as pd

        bucket = s3_file["bucket"]
        key = s3_file["key"]
        uri = s3_file.get("uri", f"s3://{bucket}/{key}")
        region = os.environ.get("AWS_REGION", "us-west-2")

        s3 = boto3.client("s3", region_name=region)
        ext = os.path.splitext(key)[1].lower()

        columns = []
        row_count = None

        if ext == ".csv":
            # Read first 32KB to infer schema
            resp = s3.get_object(Bucket=bucket, Key=key, Range="bytes=0-32768")
            chunk = resp["Body"].read().decode("utf-8", errors="replace")
            df = pd.read_csv(io.StringIO(chunk), nrows=5)
            columns = [ColumnInfo(name=c, dtype=str(df[c].dtype), sample=str(df[c].iloc[0])[:50] if len(df) > 0 else "") for c in df.columns]
        elif ext == ".parquet":
            # Read full parquet metadata (small — just schema + row count)
            import pyarrow.parquet as pq
            import tempfile
            # Download to temp file for pyarrow
            with tempfile.NamedTemporaryFile(suffix=".parquet", delete=False) as tmp:
                s3.download_file(bucket, key, tmp.name)
                pf = pq.ParquetFile(tmp.name)
                schema = pf.schema_arrow
                row_count = pf.metadata.num_rows
                columns = [ColumnInfo(name=f.name, dtype=str(f.type)) for f in schema]
                os.unlink(tmp.name)
        elif ext == ".json":
            resp = s3.get_object(Bucket=bucket, Key=key, Range="bytes=0-32768")
            chunk = resp["Body"].read().decode("utf-8", errors="replace")
            try:
                df = pd.read_json(io.StringIO(chunk), lines=True, nrows=5)
                columns = [ColumnInfo(name=c, dtype=str(df[c].dtype), sample=str(df[c].iloc[0])[:50] if len(df) > 0 else "") for c in df.columns]
            except Exception:
                # Try as single JSON object
                import json
                data = json.loads(chunk.split('\n')[0])
                if isinstance(data, dict):
                    columns = [ColumnInfo(name=k, dtype=type(v).__name__) for k, v in data.items()]

        with self._lock:
            entry = self._entries.get(uri)
            if entry:
                entry.columns = columns
                entry.row_count = row_count
                entry.status = "discovered"
                entry.discovered_at = time.time()

    # ─── DynamoDB ────────────────────────────────────────────────────────────

    def _discover_dynamodb_table(self, table_info: dict):
        """Discover schema for a DynamoDB table by scanning a few items."""
        import boto3
        from decimal import Decimal

        table_name = table_info["name"]
        region = table_info.get("region", os.environ.get("AWS_REGION", "us-west-2"))
        source_id = f"dynamodb.{table_name}"

        dynamodb = boto3.resource("dynamodb", region_name=region)
        table = dynamodb.Table(table_name)

        # Get item count from description
        row_count = table.item_count or 0

        # Scan a few items to infer columns
        resp = table.scan(Limit=10)
        items = resp.get("Items", [])

        # Union all keys across sampled items
        all_keys: dict[str, str] = {}  # column_name → inferred type
        samples: dict[str, str] = {}
        for item in items:
            for k, v in item.items():
                if k not in all_keys:
                    if isinstance(v, Decimal):
                        all_keys[k] = "number"
                    elif isinstance(v, bool):
                        all_keys[k] = "boolean"
                    elif isinstance(v, (int, float)):
                        all_keys[k] = "number"
                    elif isinstance(v, list):
                        all_keys[k] = "list"
                    elif isinstance(v, dict):
                        all_keys[k] = "map"
                    else:
                        all_keys[k] = "string"
                    samples[k] = str(v)[:50]

        columns = [ColumnInfo(name=k, dtype=t, sample=samples.get(k, "")) for k, t in all_keys.items()]

        with self._lock:
            entry = self._entries.get(source_id)
            if entry:
                entry.columns = columns
                entry.row_count = row_count
                entry.status = "discovered"
                entry.discovered_at = time.time()

    # ─── Athena (Glue Catalog) ───────────────────────────────────────────────

    def _discover_athena_table(self, table_info: dict):
        """Discover schema for an Athena table from the Glue catalog."""
        import boto3

        table_name = table_info["name"]
        database = table_info.get("database", "microvm_demo_db")
        region = table_info.get("region", os.environ.get("AWS_REGION", "us-west-2"))
        source_id = f"{database}.{table_name}"

        glue = boto3.client("glue", region_name=region)
        resp = glue.get_table(DatabaseName=database, Name=table_name)
        table_def = resp["Table"]

        # Columns from StorageDescriptor
        sd_columns = table_def.get("StorageDescriptor", {}).get("Columns", [])
        # Partition keys are also columns
        partition_keys = table_def.get("PartitionKeys", [])

        columns = []
        for col in sd_columns + partition_keys:
            columns.append(ColumnInfo(
                name=col["Name"],
                dtype=col.get("Type", "string"),
                nullable=True,
            ))

        # Try to get row count from table parameters
        row_count = None
        params = table_def.get("Parameters", {})
        if "numRows" in params:
            try:
                row_count = int(params["numRows"])
            except (ValueError, TypeError):
                pass

        with self._lock:
            entry = self._entries.get(source_id)
            if entry:
                entry.columns = columns
                entry.row_count = row_count
                entry.status = "discovered"
                entry.discovered_at = time.time()

    # ─── Public API ──────────────────────────────────────────────────────────

    def get_all(self) -> dict:
        """Return the full catalog as a serializable dict."""
        with self._lock:
            entries = []
            for entry in self._entries.values():
                entries.append({
                    "source_type": entry.source_type,
                    "source_id": entry.source_id,
                    "display_name": entry.display_name,
                    "columns": [{"name": c.name, "dtype": c.dtype, "sample": c.sample, "nullable": c.nullable} for c in entry.columns],
                    "row_count": entry.row_count,
                    "size": entry.size,
                    "status": entry.status,
                    "error": entry.error,
                    "metadata": entry.metadata,
                })
            return {
                "entries": entries,
                "total": len(entries),
                "discovered": sum(1 for e in self._entries.values() if e.status == "discovered"),
                "pending": sum(1 for e in self._entries.values() if e.status == "pending"),
                "errors": sum(1 for e in self._entries.values() if e.status == "error"),
                "discovery_complete": self._discovery_complete,
                "is_discovering": self.is_discovering,
            }

    def get_schema(self, source_id: str) -> dict | None:
        """Return schema for a specific source, or None if not found."""
        with self._lock:
            entry = self._entries.get(source_id)
            if not entry:
                return None
            return {
                "source_type": entry.source_type,
                "source_id": entry.source_id,
                "display_name": entry.display_name,
                "columns": [{"name": c.name, "dtype": c.dtype, "sample": c.sample, "nullable": c.nullable} for c in entry.columns],
                "row_count": entry.row_count,
                "size": entry.size,
                "status": entry.status,
                "error": entry.error,
                "metadata": entry.metadata,
            }

    def refresh_local_files(self):
        """Re-scan local /tmp files (called after file upload)."""
        threading.Thread(target=self._discover_local_files, daemon=True).start()
