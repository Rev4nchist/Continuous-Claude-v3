# Skills review, Phase 3: does each Tier A skill change what Claude does? (2026-10-02)

Proposal: `docs/self-improvement/proposals/2026-10-01-skills-best-practices-eval.md`. Evals: 3 per skill in
`.claude/skills/<name>/evals/evals.json` (33 evals, 160 assertions). Runner: skill-forge `run_eval.py behavior`
with fixes `de3463d` and `fa6f510`. Raw runs: `%TEMP%/skill-eval/phase3/<model>/<skill>/`; scores:
`.claude/cache/skills-eval/phase3/{sonnet,opus,fable}-scores.json`, pooled `combined.json` (gitignored).

## Method

- 11 Tier A skills x 3 evals x 2 arms (with the skill / skill off) x 3 models (Sonnet high effort, Opus,
  Fable) = 198 runs, 1 per eval per model. 187 were graded by a blind grader against 4-5 checkable
  assertions; 4 stopped at the turn cap and scored 0 with no grader call; 7 baselines were excluded.
- With-skill runs use a renamed copy of the skill; baselines have no copy, the real skill off under both its
  names, and Read denied on `~/.claude/skills/<name>/**`. Hooks off, no MCP, tools Skill/Read/Glob/Grep.
- Both arms load Dave's global `CLAUDE.md` and rules. So "Delta" measures what a skill adds ON TOP of the
  harness Dave actually runs, not over a bare model.
- A run that hit the turn cap counts as a failed answer (4 runs). 7 baseline runs were excluded as
  contaminated (see "Measurement notes").

## Results (pooled over the 3 models; sorted by delta)

| Skill | With | Without | Delta | Sonnet w/wo | Opus w/wo | Fable w/wo | Fired (with) | Excluded | Weak evals (with-skill at most 2/5 on every model) |
|---|---|---|---|---|---|---|---|---|---|
| notion-dashboard | 96% | 13% | +83 | 93/7 | 100/0 | 93/60 | 9/9 | 3 | - |
| premortem | 82% | 22% | +60 | 80/27 | 87/20 | 80/20 | 9/9 | 0 | - |
| create_handoff | 78% | 40% | +38 | 53/20 | 93/60 | 87/50 | 8/9 | 2 | - |
| code-review | 80% | 51% | +29 | 80/53 | 87/47 | 73/53 | 9/9 | 0 | - |
| skill-forge | 71% | 50% | +21 | 60/47 | 87/70 | 67/40 | 8/9 | 1 | - |
| fourth-brand-guidelines | 96% | 80% | +16 | 87/67 | 100/93 | 100/80 | 9/9 | 0 | - |
| notion-bridge | 86% | 74% | +12 | 79/71 | 93/79 | 86/71 | 9/9 | 0 | - |
| databases | 82% | 71% | +11 | 87/67 | 80/73 | 80/73 | 9/9 | 0 | - |
| personas | 63% | 58% | +5 | 67/60 | 60/50 | 60/60 | 8/9 | 2 | e3 (2/5, 1/5, 1/5) |
| mcp-guidance | 64% | 60% | +4 | 57/50 | 64/64 | 71/64 | 6/9 | 0 | e2 (2/5, 0/5, 2/5) |
| systematic-debugging | 52% | 48% | +4 | 50/43 | 57/50 | 50/50 | 8/9 | 0 | e2 (0/5, 1/5, 0/5) |

"With"/"Without" = share of assertions passed. Per-model columns are with/without percentages. One run per eval
per model, so a single eval can swing by up to 50 points by chance; read deltas under ~10 as "no clear effect".

## What the numbers say

- **Clear value (keep, polish):** `notion-dashboard` (+83), `premortem` (+60), `create_handoff` (+38),
  `code-review` (+29). They carry content a strong model cannot infer: exact IDs, a fixed method (tigers /
  paper tigers / elephants), formats. Their lift holds on all 3 models.
- **Modest value:** `skill-forge` (+21), `fourth-brand-guidelines` (+16, mostly on Sonnet; Opus and Fable
  already score 93% and 80% without it), `notion-bridge` (+12; the lift is in eval 3, "bridge sync"),
  `databases` (+11; strong models already know most of it).
- **No clear effect:** `personas` (+5), `mcp-guidance` (+4), `systematic-debugging` (+4).
  - `systematic-debugging`: CLAUDE.md already says "no fix without a root cause", so the baseline has the
    principle. In eval 2 the skill fired and the model found a plausible cause, but did not follow the skill's
    procedure (reproduce first, check recent changes, rival hypotheses with checks, one change at a time).
    The skill does not steer behaviour beyond what CLAUDE.md gives.
  - `mcp-guidance`: fired only 6 of 9 times. In eval 2 Opus quoted the skill's 50% context rule and then
    overrode it; the token tiers, batching and caching guidance were not used.
  - `personas`: the architect persona's rituals (diagram, 5-year horizon, maintainability over speed) were
    not followed in eval 3 on any model, with or without the skill.
- **Triggering:** with-skill runs fired the skill 92 of 99 times. Misses: `mcp-guidance` 3, `create_handoff`,
  `skill-forge`, `personas`, `systematic-debugging` 1 each (mostly Sonnet).

## Measurement notes (1 and 2 fixed in PR #81 after scoring; 3 still open)

1. **False contamination.** The runner counts a Read the permission rule DENIED as a read of the skill
   (`opus personas e2`: the Read returned "File is in a directory that is denied"). Count only successful
   reads.
2. **Real contamination through the repo copy.** Some baselines read the repo copy of the skill
   (`C:/Users/david.hayes/continuous-claude/.claude/skills/<name>/...`) or a related skill, which the deny
   rule does not cover (it covers `~/.claude/skills` only). Add the repo source folder to the deny list.
3. **Sampling.** One run per eval per model. Repeat the 3 "no clear effect" skills with 3 runs per eval
   before deciding their fate.

## Phase 4 fix list (from Phase 3)

| Priority | Skill | Action |
|---|---|---|
| 1 | systematic-debugging | Rewrite: cut what CLAUDE.md already says; keep the few steps models skip (reproduce first, rival hypotheses each with an eliminating check, one change at a time) and put them first, as a short checklist. Re-run its evals. Fix eval 2 to reward a correct root cause as well as the procedure. |
| 2 | mcp-guidance | Decide keep or archive. Its 50% rule and token tiers were ignored or overridden; fires 6/9. If kept: rewrite to 3-5 concrete rules, fix the description so it fires, re-run. |
| 3 | personas | Archive candidate: no effect on any model; its rituals add little. Check first whether Dave uses `/persona:` by hand (user-typed use is not in the 60-day model-use data). |
| 4 | fourth-brand-guidelines, databases | Trim to the content strong models lack (brand values, exact pool numbers, migration "Always" steps); the rest is token cost. |
| 5 | notion-bridge | Keep; its value is the sync/queue procedure (eval 3). Make that part prominent; trim the rest. |
| 6 | all 11 | The Phase 1 gate findings still apply (descriptions, contents sections, dated text, allowed-tools scoping). |
| 7 | runner | Done in PR #81: denied Reads no longer count, and the repo source folder is denied (verified live). |
