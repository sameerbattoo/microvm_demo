"""
Data Source Providers — schema discovery, preview, and snippet generation.

Each data source type implements the DataSourceProvider interface and is
registered in registry.py. Prefer the registry helpers (get_provider,
all_providers, discover_all, provider_metadata, reader_docs, sql_syntax_docs)
over importing concrete provider classes directly.
"""

from .interface import DataSourceProvider, SourceSchema, ColumnInfo, SourceRef
from .athena import AthenaSchemaProvider
from .dynamodb import DynamoDBSchemaProvider
from .s3 import S3SchemaProvider
from .local import LocalFileSchemaProvider
from . import registry
from .registry import (
    get_provider,
    all_providers,
    provider_classes,
    provider_metadata,
    discover_all,
    discover_all_sync,
    reader_docs,
    sql_syntax_docs,
)

__all__ = [
    "DataSourceProvider",
    "SourceSchema",
    "ColumnInfo",
    "SourceRef",
    "AthenaSchemaProvider",
    "DynamoDBSchemaProvider",
    "S3SchemaProvider",
    "LocalFileSchemaProvider",
    "registry",
    "get_provider",
    "all_providers",
    "provider_classes",
    "provider_metadata",
    "discover_all",
    "discover_all_sync",
    "reader_docs",
    "sql_syntax_docs",
]
