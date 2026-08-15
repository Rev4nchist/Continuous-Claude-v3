"""One-off remediation: rewrite an existing Braintrust spool into bounded records.

WHY THIS EXISTS
  spool_events used to write a failed batch as ONE json line of unbounded size,
  so a batch that failed FOR BEING TOO LARGE was persisted at exactly the size
  that failed. On 2026-08-14 the live spool was a single 516.3 MiB record of 210
  spans, first written 2026-08-09, re-read and re-written on every session start
  and end since -- it could never drain, because the only size-reduction path was
  gated on an HTTP 413 that a payload this large prevents the server from ever
  sending (it dies as WriteTimeout instead).

  The hook fix bounds what gets WRITTEN from now on. It does not retroactively
  shrink a record already on disk, and letting the hook's recursive halving chew
  through half a gigabyte inside a 20s flush budget would stall session start.
  So the existing record is re-bounded here, once, out of band.

SAFETY
  - Takes the SAME spool lock the flush uses, so it cannot race a live flush.
  - Backs the spool up before touching it; the backup is kept, not cleaned up.
  - Writes to a temp file and os.replace()s it -- never edits in place.
  - Reuses braintrust_hooks.chunk_events_by_bytes so remediation and prevention
    can never drift apart.
  - Read-only by default. Pass --apply to write.

USAGE
  python scripts/braintrust/rebound-spool.py            # report only
  python scripts/braintrust/rebound-spool.py --apply
"""
import importlib.util
import json
import os
import shutil
import sys
import time
from pathlib import Path

APPLY = "--apply" in sys.argv
MiB = 1024 * 1024

# Prefer the REPO copy over the live ~/.claude mirror. This script has to run
# BEFORE the fix is synced live -- if the new hook were already active, an
# ordinary flush would try to halve the half-gigabyte record itself, inside a 20s
# budget, and stall session start. So it must not depend on the live copy having
# been updated, and the repo is the source of truth regardless.
REPO_HOOK = Path(__file__).resolve().parents[2] / ".claude" / "hooks" / "braintrust_hooks.py"
LIVE_HOOK = Path.home() / ".claude" / "hooks" / "braintrust_hooks.py"
HOOK = REPO_HOOK if REPO_HOOK.exists() else LIVE_HOOK
if not HOOK.exists():
    print(f"FAIL: hook not found at {REPO_HOOK} or {LIVE_HOOK}")
    sys.exit(1)
print(f"hook module      : {HOOK}")

os.environ.setdefault("BRAINTRUST_API_KEY", "unused-no-network-here")
spec = importlib.util.spec_from_file_location("bh", HOOK)
bh = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bh)

spool = bh.SPOOL_FILE
if not spool.exists():
    print("nothing to do: spool is absent")
    sys.exit(0)

size = spool.stat().st_size
print(f"spool            : {spool}")
print(f"size             : {size/MiB:,.1f} MiB")
print(f"record cap       : {bh.SPOOL_MAX_RECORD_BYTES/MiB:,.1f} MiB")
print(f"mode             : {'APPLY' if APPLY else 'REPORT ONLY'}\n")

if not bh._acquire_spool_lock():
    print("FAIL: could not acquire the spool lock -- a flush is running. Try again shortly.")
    sys.exit(1)

try:
    out_lines: list[str] = []
    in_records = 0
    in_spans = 0
    out_spans = 0
    dead_spans = 0
    already_ok = 0
    biggest_in = 0

    with open(spool, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            if not line.strip():
                continue
            in_records += 1
            biggest_in = max(biggest_in, len(line.encode("utf-8", "replace")))
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                # Leave unparseable lines exactly as they were: flush_spool
                # already dead-letters those, with its own reason string.
                out_lines.append(line.rstrip("\n"))
                continue

            project_id = record.get("project_id", "")
            events = record.get("events", [])
            spooled_at = record.get("spooled_at", time.time())
            in_spans += len(events)

            if len(line.encode("utf-8", "replace")) <= bh.SPOOL_MAX_RECORD_BYTES:
                already_ok += 1
                out_spans += len(events)
                out_lines.append(line.rstrip("\n"))
                continue

            chunks, oversized = bh.chunk_events_by_bytes(events, bh.SPOOL_MAX_RECORD_BYTES)
            for ev in oversized:
                dead_spans += 1
                if APPLY:
                    bh._deadletter_events(
                        project_id, [ev],
                        f"single span exceeds {bh.SPOOL_MAX_RECORD_BYTES} bytes "
                        f"(re-bound from a {len(line)//MiB} MiB record)",
                    )
            for chunk in chunks:
                out_spans += len(chunk)
                out_lines.append(json.dumps({
                    "project_id": project_id,
                    "events": chunk,
                    # Preserve the ORIGINAL spool time. Resetting it would hide
                    # a genuinely stale backlog by making it look fresh, and
                    # restart a 7-day expiry that has already been running.
                    "spooled_at": spooled_at,
                }))

    print(f"records in       : {in_records:,}  (largest {biggest_in/MiB:,.1f} MiB)")
    print(f"  already bounded: {already_ok:,}")
    print(f"records out      : {len(out_lines):,}")
    print(f"spans in         : {in_spans:,}")
    print(f"spans out        : {out_spans:,}")
    print(f"spans dead-let.  : {dead_spans:,}  (single spans over the cap)")

    if in_spans != out_spans + dead_spans:
        print("\nFAIL: span accounting does not balance -- refusing to write.")
        sys.exit(1)

    if not APPLY:
        print("\nREPORT ONLY. Re-run with --apply to write.")
        sys.exit(0)

    backup = spool.with_suffix(f".jsonl.bak-{time.strftime('%Y%m%d-%H%M%S')}")
    shutil.copy2(spool, backup)
    print(f"\nbacked up to     : {backup.name}")

    temp = spool.with_suffix(".jsonl.rebound")
    temp.write_text("\n".join(out_lines) + "\n", encoding="utf-8")
    os.replace(temp, spool)
    new_size = spool.stat().st_size
    print(f"rewrote spool    : {new_size/MiB:,.1f} MiB in {len(out_lines):,} records")

    over = [l for l in out_lines if len(l.encode("utf-8", "replace")) > bh.SPOOL_MAX_RECORD_BYTES]
    if over:
        print(f"FAIL: {len(over)} record(s) still exceed the cap")
        sys.exit(1)
    print("PASS  every record now under the cap and independently postable")
finally:
    bh._release_spool_lock()
