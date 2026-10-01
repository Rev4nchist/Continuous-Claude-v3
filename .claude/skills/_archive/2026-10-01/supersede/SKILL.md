---
name: supersede
description: Mark a memory entry as superseded by a newer entry. Use when a previously-correct learning is replaced (e.g., the API changed, the architecture was refactored, the failed approach is now the right one). The old entry stays in archival_memory for audit but is excluded from default recall (its valid_until is set to NOW()).
metadata:
  user-invocable: true
---

# Supersede Memory Entry

Phase 1.10 of memory hardening v2 added bi-temporal validity (`valid_from`,
`valid_until`) to `archival_memory`. A "superseded" entry is one whose
`valid_until` has been set -- it stayed correct until that timestamp, but a
newer entry replaces it. Default recall excludes superseded entries; pass
`--include-superseded` to see them.

## When to Use

Trigger this skill when a stored learning is **factually replaced** rather
than wrong-from-the-start:

| Use supersede | Don't use supersede |
|---|---|
| API/library changed and the old pattern no longer works | Old entry was always wrong -> delete or store a correction |
| Architecture refactored, old pattern still works but newer is preferred | Old entry is a duplicate -> let the dedup gate handle it next store |
| User preference changed | The recall already returns the new entry above the old one |
| "Failed approach" turned out to work after a fix | The change is too small to merit a new row |

Supersede preserves audit history. If you need to purge an entry entirely,
delete it directly from the DB.

## Quick Invocation

```
/supersede <old-id> "<new content>" [--reason "<why>"]
```

The old-id is the UUID printed by `recall_learnings.py --json` or by the
PostgreSQL `archival_memory` table. The new content is the replacement
learning text -- a fresh embedding is generated automatically.

## Examples

```
/supersede 613a1764-7c40-450d-86fc-814553c05c15 "Updated: always validate JWT issuer claim AND signature, not just signature" --reason "Discovered token-spoofing CVE; original guidance was incomplete"
```

```
/supersede 2ae48c4f-6073-4366-9636-6fd732327710 "Memory pressure: prefer reboot at >85% RAM; surgical kills no longer help on Windows 11 26200" --reason "Earlier guidance was for Windows 10; new build changes Modified/Standby behaviour"
```

## What It Does

1. Looks up the entry by id -- errors if it doesn't exist or is already superseded.
2. Within a single transaction:
   - Sets `valid_until = NOW()` on the old entry.
   - Inserts a NEW row with `valid_from = NOW()`, `valid_until = NULL`, the new content, a fresh embedding, and metadata including `supersedes: <old-id>` and `supersede_reason: <reason>`.
   - Inherits session_id, scope, project_id, tags, context, and confidence from the old entry unless overridden.
3. Returns JSON with `old_id`, `new_id`, `valid_from`, `valid_until`, `learning_type`, `scope`, and `project_id`.

Idempotent: re-running supersede on an already-superseded id errors with the
original `valid_until` rather than double-marking or inserting a duplicate.

## Execution

When this skill is invoked, run:

```bash
cd $CLAUDE_OPC_DIR && PYTHONPATH=. uv run python scripts/core/supersede.py \
    <OLD_ID> "<NEW_CONTENT>" --reason "<REASON>"
```

CLI flags:

| Flag | Purpose |
|---|---|
| `--reason "<text>"` | Stored in `metadata.supersede_reason`. Strongly recommended. |
| `--scope GLOBAL\|PROJECT` | Override scope of the new entry (defaults to inheriting old). |
| `--project-dir <path>` | Override project_id for the new entry. |
| `--type <LEARNING_TYPE>` | Override learning_type. Inferred from content when omitted. |
| `--provider local\|voyage` | Embedding provider (default: local). |

Valid learning types: `FAILED_APPROACH`, `WORKING_SOLUTION`, `USER_PREFERENCE`,
`CODEBASE_PATTERN`, `ARCHITECTURAL_DECISION`, `ERROR_FIX`, `OPEN_THREAD`.

## Output

```json
{
  "success": true,
  "old_id": "613a1764-7c40-450d-86fc-814553c05c15",
  "new_id": "7bfe8f13-8054-4355-8923-55b5086f3e11",
  "supersedes": "613a1764-7c40-450d-86fc-814553c05c15",
  "valid_from": "2026-05-16T15:08:13.733061+00:00",
  "valid_until": "2026-05-16T15:08:18.845321+00:00",
  "learning_type": "CODEBASE_PATTERN",
  "scope": "PROJECT",
  "project_id": null
}
```

On error:

```json
{
  "success": false,
  "error": "Entry <id> already superseded at <iso-timestamp>",
  "valid_until": "<iso-timestamp>"
}
```

Exit code is 0 on success, 1 on error.

## Verifying

After supersede, run a recall and confirm the old entry is gone from the
default result set:

```bash
cd $CLAUDE_OPC_DIR && PYTHONPATH=. uv run python scripts/core/recall_learnings.py \
    --query "<keyword from old entry>" --json
```

To see the superseded entry for audit:

```bash
cd $CLAUDE_OPC_DIR && PYTHONPATH=. uv run python scripts/core/recall_learnings.py \
    --query "<keyword>" --include-superseded --json
```

To query the state at a past point in time (the old entry was valid then):

```bash
cd $CLAUDE_OPC_DIR && PYTHONPATH=. uv run python scripts/core/recall_learnings.py \
    --query "<keyword>" --valid-at 2026-04-01T00:00:00Z --json
```

## Related

- `.claude/skills/memory/SKILL.md` -- canonical memory reference (recall + store)
- `.claude/skills/recall/SKILL.md` -- recall slash command
- `recall_learnings.py --valid-at` -- bi-temporal point-in-time recall
- `recall_learnings.py --no-decay` -- disable exponential decay (debug)
