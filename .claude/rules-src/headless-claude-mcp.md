# Headless `claude -p` + claude.ai MCP Connectors

Root-caused 2026-07-16 (A/B-proven; this gap silently broke 3 reporting pipelines, one for 11 weeks).

## The two-condition contract [C:10]

Any scheduled/headless `claude -p` that must use a claude.ai connector (Notion, Slack, ...) needs **BOTH**, per process:

1. **`ANTHROPIC_API_KEY` cleared** (`set "ANTHROPIC_API_KEY="` in the wrapper) — any auth key in env disables claude.ai connectors entirely.
2. **An explicit `--allowedTools` grant** listing every MCP tool the run needs (e.g. `--allowedTools "mcp__claude_ai_Notion__notion-fetch,mcp__claude_ai_Notion__notion-update-page,Bash,Read"`). Non-interactive mode **auto-denies** any ungranted tool call with no prompt — the model then narrates a failure that pipelines historically misread as "mcp-unavailable → SKIP, exit 0".

Key-unset alone is NOT sufficient. The connector loading + OAuth session are reliable headless; the permission grant is the piece that was always missing.

## Wrapper conventions (all now enforced in the live wrappers)

- **Capture stdout/stderr** to a dated log (`~/.claude/logs/<pipeline>/<YYYY-MM-DD>.log`) — never discard `claude -p` output in a scheduled wrapper.
- **Never derive a registry OK from exit code alone** — exit 0 covers SKIP and silent no-ops. Verify artifact truth (see `scripts/fourthos-weekly/verify-run.mjs` as the reference classifier) or read back the write.
- **Distinguish permission-denied from mcp-unavailable** in guard prose — the former is a fixable FAILURE, never a benign SKIP.
- Prefer the **`ntn` CLI for deterministic Notion steps** (works headless unconditionally); reserve `claude -p` + MCP for steps needing LLM synthesis or MCP-only operations (embed bind, view creation).

## Reference implementations

`scripts/fourthos-weekly/scheduled-fourthos-weekly.bat` (grant + log + verify), `scripts/scheduled-health-check.bat` (grant + log), `scripts/project-cards/sweep.mjs` (per-child key-strip + scoped grant + retry-once — the pipeline that never had the bug).
