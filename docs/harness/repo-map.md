# Repository map

[Back to the README](../../README.md) · [All harness pages](README.md)

*Moved from the README on 2026-10-26. The text moved word for word. Edits made while PR 168 was reviewed fix facts that were stale or wrong, and lines that start with "Status on 2026-10-26" are dated notes.*

| Path | What it holds |
|---|---|
| `.claude/hooks/` | Hook sources (`src/`), bundles (`dist/`), tests (`src/__tests__/`) |
| `.claude/rules-src/` | Path-scoped rules and the always-loaded index of on-demand rules |
| `.claude/rules-ondemand/` | 20 tool rules and the `manifest.json` that routes them |
| `.claude/templates/` | The core `CLAUDE.md` template and other install templates |
| `.claude/agents/` | 34 subagent definitions as `.md`, plus 16 `.json` sidecars |
| `.claude/skills/` | 80 skills, each in its own folder with a `SKILL.md` |
| `.claude/settings.json.template` | The hook registration template. The rendered `settings.json` is untracked. |
| `opc/` | Python: the setup wizard (`opc/scripts/setup/`), memory scripts (`opc/scripts/core/`) and their tests |
| `scripts/` | Gates, probes, sync, coordination, self-improvement and scheduled jobs |
| `machine/` | The personal machine profile. Settings render from it and the settings template. |
| `.github/workflows/`, `.githooks/` | CI checks (gitleaks, no-work-user) and the commit hooks |
| `docker/` | PostgreSQL + pgvector compose file and schema |
| `apps/agentic-os/` | Next.js dashboard over session and lane data |
| `docs/` | Architecture notes, harness strategy, research and self-improvement proposals |
| `tests/workflow-tests/` | Checks for new workflows, skills and integrations |
| `e2e/` | A Playwright placeholder. It does not test this repo. |
| `ai-report-card/`, `proofs/`, `tasks/` | A weekly report generator, Lean proofs for the optional math tools, and the task lists |

Start with these files: `CLAUDE.md` (repo rules), `docs/testing-standard.md` (testing), `AGENTS.md` (the T3 Code advisory charter), `CONTEXT.md` (the
glossary) and `BOOTSTRAP.md` (full setup). `.coderabbit.yaml` configures the label-gated
CodeRabbit review.
