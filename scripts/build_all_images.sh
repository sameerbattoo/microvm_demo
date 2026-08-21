#!/usr/bin/env bash
# ============================================================
# Build MicroVM images for all size tiers
# Creates one image per memory size (same code, different resources)
#
# Idempotent: skips images that already exist.
# Retries: on CREATE_FAILED, deletes and recreates (up to 2 retries).
# ============================================================
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/config.sh"

MAX_BUILD_RETRIES=2
BUILD_POLL_INTERVAL=12
BUILD_TIMEOUT_SECS=600  # 10 minutes max wait per image build

echo "============================================"
echo "  Building MicroVM images (all sizes)"
echo "============================================"

cd "$ROOT_DIR"

# Package app once
echo ">> Packaging app.zip"
rm -f app.zip
zip -r app.zip app/ Dockerfile requirements.txt >/dev/null
echo "   Created app.zip"

# Upload once
echo ">> Uploading to s3://$ARTIFACT_BUCKET/$ARTIFACT_KEY"
aws s3 cp app.zip "s3://$ARTIFACT_BUCKET/$ARTIFACT_KEY" \
  --profile "$AWS_CLI_PROFILE" --region "$AWS_REGION" >/dev/null

# Query base image version
BASE_IMAGE_VERSION=$(aws_mvm list-managed-microvm-image-versions \
  --image-identifier "$BASE_IMAGE_ARN" \
  --query 'items[0].imageVersion' --output text 2>/dev/null || echo "0")
echo "   Base image version: $BASE_IMAGE_VERSION"

# --- Helper: wait for an image to reach a terminal state ---
# Returns the final state via stdout
wait_for_image() {
  local tier_arn="$1"
  local elapsed=0
  local state="CREATING"

  while [ "$state" = "CREATING" ]; do
    sleep "$BUILD_POLL_INTERVAL"
    elapsed=$((elapsed + BUILD_POLL_INTERVAL))
    state=$(aws_mvm get-microvm-image --image-identifier "$tier_arn" \
      --query 'state' --output text 2>/dev/null || echo "NOT_FOUND")

    if [ $elapsed -ge $BUILD_TIMEOUT_SECS ]; then
      echo "TIMED_OUT"
      return
    fi
  done
  echo "$state"
}

# --- Helper: delete an image and wait for deletion ---
delete_and_wait() {
  local tier_arn="$1"
  aws_mvm delete-microvm-image --image-identifier "$tier_arn" >/dev/null 2>&1 || true

  local elapsed=0
  while [ $elapsed -lt 120 ]; do
    sleep 5
    elapsed=$((elapsed + 5))
    local state
    state=$(aws_mvm get-microvm-image --image-identifier "$tier_arn" \
      --query 'state' --output text 2>/dev/null || echo "DELETED")
    if [ "$state" = "DELETED" ] || [ "$state" = "NOT_FOUND" ]; then
      return 0
    fi
  done
  echo "   ⚠ Timed out waiting for deletion of $tier_arn"
  return 1
}

# --- Helper: create a single image ---
create_image() {
  local tier_name="$1"
  local mem="$2"

  aws_mvm create-microvm-image \
    --name "$tier_name" \
    --base-image-arn "$BASE_IMAGE_ARN" \
    --base-image-version "$BASE_IMAGE_VERSION" \
    --build-role-arn "$BUILD_ROLE_ARN" \
    --code-artifact "uri=s3://$ARTIFACT_BUCKET/$ARTIFACT_KEY" \
    --hooks '{"port":8080,"microvmHooks":{"run":"ENABLED","runTimeoutInSeconds":60,"resume":"ENABLED","resumeTimeoutInSeconds":10,"suspend":"ENABLED","suspendTimeoutInSeconds":10,"terminate":"ENABLED","terminateTimeoutInSeconds":60},"microvmImageHooks":{"ready":"ENABLED","readyTimeoutInSeconds":60}}' \
    --resources "[{\"minimumMemoryInMiB\":${mem}}]" >/dev/null
}

# Build each size tier — kick off all creates in parallel
NEEDS_WAIT=()
for MEM in $IMAGE_SIZES; do
  VCPU=$(echo "$MEM" | awk '{printf "%.2g", $1 / 2048}')
  TIER_NAME="${IMAGE_NAME}-${MEM}"
  TIER_ARN="arn:aws:lambda:${AWS_REGION}:${ACCOUNT_ID}:microvm-image:${TIER_NAME}"

  # Check current state
  TIER_STATE=$(aws_mvm get-microvm-image --image-identifier "$TIER_ARN" \
    --query 'state' --output text 2>/dev/null || echo "NOT_FOUND")

  if [ "$TIER_STATE" = "CREATED" ]; then
    echo "   ✓ ${TIER_NAME} (${MEM}MB / ${VCPU}vCPU) — already exists"
    continue
  fi

  # Clean up failed images before retrying
  if [ "$TIER_STATE" = "CREATE_FAILED" ]; then
    echo "   🔄 ${TIER_NAME} — cleaning up failed image..."
    delete_and_wait "$TIER_ARN"
    TIER_STATE="NOT_FOUND"
  fi

  # If already creating, just add to wait list
  if [ "$TIER_STATE" = "CREATING" ]; then
    echo "   ⏳ ${TIER_NAME} — already building"
    NEEDS_WAIT+=("$MEM")
    continue
  fi

  # Start build (returns immediately)
  echo ">> Creating image: ${TIER_NAME} (${MEM}MB / ${VCPU}vCPU)"
  create_attempts=0
  create_success=false
  while [ $create_attempts -lt 3 ]; do
    if create_image "$TIER_NAME" "$MEM" 2>/dev/null; then
      create_success=true
      NEEDS_WAIT+=("$MEM")
      break
    fi
    create_attempts=$((create_attempts + 1))
    echo "   ⚠ create call failed (attempt $create_attempts/3), retrying in 15s..."
    sleep 15
  done
  if [ "$create_success" = "false" ]; then
    echo "   ❌ Failed to create ${TIER_NAME} after 3 attempts"
    exit 1
  fi
done

# --- Wait for all images to reach CREATED state (parallel poll) ---
if [ ${#NEEDS_WAIT[@]} -gt 0 ]; then
  echo ""
  echo ">> Waiting for ${#NEEDS_WAIT[@]} image(s) to build..."
  elapsed=0
  while [ $elapsed -lt $BUILD_TIMEOUT_SECS ]; do
    sleep "$BUILD_POLL_INTERVAL"
    elapsed=$((elapsed + BUILD_POLL_INTERVAL))

    all_done=true
    status_line=""
    for MEM in "${NEEDS_WAIT[@]}"; do
      TIER_NAME="${IMAGE_NAME}-${MEM}"
      TIER_ARN="arn:aws:lambda:${AWS_REGION}:${ACCOUNT_ID}:microvm-image:${TIER_NAME}"
      STATE=$(aws_mvm get-microvm-image --image-identifier "$TIER_ARN" \
        --query 'state' --output text 2>/dev/null || echo "NOT_FOUND")

      if [ "$STATE" = "CREATE_FAILED" ]; then
        echo "   ⚠ ${TIER_NAME} failed — retrying..."
        delete_and_wait "$TIER_ARN"
        create_image "$TIER_NAME" "$MEM" 2>/dev/null || true
        all_done=false
      elif [ "$STATE" != "CREATED" ]; then
        all_done=false
      fi
      status_line="${status_line} ${TIER_NAME}=${STATE}"
    done

    if [ "$all_done" = "true" ]; then
      echo "   All images ready ✓"
      break
    fi
    echo "   $(date +%H:%M:%S)${status_line}"
  done

  # Final check — re-verify each tier reached CREATED. A single get-microvm-image
  # right after creation can transiently return NOT_FOUND or fail (eventual
  # consistency / API blip), so retry a few times before declaring failure. Also
  # recover from a genuine CREATE_FAILED discovered here rather than aborting.
  for MEM in "${NEEDS_WAIT[@]}"; do
    TIER_NAME="${IMAGE_NAME}-${MEM}"
    TIER_ARN="arn:aws:lambda:${AWS_REGION}:${ACCOUNT_ID}:microvm-image:${TIER_NAME}"
    STATE=""
    verify_attempt=0
    while [ $verify_attempt -lt 6 ]; do
      STATE=$(aws_mvm get-microvm-image --image-identifier "$TIER_ARN" \
        --query 'state' --output text 2>/dev/null || echo "QUERY_ERROR")
      if [ "$STATE" = "CREATED" ]; then
        break
      fi
      if [ "$STATE" = "CREATE_FAILED" ]; then
        echo "   🔄 ${TIER_NAME} CREATE_FAILED at final check — rebuilding..."
        delete_and_wait "$TIER_ARN"
        create_image "$TIER_NAME" "$MEM" 2>/dev/null || true
        STATE=$(wait_for_image "$TIER_ARN")
        [ "$STATE" = "CREATED" ] && break
      fi
      verify_attempt=$((verify_attempt + 1))
      echo "   ⏳ ${TIER_NAME} final-check state=${STATE} (attempt ${verify_attempt}/6) — retrying in 5s..."
      sleep 5
    done
    if [ "$STATE" != "CREATED" ]; then
      echo "   ❌ ${TIER_NAME} not ready after retries (state: $STATE)"
      exit 1
    fi
    echo "   ✓ ${TIER_NAME} verified CREATED"
  done
fi

rm -f app.zip

echo ""
echo "✅ All images ready:"
for MEM in $IMAGE_SIZES; do
  VCPU=$(echo "$MEM" | awk '{printf "%.2g", $1 / 2048}')
  GB=$(echo "$MEM" | awk '{printf "%.1f", $1 / 1024}')
  echo "   ${IMAGE_NAME}-${MEM}: ${GB} GB / ${VCPU} vCPU"
done
