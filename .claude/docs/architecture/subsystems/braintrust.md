> RETIRED 2026-09-30. Tracing is off and the hooks are removed. See archive/braintrust-2026-10/.

# Braintrust Observability Subsystem

Braintrust is the observability pillar: it scores how well the CCv3 system
performs its own work. Underneath sits a trace/span pipeline
(`braintrust_hooks.py`) that produces the spans the scores attach to. Above it
are two scoring layers — fast deterministic scores emitted live by hooks, and
slower LLM-judge scores run offline on a sampled subset of sessions.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      BRAINTRUST OBSERVABILITY                           │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  LAYER 0 — TRACE/SPAN pipeline (live, in the hook path)                 │
│    braintrust_hooks.py                                                  │
│      turn span opened by  user_prompt_submit                            │
│      turn span closed by  stop  → Stop event (+ SessionEnd safety net)  │
│                                                                         │
│  LAYER 1 — DETERMINISTIC scores (live, in the hook path)                │
│    4 TS hooks → await emitBraintrustScore(...)                          │
│      shared helper: hooks/src/shared/braintrust-score.ts               │
│    7 score dimensions, no LLM, ~ms latency                             │
│                                                                         │
│  LAYER 2 — LLM JUDGES (offline, scheduled, sampled)                     │
│    opc/scripts/core/judge_session.py                                   │
│      JUDGE_REGISTRY ships EMPTY (P32, 2026-09-24) — see below          │
│    NO API keys — registered judges authenticate via subscription OAuth │
│    35% deterministic sampler · --force bypass · cross-project recall   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
            │                                          │
            ▼                                          ▼
   /v1/project_logs/{project_id}/feedback   (Braintrust UI: spans + scores)
```

## Layer 0 — Trace/Span Pipeline

The scores in Layers 1 and 2 attach to spans produced by `braintrust_hooks.py`.
Per-turn spans are opened by `user_prompt_submit` — which now owns
`current_turn_span_id` exclusively — and finalized by `stop`, which is written
for per-turn incremental work (it tracks `turn_last_line` in the transcript).

**Fixed in `ccdd14b`:** `stop` was registered only on `SessionEnd`, so it ran
once per session while being written to run once per turn. 7,610 of 8,726 turn
spans (87%) across 1,637 sessions were opened and never closed — open-ended,
unbounded duration in the Braintrust UI. `stop` is now also registered on a new
`Stop` event key in **both** `settings.json` copies (repo `.claude/` and active
`~/.claude/`; `python … braintrust_hooks.py stop`, timeout 15000). There was no
`Stop` key at all before. The `SessionEnd` registration stays (timeout 30000),
deliberately, as a safety net for an abrupt exit mid-turn — nothing was removed.

`stop` is idempotent: it returns early ("already finalized") when the transcript
has no new lines. That replaces the old re-entry guard, which worked by clearing
`current_turn_span_id`. `stop` no longer writes that key — it was the only
two-writer key.

Two properties made the per-turn registration safe, both established
empirically:

- **`Stop` and `UserPromptSubmit` are serialized.** The CLI does not fire
  `UserPromptSubmit` until every `Stop` hook returns (proven with 90s and 40s
  holds; the next prompt fired at +90,444ms and +40,327ms). The locked merge
  originally planned is therefore not needed (deferred as Option B).
- **Braintrust tolerates a parent span arriving after its children.** A child
  with a dangling `span_parents` reference is accepted (HTTP 200) and the
  hierarchy resolves on read, so the spool needs no parent-before-child
  ordering.

Guards: 3 in `.claude/hooks/src/__tests__/braintrust-hooks-shutdown.test.ts`
(12 tests in that file); full hook suite 117 files / 2284 passed / 0 failed.
Runbook: `docs/hooks/braintrust-stop-event-scope.md` §3.

## Layer 1 — Deterministic Scores

Seven dimensions are emitted live during a session. The four TypeScript emit
sites each call `await emitBraintrustScore(...)` from the shared helper
`.claude/hooks/src/shared/braintrust-score.ts`. The fifth source is the
Python `store_learning.py`.

| Dimension | Emitter | Lifecycle event |
|-----------|---------|-----------------|
| `memory_recall_relevance` | `memory-awareness.ts` | UserPromptSubmit |
| `memory_recall_hit` (companion) | `memory-awareness.ts` | UserPromptSubmit |
| `memory_store_quality` | `store_learning.py` (opc) | store-time (Python) |
| `tool_call_success` | `telemetry-tracker.ts` | PostToolUse |
| `skill_trigger_accuracy` | `telemetry-tracker.ts` | PostToolUse |
| `hook_health_ratio` | `hook-health-monitor.ts` | SessionStart |

**Why `await`, not `void`:** `emitBraintrustScore` POSTs feedback over HTTPS.
A `void` (fire-and-forget) call lets SessionStart-class hooks exit
milliseconds later, killing the in-flight POST before it lands. Every emit
site must use `await ... ` on a single line.

### The audit invariant

`scripts/audit-braintrust-emits.sh` is the regression tripwire. It greps
`.claude/hooks/src/` (excluding `__tests__/`) for `await emitBraintrustScore(`
and compares the count against an invariant — the TS emit sites
(`memory-awareness`, `telemetry-tracker`, `hook-health-monitor`; `ralph-task-monitor`
was removed with the rest of Ralph's live machinery). It exits non-zero if the
count shrinks below the invariant.

- The grep matches `await` only — a revert to `void` or a call split across
  lines trips the check (the old grep matched both and would have falsely
  passed an all-`void` revert).
- **Run it after ANY TypeScript hook edit.** Do NOT lower `INVARIANT_4` to
  silence a failure — fix the code it points at. If a genuinely new score
  dimension is added, that is the only reason to bump the invariant.

### Regression history (corrected)

The four emit sites regressed ~8 times in late May 2026. The corrected root
cause is **two interacting infrastructure paths**, not an "agent rewrite
collision" or a "linter revert" (both were misdiagnoses — no linter,
prettier, lint-staged, or husky exists on the hook source):

1. **Primary writer** — a rogue Ralph autonomous loop running in a separate
   Claude Code session (`ccv3-visualization` workflow) iterating against a
   2-day-stale baseline and writing the regression pattern (`await` → `void`,
   plus deletion of the memory-awareness emit block) directly into the hook
   source in both the repo and the `~/.claude/` mirror.
2. **Amplifier** — asymmetric sync. `sync-claude.sh --to-repo` carried
   `hooks/src/` while `sync-to-active.sh` excluded it, so each Ralph write got
   re-mirrored on the next reverse-sync, making one logical write look like a
   single deterministic event.

Neither alone explains the recurrence. Both were fixed: the Ralph loop was
killed manually, and the sync asymmetry was closed in commit `ddc0641`
(reverse-sync now also excludes `hooks/src/` and runs a pre-flight audit gate
that refuses to propagate if the repo audit fails). Methodology learnings are
stored as memory IDs `7a5f3af3` and `e59179b9`.

### Sync exclusion

The `audit-braintrust-emits.sh` guard works because `hooks/src/` is no longer
propagated by sync in either direction:

| Direction | Script | `hooks/src/` carried? |
|-----------|--------|-----------------------|
| Forward (repo → `~/.claude/`) | `sync-to-active.sh` | No — only `dist/*.mjs` runs |
| Reverse (`~/.claude/` → repo) | `sync-claude.sh --to-repo` | No (since `ddc0641`) + pre-flight audit gate |

The active hooks run from compiled `dist/*.mjs`; the TypeScript source is
edited only in the repo.

## Layer 2 — LLM Judges

`opc/scripts/core/judge_session.py` runs a registry of LLM judges offline
against a sampled subset of completed sessions. This runner is **not** in
the live hook path — it reads completed-session traces from the local cache
(`~/.claude/state/braintrust_sessions/<session_id>.json`) or BTQL, runs each
registered judge, and emits one feedback POST per judge per sampled session.

### Judges retired (P32, 2026-09-24)

The original three judges (`factuality`, `closedqa`, `plan_rubric`) are
retired. None produced a usable score in production: `closedqa` filtered on
a span name that never matched a live span, `plan_rubric` never scored
either, and `factuality` compared a prompt against text derived from that
same prompt, which is circular. The runner and its `JUDGE_REGISTRY` remain —
a registered judge is still graded by one of two subscription-OAuth
subprocess CLIs (`retired exec --sandbox read-only` or
`claude -p --output-format json --model sonnet`, no API keys), preflight
still checks only the CLIs a registered judge needs, and a subprocess
failure still skips only that judge. New binary judges (one failure mode
each, pass/fail, validated against human labels) are expected with P17.

### Sampling and `--force`

Sampling is deterministic per session:

```
int(sha256(session_id)[:8], 16) % 100 < 35   →  ~35% of sessions sampled
```

The same `session_id` always lands in or out of the sample, which keeps
quota predictable and the decision auditable. The `--force` flag (single-
session mode only) bypasses the sampler to judge a session on demand; the
result carries `"forced": True` while `"sampled"` still reflects the true
(un-forced) hash. `--force` is ignored in batch mode (`--scan-since`).

### Cross-project recall

`memory-awareness.ts` writes its recall log per-project at
`<projectDir>/.claude/logs/memory-recall.jsonl`, so recall data is fragmented
across project directories. To score a recall-based judge for a session from
any project, the runner searches the global log, the current working
directory, and **every project path in `~/.claude/project-registry.json`**
(deduped). This read-side helper (`_read_top_recall_from_log`) stays even
while `JUDGE_REGISTRY` is empty, so a future recall-based judge (P17) can use
it without rebuilding it.

### Idempotency

Each feedback POST `id` is derived from `sha256(f"{session_id}:{judge_name}")`
(first 16 hex chars). Braintrust dedups on the `id` field, so re-runs are
safe — no local state needed.

### Scheduling — `CCv3-Judge-Batch`

The batch runner is scheduled as a **Windows Task Scheduler** job named
`CCv3-Judge-Batch` (daily 06:15 local). It must run on the **local machine** —
NOT a Braintrust UI scoring rule and NOT a Claude Code `/schedule` job —
because the judges call local subscription CLIs (`retired` / `claude`) that a
remote rule cannot reach.

```bash
# Single session, on demand (bypass sampler)
cd opc && uv run python -m scripts.core.judge_session --session-id <id> --force

# Batch (what CCv3-Judge-Batch runs), capped + dry-run available
cd opc && uv run python -m scripts.core.judge_session --scan-since 2026-05-20 \
  --max-sessions 10 --dry-run
```

## Cross-Reference

→ **`docs/braintrust-online-scoring-recipe.md`** — operational detail: CLI
auth setup, the three-judge rubric definitions, the local scheduled-runner
configuration (and why it is NOT a UI rule), idempotency, and cost/quota
notes. This subsystem doc summarizes; the recipe doc is the runbook.

## When to Use

| Situation | Action |
|-----------|--------|
| Edited any TS hook under `hooks/src/` | Run `bash scripts/audit-braintrust-emits.sh` — confirm 4/4 |
| Turn spans look open-ended in the Braintrust UI | Confirm the `Stop` key registers `braintrust_hooks.py stop` in **both** `settings.json` copies |
| Score-volume looks wrong in Braintrust UI | Check the 7-dim → emitter map above; verify the emit `await` survived |
| Want a judge score for one session now | `judge_session.py --session-id <id> --force` |
| Suspect a regression returned | `git diff HEAD -- .claude/hooks/src/*.ts \| grep emitBraintrustScore` |
