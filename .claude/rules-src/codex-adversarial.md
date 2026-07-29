# Codex Adversarial Review Rules

OpenAI Codex (default `gpt-5.5 @ xhigh`; override via `CODEX_ADVERSARY_MODEL` env var; requires `@openai/codex` CLI >= 0.131 — verified working on `codex-cli 0.131.0` as of 2026-06-01; CLI upgraded to `0.144.1` + re-verified 2026-07-11) is wired into CCv3 as a **cross-model adversarial reviewer** via:
- `codex-plugin-cc` plugin (slash commands `/codex:*`)
- `codex-adversary` agent (used by `/review` and `/premortem`)
- `plan-exit-premortem-prompt` hook (auto-offers `/premortem` after every approved plan)

**This rule governs read-only REVIEW only.** For write-capable task *execution* via Codex (`/codex` — ask/implement/resume, `workspace-write` in an isolated worktree), see the sibling rule `.claude/rules/codex-worker-safety.md` and the `codex-worker` agent. `/codex --review` delegates back to the `codex-adversary` agent covered here.

## When Codex Review Fires (default behavior)

| Trigger | Codex involvement |
|---------|-------------------|
| `/review` | codex-adversary runs in parallel Phase 1 alongside critic and plan-reviewer |
| `/premortem` | Codex adversarial pass after the inline failure-mode imagining step |
| After `ExitPlanMode` | AskUserQuestion offers `/premortem` (which includes Codex pass) |
| Manual: `/codex:adversarial-review --base <ref>` | One-shot review on demand |
| Manual: `/codex:review` | Standard (non-adversarial) review |

## When to Skip Codex

Use `--no-codex` on `/review` and `/premortem` for:
- Doc-only changes (.md, .json comments) - waste of Codex quota
- Hotfixes where latency matters more than depth
- Trivial diffs (<20 lines, single-file, no logic change)
- When the user has already explicitly burned through Codex quota this session

## Safe Commands (no confirmation needed)

- `codex login status` (check auth state without re-prompting)
- `codex --version`, `codex --help`
- `codex exec` with `--sandbox read-only`
- `/codex:review`
- `/codex:adversarial-review`
- `/codex:status`, `/codex:result`, `/codex:cancel`

## Confirm-First Commands (ALWAYS ask user)

Before running ANY of these, explain what it does and wait for explicit user approval:

- `/codex:rescue` - delegates *execution* of a task to Codex. Large blast radius, can modify files.
- `codex exec` with `--sandbox workspace-write` or `--sandbox danger-full-access`
- `codex exec --dangerously-bypass-approvals-and-sandbox`
- `/codex:setup --enable-review-gate` - **DO NOT enable**. Documented as high-cost (drains ChatGPT Codex quota), high-latency (900s timeout per turn), high-risk on Windows.

## Auth Model

Codex authenticates via OAuth against Dave's ChatGPT subscription (Plus/Pro). Quota usage counts against that subscription, not against an OpenAI API key. There is no separate API billing - if `codex auth status` shows a logged-in ChatGPT account, every adversarial-review call is on the subscription.

**Verified 2026-06-01:** with `codex-cli 0.131.0` and `codex login status` reporting "Logged in using ChatGPT", a smoke test of `codex exec --sandbox read-only --model gpt-5.5 -c model_reasoning_effort=xhigh` returned model output at exit 0. `exec` is authorized by the ChatGPT subscription **alone — no `OPENAI_API_KEY` is needed** (for the single-model path the adversary uses). The `no-API-key` finding holds. **Correction (2026-06-01):** an earlier version of this note dismissed the broken run's `o3`/`gpt-4.1`/`gpt-4o` model errors as "hallucinated noise after the binary hung." That was WRONG — those errors are REAL: Codex's multi-agent feature spawns built-in sub-agents that request `gpt-4.1`/`o3`, which a ChatGPT subscription rejects. See "Multi-agent / gpt-4.1" below. The lesson stands but inverts: do not dismiss a broken run's model errors as hallucination without verifying — here they pointed at a genuine feature bug.

## Startup Noise (cosmetic, not a failure)

A healthy `codex exec` on this machine still streams a large block of non-fatal startup noise to stderr/stdout *before* the real answer (which appears after the `codex` sentinel line). Treat all of the following as environmental, NOT as review findings or auth failures:
- ~150 `failed to load skill ... invalid YAML` lines — Codex scans `~/.agents/skills/` and `<project>/.agents/skills/` (the gitignored next-skills mirror + `_snapshots/`) with its stricter `SkillFrontmatter` schema and rejects Claude-format skills.
- MCP connection errors (Linear/Neon expired OAuth tokens; Paper `127.0.0.1:29979` not running) from `~/.codex/config.toml`.
- `[features].collab is deprecated. Use [features].multi_agent instead.`
- Many `hook: SessionStart/UserPromptSubmit Failed` lines from `~/.codex/hooks.json`.

The codex-adversary agent now captures the model's final answer via `codex exec -o <file>` and parses findings from that **clean** file (fix applied 2026-06-01), so this preamble no longer pollutes findings. The noise is therefore a cosmetic + latency tax only. Empirically (2026-06-01) it is NOT config-driven: `--ignore-user-config` still left ~106/125 noise lines, so the sources are hardcoded `.agents/skills/` scanning (a **673-file** mirror of the Claude skill library — `_snapshots/`/`archive/`/`.bak` dirs included), the separate `~/.codex/hooks.json`, and MCP connection attempts. The lone `config.toml` deprecation (`collab` -> `multi_agent`) is fixed. Cutting the remaining LATENCY would mean pruning/scoping `~/.agents/skills/` — but that is deletion of an unknown-provenance mirror, so check what regenerates it first and confirm before removing. Not needed for correct findings.

## Multi-agent / gpt-4.1 (the adversary disables it)

**The bug (root-caused 2026-06-01).** With `[features].multi_agent = true` in `~/.codex/config.toml`, a COMPLEX `codex exec` (e.g. reviewing a ~1900-line diff) makes Codex spawn its built-in `explorer`/`worker` sub-agents. A Codex role-config bug — `apply_role_to_config` drops the caller's runtime model for built-in roles that lack an explicit model (openai/codex #15170, #16893, #20077) — makes those roles fall back to **`gpt-4.1`**, which a ChatGPT subscription does NOT support:
`400 invalid_request_error: "The 'gpt-4.1' model is not supported when using Codex with a ChatGPT account."`
The whole review then fails. SMALL diffs don't spawn sub-agents, so they succeed on the main `gpt-5.5` model — which is why a single-file review worked but a large one didn't. There is NO config key for a default sub-agent model (openai/codex #19482); `-c features.multi_agent.model=...`, `[agents].default_model`, and an env var all do NOT exist (oracle-researched, sourced).

**The adversary fix.** The `codex exec` invocation in `codex-adversary.md` passes **`--disable multi_agent`** (equivalent to `-c features.multi_agent=false`). Adversarial review is single-shot; its cross-model value comes from the different model FAMILY (gpt-5.5 vs Claude), NOT from Codex's internal fan-out. Disabling it avoids the crash, removes the slow fan-out (a trivial multi-agent probe ran >165s without finishing), and loses no review quality. Verified 2026-06-01: a `--disable multi_agent` adversarial pass over the WS-2 Phase A diff produced 3 genuine findings — including a path-traversal bug the Claude-family reviewers had explicitly cleared (the textbook cross-model lift).

**Interactive multi-agent is kept intact.** `multi_agent = true` stays enabled globally for interactive Codex. A populated `~/.codex/agents/explorer.toml` with `model = "gpt-5.5"` mitigates the role-model-drop for the `explorer` role — verified 2026-06-01: the explorer then spawns and runs WITHOUT the gpt-4.1 rejection (the trigger is the empty built-in `explorer.toml`, per #16893). Named custom agents in `~/.codex/agents/*.toml` can likewise pin `model = "gpt-5.5"`. Caveat: openai/codex #19399 reports subagent TOML can be ignored on Windows; re-verify with a probe ("spawn an explorer subagent and have it report its exact model") if interactive multi-agent misbehaves. Supported ChatGPT-subscription models for Codex exec (live-probed 2026-07-11 on codex-cli 0.144.1): gpt-5.6-sol (flagship), gpt-5.6-terra, gpt-5.6-luna, gpt-5.5, gpt-5.4, gpt-5.4-mini. gpt-4.1 is API-key-only. (An earlier version of this line claimed `gpt-5.3-codex` was supported — WRONG: every `-codex`-suffixed id probed on this account 400s; see codex-worker-safety.md "Model allowlist".)

## Cost Awareness

Each `codex-adversary` invocation:
- Spends one Codex turn at gpt-5.5 (default) or whatever `CODEX_ADVERSARY_MODEL` resolves to, at xhigh reasoning
- Latency: typically 30-90 seconds for code review, 45-120 seconds for plan review
- xhigh reasoning is the expensive setting - we picked it because adversarial review needs depth

A typical `/review` run with codex enabled = 1 Codex call. A typical `/premortem` with codex enabled = 1 Codex call. The auto-prompt hook only OFFERS premortem - doesn't auto-run it.

## Synthesis Convention

When `review-agent` synthesizes Phase 1 findings, codex-adversary output is treated as a **distinct cross-model input source**, NOT pooled with critic's findings. Prefix Codex findings with `[Codex]` in synthesis output so cross-model agreement is visible at a glance.

Findings that BOTH critic and codex-adversary flag are high-confidence - the cross-model lift is exactly the findings only one side catches.

## Telemetry: codex-lift.jsonl

Every `/review` and `/premortem` run that includes Codex appends one row to `.claude/logs/codex-lift.jsonl` with: `claude_only`, `codex_only`, `both` counts plus `skill`, `scope`, `ts`, `via`. Schema and query patterns documented in `.claude/logs/codex-lift.README.md`. The `codex_only` count IS the cross-model lift — if it's consistently zero, the Codex pass isn't earning its quota cost and should be reconsidered.

## Integration Files

| File | Role |
|------|------|
| `.claude/agents/codex-adversary.md` | Agent definition - calls `codex exec` |
| `.claude/skills/review/SKILL.md` | Spawns codex-adversary in Phase 1 |
| `.claude/skills/premortem/SKILL.md` | Spawns codex-adversary --mode=plan |
| `.claude/hooks/src/plan-exit-premortem-prompt.ts` | Auto-prompts user to run /premortem after ExitPlanMode |
| `~/.claude/plugins/cache/.../codex-plugin-cc/.../prompts/adversarial-review.md` | Upstream adversarial system prompt (referenced by codex-adversary agent) |
