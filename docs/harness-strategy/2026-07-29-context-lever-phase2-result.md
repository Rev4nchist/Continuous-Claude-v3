# Context lever, phase 2 — result

Executed 2026-07-29, session `9b863a11`, against the plan in
`2026-07-29-context-lever-phase2-plan.md`. Commits: `b800899` (sync fix), `d272454` (the split).

## Measured (the only acceptance measure)

| | before phase 1 | after phase 1 | after phase 2 |
|---|---|---|---|
| continuous-claude memory files | 145.6k (96 files) | 81.1k (50) | **72.2k** |
| agent-arch (control) | 82.1k (51) | 82.1k | **73.2k** |

Phase 2 recovered **8.9k/session**. Both projects dropped **exactly 8.9k**, which is the
control the plan asked for: a project using none of these tools sees the same drop, so the
cost was global, not project-specific. Cumulative across both phases: **145.6k → 72.2k**.

Skills stayed at **13.8k** before and after. Skill *bodies* do not load until invoked, so
moving detail into a SKILL.md is genuinely free in the always-on budget — the premise the
whole thesis rests on, now measured rather than assumed.

Ignore the `Tokens:` total between the two runs (109.7k → 137.9k). That is tool-loading
variance — the first run had MCP/system tools deferred, the second loaded them eagerly.
Memory files is the controlled measure.

## What was applied — 6 rules

| rule | bytes | detail moved to |
|---|---|---|
| `codex-worker-safety` | 15565 → 9927 | `skills/codex` |
| `grok-worker-safety` | 12901 → 9447 | `skills/grok` |
| `codex-adversarial` | 10427 → 4081 | `skills/codex` |
| `kusto-cli-safety` | 7930 → 5070 | `skills/kusto-cli` |
| `tldr-cli` | 4730 → 1345 | `skills/tldr-code` |
| `browser-automation` | 2842 → 1684 | `skills/browser-dev-cycle` |

Detail is appended to each paired SKILL.md as a **verbatim pre-split snapshot**, not a
summary, so "nothing was lost" is mechanically checkable. Caveat worth carrying: that check
is guaranteed by construction and proves only no knowledge *loss*. It says nothing about
whether a split is well *judged* — the adversarial pass is what speaks to that.

## The plan's ~26k estimate was optimistic, not pessimistic

Achievable is **~13k**, of which 8.9k is now banked. The plan assumed every tool rule
compresses to ≤800 tokens. Adversarial verification says the two largest cannot:
`codex-worker` needs ~3.7k of genuine invariants and `grok-worker` ~3.4k. The plan flagged
its own figure as "bytes/4-derived and therefore likely low, in the favourable direction" —
it was wrong in the other direction, because the binding constraint was never bytes, it was
how much text is load-bearing.

**Carry this forward: the calibration error is not in bytes/4, it is in assuming a uniform
target.** A per-rule floor set by what must be true unprompted is not a number you can
estimate from file size.

## The Verify phase earned its cost

Non-optional in the plan, and correctly so. Shown ONLY the proposed kept text with the skill
unloaded — the realistic worst case — adversarial verifiers returned UNSAFE on 3 of 13 rules
and named 6 passages. All restored verbatim. The two most instructive:

- **grok's `[cli]` placement note.** The rewrite kept "the CLI auto-updates, so version pins
  are not self-enforcing" while deleting the only safe way to pin it. The obvious remedy an
  agent would reach for — a top-level `auto_update = false` — is probed to HANG the entire
  CLI, including the `grok models` call the same rule mandates before every run. Deleting a
  hazard while keeping the motivation to trigger it is worse than deleting neither.
- **codex's refuted `worker.config.toml` overlay.** The rewrite kept the slow cold-start that
  motivates the workaround and dropped the "do NOT use" prohibition against it.

Generalisation for future splits: **a prohibition is load-bearing exactly when the kept text
still contains the friction that motivates violating it.** Trimming the prohibition while
keeping the friction converts a closed question back into an open one.

## Deliberately not applied — and why

- `cma-safety`, `cli-integration-strategy`, `package-install-safety` — **no paired skill
  exists in the repo**, so shrinking them deletes rather than relocates. The plan's premise
  that "all 13 already have a paired skill" is false for these three. `skills/cma/` exists
  only in `~/.claude` (stranded by the reverse-sync bug, below); the other two have no skill
  counterpart at all — `package-install-safety`'s counterpart is a *hook*.
- `harness-update` — the proposed rewrite was **larger** than the original (2704 → 3134).
- `notion-cli` (87% retained), `sentry` (93%), `railway` (96%) — churn on safety rules for
  ~0.3k combined.
- `linear`, `neonctl` — already at target; the audit correctly proposed no change.

Remaining headroom is therefore ~4k, and every bit of it needs a decision about where detail
should live before any of it is safe to take.

## Found while closing the plan's constraint 3

`sync-claude.sh --to-repo` **copied `agents/` and silently died** — `skills`, `scripts`,
`docs`, the rules tree and the hook files were never reverse-synced. `copy_dir` ends its
`while` body with `$VERBOSE && echo "Copied: …"`; non-verbose that is `false`, so the loop →
pipeline → function all return 1 and `set -e` kills the script at the call site. With
`--verbose` everything works, which is why it survived: the only runs anyone watched were
verbose ones. `sync-to-active.sh` already had `|| true` on all 23 of its `$VERBOSE &&` lines;
the hardening never reached its sibling. Fixed in `b800899` with
`scripts/sync-claude-mapping.test.sh` (10 assertions, both directions, guard, exit codes).

Measured consequence: **4 skills exist only in `~/.claude`** — `cma`, `launch-your-agent`,
`wrap-up`, and one `.bak`. `skills` is second in `SYNC_DIRS`, right after `agents`, so it
never once made it back. This is why `cma-safety` has no skill home in the repo.

Two notes for whoever writes the next such test. The first version of that test **passed
against the broken script**: with only `rules/` in the fixture, the rules copy completed
before the abort and every mapping assertion went green. A fixture that contains only the
thing you are testing cannot detect an abort that happens after it. And the plan's
constraint 3 was right to insist on empirical verification — reading plus `bash -n` had
already blessed this script twice.

## Also corrected while here

- `~/.claude/` is a git repo with **no remote**, last commit 2026-06-04. Not a broken hook:
  `git-auto-commit` is `PostToolUse | Write|Edit`, so it fires only on direct edits, and
  since the 2026-06-01 "repo is source of truth" change everything arrives by shell copy.
  `rules/` is now snapshotted there, but **this drift recurs by design after every forward
  sync** — the snapshot is a floor, not a fix.
- The fossil `.claude/scripts/sync-claude.sh` (and its `~/.claude` mirror) does **not**
  recreate the phase-1 duplicate, contrary to a first reading. `REPO_ROOT="$(dirname
  "$SCRIPT_DIR")"` roots it at `.claude/`, so it writes to `.claude/.claude/` — junk one
  level too deep. Still unactioned cruft with a June 2026 review verdict (D7d-02, D8a-03)
  recommending deletion of both copies.

## Open

1. `b800899` and `d272454` are **unpushed**; the `~/.claude` rules snapshot is local-only.
2. The 4 active-only skills need one `--to-repo` run to be captured — now that reverse-sync
   actually works. Requires a clean repo tree first.
3. The 3 homeless rules need a decision on where their detail should live before phase 2's
   remaining ~4k is safe to take.
4. The fossil sync scripts still await the June review's recommended deletion.
