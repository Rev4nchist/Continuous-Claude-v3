# Session notes (scratch, written during the session)

- Repo: ~\continuous-claude
- Branch: chore/skills-phase3-evals
- Most recent handoff folder on disk: thoughts/shared/handoffs/skills-review/
- Track: skills review, Phase 3 (behaviour evals)

## Done
- Wrote evals/evals.json for premortem, recall and log-work (.claude/skills/premortem/evals/evals.json, .claude/skills/recall/evals/evals.json, .claude/skills/log-work/evals/evals.json).
- Dry-run of run_eval.py loads all three files and prints the plan.
- Lane board: claimed lane `skills-phase3`, released lane `skills-phase2-forge`, noted progress on `skills-phase3` with `node scripts/coordination/lane.mjs note`.

## Decided
- Guide shape for evals.json (list of {skills, query, files, expected_behavior}), not the legacy shape: it is the Anthropic guide format.
- No paid runs yet: dry-run only until Dave approves the spend.

## Found
- notion-bridge has a nested duplicate tree at .claude/skills/notion-bridge/notion-bridge/.
- create_handoff/SKILL.v6.md contradicts SKILL.md.

## Failed
- Tried to give an eval a file outside the skill folder: run_eval.py refuses it (files are relative to the skill root).

## Open
- 9 skills still have no evals.
- Should SKILL.v6.md be deleted or archived? Ask Dave.

## Next
1. Write evals for the remaining 9 skills.
2. Run `python .claude/skills/skill-forge/scripts/run_eval.py behavior --skill-path .claude/skills/premortem --evals .claude/skills/premortem/evals/evals.json --models sonnet --dry-run` for each.
3. Ask Dave to approve the first graded run.

Verify with: python .claude/skills/skill-forge/scripts/run_eval.py behavior --skill-path .claude/skills/premortem --evals .claude/skills/premortem/evals/evals.json --models sonnet --dry-run
