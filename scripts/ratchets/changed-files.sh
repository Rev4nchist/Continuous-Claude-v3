#!/usr/bin/env bash
# changed-files.sh <base-sha> - print the repo paths changed between <base-sha> and HEAD, one per line.
# Used by .github/workflows/ccv3-checks.yml to feed scan-ratchet.mjs --changed.
# A missing or all-zero base (first push of a branch) falls back to the HEAD commit's own changes.
set -euo pipefail
base="${1:-}"
if [[ -z "$base" || "$base" =~ ^0+$ ]] || ! git cat-file -e "${base}^{commit}" 2>/dev/null; then
  git diff --name-only HEAD~1 HEAD
else
  git diff --name-only "$base"...HEAD
fi
