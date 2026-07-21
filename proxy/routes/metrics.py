"""
Metrics, image tiers, and package listing routes.

Endpoints:
  GET /instances/metrics/history/{id}  - Metrics time-series for sparklines
  GET /instances/metrics/latest        - Latest metrics for all VMs
  GET /image-tiers                     - Available MicroVM memory/vCPU tiers
  GET /packages                        - Installed Python packages (local fallback)
"""

import json
import logging
import subprocess

from fastapi import APIRouter, Request

from proxy.storage import storage
from proxy.microvm_manager import IMAGE_ARN

logger = logging.getLogger(__name__)

router = APIRouter(tags=["metrics"])


@router.get("/instances/metrics/history/{microvm_id}")
async def metrics_history(microvm_id: str, minutes: int = 5):
    """Get metrics time-series for a VM (for sparkline charts)."""
    history = storage.metrics_get_history(microvm_id, minutes)
    latest = storage.metrics_get_latest(microvm_id)
    return {"history": history, "latest": latest}


@router.get("/instances/metrics/latest")
async def metrics_latest(request: Request):
    """Get latest metrics snapshot for all running VMs."""
    vm_manager = request.app.state.vm_manager
    result = {}
    for mid in vm_manager.active_microvms:
        latest = storage.metrics_get_latest(mid)
        if latest:
            result[mid] = latest
    return {"metrics": result}


@router.get("/image-tiers")
async def list_image_tiers(request: Request):
    """Discover available MicroVM image size tiers."""
    if not IMAGE_ARN:
        return {"tiers": []}

    try:
        vm_manager = request.app.state.vm_manager
        client = vm_manager.get_lambda_client()
        image_base = IMAGE_ARN.split(":")[-1]

        response = client.list_microvm_images()
        tiers = []
        for img in response.get("items", []):
            name = img.get("name", "")
            state = img.get("state", "")
            if name.startswith(f"{image_base}-") and state in ("CREATED", "UPDATED"):
                suffix = name.replace(f"{image_base}-", "")
                if suffix.isdigit():
                    mem = int(suffix)
                    vcpu = mem / 2048
                    tiers.append({
                        "memory_mib": mem,
                        "memory_gb": mem / 1024,
                        "vcpu": vcpu,
                        "label": f"{mem / 1024:.1f} GB · {vcpu} vCPU",
                        "image_name": name,
                    })

        tiers.sort(key=lambda t: t["memory_mib"])
        return {"tiers": tiers}
    except Exception as e:
        logger.warning(f"Failed to list image tiers: {e}")
        return {"tiers": []}


@router.get("/packages")
async def list_packages():
    """List installed packages (local dev fallback)."""
    try:
        result = subprocess.run(
            ["pip3", "list", "--format=json"],
            capture_output=True, text=True, timeout=15
        )
        if result.returncode != 0:
            result = subprocess.run(
                ["pip", "list", "--format=json"],
                capture_output=True, text=True, timeout=15
            )
        packages = json.loads(result.stdout) if result.returncode == 0 else []
    except Exception:
        packages = []

    pkg_list = [{"name": p.get("name", ""), "version": p.get("version", "")} for p in packages]
    pkg_list.sort(key=lambda p: p["name"].lower())
    return {"packages": pkg_list, "count": len(pkg_list)}
