#!/usr/bin/env bash
# changed-files.sh <base-sha> - print the repo paths changed between <base-sha> and HEAD, NUL-separated
# (-z: Git does not quote non-ASCII names, so they match the scanners' paths byte for byte).
# --no-renames: a moved file lists its old path and its new path, so a file moved out of a folder still counts for that folder's job (card changed-files-renames).
# Used by .github/workflows/ccv3-checks.yml to feed scan-ratchet.mjs --changed.
# A missing or all-zero base (first push of a branch) falls back to the HEAD commit's own changes.
set -euo pipefail
base="${1:-}"
if [[ -z "$base" || "$base" =~ ^0+$ ]] || ! git cat-file -e "${base}^{commit}" 2>/dev/null; then
  git diff --name-only --no-renames -z HEAD~1 HEAD
else
  git diff --name-only --no-renames -z "$base"...HEAD
fi
