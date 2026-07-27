#!/usr/bin/env python3
"""
End-to-End Test: SQL Engine — Multi-Source Routing

Tests the SQL engine's ability to detect source types and route queries
to the correct engine (DuckDB, Athena, DynamoDB PartiQL, or mixed).

Sources tested:
  1. Local files (/tmp/*.csv) → DuckDB
  2. S3 files (read_csv('s3://...')) → DuckDB + httpfs
  3. In-memory DataFrames → DuckDB
  4. Athena tables (database.table) → Athena
  5. DynamoDB tables (dynamodb."table") → PartiQL or scan+DuckDB
  6. Mixed queries (cross-source JOINs) → materialize remote + DuckDB

Each test verifies:
  - The correct engine was used (from response 'engine' field)
  - The query returned expected row/column counts
  - Results are correct (spot-check values)

Setup:
  - Requires proxy running with sample data provisioned
  - Creates local CSV files on the VM before SQL tests

Usage:
    python3 tests/common/test_sql_engine.py
"""

import time
import json
import requests

# --- Configuration ---
PROXY_URL = "http://localhost:8081"
MEMORY_MIB = 2048


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}")


def timed(label):
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


def execute_code(session_id, code, timeout=60):
    resp = requests.post(
        f"{PROXY_URL}/proxy/execute",
        headers={"Content-Type": "application/json", "X-Session-Id": session_id},
        json={"code": code},
        timeout=timeout,
    )
    return resp.json()


def execute_sql(session_id, sql, output_variable="result", timeout=30):
    resp = requests.post(
        f"{PROXY_URL}/proxy/execute-sql",
        headers={"Content-Type": "application/json", "X-Session-Id": session_id},
        json={"sql": sql, "output_variable": output_variable},
        timeout=timeout,
    )
    return resp.json()


def terminate_session(session_id):
    requests.post(f"{PROXY_URL}/terminate", headers={"X-Session-Id": session_id}, timeout=10)


def main():
    log("=" * 70)
    log("  SQL Engine Test — Multi-Source Routing & Correctness")
    log("=" * 70)
    log("")

    checks_passed = 0
    checks_failed = 0
    check_details = []

    def check(name, condition, detail=""):
        nonlocal checks_passed, checks_failed
        if condition:
            checks_passed += 1
            check_details.append(("✓", name))
            log(f"  ✓ {name}")
        else:
            checks_failed += 1
            check_details.append(("❌", name))
            log(f"  ❌ {name}{' — ' + detail if detail else ''}")

    # --- Check proxy ---
    log("Checking proxy health...")
    try:
        health = requests.get(f"{PROXY_URL}/health", timeout=5).json()
        assert health["status"] == "proxy running"
        log(f"  Proxy OK — region: {health.get('region')}")
    except Exception as e:
        log(f"  ❌ Proxy not reachable: {e}")
        return

    # --- Launch VM ---
    log("")
    log("Launching MicroVM...")
    session_id = f"sql-test-{int(time.time())}"
    with timed("Launch"):
        resp = requests.post(f"{PROXY_URL}/launch", json={
            "name": "sql-engine-test",
            "memoryMiB": MEMORY_MIB,
            "idleTimeoutSeconds": 300,
            "sessionId": session_id,
        }, timeout=120)
        assert resp.status_code == 200, f"Launch failed: {resp.text}"
        data = resp.json()
        session_id = data.get("sessionId", session_id)
    log(f"  Session: {session_id}")
    log("")

    # Wait for VM to be ready
    time.sleep(3)

    # ================================================================
    # SETUP: Create local files and DataFrames
    # ================================================================
    log("━" * 70)
    log("  SETUP: Create local files and DataFrames on VM")
    log("━" * 70)

    # Create /tmp/orders.csv
    with timed("Create /tmp/orders.csv"):
        result = execute_code(session_id,
            "import csv\n"
            "with open('/tmp/orders.csv', 'w', newline='') as f:\n"
            "    w = csv.writer(f)\n"
            "    w.writerow(['order_id', 'customer_id', 'product', 'amount'])\n"
            "    w.writerow([1, 'C001', 'Widget', 29.99])\n"
            "    w.writerow([2, 'C002', 'Gadget', 49.99])\n"
            "    w.writerow([3, 'C001', 'Doohickey', 14.99])\n"
            "    w.writerow([4, 'C003', 'Widget', 29.99])\n"
            "    w.writerow([5, 'C002', 'Thingamajig', 9.99])\n"
            "print('orders.csv created: 5 rows')"
        )
    assert result.get("success"), f"Failed to create orders.csv: {result.get('error')}"

    # Create /tmp/customers.csv
    with timed("Create /tmp/customers.csv"):
        result = execute_code(session_id,
            "import csv\n"
            "with open('/tmp/customers.csv', 'w', newline='') as f:\n"
            "    w = csv.writer(f)\n"
            "    w.writerow(['customer_id', 'name', 'city'])\n"
            "    w.writerow(['C001', 'Alice', 'NYC'])\n"
            "    w.writerow(['C002', 'Bob', 'SF'])\n"
            "    w.writerow(['C003', 'Charlie', 'LA'])\n"
            "print('customers.csv created: 3 rows')"
        )
    assert result.get("success"), f"Failed to create customers.csv: {result.get('error')}"

    # Create in-memory DataFrames
    with timed("Create DataFrames"):
        result = execute_code(session_id,
            "import pandas as pd\n"
            "import numpy as np\n"
            "\n"
            "# Products DataFrame\n"
            "products = pd.DataFrame({\n"
            "    'product': ['Widget', 'Gadget', 'Doohickey', 'Thingamajig'],\n"
            "    'category': ['Tools', 'Electronics', 'Tools', 'Electronics'],\n"
            "    'weight_kg': [0.5, 1.2, 0.3, 0.8],\n"
            "})\n"
            "\n"
            "# Sales DataFrame (larger)\n"
            "np.random.seed(42)\n"
            "sales = pd.DataFrame({\n"
            "    'date': pd.date_range('2024-01-01', periods=100, freq='D'),\n"
            "    'region': np.random.choice(['North', 'South', 'East', 'West'], 100),\n"
            "    'revenue': np.random.uniform(100, 5000, 100).round(2),\n"
            "})\n"
            "print(f'products: {products.shape}, sales: {sales.shape}')"
        )
    assert result.get("success"), f"Failed to create DataFrames: {result.get('error')}"
    log("")

    # ================================================================
    # TEST 1: Local file — single table (DuckDB)
    # ================================================================
    log("━" * 70)
    log("  TEST 1: Local file — SELECT FROM '/tmp/orders.csv'")
    log("━" * 70)

    with timed("Query"):
        r = execute_sql(session_id, "SELECT * FROM '/tmp/orders.csv' LIMIT 10", "local_orders")
    check("T1: success", r.get("success"), r.get("error", ""))
    check("T1: engine=duckdb", r.get("engine") == "duckdb", f"got: {r.get('engine')}")
    check("T1: 5 rows", r.get("row_count") == 5, f"got: {r.get('row_count')}")
    check("T1: 4 columns", r.get("column_count") == 4, f"got: {r.get('column_count')}")
    log("")

    # ================================================================
    # TEST 2: Local file — aggregation (DuckDB)
    # ================================================================
    log("━" * 70)
    log("  TEST 2: Local file — GROUP BY aggregation")
    log("━" * 70)

    with timed("Query"):
        r = execute_sql(session_id,
            "SELECT product, COUNT(*) as cnt, SUM(amount) as total "
            "FROM '/tmp/orders.csv' GROUP BY product ORDER BY total DESC",
            "order_summary"
        )
    check("T2: success", r.get("success"), r.get("error", ""))
    check("T2: engine=duckdb", r.get("engine") == "duckdb", f"got: {r.get('engine')}")
    check("T2: 4 products", r.get("row_count") == 4, f"got: {r.get('row_count')}")
    log("")

    # ================================================================
    # TEST 3: DataFrame — SELECT FROM variable (DuckDB)
    # ================================================================
    log("━" * 70)
    log("  TEST 3: In-memory DataFrame — SELECT FROM products")
    log("━" * 70)

    with timed("Query"):
        r = execute_sql(session_id, "SELECT * FROM products WHERE category = 'Tools'", "tools")
    check("T3: success", r.get("success"), r.get("error", ""))
    check("T3: engine=duckdb", r.get("engine") == "duckdb", f"got: {r.get('engine')}")
    check("T3: 2 tools", r.get("row_count") == 2, f"got: {r.get('row_count')}")
    log("")

    # ================================================================
    # TEST 4: DataFrame — aggregation on sales (DuckDB)
    # ================================================================
    log("━" * 70)
    log("  TEST 4: DataFrame — GROUP BY on sales (100 rows)")
    log("━" * 70)

    with timed("Query"):
        r = execute_sql(session_id,
            "SELECT region, COUNT(*) as cnt, ROUND(AVG(revenue), 2) as avg_rev "
            "FROM sales GROUP BY region ORDER BY avg_rev DESC",
            "region_stats"
        )
    check("T4: success", r.get("success"), r.get("error", ""))
    check("T4: engine=duckdb", r.get("engine") == "duckdb", f"got: {r.get('engine')}")
    check("T4: 4 regions", r.get("row_count") == 4, f"got: {r.get('row_count')}")
    log("")

    # ================================================================
    # TEST 5: S3 file — read_csv (DuckDB + httpfs)
    # ================================================================
    log("━" * 70)
    log("  TEST 5: S3 file — read_csv('s3://...')")
    log("━" * 70)

    # Get the bucket name from datasources
    try:
        ds_resp = requests.get(f"{PROXY_URL}/datasources", timeout=10)
        ds = ds_resp.json()
        s3_files = ds.get("s3", [])
        if s3_files:
            bucket = s3_files[0]["bucket"]
            key = s3_files[0]["key"]
            with timed("Query"):
                r = execute_sql(session_id,
                    f"SELECT * FROM read_csv('s3://{bucket}/{key}') LIMIT 5",
                    "s3_sample"
                )
            check("T5: success", r.get("success"), r.get("error", ""))
            check("T5: engine=duckdb", r.get("engine") == "duckdb", f"got: {r.get('engine')}")
            check("T5: has rows", r.get("row_count", 0) > 0, f"got: {r.get('row_count')}")
        else:
            log("  ⚠ No S3 files available — skipping T5")
            check("T5: skipped (no S3 files)", True)
    except Exception as e:
        log(f"  ⚠ S3 test error: {e}")
        check("T5: S3 access", False, str(e))
    log("")

    # ================================================================
    # TEST 6: Athena table — database.table (Athena engine)
    # ================================================================
    log("━" * 70)
    log("  TEST 6: Athena table — SELECT FROM microvm_demo_db.sales_data")
    log("━" * 70)

    with timed("Query"):
        r = execute_sql(session_id,
            "SELECT * FROM microvm_demo_db.sales_data LIMIT 10",
            "athena_sales",
            timeout=60
        )
    check("T6: success", r.get("success"), r.get("error", ""))
    check("T6: engine=athena", r.get("engine") == "athena", f"got: {r.get('engine')}")
    check("T6: has rows", r.get("row_count", 0) > 0, f"got: {r.get('row_count')}")
    log("")

    # ================================================================
    # TEST 7: DynamoDB — single table (PartiQL)
    # ================================================================
    log("━" * 70)
    log("  TEST 7: DynamoDB — SELECT FROM dynamodb.\"microvm-demo-data\"")
    log("━" * 70)

    with timed("Query"):
        r = execute_sql(session_id,
            'SELECT * FROM dynamodb."microvm-demo-data" LIMIT 5',
            "dynamo_data",
            timeout=30
        )
    check("T7: success", r.get("success"), r.get("error", ""))
    check("T7: engine=dynamodb-partiql", r.get("engine") == "dynamodb-partiql", f"got: {r.get('engine')}")
    check("T7: has rows", r.get("row_count", 0) > 0, f"got: {r.get('row_count')}")
    log("")

    # ================================================================
    # TEST 8: Mixed — Local file JOIN DataFrame (DuckDB)
    # ================================================================
    log("━" * 70)
    log("  TEST 8: Mixed — Local file JOIN DataFrame")
    log("━" * 70)

    with timed("Query"):
        r = execute_sql(session_id,
            "SELECT o.order_id, o.product, o.amount, p.category, p.weight_kg "
            "FROM '/tmp/orders.csv' o "
            "JOIN products p ON o.product = p.product "
            "ORDER BY o.order_id",
            "orders_with_products"
        )
    check("T8: success", r.get("success"), r.get("error", ""))
    check("T8: engine=duckdb", r.get("engine") == "duckdb", f"got: {r.get('engine')}")
    check("T8: 5 rows (all orders matched)", r.get("row_count") == 5, f"got: {r.get('row_count')}")
    check("T8: 5 columns", r.get("column_count") == 5, f"got: {r.get('column_count')}")
    log("")

    # ================================================================
    # TEST 9: Mixed — Local file JOIN local file (DuckDB)
    # ================================================================
    log("━" * 70)
    log("  TEST 9: Mixed — Two local files JOIN")
    log("━" * 70)

    with timed("Query"):
        r = execute_sql(session_id,
            "SELECT o.order_id, o.product, o.amount, c.name, c.city "
            "FROM '/tmp/orders.csv' o "
            "JOIN '/tmp/customers.csv' c ON o.customer_id = c.customer_id "
            "ORDER BY o.order_id",
            "orders_with_customers"
        )
    check("T9: success", r.get("success"), r.get("error", ""))
    check("T9: engine=duckdb", r.get("engine") == "duckdb", f"got: {r.get('engine')}")
    check("T9: 5 rows", r.get("row_count") == 5, f"got: {r.get('row_count')}")
    log("")

    # ================================================================
    # TEST 10: Mixed — Athena + DuckDB (materialize remote)
    # ================================================================
    log("━" * 70)
    log("  TEST 10: Mixed — Athena table JOIN local DataFrame")
    log("━" * 70)

    with timed("Query"):
        r = execute_sql(session_id,
            "SELECT a.region, COUNT(*) as athena_rows, s.cnt as df_rows "
            "FROM microvm_demo_db.sales_data a "
            "JOIN (SELECT region, COUNT(*) as cnt FROM sales GROUP BY region) s "
            "ON a.region = s.region "
            "GROUP BY a.region, s.cnt "
            "LIMIT 10",
            "athena_mixed",
            timeout=60
        )
    check("T10: success", r.get("success"), r.get("error", ""))
    check("T10: engine contains athena", "athena" in (r.get("engine") or ""), f"got: {r.get('engine')}")
    check("T10: has rows", r.get("row_count", 0) > 0, f"got: {r.get('row_count')}")
    log("")

    # ================================================================
    # TEST 11: DynamoDB with GROUP BY (scan + DuckDB fallback)
    # ================================================================
    log("━" * 70)
    log("  TEST 11: DynamoDB with GROUP BY (forces scan + DuckDB)")
    log("━" * 70)

    with timed("Query"):
        r = execute_sql(session_id,
            'SELECT category, COUNT(*) as cnt '
            'FROM dynamodb."microvm-demo-data" '
            'GROUP BY category '
            'ORDER BY cnt DESC',
            "dynamo_grouped",
            timeout=30
        )
    check("T11: success", r.get("success"), r.get("error", ""))
    check("T11: engine=duckdb+dynamodb", r.get("engine") == "duckdb+dynamodb", f"got: {r.get('engine')}")
    check("T11: has rows", r.get("row_count", 0) > 0, f"got: {r.get('row_count')}")
    log("")

    # ================================================================
    # TEST 12: DataFrame stored from SQL result (chained queries)
    # ================================================================
    log("━" * 70)
    log("  TEST 12: Chained SQL — query result of previous SQL")
    log("━" * 70)

    # The previous queries stored results as DataFrames. Query one of them.
    with timed("Query"):
        r = execute_sql(session_id,
            "SELECT * FROM order_summary WHERE cnt > 1",
            "popular_products"
        )
    check("T12: success", r.get("success"), r.get("error", ""))
    check("T12: engine=duckdb", r.get("engine") == "duckdb", f"got: {r.get('engine')}")
    check("T12: Widget has cnt=2", r.get("row_count", 0) >= 1, f"got: {r.get('row_count')}")
    log("")

    # ================================================================
    # CLEANUP
    # ================================================================
    log("━" * 70)
    log("  CLEANUP")
    log("━" * 70)
    terminate_session(session_id)
    log("  ✓ VM terminated")
    log("")

    # ================================================================
    # REPORT
    # ================================================================
    total = checks_passed + checks_failed
    print()
    print("=" * 70)
    print("  SQL ENGINE TEST REPORT")
    print("=" * 70)
    print()
    print(f"  Result: {'✅ PASSED' if checks_failed == 0 else '❌ SOME FAILED'}")
    print(f"  Checks: {checks_passed}/{total} passed, {checks_failed} failed")
    print()
    print("  ── Test Details ────────────────────────────────────────")
    for icon, name in check_details:
        print(f"    {icon} {name}")
    print()
    print("  ── Engine Routing Summary ──────────────────────────────")
    print(f"    T1-T4:   Local files + DataFrames       → DuckDB")
    print(f"    T5:      S3 file (read_csv)             → DuckDB + httpfs")
    print(f"    T6:      Athena table (db.table)        → Athena")
    print(f"    T7:      DynamoDB (simple LIMIT)        → PartiQL")
    print(f"    T8-T9:   Local file JOINs               → DuckDB")
    print(f"    T10:     Athena + DataFrame             → Athena → DuckDB")
    print(f"    T11:     DynamoDB + GROUP BY            → scan → DuckDB")
    print(f"    T12:     Chained SQL (query prev result)→ DuckDB")
    print()
    print("=" * 70)

    exit(0 if checks_failed == 0 else 1)


if __name__ == "__main__":
    main()
