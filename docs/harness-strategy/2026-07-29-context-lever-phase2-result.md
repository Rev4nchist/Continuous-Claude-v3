# Context lever, phase 2 — result

Executed 2026-07-29 against the plan in `2026-07-29-context-lever-phase2-plan.md`, over two
sessions the same day.

- **Phase 2a**, session `9b863a11` — `b800899` (sync fix), `d272454` (6 rules split).
- **Phase 2b**, session `131683fe` — `bea25d2` (tree cleanup), `014d2c6` (recover the stranded
  skills), `6e6fdee` (the last 3 rules + the verbatim checker), `bdec8f7` (pin the snapshots).

Phase 2 is **complete**: 9 of 13 tool rules split, 13.7k/session recovered, all nine archived
snapshots machine-verified byte-identical to the text they replace.

## Measured (the only acceptance measure)

| | before phase 1 | after phase 1 | phase 2a (6 rules) | **phase 2b (9 rules)** |
|---|---|---|---|---|
| continuous-claude memory files | 145.6k (96 files) | 81.1k (50) | 72.2k | **67.4k** |
| agent-arch (control) | 82.1k (51) | 82.1k | 73.2k | **68.4k** |

Phase 2 recovered **8.9k** on the first six rules and a further **4.8k** on the last three,
**13.7k/session** in total. At every step both projects dropped *exactly* the same amount,
which is the control the plan asked for: a project using none of these tools sees the same
drop, so the cost was global, not project-specific. Cumulative: **145.6k → 67.4k**.

Skills went 13.8k → 14.0k across phase 2b. That +0.2k is the `cli-integration` skill's
*description* entering the listing; its 6.5k body stays unloaded until triggered. That is the
whole trade, priced.

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

### "Mechanically checkable" was itself unchecked, and was wrong in 3 of 6

Phase 2b built the checker that phase 2a assumed — `scripts/verify-rule-archive.mjs` extracts
the fenced block after each `<!-- archived-rule:NAME ref:SHA -->` marker and byte-compares it
to that rule's text at the pinned pre-split commit. Running it found three of the six snapshots
(`browser-automation`, `tldr-cli`, `grok-worker-safety`) were **not** byte-identical: the
appender had rewritten inner ` ``` ` fences as `` ` ` ` `` so they would not close the outer
3-backtick fence, mutating exactly the code blocks a reader most wants to copy. The other three
passed only because they happened to contain no code fences. All repaired by re-emitting inside
a 4-backtick fence, which carries 3-backtick content intact.

```
node scripts/verify-rule-archive.mjs      ->  pass=9 fail=0 skip=0
```

Two design notes worth reusing. Each marker **pins its own commit**, because one global `--ref`
cannot be right for snapshots taken in different commits — run bare, the first version reported
`pass=3 fail=6` on a set that was entirely correct, comparing six snapshots against their own
*post*-split rules. A gate whose default invocation indicts healthy work is one people learn to
ignore. And the script **exits 1 when it compared nothing**, because a green verdict over an
empty set is the failure mode that let a `PASS | 0 registrations` health check stand for months.

The general lesson: *a construction-guaranteed property is still worth testing, because the
guarantee lives in the generator and generators have bugs.* "Verbatim by construction" was true
of the intent and false of the output for half the cases, and nobody would have noticed by
reading — the mangling is invisible unless you diff.

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

## The three "homeless" rules — resolved (phase 2b, same day)

They were skipped because shrinking them would have *deleted* rather than relocated. Each got
a home that matches where the thing actually lives, rather than defaulting to "a skill":

| rule | bytes | home | why that home |
|---|---|---|---|
| `cma-safety` | 6888 → 3066 | `skills/cma` | **was never really homeless** — the skill existed only in `~/.claude`, stranded by the reverse-sync bug below. One `--to-repo` run recovered it (`014d2c6`) |
| `cli-integration-strategy` | 6552 → 2065 | `skills/cli-integration` (new) | trigger-shaped — "give Claude access to platform X" — so a skill loads it exactly when wanted |
| `package-install-safety` | 4234 → 1736 | `docs/hooks/package-install-guard.md` | its enforcement is a **hook**, and its detail is read deliberately (interpreting a block, updating the blocklist). Inventing a skill nothing would trigger would be a home built to justify the move |

Both surviving prohibitions were kept under the phase-2a generalisation — the kept text still
carries the friction that motivates the violation. `cma` keeps "every non-`GET` is
confirm-first" plus the pause command, because a standing deployment fires where the confirm
gates cannot reach. `package-install` keeps "a block is a finding, not an obstacle" and names
all three ways round it (`SKIP_PACKAGE_GUARD`, another package manager, a shell wrapper),
because "your install just failed" is precisely the friction that produces the bypass.

## Deliberately not applied — and why

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

Items 1–3 of the original open list are **closed** (pushed through `bdec8f7`; `--to-repo` ran
and captured the stranded skills in `014d2c6`; the homeless rules are resolved above). What
remains:

1. The fossil `.claude/scripts/sync-claude.sh` and its `~/.claude` mirror still await the June
   review's recommended deletion (D7d-02, D8a-03). Destructive, so Dave's call.
2. `~/.claude` drift **recurs by design** after every forward sync. If it ever matters, the fix
   is a scheduled snapshot commit, not a hook — `PostToolUse` cannot see shell-copy writes.
3. `/recall` does not surface indexed handoffs. The write half works (rows verified in
   `archival_memory` with embeddings and correct metadata); the read half returned only
   GLOBAL-scoped rows across three attempts, including a query containing a literal string SQL
   confirms is stored. Untouched this session. Open handoffs by path, not by `/recall`.
4. The reverse-sync surfaced 10 files that are drift rather than content — 2 exact duplicates
   of top-level `scripts/msys/`, a **stale** `load-probe.mjs` 139 lines behind the top-level
   copy, and 7 unregistered leftovers in `.claude/hooks/` (two byte-identical to files already
   in `hooks/archive/`). All reverted in `014d2c6`. They will reappear on the next `--to-repo`.
   Worth cleaning at the source in `~/.claude` if that becomes annoying.

## Remaining headroom

Roughly zero on this lever without changing its shape. What is left in the always-on budget is
either genuinely load-bearing (the two worker-safety rules need ~3.4–3.7k each of real
invariants), already at target (`linear`, `neonctl`), cosmetic (`notion-cli` 87% retained,
`sentry` 93%, `railway` 96% — ~0.3k combined, on safety rules, not worth the churn), or
counterproductive (`harness-update`, whose rewrite was larger). The next meaningful reduction
would have to come from a different category than tool rules.
