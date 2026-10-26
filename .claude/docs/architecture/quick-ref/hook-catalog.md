# Hook Catalog

Current registrations live in `~/.claude/settings.json`. For totals and per-event breakdown, see [hook-audit-2026-04.md](../../hook-audit-2026-04.md).

> **Step-10 prune (2026-08-31):** 31 unregistered, zero-telemetry hook sources
> were archived to `.claude/hooks/archive/2026-08-31-step10-prune/` (approved
> by Dave; qualification in `docs/harness-strategy/README.md` step table).
> Any hook named in this catalog that no longer exists in `src/` is there.
> `tldr-context-inject` and `skill-activation-prompt` are deregistered
> everywhere, including the settings template.

> **Braintrust retired (2026-09-30):** All `braintrust_hooks` registrations
> (SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd) and the
> score emitters are removed. RETIRED 2026-09-30 (see
> `archive/braintrust-2026-10/`).

## SessionStart

| Hook | Description |
|------|-------------|
| session-start-docker | Ensure Docker services are running |
| session-register | Register session in PostgreSQL for cross-terminal coordination |
| session-start-continuity | Load handoffs and prior session context |
| session-start-init-check | Auto-generate knowledge tree if missing |
| session-start-recovery | Recover from interrupted sessions |
| roadmap-reconcile | Sync ROADMAP.md with actual state on session start |
| hook-health-monitor | Verify hook registration health on startup |

## UserPromptSubmit

| Hook | Description |
|------|-------------|
| heartbeat | Session keepalive heartbeat to PostgreSQL |
| maestro-state-manager | Manage Maestro workflow phase state |
| ~~skill-activation-prompt~~ | ARCHIVED/DEREGISTERED 2026-08-31 (was: detect skill trigger keywords in user input) |
| memory-awareness | Inject relevant memories from semantic search |
| pageindex-navigator | Route to PageIndex for document queries (disabled 2026-06-01; on-demand only) |
| user-confirmation-detector | Detect user confirmations for gated operations |

## PreToolUse

| Hook | Matcher | Description |
|------|---------|-------------|
| pre-plan-memory | EnterPlanMode | Recall relevant memories before planning |
| agent-model-guard | Agent | Validate agent type and configuration |
| explore-to-scout | Agent | Redirect Explore agent to scout |
| no-haiku-enforcer | Agent | Block haiku model selection for agents |
| navigator-validate | Agent | Validate navigator agent configuration |
| task-router | Agent | Suggest better agent for task type |
| maestro-enforcer | Agent | Enforce Maestro phase gating (block skipping) |
| pre-tool-knowledge | Agent | Inject knowledge tree context for agents |
| ~~tldr-context-inject~~ | Agent | ARCHIVED/DEREGISTERED 2026-08-31 (was: inject TLDR analysis context for agents) |
| smart-search-router | Grep | Route to AST-grep or TLDR for structured searches |
| tldr-read-enforcer | Read | Suggest TLDR structure before reading large files |
| navigator-safety | Bash | Safety checks for bash commands |
| package-install-guard | Bash, PowerShell | Supply-chain check on every install segment (typosquat, blocklist, exact pip pin, OSV.dev, age); blocks malicious or unpinned installs |
| coderabbit-guard | NOT REGISTERED (live or template) until DW-80's vetted parser; target: Bash, PowerShell, Task, Skill, Agent | Blocks CodeRabbit billing/API keys, code workspace commands, autofix skill, skill installs, and a 3rd `cr review --agent` per repo+branch; allows read-only autofix delegate |
| file-claims | Edit\|Write | Distributed file locking across sessions |
| test-before-done | TaskUpdate | Require test evidence before marking task complete |
| rule-router | Bash\|PowerShell\|Agent\|Skill\|Neon/linear/sentry MCP | Load a tool-specific rule from `rules-ondemand/` at the first matching call; `deny-first` rules block once with the rule as the reason |

## PostToolUse

| Hook | Matcher | Description |
|------|---------|-------------|
| agent-error-capture | Agent | Capture and log agent errors |
| agent-verification | Agent | Verify agent output claims |
| epistemic-reminder | Grep\|Read | Warn about unverified grep/read claims |
| post-plan-roadmap | ExitPlanMode | Sync plan to ROADMAP.md after approval |
| plan-exit-premortem-prompt | ExitPlanMode | Offer /premortem (Grok cross-model pass when the user picks Grok) after plan approval |
| pr-opened-review-loop | Bash\|PowerShell | After a PR opens, point the model at pr-review-loop.md (pr_watch first on CCv3) |
| roadmap-completion | TaskUpdate\|Bash | Track roadmap task completions |
| git-commit-roadmap | Bash | Update ROADMAP.md after git commits |
| test-run-tracker | Bash | Track test execution results |
| smarter-everyday | Edit\|Write\|Bash\|TaskUpdate | Extract learnings from tool use patterns (L0) |
| prd-roadmap-sync | Write\|Edit | Sync PRD changes to ROADMAP.md |
| sync-to-repo | Write\|Edit | Auto-sync ~/.claude changes to continuous-claude repo |
| git-auto-commit | Write\|Edit | Auto-commit ~/.claude file changes |
| tree-invalidate | Write\|Edit | Mark knowledge tree stale after file changes |
| pageindex-watch | Write\|Edit | Update PageIndex after doc file changes |
| auto-build | Write\|Edit | Auto-rebuild hooks after source changes |
| import-validator | Edit\|Write | Validate import paths after code edits |
| periodic-extract | * | Periodic learning extraction (L0 timer) |
| telemetry-tracker | Skill\|Task | Track skill and task usage telemetry |
| mcp-activity-tracker | * | Track MCP server tool usage |
| vercel-deploy-context | Bash | Inject Vercel deployment context after deploy commands |
| post-edit-diagnostics | Edit\|Write | Run type check and lint after code edits |
| web-lookup-advisor | WebFetch\|WebSearch | Suggest Nia/context7 before web lookups |

## PreCompact

| Hook | Description |
|------|-------------|
| pre-compact-extract | Extract learnings before context compaction (L1) |
| pre-compact-continuity | Save continuity state before compaction |

## SessionEnd

| Hook | Description |
|------|-------------|
| maestro-cleanup | Clean up Maestro workflow state files |
| session-end-extract | Extract session learnings on close (L2) |
| session-outcome | Prompt for session outcome marking |

## Blocking Hooks

Only PreToolUse hooks can block tool execution via `permissionDecision: "deny"`.

Key blockers:
- **file-claims** -- prevents concurrent edits to same file across sessions
- **maestro-enforcer** -- blocks phase-skipping in Maestro workflows
- **no-haiku-enforcer** -- blocks haiku model selection for agents
- **test-before-done** -- blocks task completion without test evidence
- **package-install-guard** -- blocks malicious/typosquatted package installs
- **rule-router** -- blocks the first Grok call and the first CMA call and the first commit or PR create per session, once, with the rule text as the reason

## File Locations

```
~/.claude/hooks/
  src/              # TypeScript source
  dist/             # Compiled JS (esbuild output, .mjs)
  package.json      # Dependencies and build script
```

### Braintrust score emit hooks (RETIRED 2026-09-30)

RETIRED 2026-09-30 (see `archive/braintrust-2026-10/`). No hook emits
Braintrust scores. `judge_session.py` and the `CCv3-Judge-Batch` task are
archived or disabled with them.

## Registration

All hooks registered in `~/.claude/settings.json` under `hooks.<EventType>[]`.
Use Node.js atomic read-modify-write to update settings.json (never Edit tool).
