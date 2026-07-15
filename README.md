# Lambda MicroVM Notebook

A full-featured notebook web application demonstrating **AWS Lambda MicroVMs** as isolated
code execution sandboxes — the primary use case for this new serverless compute primitive.

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
- Sequential execution queue (prevents race conditions)
- Inline DataFrame table rendering
- Inline matplotlib/chart image display
- Package installation from toolbar
- Save/Open notebooks (preserves code, output, tables, and charts)
- Tab support for multiple notebooks

### Sidebar (JupyterLab-style)
- **📓 Notebooks** — Create, rename (double-click), switch, close
- **📁 Files** — Upload data files (CSV, Excel, Parquet, JSON), auto-loaded as DataFrames
- **☁️ MicroVMs** — Live instance state (Running/Suspended), Attach, Resume, Terminate

### MicroVM Management
- Auto-detect proxy availability
- Launch new MicroVMs from the UI
- Attach existing running instances to notebooks
- Resume suspended instances
- Terminate instances
- Live state refresh every 15 seconds

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
│                      │           │  GET  /instances — list all VMs   │
│                      │           │  */proxy/*       — auth + forward │
└──────────────────────┘           └────────────┬──────────────────────┘
                                                │ HTTPS + JWE token
                                                ▼
           ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
           │  MicroVM (Tab 1) │  │  MicroVM (Tab 2) │  │  MicroVM (Tab 3) │
           │  Firecracker VM  │  │  Firecracker VM  │  │  Firecracker VM  │
           │  FastAPI+Executor│  │  FastAPI+Executor│  │  FastAPI+Executor│
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
- **Add cell** — `+ Cell` button or `+` on any cell
- **Delete cell** — 🗑 button (appears on hover)

### Rich Output
- **DataFrames** — Type `df` or `df.head()` as the last line → renders as a styled table
- **Plots** — `plt.plot(...)` or `plt.show()` → renders inline as PNG
- **Text** — `print(...)` → monospace text output

### Files
- Click `↑` in the Files sidebar section to upload
- Supported: `.csv`, `.xlsx`, `.xls`, `.parquet`, `.json`
- Files auto-load as pandas DataFrames (variable name derived from filename)
- Also available at `/tmp/filename.ext` for manual loading

### Packages
- Click `📦 Install` in toolbar → type package name → Enter
- Pre-baked in image: `pandas`, `numpy`, `polars`, `matplotlib`, `requests`, `psutil`, `openpyxl`, `xlrd`, `pyarrow`
- Runtime installs persist across suspend/resume

### Notebooks
- **Save** — `💾 Save` downloads a `.notebook.json` (includes code, output, tables, charts)
- **Open** — `📂 Open` loads a saved notebook file
- **Rename** — Double-click the notebook name in the sidebar

### MicroVM Instances
- **Launch** — Click "🚀 Launch New MicroVM" in the connection panel
- **Attach** — Click ⊕ on a running instance in the sidebar to open it in a new notebook
- **Resume** — Click ▶ on a suspended instance to wake it
- **Terminate** — Click ■ to destroy an instance

## Project Structure

```
.
├── app/
│   ├── server.py        # FastAPI server: lifecycle hooks, execute, upload, install
│   └── executor.py      # Stateful Python executor with rich output (tables, plots)
├── web/
│   └── src/
│       ├── App.jsx              # Layout, state, instance management
│       ├── components/
│       │   ├── Sidebar.jsx      # Left panel: Notebooks, Files, MicroVMs
│       │   ├── Notebook.jsx     # Cell list, execution queue, save/load/upload
│       │   ├── Cell.jsx         # Code editor + rich output (text, HTML, images)
│       │   └── ConnectionPanel.jsx  # Local/MicroVM connection + attach existing
│       └── services/
│           └── microvm.js       # MicroVM client service
├── proxy/
│   └── server.py        # Token proxy: launch, terminate, resume, auth, list
├── scripts/
│   ├── config.sh        # AWS config (region: us-west-2, image name, roles)
│   ├── setup_iam.sh     # Create IAM roles + S3 bucket
│   ├── build_image.sh   # Package and create MicroVM image
│   ├── run_microvm.sh   # Launch a single MicroVM (CLI)
│   ├── trigger.sh       # CLI-based code execution
│   └── teardown.sh      # Terminate MicroVM
├── iam/                 # IAM trust and permission policies
├── Dockerfile           # MicroVM image (al2023-minimal, venv, pre-baked packages)
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
- Base image version queried automatically (currently `"0"`)
- All hooks enabled (run, suspend, resume, terminate, ready)
- 4 GB minimum memory configured

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
