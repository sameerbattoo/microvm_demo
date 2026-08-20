"""
Data source provider registry — the single source of truth for source types.

Every part of the system that needs to know about data source types (the
/datasources endpoints, the Data Sources panel, entity discovery, and the AI
assistant prompt) goes through this registry instead of hardcoding the 4 types.

Adding a new source type is therefore a two-step change:
  1. Implement DataSourceProvider in a new module.
  2. Add the class to _PROVIDER_CLASSES below.
Everything else (enumeration, schema, snippet, panel rendering, entity
discovery enumeration, AI prompt reader/SQL docs) derives from here.
"""

import asyncio
import logging

from .interface import DataSourceProvider, SourceRef
from .athena import AthenaSchemaProvider
from .dynamodb import DynamoDBSchemaProvider
from .s3 import S3SchemaProvider
from .local import LocalFileSchemaProvider

logger = logging.getLogger(__name__)

# Ordered — controls display order in the panel and the AI prompt.
_PROVIDER_CLASSES: list[type[DataSourceProvider]] = [
    LocalFileSchemaProvider,
    S3SchemaProvider,
    DynamoDBSchemaProvider,
    AthenaSchemaProvider,
]

# source_type -> provider class. Built once at import.
_REGISTRY: dict[str, type[DataSourceProvider]] = {}
for _cls in _PROVIDER_CLASSES:
    try:
        _REGISTRY[_cls().source_type] = _cls
    except Exception as e:  # pragma: no cover — a broken provider shouldn't kill the app
        logger.warning(f"Failed to register provider {_cls.__name__}: {e}")


def provider_classes() -> list[type[DataSourceProvider]]:
    """All registered provider classes, in display order."""
    return list(_PROVIDER_CLASSES)


def get_provider(source_type: str, execute_fn=None) -> DataSourceProvider | None:
    """
    Instantiate the provider for a source type, or None if unknown.

    execute_fn is only used by providers that require VM execution (local files);
    it is passed to the constructor when supported.
    """
    cls = _REGISTRY.get(source_type)
    if cls is None:
        return None
    if getattr(cls, "requires_vm_execution", False):
        return cls(execute_fn=execute_fn)
    return cls()


def all_providers(execute_fn=None) -> list[DataSourceProvider]:
    """Instantiate every registered provider, in display order."""
    return [get_provider(cls().source_type, execute_fn=execute_fn) for cls in _PROVIDER_CLASSES]


def provider_metadata() -> list[dict]:
    """
    Lightweight metadata for each source type (for the frontend to render the
    panel generically). Ordered.
    """
    meta = []
    for cls in _PROVIDER_CLASSES:
        inst = cls()
        meta.append({
            "source_type": inst.source_type,
            "display_name": cls.display_name or inst.source_type,
            "icon": cls.icon,
            "supports_sql": cls.supports_sql,
            "requires_vm_execution": cls.requires_vm_execution,
        })
    return meta


async def discover_all(session_id: str = None, execute_fn=None) -> list[SourceRef]:
    """
    Run discover() on every provider concurrently and aggregate the results.
    Providers that don't enumerate (e.g. local at the proxy level) return [].
    """
    providers = all_providers(execute_fn=execute_fn)
    results = await asyncio.gather(
        *(p.discover(session_id=session_id) for p in providers),
        return_exceptions=True,
    )
    refs: list[SourceRef] = []
    for p, res in zip(providers, results):
        if isinstance(res, Exception):
            logger.warning(f"discover() failed for {p.source_type}: {res}")
            continue
        refs.extend(res)
    return refs


def discover_all_sync(session_id: str = None, execute_fn=None) -> list[SourceRef]:
    """
    Synchronous wrapper around discover_all() for non-async callers (e.g. the
    batch entity-discovery process). Safe whether or not an event loop is running.
    """
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        # No running loop — safe to drive one directly.
        return asyncio.run(discover_all(session_id=session_id, execute_fn=execute_fn))
    # Called from within a running loop — run in a separate thread with its own loop.
    import concurrent.futures
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as ex:
        return ex.submit(
            lambda: asyncio.run(discover_all(session_id=session_id, execute_fn=execute_fn))
        ).result()


def reader_docs() -> list[str]:
    """All built-in reader helper doc lines, aggregated across providers (for the AI prompt)."""
    lines: list[str] = []
    for cls in _PROVIDER_CLASSES:
        lines.extend(cls().reader_docs())
    return lines


def sql_syntax_docs() -> list[str]:
    """All SQL-cell syntax doc lines, aggregated across SQL-capable providers (for the AI prompt)."""
    lines: list[str] = []
    for cls in _PROVIDER_CLASSES:
        inst = cls()
        if inst.supports_sql:
            lines.extend(inst.sql_syntax_docs())
    return lines
