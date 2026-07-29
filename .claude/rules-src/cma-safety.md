# Claude Managed Agents (CMA) Safety Rules

Operator detail — the endpoint-by-endpoint safe/confirm lists, pre-flight sequence, cost
mechanics, standing-deployment recipe, vault setup and the repatriation ramp — lives in
`.claude/skills/cma/SKILL.md` (verbatim pre-split snapshot at the foot of that file). Load it
before any CMA work. Companion wizards: `/launch-your-agent` (build), `/wrap-up` (close out).
Headless execution path: the `cma-operator` agent.

## What must be true unprompted

1. **CMA spends real money, on a DIFFERENT account.** It is Anthropic's **cloud-hosted** harness
   (`api.anthropic.com/v1`, beta header `managed-agents-2026-04-01`). Every create/send bills
   consumption on `ANTHROPIC_API_KEY` — **separate from Dave's Claude Code subscription** — at
   standard tokens + **$0.08/session-hour** (idle free, ms-metered) + web search $10/1k. Nothing
   here rides the subscription.
2. **CMA is NOT ZDR/HIPAA-eligible.** Never route regulated data, secrets, or sensitive private
   content into a CMA session. Scope repo digests to repos whose contents are acceptable to
   process in Anthropic's cloud.
3. **Auth is verified first, never worked around.** A valid Console key (`sk-ant-api03-…`) with
   consumption billing is required; `GET /v1/models` must return **200**. A **401
   `invalid x-api-key`** means missing/revoked/expired — STOP and have Dave mint a fresh key.
   Never print the key value.
4. **Never print `ANTHROPIC_API_KEY` or any vault secret.** The SDK / `ant` / curl read it from
   the environment.

## Confirm-first boundary [C:10]

**Every non-`GET` is confirm-first.** Default-deny, not a lookup list — an unfamiliar mutating
call is CONFIRM, never assume-safe. Pure `GET` reads (agents/environments/sessions/events/
deployments/files, `ant models list`, workspace identity) are safe and free.

Worth naming because the cost is not obvious from the verb: `sessions create` provisions a
**billable** sandbox; `events send` spends tokens **and** session-runtime; `deployments create`
is **recurring** spend; `vaults` writes a secret; `archive`/`delete` are irreversible; and
**raising `max_iterations` above the default 3** buys a full graded turn per increment.

Before the billable call, state it: *spends on Dave's API key, workspace = X, est ≈ tokens +
$0.08×\<hrs\>, max_iterations = 3.* Confirm which Console **workspace** the key maps to — objects
only appear in that workspace, which is the answer to "I can't see it".

## Standing deployments fire unattended

A scheduled deployment is **not** protected by the gates above — nobody is there to confirm. So
anything put on a clock ships with its off switch documented in the same breath:
`POST $BASE/deployments/:id/pause`. Pin `max_iterations: 3`, use **relative** dates in
`initial_events` (they replay verbatim every run), and set a workspace-level spend cap.

## Spend ledger

Append one row per billable create/send to `.claude/logs/cma-spend.jsonl`:
`{ts, op, agent_id, session_id, model, est_session_hours, max_iterations, via}`.
