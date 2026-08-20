"""
S3 schema provider — reads file headers/metadata without full download.
Supports CSV (read header + sample rows), Parquet (read metadata), JSON (sample).
"""

import os
import io
import time
import logging
from typing import Optional

import boto3

from .interface import DataSourceProvider, SourceSchema, ColumnInfo, SourceRef

logger = logging.getLogger(__name__)

CACHE_TTL_SEC = 300  # 5 minutes


def _human_size(size_bytes: int) -> str:
    """Format a byte count as a short human-readable string."""
    if size_bytes < 1024:
        return f"{size_bytes} B"
    if size_bytes < 1024 * 1024:
        return f"{size_bytes / 1024:.1f} KB"
    return f"{size_bytes / (1024 * 1024):.1f} MB"


class S3SchemaProvider(DataSourceProvider):
    """Schema provider for S3 files (CSV, Parquet, JSON)."""

    display_name = "S3 Bucket"
    icon = "s3"
    supports_sql = True

    def __init__(self):
        self._region = os.environ.get("AWS_REGION", "us-west-2")
        self._bucket = os.environ.get("ARTIFACT_BUCKET", "")
        # Discovery scope: comma-separated S3 prefixes to scan (one level deep).
        # Declarative via config.sh (DATASOURCE_S3_PREFIXES); defaults preserve
        # the previous hardcoded behavior.
        self._prefixes = [
            p.strip() for p in os.environ.get("DATASOURCE_S3_PREFIXES", "samples/,user-data/").split(",")
            if p.strip()
        ]
        self._cache: dict[str, tuple[float, SourceSchema]] = {}

    @property
    def source_type(self) -> str:
        return "s3"

    async def discover(self, session_id: str = None) -> list[SourceRef]:
        """Enumerate files directly under the configured prefixes (one level deep)."""
        refs: list[SourceRef] = []
        if not self._bucket:
            return refs
        try:
            s3 = boto3.client("s3", region_name=self._region)
            paginator = s3.get_paginator("list_objects_v2")
            for prefix in self._prefixes:
                for page in paginator.paginate(Bucket=self._bucket, Prefix=prefix, MaxKeys=50):
                    for obj in page.get("Contents", []):
                        key = obj["Key"]
                        if key.endswith("/"):
                            continue
                        # Only files directly under the prefix (skip Athena per-table subfolders)
                        relative = key[len(prefix):]
                        if "/" in relative:
                            continue
                        size_bytes = obj["Size"]
                        uri = f"s3://{self._bucket}/{key}"
                        ext = key.rsplit(".", 1)[-1].lower() if "." in key else ""
                        refs.append(SourceRef(
                            source_type="s3",
                            source_id=uri,
                            display_name=key,
                            detail=_human_size(size_bytes),
                            size=_human_size(size_bytes),
                            extra={
                                "key": key,
                                "bucket": self._bucket,
                                "size": _human_size(size_bytes),
                                "size_bytes": size_bytes,
                                "uri": uri,
                                "extension": ext,
                            },
                        ))
        except Exception as e:
            logger.warning(f"S3 discovery failed: {e}")
        return refs

    def reader_docs(self) -> list[str]:
        return [
            "read_s3_csv(bucket, key) -> df                  # Read CSV from S3",
            "read_s3_parquet(bucket, key) -> df              # Read Parquet from S3",
            "read_s3_json(bucket, key, lines=True) -> df     # Read JSON/JSONL from S3",
        ]

    def sql_syntax_docs(self) -> list[str]:
        return [
            "S3 CSV files (SQL cell only): SELECT * FROM read_csv('s3://bucket/key.csv') LIMIT 10",
            "S3 JSON files (SQL cell only): SELECT * FROM read_json('s3://bucket/key.json') LIMIT 10",
            "S3 Parquet files (SQL cell only): SELECT * FROM read_parquet('s3://bucket/key.parquet') LIMIT 10",
        ]

    async def get_schema(self, source_id: str, session_id: str = None) -> Optional[SourceSchema]:
        """
        Get schema for an S3 file.
        source_id: 's3://bucket/key' or just 'key' (uses default bucket)
        """
        if source_id in self._cache:
            ts, schema = self._cache[source_id]
            if time.time() - ts < CACHE_TTL_SEC:
                return schema

        bucket, key = self._parse_s3_path(source_id)
        if not bucket or not key:
            return None

        try:
            s3 = boto3.client("s3", region_name=self._region)

            # Get file size
            head = s3.head_object(Bucket=bucket, Key=key)
            size_bytes = head.get("ContentLength", 0)
            if size_bytes < 1024:
                size = f"{size_bytes} B"
            elif size_bytes < 1024 * 1024:
                size = f"{size_bytes / 1024:.1f} KB"
            else:
                size = f"{size_bytes / (1024 * 1024):.1f} MB"

            ext = key.rsplit('.', 1)[-1].lower() if '.' in key else ""
            display_name = key.rsplit('/', 1)[-1] if '/' in key else key

            if ext == "parquet":
                columns, row_count = self._schema_from_parquet(s3, bucket, key)
            elif ext == "csv":
                columns, row_count = self._schema_from_csv(s3, bucket, key)
            elif ext == "json":
                columns, row_count = self._schema_from_json(s3, bucket, key)
            else:
                columns, row_count = [], None

            schema = SourceSchema(
                source_type="s3",
                source_id=f"s3://{bucket}/{key}",
                display_name=display_name,
                columns=columns,
                row_count=row_count,
                size=size,
            )

            self._cache[source_id] = (time.time(), schema)
            return schema

        except Exception as e:
            logger.warning(f"S3 schema lookup failed for {source_id}: {e}")
            return None

    async def get_preview(self, source_id: str, limit: int = 5) -> list[dict]:
        """Read first N rows from the file."""
        bucket, key = self._parse_s3_path(source_id)
        if not bucket or not key:
            return []

        try:
            import pandas as pd
            s3 = boto3.client("s3", region_name=self._region)
            ext = key.rsplit('.', 1)[-1].lower() if '.' in key else ""

            if ext == "csv":
                # Use S3 Select for efficient partial read
                resp = s3.get_object(Bucket=bucket, Key=key, Range="bytes=0-65536")
                chunk = resp["Body"].read().decode("utf-8", errors="replace")
                df = pd.read_csv(io.StringIO(chunk), nrows=limit)
                return df.to_dict(orient="records")
            elif ext == "parquet":
                resp = s3.get_object(Bucket=bucket, Key=key)
                df = pd.read_parquet(io.BytesIO(resp["Body"].read())).head(limit)
                return df.to_dict(orient="records")
            elif ext == "json":
                resp = s3.get_object(Bucket=bucket, Key=key, Range="bytes=0-65536")
                chunk = resp["Body"].read().decode("utf-8", errors="replace")
                df = pd.read_json(io.StringIO(chunk), lines=True, nrows=limit)
                return df.to_dict(orient="records")
        except Exception as e:
            logger.warning(f"S3 preview failed for {source_id}: {e}")
        return []

    def get_python_snippet(self, source_id: str) -> str:
        bucket, key = self._parse_s3_path(source_id)
        ext = key.rsplit('.', 1)[-1].lower() if '.' in key else "csv"
        var_name = key.rsplit('/', 1)[-1].rsplit('.', 1)[0].replace('-', '_').replace(' ', '_')

        if ext == "csv":
            return f"# Read CSV from S3\n{var_name} = read_s3_csv('{bucket}', '{key}')\n{var_name}.head()"
        elif ext == "parquet":
            return f"# Read Parquet from S3\n{var_name} = read_s3_parquet('{bucket}', '{key}')\n{var_name}.head()"
        elif ext == "json":
            return f"# Read JSON from S3\n{var_name} = read_s3_json('{bucket}', '{key}')\n{var_name}.head()"
        else:
            return f"# Read s3://{bucket}/{key}\n{var_name} = read_s3_csv('{bucket}', '{key}')\n{var_name}.head()"

    def get_sql_snippet(self, source_id: str) -> str:
        bucket, key = self._parse_s3_path(source_id)
        ext = key.rsplit('.', 1)[-1].lower() if '.' in key else "csv"
        if ext == "csv":
            return f"SELECT * FROM read_csv('s3://{bucket}/{key}') LIMIT 100"
        elif ext == "parquet":
            return f"SELECT * FROM read_parquet('s3://{bucket}/{key}') LIMIT 100"
        elif ext == "json":
            return f"SELECT * FROM read_json('s3://{bucket}/{key}') LIMIT 100"
        return f"-- Unsupported file type: {ext}"

    def _parse_s3_path(self, source_id: str) -> tuple[str, str]:
        """Parse 's3://bucket/key' or 'key' into (bucket, key)."""
        if source_id.startswith("s3://"):
            parts = source_id[5:].split("/", 1)
            return parts[0], parts[1] if len(parts) > 1 else ""
        # Assume default bucket
        return self._bucket, source_id

    def _schema_from_csv(self, s3, bucket: str, key: str) -> tuple[list[ColumnInfo], Optional[int]]:
        """Read CSV header + sample rows to infer schema."""
        import pandas as pd
        try:
            resp = s3.get_object(Bucket=bucket, Key=key, Range="bytes=0-32768")
            chunk = resp["Body"].read().decode("utf-8", errors="replace")
            df = pd.read_csv(io.StringIO(chunk), nrows=5)

            columns = []
            for col in df.columns:
                dtype = self._pandas_dtype_to_simple(df[col].dtype)
                sample = str(df[col].iloc[0]) if len(df) > 0 else ""
                columns.append(ColumnInfo(name=str(col), dtype=dtype, sample=sample[:50]))

            return columns, None  # Row count unknown without full scan
        except Exception:
            return [], None

    def _schema_from_parquet(self, s3, bucket: str, key: str) -> tuple[list[ColumnInfo], Optional[int]]:
        """Read Parquet metadata for schema (no full download needed)."""
        import pyarrow.parquet as pq
        try:
            resp = s3.get_object(Bucket=bucket, Key=key)
            pf = pq.ParquetFile(io.BytesIO(resp["Body"].read()))
            schema = pf.schema_arrow
            row_count = pf.metadata.num_rows

            columns = []
            # Get sample values from first row group
            first_batch = pf.read_row_group(0).to_pandas().head(1)
            for i, field in enumerate(schema):
                dtype = self._arrow_dtype_to_simple(str(field.type))
                sample = ""
                if len(first_batch) > 0 and field.name in first_batch.columns:
                    sample = str(first_batch[field.name].iloc[0])[:50]
                columns.append(ColumnInfo(name=field.name, dtype=dtype, sample=sample))

            return columns, row_count
        except Exception:
            return [], None

    def _schema_from_json(self, s3, bucket: str, key: str) -> tuple[list[ColumnInfo], Optional[int]]:
        """Read first few lines of JSONL to infer schema."""
        import pandas as pd
        try:
            resp = s3.get_object(Bucket=bucket, Key=key, Range="bytes=0-32768")
            chunk = resp["Body"].read().decode("utf-8", errors="replace")
            df = pd.read_json(io.StringIO(chunk), lines=True, nrows=5)

            columns = []
            for col in df.columns:
                dtype = self._pandas_dtype_to_simple(df[col].dtype)
                sample = str(df[col].iloc[0]) if len(df) > 0 else ""
                columns.append(ColumnInfo(name=str(col), dtype=dtype, sample=sample[:50]))

            return columns, None
        except Exception:
            return [], None

    @staticmethod
    def _pandas_dtype_to_simple(dtype) -> str:
        """Map pandas dtype to simple display type."""
        from app.notebook.dtypes import normalize_dtype
        return normalize_dtype(str(dtype))

    @staticmethod
    def _arrow_dtype_to_simple(dtype: str) -> str:
        """Map Arrow dtype string to simple display type."""
        from app.notebook.dtypes import normalize_dtype
        return normalize_dtype(dtype)
