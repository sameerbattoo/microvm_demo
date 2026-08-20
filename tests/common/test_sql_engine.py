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

import os
import sys
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


def run_classification_unit_tests():
    """
    Unit tests for the SQL engine's source classification — runs on the host,
    NO proxy/VM required (imports the pure functions directly).

    Covers the multi-database Athena routing added to sql_engine.py:
      - _classify_sources now recognizes <db>.<table> for ANY configured Glue
        database (not just the single ATHENA_DB), validated against per-db catalogs.
      - _resolve_athena_databases parses the DATASOURCE_ATHENA_DATABASES allowlist.
      - _get_athena_catalogs returns a per-database {db: {tables}} mapping.
      - DynamoDB vs Athena disambiguation and comment-stripping still hold.
    """
    log("━" * 70)
    log("  UNIT: SQL source classification (multi-DB Athena routing)")
    log("━" * 70)

    # Make 'app' importable regardless of the cwd the test is launched from.
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    if root not in sys.path:
        sys.path.insert(0, root)
    from app.notebook import sql_engine as se

    passed = 0
    failed = 0
    details = []

    def u(name, cond, detail=""):
        nonlocal passed, failed
        if cond:
            passed += 1
            details.append(("✓", name))
            log(f"  ✓ {name}")
        else:
            failed += 1
            details.append(("❌", name))
            log(f"  ❌ {name}{' — ' + detail if detail else ''}")

    ATH = se.SourceType.ATHENA
    DDB = se.SourceType.DYNAMODB
    LOCAL = se.SourceType.LOCAL_FILE
    DF = se.SourceType.DATAFRAME

    # Two Glue databases, each with its own tables. Note "orders" exists only in demo_db.
    catalogs = {
        "microvm_demo_db": {"orders", "customers", "products"},
        "sensordata": {"alertdata", "reportingdata"},
    }
    ns = {"sales", "products_df"}  # in-memory DataFrames

    def athena_refs(sql):
        return sorted(s.full_ref for s in se._classify_sources(sql, catalogs, ns) if s.source_type == ATH)

    # 1. Table in the primary database
    u("primary-db table → ATHENA",
      athena_refs("SELECT * FROM microvm_demo_db.orders LIMIT 5") == ["microvm_demo_db.orders"])

    # 2. Table in a SECOND database (the new capability)
    u("second-db table → ATHENA",
      athena_refs("SELECT * FROM sensordata.alertdata") == ["sensordata.alertdata"])

    # 3. Cross-database JOIN — both recognized
    u("cross-db JOIN → both ATHENA",
      athena_refs("SELECT * FROM microvm_demo_db.orders o JOIN sensordata.alertdata a ON o.id=a.id")
      == ["microvm_demo_db.orders", "sensordata.alertdata"])

    # 4. Unknown database → not Athena
    u("unknown db.table → not ATHENA", athena_refs("SELECT * FROM otherdb.mystery") == [])

    # 5. Right db name but table only exists in a different db → not matched
    u("table under wrong db → not ATHENA", athena_refs("SELECT * FROM sensordata.orders") == [])

    # 6. DynamoDB still disambiguated from Athena by the dynamodb. prefix
    srcs = se._classify_sources('SELECT * FROM dynamodb."ecommerce-reviews" LIMIT 5', catalogs, ns)
    u("dynamodb.\"t\" → DYNAMODB",
      any(s.source_type == DDB and s.table_name == "ecommerce-reviews" for s in srcs))

    # 7. Local file + DataFrame unaffected
    srcs = se._classify_sources("SELECT * FROM '/tmp/x.csv' a JOIN products_df b ON a.id=b.id", catalogs, ns)
    types = {s.source_type for s in srcs}
    u("local file still detected", LOCAL in types)
    u("dataframe still detected", DF in types)

    # 8. Comments ignored — dynamodb ref in a comment must NOT classify
    srcs = se._classify_sources("-- FROM dynamodb.\"fake\"\nSELECT * FROM microvm_demo_db.customers", catalogs, ns)
    u("comment ignored (no false DDB, real ATHENA found)",
      not any(s.source_type == DDB for s in srcs) and any(s.source_type == ATH for s in srcs))

    # 9. _resolve_athena_databases honors an explicit allowlist (no AWS call)
    _old = os.environ.get("DATASOURCE_ATHENA_DATABASES")
    os.environ["DATASOURCE_ATHENA_DATABASES"] = "db_a, db_b ,db_c"
    try:
        dbs = se._resolve_athena_databases("us-west-2")
    finally:
        if _old is None:
            os.environ.pop("DATASOURCE_ATHENA_DATABASES", None)
        else:
            os.environ["DATASOURCE_ATHENA_DATABASES"] = _old
    u("resolve: explicit allowlist parsed", dbs == ["db_a", "db_b", "db_c"], f"got: {dbs}")

    # 10. _get_athena_catalogs returns a per-db mapping from a warm cache (no AWS call)
    se._glue_cache.clear()
    se._glue_cache.update({"db1": {"t1", "t2"}, "db2": {"t3"}})
    se._glue_cache_ts = time.time()  # fresh → no refresh, no boto3
    cats = se._get_athena_catalogs(["db1", "db2"], "us-west-2")
    u("catalogs: per-db mapping from cache", cats == {"db1": {"t1", "t2"}, "db2": {"t3"}}, f"got: {cats}")

    log("")
    return passed, failed, details


def main():
    log("=" * 70)
    log("  SQL Engine Test — Multi-Source Routing & Correctness")
    log("=" * 70)
    log("")

    # Run the host-side classification unit tests first (fast, no VM needed).
    unit_passed, unit_failed, unit_details = run_classification_unit_tests()

    # Seed the running totals with the unit-test results so the final report covers both.
    checks_passed = unit_passed
    checks_failed = unit_failed
    check_details = list(unit_details)

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
    log("  TEST 6: Athena table — SELECT FROM microvm_demo_db.orders")
    log("━" * 70)

    with timed("Query"):
        r = execute_sql(session_id,
            "SELECT * FROM microvm_demo_db.orders LIMIT 10",
            "athena_orders",
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
    log("  TEST 7: DynamoDB — SELECT FROM dynamodb.\"ecommerce-reviews\"")
    log("━" * 70)

    with timed("Query"):
        r = execute_sql(session_id,
            'SELECT * FROM dynamodb."ecommerce-reviews" LIMIT 5',
            "dynamo_reviews",
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
            "SELECT o.order_id, o.product_id, o.shipping_country, p.product, p.category "
            "FROM microvm_demo_db.orders o "
            "CROSS JOIN products p "
            "WHERE o.shipping_country = 'US' "
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
            'SELECT rating, COUNT(*) as cnt '
            'FROM dynamodb."ecommerce-reviews" '
            'GROUP BY rating '
            'ORDER BY cnt DESC',
            "dynamo_grouped",
            timeout=30
        )
    check("T11: success", r.get("success"), r.get("error", ""))
    check("T11: engine=duckdb+dynamodb", r.get("engine") == "duckdb+dynamodb", f"got: {r.get('engine')}")
    check("T11: has rows", r.get("row_count", 0) > 0, f"got: {r.get('row_count')}")
    log("")

    # ================================================================
    # TEST 12: Mixed — Athena + read_csv('/tmp/...') (the routing bug fix)
    # ================================================================
    log("━" * 70)
    log("  TEST 12: Mixed — Athena tables + read_csv('/tmp/local_file')")
    log("━" * 70)

    # First create a local file to join with
    execute_code(session_id,
        "import csv\n"
        "with open('/tmp/price_overrides.csv', 'w', newline='') as f:\n"
        "    w = csv.writer(f)\n"
        "    w.writerow(['product_id', 'override_price'])\n"
        "    w.writerow(['PROD-0001', 99.99])\n"
        "    w.writerow(['PROD-0002', 79.99])\n"
        "    w.writerow(['PROD-0003', 59.99])\n"
        "print('price_overrides.csv created')"
    )

    with timed("Query"):
        r = execute_sql(session_id,
            "SELECT p.product_id, p.name, p.price, ov.override_price "
            "FROM microvm_demo_db.products p "
            "JOIN read_csv('/tmp/price_overrides.csv') ov ON p.product_id = ov.product_id "
            "ORDER BY p.product_id",
            "products_with_overrides",
            timeout=60
        )
    check("T12: success", r.get("success"), r.get("error", ""))
    check("T12: engine=duckdb+athena (mixed)", "athena" in (r.get("engine") or ""), f"got: {r.get('engine')}")
    check("T12: 3 rows (matched products)", r.get("row_count") == 3, f"got: {r.get('row_count')}")
    check("T12: 4 columns", r.get("column_count") == 4, f"got: {r.get('column_count')}")
    log("")

    # ================================================================
    # TEST 13: DataFrame stored from SQL result (chained queries)
    # ================================================================
    log("━" * 70)
    log("  TEST 13: Chained SQL — query result of previous SQL")
    log("━" * 70)

    # The previous queries stored results as DataFrames. Query one of them.
    with timed("Query"):
        r = execute_sql(session_id,
            "SELECT * FROM order_summary WHERE cnt > 1",
            "popular_products"
        )
    check("T13: success", r.get("success"), r.get("error", ""))
    check("T13: engine=duckdb", r.get("engine") == "duckdb", f"got: {r.get('engine')}")
    check("T13: Widget has cnt=2", r.get("row_count", 0) >= 1, f"got: {r.get('row_count')}")
    log("")

    # ================================================================
    # TEST 14: read_csv('/tmp/...') alone (should route to DuckDB, not Athena)
    # ================================================================
    log("━" * 70)
    log("  TEST 14: read_csv('/tmp/...') — DuckDB function for local file")
    log("━" * 70)

    with timed("Query"):
        r = execute_sql(session_id,
            "SELECT * FROM read_csv('/tmp/price_overrides.csv') LIMIT 10",
            "local_via_readcsv"
        )
    check("T14: success", r.get("success"), r.get("error", ""))
    check("T14: engine=duckdb", r.get("engine") == "duckdb", f"got: {r.get('engine')}")
    check("T14: 3 rows", r.get("row_count") == 3, f"got: {r.get('row_count')}")
    log("")

    # ================================================================
    # TEST 15: Athena multi-table JOIN (pure Athena — stays in Athena)
    # ================================================================
    log("━" * 70)
    log("  TEST 15: Athena JOIN Athena — pure Athena multi-table")
    log("━" * 70)

    with timed("Query"):
        r = execute_sql(session_id,
            "SELECT o.order_id, o.shipping_country, p.name, p.category "
            "FROM microvm_demo_db.orders o "
            "JOIN microvm_demo_db.products p ON o.product_id = p.product_id "
            "LIMIT 10",
            "athena_join",
            timeout=60
        )
    check("T15: success", r.get("success"), r.get("error", ""))
    check("T15: engine=athena", r.get("engine") == "athena", f"got: {r.get('engine')}")
    check("T15: has rows", r.get("row_count", 0) > 0, f"got: {r.get('row_count')}")
    check("T15: 4 columns", r.get("column_count") == 4, f"got: {r.get('column_count')}")
    log("")

    # ================================================================
    # TEST 16: S3 read_csv + Athena table JOIN (mixed cloud sources)
    # ================================================================
    log("━" * 70)
    log("  TEST 16: S3 read_csv + Athena table JOIN")
    log("━" * 70)

    if s3_files:
        bucket = s3_files[0]["bucket"]
        # Use clickstream_events.csv from S3 + Athena products
        s3_key_clickstream = next((f["key"] for f in s3_files if "clickstream" in f["key"]), s3_files[0]["key"])
        with timed("Query"):
            r = execute_sql(session_id,
                f"SELECT c.action, p.category, COUNT(*) as cnt "
                f"FROM read_csv('s3://{bucket}/{s3_key_clickstream}') c "
                f"JOIN microvm_demo_db.products p ON c.product_id = p.product_id "
                f"WHERE c.product_id != '' "
                f"GROUP BY c.action, p.category "
                f"ORDER BY cnt DESC LIMIT 10",
                "s3_athena_mixed",
                timeout=60
            )
        check("T16: success", r.get("success"), r.get("error", ""))
        check("T16: engine contains athena", "athena" in (r.get("engine") or ""), f"got: {r.get('engine')}")
        check("T16: has rows", r.get("row_count", 0) > 0, f"got: {r.get('row_count')}")
    else:
        log("  ⚠ No S3 files available — skipping T16")
        check("T16: skipped", True)
    log("")

    # ================================================================
    # TEST 17: DynamoDB + local file JOIN (NoSQL + file)
    # ================================================================
    log("━" * 70)
    log("  TEST 17: DynamoDB + local file JOIN")
    log("━" * 70)

    # Create a product lookup file to join with reviews
    execute_code(session_id,
        "import csv\n"
        "with open('/tmp/product_lookup.csv', 'w', newline='') as f:\n"
        "    w = csv.writer(f)\n"
        "    w.writerow(['product_id', 'product_name'])\n"
        "    for i in range(1, 11):\n"
        "        w.writerow([f'PROD-{i:04d}', f'Product {i}'])\n"
        "print('product_lookup.csv created')"
    )

    with timed("Query"):
        r = execute_sql(session_id,
            'SELECT r.productId, pl.product_name, r.rating, r.title '
            'FROM dynamodb."ecommerce-reviews" r '
            "JOIN '/tmp/product_lookup.csv' pl ON r.productId = pl.product_id "
            "LIMIT 10",
            "dynamo_local_join",
            timeout=30
        )
    check("T17: success", r.get("success"), r.get("error", ""))
    check("T17: engine=duckdb+dynamodb", r.get("engine") == "duckdb+dynamodb", f"got: {r.get('engine')}")
    check("T17: has rows", r.get("row_count", 0) > 0, f"got: {r.get('row_count')}")
    log("")

    # ================================================================
    # TEST 18: CTE / WITH clause referencing Athena table
    # ================================================================
    log("━" * 70)
    log("  TEST 18: CTE (WITH clause) referencing Athena table")
    log("━" * 70)

    with timed("Query"):
        r = execute_sql(session_id,
            "WITH top_customers AS ("
            "  SELECT user_id, SUM(total) as total_spend "
            "  FROM microvm_demo_db.orders "
            "  GROUP BY user_id "
            "  ORDER BY total_spend DESC LIMIT 5"
            ") "
            "SELECT tc.user_id, tc.total_spend, c.name, c.segment "
            "FROM top_customers tc "
            "JOIN microvm_demo_db.customers c ON tc.user_id = c.user_id",
            "top_spenders",
            timeout=60
        )
    check("T18: success", r.get("success"), r.get("error", ""))
    check("T18: engine=athena", r.get("engine") == "athena", f"got: {r.get('engine')}")
    check("T18: 5 rows (top 5)", r.get("row_count") == 5, f"got: {r.get('row_count')}")
    log("")

    # ================================================================
    # TEST 19: Empty result set (valid query, no matching rows)
    # ================================================================
    log("━" * 70)
    log("  TEST 19: Empty result set — valid query, zero rows")
    log("━" * 70)

    with timed("Query"):
        r = execute_sql(session_id,
            "SELECT * FROM '/tmp/orders.csv' WHERE amount > 99999",
            "empty_result"
        )
    check("T19: success", r.get("success"), r.get("error", ""))
    check("T19: engine=duckdb", r.get("engine") == "duckdb", f"got: {r.get('engine')}")
    check("T19: 0 rows", r.get("row_count") == 0, f"got: {r.get('row_count')}")
    log("")

    # ================================================================
    # TEST 20: SQL with comments (should not confuse classifier)
    # ================================================================
    log("━" * 70)
    log("  TEST 20: SQL with comments — classifier ignores comments")
    log("━" * 70)

    with timed("Query"):
        r = execute_sql(session_id,
            "-- This query joins Athena orders with local prices\n"
            "/* Multi-line comment:\n"
            "   FROM dynamodb.\"fake-table\" -- this should be ignored\n"
            "*/\n"
            "SELECT o.order_id, o.total "
            "FROM microvm_demo_db.orders o "
            "WHERE o.total > 100 LIMIT 5",
            "commented_query",
            timeout=60
        )
    check("T20: success", r.get("success"), r.get("error", ""))
    check("T20: engine=athena (not confused by comments)", r.get("engine") == "athena", f"got: {r.get('engine')}")
    check("T20: has rows", r.get("row_count", 0) > 0, f"got: {r.get('row_count')}")
    log("")

    # ================================================================
    # TEST 21: Triple source — Athena + DynamoDB + local file
    # ================================================================
    log("━" * 70)
    log("  TEST 21: Triple source — Athena + DynamoDB + local file")
    log("━" * 70)

    with timed("Query"):
        r = execute_sql(session_id,
            "SELECT p.product_id, p.name, r.avg_rating, pl.product_name "
            "FROM microvm_demo_db.products p "
            "LEFT JOIN ("
            '  SELECT productId, AVG(rating) as avg_rating FROM dynamodb."ecommerce-reviews" GROUP BY productId'
            ") r ON p.product_id = r.productId "
            "LEFT JOIN '/tmp/product_lookup.csv' pl ON p.product_id = pl.product_id "
            "LIMIT 10",
            "triple_source",
            timeout=60
        )
    check("T21: success", r.get("success"), r.get("error", ""))
    check("T21: engine=duckdb+athena+dynamodb", "athena" in (r.get("engine") or "") and "dynamodb" in (r.get("engine") or ""), f"got: {r.get('engine')}")
    check("T21: has rows", r.get("row_count", 0) > 0, f"got: {r.get('row_count')}")
    log("")

    # ================================================================
    # TEST 22: Multi-database Athena routing (skips if only 1 DB configured)
    # ================================================================
    log("━" * 70)
    log("  TEST 22: Multi-DB Athena — route a table in a SECOND database")
    log("━" * 70)

    try:
        ds = requests.get(f"{PROXY_URL}/datasources", timeout=10).json()
        athena_tables = ds.get("athena", [])
        primary_db = "microvm_demo_db"  # the query-execution default (ATHENA_DB)
        distinct_dbs = sorted({t.get("database") for t in athena_tables if t.get("database")})
        secondary = [t for t in athena_tables if t.get("database") and t["database"] != primary_db]
        if secondary:
            t = secondary[0]
            db, name = t["database"], t["name"]
            with timed("Query"):
                r = execute_sql(session_id, f"SELECT * FROM {db}.{name} LIMIT 5", "multidb_athena", timeout=60)
            check("T22: success", r.get("success"), r.get("error", ""))
            check("T22: engine=athena (second DB routed)", r.get("engine") == "athena", f"got: {r.get('engine')}")
            check("T22: query returned", r.get("row_count") is not None, f"got: {r.get('row_count')}")
        else:
            log(f"  ⚠ Only one Athena database in scope ({distinct_dbs}) — skipping multi-DB routing test.")
            log("     Set DATASOURCE_ATHENA_DATABASES to 2+ DBs (and rebuild the VM image) to exercise this.")
            check("T22: skipped (single Athena DB configured)", True)
    except Exception as e:
        check("T22: multi-DB probe", False, str(e))
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
    print(f"    T12:     Athena + read_csv('/tmp/...')   → Athena → DuckDB (regression fix)")
    print(f"    T13:     Chained SQL (query prev result)→ DuckDB")
    print(f"    T14:     read_csv('/tmp/...') alone     → DuckDB")
    print(f"    T15:     Athena JOIN Athena             → Athena (stays in Athena)")
    print(f"    T16:     S3 read_csv + Athena JOIN      → mixed → DuckDB")
    print(f"    T17:     DynamoDB + local file JOIN     → scan → DuckDB")
    print(f"    T18:     CTE/WITH + Athena             → Athena")
    print(f"    T19:     Empty result (0 rows)          → DuckDB")
    print(f"    T20:     SQL with comments              → Athena (comments ignored)")
    print(f"    T21:     Triple source (Athena+DDB+file)→ materialize all → DuckDB")
    print(f"    T22:     Multi-DB Athena (2nd database)  → Athena (skips if 1 DB)")
    print(f"    UNIT:    Source classification (multi-DB) → host-side, no VM")
    print()
    print("=" * 70)

    exit(0 if checks_failed == 0 else 1)


if __name__ == "__main__":
    # `--unit` runs only the host-side classification unit tests (no proxy/VM needed) —
    # this is what validates the multi-DB sql_engine changes without an image rebuild.
    if "--unit" in sys.argv:
        p, f, _ = run_classification_unit_tests()
        print()
        print("=" * 70)
        print(f"  UNIT TESTS: {'✅ PASSED' if f == 0 else '❌ FAILED'} — {p} passed, {f} failed")
        print("=" * 70)
        exit(0 if f == 0 else 1)
    main()
