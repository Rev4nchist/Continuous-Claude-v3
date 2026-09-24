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
│      factuality + closedqa  → claude -p --model sonnet                 │
│      plan_rubric            → codex exec --sandbox read-only           │
│    NO API keys — both backends authenticate via subscription OAuth     │
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

Three LLM judges run offline against a sampled subset of completed sessions,
driven by `opc/scripts/core/judge_session.py`. This runner is **not** in the
live hook path — it reads completed-session traces from the local cache
(`~/.claude/state/braintrust_sessions/<session_id>.json`) or BTQL, runs the
judges, and emits one feedback POST per judge per sampled session.

### Subscription-CLI judge model (no API keys)

Each judge is a hand-written rubric evaluated by one of two
**subscription-OAuth subprocess CLIs** — there are no API keys for the
judges. The `JUDGE_BACKENDS` map routes each judge:

| Judge | Backend | Invocation | Subscription |
|-------|---------|------------|--------------|
| `factuality` | `claude` | `claude -p "<prompt>" --output-format json --model sonnet` | Claude Code (Sonnet bucket) |
| `closedqa` | `claude` | `claude -p "<prompt>" --output-format json --model sonnet` | Claude Code (Sonnet bucket) |
| `plan_rubric` | `codex` | `codex exec --sandbox read-only "<prompt>"` | ChatGPT (cross-model lift) |

- `factuality` — does the top recall chunk (`output`) factually align with
  the user prompt (`input`)? The top recall chunk is read from
  `memory-recall.jsonl`.
- `closedqa` — did the sub-agent (`output`) answer the orchestrator's task
  request (`input`)? **Top-level Task spans only**; nested Task spans are
  skipped with reason `nested_subagent_no_correlation` (sub-agent correlation
  is deferred Phase 4 work).
- `plan_rubric` — is the plan (`output`) complete, ordered, and verifiable
  given the request (`input`)? Read from the `PostToolUse:ExitPlanMode` span.
  It routes to **codex** so GPT cross-grades Claude-authored plans, which is
  where the cross-model lift comes from.

The `claude` backend strips `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` from
the child env so the subprocess uses subscription OAuth rather than an
inherited external key. Preflight (`check_cli_preflight`) verifies the
required CLIs are authenticated (`codex login status` and/or
`claude --version`) and fails fast with the fix command if not.

A subprocess failure (non-zero exit, timeout, or unparseable output) skips
**only that judge** with a recorded reason — one backend failure never
crashes the whole run, so a session emits 0–3 scores.

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
across project directories. To score `factuality` for a session from any
project, the runner searches the global log, the current working directory,
and **every project path in `~/.claude/project-registry.json`** (deduped). A
session from any registered project is therefore scorable, not just the one
whose `.claude/logs` the runner happens to sit in.

### Idempotency

Each feedback POST `id` is derived from `sha256(f"{session_id}:{judge_name}")`
(first 16 hex chars). Braintrust dedups on the `id` field, so re-runs are
safe — no local state needed.

### Scheduling — `CCv3-Judge-Batch`

The batch runner is scheduled as a **Windows Task Scheduler** job named
`CCv3-Judge-Batch` (daily 06:15 local). It must run on the **local machine** —
NOT a Braintrust UI scoring rule and NOT a Claude Code `/schedule` job —
because the judges call local subscription CLIs (`codex` / `claude`) that a
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
