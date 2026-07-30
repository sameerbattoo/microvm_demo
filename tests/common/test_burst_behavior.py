"""
End-to-end test: MicroVM Burst Behavior.

==========================================================================
FINDINGS (from test runs on 2026-07-23):
==========================================================================

1. BURST CAPACITY IS PRE-ALLOCATED AT 4× BASELINE:
   - 1 GB baseline → psutil sees 4 GB total, 2 CPU cores (always)
   - 2 GB baseline → psutil sees 8 GB total, 4 CPU cores (always)
   - total_mb NEVER changes during load — it's fixed at 4× from boot

2. BILLING MODEL:
   - You pay baseline rate for the entire running duration
   - Usage ABOVE baseline (used_mb > baseline_mb) incurs burst billing per-second
   - The burst surcharge = (used_mb - baseline_mb) × seconds × rate

3. HARD CEILING:
   - Exceeding the 4× peak limit causes OOM crash (VM terminated)
   - 1 GB VM crashed when allocation exceeded ~4 GB
   - There is NO dynamic scaling beyond 4× — it's a hard wall

4. WHAT psutil REPORTS:
   - memory.total_mb: Always 4× baseline (not a burst indicator)
   - memory.used_mb: Actual RSS consumption (THIS is the burst indicator)
   - cpu.count: Always 4× baseline vCPU (e.g., 2 cores for 1GB, 4 for 2GB)
   - cpu.percent: Actual CPU utilization

5. COST TRACKING IMPLICATIONS:
   - Track used_mb on each metrics poll
   - If used_mb > baseline_mb → burst surcharge applies
   - Formula: max(0, used_mb - baseline_mb) × poll_interval_sec × rate_per_mb_sec
   - total_mb is NOT useful for cost — it's always 4× regardless of load

==========================================================================

This test launches a 1GB baseline VM, gradually increases memory + CPU load
to ~3.4 GB (safely under the 4GB ceiling), polls metrics to confirm burst
behavior, then cleans up.

Requires: aws_microvm_run.sh running (proxy at localhost:8081)
"""

import requests
import time
import threading

PROXY = "http://localhost:8081"
MEMORY_MIB = 1024  # 1GB baseline — peak is 4GB (4x)


def get_metrics(session_id):
    """Fetch psutil metrics from the VM via proxy."""
    headers = {"X-Session-Id": session_id}
    try:
        resp = requests.get(f"{PROXY}/proxy/metrics", headers=headers, timeout=10)
        if resp.ok:
            return resp.json()
    except:
        pass
    return None


def execute_code(session_id, code, timeout=120):
    """Execute Python code on the VM."""
    headers = {
        "Content-Type": "application/json",
        "X-Session-Id": session_id,
    }
    resp = requests.post(f"{PROXY}/proxy/execute", headers=headers, json={"code": code}, timeout=timeout)
    return resp.json() if resp.ok else None


def print_metrics(label, metrics):
    """Print a metrics summary."""
    if not metrics:
        print(f"  [{label}] ERROR: no metrics")
        return
    mem = metrics["memory"]
    cpu = metrics["cpu"]
    print(f"  [{label}]")
    print(f"    Memory total: {mem['total_mb']:.1f} MB | used: {mem['used_mb']:.1f} MB | %: {mem['percent']:.1f}%")
    print(f"    CPU cores: {cpu['count']} | %: {cpu['percent']:.1f}%")


def main():
    print("=" * 70)
    print("  MicroVM Burst Behavior Test")
    print(f"  Baseline: {MEMORY_MIB} MiB ({MEMORY_MIB/1024:.1f} GB)")
    print(f"  Expected peak (4×): {MEMORY_MIB * 4} MiB ({MEMORY_MIB * 4 / 1024:.1f} GB)")
    print("=" * 70)

    # --- Step 1: Launch VM ---
    print(f"\n>> Launching {MEMORY_MIB} MiB MicroVM...")
    resp = requests.post(f"{PROXY}/launch", json={
        "notebookName": "Burst Test",
        "memoryMiB": MEMORY_MIB,
        "idleTimeoutSeconds": 300,
        "checkpointEnabled": False,
    })
    if not resp.ok:
        print(f"  FAILED to launch: {resp.status_code} {resp.text}")
        return

    data = resp.json()
    vm_id = data["microvmId"]
    session_id = data.get("sessionId", "")
    print(f"  VM: {vm_id}")
    print(f"  Session: {session_id}")
    print("  Waiting for VM to initialize...")
    time.sleep(5)

    # --- Step 2: Idle metrics ---
    print("\n>> Step 1: Idle metrics")
    m = get_metrics(session_id)
    print_metrics("IDLE", m)
    idle_total = m["memory"]["total_mb"] if m else 0

    # --- Step 3: Small workload ---
    print("\n>> Step 2: Small workload (load pandas, create small DataFrame)")
    execute_code(session_id, """
import pandas as pd
import numpy as np
df = pd.DataFrame(np.random.randn(10000, 50), columns=[f'col_{i}' for i in range(50)])
print(f"DataFrame: {df.shape}, memory: {df.memory_usage(deep=True).sum() / 1024 / 1024:.1f} MB")
""")
    time.sleep(1)
    m = get_metrics(session_id)
    print_metrics("SMALL LOAD", m)

    # --- Step 4: Heavy workload (safely under 4× ceiling) ---
    print("\n>> Step 3: Heavy workload (~3 GB allocation + CPU burn)")
    print("  Allocating ~3 GB (safely under 4 GB peak), polling every 3s for 50s...")

    # Allocate ~3GB (safe: under 4GB ceiling, well above 1GB baseline)
    heavy_code = """
import numpy as np
import time
import threading

# --- Memory: allocate ~3 GB (under 4 GB hard ceiling) ---
arrays = []
target_mb = 3000  # 3 GB — safely under 4 GB peak for 1 GB baseline
per_array_mb = 76.3
num_arrays = int(target_mb / per_array_mb)
print(f"Allocating {num_arrays} arrays (~{target_mb} MB)...")

for i in range(num_arrays):
    arr = np.random.randn(10_000_000)
    arrays.append(arr)
    if (i + 1) % 10 == 0:
        print(f"  [{i+1}/{num_arrays}] {(i+1)*per_array_mb:.0f} MB allocated")

total_mb = sum(a.nbytes for a in arrays) / 1024 / 1024
print(f"Done: {total_mb:.0f} MB allocated")

# --- CPU: saturate cores ---
stop_flag = [False]
def cpu_burn():
    while not stop_flag[0]:
        a = np.random.randn(500, 500)
        _ = a @ a.T

threads = [threading.Thread(target=cpu_burn) for _ in range(4)]
for t in threads:
    t.start()

time.sleep(30)

stop_flag[0] = True
for t in threads:
    t.join()

print(f"Sustained {total_mb:.0f} MB + 4 CPU threads for 30s")
del arrays
print("Released. Process alive.")
"""

    result_holder = [None]
    def run_heavy():
        result_holder[0] = execute_code(session_id, heavy_code)

    t = threading.Thread(target=run_heavy)
    t.start()

    # Poll metrics
    poll_results = []
    for i in range(17):
        time.sleep(3)
        m = get_metrics(session_id)
        if m:
            mem = m["memory"]
            cpu = m["cpu"]
            poll_results.append({
                "t": (i + 1) * 3,
                "total_mb": mem["total_mb"],
                "used_mb": mem["used_mb"],
                "percent": mem["percent"],
                "cpu_pct": cpu["percent"],
                "cpu_cores": cpu["count"],
            })
            burst = "⚡BURST" if mem["used_mb"] > MEMORY_MIB else "      "
            print(f"  t={((i+1)*3):2d}s | total={mem['total_mb']:.0f} MB | used={mem['used_mb']:.0f} MB ({mem['percent']:.0f}%) | CPU={cpu['percent']:.0f}% ({cpu['count']} cores) {burst}")
        else:
            print(f"  t={((i+1)*3):2d}s | ❌ NO RESPONSE")
            poll_results.append({"t": (i+1)*3, "crashed": True})

    t.join(timeout=60)

    # --- Report ---
    print("\n" + "=" * 70)
    print("  DETAILED REPORT")
    print("=" * 70)
    print(f"\n  Configuration:")
    print(f"    Baseline memory:     {MEMORY_MIB} MiB ({MEMORY_MIB/1024:.1f} GB)")
    print(f"    Expected peak (4×):  {MEMORY_MIB*4} MiB ({MEMORY_MIB*4/1024:.1f} GB)")
    print(f"    Idle total_mb:       {idle_total:.0f} MB")

    if poll_results:
        valid = [r for r in poll_results if not r.get("crashed")]
        if valid:
            totals = set(r["total_mb"] for r in valid)
            max_used = max(r["used_mb"] for r in valid)
            max_cpu = max(r["cpu_pct"] for r in valid)
            cores = set(r["cpu_cores"] for r in valid)
            burst_samples = [r for r in valid if r["used_mb"] > MEMORY_MIB]
            burst_duration = len(burst_samples) * 3  # 3s per poll

            print(f"\n  Observations:")
            print(f"    total_mb values seen: {sorted(totals)} → {'CONSTANT' if len(totals)==1 else 'CHANGED!'}")
            print(f"    CPU cores seen:       {sorted(cores)}")
            print(f"    Max used_mb:          {max_used:.0f} MB")
            print(f"    Max CPU %:            {max_cpu:.0f}%")
            print(f"    Burst detected:       {len(burst_samples)}/{len(valid)} samples ({burst_duration}s above baseline)")

            print(f"\n  Cost implications:")
            print(f"    Baseline cost:  {MEMORY_MIB/1024:.1f} GB × $0.0000037/GB-s + {MEMORY_MIB/1024/2:.1f} vCPU × $0.0000277/vCPU-s")
            if burst_samples:
                avg_burst = sum(r["used_mb"] - MEMORY_MIB for r in burst_samples) / len(burst_samples)
                print(f"    Burst surcharge: avg {avg_burst:.0f} MB above baseline × {burst_duration}s × (vCPU + memory rate)")
                burst_gb = avg_burst / 1024
                burst_vcpu = burst_gb / 2
                burst_cost = burst_duration * (burst_vcpu * 0.0000276944 + burst_gb * 0.0000036667)
                print(f"    Estimated burst surcharge for this test: ${burst_cost:.6f}")
            else:
                print(f"    No burst billing (usage stayed within baseline)")

    crashes = [r for r in poll_results if r.get("crashed")]
    if crashes:
        print(f"\n  ⚠️  VM became unresponsive at t={crashes[0]['t']}s")

    print(f"\n  Key findings:")
    print(f"    • total_mb is ALWAYS 4× baseline ({idle_total:.0f} MB) — pre-allocated, never changes")
    print(f"    • CPU cores always {sorted(cores) if valid else '?'} — pre-allocated at 4× vCPU")
    print(f"    • Burst = using memory above baseline; billed per-second for the overage")
    print(f"    • Exceeding 4× peak ({MEMORY_MIB*4} MB) causes OOM crash (tested separately)")

    if result_holder[0]:
        print(f"\n  Workload output: {result_holder[0].get('output', 'N/A')[:200]}")

    # --- Cleanup ---
    print(f"\n>> Terminating VM {vm_id}...")
    requests.post(f"{PROXY}/terminate", headers={"X-Session-Id": session_id})
    print("  Done.")


if __name__ == "__main__":
    main()
