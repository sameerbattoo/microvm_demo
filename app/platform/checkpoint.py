"""
Session checkpoint and restore — S3-based persistence.

Part of: app.platform (infrastructure layer)

Saves executor state (namespace + local files) to S3 on termination,
and restores them when launching a new MicroVM from a session checkpoint.
Includes per-step timing for performance analysis.

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
        self.last_save_timings: dict = {}
        self.last_restore_timings: dict = {}

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
        import time as _time

        s3 = boto3.client("s3")
        prefix = f"sessions/{session_id}"
        step_timings = {}

        # 1. Serialize the executor namespace
        t0 = _time.perf_counter()
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
        step_timings["serialize"] = _time.perf_counter() - t0

        # 2. Upload checkpoint.pkl to S3
        t0 = _time.perf_counter()
        s3.put_object(Bucket=self.bucket, Key=f"{prefix}/checkpoint.pkl", Body=checkpoint_bytes)
        step_timings["upload_pkl"] = _time.perf_counter() - t0
        logger.info(f"   Namespace: {len(namespace_to_save)} vars, {len(checkpoint_bytes) / 1024:.1f} KB (serialize: {step_timings['serialize']*1000:.0f}ms, upload: {step_timings['upload_pkl']*1000:.0f}ms)")

        # 2b. Archive local data files from /tmp/
        t0 = _time.perf_counter()
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
            step_timings["archive_files"] = _time.perf_counter() - t0
            logger.info(f"   Files: {len(data_files)} archived ({step_timings['archive_files']*1000:.0f}ms)")
        else:
            step_timings["archive_files"] = _time.perf_counter() - t0

        # 3. Save runtime package list
        t0 = _time.perf_counter()
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
        step_timings["packages"] = _time.perf_counter() - t0

        # 4. Save metadata (includes timing breakdown for analysis)
        t0 = _time.perf_counter()
        metadata = {
            "session_id": session_id,
            "microvm_id": self._session_state.get("microvm_id"),
            "checkpointed_at": datetime.now(timezone.utc).isoformat(),
            "execution_count": self._executor.get_stats()["execution_count"],
            "variables_count": len(namespace_to_save),
            "files_count": len(data_files),
            "checkpoint_size_kb": round(len(checkpoint_bytes) / 1024, 1),
            "save_timings_ms": {k: round(v * 1000, 1) for k, v in step_timings.items()},
        }
        s3.put_object(
            Bucket=self.bucket,
            Key=f"{prefix}/metadata.json",
            Body=json.dumps(metadata, indent=2),
            ContentType="application/json",
        )
        step_timings["metadata"] = _time.perf_counter() - t0
        total_time = sum(step_timings.values())
        logger.info(f"   ✅ Checkpoint complete: s3://{self.bucket}/{prefix}/ ({total_time*1000:.0f}ms total)")
        logger.info(f"   ⏱  Breakdown: serialize={step_timings['serialize']*1000:.0f}ms, upload_pkl={step_timings['upload_pkl']*1000:.0f}ms, archive={step_timings['archive_files']*1000:.0f}ms, packages={step_timings['packages']*1000:.0f}ms, metadata={step_timings['metadata']*1000:.0f}ms")
        self.last_save_timings = {k: round(v * 1000, 1) for k, v in step_timings.items()}
        self.last_save_timings["total_ms"] = round(total_time * 1000, 1)

    def restore(self, session_id: str):
        """
        Restore executor state from a previous S3 checkpoint.
        Called from the /run lifecycle hook when restoreFromSession is set.
        """
        import boto3
        import dill
        import time as _time

        s3 = boto3.client("s3")
        prefix = f"sessions/{session_id}"
        step_timings = {}

        # 1. Restore namespace
        try:
            t0 = _time.perf_counter()
            logger.info("   Restoring namespace...")
            resp = s3.get_object(Bucket=self.bucket, Key=f"{prefix}/checkpoint.pkl")
            pkl_bytes = resp["Body"].read()
            step_timings["download_pkl"] = _time.perf_counter() - t0

            t0 = _time.perf_counter()
            namespace = dill.loads(pkl_bytes)
            self._executor._namespace.update(namespace)
            step_timings["deserialize"] = _time.perf_counter() - t0
            logger.info(f"   Restored {len(namespace)} variables ({len(pkl_bytes)/1024:.1f} KB, download: {step_timings['download_pkl']*1000:.0f}ms, deserialize: {step_timings['deserialize']*1000:.0f}ms)")
        except Exception as e:
            logger.error(f"   Failed to restore namespace: {e}")

        # 2. Restore local files
        try:
            t0 = _time.perf_counter()
            logger.info("   Restoring files...")
            resp = s3.get_object(Bucket=self.bucket, Key=f"{prefix}/files.tar.gz")
            tar_buffer = io.BytesIO(resp["Body"].read())
            step_timings["download_files"] = _time.perf_counter() - t0

            t0 = _time.perf_counter()
            with tarfile.open(fileobj=tar_buffer, mode='r:gz') as tar:
                tar.extractall(path="/tmp/")
            step_timings["extract_files"] = _time.perf_counter() - t0
            logger.info(f"   Files restored to /tmp/ (download: {step_timings['download_files']*1000:.0f}ms, extract: {step_timings['extract_files']*1000:.0f}ms)")
        except s3.exceptions.NoSuchKey:
            logger.info("   No files archive found (skipping)")
            step_timings["download_files"] = 0
            step_timings["extract_files"] = 0
        except Exception as e:
            logger.error(f"   Failed to restore files: {e}")

        # 3. Install runtime packages (only ones NOT already in the base image)
        try:
            t0 = _time.perf_counter()
            resp = s3.get_object(Bucket=self.bucket, Key=f"{prefix}/requirements.txt")
            requirements = resp["Body"].read().decode("utf-8")
            if requirements.strip():
                import sys

                # Get currently installed packages (from the base image)
                current_result = subprocess.run(
                    [sys.executable, "-m", "pip", "freeze"],
                    capture_output=True, text=True, timeout=10
                )
                installed = set()
                if current_result.returncode == 0:
                    for line in current_result.stdout.strip().split('\n'):
                        if line.strip():
                            installed.add(line.strip().lower())

                # Find packages that need installing (in checkpoint but not in image)
                saved_packages = [l.strip() for l in requirements.strip().split('\n') if l.strip()]
                new_packages = [p for p in saved_packages if p.lower() not in installed]

                if new_packages:
                    logger.info(f"   Installing {len(new_packages)} runtime packages (skipping {len(saved_packages) - len(new_packages)} pre-baked)...")
                    import tempfile
                    req_file = tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False)
                    req_file.write('\n'.join(new_packages))
                    req_file.close()
                    subprocess.run(
                        [sys.executable, "-m", "pip", "install", "--quiet", "-r", req_file.name],
                        timeout=45
                    )
                    os.unlink(req_file.name)
                    logger.info(f"   Installed: {', '.join(new_packages)}")
                else:
                    logger.info(f"   All {len(saved_packages)} packages already installed (skipping pip)")
            step_timings["packages"] = _time.perf_counter() - t0
        except s3.exceptions.NoSuchKey:
            step_timings["packages"] = 0
            pass
        except Exception as e:
            logger.warning(f"   Package restore warning: {e}")

        total_time = sum(step_timings.values())
        logger.info(f"   ✅ Session restored from: {session_id} ({total_time*1000:.0f}ms total)")
        logger.info(f"   ⏱  Breakdown: download_pkl={step_timings.get('download_pkl',0)*1000:.0f}ms, deserialize={step_timings.get('deserialize',0)*1000:.0f}ms, download_files={step_timings.get('download_files',0)*1000:.0f}ms, extract={step_timings.get('extract_files',0)*1000:.0f}ms, packages={step_timings.get('packages',0)*1000:.0f}ms")
        self.last_restore_timings = {k: round(v * 1000, 1) for k, v in step_timings.items()}
        self.last_restore_timings["total_ms"] = round(total_time * 1000, 1)
