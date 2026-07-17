#!/usr/bin/env python3
"""
End-to-End Test: MicroVM Session Checkpoint & Restore via S3

This script:
1. Launches a MicroVM with checkpoint enabled
2. Creates state (variables, DataFrames, local files)
3. Terminates the MicroVM (triggers S3 checkpoint)
4. Validates the checkpoint exists in S3
5. Launches a new MicroVM with restore from the checkpoint
6. Validates all state was restored correctly
7. Reports timing for each operation

Usage:
    python3 testS3Restore.py
"""

import time
import json
import boto3
import requests

# --- Configuration ---
PROXY_URL = "http://localhost:8081"
AWS_REGION = "us-west-2"
MEMORY_MIB = 2048  # Use smallest tier for faster test


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}")


def timed(label):
    """Context manager to time operations."""
    class Timer:
        def __init__(self):
            self.elapsed = 0
        def __enter__(self):
            self.start = time.time()
            return self
        def __exit__(self, *args):
            self.elapsed = time.time() - self.start
            log(f"  ⏱  {label}: {self.elapsed:.1f}s")
    return Timer()


def wait_for_running(microvm_id, timeout=90):
    """Poll until MicroVM is RUNNING."""
    start = time.time()
    while time.time() - start < timeout:
        resp = requests.get(f"{PROXY_URL}/instances")
        instances = resp.json().get("instances", {})
        inst = instances.get(microvm_id, {})
        if inst.get("state") == "RUNNING":
            return inst
        time.sleep(3)
    raise TimeoutError(f"MicroVM {microvm_id} did not reach RUNNING in {timeout}s")


def wait_for_terminated(microvm_id, timeout=90):
    """Poll until MicroVM is TERMINATED."""
    client = boto3.client("lambda-microvms", region_name=AWS_REGION)
    start = time.time()
    while time.time() - start < timeout:
        try:
            resp = client.get_microvm(microvmIdentifier=microvm_id)
            if resp.get("state") == "TERMINATED":
                return
        except Exception:
            return  # Might get ResourceNotFound after termination
        time.sleep(3)
    raise TimeoutError(f"MicroVM {microvm_id} did not terminate in {timeout}s")


def execute_code(endpoint, microvm_id, code):
    """Execute code on a MicroVM via the proxy."""
    headers = {
        "Content-Type": "application/json",
        "X-MicroVM-Id": microvm_id,
        "X-MicroVM-Endpoint": endpoint,
    }
    resp = requests.post(
        f"{PROXY_URL}/proxy/execute",
        headers=headers,
        json={"code": code},
    )
    return resp.json()


def main():
    print("=" * 60)
    print("  MicroVM Session Checkpoint & Restore — E2E Test")
    print("=" * 60)
    print()

    timings = {}

    # ================================================================
    # PHASE 1: Launch MicroVM with checkpoint enabled
    # ================================================================
    log("PHASE 1: Launching MicroVM with checkpoint enabled...")

    with timed("Launch MicroVM") as t:
        session_id = f"test-checkpoint-{int(time.time())}"
        resp = requests.post(f"{PROXY_URL}/launch", json={
            "name": "test-checkpoint",
            "memoryMiB": MEMORY_MIB,
            "idleTimeoutSeconds": 1800,
            "maxDurationSeconds": 28800,
            "checkpointEnabled": True,
            "sessionId": session_id,
        })
        launch_data = resp.json()
        assert "microvmId" in launch_data, f"Launch failed: {launch_data}"
        microvm_id = launch_data["microvmId"]
        endpoint = launch_data["endpoint"]
    timings["launch"] = t.elapsed

    log(f"  MicroVM ID: {microvm_id}")
    log(f"  Endpoint:   {endpoint}")
    log(f"  Session ID: {session_id}")

    # Wait for it to be fully running
    with timed("Wait for RUNNING") as t:
        wait_for_running(microvm_id)
    timings["wait_running"] = t.elapsed

    # Give the /run hook a moment to complete
    time.sleep(2)

    # ================================================================
    # PHASE 2: Create state (variables, DataFrame, local file)
    # ================================================================
    log("")
    log("PHASE 2: Creating state in the MicroVM...")

    # Create variables
    result = execute_code(endpoint, microvm_id, """
import pandas as pd
import numpy as np

# Create some variables
x = 42
message = "Hello from checkpoint test!"
numbers = list(range(1, 101))

# Create a DataFrame
df = pd.DataFrame({
    'name': ['Alice', 'Bob', 'Charlie', 'Diana', 'Eve'],
    'score': [95, 87, 92, 78, 99],
    'city': ['NYC', 'SF', 'LA', 'Chicago', 'Boston']
})

# Create a numpy array
matrix = np.random.rand(10, 10)

print(f"Created: x={x}, message='{message}', len(numbers)={len(numbers)}")
print(f"DataFrame shape: {df.shape}")
print(f"Matrix shape: {matrix.shape}")
""")
    assert result.get("success"), f"Execution failed: {result.get('error')}"
    log(f"  Variables created: {result.get('output', '').strip()}")

    # Create a local file in /tmp
    result = execute_code(endpoint, microvm_id, """
import csv

# Write a CSV file to /tmp
data = [
    ['id', 'product', 'price'],
    [1, 'Widget', 9.99],
    [2, 'Gadget', 19.99],
    [3, 'Doohickey', 4.99],
    [4, 'Thingamajig', 14.99],
    [5, 'Whatchamacallit', 7.99],
]

with open('/tmp/test_products.csv', 'w', newline='') as f:
    writer = csv.writer(f)
    writer.writerows(data)

print("Created /tmp/test_products.csv (5 products)")
""")
    assert result.get("success"), f"File creation failed: {result.get('error')}"
    log(f"  {result.get('output', '').strip()}")

    # Verify state
    result = execute_code(endpoint, microvm_id, """
import os
print(f"Variables: x={x}, message='{message[:20]}...', df.shape={df.shape}")
print(f"File exists: {os.path.exists('/tmp/test_products.csv')}")
print(f"File size: {os.path.getsize('/tmp/test_products.csv')} bytes")
""")
    log(f"  State verification: {result.get('output', '').strip()}")

    # Session ID is known — we passed it at launch
    log(f"  Session ID: {session_id}")
    restore_session_id = session_id

    # ================================================================
    # PHASE 3: Terminate MicroVM (triggers checkpoint)
    # ================================================================
    log("")
    log("PHASE 3: Terminating MicroVM (triggers S3 checkpoint)...")

    with timed("Terminate MicroVM") as t:
        resp = requests.post(f"{PROXY_URL}/terminate/{microvm_id}")
        assert resp.status_code == 200, f"Terminate failed: {resp.text}"
    timings["terminate_request"] = t.elapsed

    with timed("Wait for TERMINATED") as t:
        wait_for_terminated(microvm_id)
    timings["wait_terminated"] = t.elapsed

    # ================================================================
    # PHASE 4: Validate checkpoint in S3
    # ================================================================
    log("")
    log("PHASE 4: Validating checkpoint in S3...")

    time.sleep(3)  # Give S3 a moment for consistency

    with timed("Check S3 checkpoint") as t:
        # List sessions via the proxy
        resp = requests.get(f"{PROXY_URL}/sessions")
        sessions = resp.json().get("sessions", [])
    timings["list_sessions"] = t.elapsed

    log(f"  Found {len(sessions)} session(s) in S3:")
    for s in sessions:
        log(f"    - {s['session_id']} (vars: {s.get('variables_count', '?')}, files: {s.get('files_count', '?')})")

    # Find our session
    our_session = None
    for s in sessions:
        if "test-checkpoint" in s["session_id"]:
            our_session = s
            break

    if our_session:
        log(f"  ✅ Checkpoint found: {our_session['session_id']}")
        log(f"     Variables: {our_session.get('variables_count', '?')}")
        log(f"     Files: {our_session.get('files_count', '?')}")
        log(f"     Checkpointed at: {our_session.get('checkpointed_at', '?')}")
        restore_session_id = our_session["session_id"]
    else:
        log("  ❌ No checkpoint found for our session!")
        log("     This may mean the terminate hook didn't fire or checkpoint failed.")
        log("     Check the MicroVM logs for errors.")
        print("\n" + "=" * 60)
        print("  TEST RESULT: FAILED (no checkpoint)")
        print("=" * 60)
        return

    # ================================================================
    # PHASE 5: Launch new MicroVM with restore
    # ================================================================
    log("")
    log("PHASE 5: Launching new MicroVM with session restore...")

    with timed("Launch MicroVM (with restore)") as t:
        restore_session_id_new = f"{restore_session_id}-restored-{int(time.time())}"
        resp = requests.post(f"{PROXY_URL}/launch", json={
            "name": "test-restore",
            "memoryMiB": MEMORY_MIB,
            "idleTimeoutSeconds": 1800,
            "maxDurationSeconds": 28800,
            "checkpointEnabled": False,
            "sessionId": restore_session_id_new,
            "restoreFromSession": restore_session_id,
        })
        restore_data = resp.json()
        assert "microvmId" in restore_data, f"Restore launch failed: {restore_data}"
        restore_microvm_id = restore_data["microvmId"]
        restore_endpoint = restore_data["endpoint"]
    timings["launch_restore"] = t.elapsed

    log(f"  New MicroVM ID: {restore_microvm_id}")

    with timed("Wait for RUNNING (restore)") as t:
        wait_for_running(restore_microvm_id)
    timings["wait_running_restore"] = t.elapsed

    # Give the /run hook time to restore state
    log("  Waiting for restore to complete (run hook)...")
    time.sleep(10)

    # ================================================================
    # PHASE 6: Validate restored state
    # ================================================================
    log("")
    log("PHASE 6: Validating restored state...")

    checks_passed = 0
    checks_total = 0

    # Check variables
    result = execute_code(restore_endpoint, restore_microvm_id, "print(f'x={x}')")
    checks_total += 1
    if result.get("success") and "x=42" in result.get("output", ""):
        log("  ✅ Variable 'x' restored: x=42")
        checks_passed += 1
    else:
        log(f"  ❌ Variable 'x' NOT restored: {result.get('error') or result.get('output')}")

    result = execute_code(restore_endpoint, restore_microvm_id, "print(f'message={message}')")
    checks_total += 1
    if result.get("success") and "Hello from checkpoint test" in result.get("output", ""):
        log("  ✅ Variable 'message' restored")
        checks_passed += 1
    else:
        log(f"  ❌ Variable 'message' NOT restored: {result.get('error') or result.get('output')}")

    result = execute_code(restore_endpoint, restore_microvm_id, "print(f'len(numbers)={len(numbers)}')")
    checks_total += 1
    if result.get("success") and "len(numbers)=100" in result.get("output", ""):
        log("  ✅ Variable 'numbers' restored (100 items)")
        checks_passed += 1
    else:
        log(f"  ❌ Variable 'numbers' NOT restored: {result.get('error') or result.get('output')}")

    # Check DataFrame
    result = execute_code(restore_endpoint, restore_microvm_id, "print(f'df.shape={df.shape}, columns={list(df.columns)}')")
    checks_total += 1
    if result.get("success") and "(5, 3)" in result.get("output", ""):
        log("  ✅ DataFrame 'df' restored: (5, 3)")
        checks_passed += 1
    else:
        log(f"  ❌ DataFrame 'df' NOT restored: {result.get('error') or result.get('output')}")

    # Check numpy array
    result = execute_code(restore_endpoint, restore_microvm_id, "print(f'matrix.shape={matrix.shape}')")
    checks_total += 1
    if result.get("success") and "(10, 10)" in result.get("output", ""):
        log("  ✅ Numpy array 'matrix' restored: (10, 10)")
        checks_passed += 1
    else:
        log(f"  ❌ Numpy array 'matrix' NOT restored: {result.get('error') or result.get('output')}")

    # Check local file
    result = execute_code(restore_endpoint, restore_microvm_id, """
import os
exists = os.path.exists('/tmp/test_products.csv')
size = os.path.getsize('/tmp/test_products.csv') if exists else 0
print(f'file_exists={exists}, size={size}')
""")
    checks_total += 1
    if result.get("success") and "file_exists=True" in result.get("output", ""):
        log("  ✅ File '/tmp/test_products.csv' restored")
        checks_passed += 1
    else:
        log(f"  ❌ File NOT restored: {result.get('error') or result.get('output')}")

    # Check file content
    result = execute_code(restore_endpoint, restore_microvm_id, """
import csv
with open('/tmp/test_products.csv', 'r') as f:
    reader = csv.reader(f)
    rows = list(reader)
print(f'rows={len(rows)}, header={rows[0]}, first_data={rows[1]}')
""")
    checks_total += 1
    if result.get("success") and "Widget" in result.get("output", ""):
        log("  ✅ File content verified (products data intact)")
        checks_passed += 1
    else:
        log(f"  ❌ File content check failed: {result.get('error') or result.get('output')}")

    # ================================================================
    # PHASE 7: Cleanup
    # ================================================================
    log("")
    log("PHASE 7: Cleanup...")
    requests.post(f"{PROXY_URL}/terminate/{restore_microvm_id}")
    log("  Terminated restore MicroVM")

    # ================================================================
    # REPORT
    # ================================================================
    print()
    print("=" * 60)
    print("  END-TO-END TEST REPORT")
    print("=" * 60)
    print()
    print(f"  Result: {'✅ PASSED' if checks_passed == checks_total else '❌ PARTIAL FAILURE'}")
    print(f"  Checks: {checks_passed}/{checks_total} passed")
    print()
    print("  ── Timings ─────────────────────────────────────────────")
    print(f"  Launch MicroVM:          {timings.get('launch', 0):.1f}s")
    print(f"  Wait for RUNNING:        {timings.get('wait_running', 0):.1f}s")
    print(f"  Terminate (request):     {timings.get('terminate_request', 0):.1f}s")
    print(f"  Wait for TERMINATED:     {timings.get('wait_terminated', 0):.1f}s")
    print(f"  List sessions (S3):      {timings.get('list_sessions', 0):.1f}s")
    print(f"  Launch + Restore:        {timings.get('launch_restore', 0):.1f}s")
    print(f"  Wait for RUNNING (rest): {timings.get('wait_running_restore', 0):.1f}s")
    print()
    total_checkpoint = timings.get('terminate_request', 0) + timings.get('wait_terminated', 0)
    total_restore = timings.get('launch_restore', 0) + timings.get('wait_running_restore', 0) + 10  # +10s for hook
    print(f"  ── Summary ─────────────────────────────────────────────")
    print(f"  Total checkpoint time:   {total_checkpoint:.1f}s")
    print(f"  Total restore time:      {total_restore:.1f}s")
    print(f"  Session ID:              {restore_session_id}")
    print(f"  Checkpoint MicroVM:      {microvm_id}")
    print(f"  Restore MicroVM:         {restore_microvm_id}")
    print()
    print("=" * 60)


if __name__ == "__main__":
    main()
