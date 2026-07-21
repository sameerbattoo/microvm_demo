"""
Storage abstraction layer for the MicroVM Notebook proxy.

Provides a single `storage` instance that implements the StorageBackend interface.
The backend and connection details are configured via environment variables
(set in scripts/config.sh):

  STORAGE_BACKEND:    "sqlite" (default), "mysql", "postgres"
  STORAGE_CONNECTION: Connection string (empty for sqlite, URL for mysql/postgres)

Usage in proxy code:
    from proxy.storage import storage

    notebooks = storage.notebook_list()
    storage.vm_session_create(microvm_id=..., ...)
"""

import os
from proxy.storage.interface import StorageBackend

_backend_type = os.environ.get("STORAGE_BACKEND", "sqlite").lower()
_connection_string = os.environ.get("STORAGE_CONNECTION", "")

if _backend_type == "sqlite":
    from proxy.storage.sqlite_db import SqliteStorage
    storage: StorageBackend = SqliteStorage()
elif _backend_type == "mysql":
    # Future: from proxy.storage.mysql_db import MysqlStorage
    # storage: StorageBackend = MysqlStorage(connection_string=_connection_string)
    raise NotImplementedError("MySQL backend not yet implemented. Set STORAGE_BACKEND=sqlite")
elif _backend_type == "postgres":
    # Future: from proxy.storage.postgres_db import PostgresStorage
    # storage: StorageBackend = PostgresStorage(connection_string=_connection_string)
    raise NotImplementedError("Postgres backend not yet implemented. Set STORAGE_BACKEND=sqlite")
else:
    raise ValueError(f"Unknown STORAGE_BACKEND: {_backend_type}. Supported: sqlite, mysql, postgres")
