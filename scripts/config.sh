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
export IMAGE_SIZES="2048 4096 8192"

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

# Project root
export ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Helper: call lambda-microvms with profile and region
aws_mvm() {
  aws lambda-microvms "$@" --profile "$AWS_CLI_PROFILE" --region "$AWS_REGION"
}
