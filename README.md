# Lambda MicroVM Notebook

A **Python & SQL notebook** web application demonstrating **AWS Lambda MicroVMs** as isolated
code execution sandboxes — the primary use case for this new serverless compute primitive.

> **Note:** This is a proof-of-concept / demo application. It supports Python and SQL (DuckDB + Athena)
> as execution languages. The architecture is extensible to other runtimes (R, Node.js, Julia, etc.)
> by swapping the executor and MicroVM image.

## What This Is

A browser-based Python & SQL notebook (React UI) backed by stateful execution sandboxes running
on Lambda MicroVMs. Each notebook session gets its own Firecracker VM providing:

- **Persistent state** — Variables, imports, and installed packages survive across cell executions
- **VM-level isolation** — Each user's code runs in a separate Firecracker VM
- **Suspend/resume** — Idle sessions pause automatically, resume instantly with all state intact
- **Auto-provisioning** — New notebooks can auto-launch MicroVMs; closing terminates them
- **Rich output** — DataFrames render as styled tables (with truncation for large results), matplotlib plots display inline
- **File upload** — Upload CSV/Excel/Parquet/JSON files and reference them in code
- **AWS data sources** — Auto-discover S3, DynamoDB, and Athena tables from the sidebar; click to insert query code
- **Cost tracking** — Real-time estimated cost per MicroVM with detailed breakdown on hover
- **Lifecycle hooks** — The sandbox responds to MicroVM lifecycle events

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Quick Start](#2-quick-start)
3. [Features](#3-features)
4. [Architecture](#4-architecture)
5. [Usage](#5-usage)
6. [Configuration](#6-configuration)
7. [Technical Details](#7-technical-details)
8. [Project Structure](#8-project-structure)
9. [Tests](#9-tests)
10. [Cost](#10-cost)
11. [References](#11-references)
12. [License](#12-license)
13. [Contributing](#13-contributing)
14. [Security](#14-security)

---

## 1. Prerequisites

### 1.1 Local Dev Mode (no AWS needed)

| Requirement | Version | Notes |
|------------|---------|-------|
| Python | 3.11+ | For the sandbox backend |
| Node.js | 18+ | For the React UI (Vite) |
| pip | latest | Installs FastAPI, uvicorn, boto3 |

### 1.2 AWS MicroVM Mode (full features)

| Requirement | Version | Notes |
|------------|---------|-------|
| **AWS CLI** | **2.35.10+** | **Required for `lambda-microvms` subcommand. Most existing installations will be too old — see install instructions below.** |
| Python | 3.11+ | Proxy server + sandbox |
| Node.js | 18+ | React UI |
| npm | 8+ | Installed with Node.js |
| boto3 | >= 1.43.40 | Auto-installed by launch script |
| zip | any | For packaging the MicroVM image artifact |

> **Important: AWS CLI 2.35.10+ is required.** The `lambda-microvms` subcommand was introduced in this version. If you have an older version, MicroVM commands will fail with "Invalid choice" errors.

**Install or upgrade AWS CLI:**

```bash
# Check your current version
aws --version
# Output: aws-cli/2.x.x ...

# macOS (recommended)
curl "https://awscli.amazonaws.com/AWSCLIV2.pkg" -o /tmp/AWSCLIV2.pkg
sudo installer -pkg /tmp/AWSCLIV2.pkg -target /

# Linux (x86_64)
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip
unzip -o /tmp/awscliv2.zip -d /tmp
sudo /tmp/aws/install --update

# Linux (ARM64)
curl "https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip" -o /tmp/awscliv2.zip
unzip -o /tmp/awscliv2.zip -d /tmp
sudo /tmp/aws/install --update

# Windows
# Download and run: https://awscli.amazonaws.com/AWSCLIV2.msi

# Verify after install
aws --version
# Should show 2.35.10 or higher
```

### 1.3 AWS Account Requirements

| Resource | Purpose |
|----------|---------|
| **AWS Account** | Active account with billing enabled |
| **AWS Credentials** | Configured via `~/.aws/credentials` or environment variables. The launch script uses the `default` profile (configurable in `scripts/config.sh`). |
| **IAM Permissions** (for the operator) | `iam:CreateRole`, `iam:PutRolePolicy`, `iam:GetRole`, `s3:CreateBucket`, `s3:PutObject`, `s3:GetObject`, `lambda-microvms:*`, `dynamodb:CreateTable`, `dynamodb:BatchWriteItem`, `athena:CreateWorkGroup`, `athena:StartQueryExecution`, `glue:CreateDatabase`, `glue:CreateTable` |
| **Region** | `us-west-2` (default). Also supports `us-east-1`, `us-east-2`, `eu-west-1`, `ap-northeast-1`. |

### 1.4 IAM Roles Created by the Scripts

| Role | Purpose | Key Permissions |
|------|---------|-----------------|
| `MicroVMSandboxBuildRole` | Used during MicroVM image build to pull artifacts from S3 | S3 read on artifact bucket |
| `MicroVMSandboxExecRole` | Attached to running MicroVMs — gives your notebook code access to AWS services | S3 (read/write), DynamoDB (scan/query), Athena (query), Glue (catalog read), STS |

### 1.5 Optional (for AI Features)

| Requirement | Notes |
|------------|-------|
| Amazon Bedrock access | Model access enabled for Claude Sonnet in your region |
| `bedrock:InvokeModel` permission | On the operator's credentials (proxy calls Bedrock, not the MicroVM) |
| strands-agents | Auto-installed from `requirements-proxy.txt` |

> AI features auto-detect credentials. If Bedrock is not configured, AI buttons (Chat, Explain, Fix, Generate, Annotate) are simply hidden in the UI — everything else works normally.

---

## 2. Quick Start

> **Important:** Make sure you've completed the [Prerequisites](#1-prerequisites) section before running this command.

```bash
./aws_microvm_run.sh
```

This single command runs the entire demo end-to-end. It is fully self-contained — no manual setup steps required. On first run it:
1. Creates S3 bucket, IAM roles (if missing)
2. Provisions sample data (DynamoDB, S3, Athena)
3. Builds MicroVM images in parallel (~4-5 min)
4. Starts the smart proxy (`:8081`)
5. Starts the notebook UI (`:5173`)

Subsequent runs skip the build and launch in seconds.

### Teardown

```bash
bash scripts/teardown.sh
```

Terminates all running/suspended MicroVMs and deletes all images. S3 bucket, IAM roles, and DynamoDB table are preserved for manual cleanup.

---

## 3. Features

### 3.1 Notebook UI
- **Three cell types**: Code (Python), SQL (DuckDB/Athena), and Text (Markdown)
- Code cells with `Shift+Enter` execution
- **AI Chat panel** — right-side conversational AI assistant (opens by default with each notebook)
- **AI Explain / Fix / Generate** — contextual buttons on each cell
- **Auto-Annotate** — one-click AI documentation for all cells in a notebook
- **NLP-to-Code** — type natural language in new cells, AI auto-detects and generates Python
- **Run All** — Execute all cells sequentially with one click
- Sequential execution queue (prevents race conditions)
- Inline DataFrame table rendering (truncated at 50 rows) with smart enhancements:
  - URLs rendered as clickable links (opens in new tab)
  - Image URLs rendered as inline thumbnails
  - Email addresses as `mailto:` links
  - Large numbers formatted with commas; negatives in red
  - Booleans as color-coded badges; NaN/None styled as muted italic
  - Long text truncated with hover tooltip
- Inline matplotlib/chart image display
- Save/Open notebooks (preserves code, output, tables, charts, and AI explanations)
- Tab support for multiple notebooks (cells persist across tab switches)
- **Notebook name pill** in toolbar — always shows which notebook is active
- Delete any cell (including the last one — replaced with a fresh empty cell)

### 3.2 AI Features (Powered by Strands Agents SDK)

All AI features use **Amazon Bedrock** (Claude Sonnet) and are powered by the **Strands Agents SDK** for agentic workflows. AI capabilities auto-detect — if Bedrock credentials are not configured, AI buttons are simply hidden.

| Feature | How It Works |
|---------|-------------|
| **AI Chat** | Right-side panel (opens by default). Full conversational agent with notebook context, installed packages, and data sources injected into the prompt. Uses `SlidingWindowConversationManager` (last 10 messages). Responses support markdown, code blocks with "Insert Cell" / "Replace Active Cell" buttons. |
| **AI Explain** | Click ✨ on any code cell (appears after writing code). Makes a direct Bedrock `converse()` call — returns a collapsible explanation card below the cell. Also provides the explanation as tooltip text in the Outline panel. |
| **AI Fix** | Click 🔧 on any cell with an error. Sends code + error to Bedrock, returns a suggested fix with "Apply Fix" button. |
| **Auto-Annotate** | Toolbar button ("Annotate"). Iterates all code cells sequentially, calls `/ai/explain` for each, inserts a markdown summary cell above and shows the explanation card in each cell. |
| **NLP-to-Code** | In a new empty code cell, type a natural language description (e.g. "load sales data from S3 and plot revenue by month") and click the ✨ sparkle button. The AI detects it's natural language and generates Python code. |

**Architecture:**
- The Strands Agent runs in the **proxy** (not inside the MicroVM) — avoids image bloat and rebuild cycles
- Agent tools: `execute_code`, `read_notebook_state`, `install_package`
- Chat endpoint streams responses via SSE (`/ai/chat`)
- Explain/Fix use direct `converse()` calls for speed (no full agent loop)
- Per-notebook conversation history (stored on tab, survives tab switches)
- Session ID = UUID (`crypto.randomUUID()`) for AgentCore compatibility

### 3.3 Activity Bar Sidebar
A unified collapsible sidebar with VS Code-style icon activity bar:

| Panel | Description |
|-------|-------------|
| **Notebooks** | Open tabs grouped by tag, with connection status dots and AI auto-tagging |
| **Outline** | Searchable cell list with drag-to-reorder, execution status (✓/✗/●), click to scroll |
| **Data Sources** | S3 files, DynamoDB tables, Athena tables, Public APIs (8 no-auth sources) — click to insert ready-to-run code |
| **Variables** | Live variable explorer with smart previews (DataFrames as tables, dicts as key-value, colors as swatches) |
| **Packages** | pip install + filter installed packages |
| **Samples** | 6 prebuilt notebook templates |
| **MicroVMs** | Instance cards with cost breakdown, lifecycle info, attach/terminate actions |

- **Resizable** — drag right edge (180px–480px), width persists in localStorage
- **Collapsible** — click active icon to collapse to just the 44px icon strip
- **Public APIs** include: World Bank, World Countries, CoinGecko, Open-Meteo, USGS Earthquakes, NASA APOD, Open Library, Public Holidays
- **Notebook Tags** — organize notebooks into collapsible groups:
  - New notebooks default to "Drafts"
  - Sample notebooks auto-tagged as "Samples"
  - **AI auto-tagging** — after 2 cell executions, the LLM suggests a tag (e.g. "Analytics", "Visualization", "ML Training") based on notebook name, description, and cell content
  - Manual tag edit — click `#` on any notebook to rename its tag
  - Auto-tag button on the Drafts folder to bulk-tag all draft notebooks via AI
  - Notebook scope pill shown at the top of Outline, Variables, Packages, and Data Sources panels

### 3.4 MicroVM Management
- Launch new MicroVMs from the connection panel (4 memory tiers: 1GB–8GB)
- **Idle suspend** configurable: 1 min, 2 min, 5 min, 15 min, 30 min, 1 hr, 2 hr
- Instance cards in sidebar show: spec, session, lifecycle, real-time resources, cost breakdown
- **Two persistence modes** (`SESSION_PERSISTENCE_MODE` in config):
  - `eternal` (default) — VMs rotate transparently before max lifetime. Session never dies.
  - `checkpoint` — State saved to S3 before max lifetime. VM terminates. User restores manually.
- **Transparent VM rotation** (eternal mode) — a new VM is launched, state checkpointed, restored onto the new VM, routing swapped, old VM terminated. ~8s total downtime. User never sees it.
- **Suspend button** — manually suspend a running VM to save costs
- **Live Resources** — CPU, Memory, Disk gauge bars update after each cell execution (using `psutil` inside the VM)
- **Connection status pill** — toolbar shows actual VM state: 🟢 Running, 🟠 Suspended, 🔴 Terminated/Disconnected
- Attach existing running instances to notebooks
- Resume suspended instances (auto-resume on traffic ~1s)
- Terminate instances (with optional S3 checkpoint)
- Live state refresh every 10–15 seconds (via AWS API — does NOT prevent VM suspension)
- Auto-reconnect on page refresh
- Badge on activity bar icon shows running VM count

### 3.5 Cost Tracking
- **Real-time estimated cost** per MicroVM displayed in the Instances panel
- Tracks time in RUNNING and SUSPENDED states via the proxy (uses AWS control-plane API, not VM traffic)
- Cost breakdown shows:
  - Running duration and cost
  - Suspended duration and cost
  - Memory tier and pricing rates
  - Total cost
- **Three-level cost hierarchy**:
  - Overall cost (all notebooks) — top of panel
  - Per-session cost (accumulated across VM rotations) — shown per notebook in eternal mode
  - Per-VM cost — current VM's running/suspended/burst breakdown
- **Rotation metadata** — shows rotation count and total VMs served per session (eternal mode only)
- Persists across proxy restarts (stored in SQLite database)
- Uses published Lambda MicroVM pricing: `$0.0000133/GB-sec` (running), `$0.0000000309/GB-sec` (suspended)

**Burst Billing:**
- MicroVMs are pre-allocated 4× baseline resources (memory + CPU) from boot
- You pay the baseline rate for the entire running duration
- Usage **above baseline** (actual RSS > configured memory) incurs per-second burst surcharge at the same rate
- Exceeding the 4× hard ceiling causes OOM crash — there is no dynamic scaling beyond 4×

| Baseline | Peak (4×) | Visible RAM | CPU Cores |
|----------|-----------|-------------|-----------|
| 1 GB | 4 GB | Always 4 GB | 2 |
| 2 GB | 8 GB | Always 8 GB | 4 |
| 4 GB | 16 GB | Always 16 GB | 8 |
| 8 GB | 32 GB | Always 32 GB | 16 |

### 3.6 Session Persistence — Two Modes

Lambda MicroVMs have a maximum lifetime of 8 hours (AWS-imposed). To provide longer sessions, the proxy manages state persistence automatically in one of two modes:

| | Eternal Mode (default) | Checkpoint Mode |
|---|---|---|
| Behavior | VM rotates transparently before expiry. Session never dies. | State saved to S3 on terminate. User restores manually. |
| User experience | Seamless — no disconnect, no action needed | Sees "Session saved" → clicks "Restore" on next open |
| Mechanism | Launch VM2 → checkpoint → restore → swap routing → terminate VM1 | `/terminate` hook saves state → VM dies → user launches new VM with `restoreFromSession` |
| Downtime | ~5-10s (quiesced, requests queued) | Full stop until user restores |
| Best for | Always-on notebooks, long-running analysis | Cost-sensitive, intermittent usage |

**What's preserved across rotations/restores:** Python variables, DataFrames, local `/tmp/` files, pip-installed packages.

**What's excluded:** Modules (re-imported automatically), matplotlib Figure objects (transient — data preserved, re-run plot cell to regenerate).

> **PFR filed:** A Product Feature Request has been submitted to increase the MicroVM maximum lifetime from 8 hours to 2 weeks. Once approved, the rotation/checkpoint mechanism becomes unnecessary for most use cases — a single VM will outlive typical user sessions without any state transfer.

### 3.7 UI & Theming
- **Light/Dark theme toggle** — persists across sessions (rotation animation on hover)
- **Python syntax highlighting** — Prism.js-powered with One Dark-inspired colors
- **SVG icons** throughout (Lucide-style, consistent stroke weight)
- **Centralized CSS design tokens** — all colors, spacing, shadows via CSS custom properties
- **Cell dip effect** — subtle lift on hover/select with shadow

### 3.8 SQL Cell Type (DuckDB + Athena)

The notebook supports native SQL cells alongside Python and Text cells. SQL execution is powered by **DuckDB** (in-process) with transparent **Athena** routing for remote tables.

**Cell Types:**
| Type | Icon | Execution |
|------|------|-----------|
| Code | `</>` (blue) | Python via `/execute` |
| SQL | 🗄️ (orange) | DuckDB/Athena via `/execute-sql` |
| Text | T (gray) | Markdown rendering (no execution) |

**Supported SQL Data Sources:**

| Source | Syntax | Engine |
|--------|--------|--------|
| In-memory DataFrame | `SELECT * FROM df_name` | DuckDB |
| Local CSV file | `SELECT * FROM '/tmp/file.csv'` | DuckDB |
| Local JSON file | `SELECT * FROM '/tmp/file.json'` | DuckDB |
| Local Parquet file | `SELECT * FROM '/tmp/file.parquet'` | DuckDB |
| S3 CSV file | `SELECT * FROM read_csv('s3://bucket/key.csv')` | DuckDB + httpfs |
| S3 JSON file | `SELECT * FROM read_json('s3://bucket/key.json')` | DuckDB + httpfs |
| S3 Parquet file | `SELECT * FROM read_parquet('s3://bucket/key.parquet')` | DuckDB + httpfs |
| DynamoDB table | `SELECT * FROM dynamodb."table-name"` | PartiQL → DuckDB fallback |
| Athena table | `SELECT * FROM microvm_demo_db.table_name` | Athena (auto-detected) |

**Intelligent Auto-Routing:**
- The engine detects data source references and routes transparently — the user just writes standard SQL
- **Pure local** — all references are DataFrames, files, or S3 → runs in DuckDB (instant)
- **Pure Athena** — all references are Athena tables → sends SQL directly to Athena
- **Pure DynamoDB** — simple queries (SELECT/WHERE/LIMIT) → runs server-side via PartiQL (efficient, no full scan)
- **Mixed query** — e.g. `JOIN '/tmp/local.csv' WITH microvm_demo_db.customers` or `JOIN dynamodb."products"` → remote tables are auto-materialized into DataFrames, then DuckDB executes the full query locally
- Output shows which engine ran: 🦆 DuckDB, ⚡ Athena, 🔶 DynamoDB (PartiQL), ⚡🦆 Athena → DuckDB, 🔶🦆 DynamoDB → DuckDB

**DynamoDB SQL — PartiQL-First Strategy:**

DynamoDB queries use a two-tier execution model:

1. **PartiQL first** (server-side) — For simple single-table queries without JOINs or GROUP BY, the SQL is sent directly to DynamoDB via [PartiQL](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ql-reference.html). This is efficient — WHERE clauses with partition keys use indexes, and LIMIT prevents full scans.

2. **Fallback to scan → DuckDB** — If PartiQL can't handle the query (JOIN, GROUP BY, HAVING, UNION, or any syntax DynamoDB doesn't support), the table is scanned into a DataFrame, registered in DuckDB, and the full query runs locally.

```sql
-- Simple query → runs via PartiQL (server-side, fast)
SELECT * FROM dynamodb."microvm-demo-data" WHERE category = 'Electronics'

-- Complex query → scans table, then DuckDB handles the JOIN locally
SELECT d.name, d.price, s.quantity
FROM dynamodb."microvm-demo-data" d
JOIN '/tmp/sales_data.csv' s ON d.name = s.product
```

**DynamoDB optimizations:**
- **Caching** — full table scans are cached in-memory for the VM lifetime (no re-scan on repeated queries)
- **LIMIT pushdown** — simple `SELECT * LIMIT N` queries only fetch N items from DynamoDB
- **Item count warning** — tables with >10,000 items show a warning suggesting LIMIT

**S3 Access:**
- DuckDB's `httpfs` extension is pre-configured with AWS credentials from the MicroVM execution role
- No boto3 pre-loading needed — query S3 directly in SQL

**DataSource Panel:**
- Clicking a data source shows a Python/SQL choice popover
- SQL option generates the correct syntax for the source type and file extension
- All sources (local files, S3, DynamoDB, Athena) have SQL options; Public APIs are Python-only

**Export:**
- HTML/MD exports label SQL cells as "SQL — Cell N" with proper syntax highlighting
- `.ipynb` export uses `%%sql` magic for round-trip compatibility with Jupyter
- Native `.notebook.json` preserves the `type: "sql"` field directly

### 3.9 Variable Explorer
- **Collapsible right panel** (280px default, resizable by dragging left edge)
- **Auto-refreshes** after each cell execution
- **Rich type previews** per variable:
  - DataFrames/Series → HTML mini-table
  - Lists → indexed vertical list
  - Dicts → key-value row display
  - Color lists → hex swatches with color preview
  - Booleans → green/red badges
  - Numbers → locale-formatted with commas
  - URLs → clickable links
  - File paths → directory + bold filename
  - Datetimes → human-readable format
  - matplotlib objects → "Plot object" badge
  - None → greyed "null" pill
- **Expandable detail** per variable: size, shape, preview
- Modules and functions filtered out (only user data shown)

---

## 4. Architecture

### 4.1 Local Dev Mode (`./dev_run.sh`)

```
┌──────────────────────┐           ┌───────────────────────────────────┐
│   React Notebook UI  │  HTTP     │     Local Sandbox Backend         │
│   (localhost:5173)   ├──────────►│     (localhost:8080)              │
│                      │  Direct   │                                   │
│  Sidebar + Cells     │  (no auth)│  FastAPI + SandboxExecutor        │
└──────────────────────┘           └───────────────────────────────────┘
```

### 4.2 AWS MicroVM Mode (`./aws_microvm_run.sh`)

```
┌──────────────────────┐           ┌───────────────────────────────────┐
│   React Notebook UI  │  HTTP     │       Smart Proxy (:8081)         │
│   (localhost:5173)   ├──────────►│                                   │
│                      │           │  Session-Based Routing            │
│  Header:             │           │  ┌───────────────────────────┐    │
│  X-Session-Id: uuid  │           │  │ Caller sends ONLY         │    │
│                      │           │  │ X-Session-Id header.      │    │
│                      │           │  │ Proxy resolves → VM       │    │
│                      │           │  │ internally. No VM IDs,    │    │
│                      │           │  │ endpoints, or auth tokens │    │
│                      │           │  │ leak to the caller.       │    │
│                      │           │  └───────────────────────────┘    │
│                      │           │                                   │
│                      │           │  POST /launch    — provision VM   │
│                      │           │  POST /terminate — destroy session│
│                      │           │  POST /resume    — wake suspended │
│                      │           │  GET  /instances — list + cost    │
│                      │           │  */proxy/*       — forward to VM  │
│                      │           │  POST /ai/chat   — Strands Agent  │
│                      │           │                                   │
│                      │           │  Internal (hidden from caller):   │
│                      │           │  • Session Registry (sid → VM)    │
│                      │           │  • Auth token generation (JWE)    │
│                      │           │  • VM rotation (eternal mode)     │
│                      │           │  • Checkpoint orchestration       │
│                      │           │                                   │
└──────────────────────┘           └────────────┬──────────────────────┘
                                                │
                                   HTTPS + JWE  │  (proxy handles auth)
                                                ▼
           ┌──────────────────┐  ┌──────────────────┐
           │  MicroVM (Tab 1) │  │  MicroVM (Tab 2) │
           │  Firecracker VM  │  │  Firecracker VM  │
           │  FastAPI+Executor│  │  FastAPI+Executor│
           └──────────────────┘  └──────────────────┘

The proxy also calls Amazon Bedrock (Claude Sonnet) via the Strands Agents SDK for AI features (chat, explain, fix). The agent runs in the proxy process — not inside the MicroVM — to avoid image bloat and rebuild cycles.
```

**Why session-based routing?** The proxy abstracts all MicroVM internals (VM IDs, endpoints, auth tokens) behind a single `X-Session-Id` header. This design enables:

- **Transparent VM rotation** — When a VM is swapped (eternal mode), the caller doesn't notice. Same session ID, same API, different VM underneath.
- **No credential leakage** — The caller never handles AWS auth tokens or knows the VM endpoint. The proxy generates and injects JWE tokens per-request.
- **Simplified frontend** — The UI only tracks session IDs, not VM lifecycle state. Connection management is fully server-side.
- **Mode-agnostic callers** — The same API works identically in eternal and checkpoint mode. The persistence strategy is a proxy concern, not a caller concern.

### 4.3 Data Source Connectivity

```
┌──────────────────────────────────────────────────────────────────────────┐
│ AWS Account                                                              │
│                                                                          │
│  ┌─────────────────────┐                                                 │
│  │  Lambda MicroVM     │                                                 │
│  │  (Firecracker VM)   │                                                 │
│  │                     │                                                 │
│  │  Your notebook code │                                                 │
│  │  runs here          │                                                 │
│  └─────────┬───────────┘                                                 │
│            │                                                             │
│            ├──── Internet Egress (default) ────────►  Public APIs        │
│            │     No VPC needed                        • REST APIs        │
│            │                                          • Open-Meteo       │
│            │                                          • CoinGecko        │
│            │                                                             │
│            ├──── IAM Execution Role ──────────────►  AWS Services        │
│            │     Credentials auto-injected            • S3               │
│            │                                          • DynamoDB         │
│            │                                          • Athena + Glue    │
│            │                                          • STS              │
│            │                                                             │
│            └──── VPC Egress Connector ───────────►  Private VPC          │
│                  ENI in your subnets                   • RDS             │
│                                                       • ElastiCache      │
│                                                       • OpenSearch       │
│                                                       • On-prem (DX)     │
└──────────────────────────────────────────────────────────────────────────┘
```

| Pattern | How | Use Case |
|---------|-----|----------|
| Internet Egress | Default `INTERNET_EGRESS` connector | Public APIs, external SaaS |
| AWS Services (IAM) | Execution role permissions | S3, DynamoDB, Athena, Glue, STS |
| Private VPC | VPC egress connector (ENI) | RDS, ElastiCache, internal APIs |
| On-premises | VPC + Direct Connect/VPN | Enterprise databases |

---

## 5. Usage

### 5.1 Cells
- **Execute** — `Shift+Enter` or click ▶
- **Run All** — `▶▶ Run All` in toolbar executes all cells sequentially
- **Add cell** — `+ Code`, `+ SQL`, or `+ Text` buttons at bottom (or toolbar)
- **Cell types** — Code cells run Python, SQL cells run DuckDB/Athena queries, Text cells render Markdown
- **Delete cell** — 🗑 button; deleting the last cell replaces it with a fresh empty cell

### 5.2 AI Features
- **Chat** — The AI panel opens automatically with each notebook. Ask questions, request code, or get analysis. Code in responses has "Insert Cell" buttons.
- **Explain** — Click ✨ on a code cell to get a plain-English explanation card.
- **Fix** — When a cell has an error, click 🔧 to get an AI-suggested fix with one-click apply.
- **Generate** — In a new empty cell, type what you want in natural language and click ✨ to convert to Python.
- **Annotate** — Click the Annotate toolbar button to auto-document all code cells with AI explanations and markdown summaries.

### 5.3 Rich Output
- **DataFrames** — Type `df` or `df.head()` as the last line → renders as a styled table (max 50 rows with truncation note)
- **Plots** — `plt.plot(...)` or `plt.show()` → renders inline as PNG
- **Text** — `print(...)` → monospace text output

### 5.4 Files & Data Sources
- Click `↑` in the Data Sources sidebar section to upload files
- Supported: `.csv`, `.xlsx`, `.xls`, `.parquet`, `.json`
- Files auto-load as pandas DataFrames (variable name derived from filename)
- **Click any data source** (uploaded file, S3 object, DynamoDB table, Athena table) to insert ready-to-run code into the active cell
- S3, DynamoDB, and Athena sources are auto-discovered from your AWS account

### 5.5 Packages
- Click **Packages** in the toolbar to open the Package Manager
- View all installed packages with version numbers
- Install new packages (supports version pinning: `scikit-learn==1.5.1`)
- Pre-baked in image: `pandas`, `numpy`, `polars`, `matplotlib`, `requests`, `psutil`, `openpyxl`, `xlrd`, `pyarrow`, `scipy`, `boto3`
- Runtime installs persist across suspend/resume

### 5.6 Notebooks
- **Save** — Downloads a `.notebook.json` (includes code, output, tables, charts)
- **Open** — Opens a saved notebook file as a new tab
- **Rename** — Double-click the notebook name in the sidebar

### 5.7 MicroVM Instances
- **Launch** — Click "Launch New MicroVM" in the connection panel (select 2/4/8 GB tier)
- **Attach** — Connect a running instance to the current notebook
- **Detach** — Detach a VM (stays running, will suspend after idle timeout)
- **Terminate & Save** — Checkpoint state to S3 on termination
- **Restore Session** — Launch a new VM from a previous S3 checkpoint
- **Resume & Attach** — Resume a suspended instance
- **Close notebook** — Automatically terminates the attached MicroVM

### 5.8 Cost Tracking
- Click the **MicroVMs** footer in the sidebar to open the Instances panel
- Each MicroVM shows its estimated cost in the **Est. Cost** column
- **Hover** over any cost figure to see a detailed tooltip:
  - Running time and its cost contribution
  - Suspended time and its cost contribution
  - Memory tier and pricing rates
- The **footer** shows the aggregated session total across all MicroVMs
- Cost data refreshes every 15 seconds (same interval as instance state polling)

---

## 6. Configuration

### 6.1 AWS & Infrastructure Settings

Edit `scripts/config.sh`:

```bash
AWS_REGION="us-west-2"          # MicroVM region
AWS_CLI_PROFILE="default"       # AWS CLI profile
IMAGE_NAME="agent-sandbox"      # MicroVM image name
IMAGE_SIZES="1024 2048 4096 8192"  # Memory tiers to build (MiB)
```

### 6.2 Ports & Polling

```bash
PROXY_PORT="8081"               # Smart proxy port
BACKEND_PORT="8080"             # Local sandbox backend port
POLL_INTERVAL_MS="10000"        # Instance state refresh interval (ms)
```

### 6.3 Storage Backend

```bash
STORAGE_BACKEND="sqlite"        # "sqlite", "mysql", "postgres"
STORAGE_CONNECTION=""            # Connection string (empty for sqlite)
```

The storage layer is abstracted behind an interface (`proxy/storage/interface.py`). Switch backends by changing `STORAGE_BACKEND` and providing a connection string.

### 6.4 Pricing & Retention

```bash
PRICE_RUNNING_PER_GB_SEC="0.0000133"      # Compute rate
PRICE_SUSPENDED_PER_GB_SEC="0.0000000309" # Snapshot storage rate
METRICS_RETENTION_HOURS="168"             # Keep metrics for 7 days
S3_CHECKPOINT_RETENTION_DAYS="30"         # S3 lifecycle rule
```

### 6.5 Sample Data Resources

```bash
DYNAMO_TABLE="microvm-demo-data"   # DynamoDB table name
ATHENA_DB="microvm_demo_db"        # Athena database name
ATHENA_WORKGROUP="microvm-demo"    # Athena workgroup (has default S3 output)
```

### 6.4 AI Configuration

AI is configured via constants in `proxy/ai/constants.py`:

```python
CHAT_MODEL_ID = "us.anthropic.claude-sonnet-4-20250514"  # Full agent chat
EXPLAIN_MODEL_ID = "us.anthropic.claude-sonnet-4-20250514"  # Explain/Fix (direct calls)
MAX_TOKENS_CHAT = 4096
MAX_TOKENS_EXPLAIN = 2048
TEMPERATURE_CHAT = 0.7
TEMPERATURE_EXPLAIN = 0.3
CONVERSATION_WINDOW_SIZE = 10  # Sliding window for chat history
```

Set environment variables to override the region:

```bash
export AWS_REGION="us-west-2"  # Bedrock region (same as MicroVM region)
```

AI features auto-detect AWS credentials. If Bedrock is not available, AI buttons are hidden in the UI — everything else works normally.

### 6.5 Frontend Port Configuration

The frontend reads ports from Vite environment variables (set automatically by the launch scripts):

```bash
VITE_PROXY_PORT=8081    # Passed to React app at dev-server start
VITE_BACKEND_PORT=8080  # Used for local dev mode connections
```

These are derived from `PROXY_PORT` and `BACKEND_PORT` in `config.sh` — no manual setup needed.

### 6.6 Session Persistence

```bash
# Persistence mode: "eternal" (VMs rotate, session never dies) or "checkpoint" (save & stop)
SESSION_PERSISTENCE_MODE="eternal"

# Max lifetime before rotation/checkpoint (AWS max is 28800 = 8h)
MAX_LIFETIME_SECONDS="28800"

# How far before max lifetime to start rotation (eternal mode only)
ROTATION_LEAD_SECONDS="60"
```

**Eternal mode** — VMs swap transparently. Rotation starts at `MAX_LIFETIME - ROTATION_LEAD_SECONDS`. User never disconnects.

**Checkpoint mode** — No rotation timer. The AWS `/terminate` hook fires at max lifetime and saves the latest state to S3. User restores manually on next session.

Override for testing: `SESSION_PERSISTENCE_MODE=checkpoint MAX_LIFETIME_SECONDS=180 ./aws_microvm_run.sh`

---

## 7. Technical Details

### 7.1 Execution Queue
Cells execute sequentially — if Cell 2 depends on Cell 1, it waits for Cell 1 to complete. No race conditions.

### 7.2 Rich Output Detection
The executor automatically detects:
- **Last expression is a DataFrame** → converts to HTML table (max 50 rows, with truncation note showing total row count)
- **matplotlib has active figure** → captures as PNG, returns base64
- Works with both pandas and polars DataFrames

### 7.3 Token Authentication (MicroVM mode)
- Browser sends only `X-Session-Id` — never handles AWS credentials or VM endpoints
- Proxy resolves session → VM internally via the session registry
- Proxy generates JWE tokens via `create-microvm-auth-token` (cached 25 min, expire at 30)
- Each request forwarded to the VM with the injected auth token
- On VM rotation (eternal mode), the session registry updates — caller is unaware

### 7.4 Lifecycle Hooks

| Hook | When | Action |
|------|------|--------|
| `/ready` | Image build | Signals app initialized for snapshot |
| `/run` | MicroVM starts | Load session config |
| `/suspend` | Before idle suspend | Log state, flush output |
| `/resume` | After resume | Validate state |
| `/terminate` | Before termination | Checkpoint to S3 |

### 7.5 Idle Policy & VM Rotation
- Auto-suspend after idle timeout (configurable: 1 min – 2 hr)
- Auto-resume on traffic (~1s per 500MB)
- Max lifetime: **8 hours** (`MAX_LIFETIME_SECONDS=28800`)
- **Eternal mode**: Rotator fires at `max_lifetime - ROTATION_LEAD_SECONDS`. 7-step swap is transparent to the caller.
- **Checkpoint mode**: `/terminate` hook (called by AWS at max lifetime) saves state. No pre-checkpoint timer — always captures the latest state.
- Pre-termination wake timer ensures `/terminate` fires even if VM is suspended at expiry.

### 7.6 MicroVM Image Build
- Base: `public.ecr.aws/lambda/microvms:al2023-minimal`
- Runtime: **Python 3.11** (installed via dnf, venv-isolated)
- All hooks enabled (run, suspend, resume, terminate, ready)
- Memory tiers: 1 GB (0.5 vCPU), 2 GB (1 vCPU), 4 GB (2 vCPU), 8 GB (4 vCPU)
- Each tier can burst up to **4× baseline** during peak activity (baseline-peak model)
- All tiers build **in parallel** (~4-5 minutes total) with automatic retry on transient failures
- 512MB tier excluded (insufficient memory for pandas+numpy+matplotlib snapshot)

### 7.7 Cost Tracking Implementation
- `proxy/cost_tracker.py` — `CostTracker` class records state transitions per MicroVM
- State observations come from the `/instances` polling loop (every 15 seconds) — calls AWS control-plane API, NOT the VM
- Initial `RUNNING` state recorded at launch time
- Cost formula: `memory_gb × seconds_in_state × rate_per_gb_sec`
- Rates configurable via env vars: `PRICE_RUNNING_PER_GB_SEC` (default `$0.0000133`), `PRICE_SUSPENDED_PER_GB_SEC` (default `$0.0000000309`)
- Persists across proxy restarts (stored in SQLite)

### 7.8 Storage Layer (`proxy/storage/`)

Persistent state is stored via an abstracted storage backend. The default backend is SQLite (`proxy/data/microvm.db`, auto-created on first run). Switch to MySQL/Postgres for cloud deployments via `STORAGE_BACKEND` env var.

| Table | Purpose |
|-------|---------|
| `notebooks` | Notebook CRUD — replaces browser localStorage as source of truth |
| `vm_sessions` | VM lifecycle tracking — links VMs to notebooks, stores costs |
| `vm_metrics` | Time-series resource data (CPU, memory, disk) polled after each cell execution |
| `vm_state_log` | Audit trail of state transitions (RUNNING → SUSPENDED → TERMINATED) |
| `ai_sessions` | AI chat history per notebook |

- **Abstract interface**: `proxy/storage/interface.py` defines all method signatures
- **SQLite implementation**: `proxy/storage/sqlite_db.py` (default)
- **Notebook persistence**: Frontend saves to both localStorage (offline fallback) and SQLite API (source of truth)
- **Auto-migration**: On first load, localStorage notebooks are migrated to SQLite
- **Metrics on-demand**: Resource metrics are fetched from the VM only after cell execution (not continuously) to avoid preventing idle suspension
- **Metrics retention**: Configurable via `METRICS_RETENTION_HOURS` (default: 168h / 7 days)
- API endpoints: `GET/POST/PUT/DELETE /notebooks`, `GET /instances/metrics/history/:id`

### 7.9 Live Resource Monitoring

Each MicroVM exposes a `GET /metrics` endpoint (powered by `psutil`):
- **CPU %** — process CPU utilization since last measurement
- **Memory %** — Python process RSS as percentage of allocated memory
- **Disk %** — `/tmp` usage (where user data files live)
- **Network** — cumulative bytes sent/received
- **Processes** — active process count
- **Uptime** — seconds since VM boot

Metrics are fetched on-demand (after each cell execution), NOT continuously polled. This ensures idle VMs properly suspend after their timeout.

### 7.8 Session Checkpoint & Restore

**Save (checkpoint.py):**
1. Exclude Python modules (`types.ModuleType`) — they're re-importable, and including them causes `_csv.writer`-style serialization failures
2. `dill.dumps(namespace)` — bulk serialize. If it fails, per-variable fallback skips only the broken ones.
3. `tar /tmp/*.csv,*.parquet,...` → `files.tar.gz`
4. User-installed packages (tracked via `/install` endpoint) → `requirements.txt`
5. Upload all to `s3://bucket/sessions/{session_id}/`

**Restore (checkpoint.py):**
1. Download `checkpoint.pkl` → `dill.loads()` → restore namespace
2. `copy.deepcopy()` all mutable containers (lists, dicts, sets) — breaks dill internal references that prevent re-serialization on the next rotation
3. Extract `files.tar.gz` → `/tmp/`
4. `pip install` packages from `requirements.txt`

**What's preserved:** Variables, DataFrames, computed results, local data files, pip packages.
**What's excluded:** Modules (re-imported), matplotlib Figure/Axes objects (transient display — data preserved, re-run plot cell).

**Mode-specific behavior in `/terminate` hook:**
- **Checkpoint mode** → always saves (captures latest state right before VM dies)
- **Eternal mode** → skips save (rotator already handled state transfer via `/checkpoint-save` + `/restore-state`)

### 7.9 Sample Data (auto-provisioned)
- **DynamoDB** — table `microvm-demo-data` with 10 sample products
- **S3** — 4 CSV files in `samples/` prefix (sales_data, customers, web_traffic, ab_test_results)
- **Athena** — database `microvm_demo_db` with 4 external tables over the S3 CSVs
- **Athena Workgroup** — `microvm-demo` with pre-configured output location (no bucket needed in queries)

### 7.10 Pre-baked Packages
```
pandas, numpy, polars, matplotlib, requests, psutil,
openpyxl (Excel .xlsx), xlrd (Excel .xls), pyarrow (Parquet),
scipy (statistics), boto3 (AWS SDK), duckdb (SQL engine)
```

---

## 8. Project Structure

```
.
├── app/                          # MicroVM sandbox (runs INSIDE the Firecracker VM)
│   ├── server.py                 # FastAPI entrypoint: shared state, pre-loaded libs, router registration
│   ├── platform/                 # Infrastructure layer — MicroVM lifecycle
│   │   ├── hooks.py              # Lifecycle hooks: /run, /suspend, /resume, /terminate, /checkpoint-save, /restore-state
│   │   └── checkpoint.py         # S3 checkpoint/restore: dill serialize, module exclusion, deepcopy on restore
│   └── notebook/                 # Application layer — notebook execution
│       ├── executor.py           # SandboxExecutor: stateful Python execution engine
│       ├── code_engine.py        # Python execution: /execute endpoint
│       ├── sql_engine.py         # SQL execution: /execute-sql with DuckDB/Athena/DynamoDB auto-routing
│       └── routes.py             # Utility: /install, /variables, /health, /metrics, /upload, /files
├── proxy/                        # Smart proxy (runs on your machine, hides all VM internals)
│   ├── server.py                 # FastAPI entrypoint: app setup, swap callback, health
│   ├── platform/                 # Smart MicroVM Service layer (reusable, app-agnostic)
│   │   ├── microvm_manager.py    # MicrovmManager: session registry, tokens, timers, cost, AWS client
│   │   ├── session_rotator.py    # SessionRotator: transparent VM rotation (eternal mode)
│   │   ├── cost_tracker.py       # CostTracker: burst + baseline cost with DB persistence
│   │   └── routes/
│   │       ├── microvm.py        # /launch, /terminate, /suspend, /resume, /proxy/{path}, /instances
│   │       ├── sessions.py       # S3 session checkpoints, data sources
│   │       └── metrics.py        # VM metrics, image tiers
│   ├── notebook/                 # Notebook application layer (specific to this project)
│   │   ├── ai/                   # AI module (Strands Agents SDK)
│   │   │   ├── constants.py      # All AI config constants
│   │   │   ├── prompts.py        # XML-structured system prompts
│   │   │   ├── sessions.py       # Per-notebook session management
│   │   │   ├── notebook_agent.py # Strands Agent definition with tools
│   │   │   └── tools/
│   │   │       ├── execution_tools.py  # Agent tools: execute_code, get_variables, install_package
│   │   │       └── notebook_tools.py   # Agent tools: insert_cell, edit_cell
│   │   └── routes/
│   │       ├── ai.py             # AI chat, explain, fix, suggest-tag
│   │       └── notebooks.py      # Notebook CRUD
│   ├── storage/                  # Shared storage backend
│   │   ├── __init__.py           # Backend selection (STORAGE_BACKEND env var)
│   │   ├── interface.py          # Abstract StorageBackend class (the contract)
│   │   └── sqlite_db.py          # SqliteStorage implementation (default)
│   └── data/                     # SQLite database file (auto-created, gitignored)
│       └── microvm.db
├── web/
│   └── src/
│       ├── App.jsx               # Layout, state, tab management
│       ├── config.js             # Runtime config (ports from Vite env vars)
│       ├── theme.css             # Design tokens (light + dark themes)
│       ├── components/
│       │   ├── Cell.jsx          # Code cell: collapse, drag, timer, AI buttons
│       │   ├── Notebook.jsx      # Toolbar, cell management, search, drag-reorder
│       │   ├── ConnectionPanel.jsx  # MicroVM connection + launch + restore
│       │   ├── AiChatPanel.jsx   # Right-side AI chat panel (SSE streaming)
│       │   ├── Sidebar.jsx       # Activity bar + panel container
│       │   ├── panels/           # Individual sidebar panel components
│       │   │   ├── NotebooksPanel.jsx
│       │   │   ├── OutlinePanel.jsx
│       │   │   ├── DataSourcesPanel.jsx
│       │   │   ├── SamplesPanel.jsx
│       │   │   ├── VariablesPanel.jsx
│       │   │   ├── PackagesPanel.jsx
│       │   │   ├── MicroVMsPanel.jsx
│       │   │   └── AboutPanel.jsx
│       │   ├── Icons.jsx         # SVG icon components (35+)
│       │   └── Modal.jsx         # Reusable confirm/input modals
│       └── services/
│           ├── microvm.js        # Proxy API client (all calls use X-Session-Id)
│           ├── notebooks.js      # Notebook API client (CRUD, migration)
│           └── sanitize.js       # HTML sanitization (DOMPurify)
├── tests/
│   ├── run_tests.sh             # Test runner — auto-detects mode, runs common + mode-specific tests
│   ├── common/                  # Mode-agnostic tests (run in both eternal and checkpoint)
│   │   ├── test_burst_behavior.py
│   │   ├── test_interrupt_execution.py
│   │   ├── test_microvm_lifecycle.py
│   │   └── test_sql_engine.py
│   ├── eternal/                 # Eternal-mode-only tests
│   │   └── test_rotation.py    # 5-rotation comprehensive test (6 VMs, state across rotations)
│   ├── checkpoint/              # Checkpoint-mode-only tests
│   │   ├── test_auto_checkpoint.py  # Terminate hook saves + restore on new VM
│   │   └── test_s3_restore.py      # Checkpoint/restore timing and verification
│   └── test_resume_before_expire.py # Pre-termination wake timer test
├── scripts/
│   ├── config.sh               # All config (region, ports, sizes, pricing, modes, retention)
│   ├── setup_iam.sh            # Create IAM roles + S3 bucket
│   ├── build_all_images.sh     # Parallel image build (all tiers) with retry
│   ├── setup_sample_data.sh    # DynamoDB + S3 + Athena tables + workgroup
│   └── teardown.sh             # Terminate MicroVMs + delete images
├── iam/                    # IAM trust and permission policies
├── docs/                   # Customer-facing documentation
├── Dockerfile              # MicroVM image (al2023-minimal, Python 3.11)
├── requirements.txt        # MicroVM sandbox Python deps
├── requirements-proxy.txt  # Proxy server deps (Strands Agents, FastAPI, boto3)
├── dev_run.sh              # One-command local dev
├── aws_microvm_run.sh      # One-command AWS mode
└── README.md
```

---

## 9. Tests

Tests are organized by persistence mode. The test runner auto-detects the proxy's mode and runs the appropriate suite.

### Running Tests

```bash
# Start proxy in desired mode, then run:
bash tests/run_tests.sh
```

The runner queries `/health` to detect `persistence_mode`, then executes:
1. **Common tests** (always run) — mode-agnostic functionality
2. **Mode-specific tests** — eternal OR checkpoint, based on detected mode

### Test Structure

```
tests/
├── run_tests.sh              # Auto-detect mode, run common + mode-specific
├── common/                   # Run in BOTH modes
│   ├── test_burst_behavior.py       # 4× baseline burst model validation
│   ├── test_interrupt_execution.py  # Kill long-running cells mid-execution
│   ├── test_microvm_lifecycle.py    # Full state machine: launch → execute → suspend → resume → terminate → restore
│   └── test_sql_engine.py           # 12 SQL routing tests: local, S3, Athena, DynamoDB, mixed JOINs
├── eternal/                  # Run only when mode=eternal
│   └── test_rotation.py            # 5-rotation test: state survives across 6 VMs, packages, files, mutations
└── checkpoint/               # Run only when mode=checkpoint
    ├── test_auto_checkpoint.py      # /terminate hook saves state, restore on new VM verifies all preserved
    └── test_s3_restore.py           # Checkpoint timing, S3 artifact verification, restore fidelity
```

### Example Output

```
============================================
  MicroVM Test Suite
============================================
>> Checking proxy...
  Mode: checkpoint
  Max Lifetime: 180s
>> Common tests (mode-agnostic)
  Running test_burst_behavior... PASSED
  Running test_interrupt_execution... PASSED
  Running test_microvm_lifecycle... PASSED
  Running test_sql_engine... PASSED
>> Checkpoint mode tests
  Running test_auto_checkpoint... PASSED
  Running test_s3_restore... PASSED
============================================
  Results: 6 passed, 0 failed, 0 skipped
============================================
```

### Test Configuration

For fast iteration, use short lifetimes:

```bash
# Checkpoint mode (rotation fires at terminate hook)
SESSION_PERSISTENCE_MODE=checkpoint MAX_LIFETIME_SECONDS=180 bash aws_microvm_run.sh

# Eternal mode (rotation fires at 120s = 180-60)
SESSION_PERSISTENCE_MODE=eternal MAX_LIFETIME_SECONDS=180 ROTATION_LEAD_SECONDS=60 bash aws_microvm_run.sh
```

All tests use `X-Session-Id` header only — no VM IDs or endpoints referenced.

---

## 10. Cost

### 10.1 Estimated AWS Cost

4 GB / 2 vCPU sandbox, 1 hour active per day:

| Component | Monthly |
|-----------|---------|
| Compute (active) | ~$5.30 |
| Snapshot storage (~2 GB) | ~$0.19 |
| Suspend/resume IO | ~$0.10 |
| **Total** | **~$5.60** |

### 10.2 In-App Cost Tracking

The application tracks and displays estimated cost per MicroVM in real time:
- Cost is computed from observed RUNNING and SUSPENDED durations
- Displayed in the Instances panel (hover for breakdown)
- Based on published pricing — actual AWS bill may vary slightly due to rounding

### 10.3 Burst Billing Model

Lambda MicroVMs use a **baseline-peak model** where 4× resources are pre-allocated at boot:

```
Cost = Baseline Cost + Burst Surcharge

Baseline Cost = baseline_gb × running_seconds × $0.0000133/GB-sec
Burst Surcharge = max(0, used_gb - baseline_gb) × burst_seconds × $0.0000133/GB-sec
```

**Key findings from testing (`tests/test_burst_behavior.py`):**
- Resources are pre-allocated at 4× baseline from the moment the VM boots
- `psutil.virtual_memory().total` always reports 4× baseline (e.g., 4GB for a 1GB VM)
- `total_mb` NEVER changes during load — it's fixed at 4×
- Burst billing applies when **actual usage (RSS)** exceeds the configured baseline
- Exceeding the 4× peak ceiling causes an OOM crash — there is no dynamic scaling beyond 4×
- CPU cores are also fixed at 4× baseline vCPU (2 cores for 1GB, 4 for 2GB, etc.)

**Example: 2 GB baseline, workload uses 5 GB for 120 seconds:**
- Baseline: 2 GB × total_running_time × rate = always billed
- Burst: (5 - 2) = 3 GB × 120s × $0.0000133 = $0.004788 surcharge

---

## 11. References

- [AWS Lambda MicroVMs Docs](https://docs.aws.amazon.com/lambda/latest/dg/lambda-microvms-guide.html)
- [Launch Blog Post](https://aws.amazon.com/blogs/aws/run-isolated-sandboxes-with-full-lifecycle-control-aws-lambda-introduces-microvms/)
- [MicroVM Networking](https://docs.aws.amazon.com/lambda/latest/dg/microvms-networking.html)
- [Running & Lifecycle](https://docs.aws.amazon.com/lambda/latest/dg/microvms-launching.html)
- [Pricing](https://aws.amazon.com/lambda/pricing/)

---

## 12. License

This project is licensed under the Apache License 2.0. See [LICENSE](LICENSE) for the full license text.

## 13. Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## 14. Security

See [CONTRIBUTING.md](CONTRIBUTING.md) for reporting security issues.
If you discover a potential security issue, please do **not** create a public GitHub issue.
