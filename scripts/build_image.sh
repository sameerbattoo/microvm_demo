#!/usr/bin/env bash
# ============================================================
# Build MicroVM images
# Delegates to build_all_images.sh which builds all size tiers
# ============================================================
set -euo pipefail

exec "$(dirname "${BASH_SOURCE[0]}")/build_all_images.sh" "$@"
