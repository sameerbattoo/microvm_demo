"""
Data Source Providers — schema discovery, preview, and snippet generation.

Each data source type implements the DataSourceProvider interface.
"""

from .interface import DataSourceProvider, SourceSchema, ColumnInfo
from .athena import AthenaSchemaProvider
from .dynamodb import DynamoDBSchemaProvider
from .s3 import S3SchemaProvider
from .local import LocalFileSchemaProvider

__all__ = [
    "DataSourceProvider",
    "SourceSchema",
    "ColumnInfo",
    "AthenaSchemaProvider",
    "DynamoDBSchemaProvider",
    "S3SchemaProvider",
    "LocalFileSchemaProvider",
]
