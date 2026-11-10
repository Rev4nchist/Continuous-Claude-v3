# Review-engine program

Goal: replace CodeRabbit with the CCv3 local review engine.
A CodeRabbit path retires only when its gate in `evidence-bar.md` passes and Dave says yes.

**HOLD: No session may claim a `re-` lane before Dave's GO.**
The two external lanes and the card `brief-bare-wait-dave` are `blocked` too.

## Files in this folder

| File | Holds |
|---|---|
| [map.md](map.md) | The one map: the Waves table, every lane section, the shared contracts. |
| [evidence-bar.md](evidence-bar.md) | The bar for each gate, and the open items. |
| [decisions.md](decisions.md) | Each decision point: the question, Dave's answer, the date. |
| [capacity.md](capacity.md) | Each cap: its number, the ledger that enforces it, the last measured use. |
| [research-index.md](research-index.md) | Every review-engine doc with one mark: in force, superseded, record, or record (unclear). |

- The Waves table in `map.md` is the only place that states lanes and dependencies.
- A wait that is only in prose is not a dependency. It goes into the Waves table before the seed.
- Live state stays on the lane board: holders, notes, done. No file here holds a copy.
- The coordinator seat changes these files, by PR. A worker sends a map fault with `lane.mjs say`.
- The coordinator seat holds the master card `re-program`. It does no build work under that lane.

## Terms

- **Risk band**: LOW, MID, ELEVATED, HIGH or CRITICAL. `bandOf` in `scripts/github/review-router.mjs` sets it for a PR.
- **Program**: a set of lanes with one goal and one map in `docs/<program>/`.
- **Master card**: the one lane that stands for a program on the lane board (`re-program`). It shows HOLD or GO.
- **Coordinator seat**: the session that holds the master card.
- **Wave**: a group of lanes in the Waves table. Each dependency of a lane is in an earlier wave.
- "Band" on the lane board means P0 to P2. `CONTEXT.md` gets the "Risk band" line in a later PR.

## How a session works a lane

This loop applies after GO. A step marked "not built" needs a part that does not exist yet.

- One lane is one worktree, one branch `re/<lane-id>` and one PR. The parent session opens the PR.
  OPEN: Dave has not decided if one PR can carry several small lanes.
- A session works one `re-` lane at a time.
- Run each lane command through the lane shim: `~/.claude/scripts/lane.mjs`.
- Run `program.mjs` (not built) from the primary checkout, never from a worktree copy.
- Write a lane note at each phase: claimed, worktree ready, team running, done-check passed, PR open, landed.
- Run `lane.mjs renew` before a command that runs longer than 5 minutes.

1. Run the `kanban-sync` skill. Run `program.mjs ready` (not built). Claim a lane that it prints.
2. Read your lane section in `map.md`. Then read the sections in its Depends on, Unblocks and Related.
3. Create the worktree. Run `node scripts/worktree/shared-deps.mjs --check`.
   Check the branch, the clean tree and the drift of the Owns files against `main`.
   Commits in one repo run one after another. Do not stage `.claude/hooks/dist` changes that are not yours.
4. Start the team for the lane type. See the table below.
5. The parent session runs the done-check again. Save the output in `.claudedocs/e2e-<lane-id>/` in the primary checkout.
   The "Artifact:" path in the lane section gives the file name only.
   Run `program.mjs check --diff <lane-id>` (not built). Save its output in the same folder.
   Name both in the PR Evidence section. A changed file outside the Owns list stops the lane here.
6. Run pre-pr. Open the PR. Do the review loop. Land the PR. The open and the land each need Dave's tap.
7. Mark the lane done. The `--merged` flag is not built.
   `lane.mjs done <id> --merged <sha> --note "LANDED #N (main <sha>). Evidence <path>. Not covered: <list>."`
8. Run `program.mjs sync-board` (not built). Then tell the coordinator: `lane.mjs say --to <coordinator> "<id> done"`.
9. Unlink the `node_modules` junction. Then remove the worktree.
   A forced remove with the junction in place empties the primary copy.
10. If you changed the board, publish the board page: read live, render, publish.

| Lane type | Team |
|---|---|
| Trust-boundary or CRITICAL risk band | scout, architect (plan), kraken (tests first), arbiter, critic and principal-reviewer. Add aegis when a security-tier file changes. |
| Engine or test-bench code | scout, kraken, arbiter, critic |
| Data or answer-key lane | scout, kraken, arbiter, a judge from a second model family on a sample |
| Docs or config | spark, critic |

Each subagent prompt holds the Owns list, and the Owns, data and model rules below.
For a lane that owns `scripts/github/land-pr.ps1`, each subagent prompt also holds this text:
"Use Read, Grep and Edit on land-pr.ps1. Never name it in a shell command. The parent runs the test scripts."

## Rules

- No session claims a `re-` lane before Dave's GO.
- Before GO: no engine run, Cursor run or CodeRabbit run without Dave's yes.
- After GO: spend stays inside the caps in [capacity.md](capacity.md). Read the ledger named there before each batch. Stop at the cap.
- Data: no holdout or gold PR id, and no answer, in a note, a prompt or a PR body.
  Never tune on holdout or gold data.
- Models: Cursor runs use Grok 4.7 or Composer 2.5 only. Never Auto, never -fast, never haiku.
- Owns: edit only the files in your lane's Owns list.
- CodeRabbit on a `re-` PR: the CLI and the engine, no PR bot. The checkpoint answer is `none` (Dave, 2026-11-10).
  At HIGH and CRITICAL only Dave's tap records `none`.
- Evidence: a program lane saves its evidence in `.claudedocs/e2e-<lane-id>/` in the primary checkout.
  A worktree cache is lost with the worktree. The `AGENTS.md` line for this rule comes in a later PR.
- Make no engine-file change inside a counted CRITICAL window.
  The CLI window (path F, DP1.5) counts the pinned engine copy, so engine PRs on main do not reset it.
  See [evidence-bar.md](evidence-bar.md), "Counted weeks".
- A lane marked "Needs Dave" stops at that point. It asks Dave with AskUserQuestion.
- Say "risk band" for LOW to CRITICAL. "Band" alone means P0, P1 or P2.
- Done means the lane's done-check ran and its output is saved.

## Not built yet

| Part | Status |
|---|---|
| The dependency gate T2.1: `claim` refuses a lane with an open dependency | not built |
| `lane.mjs done --merged <sha>`: the flag that records the landed SHA (comes with T2.1) | not built |
| T2.3 (owner check on `state`) and T2.4 (the `park` verb): one PR, the fourth, after T2.1 and before wave 1 (Dave, 2026-11-10) | not built |
| `scripts/review-engine/program.mjs`: the verbs `check`, `ready`, `seed-file`, `sync-board`, `status` | not built |
| The on-demand rule `.claude/rules-ondemand/review-engine.md` | not built |
| The seed: the cards and the edges that come from `map.md` | not built |

- Until T2.1 lands, a claim by id on a `blocked` card succeeds. The HOLD rule is the only guard.
- Until the seed, the lane board shows the old cards, and every `re-` card is `blocked`.
- After the seed, a wave 0 lane stays `blocked` until GO. A held lane stays `blocked` until its hold ends.
  A lane with open dependencies sits in `backlog`, where the dependency gate refuses a claim.
  (Reading of the map and plan section 3.3.)
- Order to GO: this folder, T2.1, `program.mjs` with the rule, the seed, the cold-start tests, Dave's GO.
