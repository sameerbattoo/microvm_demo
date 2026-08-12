#!/usr/bin/env python3
"""
End-to-End Test: Auto-Checkpoint on Terminate (Checkpoint Mode)

Tests that a MicroVM in checkpoint mode automatically saves state to S3
in the /terminate lifecycle hook when the VM reaches max_lifetime,
and that the state can be fully restored on a new VM.

Unlike eternal mode (which rotates transparently), checkpoint mode:
  - Does NOT rotate — the VM simply dies at max_lifetime
  - The /terminate hook (called by AWS) saves state to S3
  - The user must explicitly launch a new VM with restoreFromSession

Requires:
  - SESSION_PERSISTENCE_MODE=checkpoint
  - MAX_LIFETIME_SECONDS=180 (3 minutes — short for testing)

Total test time: ~4-5 minutes (create state, wait for termination at 180s,
then restore and verify).

Usage:
    export SESSION_PERSISTENCE_MODE=checkpoint
    export MAX_LIFETIME_SECONDS=180
    ./aws_microvm_run.sh

    # In another terminal:
    python3 tests/checkpoint/test_auto_checkpoint.py
"""

import time
import json
import requests
import hashlib

# --- Configuration ---
PROXY_URL = "http://localhost:8081"
MEMORY_MIB = 2048


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


def execute_code(session_id, code, timeout=120):
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


def get_variables(session_id):
    """Get variables from the MicroVM."""
    resp = requests.get(
        f"{PROXY_URL}/proxy/variables",
        headers={"X-Session-Id": session_id},
        timeout=15,
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


def wait_for_vm_gone(session_id, vm_id, timeout=120):
    """Wait until the VM is no longer active (terminated by AWS at max_lifetime)."""
    start = time.time()
    last_log = 0
    while time.time() - start < timeout:
        elapsed = time.time() - start
        if time.time() - last_log >= 15:
            log(f"  ⏳ Waiting for VM termination... ({elapsed:.0f}s elapsed)")
            last_log = time.time()
        instances = get_instances()
        if vm_id not in instances:
            return time.time() - start
        vm_state = instances[vm_id].get("state", "")
        if vm_state in ("TERMINATED", "GONE"):
            return time.time() - start
        time.sleep(5)
    return None


def main():
    log("=" * 70)
    log("  Auto-Checkpoint Test — Checkpoint Mode (Save Before Expiry)")
    log("=" * 70)
    log("")

    timings = {}

    # ================================================================
    # PRE-CHECK: Validate proxy is in checkpoint mode
    # ================================================================
    log("Checking proxy health and mode...")
    try:
        health = requests.get(f"{PROXY_URL}/health", timeout=5).json()
        assert health["status"] == "proxy running"
        log(f"  Proxy OK — region: {health.get('region', '?')}")
    except Exception as e:
        log(f"  ❌ Proxy not reachable: {e}")
        log("  Make sure aws_microvm_run.sh is running!")
        return

    persistence_mode = health.get("persistence_mode", "unknown")
    max_lifetime = health.get("max_lifetime_seconds", 0)

    if persistence_mode != "checkpoint":
        log(f"  ❌ ERROR: This test requires persistence_mode='checkpoint', got '{persistence_mode}'")
        log(f"  Start the proxy with SESSION_PERSISTENCE_MODE=checkpoint")
        return

    if max_lifetime <= 0 or max_lifetime > 300:
        log(f"  ❌ ERROR: max_lifetime_seconds={max_lifetime} — expected 120-180 for testing")
        log(f"  Set MAX_LIFETIME_SECONDS=180 for this test")
        return

    log(f"  ✓ Persistence mode: {persistence_mode}")
    log(f"  ✓ Max lifetime: {max_lifetime}s")
    log(f"  ✓ Checkpoint fires at: /terminate hook (when VM reaches max_lifetime)")
    log("")

    # ================================================================
    # STEP 1: Launch VM in checkpoint mode
    # ================================================================
    log("━" * 70)
    log("  STEP 1: Launch MicroVM (checkpoint mode — no rotation)")
    log("━" * 70)

    session_id = f"checkpoint-test-{int(time.time())}"
    with timed("Launch MicroVM") as t:
        resp = requests.post(f"{PROXY_URL}/launch", json={
            "name": "auto-checkpoint-test",
            "memoryMiB": MEMORY_MIB,
            "idleTimeoutSeconds": 600,
            "checkpointEnabled": True,
            "sessionId": session_id,
        }, timeout=120)
        assert resp.status_code == 200, f"Launch failed: {resp.status_code} {resp.text}"
        data = resp.json()
        vm_id = data["microvmId"]
        endpoint = data["endpoint"]
        session_id = data.get("sessionId", session_id)
    timings["launch"] = t.elapsed
    launch_time = time.time()

    log(f"  VM ID:     {vm_id}")
    log(f"  Endpoint:  {endpoint}")
    log(f"  Session:   {session_id}")
    log("")

    # Wait a moment for VM to fully initialize
    time.sleep(3)

    # ================================================================
    # STEP 2: Create rich state
    # ================================================================
    log("━" * 70)
    log("  STEP 2: Create rich state (vars, DataFrame, file, package, chart)")
    log("━" * 70)

    with timed("Create variables + DataFrame") as t:
        result = execute_code(session_id,
            "import pandas as pd\n"
            "import numpy as np\n"
            "import hashlib\n"
            "\n"
            "# Variables\n"
            "checkpoint_marker = 'I_SURVIVED_CHECKPOINT'\n"
            "counter = 42\n"
            "secret = np.random.randint(0, 999999)\n"
            "\n"
            "# 500-row DataFrame\n"
            "np.random.seed(12345)\n"
            "df = pd.DataFrame({\n"
            "    'x': np.random.randn(500),\n"
            "    'y': np.random.randn(500),\n"
            "    'category': np.random.choice(['A', 'B', 'C', 'D'], 500),\n"
            "})\n"
            "df['z'] = df['x'] * df['y']\n"
            "df_checksum = hashlib.md5(df.to_csv().encode()).hexdigest()\n"
            "\n"
            "print(f'State: marker={checkpoint_marker}, counter={counter}, secret={secret}')\n"
            "print(f'DataFrame: {df.shape}, checksum={df_checksum}')"
        )
    timings["create_vars"] = t.elapsed
    assert result.get("success"), f"Create vars failed: {result.get('error')}"
    log(f"  {result['output'].strip()}")

    with timed("Create local file") as t:
        result = execute_code(session_id,
            "import os\n"
            "with open('/tmp/checkpoint_test.txt', 'w') as f:\n"
            "    f.write(f'Created for checkpoint test\\n')\n"
            "    f.write(f'secret={secret}\\n')\n"
            "    f.write(f'df_checksum={df_checksum}\\n')\n"
            "    f.write(f'rows={len(df)}\\n')\n"
            "print(f'File: {os.path.getsize(\"/tmp/checkpoint_test.txt\")} bytes')"
        )
    timings["create_file"] = t.elapsed
    assert result.get("success"), f"Create file failed: {result.get('error')}"
    log(f"  {result['output'].strip()}")

    with timed("Install package (tabulate)") as t:
        result = install_package(session_id, "tabulate")
    timings["install_pkg"] = t.elapsed
    assert result.get("success"), f"Install failed: {result.get('error')}"
    # Verify importable
    verify = execute_code(session_id, "import tabulate; print(f'tabulate installed: {tabulate.__version__}')")
    assert verify.get("success"), f"Import failed: {verify.get('error')}"
    log(f"  {verify['output'].strip()}")

    with timed("Generate matplotlib chart") as t:
        result = execute_code(session_id,
            "import matplotlib\n"
            "matplotlib.use('Agg')\n"
            "import matplotlib.pyplot as plt\n"
            "\n"
            "fig, axes = plt.subplots(2, 2, figsize=(12, 10))\n"
            "\n"
            "# Subplot 1: Scatter\n"
            "axes[0, 0].scatter(df['x'], df['y'], c=df['z'], cmap='viridis', alpha=0.6)\n"
            "axes[0, 0].set_title('X vs Y (colored by Z)')\n"
            "\n"
            "# Subplot 2: Histogram\n"
            "axes[0, 1].hist(df['z'], bins=30, edgecolor='black')\n"
            "axes[0, 1].set_title('Distribution of Z')\n"
            "\n"
            "# Subplot 3: Box plot by category\n"
            "df.boxplot(column='z', by='category', ax=axes[1, 0])\n"
            "axes[1, 0].set_title('Z by Category')\n"
            "\n"
            "# Subplot 4: Line plot\n"
            "axes[1, 1].plot(df['x'].cumsum(), label='Cumsum X')\n"
            "axes[1, 1].plot(df['y'].cumsum(), label='Cumsum Y')\n"
            "axes[1, 1].legend()\n"
            "axes[1, 1].set_title('Cumulative Sums')\n"
            "\n"
            "plt.tight_layout()\n"
            "chart_var_name = 'fig'  # Track that we made this\n"
            "print(f'Chart created: {len(fig.axes)} subplots, figsize={fig.get_size_inches()}')"
        )
    timings["create_chart"] = t.elapsed
    assert result.get("success"), f"Chart failed: {result.get('error')}"
    log(f"  {result['output'].strip()}")

    # Capture values for later verification
    with timed("Capture baseline values") as t:
        result = execute_code(session_id,
            "import json\n"
            "print(json.dumps({'secret': int(secret), 'df_checksum': df_checksum}))"
        )
    assert result.get("success")
    baseline = json.loads(result["output"].strip())
    secret_value = baseline["secret"]
    df_checksum_value = baseline["df_checksum"]
    timings["capture_baseline"] = t.elapsed
    log(f"  Captured: secret={secret_value}, checksum={df_checksum_value[:16]}...")
    log("")

    # ================================================================
    # STEP 3: Verify state exists before checkpoint
    # ================================================================
    log("━" * 70)
    log("  STEP 3: Verify state exists")
    log("━" * 70)

    with timed("Verify state") as t:
        result = execute_code(session_id,
            "import os\n"
            "assert checkpoint_marker == 'I_SURVIVED_CHECKPOINT'\n"
            "assert counter == 42\n"
            "assert len(df) == 500\n"
            "assert os.path.exists('/tmp/checkpoint_test.txt')\n"
            "import tabulate\n"
            "print(f'All pre-checkpoint checks pass')\n"
            "print(f'  vars: OK, df: {df.shape}, file: OK, tabulate: {tabulate.__version__}')"
        )
    timings["verify_pre"] = t.elapsed
    assert result.get("success"), f"Pre-check failed: {result.get('error')}"
    log(f"  {result['output'].strip()}")
    log("")

    # ================================================================
    # STEP 4: Wait for VM termination (triggers /terminate hook → checkpoint)
    # ================================================================
    log("━" * 70)
    log(f"  STEP 4: Wait for VM termination at max_lifetime ({max_lifetime}s)")
    log("━" * 70)
    log(f"  The /terminate hook saves state to S3 right before the VM dies.")
    log("")

    elapsed_since_launch = time.time() - launch_time
    wait_until_terminated = max_lifetime + 30
    remaining = wait_until_terminated - elapsed_since_launch

    if remaining > 0:
        log(f"  {elapsed_since_launch:.0f}s since launch, waiting up to {remaining:.0f}s for termination...")
        with timed("Wait for VM termination") as t:
            gone_at = wait_for_vm_gone(session_id, vm_id, timeout=remaining + 30)
        timings["vm_terminated"] = t.elapsed

        if gone_at is not None:
            log(f"  ✓ VM terminated (gone after {gone_at:.0f}s of waiting)")
        else:
            log(f"  ⚠ VM still showing as active after {remaining:.0f}s wait")
            log(f"    Proceeding anyway — VM may have been terminated but proxy cache is stale")
    else:
        log(f"  VM should already be terminated ({elapsed_since_launch:.0f}s since launch)")
        timings["vm_terminated"] = 0

    # Brief wait for S3 checkpoint write to propagate
    time.sleep(5)
    log("")

    # ================================================================
    # STEP 5: Verify checkpoint exists in S3
    # ================================================================
    log("━" * 70)
    log("  STEP 5: Verify checkpoint exists in S3")
    log("━" * 70)

    with timed("Check sessions endpoint") as t:
        resp = requests.get(f"{PROXY_URL}/sessions", timeout=15)
        sessions = resp.json().get("sessions", [])
    timings["check_sessions"] = t.elapsed

    our_session = None
    for s in sessions:
        if s.get("session_id") == session_id:
            our_session = s
            break

    if our_session:
        log(f"  ✓ Checkpoint found for session: {session_id}")
        log(f"    Variables: {our_session.get('variables_count', '?')}")
        log(f"    Files: {our_session.get('files_count', '?')}")
        log(f"    Checkpointed at: {our_session.get('checkpointed_at', '?')}")
    else:
        log(f"  ❌ No checkpoint found for session '{session_id}'")
        log(f"  Available sessions: {[s['session_id'] for s in sessions]}")
        log(f"  This means auto-checkpoint did not fire. Check proxy logs.")
        try:
            requests.post(f"{PROXY_URL}/terminate", headers={"X-Session-Id": session_id}, timeout=10)
        except:
            pass
        return
    log("")

    # ================================================================
    # STEP 6: Launch new VM with restoreFromSession
    # ================================================================
    log("━" * 70)
    log("  STEP 6: Launch new VM with restoreFromSession")
    log("━" * 70)

    new_session_id = f"{session_id}-restored-{int(time.time())}"
    with timed("Launch restored VM") as t:
        resp = requests.post(f"{PROXY_URL}/launch", json={
            "name": "checkpoint-restore-test",
            "memoryMiB": MEMORY_MIB,
            "idleTimeoutSeconds": 300,
            "checkpointEnabled": False,
            "sessionId": new_session_id,
            "restoreFromSession": session_id,
        }, timeout=120)
        assert resp.status_code == 200, f"Restore launch failed: {resp.status_code} {resp.text}"
        restore_data = resp.json()
        restore_vm_id = restore_data["microvmId"]
        restore_endpoint = restore_data["endpoint"]
    timings["launch_restore"] = t.elapsed

    log(f"  New VM ID:  {restore_vm_id}")
    log(f"  Endpoint:   {restore_endpoint}")

    # Wait for it to be responsive
    with timed("Wait for restored VM ready") as t:
        headers = {"X-Session-Id": new_session_id}
        for _ in range(20):
            try:
                r = requests.get(f"{PROXY_URL}/proxy/health", headers=headers, timeout=5)
                if r.ok:
                    break
            except:
                pass
            time.sleep(2)
    timings["restore_ready"] = t.elapsed
    log(f"  ✓ Restored VM is responsive")
    log("")

    # ================================================================
    # STEP 7: Verify ALL state restored
    # ================================================================
    log("━" * 70)
    log("  STEP 7: Verify all state restored")
    log("━" * 70)

    checks = []

    # Check variables
    with timed("Verify variables") as t:
        result = execute_code(new_session_id,
            "import json\n"
            "results = {}\n"
            "try:\n"
            "    results['marker'] = checkpoint_marker == 'I_SURVIVED_CHECKPOINT'\n"
            "except NameError:\n"
            "    results['marker'] = False\n"
            "try:\n"
            "    results['counter'] = counter == 42\n"
            "except NameError:\n"
            "    results['counter'] = False\n"
            "try:\n"
            f"    results['secret'] = secret == {secret_value}\n"
            "except NameError:\n"
            "    results['secret'] = False\n"
            "print(json.dumps(results))"
        )
    timings["verify_vars"] = t.elapsed

    if result.get("success"):
        var_checks = json.loads(result["output"].strip())
        for name, passed in var_checks.items():
            checks.append((f"variable '{name}'", passed))
            status = "✓" if passed else "❌"
            log(f"  {status} Variable '{name}': {'restored' if passed else 'LOST'}")
    else:
        log(f"  ❌ Variable check execution failed: {result.get('error')}")
        checks.append(("variables execution", False))

    # Check DataFrame (checksum)
    with timed("Verify DataFrame") as t:
        result = execute_code(new_session_id,
            "import hashlib\n"
            "try:\n"
            "    restored_checksum = hashlib.md5(df.to_csv().encode()).hexdigest()\n"
            f"    match = restored_checksum == '{df_checksum_value}'\n"
            "    print(f'df_match={match}, shape={df.shape}, checksum={restored_checksum[:16]}')\n"
            "except NameError as e:\n"
            "    print(f'df_match=False, error={e}')"
        )
    timings["verify_df"] = t.elapsed

    if result.get("success"):
        output = result["output"].strip()
        df_ok = "df_match=True" in output
        checks.append(("DataFrame checksum", df_ok))
        status = "✓" if df_ok else "❌"
        log(f"  {status} DataFrame: {output}")
    else:
        checks.append(("DataFrame", False))
        log(f"  ❌ DataFrame check failed: {result.get('error')}")

    # Check local file
    with timed("Verify local file") as t:
        result = execute_code(new_session_id,
            "import os\n"
            "exists = os.path.exists('/tmp/checkpoint_test.txt')\n"
            "content = ''\n"
            "if exists:\n"
            "    content = open('/tmp/checkpoint_test.txt').read()\n"
            f"has_secret = 'secret={secret_value}' in content\n"
            "print(f'file_exists={exists}, has_secret={has_secret}')"
        )
    timings["verify_file"] = t.elapsed

    if result.get("success"):
        output = result["output"].strip()
        file_ok = "file_exists=True" in output and "has_secret=True" in output
        checks.append(("local file /tmp/checkpoint_test.txt", file_ok))
        status = "✓" if file_ok else "❌"
        log(f"  {status} Local file: {output}")
    else:
        checks.append(("local file", False))
        log(f"  ❌ File check failed: {result.get('error')}")
    # Check data catalog restored with local file schema
    try:
        catalog_resp = requests.get(f"{PROXY_URL}/datasources/catalog", headers={"X-Session-Id": new_session_id}, timeout=10)
        if catalog_resp.status_code == 200:
            catalog = catalog_resp.json()
            discovered = catalog.get("discovered", 0)
            total = catalog.get("total", 0)
            local_entries = [e for e in catalog.get("entries", []) if e.get("source_type") == "local"]
            checks.append(("data catalog restored", discovered > 0))
            log(f"  {"\u2713" if discovered > 0 else "\u274c"} Data catalog: {discovered}/{total} sources, {len(local_entries)} local files")
        else:
            checks.append(("data catalog restored", False))
            log(f"  \u274c Data catalog endpoint returned {catalog_resp.status_code}")
    except Exception as e:
        checks.append(("data catalog restored", False))
        log(f"  \u274c Data catalog check failed: {e}")

    # Check installed package (tabulate)
    with timed("Verify installed package") as t:
        result = execute_code(new_session_id,
            "try:\n"
            "    import tabulate\n"
            "    print(f'tabulate_ok=True, version={tabulate.__version__}')\n"
            "except ImportError as e:\n"
            "    print(f'tabulate_ok=False, error={e}')"
        )
    timings["verify_pkg"] = t.elapsed

    if result.get("success"):
        output = result["output"].strip()
        pkg_ok = "tabulate_ok=True" in output
        checks.append(("installed package (tabulate)", pkg_ok))
        status = "✓" if pkg_ok else "❌"
        log(f"  {status} Package tabulate: {output}")
    else:
        checks.append(("package tabulate", False))
        log(f"  ❌ Package check failed: {result.get('error')}")

    # ================================================================
    # STEP 8: Verify matplotlib vars are NOT restored (expected)
    # ================================================================
    log("")
    log("━" * 70)
    log("  STEP 8: Verify matplotlib vars NOT restored (excluded — expected)")
    log("━" * 70)

    with timed("Check matplotlib exclusion") as t:
        result = execute_code(new_session_id,
            "mpl_vars_exist = []\n"
            "for name in ['fig', 'axes', 'plt']:\n"
            "    try:\n"
            "        val = eval(name)\n"
            "        mpl_vars_exist.append(name)\n"
            "    except NameError:\n"
            "        pass\n"
            "print(f'matplotlib_vars_restored={mpl_vars_exist}')\n"
            "print(f'excluded={len(mpl_vars_exist) == 0}')"
        )
    timings["verify_mpl_excluded"] = t.elapsed

    if result.get("success"):
        output = result["output"].strip()
        mpl_excluded = "excluded=True" in output
        checks.append(("matplotlib vars excluded (expected)", mpl_excluded))
        status = "✓" if mpl_excluded else "⚠"
        log(f"  {status} Matplotlib: {output}")
        if mpl_excluded:
            log(f"    (This is correct — matplotlib objects can't be serialized)")
        else:
            log(f"    (Unexpected — matplotlib vars should be excluded from checkpoint)")
    else:
        checks.append(("matplotlib exclusion check", False))
        log(f"  ❌ Check failed: {result.get('error')}")
    log("")

    # ================================================================
    # CLEANUP
    # ================================================================
    log("━" * 70)
    log("  CLEANUP")
    log("━" * 70)

    with timed("Terminate restored VM") as t:
        try:
            requests.post(f"{PROXY_URL}/terminate", headers={"X-Session-Id": new_session_id}, timeout=10)
        except:
            pass
    timings["terminate"] = t.elapsed
    log("  ✓ Cleaned up")
    log("")

    # ================================================================
    # STEP 9: Timing Report
    # ================================================================
    total_time = time.time() - launch_time
    passed = sum(1 for _, ok in checks if ok)
    total = len(checks)
    all_passed = passed == total

    print()
    print("=" * 70)
    print("  AUTO-CHECKPOINT TEST REPORT")
    print("=" * 70)
    print()
    print(f"  Result: {'✅ PASSED' if all_passed else '❌ FAILED'}")
    print(f"  Checks: {passed}/{total} passed")
    print()
    print("  ── Check Details ───────────────────────────────────────")
    for name, ok in checks:
        print(f"    {'✓' if ok else '❌'} {name}")
    print()
    print("  ── Timings ─────────────────────────────────────────────")
    print(f"  Launch VM:                  {timings.get('launch', 0):.2f}s")
    print(f"  Create state (vars+df):     {timings.get('create_vars', 0):.2f}s")
    print(f"  Create file:                {timings.get('create_file', 0):.2f}s")
    print(f"  Install package:            {timings.get('install_pkg', 0):.2f}s")
    print(f"  Generate chart:             {timings.get('create_chart', 0):.2f}s")
    print(f"  Wait for VM termination:    {timings.get('vm_terminated', 0):.2f}s")
    print(f"  Launch restored VM:         {timings.get('launch_restore', 0):.2f}s")
    print(f"  Restored VM ready:          {timings.get('restore_ready', 0):.2f}s")
    print(f"  Verify variables:           {timings.get('verify_vars', 0):.2f}s")
    print(f"  Verify DataFrame:           {timings.get('verify_df', 0):.2f}s")
    print(f"  Verify file:                {timings.get('verify_file', 0):.2f}s")
    print(f"  Verify package:             {timings.get('verify_pkg', 0):.2f}s")
    print(f"  Total test time:            {total_time:.1f}s ({total_time/60:.1f} min)")
    print()
    print("  ── Configuration ───────────────────────────────────────")
    print(f"  Mode:                       checkpoint (no rotation)")
    print(f"  MAX_LIFETIME_SECONDS:       {max_lifetime}")
    print(f"  Checkpoint fires at:        /terminate hook (max_lifetime)")
    print(f"  VM dies at:                 ~{max_lifetime}s")
    print(f"  Memory:                     {MEMORY_MIB} MiB")
    print()
    print("  ── Flow ────────────────────────────────────────────────")
    print(f"  1. VM launched, state created (vars, DataFrame, file, package, chart)")
    print(f"  2. VM terminated by AWS at ~{max_lifetime}s")
    print(f"  3. /terminate hook saves checkpoint to S3 (always latest state)")
    print(f"  4. New VM launched with restoreFromSession")
    print(f"  5. All state restored (vars, DataFrame, file, packages)")
    print(f"  6. matplotlib vars correctly excluded (not serializable)")
    print()
    print("  ── Conclusion ──────────────────────────────────────────")
    if all_passed:
        print(f"  Checkpoint saved on /terminate hook at max_lifetime.")
        print(f"  Full restore confirmed: variables, DataFrame, files, packages.")
        print(f"  Non-serializable objects (matplotlib) correctly excluded.")
    else:
        print(f"  Some checks failed — see details above.")
        print(f"  Check proxy logs for checkpoint/restore errors.")
    print()
    print("=" * 70)


if __name__ == "__main__":
    main()
