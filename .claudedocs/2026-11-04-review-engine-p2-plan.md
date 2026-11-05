# Review engine phase 2: deterministic catchers (plan, 2026-11-04)

Lane `review-engine-p2-catchers`. Worktree `C:\Users\dkhay\continuous-claude\.claude\worktrees\review-p2`, branch `feat/review-engine-p2` from main f46cf0a7.
Parent plan: `C:\Users\dkhay\continuous-claude\.claudedocs\2026-11-04-review-engine-combined-plan.md` section 3 row 2, section 5, section 6.

## Facts that change the pass bar (scout 11-04)

- PR 211 Major is top-level argv parsing in `scripts/settings/remove-maestro-registrations.mjs`. Only a CLI smoke run reaches it. Pre-fix `2aabe283` exits 1 with ENOENT on `--help`.
- PR 200 (`apps/agentic-os/src/server/sources/safe-message.ts`) and PR 222 (`.claude/plugins/ccv3-mods/hooks/agentic-os/brief.ts`) are TypeScript. Fixtures must import TS: bundle with `.claude/hooks/node_modules/.bin/esbuild` to a temp ESM file.
- PR 221 Major is a policy gap in a markdown rule with no code fix. No deterministic catcher can fail on it.
- `tsc --checkJs` does not catch PR 211. `test-map.mjs` is a TREX flow selector, not a file-to-test map.
- The 11 clean PRs are the TREX negatives: 237, 210, 226, 247, 254, 255, 222, 265, 266, 211, 242. Heads in `C:\Users\dkhay\continuous-claude\.claude\cache\e2e\trex-baseline\<N>\record.json`. 222 and 211 are post-fix merge heads.

## Pass bar (restated)

1. Smoke plus fixtures FAIL on the pre-fix ranges of 200, 211 and 222 (3 of the 4 parser Majors; 221 is out of reach).
   - 211: `4ff7dc66..2aabe283`. 200: `beb9d5ef..23b62e5d`. 222: `dce71cdc..91b0b4c8`.
2. Smoke plus fixtures PASS on the post-fix heads and on all 11 clean PRs: 0 gate failures.
3. tsc errors are reported only on changed lines. tsc and mapped-test results are facts for the reviewer, never gates (Dave's yes covered smoke and fixtures only).
4. 0 Cursor runs.

## Holdout rule

200, 211 and 221 are holdout PRs. Fixture authors get the parser list and a hostile-input taxonomy only. They never get the breaking strings or the fix SHAs. The 11 clean PRs prove the fixtures are not tuned to three cases.

## Components

| File | Job |
|---|---|
| `scripts/checks/changed-lines.mjs` | Changed `.mjs` files and new-side line ranges from a diff (reuse `parseHunks` in `scripts/github/review-filter.mjs`). |
| `scripts/checks/typecheck-changed.mjs` | `tsc --noEmit --allowJs --checkJs` on the changed `.mjs` files with `@types/node` from `.claude/hooks`. Keep errors on changed lines only. Facts only. |
| `scripts/checks/cli-smoke.mjs` | The smoke contract below. Gate. |
| `scripts/checks/parser-fixtures.mjs` + `scripts/checks/parser-fixtures/registry.mjs` | Registered parsers with property checks, run over the hostile-input taxonomy. TS through esbuild. Gate. |
| `scripts/checks/catchers.mjs` | Runs all catchers on a tree plus diff. Writes `catchers.json` and a fenced markdown facts block. Exit 1 only when smoke or fixtures fail. Mapped tests come from `gatesFor(changed)` in `scripts/github/pre-pr.mjs` (no second map). |
| `scripts/github/local-review/context.mjs` | New `catchers` section (new RANK entry, fenced like `gatesSection`). |
| `scripts/github/local-review.mjs` | `--facts <file>` (sibling of `--gates`). |
| `scripts/github/pre-pr.mjs` | Gate row `catchers` for changed `scripts/**/*.mjs` and registered parser files. A FAIL blocks the stamp. |
| `scripts/eval/review-eval/catchers-eval.mjs` | Runs catchers on the target pre/post ranges and the 11 clean PRs. Prints the pass-bar table. |

## Smoke contract

- A candidate is a changed, non-test `.mjs` under `scripts/` that has a shebang or reads `process.argv` at top level.
- Run `--help`, then no args. Never pass `--apply` or any other mutating flag.
- Each child runs on a copy of the tree in a temp folder: `scripts/`, `.claude/`, `docs/` and the files at the root (no `node_modules`, `.git`, `.claude/cache`, `.claude/worktrees`). A script that writes beside itself changes only the copy. The copy is made once per run (about 2.5 s on this worktree).
- HOME, USERPROFILE, APPDATA and cwd point at another temp dir with a stub `.claude/settings.json`. 10 s timeout per run.
- FAIL: an uncaught Node error with a stack frame (`at ... (file:line)`), or an ENOENT or EISDIR whose message names a path that holds an argument.
- TIMEOUT (changed 11-04 by the orchestrator): a run that hits the limit is a fact in the catcher text, not a failure and not a gate. Reason: `--help` on `validate-mods.mjs` and `e2e-headless.mjs` runs past 10 s at a clean commit and would block real PRs with noise. A script with a FAIL run is FAIL even if its other run timed out.
- PASS: any clean exit, including exit 1 or 2 with a usage message.
- A crash of the smoke or the fixtures tool (no verdict) fails the gate. A crash of tsc stays a fact.

## Hostile-input taxonomy (for fixture authors)

Empty string, whitespace only, CRLF and lone CR, tabs, very long input, unicode and emoji, NUL, paths with spaces, quotes and apostrophes, Windows and POSIX paths, `~` paths, a flag where a value is expected, repeated flags, mixed case, punctuation variants (en and em dash, unspaced dash, smart quotes), and action words mixed with wait words.

## Order

1. Build: K1 changed-lines + typecheck + smoke; K2 fixtures (parallel, disjoint files, no commits). Then K3 catchers + wiring. The orchestrator commits each wave.
2. Measure: K4 eval runner. Save `.claude/cache/e2e/2026-11-04-p2-catchers-eval.{json,md}`.
3. Critic + refute workflow, then pre-pr, draft PR, pr_watch + pr_checkpoint. Land on Dave's yes.
