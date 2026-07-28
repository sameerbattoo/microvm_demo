# Lambda MicroVM Notebook

A Python & SQL notebook running on **AWS Lambda MicroVMs** — each session gets its own Firecracker VM with persistent state, VM-level isolation, and automatic suspend/resume.

> Proof-of-concept demonstrating Lambda MicroVMs as stateful code execution sandboxes. Extensible to other runtimes (R, Node.js, Julia) by swapping the executor and image.

## Quick Start

```bash
./aws_microvm_run.sh        # builds images, starts proxy + UI
```

Opens at http://localhost:5173. Each notebook tab auto-launches a MicroVM. Closing a tab terminates its VM.

**Requirements:** AWS CLI 2.35.10+, Python 3.11+, Node.js 18+, configured AWS credentials. See [Prerequisites](#prerequisites) for details.

**Teardown:** `bash scripts/teardown.sh` (terminates all VMs, deletes images)

---

## Architecture

### Session-Based Routing

All callers interact with the proxy using only an `X-Session-Id` header. The proxy hides all VM internals — endpoints, auth tokens, VM IDs, rotation state:

```
┌────────────────────┐         ┌─────────────────────────────────────┐
│  Browser / Client  │  HTTP   │         Smart Proxy (:8081)         │
│                    ├────────►│                                     │
│  X-Session-Id: uuid│         │  • Session registry (sid → VM)      │
│                    │         │  • Auth token injection (JWE)       │
│                    │         │  • VM rotation (eternal mode)       │
│                    │         │  • Checkpoint orchestration         │
│                    │         │  • AI agent (Strands/Bedrock)       │
└────────────────────┘         └──────────────┬──────────────────────┘
                                              │ HTTPS + auth
                                              ▼
                               ┌────────────────────────-──┐
                               │  Lambda MicroVM           │
                               │  (Firecracker, ARM64)     │
                               │  FastAPI + SandboxExecutor│
                               └─────────────────────-─────┘
```

**Why this design:**
- Transparent VM rotation — same session ID, different VM underneath
- No credential leakage — caller never handles auth tokens
- Mode-agnostic — same API works in eternal and checkpoint mode
- Simplified clients — just track session IDs, nothing else

### Two Persistence Modes

Lambda MicroVMs have an 8-hour max lifetime (AWS limit). The proxy extends sessions beyond this:

| | Eternal (default) | Checkpoint |
|---|---|---|
| What happens at max lifetime | VM swaps transparently (~5-10s) | State saved to S3, VM dies |
| User experience | Seamless — never disconnects | Must click "Restore" next time |
| Best for | Always-on notebooks | Intermittent, cost-sensitive use |

**What survives:** Variables, DataFrames, `/tmp/` files, pip packages.
**What's excluded:** Python modules (re-imported), matplotlib figures (transient display objects).

> **PFR filed:** Request submitted to increase max lifetime from 8h to 2 weeks. Once approved, rotation/checkpoint becomes unnecessary for most use cases.

Configure via environment: `SESSION_PERSISTENCE_MODE=eternal` (or `checkpoint`)

---

## Features

### Notebook
- **Three cell types** — Python, SQL (DuckDB/Athena), Markdown
- **Sequential execution** — `Shift+Enter` runs cells in order, no race conditions
- **Rich output** — DataFrames as styled HTML tables, matplotlib inline, syntax highlighting
- **File upload** — CSV, Excel, Parquet, JSON → auto-loaded as pandas DataFrames
- **Multi-tab** — each tab = separate notebook + separate MicroVM
- **Save/Open** — `.notebook.json` preserves code, output, charts, AI explanations

### SQL Engine (DuckDB + Athena + DynamoDB)
Native SQL cells with intelligent auto-routing — write standard SQL, engine chosen transparently:

| Source | Syntax | Engine |
|--------|--------|--------|
| DataFrame in memory | `SELECT * FROM df_name` | DuckDB |
| Local file | `SELECT * FROM '/tmp/file.csv'` | DuckDB |
| S3 file | `SELECT * FROM read_csv('s3://...')` | DuckDB + httpfs |
| DynamoDB table | `SELECT * FROM dynamodb."table"` | PartiQL (or scan → DuckDB) |
| Athena table | `SELECT * FROM db.table` | Athena |
| Mixed JOIN | Any combination above | Materialize remote → DuckDB |

### AI Assistant (Strands Agents + Bedrock)
- **Chat panel** — conversational agent with notebook context awareness
- **Explain** — one-click plain-English explanation of any cell
- **Fix** — AI-suggested fixes for error cells with one-click apply
- **NLP-to-Code** — type natural language, get Python
- **Auto-Annotate** — document all cells with AI in one click
- Agent runs in the proxy (not the MicroVM) — no image bloat, instant iteration
- Auto-detects Bedrock credentials; hides AI buttons if not configured

### MicroVM Management
- 4 memory tiers: 1 GB (0.5 vCPU) through 8 GB (4 vCPU), burst to 4×
- Configurable idle suspend (1 min – 2 hr), auto-resume on traffic (~1s)
- Real-time cost tracking (running + suspended + burst)
- Connection status pill: 🟢 Running, 🟠 Suspended, 🔴 Terminated
- Instance panel: specs, lifecycle, resources, cost breakdown per VM

### Sidebar (VS Code-style)
Notebooks, Outline, Data Sources, Variables, Packages, Samples, MicroVMs — resizable, collapsible.

---

## Data Source Connectivity

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│  Lambda MicroVM (Firecracker)                                                   │
│                                                                                 │
│  ┌───────────────────────────────────────────────────────────────────────────┐  │
│  │  Notebook Code (Python / SQL)                                             │  │
│  │                                                                           │  │
│  │  • pandas, numpy, polars, matplotlib, scipy                               │  │
│  │  • DuckDB (in-process SQL engine)                                         │  │
│  │  • boto3 (AWS SDK)                                                        │  │
│  └───┬───────────┬──────────────┬────────────────┬───────────────────────────┘  │
│      │           │              │                │                              │
│      ▼           │              │                │                              │
│  ┌────────┐      │              │                │                              │
│  │ /tmp/  │      │              │                │                              │
│  │ Local  │      │              │                │                              │
│  │ Files  │      │              │                │                              │
│  └────────┘      │              │                │                              │
│                  │              │                │                              │
└──────────────────┼──────────────┼────────────────┼──────────────────────────────┘
                   │              │                │
    ┌──────────────┼──────────────┼────────────────┼───────────────────────────┐
    │              ▼              ▼                ▼                           │
    │  ┌─────────────────────────────────────────────────────────────────────┐ │
    │  │              IAM Execution Role (auto-injected credentials)         │ │
    │  └──┬──────────┬───────────┬──────────────┬───────────────┬──────────-─┘ │
    │     │          │           │              │               │              │
    │     ▼          ▼           ▼              ▼               ▼              │
    │  ┌──────┐  ┌────────┐  ┌────────┐  ┌──────────┐  ┌───────────┐           │
    │  │  S3  │  │DynamoDB│  │ Athena │  │   Glue   │  │    STS    │           │
    │  │      │  │        │  │        │  │ (Catalog)│  │           │           │
    │  │Bucket│  │ Tables │  │Workgrp │  │  Tables  │  │  Assume   │           │
    │  └──────┘  └────────┘  └────────┘  └──────────┘  └───────────┘           │
    │                                                                          │
    │                 AWS Account (IAM-based access)                           │
    └──────────────────────────────────────────────────────────────────────────┘

                   │
    ┌──────────────┼───────────────────────────────────────────────────────────┐
    │              ▼                                                           │
    │  ┌─────────────────────────────────────────────────────────────────────┐ │
    │  │           VPC Egress Connector (ENI in customer subnets)            │ │
    │  └──┬──────────┬───────────┬──────────────┬──────────────────────────-─┘ │
    │     │          │           │              │                              │
    │     ▼          ▼           ▼              ▼                              │
    │  ┌──────┐  ┌────────┐  ┌────────-──┐  ┌───────────────┐                  │
    │  │ RDS  │  │Redshift│  │ElastiCache│  │  On-premises  │                  │
    │  │      │  │        │  │           │  │  (Direct      │                  │
    │  │Postgres││  DWH   │  │  Redis    │  │   Connect)    │                  │
    │  │MySQL │  │        │  │           │  │               │                  │
    │  └──────┘  └────────┘  └────────-──┘  └───────────────┘                  │
    │                                                                          │
    │                 Customer VPC (private subnet access)                     │
    └──────────────────────────────────────────────────────────────────────────┘

                   │
    ┌──────────────┼───────────────────────────────────────────────────────────┐
    │              ▼                                                           │
    │  ┌─────────────────────────────────────────────────────────────────────┐ │
    │  │              Internet Egress (default, no VPC needed)               │ │
    │  └──┬──────────┬───────────┬───────────────────────────────────-───────┘ │
    │     │          │           │                                             │
    │     ▼          ▼           ▼                                             │
    │  ┌──────┐  ┌────────┐  ┌────────────┐                                    │
    │  │Public│  │  pip   │  │ SaaS APIs  │                                    │
    │  │ APIs │  │install │  │ (Snowflake,│                                    │
    │  │      │  │        │  │  Databricks│                                    │
    │  └──────┘  └────────┘  │  etc.)     │                                    │
    │                        └────────────┘                                    │
    │                 Public Internet                                          │
    └──────────────────────────────────────────────────────────────────────────┘
```

| Access Pattern | Mechanism | Data Sources |
|----------------|-----------|--------------|
| Local | In-VM filesystem | `/tmp/*.csv`, `.parquet`, `.json`, `.xlsx` |
| IAM Role | Auto-injected credentials | S3, DynamoDB, Athena, Glue, STS |
| VPC Connector | ENI in private subnets | RDS, Redshift, ElastiCache, OpenSearch, on-prem (DX) |
| Internet | Default egress | Public APIs, pip packages, SaaS (Snowflake, Databricks) |

Sample data auto-provisioned: DynamoDB table, 4 S3 CSVs, Athena database with 4 tables.

---

## Configuration

Key settings in `scripts/config.sh`:

```bash
SESSION_PERSISTENCE_MODE="eternal"    # "eternal" or "checkpoint"
MAX_LIFETIME_SECONDS="28800"          # 8h (AWS max)
ROTATION_LEAD_SECONDS="60"            # Start rotation 60s before expiry (eternal only)
AWS_REGION="us-west-2"
IMAGE_SIZES="1024 2048 4096 8192"     # Memory tiers (MiB)
```

Override for testing: `SESSION_PERSISTENCE_MODE=checkpoint MAX_LIFETIME_SECONDS=180 ./aws_microvm_run.sh`

AI config in `proxy/notebook/ai/constants.py` — model IDs, temperature, token limits. Uses Bedrock Claude Sonnet by default.

---

## Testing

Tests auto-detect the proxy's persistence mode and run the appropriate suite:

```bash
bash tests/run_tests.sh
```

```
tests/
├── run_tests.sh              # Auto-detect mode, run common + mode-specific
├── common/                   # Both modes
│   ├── test_burst_behavior.py
│   ├── test_interrupt_execution.py
│   ├── test_microvm_lifecycle.py
│   └── test_sql_engine.py
├── eternal/
│   └── test_rotation.py     # 5-rotation test across 6 VMs
└── checkpoint/
    ├── test_auto_checkpoint.py
    └── test_s3_restore.py
```

All tests use `X-Session-Id` only — no VM internals referenced.

---

## Project Structure

```
app/                          # Runs INSIDE the MicroVM
├── server.py                 # FastAPI entrypoint, pre-loaded libs
├── platform/
│   ├── hooks.py              # Lifecycle: /run, /suspend, /resume, /terminate, /checkpoint-save, /restore-state
│   └── checkpoint.py         # dill serialize/restore, module exclusion, deepcopy on restore
└── notebook/
    ├── executor.py           # SandboxExecutor (stateful Python engine)
    ├── code_engine.py        # /execute endpoint
    ├── sql_engine.py         # /execute-sql with auto-routing
    └── routes.py             # /install, /variables, /health, /metrics, /upload

proxy/                        # Runs on your machine (hides all VM internals)
├── server.py                 # FastAPI entrypoint, swap callback, health
├── platform/
│   ├── microvm_manager.py    # Session registry, tokens, timers, AWS client
│   ├── session_rotator.py    # Transparent VM rotation (eternal mode)
│   ├── cost_tracker.py       # Burst + baseline cost tracking
│   └── routes/
│       └── microvm.py        # /launch, /terminate, /proxy/{path}, /instances
├── notebook/
│   ├── ai/                   # Strands Agent (chat, explain, fix)
│   └── routes/               # AI + notebook CRUD endpoints
└── storage/                  # SQLite backend (notebooks, sessions, metrics)

web/src/                      # React UI (Vite)
├── components/               # Cell, Notebook, Sidebar, ConnectionPanel, AiChatPanel
└── services/microvm.js       # API client (all calls use X-Session-Id)

tests/                        # E2E tests (common + eternal + checkpoint)
scripts/                      # config.sh, setup_iam.sh, build_all_images.sh, teardown.sh
```

---

## Technical Details

### Lifecycle Hooks
| Hook | When | Purpose |
|------|------|---------|
| `/run` | VM starts | Initialize session, optionally restore from S3 |
| `/suspend` | Going idle | Flush state |
| `/resume` | Traffic arrives | Validate state |
| `/terminate` | Shutting down | Checkpoint to S3 (checkpoint mode only) |

### Checkpoint Serialization
- **Save:** Exclude modules → `dill.dumps(namespace)` → bulk serialize with per-var fallback → upload pkl + files + packages to S3
- **Restore:** Download from S3 → `dill.loads()` → `copy.deepcopy()` mutable containers → `pip install` tracked packages
- Module exclusion prevents `_csv.writer` and similar C-extension crashes
- Deepcopy breaks dill internal references that prevent list mutations from surviving re-serialization

### Rotation (Eternal Mode)
7-step process: launch VM2 → health check → quiesce traffic → checkpoint VM1 → restore VM2 → swap routing → terminate VM1. Requests during quiesce are queued and replayed. Typical: ~5-10s total.

### Burst Model
VMs get 4× baseline resources pre-allocated from boot. Usage above baseline incurs burst billing. Exceeding 4× = OOM crash. Rate: `$0.0000133/GB-sec` (both baseline and burst).

### Pre-Termination Wake
AWS doesn't fire `/terminate` on suspended VMs. The proxy resumes the VM before max lifetime so the hook fires and state is saved.

---

## Prerequisites

### AWS MicroVM Mode

| Requirement | Version |
|------------|---------|
| AWS CLI | 2.35.10+ (for `lambda-microvms` subcommand) |
| Python | 3.11+ |
| Node.js | 18+ |
| AWS credentials | Configured via `~/.aws/credentials` |

```bash
# Install/upgrade AWS CLI (macOS)
curl "https://awscli.amazonaws.com/AWSCLIV2.pkg" -o /tmp/AWSCLIV2.pkg
sudo installer -pkg /tmp/AWSCLIV2.pkg -target /
```

### Local Dev Mode (no AWS)
Just Python 3.11+ and Node.js 18+. Run `./dev_run.sh`.

### IAM Roles (auto-created)
- `MicroVMSandboxBuildRole` — S3 read during image build
- `MicroVMSandboxExecRole` — S3, DynamoDB, Athena, Glue, STS for running VMs

### AI Features (optional)
Amazon Bedrock access with Claude Sonnet enabled. If not configured, AI buttons are hidden — everything else works.

---

## Cost

4 GB / 2 vCPU sandbox, 1 hour active per day: **~$5.60/month** (compute + snapshot storage).

---

## References

- [AWS Lambda MicroVMs Docs](https://docs.aws.amazon.com/lambda/latest/dg/lambda-microvms-guide.html)
- [Launch Blog Post](https://aws.amazon.com/blogs/aws/run-isolated-sandboxes-with-full-lifecycle-control-aws-lambda-introduces-microvms/)
- [MicroVM Pricing](https://aws.amazon.com/lambda/pricing/)

---

## License

Apache License 2.0. See [LICENSE](LICENSE).
