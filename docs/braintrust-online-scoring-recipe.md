# Braintrust Online Scoring Recipe — Gate C / Phase 3b Judges

This is the operations recipe for the **local scheduled runner** that
Phase 3b's trace-level judges run through. The runner code lives in
`opc/scripts/core/judge_session.py`. There is **no Braintrust UI scoring
rule** — the judges shell out to local subscription CLIs, which a
server-side UI rule cannot reach (see "How to run the judges" below). This
doc covers the runner side: trace-level sampling, the three scorers,
eligibility, and the CLI-auth preflight.

**No API keys.** The judge backend is the Claude Code subscription — the
runner shells out to `claude -p`
(Sonnet bucket). There is no API key and
no pay-per-token billing in the judge path.

## Why trace level, not span level

The runner judges **once per session (trace)**, so each judge counts **1
against quota per session**. If it judged per span instead, each judge would
fire once per matching span — for sessions with many Task spans or many
Bash calls, that's a 10-50x quota multiplier with no improvement in
signal. The deterministic 35% sampler in `judge_session.py` is computed
on the trace's `session_id`, which is also the trace's `root_span_id`, and
each judge POSTs to that `root_span_id` so the scores attach at trace level.
Sample decisions are stable per session, not per span.

## Required setup — CLI auth (no API keys)

The judges do **not** use an LLM API key. Each judge prompt is graded by a
subscription CLI subprocess. Before the runner can do real work, `claude`
must be authenticated:

| CLI | Used by | Auth | Verify | Fix |
|-----|---------|------|--------|-----|
| `claude` | `factuality`, `closedqa`, `plan_rubric` | Claude Code subscription (Sonnet) | `claude --version` exits 0 | `claude login` |

The runner's `check_cli_preflight()` runs that probe when a judge is
registered and **fails fast naming the fix command** when `claude` is not
ready. A `--dry-run` skips the auth check entirely (it makes
no backend calls), so quota audits work even on a box where `claude` is not
logged in.

Verify before the first non-dry run:

```bash
claude --version      # expect: a version string, exit 0
```

> **Why `claude -p` strips `ANTHROPIC_API_KEY`:** `opc/.env` sets
> `ANTHROPIC_API_KEY` (for PageIndex). If the `claude` subprocess inherited
> it, Claude Code would try to use it as an *external* API key and 401. The
> runner strips `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from the child
> env so the subprocess authenticates via the subscription OAuth path.

The feedback POST still needs the Braintrust vars:

| Variable | Where it lives | Purpose |
|---------|----------------|---------|
| `BRAINTRUST_API_KEY` | `opc/.env` | Posts feedback to `/v1/project_logs/<project_id>/feedback`. |
| `BRAINTRUST_CC_PROJECT_ID` | `opc/.env` | The project the feedback POSTs target. |
| `TRACE_TO_BRAINTRUST` | `opc/.env` | Set to `true` to actually POST. |
| `BRAINTRUST_API_URL` | `opc/.env` (optional) | Defaults to `https://api.braintrust.dev`. |

## The three judges

The runner emits one feedback POST per sampled session per judge that
has the required artifacts. Each POST targets the session's root_span_id
so the scores attach at trace level in the Braintrust UI.

| Judge | Backend | Input | Output | Skip reason if missing/failed |
|-------|---------|-------|--------|------------------------------|
| `factuality` | `claude -p --model sonnet` | user prompt | top recall chunk | `missing_input_or_output` / `claude_timeout` / `claude_unavailable` / `unparseable_score` |
| `closedqa` | `claude -p --model sonnet` | orchestrator task request | sub-agent final output | `no_task_span` / `nested_subagent_no_correlation` / `missing_input_or_output` / `claude_*` |
| `plan_rubric` | `claude -p --model sonnet` | user prompt | plan body from `ExitPlanMode` | `missing_input_or_output` / `claude_timeout` / `claude_unavailable` / `unparseable_score` |

Each judge prompt is a **hand-written rubric + a structured-output demand**.
The rubric is faithful to autoevals semantics (Factuality / ClosedQA) but the
LLM call is a subprocess CLI, not an autoevals OpenAI-client call. The prompt
ends with: `Respond with ONLY this JSON and nothing else: {"score": <float
0.0-1.0>, "rationale": "<one sentence>"}`. The runner finds the first `{...}`
block in stdout (tolerating markdown fences / preamble), clamps `score` to
`[0.0, 1.0]`, and normalizes a missing `rationale` to `""`.

### Why plan_rubric uses claude -p

`plan_rubric` is graded by `claude -p --model sonnet`, the same subscription
CLI as `factuality` and `closedqa`. The second-CLI backend was removed.
The judge→backend map lives in `JUDGE_BACKENDS` in
`judge_session.py` and is echoed in the runner's JSON output (`backends`
key) so a `--dry-run` shows exactly which backend each judge uses.

### Double-layer parse for the claude backend

`claude -p --output-format json` returns a Claude Code *envelope* whose
`.result` field is a **string** containing the model's text output — and that
text is itself the judge JSON. The runner parses the envelope, takes
`.result`, then parses the judge JSON from within it. An envelope with
`is_error: true` (e.g. an auth failure) is treated as `claude_unavailable`
and skips only that judge.

### Per-judge skip — one failure never crashes the run

A subprocess non-zero exit, timeout, or unparseable output skips **only that
judge** with a recorded reason and continues the others. A sampled session
therefore emits 0–3 scores depending on backend success and which artifacts
the trace actually has.

### Why top-level Task spans only for ClosedQA

The orchestrator-to-sub-agent edge is well-defined (orchestrator says
"do X", sub-agent returns Y, we grade "did Y answer X?"). The
sub-agent-to-nested-tool edge is currently *not* correlated end-to-end
in our Braintrust traces — Phase 4 (sub-agent correlation) is deferred.
If we grade nested Task spans now, we get wrong attribution. The runner
skips nested spans with reason `nested_subagent_no_correlation` and the
ClosedQA judge gets one shot per session at the top-level Task only.

## How to run the judges — local scheduled runner (NOT a UI rule)

**Important:** With subscription-OAuth judges there is **no Braintrust UI
online-scoring-rule path.** A UI scoring rule runs on Braintrust's servers,
which can only call API-key-based scorers (autoevals / OpenAI / Anthropic) —
they **cannot invoke your local / `claude` CLIs** or their OAuth
tokens. The `factuality` / `closedqa` / `plan_rubric` judges live in
`opc/scripts/core/judge_session.py` and only work where those CLIs are
authenticated: your local machine.

So the judges run via the **local CLI runner**, which posts scores to
Braintrust via `/v1/project_logs/<project_id>/feedback` (same pattern as
Phases 1-2 — `emitBraintrustScore`, `_emit_store_quality_score`). The
Braintrust UI is the *viewing* destination (Feedback panel), not a trigger.

### Manual / ad-hoc

```bash
cd opc && uv run python -m scripts.core.judge_session --session-id <id>                          # one session (still sampled)
cd opc && uv run python -m scripts.core.judge_session --session-id <id> --force                  # one session, BYPASS the 35% sampler
cd opc && uv run python -m scripts.core.judge_session --scan-since <iso-date> --max-sessions N   # batch
cd opc && uv run python -m scripts.core.judge_session --scan-since <iso-date> --dry-run          # preview, no calls
```

`--session-id` alone still respects the 35% sampler (it judges nothing if the
session hashes out of sample). Use `--force` to judge a specific session
regardless of its hash — for on-demand/debug scoring. `--force` applies to
single-session mode only; it's ignored in batch (`--scan-since`).

**Cross-project recall:** the runner reads `memory-recall.jsonl` from the
global log, the cwd, AND every project path in `~/.claude/project-registry.json`.
So a session that ran in any registered project (NorthStar, Fourth Connect, etc.)
has its factuality recall found, not just sessions from the runner's own cwd.
(`closedqa`/`plan_rubric` read the Braintrust trace, so they were already
cross-project.)

### Automated (scheduled) — must be a LOCAL scheduler

Schedule the `--scan-since` batch on the **local machine only**. Claude Code
`/schedule` routines run *remotely* (Anthropic cloud) and — like a Braintrust
UI rule — cannot reach the local / `claude` CLIs or their OAuth tokens.
So the runner is scheduled via **Windows Task Scheduler** (this machine), not
`/schedule`.

A wrapper script `scripts/run-judge-batch.ps1` runs the daily batch
(`--scan-since` = previous day), and a Task Scheduler job `CCv3-Judge-Batch`
invokes it daily. To inspect or change it:

```powershell
schtasks /query /tn "CCv3-Judge-Batch" /v /fo list     # view
schtasks /run   /tn "CCv3-Judge-Batch"                 # run now (manual trigger)
schtasks /delete /tn "CCv3-Judge-Batch" /f             # remove
```

Pick a cadence that keeps daily judge volume within subscription headroom
(see Cost / quota below). The wrapper defaults to `--max-sessions 10`.

### Eligibility (built into the runner, no UI filter needed)

The runner already short-circuits sessions lacking the required artifacts
(a recall event, plus a Task span or `ExitPlanMode` span) before any backend
call — verified in the dry-run. No external eligibility filter to configure.

### If you ever DO want a Braintrust UI rule

You'd have to abandon the subscription-CLI judges and re-implement the three
scorers as Braintrust **server-side autoevals** with an `OPENAI_API_KEY` (or
`ANTHROPIC_API_KEY`) configured in the Braintrust project — i.e. accept API
billing. That's the exact trade-off we rejected. Don't do this unless the
local-runner cadence proves insufficient AND you accept per-token cost.

The feedback id derivation (`sha256(f"{session_id}:{judge_name}")[:16]`) makes
re-runs idempotent — Braintrust dedups on id, so overlapping batches are safe.

## Verifying the judges fire

Kick off a normal Claude Code session that contains a recall, a Task call, and
an `ExitPlanMode`. Wait for the trace to complete, then run the local runner
against that session. Use `--session-id <id> --force` for the test —
`--session-id` *alone* still respects the 35% sampler, so the session may hash
out of sample and emit nothing; `--force` guarantees the judges fire. Then in
the Braintrust UI:

1. Open the trace's root span.
2. Look at the **Feedback** panel.
3. You should see up to three scores: `factuality`, `closedqa`,
   `plan_rubric`, each with `score` and a `rationale` in the metadata.

If a judge is missing, check the skip reasons by re-running the CLI in
dry mode for that session:

```bash
cd opc && uv run python -m scripts.core.judge_session \
    --session-id <session-id> --dry-run
```

The output JSON's `skipped` map tells you which judges were skipped and
why.

## Trigger conditions / when to run

All scoring goes through the local CLI runner — there is no UI-rule path
for the subscription-CLI judges.

| Scenario | CLI runner |
|----------|-----------|
| Steady-state automated scoring | `CCv3-Judge-Batch` scheduled task (daily, `--scan-since` previous day, 35% sample) |
| Backfill historical sessions | `--scan-since <iso-date> --max-sessions N` |
| Re-grade a specific session | `--session-id <id>` (still sampled) or `--session-id <id> --force` (bypass sampler) |
| Pre-flight a candidate change to the rubric | `--session-id <id> --dry-run` then enable POSTs |
| Quota audit | `--dry-run` reports `would_post` counts without firing judges |

## Idempotency and re-runs

Re-running the CLI for the same session yields the same feedback IDs
(`sha256(f"{session_id}:{judge_name}")[:16]`). Braintrust dedups on the
id, so re-running is safe — overlapping batches (e.g. a manual re-grade
landing on a session the scheduled batch already scored) won't create
duplicate scores.

## Cost / quota notes

- **No per-token API billing.** Every judge is subscription-billed via
  OAuth on the Claude subscription. `plan_rubric`, `factuality`, and
  `closedqa` each spend one Claude Code turn against the Sonnet bucket.
- One fully-equipped sampled session = up to three Claude judge calls.
- At 35% sampling and ~50 sessions/day, expect ~52 sampled sessions per
  week, ~156 Claude judge calls per week. Adjust the sample rate at the
  rule level if this exceeds your subscription quota.
- Subprocess latency: budget ~10–90s per Claude call. Each call has a
  hard 180s timeout; a timeout skips only that judge (`claude_timeout`).

## Distribution review

Defer per the plan: ~1 week after first organic runs, eyeball the score
histograms in the Braintrust UI. If any judge produces near-uniform
`score=1.0` outputs, the prompt or rubric needs sharpening before the
score signal is useful.
