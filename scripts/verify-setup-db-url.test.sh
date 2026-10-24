#!/usr/bin/env bash
# Drives scripts/verify-setup.sh. No bats in this repo; this is the same
# temp-HOME shell harness as scripts/sync-to-active-cursor.test.sh.
#
# Three cases, one install mode each, read from opc/.env the way the wizard
# writes it ("# Database Mode: docker|sqlite"). The URL value is a placeholder
# and must not appear in the script's output.
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REAL="$SCRIPT_DIR/verify-setup.sh"
FIX="$(mktemp -d)"
trap 'rm -rf "$FIX"' EXIT

PLACEHOLDER='postgresql://user:PLACEHOLDER@localhost:5432/db'
mkdir -p "$FIX/home"
pass=0
fail=0

chk() {
    if [ "$2" = "1" ]; then
        echo "  PASS  $1"
        pass=$((pass + 1))
    else
        echo "  FAIL  $1"
        fail=$((fail + 1))
    fi
}

write_env() {
    local opc="$1"
    local mode="$2"
    mkdir -p "$opc"
    if [ "$mode" = "sqlite" ]; then
        printf '%s\n' '# Database Mode: sqlite' '# SQLite mode - no connection string needed' 'CONTINUOUS_CLAUDE_DB_URL=' > "$opc/.env"
    else
        printf '%s\n' '# Database Mode: docker' "CONTINUOUS_CLAUDE_DB_URL=${PLACEHOLDER}" > "$opc/.env"
    fi
}

run_case() {
    local name="$1"
    local mode="$2"
    local with_url="$3"
    local opc="$FIX/opc-$name"
    write_env "$opc" "$mode"
    if [ "$with_url" = "set" ]; then
        HOME="$FIX/home" CLAUDE_OPC_DIR="$opc" CONTINUOUS_CLAUDE_DB_URL="$PLACEHOLDER" \
            bash "$REAL" > "$FIX/$name.out" 2>&1 || true
    else
        env -u CONTINUOUS_CLAUDE_DB_URL HOME="$FIX/home" CLAUDE_OPC_DIR="$opc" \
            bash "$REAL" > "$FIX/$name.out" 2>&1 || true
    fi
}

failed_of() {
    sed -n 's/^  Failed: //p' "$1" | head -n 1
}

run_case postgres-missing docker missing
run_case postgres-set docker set
run_case sqlite sqlite missing

miss="$FIX/postgres-missing.out"
setout="$FIX/postgres-set.out"
skip="$FIX/sqlite.out"

fail_miss="$(failed_of "$miss")"
fail_set="$(failed_of "$setout")"
fail_skip="$(failed_of "$skip")"

grep -F '[FAIL] CONTINUOUS_CLAUDE_DB_URL is set' "$miss" >/dev/null && miss_fail=1 || miss_fail=0
grep -F '[PASS] CONTINUOUS_CLAUDE_DB_URL is set' "$miss" >/dev/null && miss_pass=1 || miss_pass=0
grep -F '[PASS] CONTINUOUS_CLAUDE_DB_URL is set' "$setout" >/dev/null && set_pass=1 || set_pass=0
grep -F '[FAIL] CONTINUOUS_CLAUDE_DB_URL is set' "$setout" >/dev/null && set_fail=1 || set_fail=0
grep -F '[SKIP] CONTINUOUS_CLAUDE_DB_URL (sqlite mode)' "$skip" >/dev/null && skip_line=1 || skip_line=0
grep -F '[FAIL] CONTINUOUS_CLAUDE_DB_URL is set' "$skip" >/dev/null && skip_fail=1 || skip_fail=0
grep -F '[PASS] CONTINUOUS_CLAUDE_DB_URL is set' "$skip" >/dev/null && skip_pass=1 || skip_pass=0

chk "postgres + missing is FAIL" "$miss_fail"
chk "postgres + missing is not PASS" "$([ "$miss_pass" = 0 ] && echo 1 || echo 0)"
chk "postgres + set is PASS" "$set_pass"
chk "postgres + set is not FAIL" "$([ "$set_fail" = 0 ] && echo 1 || echo 0)"
chk "sqlite is SKIP" "$skip_line"
chk "sqlite is not FAIL" "$([ "$skip_fail" = 0 ] && echo 1 || echo 0)"
chk "sqlite is not PASS" "$([ "$skip_pass" = 0 ] && echo 1 || echo 0)"

delta_ok=0
if [ -n "$fail_miss" ] && [ -n "$fail_set" ] && [ -n "$fail_skip" ]; then
    if [ "$fail_miss" -eq $((fail_set + 1)) ] && [ "$fail_skip" -eq "$fail_set" ]; then
        delta_ok=1
    fi
fi
chk "sqlite SKIP does not count toward Failed (missing=$fail_miss set=$fail_set sqlite=$fail_skip)" "$delta_ok"

leak=0
if grep -F 'PLACEHOLDER' "$miss" "$setout" "$skip" >/dev/null || grep -F 'postgresql://' "$miss" "$setout" "$skip" >/dev/null; then
    leak=1
fi
chk "output has no URL value" "$([ "$leak" = 0 ] && echo 1 || echo 0)"

echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
