"""
DataSourceProvider — abstract interface for all data source interactions.

Each data source type (Athena, DynamoDB, S3, Local) implements this interface.
Provides: schema discovery, preview rows, and code snippet generation.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field


@dataclass
class ColumnInfo:
    """Schema information for a single column."""
    name: str
    dtype: str  # 'string', 'int', 'float', 'date', 'boolean', 'json', etc.
    sample: str = ""  # A sample value for display
    nullable: bool = True


@dataclass
class SourceSchema:
    """Schema for a data source."""
    source_type: str  # 'athena', 'dynamodb', 's3', 'local'
    source_id: str  # Table name, file path, S3 key, etc.
    display_name: str  # Human-readable name
    columns: list[ColumnInfo] = field(default_factory=list)
    row_count: int | None = None  # None if unknown
    size: str = ""  # Human-readable size (e.g., "45 KB", "1.2 MB")


class DataSourceProvider(ABC):
    """
    Abstract interface for data source interactions.
    
    Each implementation handles one source type (Athena, DynamoDB, S3, Local).
    """

    @property
    @abstractmethod
    def source_type(self) -> str:
        """The source type identifier (e.g., 'athena', 'dynamodb', 's3', 'local')."""

    @abstractmethod
    async def get_schema(self, source_id: str, session_id: str = None) -> SourceSchema | None:
        """
        Return schema (columns, types, sample values) for a specific source.
        Returns None if the source doesn't exist or can't be accessed.
        
        Args:
            source_id: Identifier for the source (table name, file path, S3 URI)
            session_id: Optional session context (required for local files on the VM)
        """

    @abstractmethod
    async def get_preview(self, source_id: str, limit: int = 5) -> list[dict]:
        """
        Return first N rows as list of dicts (for inline preview).
        Returns empty list if unavailable.
        """

    def get_python_snippet(self, source_id: str) -> str:
        """Generate Python code to load this source into a DataFrame."""
        return f"# No Python snippet available for {source_id}"

    def get_sql_snippet(self, source_id: str) -> str:
        """Generate SQL query for this source."""
        return f"-- No SQL snippet available for {source_id}"
