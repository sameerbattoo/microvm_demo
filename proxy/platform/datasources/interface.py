"""
DataSourceProvider — abstract interface for all data source interactions.

Each data source type (Athena, DynamoDB, S3, Local) implements this interface.
A provider owns the FULL lifecycle for its type:
  - discover():          enumerate the sources of this type (auto-discovery)
  - get_schema():        columns / types / samples for one source
  - get_preview():       first N rows
  - get_python_snippet / get_sql_snippet: ready-to-run insert code
  - class metadata:      display_name, icon, capability flags (for the UI)
  - AI metadata:         reader_docs / sql_syntax_docs (for the assistant prompt)

Adding a new source type = implement this interface + register the class in
registry.py. Everything else (endpoints, panel rendering, entity discovery,
AI prompt) derives from the registry.
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


@dataclass
class SourceRef:
    """
    A discovered source instance (result of provider.discover()), before any
    schema fetch. This is the generic, type-agnostic descriptor the frontend
    and entity discovery consume.

    Attributes:
        source_type: provider identifier ('s3', 'dynamodb', 'athena', ...)
        source_id:   canonical id used by get_schema/get_snippet (e.g. an S3 URI,
                     'database.table' for Athena, table name for DynamoDB)
        display_name: short human label shown in the panel
        detail:      short secondary line (e.g. "13 KB", "200 items", "8 cols")
        size:        human-readable size where known
        row_count:   row/item count where cheaply known
        extra:       type-specific fields (bucket, key, uri, database, region...)
                     kept so callers that still need type details can read them.
    """
    source_type: str
    source_id: str
    display_name: str
    detail: str = ""
    size: str = ""
    row_count: int | None = None
    extra: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "source_type": self.source_type,
            "source_id": self.source_id,
            "display_name": self.display_name,
            "detail": self.detail,
            "size": self.size,
            "row_count": self.row_count,
            **self.extra,
        }


class DataSourceProvider(ABC):
    """
    Abstract interface for data source interactions.

    Each implementation handles one source type (Athena, DynamoDB, S3, Local).
    """

    # --- Class-level metadata (used by the frontend + AI, no instance needed) ---
    display_name: str = ""          # e.g. "Amazon S3" — falls back to source_type
    icon: str = "database"          # frontend icon key (see DataSourcesPanel icon map)
    supports_sql: bool = True       # can this source be queried from a SQL cell?
    requires_vm_execution: bool = False  # schema/discovery needs code run on the VM (local files)

    @property
    @abstractmethod
    def source_type(self) -> str:
        """The source type identifier (e.g., 'athena', 'dynamodb', 's3', 'local')."""

    # --- Auto-discovery ---------------------------------------------------
    async def discover(self, session_id: str = None) -> list["SourceRef"]:
        """
        Enumerate all sources of this type that are in scope.

        Default returns [] — appropriate for types whose sources are discovered
        elsewhere (e.g. local /tmp files are enumerated on the VM). Cloud
        providers (S3, DynamoDB, Athena) override this with boto3 enumeration.
        """
        return []

    # --- Schema / preview -------------------------------------------------
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

    # --- Snippet generation ----------------------------------------------
    def get_python_snippet(self, source_id: str) -> str:
        """Generate Python code to load this source into a DataFrame."""
        return f"# No Python snippet available for {source_id}"

    def get_sql_snippet(self, source_id: str) -> str:
        """Generate SQL query for this source."""
        return f"-- No SQL snippet available for {source_id}"

    # --- AI assistant metadata -------------------------------------------
    # These let the assistant prompt (proxy/notebook/ai/prompts.py) be generated
    # from the registry instead of hardcoding per-source facts. Return one line
    # per entry. The VM still implements the actual helper functions; these just
    # document them so the prompt stays in sync with the registered providers.
    def reader_docs(self) -> list[str]:
        """Lines describing the built-in reader helper(s) for this source, e.g.
        'read_athena(sql, database=...) -> df   # Run Athena SQL, return DataFrame'."""
        return []

    def sql_syntax_docs(self) -> list[str]:
        """Lines describing SQL-cell syntax for this source (empty if !supports_sql)."""
        return []
