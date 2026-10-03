# Skills review, Phase 0: ground truth (2026-10-01)

Proposal: `docs/self-improvement/proposals/2026-10-01-skills-best-practices-eval.md`.
Data and scripts: `.claude/cache/skills-eval/phase0/` (gitignored). Workflow `wf_a3db9877-205`: 9 read-only
agents (1 docs diff, 8 batch reviewers), 146 of 146 skills reviewed, 0 missing, 0 agent errors.

## Headline

- Verdicts: 3 ok, 46 fix-minor, 42 fix-major, 12 merge, 43 archive candidates.
- Tiers: A 11 (used 3+ times in 60 days, or named in CLAUDE.md "Skills to load first", plus skill-forge),
  B 73 (any use, named by a harness file, or user-invoked), C 62 (no use, no harness reference).
- C splits into 35 archive candidates, 8 merges, 18 fixes and 1 ok.
- Conciseness (1-5): 46 skills score 1-2. Degrees of freedom: 96 right, 28 too rigid, 16 too loose.
- Stale content in 98 skills, the main themes:
  - Opus 4 or Sonnet 4 model ids (12);
  - Haiku (8);
  - claude-in-chrome (5);
  - the retired skill-rules.json routing (3);
  - Braintrust in `create_handoff`.
- Usage is thin: in 60 days of transcripts (1,743 files) the model loaded only about 15 distinct skills by itself.

## Tier A (the 11 skills Phase 3 evaluates with 3 evals x 3 models)

databases, systematic-debugging, create_handoff, fourth-brand-guidelines, mcp-guidance, notion-dashboard,
notion-bridge, personas, premortem, code-review, skill-forge. Five are fix-minor, six fix-major. Dave may add
skills by name (artifact-design and workflow-authoring are the top two by use but are bundled or plugin skills,
outside scope).

## Defects in our tooling (fix in Phases 1 and 2, before any skill edit)

1. `vet-skill` can never pass its Step 2: it calls `quick_validate.py --skill-path`, which takes one
   positional directory and exits 1 (vet-skill/SKILL.md:37, quick_validate.py:411).
2. `quick_validate.py` rejects every Claude Code key outside the 6 upload keys, so it fails all 18
   user-invoked skills (`disable-model-invocation`) and maestro and impeccable (quick_validate.py:26-28).
3. `trigger-probe.mjs` still spawns the retired skill-activation-prompt hook; that channel always scores 0.
   The native channel asks the model to self-report, which is not how routing works (trigger-probe.mjs:6,27,44-48).
4. `audit-descriptions.mjs` skips junction skill folders (archify, find-skills, vercel-cli, ...), so
   archify's 652-char description is never audited, and it still counts a dead `inRouter` column (:71-77).
5. `$<digit>` in skill bodies is replaced by Claude Code with an argument: cma ($0.08, $10) and
   memory-stats (awk $1 $2) break when called with arguments.
6. skill-forge's `run_eval.py` baseline keeps the real skill listed, so a "without skill" run can still
   pick it; the description optimizer spends API-key tokens.

## Conflicts between our conventions and the guide (26 found; the ones that change policy)

- Description convention "one line with Use when ..." becomes "Does X. Use when Y." in third person.
  16 skills start with "Use when" and never say what they do; 16 use first or second person.
- `allowed-tools` pre-approves tools for the turn; it does not restrict them. Our skill-authoring skills teach
  the opposite, and about 34 of 39 grants are bare `Bash` (the gate should require `Bash(pattern)`).
- 13 skills hide themselves with `metadata: user-invocable: false` and 6 pin `metadata.model`; Claude Code
  ignores `metadata`, so none of that works (3 pin the stale claude-opus-4-5-20251101).
- skill-forge: reference files need a contents section above 100 lines (we say 300); descriptions should be
  specific, not "slightly pushy"; no "When to Use" body section; 3 evals minimum with a no-skill baseline
  (`skillOverrides: off`) on Sonnet-high, Opus and Fable; scaffold into the repo, not `~/.claude/skills`.
- Name shadowing: local `debug`, `code-review`, `review` and `help` share names with bundled skills, the
  bundled /review alias, or the built-in /help. [Speculation] /review and /help may never reach ours.
- Listing budget: names always show; when the listing exceeds `skillListingBudgetFraction` of the context
  window, descriptions of the least-invoked skills are dropped first. After compaction only the first 5,000
  tokens of a skill are re-attached, so critical rules go at the top.

The docs agent also proposed 32 deterministic gate rules (G01-G32) for `audit-skills.mjs`, with ratchet
baselines. They are the Phase 1 spec: `phase0-results.json` -> `docs.gateRules`.

## Families to consolidate (mutual overlaps; 171 mutual pairs in total)

- memory: memory, recall, remember, recall-reasoning, memory-curate, memory-stats, supersede, extract-v2
- hooks: hooks, hook-developer, hook-scaffold, hook-audit, debug-hooks
- skill authoring: skill-forge, skill-developer, skill-development, skill-upgrader, vet-skill, find-skills
- planning and building: build, maestro, workflow-router, plan-agent, plan-mode, implement_plan,
  implement_plan_micro, implement_task, discovery-interview
- testing: test, tdd, qa-test, qa-suite, full-test-suite, tdd-migrate
- health: health-check, mot, post-ship-audit, sync-drift, stale-scan, hook-audit
- research and search: explore, research, research-external, repo-research-analyst, repoprompt,
  search-router, tldr-code, ast-grep-find, morph-search, exa-code-search, nia-docs, perplexity-search,
  firecrawl-scrape, github-search
- Fourth decks: fourth-presentation-suite, fourth-presentation-builder, fourth-brand-guidelines, frontend-slides
- handoffs: create_handoff, resume_handoff, continuity_ledger, notion-bridge
- deploy: vercel-cli, railway-cli, azure-deployment

## Other locations

- Codex mirror: 15 skills exist only there, mostly retired (braintrust-*, serena, ralph, claude-in-chrome,
  skill-creator, agentica-*). The mirror rewrites "Claude" to "Codex", so 117 copies differ by design.
- Active only: archify, workos, workos-widgets (reviewed), and `synced` (no SKILL.md; "synced" is a
  reserved name in Claude Code).
- Repo dirs with no SKILL.md: `archive`, `create-better-skills.bak`.

## Decisions for Dave

1. The 43 archive candidates (35 Tier C). Archive means move to `.claude/skills/_archive/`.
2. The 12 merges and the families above: consolidate now (Phase 4) or keep separate skills with sharper,
   non-overlapping descriptions.
3. `allowed-tools`: scope every grant to `Bash(<cli> *)` and similar, or keep bare grants.
4. Shadowed names (debug, code-review, review, help): rename ours or accept the shadowing.

## Per-skill table (Tier A first, then by verdict and use)

| Skill | Tier | Uses 60d | Harness refs | Verdict | Concise (1-5) | Freedom | First issue |
|---|---|---|---|---|---|---|---|
| code-review | A | 8 | 1 | fix-major | 2 | too-rigid | 'Integration with SuperClaude' section and persona alignment (SKILL.md:128-147). |
| create_handoff | A | 4 | 8 | fix-major | 2 | right | SKILL.v6.md:58 root_span_id/turn_span_id (Braintrust, retired 2026-09-30). |
| fourth-brand-guidelines | A | 4 | 1 | fix-major | 3 | right | Stray 5.6 MB `fourth-brand-guidelines.zip` in the skill folder duplicates the content. |
| mcp-guidance | A | 1 | 1 | fix-major | 1 | too-loose | claude-in-chrome (SKILL.md:87,158,201) |
| personas | A | 0 | 2 | fix-major | 2 | too-loose | SKILL.md:131-134 maps personas to /user:scan, /user:analyze, /user:improve, /user:build etc.; none exist in ~/.claude/commands. |
| skill-forge | A | 0 | 0 | fix-major | 3 | right | references/authoring-guide.md:215 and references/schemas.md:228 pin model claude-sonnet-4-20250514 and beta headers (time-sensitive). |
| systematic-debugging | A | 13 | 6 | fix-minor | 3 | right | Triggers "debug" and "fix this bug" collide with fix ('fix this', 'debug this') and debug ('debug this'); the description does not say it is the metho |
| premortem | A | 10 | 5 | fix-minor | 3 | right | SKILL.md:19-20, 224 offer --grok and Both; Grok is parked on this machine (flag only). |
| notion-dashboard | A | 8 | 0 | fix-minor | 4 | right | Imperative ('Build and refresh...'); otherwise clear with good user phrases. |
| databases | A | 6 | 4 | fix-minor | 2 | right | SuperClaude persona integration (L122-134) |
| notion-bridge | A | 4 | 2 | fix-minor | 4 | right | Grok listed as an active Bridge party (lines 20, 57-58, 76) while Grok is parked on this machine; flag, not wrong. |
| resume_handoff | B | 2 | 2 | fix-major | 2 | too-rigid | ENG-XXXX ticket route and the .md handoff filename format |
| codex | B | 1 | 12 | fix-major | 2 | right | Grok named as default builder while Grok is parked on this machine (flag only). |
| memory | B | 1 | 15 | fix-major | 2 | right | PROACTIVE_INJECTION_FLOOR and '--k 5' hook settings (lines 121-127). |
| vet-skill | B | 1 | 1 | fix-major | 3 | right | Registration into skill-rules.json as the routing table (SKILL.md:8, :135-178). |
| browser-dev-cycle | B | 0 | 3 | fix-major | 2 | too-loose | tool-comparison.md:3 'Status Overview (March 2026)' is time-sensitive. |
| build | B | 0 | 3 | fix-major | 2 | right | `Task(...)` tool name in references/modes.md (Agent tool is current). |
| cli-integration | B | 0 | 1 | fix-major | 2 | right | SKILL.md:85 lists Paper as an MCP server; paper-design is retired (MEMORY.md scroll-craft entry). |
| commit | B | 0 | 4 | fix-major | 3 | right | SKILL.v6.md (97 lines) is an orphan alternate version in the skill folder; SKILL.md never links it, and it repeats the same rules in MDP notation. |
| discovery-interview | B | 0 | 2 | fix-major | 3 | too-rigid | metadata.model claude-opus-4-5-20251101 (line 6), and model under metadata is probably inert [Speculation]. |
| explore | B | 0 | 2 | fix-major | 2 | too-rigid | 'Task tool' for agent spawn (references/depth-procedures.md:47, :66, :73) |
| fix | B | 0 | 3 | fix-major | 3 | too-rigid | allowed-tools lists `Task` (SKILL.md:4); the spawn tool is Agent. |
| fourth-presentation-suite | B | 0 | 1 | fix-major | 3 | right | 7 reference files over 100 lines lack a table of contents: html-engine/STYLE_PRESETS.md (570), references/brand-essentials.md (378), references/fourth |
| fourthos-weekly | B | 0 | 1 | fix-major | 2 | right | GitHub Pages publish and public decks repo (SKILL.md:282-283) superseded by OneDrive local publish (SKILL.md:101-105, 352-354). |
| grok | B | 0 | 6 | fix-major | 2 | right | Grok active-use guidance while Grok is parked (flag, not wrong) |
| hook-audit | B | 0 | 1 | fix-major | 3 | too-loose | references/audit-commands.md (288 lines) has no ToC. |
| hook-scaffold | B | 0 | 1 | fix-major | 3 | right | Shared-module table (hook-templates.md:493-510) omits outputDeny, the correct PreToolUse helper (shared/output.ts:97). |
| hooks | B | 0 | 25 | fix-major | 3 | too-loose | npx tsx shell-wrapper model; session-start-continuity.sh test example (SKILL.md:54). |
| landing-page-score | B | 0 | 1 | fix-major | 3 | too-loose | 'Unbounce 2024' and '2025 personalization data' (lines 306, 317) are time-sensitive benchmark labels. |
| memory-stats | B | 0 | 1 | fix-major | 3 | right | PROACTIVE_INJECTION_FLOOR and LOCAL_SCORE_NORMALIZE (gone from .claude/hooks/src/memory-awareness.ts). |
| plan-agent | B | 0 | 1 | fix-major | 2 | right | Hardcoded year 2025 (SKILL.md:6). |
| shadcn-create | B | 0 | 3 | fix-major | 1 | too-rigid | claude-in-chrome (deprecated; use @playwright/mcp). |
| sync-drift | B | 0 | 3 | fix-major | 2 | right | Hardcoded NorthStar, fourth-connect, agent-factory loop (cross-project-check.md:31-34); NorthStar is archived in the registry. |
| tdd | B | 0 | 4 | fix-major | 3 | too-rigid | Orphan duplicates: tdd/deep-modules.md and tdd/mocking-boundaries.md are byte-identical to the references/ copies (diff -> IDENTICAL); SKILL.md links  |
| test | B | 0 | 8 | fix-major | 2 | too-rigid | `Task(...)` / 'TaskOutput' naming (SKILL.md:86,117). |
| tldr-code | B | 0 | 1 | fix-major | 2 | right | rules.md:9-24 names layers call_graph/cfg/dfg/pdg that are not CLI commands; rules.md:34 says 'The PreToolUse:Task hook automatically injects TLDR con |
| ui-ux-pro-max | B | 0 | 1 | fix-major | 2 | too-rigid | python3 invocation |
| validate-agent | B | 0 | 1 | fix-major | 3 | right | model="haiku" (L207) |
| continuity_ledger | B | 0 | 5 | merge | 2 | right | Hook mismatch: .claude/hooks/src/session-start-continuity.ts:706 looks for CONTINUITY_CLAUDE-*.md ledgers and :816-817 tells the user to run /continui |
| debug | B | 0 | 1 | merge | 2 | too-rigid | Task agents (now the Agent tool) |
| mot | B | 0 | 0 | merge | 3 | right | haiku as valid model (references/audit-scripts.md:52) |
| research | B | 0 | 5 | merge | 2 | too-rigid | metadata.model: claude-opus-4-5-20251101 (L5), a stale model pin |
| help | B | 0 | 0 | archive-candidate | 2 | too-rigid | SKILL.md:205 lists the skill-activation-prompt hook (retired 2026-08-19). |
| iq360-event-audit | B | 0 | 0 | archive-candidate | 3 | right | evals/trigger_eval.json exists (good practice) but no behaviour evals. |
| migrate | B | 0 | 0 | archive-candidate | 2 | too-loose | 'Task(' agent spawn syntax (SKILL.md:58-141) |
| system_overview | B | 0 | 0 | archive-candidate | 2 | too-rigid | skill-activation-prompt hook |
| tdd-migrate | B | 0 | 0 | archive-candidate | 3 | too-rigid | No 'Use when' clause (inventory descHasUseWhen=false); 'Use "/tdd-migrate" or say' is not the convention. |
| tour | B | 0 | 0 | archive-candidate | 3 | right | 'explorer' agent (SKILL.md:49); the harness rule is 'Use scout'. |
| weekly-report | B | 0 | 0 | archive-candidate | 4 | right | [Speculation] the hard-coded project roster and Railway dashboard URL |
| workroom | B | 0 | 0 | archive-candidate | 4 | right | Fine for a user-invoked skill (disable-model-invocation: true). |
| archify | B | 2 | 1 | fix-minor | 3 | right | Lives only in ~/.claude/skills (a link to ~/.agents/skills/archify); not in the repo, so no sync, review or ratchet covers it (inventory where.repo=fa |
| game-plan | B | 1 | 0 | fix-minor | 4 | right | Grok as active builder while Grok is parked (SKILL.md:69, :49-54) [flag, not wrong] |
| harness-update | B | 1 | 7 | fix-minor | 4 | right | Edit point rules-ondemand/grok-worker-safety.md for allowlist (SKILL.md:92) |
| init-project | B | 1 | 1 | fix-minor | 4 | right | Template 'DB push: npx drizzle-kit push' default (claude-md-template.md:70) conflicts with the shared-DB rule in memory ('never drizzle-kit push') for |
| review | B | 1 | 9 | fix-minor | 3 | right | 'dogfood-proven 2026-07-11' provenance inside the synthesis prompt (SKILL.md:164); keep the rule, drop the date. |
| cma | B | 0 | 5 | fix-minor | 3 | right | Line 115: 'As of 2026-06-27 the env key 401s' is a dated status line; MEMORY says the key now lives only in opc/.env. |
| excalidraw-mcp | B | 0 | 1 | fix-minor | 4 | right | inventory deadRefs 'scripts/*.cjs' is a false positive: it is a glob and all 7 scripts exist in excalidraw-mcp/scripts/. |
| frontend-slides | B | 0 | 1 | fix-minor | 3 | right | Six reference files over 100 lines have no table of contents: STYLE_PRESETS.md (523), templates/nextjs-shadcn/README.md (258), themes/README.md (219), |
| impeccable | B | 0 | 1 | fix-minor | 3 | right | 26 reference files over 100 lines have no table of contents (inventory longRefsNoToc). critique.md is 780 lines and live.md is 727. |
| knowledge-tree | B | 0 | 1 | fix-minor | 3 | right | Daemon references at SKILL.md:139 and 146. |
| kusto-cli | B | 0 | 1 | fix-minor | 2 | right | Dated provenance lines: 'archived 2026-07-29' (SKILL.md:133) and 'moved here on 2026-09-23' (SKILL.md:250). |
| landing-page-builder | B | 0 | 1 | fix-minor | 3 | right | 'build me a page' is generic and collides with frontend-design, artifact-design, scroll-craft and impeccable; anchor on conversion, lead capture, CTA. |
| launch-your-agent | B | 0 | 4 | fix-minor | 3 | right | SKILL.md:15 'ANTHROPIC_API_KEY is already set in the environment on this machine' is false since 2026-09-18: the key lives only in opc/.env and must n |
| linear | B | 0 | 2 | fix-minor | 4 | right | references/projects.md:126-134 maps CCv3 projects to Linear projects; unverified [Speculation]. |
| maestro | B | 0 | 5 | fix-minor | 3 | right | metadata.model pins `claude-opus-4-5-20251101` (SKILL.md:7). |
| neonctl | B | 0 | 1 | fix-minor | 4 | right | Nested duplicate copy: .claude/skills/neonctl/neonctl/SKILL.md and neonctl/neonctl/references/*.md (identical refs per diff -r) with an older descript |
| notion-cli | B | 0 | 1 | fix-minor | 4 | right | Windows absolute exe path with backslashes (SKILL.md:15) is a literal path; acceptable, but note it is machine-specific. |
| opencli | B | 0 | 1 | fix-minor | 4 | right | claude-in-chrome recommended (SKILL.md:54; references/adapter-pipeline.md:64). |
| project-registry | B | 0 | 5 | fix-minor | 3 | right | NorthStar port 3002 example table (SKILL.md:59-64). |
| qa-test | B | 0 | 2 | fix-minor | 3 | right | metadata.user-invocable and metadata.triggers (:4-7) are not Claude Code frontmatter fields; [Speculation] they are ignored. |
| railway-cli | B | 0 | 1 | fix-minor | 4 | right | A stale nested copy exists: railway-cli/railway-cli/SKILL.md plus railway-cli/railway-cli/references/*.md (same reference content, older description w |
| react-perf | B | 0 | 3 | fix-minor | 3 | right | allowed-tools `Task` (SKILL.md:4) |
| recall | B | 0 | 3 | fix-minor | 4 | right | Collides with memory, whose description also claims '/recall' (all-skills.md:68). Two skills compete for the same trigger. |
| refactor | B | 0 | 3 | fix-minor | 3 | right | Legacy `Task(` call syntax (SKILL.md:52). |
| release | B | 0 | 3 | fix-minor | 3 | right | Legacy `Task(` call syntax (SKILL.md:54). |
| roadmap | B | 0 | 7 | fix-minor | 3 | right | Dated lines SKILL.md:59 and :110. |
| scroll-craft | B | 0 | 1 | fix-minor | 3 | right | SKILL.md body is 471 lines, near the 500-line ceiling. |
| security | B | 0 | 3 | fix-minor | 2 | right | 'Task(' agent spawn syntax (SKILL.md:52, :100) |
| sentry-cli | B | 0 | 1 | fix-minor | 4 | right | Line 83 dated move comment (2026-09-23) is harmless but time-stamped. |
| ui-audit | B | 0 | 3 | fix-minor | 3 | right | references/audit-rules.md is 373 lines with no table of contents. |
| vercel-cli | B | 0 | 2 | fix-minor | 4 | right | command/vercel.md is an opencode-style command (`skill({ name: 'vercel-cli' })`, <user-request> $ARGUMENTS) inside the skill folder; Claude Code does  |
| wrap-up | B | 0 | 2 | fix-minor | 4 | right | Dated audit stamp 'G8 2026-06-27' (SKILL.md:8, :15). |
| failure-audit | B | 0 | 0 | ok | 5 | right | Inventory flags first/second person; the 'you' sits inside a quoted trigger phrase, so this is a false positive. |
| next-best-practices | B | 0 | 1 | ok | 5 | right | 14 reference files over 100 lines have no ToC (e.g. self-hosting.md 372, metadata.md 302, data-patterns.md 298). The content is vendored (commit 50416 |
| find-skills | C | 0 | 0 | fix-major | 3 | too-loose | 'how do I do X' is the broadest possible trigger and would steal ordinary how-to questions. |
| implement_plan | C | 0 | 0 | fix-major | 2 | right | Task(...) tool name; the tool is now Agent. |
| implement_task | C | 0 | 0 | fix-major | 2 | too-rigid | Line 250 pins model claude-opus-4-5-20251101; harness policy is opus/sonnet tiers with effort high. |
| memory-curate | C | 0 | 0 | fix-major | 2 | too-loose | session_id LIKE 'auto-%' heuristic (references/scoring-rubric.md:11, :128-134) |
| reporting | C | 0 | 0 | fix-major | 3 | right | 'ai-reporting MCP ... currently unregistered' (SKILL.md:71-72) |
| research-external | C | 0 | 0 | fix-major | 2 | too-rigid | Ignores the opencli-first rule (rules-ondemand/opencli-first.md:3-10) that loads on WebFetch/WebSearch. |
| stale-scan | C | 0 | 0 | fix-major | 3 | too-loose | Sentinel/Warden as the archived set; .yml agent format. |
| task-master-workflow | C | 0 | 0 | fix-major | 3 | right | "what's next" is a generic phrase; outside a .taskmaster project it will steal the turn from roadmap, lane and handoff work. |
| win-preflight | C | 0 | 0 | fix-major | 3 | too-loose | references/windows-antipatterns.md is 327 lines with no table of contents. |
| agent-development | C | 0 | 0 | merge | 3 | right | Haiku model alias recommended (SKILL.md:51, :63, :178) |
| dead-code | C | 0 | 0 | merge | 2 | right | Overlaps tldr-code, whose description already lists 'dead code' (tldr-code/SKILL.md:3,6). |
| debug-hooks | C | 0 | 0 | merge | 3 | right | Shell-wrapper hook model. |
| extract-v2 | C | 0 | 0 | merge | 3 | right | Frontmatter uses a top-level `user-invocable: true` key instead of the CCv3 `disable-model-invocation` convention. |
| fourth-presentation-builder | C | 0 | 0 | merge | 3 | right | references/brand-standards.md:24 lists 'Sunrise Orange #062A3C'; #062A3C is a dark navy, not orange. Wrong hex in a brand reference. |
| hook-developer | C | 0 | 0 | merge | 3 | right | Debugging checklist repeats debug-hooks (SKILL.md:126-134 vs debug-hooks SKILL.md:111-118). |
| remember | C | 0 | 0 | merge | 4 | right | 'remember this' and 'store this learning' triggers are already in the memory skill description (all-skills.md:68). |
| sub-agents | C | 0 | 0 | merge | 3 | n/a | Haiku model option and 'Explore / Haiku' built-in row. |
| agent-context-isolation | C | 0 | 0 | archive-candidate | 3 | too-rigid | Task(...) tool name (now Agent) |
| agentica-prompts | C | 0 | 0 | archive-candidate | 2 | too-rigid | Memory system described as FTS5 3-tier store (SKILL.md:236-249); CCv3 memory is PostgreSQL + pgvector. |
| agentica-sdk | C | 0 | 0 | archive-candidate | 3 | right | Model ids claude-sonnet-4.5 / claude-opus-4.5 / gpt-3.5-turbo (references/api-reference.md:34-43) |
| agentica-spawn | C | 0 | 0 | archive-candidate | 3 | too-loose | Pattern classes come from the retired agentica-infrastructure skill (snapshot 2026-03-07 only). |
| ast-grep-find | C | 0 | 0 | archive-candidate | 3 | right | Python-harness-over-MCP pattern (cli-integration SKILL.md:84 lists ast-grep under it) no longer has any configured server. |
| azure-deployment | C | 0 | 0 | archive-candidate | 3 | right | Manual SWA CLI deploy flow replaced by GitHub Actions for the only consuming project. |
| cli-reference | C | 0 | 0 | archive-candidate | 3 | n/a | Model ID claude-opus-4-5-20251101 (line 89). |
| date-logic-management | C | 0 | 0 | archive-candidate | 2 | too-rigid | README.md (393 lines) is human install documentation for Claude Web App; no ToC, not needed by Claude. |
| describe_pr | C | 0 | 0 | archive-candidate | 3 | too-rigid | Name/directory mismatch (describe-pr vs describe_pr). |
| exa-code-search | C | 0 | 0 | archive-candidate | 3 | right | Nia tool name `nia_search_github_repo` (SKILL.md:48) no longer exists; current Nia tools are nia_grep/nia_read/search. |
| firecrawl-scrape | C | 0 | 0 | archive-candidate | 4 | right | 'MCP Server Required' claim |
| full-test-suite | C | 0 | 0 | archive-candidate | 3 | right | Uses raw CDP Chrome instead of @playwright/mcp (browser-automation.md rule) [partial: not claude-in-chrome, so not banned]. |
| github-search | C | 0 | 0 | archive-candidate | 4 | n/a | 'via MCP' names a server that is not configured. |
| implement_plan_micro | C | 0 | 0 | archive-candidate | 1 | too-rigid | SKILL.md:187 hard-codes model="claude-opus-4-5-20251101" and subagent_type general-purpose; the harness uses tiered named agents (opus/sonnet) and nev |
| meeting-brief-generator | C | 0 | 0 | archive-candidate | 2 | too-loose | Q4 goals project paths (references/meeting-template.md:44) |
| morph-apply | C | 0 | 0 | archive-candidate | 3 | n/a | 'no read-first needed' invites edits to unread files, against the harness rule that edits need a prior Read. |
| morph-search | C | 0 | 0 | archive-candidate | 3 | n/a | 'search the codebase for X' / 'find where this is used' are the most generic search phrases; they collide with search-router, tldr-code, ast-grep-find |
| nia-docs | C | 0 | 0 | archive-candidate | 3 | too-rigid | Removed Nia tool names doc_*, code_grep, nia_web_search, nia_deep_research_agent (SKILL.md:46-57, :25-27) |
| onboard | C | 0 | 0 | archive-candidate | 4 | right | 'continuity ledger' in the description, 'YAML handoff' in the body: two terms for one artifact. |
| pageindex-search | C | 0 | 0 | archive-candidate | 2 | right | Name collides with the claude.ai PageIndex MCP connector (Vectify, for PDFs), so routing is ambiguous. |
| parallel-agents | C | 0 | 0 | archive-candidate | 2 | too-rigid | Task tool name |
| perplexity-search | C | 0 | 0 | archive-candidate | 3 | right | 'Models (2025)' header and 2025 example queries (lines 18, 58, 98) are time-sensitive. |
| plan-mode | C | 0 | 0 | archive-candidate | 3 | too-rigid | 'asked to "make a plan"' is the same trigger as plan-agent ('make a plan'). |
| post-ship-audit | C | 0 | 0 | archive-candidate | 3 | too-loose | references/audit-checklist.md is 222 lines with no table of contents. |
| qlty-check | C | 0 | 0 | archive-candidate | 3 | right | Python-harness-over-MCP pattern, broken on this machine. |
| recall-reasoning | C | 0 | 0 | archive-candidate | 3 | right | Artifact Index / context.db path superseded by archival_memory handoff indexing. |
| repo-research-analyst | C | 0 | 0 | archive-candidate | 2 | too-loose | 'current year is 2025' (SKILL.md:6) |
| repoprompt | C | 0 | 0 | archive-candidate | 3 | right | "explore the codebase" collides with explore, tldr-code and repo-research-analyst; Claude would pick an uninstalled tool. |
| rlm-analyze | C | 0 | 0 | archive-candidate | 4 | right | Dead plan link at L101 |
| search-router | C | 0 | 0 | archive-candidate | 2 | too-rigid | References `/tldr-search` (SKILL.md:88), which is not a skill; only tldr-code and tldr-stats exist. |
| session-score | C | 0 | 0 | archive-candidate | 3 | too-rigid | References the removed .ralph/state.json signal (SKILL.md:36-37) as history. |
| skill-developer | C | 0 | 0 | archive-candidate | 2 | n/a | Step 3 registers triggers in skill-rules.json (SKILL.md:117-136); the skill-activation-prompt hook that read them was retired 2026-08-19, and no regis |
| skill-development | C | 0 | 0 | archive-candidate | 2 | too-loose | 'Add triggers to skill-rules.json' and 'Create skills without corresponding trigger in skill-rules.json' (SKILL.md:22, :27): the activation hook that  |
| skill-upgrader | C | 0 | 0 | archive-candidate | 2 | too-rigid | Task tool name (now Agent) in allowed-tools and examples. |
| workflow-router | C | 0 | 0 | archive-candidate | 2 | too-rigid | Spawn examples use Task(subagent_type=...) (SKILL.md:124-189); the tool is now Agent. |
| health-check | C | 0 | 0 | fix-minor | 3 | right | Haiku model in the wrapped script (health_check.py:2396). |
| log-work | C | 0 | 0 | fix-minor | 4 | right | SKILL.md:7 and :206 version/date banners (time-sensitive). |
| next-cache-components | C | 0 | 0 | fix-minor | 4 | right | `revalidateTag('posts')` with one argument (SKILL.md:214); Next.js 16 deprecated the one-argument form in favour of a cacheLife profile second argumen |
| next-upgrade | C | 0 | 0 | fix-minor | 4 | right | Trigger 'update to Next 16' is time-sensitive. |
| project-card | C | 0 | 0 | fix-minor | 4 | right | inventory deadRefs (state.json, template.html, README.md) are false positives: all exist under C:/Users/david.hayes/continuous-claude/scripts/project- |
| qa-suite | C | 0 | 0 | fix-minor | 4 | right | metadata.user-invocable and metadata.triggers (lines 5-7) are probably inert [Speculation]. |
| supersede | C | 0 | 0 | fix-minor | 4 | right | metadata.user-invocable (:4-5) is not a Claude Code frontmatter field; [Speculation] ignored. |
| tldr-stats | C | 0 | 0 | fix-minor | 2 | right | Haiku pricing and emoji (lines 80, 86). |
| workos-widgets | C | 0 | 0 | fix-minor | 4 | right | Second-level references: six framework-*.md files link to token-strategies.md (e.g. references/framework-nextjs.md:8, :13). |
| workos | C | 0 | 0 | ok | 4 | right | 9 references link to other references, two levels deep (e.g. references/workos-authkit-nextjs.md:7 sends Claude to workos-authkit-setup.md); the SKILL |
