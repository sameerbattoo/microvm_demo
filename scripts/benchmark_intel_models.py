#!/usr/bin/env python3
"""
Benchmark: Full Workbook Intel lifecycle across multiple LLM models.

Tests 4 flows per model:
  1. COMPLETE Phase 1 — agent + tools → tab cards (analyses, viz, investigations, alerts)
  2. COMPLETE Phase 2 — single-shot → full_report + relationships
  3. INCREMENTAL — upload product_returns.csv → delta intel
  4. DELETION — delete product_returns.csv → prune intel

Judge (Opus 4.8) evaluates Phase 1 quality and Phase 2 quality separately.

Prerequisites:
  - Proxy running on localhost:8081 (./aws_microvm_run.sh)
  - tests/product_returns.csv exists

Usage:
  python3 scripts/benchmark_intel_models.py
  python3 scripts/benchmark_intel_models.py --session <existing-session-id>
  python3 scripts/benchmark_intel_models.py --no-judge
"""

import argparse
import json
import logging
import os
import sys
import time
from datetime import datetime, timezone

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PROJECT_ROOT)
os.chdir(PROJECT_ROOT)

import boto3
import httpx
from botocore.config import Config as BotoConfig

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
PROXY_URL = "http://localhost:8081"
AWS_REGION = os.environ.get("AWS_REGION", "us-west-2")
ARTIFACT_BUCKET = os.environ.get("ARTIFACT_BUCKET", "")
SAMPLE_NOTEBOOK = os.path.join(PROJECT_ROOT, "web/public/samples/aws_data_sources.notebook.json")
TEST_CSV = os.path.join(PROJECT_ROOT, "tests/product_returns.csv")

DEFAULT_MODELS = [
    "us.anthropic.claude-sonnet-4-6",
    "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    "us.amazon.nova-2-lite-v1:0",
]
DEFAULT_JUDGE_MODEL = "us.anthropic.claude-opus-4-8"
AGENT_MAX_TOKENS = 32768
AGENT_TEMPERATURE = 0.2

logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("botocore").setLevel(logging.WARNING)
logging.getLogger("strands").setLevel(logging.WARNING)


# ---------------------------------------------------------------------------
# Setup: Launch VM + Execute Cells
# ---------------------------------------------------------------------------
def setup_session() -> str:
    print("\n" + "=" * 60)
    print("SETUP: Launch MicroVM + Execute Sample Notebook")
    print("=" * 60)

    # Check proxy
    proxy_ok = False
    for _ in range(3):
        try:
            r = httpx.get(f"{PROXY_URL}/instances", timeout=10)
            if r.status_code == 200:
                proxy_ok = True
                break
        except:
            time.sleep(2)
    if not proxy_ok:
        print(f"  ERROR: Proxy not reachable at {PROXY_URL}")
        print(f"  Start it: cd {PROJECT_ROOT} && ./aws_microvm_run.sh")
        sys.exit(1)
    print("  Proxy OK")

    # Launch VM
    resp = httpx.post(f"{PROXY_URL}/launch", json={"name": "Intel Benchmark", "memory_mib": 2048}, timeout=60)
    if resp.status_code != 200:
        print(f"  ERROR: Launch failed: {resp.status_code}")
        sys.exit(1)
    session_id = resp.json().get("sessionId")
    print(f"  Session: {session_id}")

    # Wait ready
    headers = {"X-Session-Id": session_id}
    for _ in range(30):
        try:
            r = httpx.get(f"{PROXY_URL}/proxy/variables", headers=headers, timeout=10)
            if r.status_code == 200:
                break
        except:
            pass
        time.sleep(2)

    # Execute sample notebook
    with open(SAMPLE_NOTEBOOK) as f:
        nb = json.load(f)
    cells = [c for c in nb["cells"] if c["type"] == "code" and c.get("code", "").strip()]
    print(f"  Executing {len(cells)} cells...")
    for i, cell in enumerate(cells):
        resp = httpx.post(f"{PROXY_URL}/proxy/execute", headers=headers, json={"code": cell["code"]}, timeout=120)
        ok = resp.status_code == 200 and not resp.json().get("error")
        print(f"    [{i+1}/{len(cells)}] {'OK' if ok else 'ERR'}")

    print("  Setup complete")
    return session_id


# ---------------------------------------------------------------------------
# Flow 1: COMPLETE Phase 1 (agent + tools -> tab cards)
# ---------------------------------------------------------------------------
def run_complete_phase1(session_id: str, model_id: str, entity_docs: str) -> dict:
    from strands import Agent
    from strands.models import BedrockModel
    from strands.models.bedrock import CacheConfig
    from strands.agent.conversation_manager import SlidingWindowConversationManager
    from proxy.notebook.ai.prompts import INTEL_PROMPT, NOTEBOOK_AGENT_PROMPT
    from proxy.notebook.ai.tools.execution_tools import (
        execute_code, get_variables, get_notebook_state,
        install_package, get_available_data_sources, set_execution_context
    )
    from proxy.notebook.ai.workbook_intel import _extract_intel_json

    context = {"proxy_url": PROXY_URL, "session_id": session_id, "notebook_cells": [],
               "memory_mib": 2048, "data_sources": None, "packages": [], "uploaded_files": []}
    set_execution_context(context)

    model_kwargs = dict(model_id=model_id, region_name=AWS_REGION,
                        temperature=AGENT_TEMPERATURE, max_tokens=AGENT_MAX_TOKENS)
    if "anthropic" in model_id.lower():
        model_kwargs["cache_config"] = CacheConfig(strategy="auto")
        model_kwargs["cache_tools"] = "default"

    from datetime import datetime as dt, timezone as tz
    now = dt.now(tz.utc)
    system_prompt = NOTEBOOK_AGENT_PROMPT.format(
        current_time=now.strftime("%Y-%m-%d %H:%M UTC (%A)"), aws_region=AWS_REGION,
        memory_tier="2048 MB (2.0 GB / 1.0 vCPU)",
        athena_workgroup=os.environ.get("ATHENA_WORKGROUP", "microvm-demo"),
        athena_db=os.environ.get("ATHENA_DB", "microvm_demo_db"), s3_bucket=ARTIFACT_BUCKET,
        dynamo_table_prefix=os.environ.get("DYNAMO_TABLE", "microvm-demo").rsplit("-", 1)[0] + "-",
    )

    agent = Agent(model=BedrockModel(**model_kwargs), system_prompt=system_prompt,
                  tools=[execute_code, get_variables, get_notebook_state, install_package, get_available_data_sources],
                  conversation_manager=SlidingWindowConversationManager(window_size=10))

    intel_prompt = INTEL_PROMPT.format(entity_docs=entity_docs,
        catalog_json="[Use get_available_data_sources tool if needed]",
        notebook_state="[Use get_variables tool]",
        variables="[Use execute_code SPARINGLY]")

    t0 = time.time()
    try:
        result = agent(intel_prompt)
        raw = str(result).strip()
        elapsed = time.time() - t0
        intel = _extract_intel_json(raw)
        return {"success": bool(intel), "seconds": round(elapsed, 1),
                "intel": intel, "raw_chars": len(raw), "error": None}
    except Exception as e:
        return {"success": False, "seconds": round(time.time() - t0, 1),
                "intel": None, "raw_chars": 0, "error": str(e)[:500]}


# ---------------------------------------------------------------------------
# Flow 2: COMPLETE Phase 2 (single-shot -> full_report + relationships)
# ---------------------------------------------------------------------------
def run_complete_phase2(model_id: str, entity_docs: str, phase1_intel: dict) -> dict:
    from proxy.notebook.ai.prompts import INTEL_REPORT_PROMPT
    from proxy.notebook.ai.workbook_intel import _extract_intel_json

    structured = json.dumps({k: phase1_intel.get(k, []) for k in
        ["suggested_analyses", "visualizations", "investigations", "alerts", "data_landscape"]}, indent=2)

    prompt = INTEL_REPORT_PROMPT.format(entity_docs=entity_docs, structured_findings=structured)

    client = boto3.client("bedrock-runtime", region_name=AWS_REGION,
                          config=BotoConfig(retries={"max_attempts": 3}, read_timeout=180))

    infer_config = {"maxTokens": AGENT_MAX_TOKENS, "temperature": 0.2}
    if "amazon" in model_id.lower():
        infer_config = {"maxTokens": min(AGENT_MAX_TOKENS, 10000)}

    t0 = time.time()
    try:
        resp = client.converse(modelId=model_id,
            messages=[{"role": "user", "content": [{"text": prompt}]}],
            inferenceConfig=infer_config)
        raw = resp["output"]["message"]["content"][0]["text"].strip()
        elapsed = time.time() - t0

        # Parse JSON
        try:
            data = json.loads(raw)
        except:
            from proxy.notebook.ai.workbook_intel import _extract_json_object
            data = _extract_json_object(raw)

        if data and isinstance(data, dict):
            return {"success": True, "seconds": round(elapsed, 1),
                    "full_report_chars": len(data.get("full_report", "")),
                    "relationships_count": len(data.get("relationships", [])),
                    "data": data, "error": None}
        else:
            return {"success": True, "seconds": round(elapsed, 1),
                    "full_report_chars": len(raw), "relationships_count": 0,
                    "data": {"full_report": raw[:15000], "relationships": []}, "error": None}
    except Exception as e:
        return {"success": False, "seconds": round(time.time() - t0, 1),
                "full_report_chars": 0, "relationships_count": 0, "data": None, "error": str(e)[:500]}


# ---------------------------------------------------------------------------
# Flow 3: INCREMENTAL (upload file -> delta intel)
# ---------------------------------------------------------------------------
def run_incremental(session_id: str, model_id: str, entity_docs: str, existing_intel: dict) -> dict:
    from proxy.notebook.ai.prompts import INTEL_INCREMENTAL_PROMPT
    from proxy.notebook.ai.workbook_intel import _extract_intel_json

    # Upload the test CSV to the VM
    headers = {"X-Session-Id": session_id}
    with open(TEST_CSV, "rb") as f:
        files = {"file": ("product_returns.csv", f, "text/csv")}
        httpx.post(f"{PROXY_URL}/proxy/upload", headers=headers, files=files, timeout=30)

    # Build the incremental prompt (simulating what the real flow does)
    # We need a new_file_doc — let's create a minimal one
    new_file_doc = f"""# product_returns.csv (local /tmp file)
**Type:** CSV | **Rows:** 100 | **Columns:** 13
## Schema
| Column | Type | Sample |
|--------|------|--------|
| return_id | string | RET-00001 |
| order_id | string | ORD-00001 |
| user_id | string | USR-0320 |
| product_id | string | PROD-0079 |
| category | string | Beauty |
| return_date | string | 2024-11-04 |
| days_to_return | int | 25 |
| return_reason | string | defective |
| quantity | int | 2 |
| refund_amount | float | 316.75 |
| restocking_fee | float | 0.0 |
| item_condition | string | resellable_used |
| resolution | string | refund |
"""
    # Build compact summary of existing intel
    existing_summary = json.dumps({
        "suggested_analyses": [a.get("title") for a in existing_intel.get("suggested_analyses", [])],
        "visualizations": [v.get("title") for v in existing_intel.get("visualizations", [])],
        "investigations": [i.get("title") for i in existing_intel.get("investigations", [])],
        "alerts": [a.get("message", "")[:80] for a in existing_intel.get("alerts", [])],
    }, indent=2)

    prompt = INTEL_INCREMENTAL_PROMPT.format(
        existing_report_json=existing_summary,
        new_file_doc=new_file_doc,
        entity_summaries=entity_docs[:15000],
    )

    client = boto3.client("bedrock-runtime", region_name=AWS_REGION,
                          config=BotoConfig(retries={"max_attempts": 3}, read_timeout=120))

    infer_config = {"maxTokens": AGENT_MAX_TOKENS, "temperature": 0.2}
    if "amazon" in model_id.lower():
        infer_config = {"maxTokens": min(AGENT_MAX_TOKENS, 10000)}

    t0 = time.time()
    try:
        resp = client.converse(modelId=model_id,
            messages=[{"role": "user", "content": [{"text": prompt}]}],
            inferenceConfig=infer_config)
        raw = resp["output"]["message"]["content"][0]["text"].strip()
        elapsed = time.time() - t0

        try:
            data = json.loads(raw)
        except:
            from proxy.notebook.ai.workbook_intel import _extract_json_object
            data = _extract_json_object(raw)

        success = isinstance(data, dict) and data.get("new_source_label")
        return {"success": success, "seconds": round(elapsed, 1),
                "new_items": (len(data.get("suggested_analyses", [])) + len(data.get("visualizations", []))
                              + len(data.get("investigations", [])) + len(data.get("alerts", []))
                              + len(data.get("relationships", []))) if data else 0,
                "data": data, "error": None}
    except Exception as e:
        return {"success": False, "seconds": round(time.time() - t0, 1),
                "new_items": 0, "data": None, "error": str(e)[:500]}


# ---------------------------------------------------------------------------
# Flow 4: DELETION (delete file -> prune intel)
# ---------------------------------------------------------------------------
def run_deletion(model_id: str, existing_intel: dict) -> dict:
    from proxy.notebook.ai.prompts import INTEL_DELETION_PROMPT

    # The deletion prompt needs the full existing intel + the deleted file name
    prompt = INTEL_DELETION_PROMPT.format(
        deleted_source_label="product_returns.csv",
        existing_report_json=json.dumps(existing_intel, indent=2)[:20000],
    )

    client = boto3.client("bedrock-runtime", region_name=AWS_REGION,
                          config=BotoConfig(retries={"max_attempts": 3}, read_timeout=120))

    infer_config = {"maxTokens": 4096, "temperature": 0.0}
    if "amazon" in model_id.lower():
        infer_config = {"maxTokens": 4096}

    t0 = time.time()
    try:
        resp = client.converse(modelId=model_id,
            messages=[{"role": "user", "content": [{"text": prompt}]}],
            inferenceConfig=infer_config)
        raw = resp["output"]["message"]["content"][0]["text"].strip()
        elapsed = time.time() - t0

        try:
            data = json.loads(raw)
        except:
            from proxy.notebook.ai.workbook_intel import _extract_json_object
            data = _extract_json_object(raw)

        success = isinstance(data, dict)
        removed = sum(len(data.get(k, [])) for k in
            ["remove_analyses", "remove_visualizations", "remove_investigations",
             "remove_alerts", "remove_relationships"]) if data else 0
        return {"success": success, "seconds": round(elapsed, 1),
                "removed_items": removed, "data": data, "error": None}
    except Exception as e:
        return {"success": False, "seconds": round(time.time() - t0, 1),
                "removed_items": 0, "data": None, "error": str(e)[:500]}


# ---------------------------------------------------------------------------
# Judge
# ---------------------------------------------------------------------------
def judge_responses(all_results: dict, judge_model_id: str) -> list:
    judge_prompt = """You are evaluating AI-generated Workbook Intelligence across 4 flows per model.

For each model, score these separately (1-10):
- **phase1_score**: Quality of tab cards (analyses, viz, investigations, alerts). Are prompts specific? Numbers accurate?
- **phase2_score**: Quality of full_report markdown + relationships with JOIN SQL.
- **incremental_score**: Quality of delta findings when a new file is added. Are new items relevant to the new file?
- **deletion_score**: Quality of removal decisions. Did it correctly identify items tied to the deleted file?
- **overall**: Weighted average (Phase1 most important, then incremental, then Phase2, then deletion)

Also provide reasoning (4-6 sentences) and a verdict.

Return ONLY a JSON array:
[
  {{"model": "model_id", "phase1_score": N, "phase2_score": N, "incremental_score": N, "deletion_score": N, "overall": N, "reasoning": "...", "verdict": "..."}}
]

--- RESULTS ---

"""
    for model_id, flows in all_results.items():
        model_short = model_id.split(".")[-1][:30]
        judge_prompt += f"\n### {model_short}\n"
        # Phase 1
        p1 = flows["phase1"]
        if p1["success"]:
            judge_prompt += f"**Phase 1** ({p1['seconds']}s): {json.dumps(p1['intel'], indent=2)[:4000]}\n"
        else:
            judge_prompt += f"**Phase 1**: FAILED - {p1.get('error','')[:100]}\n"
        # Phase 2
        p2 = flows["phase2"]
        if p2["success"]:
            judge_prompt += f"**Phase 2** ({p2['seconds']}s): report={p2['full_report_chars']} chars, relationships={p2['relationships_count']}\n"
            if p2.get("data", {}).get("full_report"):
                judge_prompt += f"Report preview: {p2['data']['full_report'][:1500]}\n"
        else:
            judge_prompt += f"**Phase 2**: FAILED - {(p2.get('error') or '')[:100]}\n"
        # Incremental
        inc = flows["incremental"]
        if inc["success"]:
            judge_prompt += f"**Incremental** ({inc['seconds']}s, {inc['new_items']} new items): {json.dumps(inc['data'], indent=2)[:3000]}\n"
        else:
            judge_prompt += f"**Incremental**: FAILED - {(inc.get('error') or '')[:100]}\n"
        # Deletion
        dl = flows["deletion"]
        if dl["success"]:
            judge_prompt += f"**Deletion** ({dl['seconds']}s, {dl['removed_items']} removed): {json.dumps(dl['data'], indent=2)[:2000]}\n"
        else:
            judge_prompt += f"**Deletion**: FAILED - {(dl.get('error') or '')[:100]}\n"

    print(f"\n{'='*60}")
    print("JUDGE EVALUATION")
    print(f"{'='*60}")
    print("  Invoking judge...")

    client = boto3.client("bedrock-runtime", region_name=AWS_REGION,
                          config=BotoConfig(retries={"max_attempts": 3}, read_timeout=180))
    t0 = time.time()
    resp = client.converse(modelId=judge_model_id,
        messages=[{"role": "user", "content": [{"text": judge_prompt}]}],
        inferenceConfig={"maxTokens": 8192})
    print(f"  Judge responded in {time.time()-t0:.1f}s")

    text = resp["output"]["message"]["content"][0]["text"]
    try:
        import re
        if "```" in text:
            m = re.search(r"```(?:json)?\s*(.*?)```", text, re.DOTALL)
            if m: text = m.group(1)
        return json.loads(text.strip())
    except:
        print(f"  WARNING: Judge parse failed. Raw:\n{text[:500]}")
        return []


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--session", type=str)
    parser.add_argument("--models", type=str)
    parser.add_argument("--no-judge", action="store_true")
    parser.add_argument("--judge-model", type=str, default=DEFAULT_JUDGE_MODEL)
    args = parser.parse_args()

    # Load config
    global ARTIFACT_BUCKET
    if not ARTIFACT_BUCKET:
        import subprocess
        r = subprocess.run(["bash", "-c", "source scripts/config.sh && echo $ARTIFACT_BUCKET"],
                          capture_output=True, text=True, cwd=PROJECT_ROOT)
        ARTIFACT_BUCKET = r.stdout.strip()
        os.environ["ARTIFACT_BUCKET"] = ARTIFACT_BUCKET
    os.environ.setdefault("AWS_REGION", AWS_REGION)
    os.environ.setdefault("ATHENA_WORKGROUP", "microvm-demo")
    os.environ.setdefault("ATHENA_DB", "microvm_demo_db")
    os.environ.setdefault("DYNAMO_TABLE", "microvm-demo-data")

    models = args.models.split(",") if args.models else DEFAULT_MODELS

    print("=" * 60)
    print("WORKBOOK INTEL FULL LIFECYCLE BENCHMARK")
    print("=" * 60)
    print(f"Models: {', '.join(m.split('.')[-1][:20] for m in models)}")
    print(f"Flows: Phase1 + Phase2 + Incremental + Deletion")

    # Setup
    session_id = args.session or setup_session()

    # Fetch entity docs (shared)
    print("\n  Fetching entity profiles...")
    from proxy.notebook.ai.workbook_intel import _fetch_relevant_entity_docs
    from proxy.storage import storage
    storage.initialize()
    entity_docs = _fetch_relevant_entity_docs(session_id, PROXY_URL, ARTIFACT_BUCKET, storage)
    print(f"  Entity profiles: {len(entity_docs)} chars")

    # Run all flows per model
    all_results = {}
    for i, model_id in enumerate(models):
        model_short = model_id.split(".")[-1][:25]
        print(f"\n{'='*60}")
        print(f"[{i+1}/{len(models)}] {model_short}")
        print(f"{'='*60}")

        # Phase 1
        print(f"  Phase 1 (agent + tabs)...", end=" ", flush=True)
        p1 = run_complete_phase1(session_id, model_id, entity_docs)
        print(f"{'OK' if p1['success'] else 'FAIL'} ({p1['seconds']}s)")

        # Phase 2
        print(f"  Phase 2 (report)...", end=" ", flush=True)
        if p1["success"] and p1["intel"]:
            p2 = run_complete_phase2(model_id, entity_docs, p1["intel"])
        else:
            p2 = {"success": False, "seconds": 0, "full_report_chars": 0, "relationships_count": 0, "data": None, "error": "Phase 1 failed"}
        print(f"{'OK' if p2['success'] else 'FAIL'} ({p2['seconds']}s, {p2['full_report_chars']} chars)")

        # Incremental (needs existing intel from Phase 1)
        print(f"  Incremental (upload)...", end=" ", flush=True)
        if p1["success"] and p1["intel"]:
            inc = run_incremental(session_id, model_id, entity_docs, p1["intel"])
        else:
            inc = {"success": False, "seconds": 0, "new_items": 0, "data": None, "error": "No base intel"}
        print(f"{'OK' if inc['success'] else 'FAIL'} ({inc['seconds']}s, {inc['new_items']} new items)")

        # Deletion
        print(f"  Deletion (remove)...", end=" ", flush=True)
        # Merge incremental into base intel for deletion test
        merged_intel = dict(p1["intel"]) if p1["intel"] else {}
        if inc["success"] and inc["data"]:
            for k in ["suggested_analyses", "visualizations", "investigations", "alerts", "relationships"]:
                merged_intel.setdefault(k, []).extend(inc["data"].get(k, []))
        dl = run_deletion(model_id, merged_intel)
        print(f"{'OK' if dl['success'] else 'FAIL'} ({dl['seconds']}s, {dl['removed_items']} removed)")

        all_results[model_id] = {"phase1": p1, "phase2": p2, "incremental": inc, "deletion": dl}

    # Print summary
    print(f"\n{'='*80}")
    print(f"{'RESULTS SUMMARY':^80}")
    print(f"{'='*80}")
    print(f"\n{'Model':<28} {'P1':>5} {'P2':>5} {'Inc':>5} {'Del':>5} {'Total':>7} {'P1 OK':>6} {'Inc OK':>7} {'Del OK':>7}")
    print(f"{'-'*28} {'-'*5} {'-'*5} {'-'*5} {'-'*5} {'-'*7} {'-'*6} {'-'*7} {'-'*7}")
    for mid, flows in all_results.items():
        ms = mid.split(".")[-1][:26]
        p1s = flows["phase1"]["seconds"]
        p2s = flows["phase2"]["seconds"]
        incs = flows["incremental"]["seconds"]
        dls = flows["deletion"]["seconds"]
        total = p1s + p2s + incs + dls
        print(f"{ms:<28} {p1s:>4.0f}s {p2s:>4.0f}s {incs:>4.0f}s {dls:>4.0f}s {total:>6.0f}s "
              f"{'Y' if flows['phase1']['success'] else 'N':>6} "
              f"{'Y' if flows['incremental']['success'] else 'N':>7} "
              f"{'Y' if flows['deletion']['success'] else 'N':>7}")

    # Judge
    scores = []
    if not args.no_judge:
        scores = judge_responses(all_results, args.judge_model)
        if scores:
            print(f"\n{'Model':<28} {'P1':>4} {'P2':>4} {'Inc':>4} {'Del':>4} {'ALL':>5}")
            print(f"{'-'*28} {'-'*4} {'-'*4} {'-'*4} {'-'*4} {'-'*5}")
            for s in scores:
                ms = s.get("model", "?").split(".")[-1][:26]
                print(f"{ms:<28} {s.get('phase1_score','-'):>4} {s.get('phase2_score','-'):>4} "
                      f"{s.get('incremental_score','-'):>4} {s.get('deletion_score','-'):>4} {s.get('overall','-'):>5}")
                print(f"  {s.get('reasoning', '')}")
                print(f"  Verdict: {s.get('verdict', '')}\n")

    # Save
    out_path = f"scripts/benchmark_results_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    save = {"timestamp": datetime.now(timezone.utc).isoformat(), "session_id": session_id,
            "models": models, "results": {m: {k: {kk: vv for kk, vv in v.items() if kk != "data"}
            for k, v in flows.items()} for m, flows in all_results.items()}, "judge_scores": scores}
    with open(out_path, "w") as f:
        json.dump(save, f, indent=2, default=str)
    print(f"\nSaved: {out_path}")


if __name__ == "__main__":
    main()
