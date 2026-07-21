"""
Session checkpoint and restore — S3-based persistence.

Saves executor state (namespace + local files) to S3 on termination,
and restores them when launching a new MicroVM from a session checkpoint.

S3 structure:
  sessions/{session_id}/checkpoint.pkl   — dill-serialized namespace
  sessions/{session_id}/files.tar.gz     — /tmp/ data files
  sessions/{session_id}/requirements.txt — runtime-installed packages
  sessions/{session_id}/metadata.json    — session info
"""

import os
import io
import tarfile
import glob
import json
import subprocess
import logging
from datetime import datetime, timezone

logger = logging.getLogger(__name__)


class CheckpointManager:
    """
    Manages S3 checkpoint/restore for a MicroVM session.

    Holds references to the executor and session_state so they don't
    need to be passed to every method call.
    """

    def __init__(self, executor, session_state: dict):
        self._executor = executor
        self._session_state = session_state
        self._bucket: str | None = None

    @property
    def bucket(self) -> str:
        """Get the S3 bucket name (from session config or constructed from account)."""
        if self._bucket:
            return self._bucket

        # Use bucket name passed from the proxy via runHookPayload
        if self._session_state.get("artifacts_bucket"):
            self._bucket = self._session_state["artifacts_bucket"]
            return self._bucket

        # Fallback: construct from account ID + region
        import boto3
        region = os.environ.get("AWS_REGION", "us-west-2")
        sts = boto3.client("sts")
        account_id = sts.get_caller_identity()["Account"]
        self._bucket = f"microvm-sandbox-artifacts-{account_id}-{region}"
        return self._bucket

    def save(self, session_id: str):
        """
        Checkpoint current state to S3.
        Called from the /terminate lifecycle hook.
        """
        import boto3
        import dill

        s3 = boto3.client("s3")
        prefix = f"sessions/{session_id}"

        # 1. Serialize the executor namespace
        logger.info("   Serializing namespace...")
        namespace_to_save = {}
        for key, value in self._executor._namespace.items():
            if key.startswith("__") and key.endswith("__"):
                continue
            try:
                dill.dumps(value)
                namespace_to_save[key] = value
            except Exception:
                logger.warning(f"   Skipping non-serializable: {key} ({type(value).__name__})")

        checkpoint_bytes = dill.dumps(namespace_to_save)
        s3.put_object(Bucket=self.bucket, Key=f"{prefix}/checkpoint.pkl", Body=checkpoint_bytes)
        logger.info(f"   Namespace: {len(namespace_to_save)} vars, {len(checkpoint_bytes) / 1024:.1f} KB")

        # 2. Archive local data files from /tmp/
        logger.info("   Archiving local files...")
        data_extensions = ['*.csv', '*.xlsx', '*.xls', '*.parquet', '*.json', '*.txt']
        data_files = []
        for ext in data_extensions:
            data_files.extend(glob.glob(f'/tmp/{ext}'))

        if data_files:
            tar_buffer = io.BytesIO()
            with tarfile.open(fileobj=tar_buffer, mode='w:gz') as tar:
                for filepath in data_files:
                    tar.add(filepath, arcname=os.path.basename(filepath))
            tar_buffer.seek(0)
            s3.put_object(Bucket=self.bucket, Key=f"{prefix}/files.tar.gz", Body=tar_buffer.read())
            logger.info(f"   Files: {len(data_files)} archived")

        # 3. Save runtime package list
        logger.info("   Saving package list...")
        try:
            import sys
            result = subprocess.run(
                [sys.executable, "-m", "pip", "freeze"],
                capture_output=True, text=True, timeout=10
            )
            if result.returncode == 0:
                s3.put_object(Bucket=self.bucket, Key=f"{prefix}/requirements.txt", Body=result.stdout)
        except Exception:
            pass

        # 4. Save metadata
        metadata = {
            "session_id": session_id,
            "microvm_id": self._session_state.get("microvm_id"),
            "checkpointed_at": datetime.now(timezone.utc).isoformat(),
            "execution_count": self._executor.get_stats()["execution_count"],
            "variables_count": len(namespace_to_save),
            "files_count": len(data_files),
        }
        s3.put_object(
            Bucket=self.bucket,
            Key=f"{prefix}/metadata.json",
            Body=json.dumps(metadata, indent=2),
            ContentType="application/json",
        )
        logger.info(f"   ✅ Checkpoint complete: s3://{self.bucket}/{prefix}/")

    def restore(self, session_id: str):
        """
        Restore executor state from a previous S3 checkpoint.
        Called from the /run lifecycle hook when restoreFromSession is set.
        """
        import boto3
        import dill

        s3 = boto3.client("s3")
        prefix = f"sessions/{session_id}"

        # 1. Restore namespace
        try:
            logger.info("   Restoring namespace...")
            resp = s3.get_object(Bucket=self.bucket, Key=f"{prefix}/checkpoint.pkl")
            namespace = dill.loads(resp["Body"].read())
            self._executor._namespace.update(namespace)
            logger.info(f"   Restored {len(namespace)} variables")
        except Exception as e:
            logger.error(f"   Failed to restore namespace: {e}")

        # 2. Restore local files
        try:
            logger.info("   Restoring files...")
            resp = s3.get_object(Bucket=self.bucket, Key=f"{prefix}/files.tar.gz")
            tar_buffer = io.BytesIO(resp["Body"].read())
            with tarfile.open(fileobj=tar_buffer, mode='r:gz') as tar:
                tar.extractall(path="/tmp/")
            logger.info("   Files restored to /tmp/")
        except s3.exceptions.NoSuchKey:
            logger.info("   No files archive found (skipping)")
        except Exception as e:
            logger.error(f"   Failed to restore files: {e}")

        # 3. Install runtime packages
        try:
            resp = s3.get_object(Bucket=self.bucket, Key=f"{prefix}/requirements.txt")
            requirements = resp["Body"].read().decode("utf-8")
            if requirements.strip():
                logger.info("   Installing saved packages...")
                import sys
                import tempfile
                req_file = tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False)
                req_file.write(requirements)
                req_file.close()
                subprocess.run(
                    [sys.executable, "-m", "pip", "install", "--quiet", "-r", req_file.name],
                    timeout=45
                )
                os.unlink(req_file.name)
                logger.info("   Packages restored")
        except s3.exceptions.NoSuchKey:
            pass
        except Exception as e:
            logger.warning(f"   Package restore warning: {e}")

        logger.info(f"   ✅ Session restored from: {session_id}")
