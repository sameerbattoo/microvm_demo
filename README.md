# Lambda MicroVM Notebook

A **Python notebook** web application demonstrating **AWS Lambda MicroVMs** as isolated
code execution sandboxes — the primary use case for this new serverless compute primitive.

> **Note:** This is a proof-of-concept / demo application. It currently supports Python as the
> execution language but the architecture is extensible to other runtimes (R, Node.js, Julia, etc.)
> by swapping the executor and MicroVM image.

## What This Is

A browser-based Python notebook (React UI) backed by stateful execution sandboxes running
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
4. Starts the token proxy (`:8081`)
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
- Launch new MicroVMs from the connection panel (5 memory tiers: 512MB–8GB)
- **Idle suspend** configurable: 1 min, 2 min, 5 min, 15 min, 30 min, 1 hr, 2 hr
- **Max lifetime** configurable: 1 hr, 2 hr, 4 hr, 8 hr
- Instance cards in sidebar show: spec, session, lifecycle, real-time cost breakdown with rates
- Attach existing running instances to notebooks
- Resume suspended instances (auto-resume on traffic ~1s)
- Terminate instances (with optional S3 checkpoint)
- Live state refresh every 10–15 seconds
- Auto-reconnect on page refresh
- Badge on activity bar icon shows running VM count

### 3.5 Cost Tracking
- **Real-time estimated cost** per MicroVM displayed in the Instances panel
- Tracks time in RUNNING and SUSPENDED states via the proxy
- **Hover tooltip** on any cost figure shows detailed breakdown:
  - Running duration and cost
  - Suspended duration and cost
  - Memory tier
  - Pricing rates applied
- **Session total** in the panel footer (aggregated across all tracked MicroVMs)
- Persists across page refreshes (tracked in proxy process memory)
- Uses published Lambda MicroVM pricing: `$0.0000133/GB-sec` (running), `$0.0000000309/GB-sec` (suspended)

### 3.6 Session Checkpoint & Restore
- Enable "session restore" when launching a MicroVM
- On termination, state is serialized to S3 (variables, files, packages)
- Launch a new MicroVM and select "Restore from session" to resume where you left off
- Extends effective session lifetime beyond the 8-hour VM maximum

### 3.7 UI & Theming
- **Light/Dark theme toggle** — persists across sessions (rotation animation on hover)
- **Python syntax highlighting** — Prism.js-powered with One Dark-inspired colors
- **SVG icons** throughout (Lucide-style, consistent stroke weight)
- **Centralized CSS design tokens** — all colors, spacing, shadows via CSS custom properties
- **Cell dip effect** — subtle lift on hover/select with shadow

### 3.8 Variable Explorer
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
│   React Notebook UI  │  HTTP     │       Token Proxy (:8081)         │
│   (localhost:5173)   ├──────────►│                                   │
│                      │           │  POST /launch    — provision VM   │
│  Sidebar + Cells     │           │  POST /terminate — destroy VM     │
│                      │           │  POST /resume    — wake suspended │
│  AI Chat (right)     │           │  GET  /instances — list + cost    │
│  Explain/Fix/Gen     │           │  */proxy/*       — auth + forward │
│                      │           │  POST /ai/chat   — Strands Agent  │
│                      │           │  POST /ai/explain— direct Bedrock │
│                      │           │  POST /ai/fix    — direct Bedrock │
│                      │           │  GET  /datasources — S3/DDB/Athena│
└──────────────────────┘           └────────────┬──────────┬───────────┘
                                                │          │
                                   HTTPS + JWE  │          │ Bedrock
                                                ▼          ▼
           ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
           │  MicroVM (Tab 1) │  │  MicroVM (Tab 2) │  │  Amazon Bedrock  │
           │  Firecracker VM  │  │  Firecracker VM  │  │  Claude Sonnet   │
           │  FastAPI+Executor│  │  FastAPI+Executor│  │  (Strands Agent) │
           └──────────────────┘  └──────────────────┘  └──────────────────┘
```

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
- **Add cell** — `+ Cell` button or `+` on any cell
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
IMAGE_SIZES="512 1024 2048 4096 8192"  # Memory tiers to build (MiB)
```

### 6.2 Ports & Polling

```bash
PROXY_PORT="8081"               # Token proxy port
BACKEND_PORT="8080"             # Local sandbox backend port
POLL_INTERVAL_MS="10000"        # Instance state refresh interval (ms)
```

### 6.3 Sample Data Resources

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
- Browser never handles AWS credentials
- Proxy generates JWE tokens via `create-microvm-auth-token`
- Tokens cached for 25 min (expire at 30)
- Each request forwarded with `X-aws-proxy-auth` header

### 7.4 Lifecycle Hooks

| Hook | When | Action |
|------|------|--------|
| `/ready` | Image build | Signals app initialized for snapshot |
| `/run` | MicroVM starts | Load session config |
| `/suspend` | Before idle suspend | Log state, flush output |
| `/resume` | After resume | Validate state |
| `/terminate` | Before termination | Checkpoint to S3 |

### 7.5 Idle Policy
- Auto-suspend after **30 minutes** idle
- Stay suspended up to **8 hours**
- Auto-resume on traffic (~1s per 500MB)
- Max lifetime: **8 hours**

### 7.6 MicroVM Image Build
- Base: `public.ecr.aws/lambda/microvms:al2023-minimal`
- Runtime: **Python 3.11** (installed via dnf, venv-isolated)
- All hooks enabled (run, suspend, resume, terminate, ready)
- Memory tiers: 0.5 GB (0.25 vCPU), 1 GB (0.5 vCPU), 2 GB (1 vCPU), 4 GB (2 vCPU), 8 GB (4 vCPU)
- Each tier can burst up to **4× baseline** during peak activity (baseline-peak model)
- All tiers build **in parallel** (~4-5 minutes total) with automatic retry on transient failures

### 7.7 Cost Tracking Implementation
- `proxy/cost_tracker.py` — `CostTracker` class records state transitions per MicroVM
- State observations come from the `/instances` polling loop (every 15 seconds)
- Initial `RUNNING` state recorded at launch time
- Cost formula: `memory_gb × seconds_in_state × rate_per_gb_sec`
- Rates: `$0.0000133/GB-sec` (running), `$0.0000000309/GB-sec` (suspended)
- Persists across page refreshes (in-memory on the proxy process)
- Resets on proxy restart (acceptable — proxy restart = fresh session)

### 7.8 Session Checkpoint & Restore

**Termination flow:**
1. `/terminate` hook fires (60s timeout)
2. `dill.dumps(executor namespace)` → `checkpoint.pkl`
3. `tar /tmp/*.csv,*.parquet` → `files.tar.gz`
4. `pip freeze` → `requirements.txt`
5. Upload all to `s3://bucket/sessions/{session_id}/`

**Restore flow:**
1. `/run` hook fires (60s timeout)
2. Download `checkpoint.pkl` → `dill.loads()` → restore namespace
3. Extract `files.tar.gz` → `/tmp/`
4. `pip install -r requirements.txt`
5. MicroVM ready with full previous state

**What's checkpointed:** Variables, local data files, runtime packages.
**What's NOT checkpointed:** Network connections, matplotlib figures, non-serializable objects.

### 7.9 Sample Data (auto-provisioned)
- **DynamoDB** — table `microvm-demo-data` with 10 sample products
- **S3** — 4 CSV files in `samples/` prefix (sales_data, customers, web_traffic, ab_test_results)
- **Athena** — database `microvm_demo_db` with 4 external tables over the S3 CSVs
- **Athena Workgroup** — `microvm-demo` with pre-configured output location (no bucket needed in queries)

### 7.10 Pre-baked Packages
```
pandas, numpy, polars, matplotlib, requests, psutil,
openpyxl (Excel .xlsx), xlrd (Excel .xls), pyarrow (Parquet),
scipy (statistics), boto3 (AWS SDK)
```

---

## 8. Project Structure

```
.
├── app/
│   ├── server.py           # FastAPI: lifecycle hooks, execute (async), upload, install, interrupt
│   └── executor.py         # Stateful Python executor with rich output, interrupt, variable inspection,
│                           # smart DataFrame enhancement (clickable URLs, number formatting, etc.)
├── proxy/
│   ├── server.py           # Token proxy: launch, terminate, resume, auth, datasources, cost tracking, AI endpoints
│   ├── cost_tracker.py     # CostTracker class: per-MicroVM cost estimation
│   └── ai/                 # AI module (Strands Agents SDK)
│       ├── __init__.py
│       ├── constants.py    # All AI config constants (model IDs, tokens, temperatures)
│       ├── prompts.py      # XML-structured system prompts for agent, explain, fix
│       ├── sessions.py     # Per-notebook session management (SlidingWindowConversationManager)
│       ├── notebook_agent.py  # Strands Agent definition with tools
│       └── tools/
│           ├── __init__.py
│           └── execution_tools.py  # Agent tools: execute_code, read_notebook_state, install_package
├── web/
│   └── src/
│       ├── main.jsx
│       ├── App.jsx              # Layout, state, tab management (debounced localStorage)
│       ├── App.css              # App shell, empty state welcome page
│       ├── config.js            # Runtime config (ports from Vite env vars)
│       ├── theme.css            # Design tokens (light + dark themes)
│       ├── syntax-theme.css     # Python syntax highlighting
│       ├── components/
│       │   ├── Cell.jsx         # Code cell: collapse, drag, timer, AI explain/fix/generate buttons
│       │   ├── Cell.css
│       │   ├── MarkdownCell.jsx     # Markdown/text cell: edit/render modes
│       │   ├── ConnectionPanel.jsx  # MicroVM connection + launch (dynamic tiers, idle/max config)
│       │   ├── ConnectionPanel.css
│       │   ├── Notebook.jsx     # Toolbar, cell management, search, drag-reorder, annotate
│       │   ├── Notebook.css
│       │   ├── AiChatPanel.jsx  # Right-side AI chat panel (per-notebook messages, SSE streaming)
│       │   ├── AiChatPanel.css
│       │   ├── Sidebar.jsx      # Activity bar + collapsible panels:
│       │   │                    #   • Notebooks — open tabs with status + tag grouping
│       │   │                    #   • Outline — searchable cell list with drag-reorder
│       │   │                    #   • Data Sources — S3, DynamoDB, Athena, Public APIs
│       │   │                    #   • Variables — live variable explorer with smart previews
│       │   │                    #   • Packages — pip install + package list
│       │   │                    #   • Samples — prebuilt notebook templates
│       │   │                    #   • MicroVMs — instance cards with cost breakdown
│       │   ├── Sidebar.css
│       │   ├── VariablePreviewRenderer.jsx  # Smart type-aware variable preview
│       │   ├── Icons.jsx        # SVG icon components (35+)
│       │   ├── Modal.jsx        # Reusable confirm/input modals
│       │   └── Modal.css
│       └── services/
│           ├── microvm.js       # MicroVM client service
│           └── sanitize.js      # HTML sanitization (DOMPurify) for XSS prevention
├── tests/
│   ├── test_interrupt_execution.py  # E2E: interrupt long-running cells (7 scenarios)
│   ├── test_microvm_lifecycle.py    # E2E: full state machine + checkpoint/restore (15 scenarios)
│   └── test_s3_restore.py          # E2E: checkpoint serialization & restore (8 scenarios)
├── scripts/
│   ├── config.sh               # All config (region, ports, sizes, DB names, polling)
│   ├── setup_iam.sh            # Create IAM roles + S3 bucket
│   ├── build_all_images.sh     # Parallel image build (all 5 tiers) with retry
│   ├── setup_sample_data.sh    # DynamoDB + S3 + Athena tables + workgroup
│   └── teardown.sh             # Terminate MicroVMs + delete images
├── iam/                    # IAM trust and permission policies
├── Dockerfile              # MicroVM image (al2023-minimal, Python 3.11)
├── requirements.txt        # MicroVM sandbox Python deps (exact pins for fast image builds)
├── requirements-proxy.txt  # Proxy server deps (Strands Agents, FastAPI, boto3)
├── dev_run.sh              # One-command local dev (auto-detects python/python3)
├── aws_microvm_run.sh      # One-command AWS mode (auto-detects python/python3)
└── README.md
```

---

## 9. Tests

Three end-to-end test scripts validate the major aspects of MicroVM execution. All tests launch real MicroVMs via the proxy, execute code, and verify results.

```bash
# Run any test (requires aws_microvm_run.sh to be running)
python3 tests/test_interrupt_execution.py
python3 tests/test_microvm_lifecycle.py
python3 tests/test_s3_restore.py
```

### 9.1 Interrupt Execution (`test_interrupt_execution.py`)

Tests the ability to stop long-running or stuck cells mid-execution.

| # | Scenario | Validates |
|---|----------|-----------|
| 1 | Normal execution | Sanity — code runs and returns output |
| 2 | Interrupt `time.sleep()` | Blocking I/O can be interrupted |
| 3 | Post-interrupt health | Sandbox still works after interrupt, variables preserved |
| 4 | Interrupt CPU loop | `while True` loop can be stopped |
| 5 | Loop variable survived | State created during the loop exists after interrupt |
| 6 | No-op interrupt | Calling interrupt when idle is gracefully handled |
| 7 | Final execution + HTML | Full execution with DataFrame rendering works after all interrupts |

### 9.2 MicroVM Lifecycle (`test_microvm_lifecycle.py`)

Comprehensive state machine test covering all MicroVM lifecycle transitions.

**Part 1 — Without checkpoint:**

| # | State Transition | Validates |
|---|-----------------|-----------|
| 1 | PENDING → RUNNING | Launch succeeds, VM is healthy |
| 2 | Execute + create variables | Code runs, state accumulates |
| 3 | Cross-call persistence | Variables survive across separate /execute calls |
| 4 | RUNNING → SUSPENDED | Programmatic suspend works |
| 5 | SUSPENDED → RUNNING (auto) | Sending /execute auto-resumes the VM |
| 6 | Variables after resume | All state survives the suspend/resume cycle |
| 7 | RUNNING → TERMINATED | Terminate without checkpoint |
| 8 | Not recoverable | Terminated VM cannot be restored |

**Part 2 — With S3 checkpoint:**

| # | State Transition | Validates |
|---|-----------------|-----------|
| 9 | Launch with checkpoint | checkpointEnabled flag accepted |
| 10 | Create rich state | DataFrames, numpy arrays, computed values |
| 11 | Terminate → S3 | Checkpoint files written to S3 |
| 12 | Launch new VM + restore | New VM restores from S3 checkpoint |
| 13 | Variables restored | All variables match pre-terminate state |
| 14 | Packages restored | pip-installed packages survive |
| 15 | Clean up | Restored VM terminated |

### 9.3 S3 Checkpoint & Restore (`test_s3_restore.py`)

Focused deep test of the checkpoint/restore mechanism — serialization, S3 upload, and namespace restoration.

| # | Scenario | Validates |
|---|----------|-----------|
| 1 | Launch with checkpoint | Session ID assigned |
| 2 | Create complex state | Variables, DataFrames, local files, installed packages |
| 3 | Terminate (triggers checkpoint) | /terminate hook fires, state serialized to S3 |
| 4 | Verify S3 checkpoint | checkpoint.pkl, files.tar.gz, requirements.txt, metadata.json exist |
| 5 | Launch new VM + restore | restoreFromSession flag triggers download + deserialization |
| 6 | Validate restored namespace | All variables match, types correct |
| 7 | Validate restored files | Local /tmp/ files exist |
| 8 | Timing report | End-to-end latency breakdown |

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
