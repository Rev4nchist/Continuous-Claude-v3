# Proposal: load instructions by trigger, not by default

Date: 2026-09-24 · Author: Claude Code (claude-opus-5-5) · Verdict: **ADOPT, phased**

## The problem

Every session and every subagent starts with 42 always-loaded instruction files: 153,689 characters,
over Claude Code's 150,000-character limit. CLAUDE.md (18.9k), RULES.md (13.3k), the @-imported
architecture INDEX (4.6k) and 39 rules (116.9k). Most of it is about one tool, one repo or one
situation, and it sits in context whether or not that situation ever happens. Anthropic's own guidance:
"Bloated CLAUDE.md files cause Claude to ignore your actual instructions"
(https://code.claude.com/docs/en/best-practices.md#write-an-effective-claudemd).

Our ratchet did not catch it: `rules-budget-guard.mjs` counts only `.claude/rules-src` bytes (127.7k,
passing) and never counts CLAUDE.md, RULES.md or imports.

## What the evidence says about delivery channels

| Channel | How it reaches the model | Evidence (this machine, this week) | Reliability |
|---|---|---|---|
| **Enforcement hook** (PreToolUse deny/ask + reason) | Blocks the action; the reason explains the rule; the model re-plans | The destructive guard stopped a blind `git restore` and a `worktree remove --force` on 2026-09-24; both re-planned correctly | Highest: cannot be forgotten |
| **Action-triggered injection** (PreToolUse `additionalContext`) | Arrives before the tool runs, only when that tool/command is used | Documented as pre-execution (hooks docs); knowledge-tree context arrived before every Agent call; the PR-opened hook fired on 5 of 5 PR creations | High, precise (triggers on a real action) |
| **Path-scoped rule** (`paths:` frontmatter) | Loads when matching files are in play | The size warning counted 42 files, not 46: the 4 `paths:` rules are excluded from the always-on budget | High for file-type conventions |
| **Skill** | Description always listed; body loads on trigger | Routing ratchet exists; skill-router hook retired because native routing matched it | Good for procedures and reference |
| **Always-loaded core** (CLAUDE.md, RULES.md, rules without `paths:`) | Every turn, every subagent | Over the limit; long files dilute what matters | Good only while small |
| **Keyword prompt hook** (UserPromptSubmit on words) | Guesses from prompt text | ~9 false fires in this one session: the debugging guardrail on 3 cron prompts, the database guardrail on a pasted Donna reply, code-review on a cron prompt, Maestro at 75-100% on status messages | Low: noisy, trains the model to ignore it |

**Principle: trigger on actions, not on words.** Keep always-loaded text for what shapes every
reply. Enforce must-never rules with a hook. Inject how-to rules at the moment of the action. Put
file conventions behind `paths:`. Put procedures in skills.

## Target shape

| Tier | Content | Budget |
|---|---|---|
| 0 Core (always) | Who Dave is, how we work, STE writing, Next-steps block, verification and testing standard, git remote invariants, one-line safety invariants, and a **router**: one line per on-demand rule saying "when X, the Y rule is injected / the Z skill applies" | ≤ 40k chars (from 153.7k) |
| 1 Enforce | Hooks that deny/ask with the rule in the reason | as today, plus the ones below |
| 2 Inject at action | One `rule-router` hook, PreToolUse + PostToolUse, driven by a manifest: `{ rule, tools, command regex, once-per-session }`. Injects the rule text the first time it applies in a session | 0 chars until used |
| 3 Path-scoped | `paths:` rules for file conventions | 0 chars until used |
| 4 Skills | procedures, references, histories | description only |
| 5 Docs | forensic history (MSYS, incidents) | 0 |

## Where each current rule goes

| Rule (chars) | Channel | Trigger |
|---|---|---|
| codex-worker-safety (12.1k), codex-adversarial (4.6k), harness-update (2.8k) | 2 + enforce existing gates | Bash/PowerShell `codex `; Agent `codex-*`; `/harness-update` |
| grok-worker-safety (1.7k) | 2 | `grok ` |
| cma-safety (3.0k) | 2 + ask on billable calls | `ant `, api.anthropic.com `/v1/(agents\|sessions\|deployments)` |
| notion-cli-safety (4.1k), railway (1.4k), neonctl (0.8k), kusto (0.8k), sentry (0.5k), linear (0.4k) | 2 | the CLI name at a command position |
| git-merge-workflow (6.2k) | 2 | `gh api .../merge`, `git merge`, `land-pr.ps1` |
| pr-and-commit-style (2.1k) | 2 | `git commit`, `git-safe.ps1 ... commit`, `gh pr create`, `pulls -X POST` |
| pr-coderabbit-loop (3.0k) | 2 (the existing PR-opened hook already injects; move the text into it) | PR created |
| cross-terminal-db (2.8k) | 2 | `psql`, `docker exec ...postgres` |
| headless-claude-mcp (2.0k) | 2 + 3 | `claude -p`; `paths: **/*.bat` |
| browser-automation (1.7k) | 2 + enforce | any `mcp__claude-in-chrome__*` (deny, deprecated) or Playwright tool |
| opencli-first (1.2k) | 2 | WebFetch / WebSearch |
| agent-model-selection (3.0k), no-haiku (0.4k), use-scout-not-explore (0.8k) | 1 (hooks exist) + one core line | Agent spawn |
| destructive-commands (4.2k), package-install-safety (1.7k) | 1 (hooks exist) + one core line each | — |
| proactive-memory-disclosure (1.4k) | the memory hook's own injected text | MEMORY MATCH |
| claim-verification (1.8k) | core, one paragraph (the epistemic hook already injects after Grep) | — |
| every-surface-checklist (2.8k), git-sync-workflow (4.5k), sync-known-gaps (3.7k) | 3 | `paths:` `.claude/**`, `scripts/**`, `**/settings.json` |
| design-work (6.0k) | 3 + skills | `paths:` `**/*.{tsx,jsx,html,css}`; routing lives in skill descriptions |
| windows-platform (15.6k) | core 1.5k (python not python3, `bash` is WSL, git-safe for commits, PowerShell when Bash hangs) + 1 (`.claude.json` edit → deny with the Node recipe) + 5 (MSYS history → `docs/windows/`) | — |
| proactive-delegation (6.9k) | core 1k (when to delegate) + 2 (spawn details at Agent) | Agent spawn |
| terminal-command-format (2.6k), paste-ready-deliverables (1.7k) | core, merged to ~0.8k (they shape replies) | — |
| cli-integration-strategy (2.1k), project-registry (1.2k), new-machine-setup (1.0k), tldr-cli (1.3k), memory-rules (0.9k), hook-auto-execute (1.9k) | 4 (skills exist) + router line | — |
| CLAUDE.md (18.9k) + RULES.md (13.3k) | merged, de-duplicated core (~15k) | — |
| INDEX.md import (4.6k) | 5: drop the `@` import; router line points at it | — |

Estimated core after all phases: ~30-35k chars (about 8-9k tokens), from 153.7k, in every session
and every subagent.

## Risks and how the design handles them

- **Injection arrives after the decision.** A PreToolUse injection lands when the command is already
  chosen. For rules that must change the decision (confirm before a Codex write run, billable CMA
  calls), the hook returns **ask/deny with the rule as the reason**, so the model re-plans with the rule
  in view. Pure how-to guidance can be plain `additionalContext`.
- **Rules with no action to hang on** (tone, delegation judgment, when to ask Dave) stay in the core.
- **The model must know on-demand rules exist.** The core router lists each one in one line.
- **Hooks fail open and add latency.** One router hook with a manifest, not one hook per rule; a
  per-session dedupe file so each rule injects once; fail-open like every hook here.
- **Undocumented edges** (exact `paths:` load timing; whether subagents get injections): each gets
  a probe before we rely on it (E2E per the new testing policy), e.g. a headless `claude -p` run that
  asks the model to quote the injected rule.

## Measure it (evals, not vibes)

- Always-loaded chars, counted the way Claude Code counts them, ratcheted at 40k.
- Router precision: every injection logged with its trigger; audit a week of logs for false fires
  (the keyword guardrails fail this test today).
- Behaviour: the failure-audit correction rate on the rules that moved (e.g. merge-workflow mistakes
  before vs after), plus one headless probe per moved rule showing the injected text is used.

## Phases

1. **Measure + guard:** replace the bytes ratchet with a chars ratchet over the real always-loaded set;
   retire the keyword guardrail and Maestro prompt hooks (evidence above). Gets under 150k by dropping
   the INDEX import and moving MSYS history to docs.
2. **Router hook + the tool families** (Codex, Grok, CMA, the CLIs, git merge, PR style, DB): ~45k out
   of always-loaded, each with a probe.
3. **Path-scope** the repo-only rules; move skill-shaped rules into their skills.
4. **Rewrite the core:** merge CLAUDE.md and RULES.md into one de-duplicated core with the router.
   Dave reviews the live file before it replaces his.

Each phase is one PR, verified by the ratchet and the probes before the next starts.
