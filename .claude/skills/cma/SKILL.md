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
