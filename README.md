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
- **Rich output** — DataFrames render as styled tables, matplotlib plots display inline
- **File upload** — Upload CSV/Excel/Parquet/JSON files and reference them in code
- **Lifecycle hooks** — The sandbox responds to MicroVM lifecycle events

## Features

### Notebook UI
- Code cells with `Shift+Enter` execution
- **AI-powered code generation** — Toggle cells to AI mode, describe what you want in plain English, and generate Python code using Amazon Bedrock (Claude Sonnet)
- **Run All** — Execute all cells sequentially with one click
- Sequential execution queue (prevents race conditions)
- Inline DataFrame table rendering
- Inline matplotlib/chart image display
- Package installation from toolbar
- Save/Open notebooks (preserves code, output, tables, and charts)
- Tab support for multiple notebooks (cells persist across tab switches)

### AI Code Generation
- Each cell has a **Code | ✨ AI** mode toggle
- In AI mode, describe what you want in natural language and hit Enter (or click Generate)
- The AI receives **full notebook context** — all prior cells, their outputs, and cell position — for accurate, contextual code generation
- Generated code shows in a **preview panel** with Accept/Discard buttons
- Accepting inserts the code and switches back to Code mode for execution
- Uses **Amazon Bedrock Converse API** with Claude Sonnet (configurable model)
- Auto-detects AWS credential availability — AI toggle hidden when no credentials are configured
- Works in both local dev and MicroVM modes

### Sidebar (JupyterLab-style)
- **📓 Notebooks** — Create, rename (double-click), switch, close
- **📁 Data Sources** — Unified panel for uploaded files, sample data, S3 bucket files, DynamoDB tables. Click any item to insert read code into the active cell.
- **💡 Sample Notebooks** — Pre-built analysis notebooks (Sales, Time Series, Statistical, APIs, AWS)
- **☁️ MicroVMs** — Footer showing live instance count; click to manage (Attach, Resume, Terminate)

### MicroVM Management
- Auto-detect proxy availability
- Launch new MicroVMs from the UI (2 GB / 4 GB / 8 GB tiers)
- Attach existing running instances to notebooks
- Resume suspended instances
- Terminate instances
- Live state refresh every 15 seconds
- Auto-reconnect on page refresh (remembers which VM each notebook was connected to)

### UI & Theming
- **Light/Dark theme toggle** — persists across sessions
- **Python syntax highlighting** — Prism.js-powered with One Dark-inspired colors
- **SVG icons** throughout (Lucide-style, consistent stroke weight)
- **Centralized CSS design tokens** — all colors, spacing, shadows via CSS custom properties

## Architecture

### Local Dev Mode (`./dev_run.sh`)

```
┌──────────────────────┐           ┌───────────────────────────────────┐
│   React Notebook UI  │  HTTP     │     Local Sandbox Backend         │
│   (localhost:5173)   ├──────────►│     (localhost:8080)              │
│                      │  Direct   │                                   │
│  Sidebar + Cells     │  (no auth)│  FastAPI + SandboxExecutor        │
└──────────────────────┘           └───────────────────────────────────┘
```

### AWS MicroVM Mode (`./aws_microvm_run.sh`)

```
┌──────────────────────┐           ┌───────────────────────────────────┐
│   React Notebook UI  │  HTTP     │       Token Proxy (:8081)         │
│   (localhost:5173)   ├──────────►│                                   │
│                      │           │  POST /launch    — provision VM   │
│  Sidebar + Cells     │           │  POST /terminate — destroy VM     │
│                      │           │  POST /resume    — wake suspended │
│  AI Mode (per cell)  │           │  GET  /instances — list all VMs   │
│                      │           │  */proxy/*       — auth + forward │
│                      │           │  POST /ai/generate — AI code gen  │
│                      │           │  GET  /ai/config   — AI status    │
└──────────────────────┘           └────────────┬──────────┬───────────┘
                                                │          │
                                   HTTPS + JWE  │          │ Bedrock
                                                ▼          ▼
           ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
           │  MicroVM (Tab 1) │  │  MicroVM (Tab 2) │  │  Amazon Bedrock  │
           │  Firecracker VM  │  │  Firecracker VM  │  │  Claude Sonnet   │
           │  FastAPI+Executor│  │  FastAPI+Executor│  │  (Converse API)  │
           └──────────────────┘  └──────────────────┘  └──────────────────┘
```

### Data Source Connectivity

```
┌───────────────────────────────────────────────────────────────────────────--──┐
│ AWS Account                                                                   │
│                                                                               │
│  ┌─────────────────-───┐                                                      │
│  │  Lambda MicroVM     │                                                      │
│  │  (Firecracker VM)   │                                                      │
│  │                     │                                                      │
│  │  Your notebook code │                                                      │
│  │  runs here          │                                                      │
│  └─────────┬───────────┘                                                      │
│            │                                                                  │
│            ├──── Internet Egress (default) ────────►  Public APIs             │
│            │     No VPC needed                        • REST Countries        │
│            │                                          • Open-Meteo Weather    │
│            │                                          • CoinGecko Crypto      │
│            │                                                                  │
│            ├──── IAM Execution Role ──────────────►  AWS Services             │
│            │     Credentials auto-injected            • S3 (read buckets)     │
│            │                                          • DynamoDB (scan/query) │
│            │                                          • Athena, Redshift...   │
│            │                                                                  │
│            └──── VPC Egress Connector ───────────►  Private VPC Resources     │
│                  ENI in your subnets                   • RDS Postgres/MySQL   │
│                                                       • ElastiCache Redis     │
│                  ┌──────────────────────────┐         • OpenSearch            │
│                  │ Your VPC                 │         • On-prem (via DX/VPN)  │
│                  │                          │                                 │
│                  │  ┌─────┐    ┌──────────┐ │                                 │
│                  │  │ ENI │───►│ RDS      │ │                                 │
│                  │  └─────┘    │ Postgres │ │                                 │
│                  │             └──────────┘ │                                 │
│                  │  ┌─────┐    ┌──────────┐ │                                 │
│                  │  │ NAT │───►│ Internet │ │  (if VPC needs outbound)        │
│                  │  │ GW  │    │          │ │                                 │
│                  │  └─────┘    └──────────┘ │                                 │
│                  └──────────────────────────┘                                 │
└────────────────────────────────────────────────────────────────────────────--─┘
```

**Network patterns:**

| Pattern | How | Use Case |
|---------|-----|----------|
| Internet Egress | Default `INTERNET_EGRESS` connector | Public APIs, external SaaS |
| AWS Services (IAM) | Execution role permissions | S3, DynamoDB, Athena, STS |
| Private VPC | VPC egress connector (ENI) | RDS, ElastiCache, internal APIs |
| On-premises | VPC + Direct Connect/VPN | Enterprise databases |

## Quick Start (Local Dev)

```bash
./dev_run.sh
```

Starts the sandbox backend (`:8080`) and notebook UI (`:5173`).
Click **"🖥 Local Dev"** to connect. No AWS account needed.

## Quick Start (AWS MicroVM)

```bash
./aws_microvm_run.sh
```

Fully self-contained. On first run it:
1. Creates S3 bucket, IAM roles (if missing)
2. Builds the MicroVM image with all hooks enabled (~3-4 min)
3. Starts the token proxy (`:8081`)
4. Starts the notebook UI (`:5173`)

Subsequent runs skip the build and launch in seconds.

### Prerequisites for AWS mode

- AWS CLI **2.35.10+** (script checks and exits with instructions if too old)
- AWS credentials configured
- **boto3 >= 1.43.40** (installed automatically)
- Region: `us-west-2` (default), also supports `us-east-1`, `us-east-2`, `eu-west-1`, `ap-northeast-1`

## Usage

### Cells
- **Execute** — `Shift+Enter` or click ▶
- **Run All** — `▶▶ Run All` in toolbar executes all cells sequentially
- **Add cell** — `+ Cell` button or `+` on any cell
- **Delete cell** — 🗑 button (appears on hover)

### AI Code Generation
- Click the **✨ AI** toggle on any cell to switch to AI mode
- Type a natural language description (e.g. "Load the CSV and plot revenue by month")
- Press `Enter` to generate, `Esc` to cancel
- Review the generated code in the preview panel
- Click **✓ Accept** to insert it into the cell, or **✗ Discard** to try again
- The AI model is configurable via environment variable:
  ```bash
  export BEDROCK_MODEL_ID="us.anthropic.claude-sonnet-4-6"  # default
  export BEDROCK_REGION="us-west-2"                          # default
  ```

### Rich Output
- **DataFrames** — Type `df` or `df.head()` as the last line → renders as a styled table
- **Plots** — `plt.plot(...)` or `plt.show()` → renders inline as PNG
- **Text** — `print(...)` → monospace text output

### Files & Data Sources
- Click `↑` in the Data Sources sidebar section to upload files
- Supported: `.csv`, `.xlsx`, `.xls`, `.parquet`, `.json`
- Files auto-load as pandas DataFrames (variable name derived from filename)
- **Click any data source** (uploaded file, S3 object, DynamoDB table) to insert ready-to-run code into the active cell
- S3 and DynamoDB sources are auto-discovered from your AWS account

### Packages
- Click **Packages** in the toolbar to open the Package Manager
- View all installed packages with version numbers
- Install new packages (supports version pinning: `scikit-learn==1.5.1`)
- Package list reflects what's installed on the connected MicroVM
- Pre-baked in image: `pandas`, `numpy`, `polars`, `matplotlib`, `requests`, `psutil`, `openpyxl`, `xlrd`, `pyarrow`
- Runtime installs persist across suspend/resume

### Notebooks
- **Save** — `💾 Save` downloads a `.notebook.json` (includes code, output, tables, charts)
- **Open** — `📂 Open` loads a saved notebook file
- **Rename** — Double-click the notebook name in the sidebar

### MicroVM Instances
- **Launch** — Click "🚀 Launch New MicroVM" in the connection panel (select 2/4/8 GB tier)
- **Attach** — Click ⊕ on a running instance in the sidebar to open it in a new notebook
- **Resume** — Click ▶ on a suspended instance to wake it
- **Terminate** — Click ■ to destroy an instance
- **Close notebook** — Automatically terminates the attached MicroVM

## Project Structure

```
.
├── app/
│   ├── server.py        # FastAPI server: lifecycle hooks, execute, upload, install, AI generate
│   └── executor.py      # Stateful Python executor with rich output (tables, plots)
├── web/
│   └── src/
│       ├── main.jsx             # React entry point
│       ├── App.jsx              # Layout, state, tab management, theme toggle
│       ├── App.css              # App shell styles (header, layout, empty state)
│       ├── index.css            # Global resets, imports theme + syntax CSS
│       ├── theme.css            # Centralized design tokens (light + dark themes)
│       ├── syntax-theme.css     # Python syntax highlighting colors (both themes)
│       ├── components/
│       │   ├── Icons.jsx        # SVG icon components (Lucide-style, 25+ icons)
│       │   ├── Cell.jsx         # Code editor + syntax highlighting + AI mode toggle
│       │   ├── Cell.css
│       │   ├── ConnectionPanel.jsx  # MicroVM connection + attach existing
│       │   ├── ConnectionPanel.css
│       │   ├── InstancesPanel.jsx   # Modal: list/attach/resume/terminate MicroVMs
│       │   ├── InstancesPanel.css
│       │   ├── Modal.jsx        # Reusable confirm/input modals
│       │   ├── Modal.css
│       │   ├── Notebook.jsx     # Cell list, execution queue, Run All, save/load
│       │   ├── Notebook.css
│       │   ├── PackageManager.jsx   # Package Manager modal (list + install)
│       │   ├── PackageManager.css
│       │   ├── Sidebar.jsx      # Left panel: Notebooks, Data Sources, Samples
│       │   ├── Sidebar.css
│       │   ├── TabBar.jsx       # Tab bar component
│       │   └── TabBar.css
│       └── services/
│           └── microvm.js       # MicroVM client service
├── proxy/
│   └── server.py        # Token proxy: launch, terminate, resume, auth, AI, data sources
├── scripts/
│   ├── config.sh             # AWS config (region, image sizes, roles)
│   ├── setup_iam.sh          # Create IAM roles + S3 bucket
│   ├── build_image.sh        # Package and create a single MicroVM image
│   ├── build_all_images.sh   # Build all size-tier images (2/4/8 GB)
│   ├── setup_sample_data.sh  # Provision DynamoDB + S3 sample data
│   ├── run_microvm.sh        # Launch a single MicroVM (CLI)
│   ├── trigger.sh            # CLI-based code execution
│   └── teardown.sh           # Terminate MicroVM
├── iam/                 # IAM trust and permission policies
├── Dockerfile           # MicroVM image (al2023-minimal, Python 3.11, pre-baked packages)
├── requirements.txt     # Python deps: server + data science + file format support
├── dev_run.sh           # One-command local dev
├── aws_microvm_run.sh   # One-command AWS mode (fully self-contained)
└── README.md
```

## Configuration

Edit `scripts/config.sh`:

```bash
AWS_REGION="us-west-2"          # MicroVM region
AWS_CLI_PROFILE="default"       # AWS CLI profile
IMAGE_NAME="agent-sandbox"      # MicroVM image name
```

### AI Code Generation

The AI model is configurable via environment variables (set before running):

```bash
export BEDROCK_MODEL_ID="us.anthropic.claude-sonnet-4-6"  # default model
export BEDROCK_REGION="us-west-2"                          # Bedrock region
```

AI mode auto-detects AWS credentials. If credentials are not configured, the AI toggle is hidden and cells operate in code-only mode.

## Key Technical Details

### Execution Queue
Cells execute sequentially — if Cell 2 depends on Cell 1, it waits for Cell 1 to complete.
No race conditions.

### Rich Output Detection
The executor automatically detects:
- **Last expression is a DataFrame** → converts to HTML table (max 50 rows)
- **matplotlib has active figure** → captures as PNG, returns base64
- Works with both pandas and polars DataFrames

### Token Authentication (MicroVM mode)
- Browser never handles AWS credentials
- Proxy generates JWE tokens via `create-microvm-auth-token`
- Tokens cached for 25 min (expire at 30)
- Each request forwarded with `X-aws-proxy-auth` header

### Lifecycle Hooks
| Hook | When | Action |
|------|------|--------|
| `/ready` | Image build | Signals app initialized for snapshot |
| `/run` | MicroVM starts | Load session config |
| `/suspend` | Before idle suspend | Log state, flush output |
| `/resume` | After resume | Validate state |
| `/terminate` | Before termination | Could checkpoint to S3 |

### Idle Policy
- Auto-suspend after **30 minutes** idle
- Stay suspended up to **8 hours**
- Auto-resume on traffic (~1s per 500MB)
- Max lifetime: **8 hours**

### MicroVM Image Build
- Base: `public.ecr.aws/lambda/microvms:al2023-minimal`
- Runtime: **Python 3.11** (installed via dnf, venv-isolated)
- Base image version queried automatically (currently `"0"`)
- All hooks enabled (run, suspend, resume, terminate, ready)
- Supported memory tiers: 2 GB (1 vCPU), 4 GB (2 vCPU), 8 GB (4 vCPU)

### AI Code Generation (Bedrock Integration)
- Uses **Amazon Bedrock Converse API** for code generation
- Default model: `us.anthropic.claude-sonnet-4-6` (configurable)
- AI runs on the **proxy server** (not inside the MicroVM) — no Bedrock access needed in the execution role
- Full notebook context sent with each request: prior cell code, outputs, cell position
- System prompt instructs the model to output only executable Python (no markdown, no explanations)
- Auto-detects credential availability — gracefully hidden when no AWS credentials are present

### Pre-baked Packages
```
pandas, numpy, polars, matplotlib, requests, psutil,
openpyxl (Excel .xlsx), xlrd (Excel .xls), pyarrow (Parquet),
scipy (statistics), boto3 (AWS SDK)
```

### Sample Data (auto-provisioned)
- **DynamoDB** table `microvm-demo-data` with 10 sample products
- **S3** file `samples/sales_data.csv` in the artifacts bucket
- **Local CSV files** in `web/public/samples/data/` (sales, customers, traffic, A/B test)

## Cost (on AWS)

4 GB / 2 vCPU sandbox, 1 hour active per day:

| Component | Monthly |
|-----------|---------|
| Compute (active) | ~$5.30 |
| Snapshot storage (~2 GB) | ~$0.19 |
| Suspend/resume IO | ~$0.10 |
| **Total** | **~$5.60** |

## Dependencies

| Component | Requirement |
|-----------|-------------|
| Python | 3.11+ |
| Node.js | 18+ |
| AWS CLI | 2.35.10+ |
| boto3 | >= 1.43.40 |

All dependencies installed automatically by launch scripts.

## References

- [AWS Lambda MicroVMs Docs](https://docs.aws.amazon.com/lambda/latest/dg/lambda-microvms-guide.html)
- [Launch Blog Post](https://aws.amazon.com/blogs/aws/run-isolated-sandboxes-with-full-lifecycle-control-aws-lambda-introduces-microvms/)
- [MicroVM Networking](https://docs.aws.amazon.com/lambda/latest/dg/microvms-networking.html)
- [Running & Lifecycle](https://docs.aws.amazon.com/lambda/latest/dg/microvms-launching.html)
- [Pricing](https://aws.amazon.com/lambda/pricing/)
