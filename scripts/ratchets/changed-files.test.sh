#!/usr/bin/env bash
# changed-files.test.sh - card changed-files-renames. Runs scripts/ratchets/changed-files.sh in a scratch git repo.
# A file that moves out of a folder must list BOTH paths (the old one and the new one), in the base form and in the first-push form
# (empty base: the HEAD commit's own changes). A file that is only edited must list once.
# Run it with Git Bash, not the bash on PATH (WSL): "C:/Program Files/Git/bin/bash.exe" scripts/ratchets/changed-files.test.sh
# Prints one PASS or FAIL line per case and exits 1 when any case fails.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="$here/changed-files.sh"
work="$(mktemp -d)"
fail=0

g() { git -c user.name=t -c user.email=t@t -c commit.gpgsign=false "$@"; }

cd "$work" || exit 2
g init -q -b main
g config core.autocrlf false
mkdir -p apps/agentic-os/src docs
printf 'a long enough file body so that git sees the rename\nline two\nline three\nline four\n' > apps/agentic-os/src/x.ts
printf 'one\n' > docs/a.md
g add .
g commit -q -m base
base="$(g rev-parse HEAD)"

mkdir -p scripts
g mv apps/agentic-os/src/x.ts scripts/x.ts
printf 'one\ntwo\n' > docs/a.md
g add .
g commit -q -m move

# One path per line, sorted, from the NUL-separated output.
listed() { bash "$script" "$@" | tr '\0' '\n' | sort; }

check() {
  local name="$1" want="$2" got="$3"
  if [[ "$want" == "$got" ]]; then
    echo "PASS $name"
  else
    echo "FAIL $name"
    echo "  want: $(printf '%s' "$want" | tr '\n' ' ')"
    echo "  got:  $(printf '%s' "$got" | tr '\n' ' ')"
    fail=1
  fi
}

want_both=$'apps/agentic-os/src/x.ts\ndocs/a.md\nscripts/x.ts'
check "CF-sh1 base form lists the old and the new path of a moved file, and the edited file once" "$want_both" "$(listed "$base")"
check "CF-sh2 first-push form (empty base) lists both paths of the move" "$want_both" "$(listed "")"
check "CF-sh3 all-zero base falls back to the HEAD commit and lists both paths" "$want_both" "$(listed 0000000000000000000000000000000000000000)"

# An edit with no move lists the file once.
printf 'one\ntwo\nthree\n' > docs/a.md
g add .
g commit -q -m edit
check "CF-sh4 a file that is only edited lists once" "docs/a.md" "$(listed "$(g rev-parse HEAD~1)")"

# Output is NUL-separated: no newline between paths.
nul_count="$(bash "$script" "$base" | tr -cd '\0' | wc -c | tr -d ' ')"
check "CF-sh5 the output is NUL-separated (3 paths, 3 NUL bytes)" "3" "$nul_count"

cd / || true
exit "$fail"
