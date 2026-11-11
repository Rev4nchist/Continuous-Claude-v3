# Review-engine program lanes

You see this because the call claims a program lane (`re-`, `force-high-security-tier`, `hf-judge-precheck`).
The rule informs. The claim code refuses an open dependency (T2.1). Map: `docs/review-engine/map.md` on `main`.
Script: `node C:/Users/dkhay/continuous-claude/scripts/review-engine/program.mjs`, from the primary checkout only.

## The ten rules

1. Before any edit, read `docs/review-engine/README.md` and your lane section in `map.md`.
2. Claim only a lane that `program.mjs ready` prints. Hold one program lane per session. One lane has one worktree, one branch and one PR. Never use `--dep-override`.
3. Edit only the files in your lane's Owns list. Run `program.mjs check --diff <lane-id>` before the PR.
4. Holdout and gold data: never tune on them. Never put their PR ids or answers in a note, a prompt or a PR body.
5. Cursor models: Grok 4.7 or Composer 2.5 only. Never Auto, never -fast. Never haiku.
6. Spend: before each batch, read the ledger that `docs/review-engine/capacity.md` names. Stop at the cap.
7. Make no engine-file change inside a counted CRITICAL window. The CLI window (path F, DP1.5) counts the pinned engine copy, so an engine PR on `main` does not reset it. See `docs/review-engine/evidence-bar.md`, "Counted weeks".
8. A lane marked "Needs Dave" stops at that point. Ask Dave with AskUserQuestion, recommended option first. While a lane waits on Dave or on a review, set state `review` with a note: what it waits on and the next step.
9. Write "risk band" for LOW to CRITICAL. "Band" alone means P0, P1 or P2.
10. Done means the lane's done-check ran and its output is saved in `.claudedocs/e2e-<lane-id>/` in the primary checkout. Name that folder in the done note and in the PR. End the lane with `node C:/Users/dkhay/.claude/scripts/lane.mjs done <id> --merged <sha>` (the merge commit on `main`) or `node C:/Users/dkhay/.claude/scripts/lane.mjs done <id> --no-pr --evidence <path>`. A plain `done` opens no dependent lane. Then run `program.mjs sync-board --apply` (without `--apply` it is a dry run).

## The cap

- At most 3 program lanes are in work, and 1 lane that spends test runs. `program.mjs ready` applies the cap.
- The cap counts lanes in `active` or `review` whose holder is alive. A parked lane with a live holder counts.
- Before a command that runs longer than 5 minutes, run `node C:/Users/dkhay/.claude/scripts/lane.mjs renew`.

## Subagents

This rule does not load on Edit or Write. Put the Owns list and rules 3 to 5 in every subagent prompt. Subagents never claim a lane.

## Messages

- Send one DM per milestone and receiver: `node C:/Users/dkhay/.claude/scripts/lane.mjs say "<text>" --to <name>`.
- A DM has at most 5 numbered items. The receiver replies one time.
- A session outside the program sends program items to the seat only.
- Take every time you write from a clock in the same command. Never type a time from memory.

## Next

If the lane fits rules 1 and 2, re-issue the same call. If not, stop and tell the coordinator seat (holder of `re-program`) with `node C:/Users/dkhay/.claude/scripts/lane.mjs say "<text>" --to <seat>`.
