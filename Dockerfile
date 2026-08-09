# =============================================================================
# Lambda MicroVM Sandbox — Application Image
# =============================================================================
#
# This Dockerfile defines the application image that runs inside each Lambda
# MicroVM. It is NOT a traditional container — Lambda builds a Firecracker
# memory snapshot from this image, and new VMs restore from that snapshot
# in milliseconds (no boot, no init, no cold start).
#
# Architecture:
#   1. Base image: Amazon Linux 2023 minimal (provided by Lambda MicroVMs)
#   2. System packages: Python 3.11, git, bash, tar, gzip
#   3. Python venv with pre-installed data science packages (pandas, numpy, etc.)
#   4. FastAPI app serving on port 8080 (code execution + lifecycle hooks)
#
# Build process (handled by AWS):
#   - Lambda pulls this Dockerfile + code from S3 (agent-sandbox.zip)
#   - Runs the Dockerfile to create the filesystem
#   - Boots the image, waits for the /ready hook to return 200
#   - Takes a Firecracker memory snapshot (all imports pre-loaded in RAM)
#   - New VMs restore from this snapshot — Python + packages already in memory
#
# Terminal access:
#   The SHELL_INGRESS network connector provides interactive shell access.
#   It requires /bin/bash to exist (hence the explicit `bash` install).
#   The venv PATH is injected into /root/.bashrc so that `python3`, `pip`,
#   `git`, and all installed packages are available in the terminal.
#
# Adding packages:
#   Add Python packages to requirements.txt. They'll be pre-installed in the
#   venv and available instantly on VM launch (no pip install at runtime).
#   System packages go in the `dnf install` line below.
#
# Port 8080:
#   Lambda MicroVM ingress routes all inbound traffic to port 8080 by default.
#   The FastAPI app listens here and handles code execution, lifecycle hooks,
#   file uploads, metrics, and variable introspection.
# =============================================================================

FROM public.ecr.aws/lambda/microvms:al2023-minimal

# System packages:
#   python3.11   — Runtime for the sandbox app and user code
#   python3.11-pip — Package installer (used to bootstrap venv)
#   git          — Clone repos from the terminal
#   tar, gzip    — Extract archives (wget'd datasets, etc.)
#   bash         — Required by SHELL_INGRESS for interactive terminal access
RUN dnf install -y python3.11 python3.11-pip git tar gzip bash && dnf clean all

# Symlink python3 globally so any shell (including platform shell) can find it
RUN ln -sf /usr/bin/python3.11 /usr/bin/python3 && \
    ln -sf /usr/bin/python3.11 /usr/bin/python

# Use a venv to keep packages isolated from system Python
RUN python3.11 -m venv /app/venv
ENV PATH="/app/venv/bin:$PATH"

# Make the venv PATH available in terminal sessions (SHELL_INGRESS spawns bash)
# Without this, `python3` in the terminal finds the bare system Python (no packages)
RUN echo 'export PATH="/app/venv/bin:$PATH"' >> /root/.bashrc

# Install sandbox server + pre-baked data science packages
# These are captured in the Firecracker snapshot — zero cold-start import latency
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

# Copy application code (FastAPI app with execution engine + lifecycle hooks)
WORKDIR /app
COPY app/ ./app/

# Lambda MicroVM ingress routes to this port by default
EXPOSE 8080

# Start the FastAPI server (uvicorn)
# This process is snapshotted after /ready returns — on restore it's already running
CMD ["uvicorn", "app.server:app", "--host", "0.0.0.0", "--port", "8080"]
