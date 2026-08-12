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


def execute_code(session_id, code, timeout=60):
    """Execute code on the MicroVM via the proxy using session_id only."""
    resp = requests.post(
        f"{PROXY_URL}/proxy/execute",
        headers={
            "Content-Type": "application/json",
            "X-Session-Id": session_id,
        },
        json={"code": code},
        timeout=timeout,
    )
    return resp.json()


def main():
    print("=" * 60)
    print("  MicroVM Session Checkpoint & Restore — E2E Test")
    print("=" * 60)
    print()

    timings = {}

    # ================================================================
    # PHASE 0: Baseline — Launch a bare VM (no checkpoint, no restore)
    # ================================================================
    log("PHASE 0: Baseline — launching bare VM (no checkpoint, no restore)...")

    with timed("Bare VM launch") as t:
        resp = requests.post(f"{PROXY_URL}/launch", json={
            "name": "baseline-timing",
            "memoryMiB": MEMORY_MIB,
            "idleTimeoutSeconds": 60,
            "checkpointEnabled": False,
        })
        baseline_data = resp.json()
        assert "microvmId" in baseline_data, f"Baseline launch failed: {baseline_data}"
        baseline_vm_id = baseline_data["microvmId"]
        baseline_session_id = baseline_data.get("sessionId", "")
    timings["bare_launch"] = t.elapsed

    # Quick health check to confirm it's responsive
    with timed("Bare VM first response") as t:
        headers = {"X-Session-Id": baseline_session_id}
        for _ in range(10):
            try:
                r = requests.get(f"{PROXY_URL}/proxy/health", headers=headers, timeout=5)
                if r.ok:
                    break
            except:
                pass
            time.sleep(1)
    timings["bare_first_response"] = t.elapsed

    log(f"  Bare VM: {baseline_vm_id}")
    log(f"  Launch: {timings['bare_launch']:.1f}s, First response: {timings['bare_first_response']:.1f}s")

    # Terminate baseline VM
    requests.post(f"{PROXY_URL}/terminate", headers={"X-Session-Id": baseline_session_id})
    log(f"  Terminated baseline VM")
    log("")

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

    result = execute_code(session_id, """
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
    result = execute_code(session_id, """
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
    result = execute_code(session_id, """
import os
print(f"Variables: x={x}, message='{message[:20]}...', df.shape={df.shape}")
print(f"File exists: {os.path.exists('/tmp/test_products.csv')}")
print(f"File size: {os.path.getsize('/tmp/test_products.csv')} bytes")
""")
    log(f"  State verification: {result.get('output', '').strip()}")

    log(f"  Session ID: {session_id}")
    restore_session_id = session_id

    # ================================================================
    # PHASE 2b: Verify data catalog discovered the local file
    # ================================================================
    log("")
    log("PHASE 2b: Triggering local file catalog refresh + verify...")
    # Trigger refresh so the catalog picks up the new file
    try:
        requests.post(f"{PROXY_URL}/proxy/data-catalog/refresh-local", headers={"X-Session-Id": session_id}, timeout=5)
    except Exception:
        pass
    time.sleep(3)  # Give background scan time
    try:
        catalog_resp = requests.get(f"{PROXY_URL}/datasources/catalog", headers={"X-Session-Id": session_id}, timeout=10)
        if catalog_resp.status_code == 200:
            catalog = catalog_resp.json()
            entries = catalog.get("entries", [])
            local_entries = [e for e in entries if e.get("source_type") == "local"]
            log(f"  Catalog total: {catalog.get('total', 0)} sources, local files: {len(local_entries)}")
            products_entry = next((e for e in local_entries if "test_products" in e.get("source_id", "")), None)
            if products_entry and products_entry.get("status") == "discovered":
                cols = [c["name"] for c in products_entry.get("columns", [])]
                log(f"  \u2705 test_products.csv discovered: columns={cols}")
            else:
                log(f"  \u26a0 test_products.csv not yet discovered (status={products_entry.get('status') if products_entry else 'missing'})")
        else:
            log(f"  \u26a0 Catalog endpoint returned {catalog_resp.status_code}")
    except Exception as e:
        log(f"  \u26a0 Could not check catalog: {e}")

    # ================================================================
    # PHASE 3: Terminate MicroVM (triggers checkpoint)
    # ================================================================
    log("")
    log("PHASE 3: Terminating MicroVM (triggers S3 checkpoint)...")

    with timed("Terminate MicroVM") as t:
        resp = requests.post(f"{PROXY_URL}/terminate", headers={"X-Session-Id": session_id})
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
        resp = requests.get(f"{PROXY_URL}/sessions")
        sessions = resp.json().get("sessions", [])
    timings["list_sessions"] = t.elapsed

    log(f"  Found {len(sessions)} session(s) in S3:")
    for s in sessions:
        log(f"    - {s['session_id']} (vars: {s.get('variables_count', '?')}, files: {s.get('files_count', '?')})")

    our_session = None
    for s in sessions:
        if "test-checkpoint" in s["session_id"]:
            our_session = s
            break

    save_timings_ms = {}
    if our_session:
        log(f"  ✅ Checkpoint found: {our_session['session_id']}")
        log(f"     Variables: {our_session.get('variables_count', '?')}")
        log(f"     Files: {our_session.get('files_count', '?')}")
        log(f"     Checkpointed at: {our_session.get('checkpointed_at', '?')}")
        save_timings_ms = our_session.get('save_timings_ms', {})
        if save_timings_ms:
            log(f"     Save breakdown (inside VM):")
            log(f"       Serialize (dill):     {save_timings_ms.get('serialize', 0):.0f}ms")
            log(f"       Upload checkpoint.pkl:{save_timings_ms.get('upload_pkl', 0):.0f}ms")
            log(f"       Archive files:        {save_timings_ms.get('archive_files', 0):.0f}ms")
            log(f"       pip freeze:           {save_timings_ms.get('packages', 0):.0f}ms")
            log(f"       Upload metadata:      {save_timings_ms.get('metadata', 0):.0f}ms")
            log(f"       TOTAL (inside VM):    {sum(save_timings_ms.values()):.0f}ms")
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
            "checkpointEnabled": False,
            "sessionId": restore_session_id_new,
            "restoreFromSession": restore_session_id,
        })
        restore_data = resp.json()
        assert "microvmId" in restore_data, f"Restore launch failed: {restore_data}"
        restore_microvm_id = restore_data["microvmId"]
    timings["launch_restore"] = t.elapsed

    log(f"  New MicroVM ID: {restore_microvm_id}")

    with timed("Wait for RUNNING (restore)") as t:
        wait_for_running(restore_microvm_id)
    timings["wait_running_restore"] = t.elapsed

    # Measure time until restored VM responds
    with timed("Restore VM first response") as t:
        headers = {"X-Session-Id": restore_session_id_new}
        for _ in range(20):
            try:
                r = requests.get(f"{PROXY_URL}/proxy/health", headers=headers, timeout=5)
                if r.ok:
                    break
            except:
                pass
            time.sleep(1)
    timings["restore_first_response"] = t.elapsed

    # ================================================================
    # PHASE 6: Validate restored state
    # ================================================================
    log("")
    log("PHASE 6: Validating restored state...")

    checks_passed = 0
    checks_total = 0

    # Check variables
    result = execute_code(restore_session_id_new, "print(f'x={x}')")
    checks_total += 1
    if result.get("success") and "x=42" in result.get("output", ""):
        log("  ✅ Variable 'x' restored: x=42")
        checks_passed += 1
    else:
        log(f"  ❌ Variable 'x' NOT restored: {result.get('error') or result.get('output')}")

    result = execute_code(restore_session_id_new, "print(f'message={message}')")
    checks_total += 1
    if result.get("success") and "Hello from checkpoint test" in result.get("output", ""):
        log("  ✅ Variable 'message' restored")
        checks_passed += 1
    else:
        log(f"  ❌ Variable 'message' NOT restored: {result.get('error') or result.get('output')}")

    result = execute_code(restore_session_id_new, "print(f'len(numbers)={len(numbers)}')")
    checks_total += 1
    if result.get("success") and "len(numbers)=100" in result.get("output", ""):
        log("  ✅ Variable 'numbers' restored (100 items)")
        checks_passed += 1
    else:
        log(f"  ❌ Variable 'numbers' NOT restored: {result.get('error') or result.get('output')}")

    # Check DataFrame
    result = execute_code(restore_session_id_new, "print(f'df.shape={df.shape}, columns={list(df.columns)}')")
    checks_total += 1
    if result.get("success") and "(5, 3)" in result.get("output", ""):
        log("  ✅ DataFrame 'df' restored: (5, 3)")
        checks_passed += 1
    else:
        log(f"  ❌ DataFrame 'df' NOT restored: {result.get('error') or result.get('output')}")

    # Check numpy array
    result = execute_code(restore_session_id_new, "print(f'matrix.shape={matrix.shape}')")
    checks_total += 1
    if result.get("success") and "(10, 10)" in result.get("output", ""):
        log("  ✅ Numpy array 'matrix' restored: (10, 10)")
        checks_passed += 1
    else:
        log(f"  ❌ Numpy array 'matrix' NOT restored: {result.get('error') or result.get('output')}")

    # Check local file
    result = execute_code(restore_session_id_new, """
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
    result = execute_code(restore_session_id_new, """
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
    # Check data catalog restored
    checks_total += 1
    try:
        catalog_resp = requests.get(f"{PROXY_URL}/datasources/catalog", headers={"X-Session-Id": restore_session_id_new}, timeout=10)
        if catalog_resp.status_code == 200:
            catalog = catalog_resp.json()
            entries = catalog.get("entries", [])
            local_entries = [e for e in entries if e.get("source_type") == "local"]
            products_entry = next((e for e in local_entries if "test_products" in e.get("source_id", "")), None)
            if products_entry and products_entry.get("columns"):
                cols = [c["name"] for c in products_entry.get("columns", [])]
                log(f"  \u2705 Data catalog restored: test_products.csv columns={cols}")
                checks_passed += 1
            else:
                log(f"  \u274c Data catalog NOT restored (test_products.csv missing or no columns)")
        else:
            log(f"  \u274c Catalog endpoint returned {catalog_resp.status_code}")
    except Exception as e:
        log(f"  \u274c Data catalog check failed: {e}")
    print()
    # PHASE 6b: Fetch internal checkpoint timings from the restored VM
    # ================================================================
    log("")
    log("PHASE 6b: Fetching checkpoint timing breakdown from VM...")
    checkpoint_timings = {}
    try:
        headers = {"X-Session-Id": restore_session_id_new}
        resp = requests.get(f"{PROXY_URL}/proxy/checkpoint-timings", headers=headers, timeout=10)
        if resp.ok:
            checkpoint_timings = resp.json()
            if checkpoint_timings.get("last_restore"):
                rt = checkpoint_timings["last_restore"]
                log(f"  Restore breakdown (inside VM):")
                log(f"    Download checkpoint.pkl: {rt.get('download_pkl', 0):.0f}ms")
                log(f"    Deserialize (dill):      {rt.get('deserialize', 0):.0f}ms")
                log(f"    Download files.tar.gz:   {rt.get('download_files', 0):.0f}ms")
                log(f"    Extract files:           {rt.get('extract_files', 0):.0f}ms")
                log(f"    Install packages:        {rt.get('packages', 0):.0f}ms")
                log(f"    Total (inside VM):       {rt.get('total_ms', 0):.0f}ms")
            else:
                log("  No restore timings available (endpoint returned empty)")
    except Exception as e:
        log(f"  Could not fetch timings: {e}")

    # ================================================================
    # PHASE 7: Cleanup — terminate ALL test VMs
    # ================================================================
    log("")
    log("PHASE 7: Cleanup...")
    for sid in [baseline_session_id, session_id, restore_session_id_new]:
        try:
            requests.post(f"{PROXY_URL}/terminate", headers={"X-Session-Id": sid}, timeout=5)
            log(f"  Terminated session {sid[:20]}...")
        except:
            pass
    log("  All test VMs cleaned up")

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
    print(f"  Bare VM launch (baseline):  {timings.get('bare_launch', 0):.1f}s")
    print(f"  Bare VM first response:     {timings.get('bare_first_response', 0):.1f}s")
    print(f"  Launch (with checkpoint):   {timings.get('launch', 0):.1f}s")
    print(f"  Wait for RUNNING:           {timings.get('wait_running', 0):.1f}s")
    print(f"  Terminate (request):        {timings.get('terminate_request', 0):.1f}s")
    print(f"  Wait for TERMINATED:        {timings.get('wait_terminated', 0):.1f}s")
    print(f"  List sessions (S3):         {timings.get('list_sessions', 0):.1f}s")
    print(f"  Launch + Restore:           {timings.get('launch_restore', 0):.1f}s")
    print(f"  Wait for RUNNING (restore): {timings.get('wait_running_restore', 0):.1f}s")
    print(f"  Restore VM first response:  {timings.get('restore_first_response', 0):.1f}s")
    print()
    total_checkpoint = timings.get('terminate_request', 0) + timings.get('wait_terminated', 0)
    total_restore = timings.get('launch_restore', 0) + timings.get('wait_running_restore', 0) + timings.get('restore_first_response', 0)
    bare_total = timings.get('bare_launch', 0) + timings.get('bare_first_response', 0)
    restore_overhead = total_restore - bare_total
    print(f"  ── Summary ─────────────────────────────────────────────")
    print(f"  Bare VM (no restore):    {bare_total:.1f}s")
    print(f"  Total checkpoint time:   {total_checkpoint:.1f}s (serialize + S3 upload)")
    print(f"  Total restore time:      {total_restore:.1f}s (launch + S3 download + deserialize)")
    print(f"  Restore overhead (Δ):    {restore_overhead:.1f}s (time added by S3 restore vs bare launch)")
    print(f"  Session ID:              {restore_session_id}")
    print(f"  Checkpoint MicroVM:      {microvm_id}")
    print(f"  Restore MicroVM:         {restore_microvm_id}")
    print()
    print(f"  ── Interpretation ──────────────────────────────────────")
    if restore_overhead < 2:
        print(f"  S3 restore adds <2s overhead — negligible vs VM provisioning")
    elif restore_overhead < 5:
        print(f"  S3 restore adds ~{restore_overhead:.0f}s — moderate (mostly S3 download + deserialize)")
    else:
        print(f"  S3 restore adds ~{restore_overhead:.0f}s — significant (consider EFS for large checkpoints)")

    if checkpoint_timings.get("last_restore"):
        rt = checkpoint_timings["last_restore"]
        print()
        print(f"  ── Checkpoint Internals (inside VM) ────────────────────")
        if save_timings_ms:
            print(f"  SAVE (backup):")
            print(f"    Serialize (dill):      {save_timings_ms.get('serialize', 0):.0f}ms")
            print(f"    S3 upload (pkl):       {save_timings_ms.get('upload_pkl', 0):.0f}ms")
            print(f"    Archive + upload files: {save_timings_ms.get('archive_files', 0):.0f}ms")
            print(f"    pip freeze:            {save_timings_ms.get('packages', 0):.0f}ms")
            print(f"    Upload metadata:       {save_timings_ms.get('metadata', 0):.0f}ms")
            print(f"    TOTAL (inside VM):     {sum(save_timings_ms.values()):.0f}ms")
            print()
        print(f"  RESTORE:")
        print(f"    S3 download (pkl):     {rt.get('download_pkl', 0):.0f}ms")
        print(f"    Deserialize (dill):    {rt.get('deserialize', 0):.0f}ms")
        print(f"    S3 download (files):   {rt.get('download_files', 0):.0f}ms")
        print(f"    Extract files:         {rt.get('extract_files', 0):.0f}ms")
        print(f"    pip install packages:  {rt.get('packages', 0):.0f}ms")
        print(f"    TOTAL (inside VM):     {rt.get('total_ms', 0):.0f}ms")
    print()
    print("=" * 60)


if __name__ == "__main__":
    main()
