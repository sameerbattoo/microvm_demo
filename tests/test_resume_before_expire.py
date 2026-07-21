#!/usr/bin/env python3
"""
Test: Resume VM before max duration expires — does AWS fire /terminate hook?

HYPOTHESIS:
  If we resume a suspended VM 30s before maximumDurationInSeconds expires,
  the VM will be in RUNNING state when the service auto-terminates it.
  Since it's RUNNING, AWS should fire the /terminate hook.

TEST FLOW:
  1. Launch VM: maxDuration=180s, idleTimeout=60s, checkpoint=True
  2. Execute code (create state)
  3. Wait for VM to suspend (~60s idle)
  4. At t=150s (30s before max duration), resume the VM
  5. Let AWS terminate it at t=180s (max duration)
  6. Check if /terminate hook fired
  7. Check if S3 checkpoint was saved

  Total test time: ~4 minutes

Usage:
    python3 tests/test_resume_before_expire.py
"""

import time
import json
import requests
import boto3

PROXY_URL = "http://localhost:8081"
AWS_REGION = "us-west-2"
MEMORY_MIB = 2048
MAX_DURATION_SEC = 240       # 4 minutes — timer fires at 216s, we resume at 210s
IDLE_TIMEOUT_SEC = 60
RESUME_BEFORE_SEC = 30       # Resume 30s before max duration


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}")


def execute_code(microvm_id, real_endpoint, code, timeout=60):
    resp = requests.post(
        f"{PROXY_URL}/proxy/execute",
        headers={
            "Content-Type": "application/json",
            "X-MicroVM-Id": microvm_id,
            "X-MicroVM-Endpoint": real_endpoint,
        },
        json={"code": code},
        timeout=timeout,
    )
    return resp.json()


def get_instance_state(microvm_id):
    resp = requests.get(f"{PROXY_URL}/instances", timeout=10)
    instances = resp.json().get("instances", {})
    inst = instances.get(microvm_id)
    return inst.get("state") if inst else "NOT_FOUND"


def main():
    log("=" * 70)
    log("  Test: Resume Before Max Duration — Does AWS fire /terminate?")
    log("=" * 70)
    log("")
    log(f"  Plan: Launch ({MAX_DURATION_SEC}s max) → suspend → resume at t={MAX_DURATION_SEC - RESUME_BEFORE_SEC}s → let AWS terminate at t={MAX_DURATION_SEC}s")
    log("")

    # Check proxy
    try:
        health = requests.get(f"{PROXY_URL}/health", timeout=5).json()
        assert health["status"] == "proxy running"
    except:
        log("  ❌ Proxy not reachable")
        return

    # Launch
    session_id = f"resume-test-{int(time.time())}"
    launch_time = time.time()

    log("PHASE 1: Launch VM")
    resp = requests.post(f"{PROXY_URL}/launch", json={
        "name": "resume-expire-test",
        "memoryMiB": MEMORY_MIB,
        "idleTimeoutSeconds": IDLE_TIMEOUT_SEC,
        "maxDurationSeconds": MAX_DURATION_SEC,
        "checkpointEnabled": True,
        "sessionId": session_id,
    }, timeout=120)
    assert resp.status_code == 200, f"Launch failed: {resp.text}"
    data = resp.json()
    microvm_id = data["microvmId"]
    endpoint = data["endpoint"]

    log(f"  VM: {microvm_id}")
    log(f"  Session: {session_id}")
    log(f"  Resume at: ~{time.strftime('%H:%M:%S', time.localtime(launch_time + MAX_DURATION_SEC - RESUME_BEFORE_SEC))}")
    log(f"  AWS terminates: ~{time.strftime('%H:%M:%S', time.localtime(launch_time + MAX_DURATION_SEC))}")
    log("")

    # Create state
    log("PHASE 2: Create state")
    result = execute_code(microvm_id, endpoint,
        "checkpoint_value = 'RESUME_EXPIRE_TEST'\n"
        "magic = 77777\n"
        "print(f'State: {checkpoint_value}, {magic}')"
    )
    assert result.get("success"), f"Failed: {result.get('error')}"
    log(f"  ✓ {result['output'].strip()}")
    log("")

    # Wait for suspend
    log("PHASE 3: Wait for suspend")
    time.sleep(IDLE_TIMEOUT_SEC + 10)
    state = get_instance_state(microvm_id)
    log(f"  State: {state}")
    log("")

    # Wait until 30s before max duration — the proxy's timer should resume the VM
    resume_at = launch_time + MAX_DURATION_SEC - RESUME_BEFORE_SEC
    wait_for_resume = resume_at - time.time()
    if wait_for_resume > 0:
        log(f"PHASE 4: Waiting {int(wait_for_resume)}s for proxy timer to resume VM...")
        time.sleep(wait_for_resume)

    log(f"  Proxy timer should fire now (t={int(time.time() - launch_time)}s)")
    # Wait a few seconds for the resume to take effect
    for i in range(6):
        time.sleep(3)
        state = get_instance_state(microvm_id)
        log(f"  [{int(time.time() - launch_time)}s] State: {state}")
        if state == "RUNNING":
            break
    log("")

    # Now wait for AWS to terminate at max duration
    log("PHASE 5: Waiting for AWS to auto-terminate (max duration)...")
    expire_time = launch_time + MAX_DURATION_SEC + 30  # +30s buffer
    while time.time() < expire_time:
        state = get_instance_state(microvm_id)
        elapsed = int(time.time() - launch_time)
        if state in ("TERMINATED", "NOT_FOUND"):
            log(f"  [{elapsed}s] VM terminated! ✓")
            break
        log(f"  [{elapsed}s] State: {state}")
        time.sleep(10)
    else:
        log(f"  ⚠ VM still alive after expected termination time")
    log("")

    # Check S3 checkpoint
    log("PHASE 6: Check S3 checkpoint")
    time.sleep(5)
    s3 = boto3.client("s3", region_name=AWS_REGION)
    bucket = f"microvm-sandbox-artifacts-175918693907-{AWS_REGION}"
    try:
        resp = s3.list_objects_v2(Bucket=bucket, Prefix=f"sessions/{session_id}/")
        files = [obj["Key"] for obj in resp.get("Contents", [])]
    except:
        files = []

    if files:
        log(f"  ✅ CHECKPOINT SAVED! ({len(files)} files)")
        for f in files:
            log(f"    • {f}")
        log("")
        log("  CONCLUSION: AWS DOES fire /terminate hook when it auto-terminates")
        log("  a RUNNING VM. Just resuming before expiry is sufficient!")
    else:
        log(f"  ❌ No checkpoint found")
        log("")
        log("  CONCLUSION: AWS did NOT fire /terminate hook even on a RUNNING VM")
        log("  auto-terminated by max duration. Explicit terminate is required.")

    # Check CloudWatch for confirmation
    log("")
    log("PHASE 7: CloudWatch log check")
    import subprocess
    from datetime import datetime, timezone, timedelta
    pst = timezone(timedelta(hours=-7))

    for lg in ["/aws/lambda-microvms/agent-sandbox-2048", "/aws/lambda-microvms/agent-sandbox-1024"]:
        result = subprocess.run(
            ["aws", "logs", "get-log-events",
             "--log-group-name", lg,
             "--log-stream-name", f"2026/07/21[1.0]{microvm_id}",
             "--limit", "10",
             "--region", "us-west-2"],
            capture_output=True, text=True
        )
        try:
            events_data = json.loads(result.stdout)
            events = events_data.get('events', [])
            if events:
                log(f"  Last events from {lg.split('/')[-1]}:")
                for e in events[-5:]:
                    t = datetime.fromtimestamp(e['timestamp']/1000, tz=pst).strftime('%I:%M:%S %p')
                    log(f"    [{t}] {e['message'].strip()[:120]}")
                break
        except:
            pass

    # Cleanup
    log("")
    log("  Cleanup: terminating if still alive...")
    try:
        requests.post(f"{PROXY_URL}/terminate/{microvm_id}", timeout=10)
    except:
        pass
    log("  Done.")


if __name__ == "__main__":
    main()
