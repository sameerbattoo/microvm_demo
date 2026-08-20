#!/usr/bin/env bash
# ============================================================
# CONFIGURATION — Edit these values for your AWS account
# ============================================================

export AWS_REGION="us-west-2"
export AWS_CLI_PROFILE="default"  # change if using a named profile

# Auto-detect account ID
export ACCOUNT_ID=$(aws sts get-caller-identity --profile "$AWS_CLI_PROFILE" --query Account --output text 2>/dev/null)

# S3 bucket for MicroVM image artifacts
export ARTIFACT_BUCKET="microvm-sandbox-artifacts-${ACCOUNT_ID}-${AWS_REGION}"

# Image configuration
export IMAGE_NAME="agent-sandbox"
export IMAGE_ARN="arn:aws:lambda:${AWS_REGION}:${ACCOUNT_ID}:microvm-image:${IMAGE_NAME}"
export BASE_IMAGE_ARN="arn:aws:lambda:${AWS_REGION}:aws:microvm-image:al2023-1"

# Size tiers (image name suffix → memory in MiB)
# Note: 512 excluded — not enough memory for pandas+numpy+matplotlib snapshot
export IMAGE_SIZES="1024 2048 4096 8192"

# IAM role names
export BUILD_ROLE_NAME="MicroVMSandboxBuildRole"
export EXEC_ROLE_NAME="MicroVMSandboxExecRole"
export BUILD_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${BUILD_ROLE_NAME}"
export EXEC_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${EXEC_ROLE_NAME}"

# Network connectors (AWS-managed defaults)
export INGRESS_CONNECTOR="arn:aws:lambda:${AWS_REGION}:aws:network-connector:aws-network-connector:ALL_INGRESS"
export EGRESS_CONNECTOR="arn:aws:lambda:${AWS_REGION}:aws:network-connector:aws-network-connector:INTERNET_EGRESS"

# Artifact key in S3
export ARTIFACT_KEY="images/${IMAGE_NAME}.zip"

# Polling interval for MicroVM state refresh (milliseconds)
export POLL_INTERVAL_MS="10000"

# Storage backend configuration
# Supported: "sqlite", "mysql", "postgres" (only sqlite implemented currently)
export STORAGE_BACKEND="sqlite"
# SQLite: path is relative to proxy/data/ by default (no connection string needed)
# MySQL:  export STORAGE_CONNECTION="mysql://user:pass@host:3306/microvm_db"
# Postgres: export STORAGE_CONNECTION="postgresql://user:pass@host:5432/microvm_db"
export STORAGE_CONNECTION=""

# Pricing (Lambda MicroVM rates, Graviton/ARM64, us-east-1)
# AWS bills on TWO axes: vCPU + Memory (separately)
# CPU allocated at 2 GB : 1 vCPU ratio
export PRICE_VCPU_PER_SEC="0.0000276944"       # per vCPU-second
export PRICE_MEMORY_PER_GB_SEC="0.0000036667"   # per GB-second
export PRICE_SNAPSHOT_PER_GB_MONTH="0.08"       # suspended snapshot storage

# Metrics retention (hours) — how long VM metrics are kept in the DB
export METRICS_RETENTION_HOURS="168"

# S3 session checkpoint retention (days)
export S3_CHECKPOINT_RETENTION_DAYS="30"

# MicroVM lifetime & persistence
# Max lifetime before action is taken (seconds). AWS max is 28800 (8h).
# Set to smaller values (e.g., 180) for testing rotation logic.
# Override: MAX_LIFETIME_SECONDS=180 ./aws_microvm_run.sh
export MAX_LIFETIME_SECONDS="${MAX_LIFETIME_SECONDS:-28800}"
# Buffer before max lifetime to start rotation/checkpoint (seconds).
# Must be larger than worst-case rotation time (~10-15s for large states).
# With 8h lifetime, 60s buffer is negligible but gives safe margin.
export ROTATION_LEAD_SECONDS="${ROTATION_LEAD_SECONDS:-60}"

# Pre-terminate wake: computed dynamically per VM as (idle_timeout - 10s).
# Not configurable — derived from each VM's idle timeout at launch time.
# Ensures the VM stays RUNNING when AWS kills it (can't re-suspend in time).

# Session persistence mode:
#   "eternal"     — VMs rotate transparently before max lifetime. Session never dies.
#                   User sees no interruption. Cost accumulates across rotated VMs.
#   "checkpoint"  — State is saved to S3 before max lifetime. VM terminates.
#                   User must manually restore next time they open the notebook.
export SESSION_PERSISTENCE_MODE="${SESSION_PERSISTENCE_MODE:-checkpoint}"

# Port configuration
export PROXY_PORT="8081"
export BACKEND_PORT="8080"

# ------------------------------------------------------------
# Data Source auto-discovery scope (read by proxy/platform/datasources providers)
# These declaratively bound what the Data Sources panel + entity discovery surface.
# The AWS role still limits what is *accessible*; these limit what is *shown*.
# Each provider reads its own scope below; leave blank/unset to use the defaults.
# ------------------------------------------------------------
# Athena: ATHENA_DB is the DEFAULT database for query EXECUTION (the db.table
# prefix, read_athena default, SQL engine catalog). ATHENA_WORKGROUP scopes runs.
export ATHENA_DB="microvm_demo_db"
export ATHENA_WORKGROUP="microvm-demo"
# Athena DISCOVERY scope (which databases' tables appear in the panel) is separate
# from the query default above. Set to a comma-separated allowlist to restrict which
# Glue databases are shown, or leave EMPTY to auto-discover EVERY database the role
# can access. Defaults to the demo DB so the panel stays clean; empty it (or add more)
# to surface additional databases the role has access to.
export DATASOURCE_ATHENA_DATABASES="${ATHENA_DB}"
# S3: comma-separated key prefixes to scan (one level deep).
export DATASOURCE_S3_PREFIXES="samples/,user-data/"
# DynamoDB: comma-separated substrings; only tables whose name contains one are shown.
export DATASOURCE_DDB_NAME_FILTERS="microvm,demo,ecommerce"

# Project root
export ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Helper: call lambda-microvms with profile and region
aws_mvm() {
  aws lambda-microvms "$@" --profile "$AWS_CLI_PROFILE" --region "$AWS_REGION"
}
