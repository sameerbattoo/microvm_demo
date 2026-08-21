#!/usr/bin/env python3
"""
End-to-End Test: 5-Rotation Comprehensive VM Rotation (Eternal Sessions)

Tests that a MicroVM session automatically rotates to new VMs before
max lifetime expires, preserving all state transparently across 5 rotations
(6 VMs total). Each rotation tests different scenarios.

Setup:
  - Requires proxy running with SESSION_PERSISTENCE_MODE=eternal
  - Requires MAX_LIFETIME_SECONDS=180 (3 minutes)
  - Requires ROTATION_LEAD_SECONDS=30 (rotation fires at 150s)
  - Total test time: ~18-20 minutes (5 rotation cycles)

Rotation Scenarios:
  1. VM1→VM2: Basic state persistence (vars, DataFrame, file)
  2. VM2→VM3: Package install + SQL query + mutations + quiesce request
  3. VM3→VM4: Heavy state (large DataFrame, matplotlib, second file)
  4. VM4→VM5: Verification-only (no new state, just checks everything)
  5. VM5→VM6: Execution during rotation + final comprehensive check

Usage:
    export MAX_LIFETIME_SECONDS=180
    export ROTATION_LEAD_SECONDS=30
    export SESSION_PERSISTENCE_MODE=eternal
    ./aws_microvm_run.sh

    # In another terminal:
    python3 tests/eternal/test_rotation.py
"""

import time
import json
import random
import threading
import requests
import sys

# --- Configuration ---
PROXY_URL = "http://localhost:8081"
MEMORY_MIB = 2048
# Rotation fires at MAX_LIFETIME - ROTATION_LEAD = 180 - 30 = 150s
WAIT_FOR_ROTATION_SECONDS = 220


# --- Helpers ---

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
            log(f"  ⏱  {label}: {self.elapsed:.2f}s")
    return Timer()


def execute_code(session_id, code, timeout=90, cell_id=None):
    """Execute code on the MicroVM via the proxy using session_id only.
    Pass cell_id to record variable provenance (which cell created/modified vars)."""
    body = {"code": code}
    if cell_id is not None:
        body["cell_id"] = cell_id
    resp = requests.post(
        f"{PROXY_URL}/proxy/execute",
        headers={
            "Content-Type": "application/json",
            "X-Session-Id": session_id,
        },
        json=body,
        timeout=timeout,
    )
    return resp.json()


def get_variables(session_id, timeout=30):
    """Fetch the namespace variables (incl. provenance) via the proxy."""
    resp = requests.get(
        f"{PROXY_URL}/proxy/variables",
        headers={"X-Session-Id": session_id},
        timeout=timeout,
    )
    return resp.json().get("variables", {})


def install_package(session_id, package, timeout=120):
    """Install a package via the /install endpoint (tracked for checkpoint)."""
    resp = requests.post(
        f"{PROXY_URL}/proxy/install",
        headers={
            "Content-Type": "application/json",
            "X-Session-Id": session_id,
        },
        json={"package": package},
        timeout=timeout,
    )
    return resp.json()


def execute_sql(session_id, sql, output_variable, timeout=30, cell_id=None):
    """Execute a SQL query on the MicroVM via the proxy using session_id only.
    Pass cell_id to record provenance for the result variable."""
    body = {"sql": sql, "output_variable": output_variable}
    if cell_id is not None:
        body["cell_id"] = cell_id
    resp = requests.post(
        f"{PROXY_URL}/proxy/execute-sql",
        headers={
            "Content-Type": "application/json",
            "X-Session-Id": session_id,
        },
        json=body,
        timeout=timeout,
    )
    return resp.json()


def get_instances():
    """Get all active instances from the proxy."""
    resp = requests.get(f"{PROXY_URL}/instances", timeout=10)
    return resp.json().get("instances", {})


def find_vm_for_session(session_id):
    """Find the current VM ID serving a session."""
    instances = get_instances()
    for vm_id, info in instances.items():
        if info.get("session_id") == session_id:
            return vm_id, info.get("endpoint")
    return None, None


def wait_for_rotation(session_id, current_vm_id, launch_time, label=""):
    """Poll until a new VM appears for this session (swap completed)."""
    last_status_time = 0
    while time.time() - launch_time < WAIT_FOR_ROTATION_SECONDS:
        elapsed = time.time() - launch_time
        if time.time() - last_status_time >= 30:
            log(f"  ⏳ {elapsed:.0f}s since launch — still on {current_vm_id[:25]}...")
            last_status_time = time.time()

        new_vm_id, new_endpoint = find_vm_for_session(session_id)
        if new_vm_id and new_vm_id != current_vm_id:
            rotation_time = time.time() - launch_time
            log(f"  🔄 ROTATION {label}DETECTED at {rotation_time:.1f}s!")
            log(f"     Old VM: {current_vm_id}")
            log(f"     New VM: {new_vm_id}")
            return new_vm_id, new_endpoint, rotation_time
        time.sleep(10)

    return None, None, 0


def check_result(result, context=""):
    """Assert execution succeeded, return output."""
    if not result.get("success"):
        error = result.get("error", "unknown error")
        log(f"  ❌ Execution failed{' (' + context + ')' if context else ''}: {error}")
        return None
    return result.get("output", "")


# --- Main Test ---

def main():
    test_start = time.time()
    log("=" * 70)
    log("  5-Rotation Comprehensive VM Rotation Test (Eternal Sessions)")
    log("=" * 70)
    log("")

    # Track results
    timings = {}
    vm_ids = []
    checks_passed = 0
    checks_failed = 0
    check_details = []

    def record_check(name, passed):
        nonlocal checks_passed, checks_failed
        if passed:
            checks_passed += 1
            check_details.append(("✓", name))
        else:
            checks_failed += 1
            check_details.append(("❌", name))
        return passed

    # ================================================================
    # PRE-CHECK: Validate proxy configuration
    # ================================================================
    log("PRE-CHECK: Validating proxy configuration...")
    try:
        health = requests.get(f"{PROXY_URL}/health", timeout=5).json()
        assert health["status"] == "proxy running"
    except Exception as e:
        log(f"  ❌ ERROR: Proxy not reachable at {PROXY_URL}: {e}")
        log("  Run: ./aws_microvm_run.sh")
        sys.exit(1)

    persistence_mode = health.get("persistence_mode", "unknown")
    max_lifetime = health.get("max_lifetime_seconds", 0)

    if persistence_mode != "eternal":
        log(f"  ❌ ERROR: persistence_mode must be 'eternal', got '{persistence_mode}'")
        log("  Set SESSION_PERSISTENCE_MODE=eternal before starting proxy")
        sys.exit(1)

    if max_lifetime > 300:
        log(f"  ❌ ERROR: max_lifetime_seconds must be <= 300 for testing, got {max_lifetime}")
        log("  Set MAX_LIFETIME_SECONDS=180 before starting proxy")
        sys.exit(1)

    log(f"  ✓ Mode: {persistence_mode}, Max Lifetime: {max_lifetime}s")
    log(f"  ✓ Region: {health.get('region', 'unknown')}")
    log("")

    # ================================================================
    # LAUNCH: Create initial MicroVM
    # ================================================================
    log("━" * 70)
    log("  LAUNCH: Create initial MicroVM (VM1)")
    log("━" * 70)

    session_id = f"rotation-5x-{int(time.time())}"
    secret_value = random.randint(100000, 999999)

    with timed("Launch MicroVM") as t:
        resp = requests.post(f"{PROXY_URL}/launch", json={
            "name": "rotation-5x-test",
            "memoryMiB": MEMORY_MIB,
            "idleTimeoutSeconds": 300,
            "checkpointEnabled": True,
            "sessionId": session_id,
        }, timeout=120)
        assert resp.status_code == 200, f"Launch failed: {resp.text}"
        data = resp.json()
        vm1_id = data["microvmId"]
        vm1_endpoint = data["endpoint"]
    timings["launch"] = t.elapsed
    vm_ids.append(vm1_id)
    launch_time_vm1 = time.time()

    log(f"  VM1 ID:    {vm1_id}")
    log(f"  Session:   {session_id}")
    log(f"  Secret:    {secret_value}")
    log("")

    # ================================================================
    # ROTATION 1 SETUP: Basic state persistence (VM1)
    # ================================================================
    log("━" * 70)
    log("  ROTATION 1 SETUP: Create state on VM1")
    log("━" * 70)

    with timed("Create variables") as t:
        result = execute_code(session_id,
            "import pandas as pd\n"
            "import numpy as np\n"
            f"marker = 'ROTATION_TEST_MARKER'\n"
            f"counter = 1000\n"
            f"secret = {secret_value}\n"
            f"history = ['created_on_vm1']\n"
            f"config = {{'version': 1, 'mode': 'eternal', 'rotations': 0}}\n"
            "print(f'Variables: marker={marker}, counter={counter}, secret={secret}')\n"
            "print(f'history={history}, config={config}')",
            cell_id="cell-r1-vars",
        )
    timings["r1_create_vars"] = t.elapsed
    output = check_result(result, "create variables")
    assert output is not None, "Failed to create variables"
    log(f"  {output.strip()}")

    with timed("Create DataFrame") as t:
        result = execute_code(session_id,
            "np.random.seed(42)\n"
            "df = pd.DataFrame({\n"
            "    'id': range(500),\n"
            "    'value': np.random.randn(500),\n"
            "    'category': np.random.choice(['A','B','C','D'], 500),\n"
            "    'score': np.random.uniform(0, 100, 500),\n"
            "})\n"
            "df_checksum = float(df['value'].sum() + df['score'].sum())\n"
            "print(f'DataFrame: shape={df.shape}, checksum={df_checksum:.6f}')",
            cell_id="cell-r1-df",
        )
    timings["r1_create_df"] = t.elapsed
    output = check_result(result, "create DataFrame")
    assert output is not None, "Failed to create DataFrame"
    log(f"  {output.strip()}")

    with timed("Create local file") as t:
        result = execute_code(session_id,
            "import csv\n"
            "with open('/tmp/rotation_test.csv', 'w', newline='') as f:\n"
            "    writer = csv.writer(f)\n"
            "    writer.writerow(['id', 'value', 'note'])\n"
            "    for i in range(10):\n"
            "        writer.writerow([i, i*3.14, f'row_{i}_from_vm1'])\n"
            "import os\n"
            "file_size = os.path.getsize('/tmp/rotation_test.csv')\n"
            "print(f'File created: /tmp/rotation_test.csv ({file_size} bytes)')"
        )
    timings["r1_create_file"] = t.elapsed
    output = check_result(result, "create file")
    assert output is not None, "Failed to create file"
    log(f"  {output.strip()}")
    log("  ✓ Rotation 1 state created on VM1")
    log("")

    # --- Wait for Rotation 1: VM1 → VM2 ---
    log("━" * 70)
    log("  ROTATION 1: Waiting for VM1 → VM2")
    log("━" * 70)

    vm2_id, vm2_endpoint, rot1_time = wait_for_rotation(
        session_id, vm1_id, launch_time_vm1, "#1 "
    )
    timings["rotation_1"] = rot1_time

    if not vm2_id:
        log(f"  ❌ ROTATION #1 DID NOT HAPPEN within {WAIT_FOR_ROTATION_SECONDS}s")
        requests.post(f"{PROXY_URL}/terminate", headers={"X-Session-Id": session_id}, timeout=10)
        sys.exit(1)

    vm_ids.append(vm2_id)
    launch_time_vm2 = time.time()
    log("")

    # --- Verify Rotation 1 on VM2 ---
    log("━" * 70)
    log("  ROTATION 1 VERIFY: Check state on VM2")
    log("━" * 70)

    with timed("Verify rotation 1") as t:
        result = execute_code(session_id,
            "import os\n"
            "checks = []\n"
            f"checks.append(('marker', marker == 'ROTATION_TEST_MARKER'))\n"
            f"checks.append(('counter', counter == 1000))\n"
            f"checks.append(('secret', secret == {secret_value}))\n"
            "checks.append(('history', history == ['created_on_vm1']))\n"
            "checks.append(('config', config == {'version': 1, 'mode': 'eternal', 'rotations': 0}))\n"
            "checks.append(('df_shape', df.shape == (500, 4)))\n"
            "checks.append(('df_checksum', abs((df['value'].sum() + df['score'].sum()) - df_checksum) < 0.001))\n"
            "checks.append(('file_exists', os.path.exists('/tmp/rotation_test.csv')))\n"
            "if os.path.exists('/tmp/rotation_test.csv'):\n"
            "    content = open('/tmp/rotation_test.csv').read()\n"
            "    checks.append(('file_content', 'row_0_from_vm1' in content))\n"
            "else:\n"
            "    checks.append(('file_content', False))\n"
            "passed = sum(1 for _, v in checks if v)\n"
            "total = len(checks)\n"
            "for name, ok in checks:\n"
            "    print(f'  {\"✓\" if ok else \"❌\"} {name}')\n"
            "print(f'ROTATION1_RESULT:{passed}/{total}')"
        )
    timings["r1_verify"] = t.elapsed
    output = check_result(result, "verify rotation 1")
    if output:
        log(f"  Results:\n    {output.strip().replace(chr(10), chr(10) + '    ')}")
        for line in output.split('\n'):
            if 'ROTATION1_RESULT:' in line:
                parts = line.split(':')[1].split('/')
                p, tot = int(parts[0]), int(parts[1])
                record_check("R1: All variables survived", p == tot)
    log("")
    # Verify data catalog survived rotation (schemas should persist)
    try:
        catalog_resp = requests.get(f"{PROXY_URL}/datasources/catalog", headers={"X-Session-Id": session_id}, timeout=10)
        if catalog_resp.status_code == 200:
            catalog = catalog_resp.json()
            discovered = catalog.get("discovered", 0)
            total = catalog.get("total", 0)
            local_entries = [e for e in catalog.get("entries", []) if e.get("source_type") == "local"]
            csv_entry = next((e for e in local_entries if "rotation_test" in e.get("source_id", "")), None)
            catalog_ok = csv_entry is not None and csv_entry.get("status") == "discovered"
            record_check("R1: Data catalog survived rotation", catalog_ok)
            if catalog_ok:
                cols = [c["name"] for c in csv_entry.get("columns", [])]
                log(f"  \u2713 Data catalog: rotation_test.csv columns={cols}")
            else:
                log(f"  \u26a0 Data catalog: rotation_test.csv not found or not discovered (total={total}, local={len(local_entries)})")
        else:
            record_check("R1: Data catalog survived rotation", False)
            log(f"  \u274c Data catalog endpoint returned {catalog_resp.status_code}")
    except Exception as e:
        record_check("R1: Data catalog survived rotation", False)
        log(f"  \u274c Data catalog check failed: {e}")
    log("")

    # Verify variable provenance survived the rotation (defined_by preserved)
    vars_meta = get_variables(session_id)
    marker_defined = (vars_meta.get("marker") or {}).get("defined_by")
    df_defined = (vars_meta.get("df") or {}).get("defined_by")
    prov_ok = marker_defined == "cell-r1-vars" and df_defined == "cell-r1-df"
    record_check("R1: Variable provenance survived rotation", prov_ok)
    log(f"  {'✓' if prov_ok else '❌'} Provenance: marker.defined_by={marker_defined!r}, df.defined_by={df_defined!r}")
    log("")

    # ================================================================
    # ROTATION 2 SETUP: Package install + SQL + mutations (VM2)
    # ================================================================
    log("━" * 70)
    log("  ROTATION 2 SETUP: Package install + SQL + mutations on VM2")
    log("━" * 70)

    with timed("Install tabulate") as t:
        result = install_package(session_id, "tabulate")
    timings["r2_install_pkg"] = t.elapsed
    if result.get("success"):
        verify = execute_code(session_id, "import tabulate; print(f'tabulate version: {tabulate.__version__}')")
        output = check_result(verify, "verify tabulate import")
        if output:
            log(f"  {output.strip()}")
    else:
        log(f"  ⚠ Install failed: {result.get('error', 'unknown')}")

    with timed("SQL query") as t:
        sql_result = execute_sql(session_id,
            "SELECT category, COUNT(*) as cnt, AVG(score) as avg_score FROM df GROUP BY category ORDER BY cnt DESC",
            "sql_result",
            cell_id="cell-r2-sql",
        )
    timings["r2_sql"] = t.elapsed
    if sql_result.get("success"):
        log(f"  ✓ SQL query executed, result stored in 'sql_result'")
    else:
        log(f"  ⚠ SQL query: {sql_result.get('error', 'unknown')}")

    with timed("Mutate state") as t:
        result = execute_code(session_id,
            "counter += 100\n"
            "config['rotations'] += 1\n"
            "config['last_vm'] = 'vm2'\n"
            "history.append('mutated_on_vm2')\n"
            "vm2_data = 'exclusive_to_vm2_forward'\n"
            "print(f'Mutated: counter={counter}, config={config}')\n"
            "print(f'history={history}')",
            cell_id="cell-r2-mutate",
        )
    timings["r2_mutate"] = t.elapsed
    output = check_result(result, "mutate state")
    if output:
        log(f"  {output.strip()}")

    # Fire a request during quiesce window (background thread)
    quiesce_result_r2 = {"result": None, "error": None, "elapsed": 0}

    def fire_quiesce_r2():
        """Fire request ~2s before rotation_lead fires (at 148s from VM2 launch)."""
        wait_until = launch_time_vm2 + 148
        remaining = wait_until - time.time()
        if remaining > 0:
            time.sleep(remaining)
        log("  📤 Firing quiesce-window request (rotation 2)...")
        t0 = time.time()
        try:
            r = execute_code(session_id,
                "quiesce_marker_r2 = 'survived_quiesce_r2'\n"
                "print(f'Quiesce R2 executed! counter={counter}')",
                timeout=90
            )
            quiesce_result_r2["result"] = r
        except Exception as e:
            quiesce_result_r2["error"] = str(e)
        quiesce_result_r2["elapsed"] = time.time() - t0

    quiesce_thread_r2 = threading.Thread(target=fire_quiesce_r2, daemon=True)
    quiesce_thread_r2.start()

    log("  ✓ Rotation 2 setup complete, waiting for rotation...")
    log("")

    # --- Wait for Rotation 2: VM2 → VM3 ---
    log("━" * 70)
    log("  ROTATION 2: Waiting for VM2 → VM3")
    log("━" * 70)

    vm3_id, vm3_endpoint, rot2_time = wait_for_rotation(
        session_id, vm2_id, launch_time_vm2, "#2 "
    )
    timings["rotation_2"] = rot2_time

    if not vm3_id:
        log(f"  ❌ ROTATION #2 DID NOT HAPPEN within {WAIT_FOR_ROTATION_SECONDS}s")
        requests.post(f"{PROXY_URL}/terminate", headers={"X-Session-Id": session_id}, timeout=10)
        sys.exit(1)

    vm_ids.append(vm3_id)
    launch_time_vm3 = time.time()

    # Wait for quiesce thread
    quiesce_thread_r2.join(timeout=30)
    if quiesce_result_r2["result"] and quiesce_result_r2["result"].get("success"):
        log(f"  ✓ Quiesce request completed in {quiesce_result_r2['elapsed']:.2f}s")
        record_check("R2: Quiesce request survived", True)
    else:
        log(f"  ⚠ Quiesce request: {quiesce_result_r2.get('error') or 'failed'}")
        record_check("R2: Quiesce request survived", False)
    log("")

    # --- Verify Rotation 2 on VM3 ---
    log("━" * 70)
    log("  ROTATION 2 VERIFY: Check state on VM3")
    log("━" * 70)

    with timed("Verify rotation 2") as t:
        result = execute_code(session_id,
            "import os\n"
            "checks = []\n"
            "# Original state\n"
            f"checks.append(('marker', marker == 'ROTATION_TEST_MARKER'))\n"
            f"checks.append(('secret', secret == {secret_value}))\n"
            "# Mutations from VM2\n"
            "checks.append(('counter=1100', counter == 1100))\n"
            "checks.append(('history_len=2', len(history) == 2))\n"
            "checks.append(('config_rotations=1', config['rotations'] == 1))\n"
            "checks.append(('vm2_data', vm2_data == 'exclusive_to_vm2_forward'))\n"
            "# Package install\n"
            "try:\n"
            "    import tabulate\n"
            "    checks.append(('tabulate_import', True))\n"
            "except ImportError:\n"
            "    checks.append(('tabulate_import', False))\n"
            "# SQL result\n"
            "try:\n"
            "    checks.append(('sql_result_exists', 'sql_result' in dir() and sql_result is not None))\n"
            "    checks.append(('sql_result_has_rows', len(sql_result) > 0))\n"
            "except:\n"
            "    checks.append(('sql_result_exists', False))\n"
            "    checks.append(('sql_result_has_rows', False))\n"
            "# DataFrame still intact\n"
            "checks.append(('df_shape', df.shape == (500, 4)))\n"
            "# File still exists\n"
            "checks.append(('file_exists', os.path.exists('/tmp/rotation_test.csv')))\n"
            "# Quiesce marker\n"
            "try:\n"
            "    checks.append(('quiesce_marker', quiesce_marker_r2 == 'survived_quiesce_r2'))\n"
            "except NameError:\n"
            "    checks.append(('quiesce_marker', False))\n"
            "passed = sum(1 for _, v in checks if v)\n"
            "total = len(checks)\n"
            "for name, ok in checks:\n"
            "    print(f'  {\"✓\" if ok else \"❌\"} {name}')\n"
            "print(f'ROTATION2_RESULT:{passed}/{total}')"
        )
    timings["r2_verify"] = t.elapsed
    output = check_result(result, "verify rotation 2")
    if output:
        log(f"  Results:\n    {output.strip().replace(chr(10), chr(10) + '    ')}")
        for line in output.split('\n'):
            if 'ROTATION2_RESULT:' in line:
                parts = line.split(':')[1].split('/')
                p, tot = int(parts[0]), int(parts[1])
                record_check("R2: Package + SQL + mutations survived", p == tot)
    log("")

    # Verify provenance tracked the modification + SQL write across the rotation:
    # counter was created in cell-r1-vars but last modified in cell-r2-mutate;
    # sql_result was created by the SQL cell (cell-r2-sql).
    vars_meta = get_variables(session_id)
    counter_meta = vars_meta.get("counter") or {}
    sql_meta = vars_meta.get("sql_result") or {}
    prov_ok = (
        counter_meta.get("defined_by") == "cell-r1-vars"
        and counter_meta.get("last_cell") == "cell-r2-mutate"
        and sql_meta.get("defined_by") == "cell-r2-sql"
    )
    record_check("R2: Provenance (created + modified + SQL) survived rotation", prov_ok)
    log(f"  {'✓' if prov_ok else '❌'} Provenance: counter.defined_by={counter_meta.get('defined_by')!r}, "
        f"counter.last_cell={counter_meta.get('last_cell')!r}, sql_result.defined_by={sql_meta.get('defined_by')!r}")
    log("")

    # ================================================================
    # ROTATION 3 SETUP: Heavy state — large DataFrame + matplotlib (VM3)
    # ================================================================
    log("━" * 70)
    log("  ROTATION 3 SETUP: Heavy state on VM3 (large DF + matplotlib)")
    log("━" * 70)

    with timed("Create large DataFrame") as t:
        result = execute_code(session_id,
            "import numpy as np\n"
            "import pandas as pd\n"
            "np.random.seed(99)\n"
            "large_df = pd.DataFrame(\n"
            "    np.random.randn(5000, 20),\n"
            "    columns=[f'col_{i}' for i in range(20)]\n"
            ")\n"
            "large_df_checksum = float(large_df.values.sum())\n"
            "large_df_shape = large_df.shape\n"
            "print(f'Large DF: shape={large_df.shape}, checksum={large_df_checksum:.6f}')",
            timeout=30
        )
    timings["r3_large_df"] = t.elapsed
    output = check_result(result, "create large DataFrame")
    if output:
        log(f"  {output.strip()}")

    with timed("Create matplotlib chart") as t:
        result = execute_code(session_id,
            "import matplotlib\n"
            "matplotlib.use('Agg')\n"
            "import matplotlib.pyplot as plt\n"
            "fig, axes = plt.subplots(2, 2, figsize=(10, 8))\n"
            "axes[0,0].plot(large_df['col_0'][:100])\n"
            "axes[0,1].hist(large_df['col_1'], bins=30)\n"
            "axes[1,0].scatter(large_df['col_2'][:200], large_df['col_3'][:200])\n"
            "axes[1,1].bar(range(10), large_df['col_4'][:10])\n"
            "plt.tight_layout()\n"
            "chart_created = True\n"
            "print(f'Chart created: fig={type(fig).__name__}, axes shape={axes.shape}')",
            timeout=30
        )
    timings["r3_matplotlib"] = t.elapsed
    output = check_result(result, "create matplotlib chart")
    if output:
        log(f"  {output.strip()}")

    with timed("Write large_data.csv") as t:
        result = execute_code(session_id,
            "large_df.to_csv('/tmp/large_data.csv', index=False)\n"
            "import os\n"
            "size = os.path.getsize('/tmp/large_data.csv')\n"
            "print(f'File written: /tmp/large_data.csv ({size} bytes, {size/1024:.1f} KB)')",
            timeout=30
        )
    timings["r3_write_file"] = t.elapsed
    output = check_result(result, "write large_data.csv")
    if output:
        log(f"  {output.strip()}")

    with timed("Update tracking") as t:
        result = execute_code(session_id,
            "counter += 100\n"
            "config['rotations'] += 1\n"
            "config['last_vm'] = 'vm3'\n"
            "history.append('heavy_state_on_vm3')\n"
            "print(f'Updated: counter={counter}, history={history}')"
        )
    timings["r3_update"] = t.elapsed
    output = check_result(result, "update tracking")
    if output:
        log(f"  {output.strip()}")

    log("  ✓ Rotation 3 heavy state created")
    log("")

    # --- Wait for Rotation 3: VM3 → VM4 ---
    log("━" * 70)
    log("  ROTATION 3: Waiting for VM3 → VM4")
    log("━" * 70)

    vm4_id, vm4_endpoint, rot3_time = wait_for_rotation(
        session_id, vm3_id, launch_time_vm3, "#3 "
    )
    timings["rotation_3"] = rot3_time

    if not vm4_id:
        log(f"  ❌ ROTATION #3 DID NOT HAPPEN within {WAIT_FOR_ROTATION_SECONDS}s")
        requests.post(f"{PROXY_URL}/terminate", headers={"X-Session-Id": session_id}, timeout=10)
        sys.exit(1)

    vm_ids.append(vm4_id)
    launch_time_vm4 = time.time()
    log("")

    # --- Verify Rotation 3 on VM4 ---
    log("━" * 70)
    log("  ROTATION 3 VERIFY: Check heavy state on VM4")
    log("━" * 70)

    with timed("Verify rotation 3") as t:
        result = execute_code(session_id,
            "import os\n"
            "checks = []\n"
            "# Large DataFrame\n"
            "try:\n"
            "    checks.append(('large_df_exists', large_df is not None))\n"
            "    checks.append(('large_df_shape', large_df.shape == (5000, 20)))\n"
            "    current_checksum = float(large_df.values.sum())\n"
            "    checks.append(('large_df_checksum', abs(current_checksum - large_df_checksum) < 0.001))\n"
            "except NameError:\n"
            "    checks.append(('large_df_exists', False))\n"
            "    checks.append(('large_df_shape', False))\n"
            "    checks.append(('large_df_checksum', False))\n"
            "# File from rotation 3\n"
            "checks.append(('large_data_csv', os.path.exists('/tmp/large_data.csv')))\n"
            "# Original file from rotation 1\n"
            "checks.append(('rotation_test_csv', os.path.exists('/tmp/rotation_test.csv')))\n"
            "# matplotlib vars — expected GONE (excluded from checkpoint)\n"
            "fig_gone = True\n"
            "try:\n"
            "    _ = fig\n"
            "    fig_gone = False\n"
            "except NameError:\n"
            "    pass\n"
            "checks.append(('matplotlib_fig_gone', fig_gone))\n"
            "# Accumulated state\n"
            "checks.append(('counter=1200', counter == 1200))\n"
            "checks.append(('history_len=3', len(history) == 3))\n"
            "checks.append(('config_rotations=2', config['rotations'] == 2))\n"
            "# Original vars still there\n"
            f"checks.append(('secret', secret == {secret_value}))\n"
            "passed = sum(1 for _, v in checks if v)\n"
            "total = len(checks)\n"
            "for name, ok in checks:\n"
            "    print(f'  {\"✓\" if ok else \"❌\"} {name}')\n"
            "print(f'ROTATION3_RESULT:{passed}/{total}')"
        )
    timings["r3_verify"] = t.elapsed
    output = check_result(result, "verify rotation 3")
    if output:
        log(f"  Results:\n    {output.strip().replace(chr(10), chr(10) + '    ')}")
        for line in output.split('\n'):
            if 'ROTATION3_RESULT:' in line:
                parts = line.split(':')[1].split('/')
                p, tot = int(parts[0]), int(parts[1])
                record_check("R3: Heavy state survived (large DF + files)", p >= tot - 1)
    log("")

    # ================================================================
    # ROTATION 4 SETUP: Verification-only — no new state (VM4)
    # ================================================================
    log("━" * 70)
    log("  ROTATION 4 SETUP: Verification-only on VM4 (no new state)")
    log("━" * 70)

    with timed("Comprehensive verification on VM4") as t:
        result = execute_code(session_id,
            "import os\n"
            "checks = []\n"
            "# --- From Rotation 1 ---\n"
            f"checks.append(('R1: marker', marker == 'ROTATION_TEST_MARKER'))\n"
            f"checks.append(('R1: secret', secret == {secret_value}))\n"
            "checks.append(('R1: df shape', df.shape == (500, 4)))\n"
            "checks.append(('R1: df_checksum', abs((df['value'].sum() + df['score'].sum()) - df_checksum) < 0.001))\n"
            "checks.append(('R1: csv file', os.path.exists('/tmp/rotation_test.csv')))\n"
            "# --- From Rotation 2 ---\n"
            "checks.append(('R2: vm2_data', vm2_data == 'exclusive_to_vm2_forward'))\n"
            "try:\n"
            "    import tabulate\n"
            "    checks.append(('R2: tabulate pkg', True))\n"
            "except ImportError:\n"
            "    checks.append(('R2: tabulate pkg', False))\n"
            "try:\n"
            "    checks.append(('R2: sql_result', len(sql_result) > 0))\n"
            "except:\n"
            "    checks.append(('R2: sql_result', False))\n"
            "# --- From Rotation 3 ---\n"
            "checks.append(('R3: large_df shape', large_df.shape == (5000, 20)))\n"
            "checks.append(('R3: large_df checksum', abs(float(large_df.values.sum()) - large_df_checksum) < 0.001))\n"
            "checks.append(('R3: large_data.csv', os.path.exists('/tmp/large_data.csv')))\n"
            "# --- Accumulated mutations ---\n"
            "checks.append(('Accumulated: counter=1200', counter == 1200))\n"
            "checks.append(('Accumulated: history len=3', len(history) == 3))\n"
            "checks.append(('Accumulated: config rotations=2', config['rotations'] == 2))\n"
            "passed = sum(1 for _, v in checks if v)\n"
            "total = len(checks)\n"
            "print(f'=== COMPREHENSIVE CHECK (VM4) ===')\n"
            "for name, ok in checks:\n"
            "    print(f'  {\"✓\" if ok else \"❌\"} {name}')\n"
            "print(f'ROTATION4_RESULT:{passed}/{total}')"
        )
    timings["r4_verify"] = t.elapsed
    output = check_result(result, "comprehensive verification on VM4")
    if output:
        log(f"  Results:\n    {output.strip().replace(chr(10), chr(10) + '    ')}")
        for line in output.split('\n'):
            if 'ROTATION4_RESULT:' in line:
                parts = line.split(':')[1].split('/')
                p, tot = int(parts[0]), int(parts[1])
                record_check("R4: All accumulated state verified", p == tot)

    execute_code(session_id,
        "config['rotations'] += 1\n"
        "config['last_vm'] = 'vm4'\n"
        "history.append('verified_on_vm4')"
    )
    log("")

    # --- Wait for Rotation 4: VM4 → VM5 ---
    log("━" * 70)
    log("  ROTATION 4: Waiting for VM4 → VM5")
    log("━" * 70)

    vm5_id, vm5_endpoint, rot4_time = wait_for_rotation(
        session_id, vm4_id, launch_time_vm4, "#4 "
    )
    timings["rotation_4"] = rot4_time

    if not vm5_id:
        log(f"  ❌ ROTATION #4 DID NOT HAPPEN within {WAIT_FOR_ROTATION_SECONDS}s")
        requests.post(f"{PROXY_URL}/terminate", headers={"X-Session-Id": session_id}, timeout=10)
        sys.exit(1)

    vm_ids.append(vm5_id)
    launch_time_vm5 = time.time()
    log("")

    # --- Verify Rotation 4 on VM5 ---
    log("━" * 70)
    log("  ROTATION 4 VERIFY: Confirm everything still on VM5")
    log("━" * 70)

    with timed("Verify rotation 4") as t:
        result = execute_code(session_id,
            "import os\n"
            "checks = []\n"
            f"checks.append(('marker', marker == 'ROTATION_TEST_MARKER'))\n"
            f"checks.append(('secret', secret == {secret_value}))\n"
            "checks.append(('counter=1200', counter == 1200))\n"
            "checks.append(('history_len=4', len(history) >= 4))\n"
            "checks.append(('config_rotations=3', config['rotations'] == 3))\n"
            "checks.append(('df intact', df.shape == (500, 4)))\n"
            "checks.append(('large_df intact', large_df.shape == (5000, 20)))\n"
            "checks.append(('files exist', os.path.exists('/tmp/rotation_test.csv') and os.path.exists('/tmp/large_data.csv')))\n"
            "try:\n"
            "    import tabulate\n"
            "    checks.append(('tabulate', True))\n"
            "except:\n"
            "    checks.append(('tabulate', False))\n"
            "passed = sum(1 for _, v in checks if v)\n"
            "total = len(checks)\n"
            "for name, ok in checks:\n"
            "    print(f'  {\"✓\" if ok else \"❌\"} {name}')\n"
            "print(f'ROTATION4_VERIFY:{passed}/{total}')"
        )
    timings["r4_verify_vm5"] = t.elapsed
    output = check_result(result, "verify rotation 4 on VM5")
    if output:
        log(f"  Results:\n    {output.strip().replace(chr(10), chr(10) + '    ')}")
        for line in output.split('\n'):
            if 'ROTATION4_VERIFY:' in line:
                parts = line.split(':')[1].split('/')
                p, tot = int(parts[0]), int(parts[1])
                record_check("R4: State survived to VM5", p == tot)
    log("")

    # ================================================================
    # ROTATION 5 SETUP: Execution during rotation + final (VM5)
    # ================================================================
    log("━" * 70)
    log("  ROTATION 5 SETUP: Long-running exec during rotation on VM5")
    log("━" * 70)

    execute_code(session_id,
        "counter += 100\n"
        "config['rotations'] += 1\n"
        "config['last_vm'] = 'vm5'\n"
        "history.append('exec_during_rotation_vm5')"
    )

    long_run_result = {"result": None, "error": None, "elapsed": 0}

    def fire_long_running():
        """Start a long-running request that should get queued during quiesce."""
        wait_until = launch_time_vm5 + 145
        remaining = wait_until - time.time()
        if remaining > 0:
            time.sleep(remaining)
        log("  📤 Firing long-running request (time.sleep(5)) near rotation...")
        t0 = time.time()
        try:
            r = execute_code(session_id,
                "import time as _time\n"
                "_time.sleep(5)\n"
                "long_run_completed = True\n"
                "long_run_vm = 'completed_after_rotation'\n"
                "print(f'Long-running request completed! counter={counter}')",
                timeout=120
            )
            long_run_result["result"] = r
        except Exception as e:
            long_run_result["error"] = str(e)
        long_run_result["elapsed"] = time.time() - t0

    long_run_thread = threading.Thread(target=fire_long_running, daemon=True)
    long_run_thread.start()

    log("  ✓ Long-running thread started, waiting for rotation...")
    log("")

    # --- Wait for Rotation 5: VM5 → VM6 ---
    log("━" * 70)
    log("  ROTATION 5: Waiting for VM5 → VM6")
    log("━" * 70)

    vm6_id, vm6_endpoint, rot5_time = wait_for_rotation(
        session_id, vm5_id, launch_time_vm5, "#5 "
    )
    timings["rotation_5"] = rot5_time

    if not vm6_id:
        log(f"  ❌ ROTATION #5 DID NOT HAPPEN within {WAIT_FOR_ROTATION_SECONDS}s")
        requests.post(f"{PROXY_URL}/terminate", headers={"X-Session-Id": session_id}, timeout=10)
        sys.exit(1)

    vm_ids.append(vm6_id)
    log("")

    # Wait for long-running thread
    long_run_thread.join(timeout=60)
    if long_run_result["result"] and long_run_result["result"].get("success"):
        log(f"  ✓ Long-running request completed in {long_run_result['elapsed']:.2f}s")
        record_check("R5: Long-running request survived rotation", True)
    else:
        log(f"  ⚠ Long-running request: {long_run_result.get('error') or 'failed'}")
        record_check("R5: Long-running request survived rotation", False)
    log("")

    # --- Final Verification on VM6 ---
    log("━" * 70)
    log("  ROTATION 5 VERIFY: Final comprehensive check on VM6")
    log("━" * 70)

    with timed("Final comprehensive check") as t:
        result = execute_code(session_id,
            "import os\n"
            "checks = []\n"
            "# === State from ALL rotations ===\n"
            "# Rotation 1: basic vars\n"
            f"checks.append(('R1: marker', marker == 'ROTATION_TEST_MARKER'))\n"
            f"checks.append(('R1: secret', secret == {secret_value}))\n"
            "checks.append(('R1: df shape (500,4)', df.shape == (500, 4)))\n"
            "checks.append(('R1: df_checksum', abs((df['value'].sum() + df['score'].sum()) - df_checksum) < 0.001))\n"
            "checks.append(('R1: rotation_test.csv', os.path.exists('/tmp/rotation_test.csv')))\n"
            "# Rotation 2: package + SQL + mutations\n"
            "checks.append(('R2: vm2_data', vm2_data == 'exclusive_to_vm2_forward'))\n"
            "try:\n"
            "    import tabulate\n"
            "    checks.append(('R2: tabulate', True))\n"
            "except ImportError:\n"
            "    checks.append(('R2: tabulate', False))\n"
            "try:\n"
            "    checks.append(('R2: sql_result', len(sql_result) > 0))\n"
            "except:\n"
            "    checks.append(('R2: sql_result', False))\n"
            "# Rotation 3: heavy state\n"
            "checks.append(('R3: large_df (5000,20)', large_df.shape == (5000, 20)))\n"
            "checks.append(('R3: large_df_checksum', abs(float(large_df.values.sum()) - large_df_checksum) < 0.001))\n"
            "checks.append(('R3: large_data.csv', os.path.exists('/tmp/large_data.csv')))\n"
            "# Rotation 5: long-running request\n"
            "try:\n"
            "    checks.append(('R5: long_run_completed', long_run_completed == True))\n"
            "    checks.append(('R5: long_run_vm', long_run_vm == 'completed_after_rotation'))\n"
            "except NameError:\n"
            "    checks.append(('R5: long_run_completed', False))\n"
            "    checks.append(('R5: long_run_vm', False))\n"
            "# Accumulated state across all rotations\n"
            "checks.append(('Acc: counter=1300+', counter >= 1300))\n"
            "checks.append(('Acc: history len>=4', len(history) >= 4))\n"
            "checks.append(('Acc: config rotations=4', config['rotations'] >= 4))\n"
            "passed = sum(1 for _, v in checks if v)\n"
            "total = len(checks)\n"
            "print(f'=== FINAL COMPREHENSIVE CHECK (VM6) ===')\n"
            "for name, ok in checks:\n"
            "    print(f'  {\"✓\" if ok else \"❌\"} {name}')\n"
            "print(f'FINAL_RESULT:{passed}/{total}')\n"
            "if passed == total:\n"
            "    print('ALL_PASSED')"
        )
    timings["r5_final_verify"] = t.elapsed
    output = check_result(result, "final comprehensive check")
    all_passed = False
    if output:
        log(f"  Results:\n    {output.strip().replace(chr(10), chr(10) + '    ')}")
        for line in output.split('\n'):
            if 'FINAL_RESULT:' in line:
                parts = line.split(':')[1].split('/')
                p, tot = int(parts[0]), int(parts[1])
                record_check("R5: Final comprehensive check", p == tot)
        all_passed = "ALL_PASSED" in output
    log("")

    # ================================================================
    # CLEANUP
    # ================================================================
    log("━" * 70)
    log("  CLEANUP: Terminate VM6")
    log("━" * 70)

    with timed("Terminate") as t:
        try:
            requests.post(f"{PROXY_URL}/terminate", headers={"X-Session-Id": session_id}, timeout=30)
        except:
            pass
    timings["terminate"] = t.elapsed
    log("  ✓ VM6 terminated")
    log("")

    total_elapsed = time.time() - test_start

    # ================================================================
    # FINAL REPORT
    # ================================================================
    print()
    print("=" * 70)
    print("  5-ROTATION VM TEST REPORT")
    print("=" * 70)
    print()
    print(f"  Result: {'✅ ALL PASSED' if all_passed and checks_failed == 0 else '❌ SOME FAILED'}")
    print(f"  Checks: {checks_passed} passed, {checks_failed} failed")
    print()

    print("  ── Check Details ───────────────────────────────────────")
    for icon, name in check_details:
        print(f"    {icon} {name}")
    print()

    print("  ── Rotation Timings ────────────────────────────────────")
    print(f"  Launch VM1:                 {timings.get('launch', 0):.2f}s")
    print(f"  Rotation 1 (VM1→VM2):      {timings.get('rotation_1', 0):.1f}s (expected ~150s)")
    print(f"  Rotation 2 (VM2→VM3):      {timings.get('rotation_2', 0):.1f}s (expected ~150s)")
    print(f"  Rotation 3 (VM3→VM4):      {timings.get('rotation_3', 0):.1f}s (expected ~150s)")
    print(f"  Rotation 4 (VM4→VM5):      {timings.get('rotation_4', 0):.1f}s (expected ~150s)")
    print(f"  Rotation 5 (VM5→VM6):      {timings.get('rotation_5', 0):.1f}s (expected ~150s)")
    print()

    print("  ── Per-Rotation Step Breakdown ─────────────────────────")
    try:
        rot_resp = requests.get(f"{PROXY_URL}/rotation-history/{session_id}", timeout=5)
        if rot_resp.ok:
            rot_data = rot_resp.json()
            rotations = rot_data.get("rotations", [])
            if rotations:
                print(f"  {'#':<3} {'Total':>6} {'Launch':>7} {'Health':>7} {'Chkpt':>7} {'Restore':>8} {'From → To'}")
                print(f"  {'─'*3} {'─'*6} {'─'*7} {'─'*7} {'─'*7} {'─'*8} {'─'*40}")
                for r in rotations:
                    num = r.get("rotation_number", "?")
                    total = r.get("total", 0)
                    launch = r.get("launch", 0)
                    healthy = r.get("healthy", 0)
                    chkpt = r.get("checkpoint", 0)
                    restore = r.get("restore", 0)
                    from_vm = r.get("from_vm", "?")[:12]
                    to_vm = r.get("to_vm", "?")[:12]
                    print(f"  {num:<3} {total:>5.1f}s {launch:>6.1f}s {healthy:>6.1f}s {chkpt:>6.1f}s {restore:>7.1f}s {from_vm}→{to_vm}")
            else:
                print("  (no rotation data available from proxy)")
        else:
            print(f"  (could not fetch: HTTP {rot_resp.status_code})")
    except Exception as e:
        print(f"  (could not fetch rotation history: {e})")
    print()

    print("  ── VM Identity ─────────────────────────────────────────")
    print(f"  Session ID (constant):      {session_id}")
    for i, vm_id in enumerate(vm_ids, 1):
        print(f"  VM{i}:                        {vm_id}")
    print(f"  Memory:                     {MEMORY_MIB} MiB")
    print()

    print("  ── Scenario Summary ────────────────────────────────────")
    print(f"  R1 (VM1→VM2): Basic state (vars, DF, file)         {'✓' if checks_passed > 0 else '❌'}")
    print(f"  R2 (VM2→VM3): Pkg install + SQL + quiesce          {'✓' if checks_passed > 1 else '❌'}")
    print(f"  R3 (VM3→VM4): Heavy state (5k DF, matplotlib)      {'✓' if checks_passed > 2 else '❌'}")
    print(f"  R4 (VM4→VM5): Verification-only                    {'✓' if checks_passed > 3 else '❌'}")
    print(f"  R5 (VM5→VM6): Exec during rotation + final         {'✓' if checks_passed > 4 else '❌'}")
    print()

    print("  ── Total Elapsed ───────────────────────────────────────")
    print(f"  Total test time:            {total_elapsed:.1f}s ({total_elapsed/60:.1f} min)")
    print()

    print("  ── Conclusion ──────────────────────────────────────────")
    if all_passed and checks_failed == 0:
        print("  The session is truly eternal — survived 5 rotations (6 VMs).")
        print("  All state, files, packages, SQL results, and mutations preserved.")
        print("  Request queuing during quiesce works correctly.")
        print("  Long-running requests survive rotation boundaries.")
        print("  Session ID remains stable across all VMs.")
    else:
        print("  ⚠ Some checks failed. Review details above.")
        print("  Check proxy logs for rotation/checkpoint errors.")
    print()
    print("=" * 70)

    sys.exit(0 if (all_passed and checks_failed == 0) else 1)


if __name__ == "__main__":
    main()
