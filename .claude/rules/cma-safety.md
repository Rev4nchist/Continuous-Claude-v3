# Claude Managed Agents (CMA) Safety Rules

Companion to `.claude/skills/cma/SKILL.md` and the `/launch-your-agent` + `/wrap-up` wizard skills.
CMA is Anthropic's **cloud-hosted** agent harness (REST API at `api.anthropic.com/v1`, beta header
`managed-agents-2026-04-01`). Every create/send call runs in Anthropic's cloud and **bills consumption
on the `ANTHROPIC_API_KEY` — SEPARATE from Dave's Claude Code subscription** (standard tokens +
**$0.08/session-hour**, idle free, ms-metered + web search $10/1k). CMA is **NOT** ZDR/HIPAA-eligible.

## Auth prerequisite (verify FIRST)

CMA needs a **valid Console API key** (`sk-ant-api03-…`) with consumption billing. Confirm it before any
call: `curl -sS -o /dev/null -w "%{http_code}" https://api.anthropic.com/v1/models -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01"` → expect **200**. A **401 `invalid x-api-key`** means the
key is missing/revoked/expired — STOP and have Dave mint a fresh key at platform.claude.com → API keys.
(As of 2026-06-27 the env key 401s; the live path is blocked until replaced.) Never print the key value.

## Safe Commands (no confirmation needed — read-only, no spend)

- `ant agents list|get|describe` · `curl GET $BASE/agents[/:id]` · `…/agents/:id/versions`
- `ant environments list|get` · `curl GET $BASE/environments[/:id]`
- `ant sessions list|get|describe` · `curl GET $BASE/sessions[/:id]` (read `.status`, `.usage`, `.outcome_evaluations`)
- `ant events read|tail` · `curl GET $BASE/sessions/:id/events` · the SSE `/events/stream` (reading an existing run)
- `ant models list` · `curl GET $BASE/models`
- `curl GET $BASE/deployments[/:id]` · `$BASE/deployment_runs?deployment_id=…` (history)
- `curl GET $BASE/files?scope_id=…` + `…/files/:id/content` (fetch a finished run's outputs)
- workspace identity / `GET $BASE/me`
- Any pure `GET` to `api.anthropic.com/v1/…`

## Confirm-First Commands (ALWAYS explain + wait for Dave's approval)

These spend money, mutate cloud state, or are irreversible:

- `ant agents create` / `agents update` (new versioned config)
- `ant environments create` / `environments delete`
- `ant sessions create` — **provisions a billable sandbox**
- `ant events send` / `append` — `user.message` / `user.define_outcome` **spends tokens + session-runtime**
- `ant deployments create` / `delete` / `pause` / `unpause` — **native cron = recurring spend**
- `deployments/:id/run` (manual fire) — creates a billable session immediately
- `ant vaults create` + `vaults/:id/credentials` (writes a secret) / `vaults delete`
- `agents archive` / `sessions delete|archive` (destructive)
- **Raising `max_iterations` above the default 3** (each iteration is a full graded turn)

## Pre-Flight (run before ANY create/send)

1. **Auth + identity** — the 200 check above; confirm WHICH Console **workspace** the key maps to (objects only
   appear in that workspace's Console — the answer to "I can't see it"). CMA spend is on Dave's consumption billing.
2. **Confirm the target** — the exact agent/environment/session/deployment id you're about to act on.
3. **Data-residency gate** — CMA is NOT ZDR/HIPAA-eligible and ships data to Anthropic's cloud. **Never route
   regulated/ZDR-required data, secrets, or sensitive private content into a CMA session.** For repo digests,
   scope to repos whose contents are acceptable to process in the cloud.
4. **Cost estimate** — state "this spends on Dave's API key, workspace = X, est = ~tokens + $0.08×<hrs>, max_iterations = 3" BEFORE the billable call (heads-up-early / hand-over-late).

## Cost Guard

- Pricing: standard tokens + **$0.08/session-hour** (idle free, ms-metered) + web search $10/1k. Idle is free,
  but a `running` outcome loop and an un-ended session are not — always end/archive sessions you're done with.
- Keep `max_iterations: 3` (max 20). Never raise without an explicit confirm + cost note.
- **Spend ledger:** append one row per billable create/send to `.claude/logs/cma-spend.jsonl`
  (schema mirrors `codex-lift.jsonl`): `{ts, op, agent_id, session_id, model, est_session_hours, max_iterations, via}`.
- Optional soft cap: if `CMA_MONTHLY_BUDGET_USD` env var is set, surface the running ledger total before confirming.
- Spend caps are also settable at the **workspace level in the Console** — recommend setting one before standing up a cron deployment.

## Standing Deployments (recurring spend — extra care)

A scheduled deployment fires **unattended**, so the interactive confirm-gates DO NOT protect it. Before creating one:
- Pin `max_iterations: 3` in the deployment's `initial_events`; use **relative dates** ("today", "last 7 days as of this run") — `initial_events` replay verbatim every run.
- Set a workspace spend cap.
- Add a post-run monitor (read `deployment_runs?has_error=true` + verify the expected output landed) so a silent failure is caught.
- **Pause / delete (the off switch):** `POST $BASE/deployments/:id/pause` (stop firing, keep config) ·
  `…/unpause` · `…/archive`. Document the exact pause command alongside any cron you create so Dave can stop spend instantly.

## Secrets Hygiene

- Store credentials as **write-only CMA vault** entries; prefer `environment_variable` auth with a
  `networking.limited.allowed_hosts` allowlist (e.g. `["api.notion.com"]`) so the sandbox can only reach the
  intended host — this contains exfiltration better than a prompt instruction.
- **Never** put a token in an inline `Authorization` header inside a persisted command/payload, in agent output,
  in `my-agent/` artifacts, or in the digest — secret-scan outputs before any external write.
- **Never** print `ANTHROPIC_API_KEY` or any vault secret. The SDK/`ant`/curl read the key from the environment.

## Quick Decision Table

| Pattern | Safe? |
|---------|-------|
| `GET …/v1/…` (list/get/describe/read/stream existing) | Yes |
| `ant models list` / workspace identity | Yes |
| `agents create|update`, `environments create|delete` | **Confirm** |
| `sessions create`, `events send` (message/outcome) | **Confirm** (spends) |
| `deployments create|delete|pause|unpause|run` | **Confirm** (recurring spend) |
| `vaults create` + credential write, `vaults delete` | **Confirm** |
| `agents archive`, `sessions delete|archive` | **Confirm** (destructive) |
| raising `max_iterations` above 3 | **Confirm** |

## Repatriation Ramp (anti-lock-in)

`cma-operator` writes to the same `.claude/cache/agents/<name>/latest-output.md` convention as local agents and is
spawnable from the same `claude -p` / Task Scheduler substrate. Any CMA job can move back to a local `claude -p`
wrapper by swapping the invocation line — no downstream consumer rewrite. Existing recurring jobs
(FourthOS weekly, weekly-report) **stay local**; CMA is additive for net-new off-box jobs only.
