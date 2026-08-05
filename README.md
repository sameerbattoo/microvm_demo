# Lambda MicroVM Notebook

A Python & SQL notebook running on **AWS Lambda MicroVMs** — each session gets its own Firecracker VM with persistent state, VM-level isolation, and automatic suspend/resume.

> Proof-of-concept demonstrating Lambda MicroVMs as stateful code execution sandboxes. Extensible to other runtimes (R, Node.js, Julia) by swapping the executor and image.

**Contents:** [Demo Videos](#demo-videos) · [Quick Start](#quick-start) · [Why MicroVMs?](#why-lambda-microvms-for-notebooks) · [Architecture](#architecture) · [Features](#features) · [Data Sources](#data-source-connectivity) · [Configuration](#configuration) · [Network Egress Control](#network-egress-control-layer-7) · [Testing](#testing) · [Project Structure](#project-structure) · [Technical Details](#technical-details) · [Prerequisites](#prerequisites) · [Cost](#cost)

## Demo Videos

<table>
<tr>
<td width="33%">
<a href="https://share.descript.com/view/8BAokQd9eTy" target="_blank" rel="noopener">
<img src="https://img.shields.io/badge/▶_Video_1-Building_a_Data_Science_MicroVM_Image-blue?style=for-the-badge&labelColor=1a1a2e" width="100%"/>
</a>
<br/><sub>How to create a Docker image for a data science environment and deploy it as Lambda MicroVM images</sub>
</td>
<td width="33%">
<a href="https://share.descript.com/view/AAPf8FAOKcl" target="_blank" rel="noopener">
<img src="https://img.shields.io/badge/▶_Video_2-Running_Notebooks_on_Lambda_MicroVMs-blue?style=for-the-badge&labelColor=1a1a2e" width="100%"/>
</a>
<br/><sub>Running Notebooks on Lambda MicroVMs</sub>
</td>
<td width="33%">
<a href="https://share.descript.com/view/7WSjbHaxXKb" target="_blank" rel="noopener">
<img src="https://img.shields.io/badge/▶_Video_3-AI_Assistant_with_Full_VM_Context-blue?style=for-the-badge&labelColor=1a1a2e" width="100%"/>
</a>
<br/><sub>AI Assistant with Full MicroVM Context</sub>
</td>
</tr>
</table>

## Quick Start

```bash
./aws_microvm_run.sh        # builds images, starts proxy + UI
```

Opens at http://localhost:5173. Each notebook tab auto-launches a MicroVM. Closing a tab terminates its VM.

**Requirements:** AWS CLI 2.35.10+, Python 3.11+, Node.js 18+, configured AWS credentials. See [Prerequisites](#prerequisites) for details.

**Teardown:** `bash scripts/teardown.sh` (terminates all VMs, deletes images)

---

## Why Lambda MicroVMs for Notebooks?

Traditional notebook platforms run kernels as containers on shared Kubernetes nodes. Lambda MicroVMs offer a fundamentally better primitive for this workload:

| | EKS Pods (containers) | Lambda MicroVMs |
|---|---|---|
| **Isolation** | Shared host kernel (namespaces + cgroups) | Dedicated Firecracker guest kernel per session — hardware VM boundary |
| **Idle cost** | 5-min eviction tail + 24/7 EBS volumes | Suspends to ~$0 instantly, snapshot only |
| **Resume** | Kill pod → recreate → reattach EBS (~10-30s) | Snapshot restore with memory + disk intact (~1-2s) |
| **Infra overhead** | Cluster autoscaler, node pools, PDBs, etcd tuning | None — fully managed, no cluster to operate |
| **Blast radius** | Runaway kernel affects co-located pods on same node | Confined to its own VM, terminated cleanly |

**Key benefits for notebook use cases:**

- **VM-level tenant isolation** — Customer-supplied Python runs in its own Firecracker VM with a dedicated guest kernel. Container escapes, fork bombs, and malicious dependencies cannot cross the boundary. Materially stronger for SOC 2 and enterprise security reviews.

- **Instant suspend, zero idle cost** — No eviction timers, no EBS volumes running 24/7. The VM freezes the moment the user stops typing and resumes in 1-2 seconds when they return. You pay only for active compute.

- **Eliminates control-plane churn** — Notebook kernels stop being Kubernetes pods, so they generate zero scheduling, eviction, and etcd write load. The control-plane stability problem disappears for this workload.

- **Simpler operations** — No cluster autoscaler, node drain logic, or EBS reattach choreography. Lifecycle is a single API: `run → suspend → resume → terminate`.

**Cost comparison** (directional, per user/month, 2 vCPU / 4 GB kernel, ~2.5 hr/day session of which ~30 min is active cell execution):

| Scale | Lambda MicroVMs | EKS + EBS (evict-on-idle) | Saving |
|-------|----------------|---------------------------|--------|
| Per user | ~$3.25 | ~$5.71 | ~43% |
| 1,000 users | ~$3,254 | ~$5,781 | ~$30K/yr |
| 2,000 users | ~$6,508 | ~$11,490 | ~$60K/yr |

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
VMs get 4× baseline resources pre-allocated from boot. Usage above baseline incurs burst billing at the same vCPU + memory rates. Exceeding 4× = OOM crash.

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

**Pricing rates** (from [AWS Lambda MicroVM pricing](https://aws.amazon.com/lambda/pricing/), Graviton/ARM64, us-east-1):

| Component | Rate |
|-----------|------|
| vCPU (compute) | $0.0000276944 / vCPU-second |
| Memory | $0.0000036667 / GB-second |
| Snapshot (suspended) | ~$0.08 / GB-month |

**Note:** CPU is allocated at 2 GB : 1 vCPU. A 4 GB kernel = 2 vCPU.

**Example breakdown** — 2 vCPU / 4 GB kernel, ~2.5 hr/day session of which ~30 min is active cell execution (~11 hr/month compute, 22 workdays):

| Component | Calculation | Monthly Cost |
|-----------|-------------|-------------|
| vCPU | 2 vCPU × 39,600s × $0.0000276944 | $2.19 |
| Memory | 4 GB × 39,600s × $0.0000036667 | $0.58 |
| Snapshot storage | ~6 GB × $0.08/GB-month | $0.48 |
| **Total** | | **~$3.25** |

See [Why MicroVMs](#why-lambda-microvms-for-notebooks) for comparison vs EKS (~43% savings).

---

## References

- [AWS Lambda MicroVMs Docs](https://docs.aws.amazon.com/lambda/latest/dg/lambda-microvms-guide.html)
- [Launch Blog Post](https://aws.amazon.com/blogs/aws/run-isolated-sandboxes-with-full-lifecycle-control-aws-lambda-introduces-microvms/)
- [MicroVM Pricing](https://aws.amazon.com/lambda/pricing/)

---

## Network Egress Control (Layer 7)

MicroVMs have full internet access by default via the `INTERNET_EGRESS` network connector. For production deployments where you need to control **which domains** user code can reach (e.g., block unauthorized data exfiltration, restrict to approved APIs only), you can implement Layer 7 egress filtering.

### Option A: AWS Network Firewall

Route MicroVM traffic through a VPC with AWS Network Firewall for infrastructure-enforced domain filtering.

#### Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────────┐     ┌──────────┐
│  MicroVM    │────▶│  VPC NAT Gateway │────▶│  AWS Network        │────▶│ Internet │
│  (Lambda)   │     │  (private subnet)│     │  Firewall           │     │          │
└─────────────┘     └──────────────────┘     │  (L7 domain rules)  │     └──────────┘
                                             └─────────────────────┘
```

Instead of the default `INTERNET_EGRESS` connector, MicroVMs are launched into a **VPC private subnet** with a NAT Gateway. All outbound traffic passes through AWS Network Firewall, which inspects TLS SNI (Server Name Indication) to filter by domain.

#### Setup Steps

##### 1. Create a VPC with Network Firewall

```bash
# Create VPC with public + private + firewall subnets
aws ec2 create-vpc --cidr-block 10.0.0.0/16

# Private subnet (MicroVMs egress here)
aws ec2 create-subnet --vpc-id vpc-xxx --cidr-block 10.0.1.0/24

# Firewall subnet (Network Firewall ENIs)
aws ec2 create-subnet --vpc-id vpc-xxx --cidr-block 10.0.2.0/24

# Public subnet (NAT Gateway → Internet Gateway)
aws ec2 create-subnet --vpc-id vpc-xxx --cidr-block 10.0.3.0/24
```

##### 2. Create Network Firewall Domain Allowlist

```bash
# Create a stateful rule group with domain filtering
aws network-firewall create-rule-group \
  --rule-group-name "microvm-egress-allowlist" \
  --type STATEFUL \
  --capacity 100 \
  --rule-group '{
    "RulesSource": {
      "RulesSourceList": {
        "Targets": [
          ".amazonaws.com",
          ".aws.amazon.com",
          "pypi.org",
          "files.pythonhosted.org",
          "github.com",
          "raw.githubusercontent.com",
          "api.openai.com",
          "bedrock-runtime.us-west-2.amazonaws.com"
        ],
        "TargetTypes": ["TLS_SNI", "HTTP_HOST"],
        "GeneratedRulesType": "ALLOWLIST"
      }
    }
  }'
```

This allows MicroVMs to reach:
- **AWS services** (S3, DynamoDB, Athena, Bedrock) — required for data access
- **PyPI** — for `pip install` of user packages
- **GitHub** — for package downloads that reference GitHub
- **Everything else is BLOCKED** — no data exfiltration to unauthorized endpoints

##### 3. Create Firewall Policy

```bash
aws network-firewall create-firewall-policy \
  --firewall-policy-name "microvm-egress-policy" \
  --firewall-policy '{
    "StatelessDefaultActions": ["aws:forward_to_sfe"],
    "StatelessFragmentDefaultActions": ["aws:forward_to_sfe"],
    "StatefulRuleGroupReferences": [
      {
        "ResourceArn": "arn:aws:network-firewall:us-west-2:ACCOUNT:stateful-rulegroup/microvm-egress-allowlist"
      }
    ]
  }'
```

##### 4. Deploy the Firewall

```bash
aws network-firewall create-firewall \
  --firewall-name "microvm-egress-firewall" \
  --vpc-id vpc-xxx \
  --subnet-mappings SubnetId=subnet-firewall \
  --firewall-policy-arn "arn:aws:network-firewall:us-west-2:ACCOUNT:firewall-policy/microvm-egress-policy"
```

##### 5. Route MicroVM Traffic Through Firewall

Update route tables so the private subnet (where MicroVMs run) sends `0.0.0.0/0` traffic to the Network Firewall endpoint, which then forwards allowed traffic to the NAT Gateway → Internet.

```bash
# Private subnet route table → Firewall endpoint
aws ec2 create-route \
  --route-table-id rtb-private \
  --destination-cidr-block 0.0.0.0/0 \
  --vpc-endpoint-id vpce-firewall-endpoint
```

##### 6. Configure MicroVM Network Connector

Replace the `INTERNET_EGRESS` connector with a VPC connector pointing to the private subnet:

```bash
# In scripts/config.sh or environment:
export MICROVM_EGRESS_CONNECTOR="arn:aws:lambda:us-west-2:ACCOUNT:network-connector:vpc-connector-private-subnet"
```

#### Policy Examples

**Minimal (data access only):**
```
ALLOW: .amazonaws.com (S3, DynamoDB, Athena, Bedrock)
DENY: all others
```

**Standard (data + packages):**
```
ALLOW: .amazonaws.com, pypi.org, files.pythonhosted.org
DENY: all others
```

**Permissive (data + packages + APIs):**
```
ALLOW: .amazonaws.com, pypi.org, files.pythonhosted.org, api.github.com, *.openai.com
DENY: all others
```

#### Monitoring & Audit

Network Firewall logs all allowed/denied connections to CloudWatch Logs or S3:

```bash
aws network-firewall update-logging-configuration \
  --firewall-arn arn:aws:network-firewall:... \
  --logging-configuration '{
    "LogDestinationConfigs": [{
      "LogType": "ALERT",
      "LogDestinationType": "CloudWatchLogs",
      "LogDestination": {
        "logGroup": "/aws/network-firewall/microvm-egress"
      }
    }]
  }'
```

This gives you an audit trail of every domain a MicroVM tried to reach — useful for compliance and detecting unauthorized access patterns.

#### Cost Considerations

| Component | Cost |
|-----------|------|
| Network Firewall | ~$0.395/hr per AZ (~$285/mo) |
| Traffic processing | $0.065/GB |
| NAT Gateway | $0.045/hr + $0.045/GB |

For development/demo, use the default `INTERNET_EGRESS` connector (no VPC needed). For production with compliance requirements, the Network Firewall adds ~$300/mo fixed cost plus per-GB processing.

### Option B: In-VM Transparent Egress Proxy

An alternative to AWS Network Firewall — bake a lightweight policy-driven proxy inside the MicroVM image. Similar to how **Cilium** enforces L7 policies in Kubernetes pods via eBPF, but implemented as an application-level proxy since MicroVMs don't expose the host kernel.

#### Architecture

```
┌─────────────────────────────────────────────────────────┐
│  MicroVM                                                │
│                                                         │
│  ┌──────────┐     ┌──────────────────-─┐     ┌────────┐ │
│  │ User Code│────▶│ Egress Proxy       │────▶│Network │─┼──▶ Internet
│  │ (Python) │     │ (localhost:8888)   │     │        │ │
│  └──────────┘     │ • Domain allowlist │     └────────┘ │
│                   │ • Path rules       │                │
│  HTTP_PROXY=      │ • Rate limiting    │                │
│  localhost:8888   │ • Audit logging    │                │
│                   └────────┬──────-────┘                │
│                            │                            │
│                   ┌────────▼────────┐                   │
│                   │ Policy (from S3)│                   │
│                   └─────────────────┘                   │
└─────────────────────────────────────────────────────────┘
```

#### How it works

1. A small proxy binary (~5MB) is baked into the Docker image
2. At VM boot, the proxy starts and fetches policy from S3: `s3://bucket/policies/egress-policy.yaml`
3. `HTTP_PROXY` / `HTTPS_PROXY` env vars route all Python HTTP traffic through it
4. Every outbound request is checked against the policy — allowed requests pass, denied requests return 403

#### Policy Format (centrally managed via S3)

```yaml
# s3://artifacts-bucket/policies/egress-policy.yaml
version: 1
default: deny

rules:
  - action: allow
    domains: ["*.amazonaws.com", "*.aws.amazon.com"]
    description: "AWS API access (S3, DynamoDB, Athena, Bedrock)"

  - action: allow
    domains: ["pypi.org", "files.pythonhosted.org"]
    description: "Python package installation"

  - action: allow
    domains: ["api.github.com"]
    paths: ["/repos/*"]
    description: "GitHub API (read-only)"

  - action: deny
    domains: ["*"]
    log: true
    description: "Default deny — block all other egress"
```

Update the YAML in S3 → all new MicroVMs pick up the policy on launch. For running VMs, the proxy can poll S3 periodically for hot-reload.

#### Implementation

**Dockerfile:**
```dockerfile
COPY egress-proxy /usr/local/bin/egress-proxy
ENV HTTP_PROXY=http://localhost:8888
ENV HTTPS_PROXY=http://localhost:8888
ENV NO_PROXY=localhost,127.0.0.1,169.254.169.254
ENV EGRESS_POLICY_S3="s3://BUCKET/policies/egress-policy.yaml"
```

**Boot sequence (app/server.py):**
```python
subprocess.Popen(["/usr/local/bin/egress-proxy", "--policy-s3", os.environ["EGRESS_POLICY_S3"]])
```

#### Security Hardening

To prevent user code from bypassing the proxy:
- **iptables rules**: Force all port 80/443 traffic through the proxy (requires `CAP_NET_ADMIN`)
- **Read-only env vars**: Set `HTTP_PROXY` in the image (cannot be unset at runtime)
- **Binary integrity**: Verify proxy binary hash at boot

### Comparison: Network Firewall vs In-VM Proxy

| Feature | AWS Network Firewall | In-VM Transparent Proxy |
|---------|---------------------|------------------------|
| **Monthly cost** | ~$300 fixed + per-GB | $0 (runs inside VM) |
| **Domain filtering** | ✅ (TLS SNI inspection) | ✅ (CONNECT tunnel) |
| **Path-level rules** | ❌ | ✅ (`/api/v1/*` patterns) |
| **Header inspection** | ❌ | ✅ (inspect/inject headers) |
| **Rate limiting** | ❌ | ✅ (per-domain limits) |
| **Request body inspection** | ❌ | ✅ (block large uploads) |
| **VPC required** | ✅ (subnets + NAT + routing) | ❌ (works with default INTERNET_EGRESS) |
| **Setup complexity** | High | Low (binary + env var) |
| **Enforcement level** | Network (cannot bypass) | Application (env-var based) |
| **Bypass risk** | None (infra-enforced) | Low (mitigated with iptables) |
| **Central policy** | AWS Console / API | S3 YAML file |
| **Audit logging** | CloudWatch (async) | Inline stdout (real-time) |
| **Hot policy reload** | Immediate (rule update) | Poll-based (60s) |

**Recommendation:**
- **Compliance/regulated workloads** → AWS Network Firewall (cannot be bypassed)
- **Cost-sensitive / flexible policies** → In-VM Proxy (zero infra cost, path-level rules)
- **Defense in depth** → Both (Network Firewall as hard boundary + proxy for fine-grained L7 rules)

---

## License

Apache License 2.0. See [LICENSE](LICENSE).
