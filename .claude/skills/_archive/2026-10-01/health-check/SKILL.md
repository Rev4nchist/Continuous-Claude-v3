---
name: health-check
description: Run the CCv3 system health check across infra, hooks, memory, skills, and more. Use when the user types /health-check, says "health check", "system check", "run diagnostics", or asks if everything is working.
---

# Health Check

Run the CCv3 comprehensive health check. Behaviour-exercising, not existence-checking -- every check runs the actual code path a user depends on.

## What it covers

13 categories, ~35-50 checks:

| Category | Example checks |
|---|---|
| infrastructure | docker daemon, postgres container, env vars, opc/.env |
| hooks | dist freshness, settings.json registrations, node load test, vitest suite |
| memory | DB ping, end-to-end canary round-trip (store -> recall -> verify -> delete), growth rate, duplicates, stale entries |
| skills | frontmatter validation, description quality, broken references |
| agents | YAML parse, no-haiku rule, required fields |
| rlm | import smoke, pytest subset |
| cli | version checks for claude, docker, uv, gh, vercel, railway, neonctl, qlty, sentry-cli, linearis, tldr, etc. |
| tests | opc pytest smoke |
| sync | drift between continuous-claude/.claude and ~/.claude |
| external | Anthropic Developer API 1-token ping, claude CLI responsiveness |
| knowledge-tree | presence, freshness, valid JSON |
| git | uncommitted changes, remote sync |
| roadmap | ROADMAP.md present and non-empty |

## Headline check: memory canary round-trip

The single most load-bearing assertion. Stores a unique canary learning, re-recalls it, confirms it shows up as top result, checks the embedding is 1024-dim, deletes it, and re-verifies deletion. If recall is silently degraded, this is the check that catches it.

## Running it

Default (full run, ~2-3 minutes end to end):

```bash
cd $CLAUDE_OPC_DIR && PYTHONPATH=. uv run python scripts/health_check.py
```

Fast subset (skip slow checks -- tests, vitest, canary round-trip, API pings):

```bash
cd $CLAUDE_OPC_DIR && PYTHONPATH=. uv run python scripts/health_check.py --skip-slow
```

Scoped to a single category (great for iteration):

```bash
cd $CLAUDE_OPC_DIR && PYTHONPATH=. uv run python scripts/health_check.py --categories memory
cd $CLAUDE_OPC_DIR && PYTHONPATH=. uv run python scripts/health_check.py --categories hooks,agents
```

Quiet mode (suppress stdout -- artifacts still written):

```bash
cd $CLAUDE_OPC_DIR && PYTHONPATH=. uv run python scripts/health_check.py --quiet
```

## Exit codes

| Exit | Meaning |
|---|---|
| 0 | all PASS |
| 1 | at least one WARN, nothing failed |
| 2 | any HIGH-severity FAIL |
| 3 | any CRITICAL FAIL |

## Output artifacts

All writes live under `.claude/cache/health-checks/`:

- `health_YYYYMMDD_HHMMSS.md` -- human-readable report
- `health_YYYYMMDD_HHMMSS.json` -- structured results
- `history.jsonl` -- one line per run for trend tracking

The Markdown report groups issues by severity, has a per-category pass/warn/fail table, and shows every individual check with its evidence string.

## Notion dashboard (weekly mirror)

Every scheduled run also mirrors results onto a Notion page so trends, WARN breakdown, and suggested actions live outside the repo where they can be reviewed casually and discussed.

- **Page:** [CCv3 Weekly Health Checks](https://www.notion.so/innovativemusings/CCv3-Weekly-Health-Checks-34c76fd7ac8280a984afc486a9844290) (id `34c76fd7-ac82-80a9-84af-c486a9844290`)
- **Sections auto-refreshed every run:** Current Status, Critical Path, Run Log (new row appended), WARN Breakdown, Your Suggested Actions
- **Sections preserved across runs:** Improvement Ideas (brainstorm), Automation (this section's doc)
- **Mechanism:** `scripts/scheduled-health-check.bat` pipes `scripts/notion-health-prompt.md` into `claude -p` after the Python run finishes. The prompt is deterministic: same page ID, same sections, same guardrails. If the Notion MCP is unavailable the step prints `notion-health-update: SKIP` and the scheduled task still reports correct exit status based on the Python run.
- **Fallback:** raw JSON/MD artifacts on disk are always authoritative. Notion is a projection, not the source of truth.

To test the Notion update manually without waiting for Friday:

```bash
type scripts\notion-health-prompt.md | claude -p --output-format text
```

(run from `C:\Users\david.hayes\continuous-claude`)

## When to run it

- Friday 8am scheduled audit (the primary use case)
- Before a major merge -- scope to the categories you touched
- When something feels off and you want an objective baseline
- Right after cross-machine sync or a fresh bootstrap

## When findings land

Work top-down by severity:

1. **CRITICAL** -- block everything, fix first (memory round-trip fail, docker down, hook load error)
2. **HIGH** -- current session should address (test failures, registered-but-missing hooks)
3. **MEDIUM** -- worth a ticket (agents missing fields, skill references broken)
4. **LOW** -- nice-to-have (CLI tools uninstalled, stale low-confidence entries)

Each FAIL/WARN carries a `remediation:` string with the exact next command.

## Examples

```
/health-check
```
-> full run, print summary, write artifacts.

```
/health-check memory
```
-> only memory category (connection, canary, growth, duplicates, staleness).

```
/health-check --skip-slow
```
-> infrastructure + static checks only, ~10 seconds.

## Implementation

See `opc/scripts/health_check.py` and `opc/tests/test_health_check.py`.
