---
name: cma
description: Operator reference for Claude Managed Agents (CMA) — Anthropic's cloud-hosted agent harness. Use when running, inspecting, or scripting CMA agents, environments, sessions, events, outcomes, vaults, memory stores, or scheduled deployments via the ant CLI, the anthropic SDK, or curl against api.anthropic.com. Distinct from the launch-your-agent wizard (which interviews and builds a new agent); this skill is the call-shape and operator reference for working with CMA that already exists. Triggers on cma, managed agents api, ant cli, cma session, cma deployment, cma vault.
metadata:
  version: "1.0.0"
  authored: "2026-06-27 (continuous-claude harness)"
  companions: ".claude/rules/cma-safety.md, .claude/skills/launch-your-agent/, .claude/agents/cma-operator.md"
---

# CMA — operator reference

Claude Managed Agents is Anthropic's **cloud-hosted** agent harness: you define an Agent config
(model + system + tools + mcp_servers + skills), and Anthropic runs the agent loop in a sandboxed Linux
container server-side, persisting the event log. It reaches the world only through the internet
(`web_fetch`/`web_search`), its own sandbox filesystem, and the **MCP connectors + vault credentials** you
wire to it — **never your local disk or local MCP servers**. Live docs (authoritative on drift):
https://platform.claude.com/docs/en/managed-agents/overview

**Before any billable call, apply `.claude/rules/cma-safety.md`.** Spend is on `ANTHROPIC_API_KEY`
(consumption — SEPARATE from the Claude Code subscription): tokens + **$0.08/session-hour** + web search.

## API Contract (single source of truth — the drift firewall)

Everything else references these constants; if a call fails on one, the live docs win — fix here once.

- Base: `https://api.anthropic.com/v1`
- Headers: `x-api-key: $ANTHROPIC_API_KEY` · `anthropic-version: 2023-06-01` · `anthropic-beta: managed-agents-2026-04-01` · `content-type: application/json`
- Built-in toolset id: **`agent_toolset_20260401`** — pass as `[{"type":"agent_toolset_20260401"}]`. The API
  **rejects** built-in tools listed individually (`{"type":"bash"}` → 400). Disable one with
  `configs:[{"name":"web_search","enabled":false}]`; gate one with `permission_policy:{type:"always_ask"}`.
- Deployments use the query param `?beta=true` (not the header) on create/run/pause.
- Models: `claude-opus-4-8` (default) / Sonnet for speed-or-cost. `system.message` mid-session is Opus-4.8 only.

## Auth quick check (read-only, $0)

```bash
curl -sS -o /dev/null -w "%{http_code}\n" https://api.anthropic.com/v1/models \
  -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01"
```
200 = key valid. **401 `invalid x-api-key` = key missing/revoked/expired** → mint a fresh Console key
(platform.claude.com → API keys), confirm consumption billing, note its workspace. Never print the key.

## Primitives (one line each)

| Emoji | Primitive | What it is | ID |
|-------|-----------|------------|----|
| 🤖 | Agent | versioned config: model + system + tools + mcp_servers + skills + multiagent | `agent_…` |
| 📦 | Environment | where sessions run: `cloud` sandbox (default) or `self_hosted`; networking unrestricted/limited; packages | (env id) |
| ▶️ | Session | one running instance; sandbox + event log; statuses idle→running→terminated | `sesn_…` |
| ✉️ | Events | bidirectional; **open the SSE stream BEFORE sending** (only post-open events deliver) | — |
| 🎯 | Outcome | self-grading rubric loop; `user.define_outcome` + `max_iterations` (default 3, max 20) | — |
| 🗓️ | Deployment | native cron (5-field POSIX + IANA tz) — recurring, unattended spend | `depl_…` |
| 🔐 | Vault | write-only credentials; prefer `environment_variable` auth + `networking.limited.allowed_hosts` | `vlt_…` |
| 🧠 | Memory store | cross-session state mounted at `/mnt/memory/` | `memstore_…` |

Outputs land in `/mnt/session/outputs/`, fetched via the Files API (`?scope_id=$SESSION_ID`).

## Surfaces — pick the right one

| Surface | Use when | Notes |
|---------|----------|-------|
| **Python SDK** (`pip install anthropic`, present) | **headless / scheduled / cma-operator** | sets the beta header + manages the SSE lifecycle automatically; the robust path on Windows |
| `ant` CLI | interactive ops | no public Windows release binary as of 2026-06-27 — install from a release binary to `C:\tools\ant\` if/when available, else use SDK/curl |
| `curl.exe` | debugging an exact payload, zero-install | in PowerShell use `curl.exe` (bare `curl` is an alias) or run via the Bash tool; parse responses with `python` + `json.JSONDecoder(strict=False)`, NOT `jq` (embedded system prompts carry control chars) |

## Call shapes — see the vendored reference (DRY)

Full verified curl / `ant` / SDK shapes for every call (agent, environment, session, kickoff events, watch,
outputs, memory, vault, scheduled deployment, troubleshooting) live in
**`.claude/skills/launch-your-agent/references/cma-api.md`** — do not duplicate them here; that file is the
maintained call-shape reference (Windows-ported).

## Anti-patterns

- Sending an event before opening the SSE stream (the agent never sees it).
- Listing built-in tools individually (400) — use the toolset wrapper.
- Raising `max_iterations` without a cost check (each iteration is a full graded turn).
- Assuming subscription billing — CMA bills the API key's consumption, separately.
- A literal date in a deployment's `initial_events` (they replay verbatim every run — use relative dates).
- Leaving a session `running` / un-archived (idle is free, but tidy up).
- Routing local-only data into the cloud sandbox — it can't see your disk; feed it GitHub/MCP/vault instead.

## Boundary vs the wizard

`/launch-your-agent` = the interview→build-sheet→launch→grade→schedule **wizard** for standing up a NEW agent.
`/wrap-up` = the close-out/status skill. **This `cma` skill** = the operator reference for working with CMA
(call shapes, auth, primitives, safety) once you know what you're doing. The headless/scheduled execution path
is the **`cma-operator`** agent (`.claude/agents/cma-operator.md`).

---

<!-- archived-rule:cma-safety.md -->
## Reference: pre-split text of `rules/cma-safety.md` (archived 2026-07-29)

The rule now carries only what must be true *before* an agent decides to touch CMA at all —
that it spends real money on a different account, that it is not ZDR-eligible, that every
non-`GET` is confirm-first. The endpoint-by-endpoint safe/confirm lists, pre-flight sequence,
cost mechanics, deployment recipe, vault setup and repatriation ramp live here, and load only
once this skill does. Verbatim snapshot, so nothing that was trimmed is lost:

````markdown
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
````
