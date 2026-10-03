# Skills review against Anthropic's skill best practices (2026-10-01)

Source: https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices
Verdict: ADOPT. Status: proposed; Dave answered the 4 decisions below on 2026-10-01.

## Baseline (static pass, 143 repo skills with a SKILL.md, nothing edited)

| Best-practice rule | Our skills now |
|---|---|
| SKILL.md body under 500 lines | 0 over 500; 24 over 300 (largest: memory 488) |
| Description at most 1,024 chars, third person, what + when | 0 too long; 14 start with "Use when" and never say what the skill does |
| name: lowercase/digits/hyphens, matches the folder | 6 name/folder mismatches |
| Reference file over 100 lines has a table of contents | 130 have none |
| References one level deep from SKILL.md | 21 reference files link on to further .md files |
| No time-sensitive text | 33 skills have dated text in the body |
| Forward-slash paths only | 10 skills have Windows paths |
| At least 3 evaluations per skill, with a no-skill baseline | almost none (`scripts/skills/trigger-cases.json` has 1 case) |

Skill locations: repo `.claude/skills` 146 dirs (3 with no SKILL.md); active `~/.claude/skills` 157
(about 11 active-only); Codex mirror `~/.agents/skills` 137.

## Decisions (Dave, 2026-10-01)

1. Eval models: Sonnet (high) + Opus + Fable. No Haiku (policy).
2. Naming: fix the 6 name/folder mismatches and vague names only. No gerund mass rename.
3. Scope: repo + active-only skills + Codex mirror. Plugin and claude.ai account skills: report only.
4. Phases 0 and 3 run as workflows (about 8-10 agents per run).

## Phases (one PR each; Phase 4 is several PRs)

0. Ground truth, read-only: read the Claude Code skills doc (extra frontmatter keys); diff our rules
   (`audit-descriptions.mjs`, skill-forge `references/authoring-guide.md`, the "Use when" convention)
   against the guide; inventory every location; count 60-day skill use from transcripts; tier the skills.
1. Gate: extend `scripts/skills/audit-descriptions.mjs` to `audit-skills.mjs`, a ratchet over every
   static item above plus dead file/script references. Measure the skill listing size against
   `skillListingBudgetFraction 0.05` before any description gets longer.
2. skill-forge: authoring guide, `quick_validate.py`, `init_skill.py` template and eval schema follow the
   guide; its validator calls the new gate.
3. Behaviour evals. Tier A (about 25 most-used + Dave's picks): 3 evals each in the guide's
   `{query, files, expected_behavior}` shape, baseline without vs with the skill, 3 models, via
   skill-forge `run_eval.py`. Tier B: should-fire / should-not-fire prompts via `trigger-probe.mjs`
   native channel (catches routing collisions). Tier C (no use in 60 days): archive candidates for Dave.
4. Fix in batches of about 15 skills per PR, most-used first: "Does X. Use when Y." descriptions,
   split long bodies into one-level references, add contents sections, move dated text to an
   "old patterns" section, scripts for deterministic steps. Critic review per PR; ratchet goes down;
   Tier A evals re-run and a change stays only if it beats the baseline.

## Risks

- Longer descriptions can push skills out of the listing budget (measure in Phase 1).
- Eval volume: about 25 x 3 x 2 x 3 models = 450 headless runs for Tier A [Speculation on runtime].
