---
name: cli-integration
description: How to give Claude Code access to a new platform, tool, or application — the six-option priority order (native CLI, OpenCLI adapter, MCP, generated wrapper, thin REST wrapper, browser automation), the agent-compatibility checklist for scoring a candidate CLI, the current integration inventory, and the step-by-step checklist for wiring a new tool in. Use when adding or evaluating a tool integration, choosing between a CLI and an MCP server for the same platform, asking "how do I give Claude access to X", scoring whether a CLI is agent-friendly, or checking whether a platform is already integrated. Triggers on cli integration, integrate a platform, add a new cli, agent compatibility checklist, cli vs mcp, opencli adapter, new tool access.
metadata:
  version: "1.0.0"
  authored: "2026-07-29 (context lever phase 2)"
  companions: ".claude/rules/cli-integration-strategy.md"
---

# CLI Integration Strategy

The always-on rule (`rules/cli-integration-strategy.md`) carries only the priority order — the
one thing that must be true unprompted, because it shapes a choice an agent otherwise makes on
instinct (usually by reaching for browser automation when a CLI already exists).

Everything else is consulted deliberately, at the moment you are actually integrating something,
and lives below:

- **The full six-option decision tree** with the example platforms for each tier.
- **The current inventory** — which tools are integrated, under which pattern, with the
  per-tool caveats that matter when you compare a new candidate against them.
- **Known gaps** — what is integrated, when, with what auth and what load-bearing caveats
  (Codex, Grok, ntn, Kusto all carry traps that cost time if rediscovered).
- **The agent-compatibility checklist** — ten criteria for scoring a candidate CLI before
  committing to it, from "Building CLIs for agents" by @ericzakariasson.
- **The integration checklist** — the seven steps for wiring a new tool in.

## Two standing caveats about the tables below

**The inventory and gaps tables rot.** They are hand-maintained prose, and this harness has
already been bitten once by a hardcoded table drifting behind reality (the port table in
`dev-server-cleanup.md`, which went eight projects stale before anyone noticed). Treat a row as
a starting point, then verify against the thing itself — `<tool> --version`, the skill file, the
rule file — before relying on it. Step 6 of the integration checklist exists to keep this honest.

**CLI is usually better than MCP for scripted or batch work** (roughly 32x fewer tokens), even
when the vendor ships an MCP server. Prefer MCP where it is the only transport, where auth is
interactive, or where the operation genuinely has no CLI equivalent.

---

<!-- archived-rule:cli-integration-strategy.md -->
## Reference: pre-split text of `rules/cli-integration-strategy.md` (archived 2026-07-29)

Verbatim snapshot of the rule as it stood before the split, so nothing that was trimmed out of
the always-on budget is lost. This is the content the bullets above point at:

````markdown
# CLI Integration Strategy

## Decision Tree: How to Give Claude Code Access to a New Platform

When a new platform or application needs agent access, follow this priority order:

### 1. Native CLI exists? (gh, vercel, railway, neonctl, docker)
Install it, create skill + rule, use **Pattern 1** (Direct Bash + Skill + Rule).
This is the gold standard — maintained by the vendor, structured output, battle-tested.

### 2. Web platform with browser login? (Twitter, Reddit, HN, LinkedIn)
Use **OpenCLI** adapter (existing or generate new with `opencli generate`).
Zero API keys — reuses Chrome session cookies via browser bridge.

### 3. Accessible via MCP? (Notion, Playwright, Paper, Neon)
Use **MCP integration**. Best when the tool vendor ships an MCP server.
Note: CLI is often better than MCP for scripted/batch operations (32x fewer tokens).

### 4. Desktop software with source code? (GIMP, Blender, LibreOffice)
Use **CLI-Anything** plugin to auto-generate a Python Click CLI wrapper.
Install: `/plugin marketplace add HKUDS/CLI-Anything`
Review generated code for security before deploying.

### 5. Has a REST API but no CLI? (internal services, custom platforms)
Write a **thin CLI wrapper script** (like `scripts/cdp.mjs`).
Pattern: single file, JSON output to stdout, subcommand interface.

### 6. None of the above?
Use **browser automation** (Playwright MCP) as last resort.
Highest friction, lowest reliability — only for truly GUI-only workflows.

## Current CLI Inventory (24 tools)

| Pattern | Tools |
|---------|-------|
| Direct Bash + Skill + Rule | tldr, opencli, gh, vercel, railway, neonctl, qlty, git, playwright, playwright-cli, cdp.mjs, linearis, sentry-cli, kusto-cli\*, codex, grok, ntn (Notion) |
| Python harness via uv run | ast-grep, morph, braintrust, github-search |
| MCP server | Playwright MCP, Notion, Paper, Exa, Neon, Vercel Cloud, Linear, Sentry |
| Claude Code plugin | codex-plugin-cc (slash commands `/codex:*`) |
| Agent delegation | deployer (Vercel + Railway + Sentry + Linear), arbiter/atlas (tests), codex-adversary (cross-model review via Codex CLI) |

\* `kusto-cli` is Pattern 1 with notable agent-friendliness gaps — REPL-first (needs `-keepRunning:false`), positional connection string, no native JSON output (CSV via `#save` only). Score it low on the Agent Compatibility Checklist when comparing to gold-standard tools like `gh` or `vercel`.

## Known Gaps

| Platform | Status | Priority |
|----------|--------|----------|
| Railway CLI | INTEGRATED — skill + rule + deployer agent (2026-03-23) | DONE |
| neonctl | INTEGRATED — skill + databases cross-ref (2026-03-23) | DONE |
| Linear | INTEGRATED — MCP (remote) + linearis CLI + linear-cli + skill + rule + deployer (2026-03-25) | DONE |
| Sentry | INTEGRATED — MCP (remote) + sentry-cli + skill + rule + deployer + 3 hooks (2026-03-25) | DONE |
| Kusto.Cli (ADX / Fabric Eventhouse) | INTEGRATED — Microsoft.Azure.Kusto.Tools v14.1.2 net472 staged at `C:\tools\kusto-cli\`; skill + safety rule + databases cross-ref (2026-05-04) | DONE |
| Codex (OpenAI) | INTEGRATED — `codex-cli 0.144.1` (upgraded from 0.131.0 + re-verified 2026-07-11; gpt-5.6-sol/terra/luna enabled) + `codex-plugin-cc` plugin + `codex-adversary` agent + `codex-adversarial` rule + `/review` and `/premortem` skill wiring + `plan-exit-premortem-prompt` hook (2026-05-18; CLI 0.104.0 -> 0.131.0, end-to-end verified 2026-06-01). ChatGPT subscription auth via `codex login` — verified `codex exec` runs on the subscription with no `OPENAI_API_KEY`. Used for cross-model adversarial review. | DONE |
| Notion CLI (ntn) | INTEGRATED — `winget install Notion.ntn` v0.18.1 + skill + safety rule (2026-07-03). Scores near-gold on the checklist: non-interactive ✓ (--yes/--json/env), per-subcommand --help ✓, JSON output ✓, flag-based ✓ (one trap: inline field values containing `:` misparse — use stdin JSON), fail-fast ✓, `--spec` OpenAPI introspection ✓. Caveats: stdin must be redirected from NUL in automation (open stdin hangs); `v1/users` 403s on personal tokens (probe with `ntn doctor`). Spike evidence: docs/notion-platform-spike-report.md. Workers runtime PARKED (no account access yet). | DONE |
| Grok (xAI) | INTEGRATED — `grok-cli 0.2.93` + `/grok` skill + `grok-worker` agent + `grok-adversary` agent + `grok-worker-safety` rule (2026-07-11). X Premium+ subscription auth via OAuth (auth.x.ai, oidc) — no API key. Third cross-model training family (distinct from Claude and GPT-5.5/Codex) for task execution + adversarial review. **Caveats (load-bearing, not just notes):** `--tools "read_file,list_dir,grep"` is the ONLY working read-only guard — `--sandbox` is decorative/unvalidated (accepts any string, blocks nothing) and `--permission-mode plan` does not block writes headless either; `-w/--worktree` is silently IGNORED in headless `-p` mode, so implement mode reuses the codex-worker hand-rolled out-of-repo worktree recipe (`.grok-worktrees/`). CLI auto-updates — re-verify via `/harness-update` on version change. | DONE |
| CLI-Anything | Not installed — for future desktop software control | LOW |

## Agent Compatibility Checklist

When evaluating a new CLI for CCv3 integration, score it against these criteria:

| Criteria | Required | Nice-to-have |
|----------|----------|-------------|
| Non-interactive mode | REQUIRED | — |
| Per-subcommand --help | REQUIRED | With examples |
| JSON/structured output | REQUIRED | Default JSON preferred |
| Flag-based inputs (no positional-only) | REQUIRED | stdin support |
| Fail-fast on missing args | REQUIRED | With correct invocation shown |
| Idempotent commands | — | Document which commands are safe to retry |
| --dry-run for destructive ops | — | Compensate with safety rules if missing |
| --yes/--force for confirmations | — | Compensate with safety rules if missing |
| Predictable resource+verb structure | REQUIRED | Matches existing patterns |
| Structured success output (IDs, URLs) | REQUIRED | Not just "Success!" |

Source: "Building CLIs for agents" by @ericzakariasson

## Integration Checklist (when adding a new CLI)

1. Install the CLI globally (`npm i -g` or `pip install`)
2. Verify it works: `<tool> --version` or `<tool> --help`
3. Score against Agent Compatibility Checklist above
4. Create skill at `.claude/skills/<tool-name>/SKILL.md`
5. Create rule if safety gates needed (deploy, delete, etc.)
6. Update this inventory table
7. Sync to `~/.claude/`: `bash scripts/sync-to-active.sh`
````
