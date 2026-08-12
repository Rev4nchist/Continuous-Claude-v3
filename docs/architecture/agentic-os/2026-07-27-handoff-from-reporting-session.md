# Handoff to c22279d5 — from 0e1e2e2b (reporting-tracker-spine)

This is **one half** of the combined handoff. The other half is d3c53258's
(coordination bus, schema, GPU crash lane). Read both; where we disagree, the
disagreements are marked below and are not yet resolved.

**Status of my lane: DONE.** `reporting-tracker-spine` is closed and verified. It
will keep reading `active` on the board until `lane.mjs done` is patched — see
"the board cannot show completion" below.

---

## What shipped

`scripts/work-tracker/` — the Weekly Work Tracker spine. Commits `b9ddb11`,
`fdb32fe`; Phase 0 record in `079bb6f`, `69106e6`.

- **`propose-rows.mjs`** — read-only by construction. Derives candidate rows from
  `git log`, groups by scope **+ date + top-level directory** (scope alone fuses
  unrelated work — a premortem predicted it and it fired on the first live run),
  and dedups on commit SHA against existing rows.
- **`apply-rows.mjs`** — the write path, behind four gates: a named proposal id,
  a freshness re-read of git HEAD and the Tracker before any write, explicit row
  selection with **no `--all`**, and approver + timestamp in the row body that
  distinguishes corrected fields from accepted machine guesses.
- 25/25 tests, `scripts/work-tracker/test/apply-rows.test.mjs`.

**Result: Tracker went 78 → 124 rows.** 46 rows applied covering 2026-07-11 to
today, zero failures. Before this, the newest row was 07-25 while two weeks of
shipped work existed in git and in nothing any report reads.

Six commits were **deliberately excluded** as machine churn, not work:
`b855583`, `706fb92`, `950fb26`, `a37a9b7`, `b840bc3`, `2815f70` — hook
auto-commits and committed generator output. If a future sweep re-proposes them,
that exclusion was a judgement call, not a bug.

---

## What I got wrong, so you don't inherit it as fact

1. **I buried work while fixing burying.** Applying one row dated 07-26 advanced
   the watermark past three unlogged 07-25 commits, leaving them neither proposed
   nor logged. A high-water mark cannot see behind itself. Fixed with a 14-day
   lookback that reports what the watermark stepped over — it immediately found
   38 such commits. **Assume the same class of hole exists elsewhere**: anywhere
   a "newest seen" cursor is the only dedup, older stragglers vanish silently.

2. **A hand-picked window is not a watermark.** Every `--since` proposal was
   un-appliable because the override was stored *as* the watermark, so the
   freshness check compared a typed value against a derived one. The gate refused
   correctly; the bug was mine (`fdb32fe`).

3. **My first Phase 0 commit message claimed a durable record that did not
   exist.** `thoughts/` (`.gitignore:89`) and `.claude/logs/*.jsonl`
   (`.gitignore:35`) are both untracked. Anything written there **does not leave
   this machine.** The Phase 0 record is at
   `docs/reporting/2026-07-27-phase0-observations.md`; this handoff is likewise
   under `docs/` for the same reason. **Check the ignore rules before you promise
   anyone a durable artifact.**

---

## Phase 0 verdict — full Phase 2 scope stands

All three pipelines have an observation. **None of them clears anything.**

| Pipeline | Period | Task | Rows | Verdict |
|---|---|---|---|---|
| Self-Improvement | 07-27 | `0xC000013A` | 1 | CONFOUNDED |
| Project-Cards | 07-27 | `0` | **0** | **MISS** |
| Dashboard-Sync | 07-26 | `0` | 1 | PASS_WITH_WARN |

- **Project-Cards is the finding.** It exited 0, refreshed 10 cards, and left no
  registry row: the pre-emit died on `ntn spawnSync ETIMEDOUT` and was swallowed
  as non-fatal, then the box fell over before completion. **The local `$TEMP`
  artifact survived with its runId** — preserved at
  `.claude/logs/phase0-artifacts/`. That is precisely what the Phase 2a
  reconciler replays, and it is no longer a hypothetical case.
- **The 07:55 kill was a crash, not a reboot** (System event 6008). c22279d5 has
  since established it was an NVIDIA bugcheck, one of eight. Consequence for
  every diagnostic record: **any unexplained kill in the 07-25 evening or 07-27
  morning windows must be checked against those timestamps before being blamed on
  code.** Self-Improvement's `0xC000013A` is explained by the crash and does
  **not** show the `claude -p` hang recurring.
- Every clean-box observation is still outstanding. The three runs above happened
  on a box that was sick or about to crash. Deadline 2026-07-29 does not move.

---

## The board cannot show completion — and that is not cosmetic

`lane.mjs` `done` / `release` / `state` **all fail**: the UPDATE passes four
parameters but the SQL references only `$1`, `$2`, `$4`; `$3` is unreferenced, so
Postgres cannot infer its type and rejects the statement. Exit code 1, nothing
mutates. c22279d5 reproduced it non-destructively and has the minimal fix.

**Nothing has ever been marked done through the CLI.** Every "done" lane on the
board was seeded that way. Until this lands, the board is an intake register, not
a completion record — do not read an absence of completions as an absence of
work.

c22279d5 also found that the denial message renders a holder's last heartbeat
**4.5 hours in the future** (`timestamp without time zone` holding UTC, parsed as
local). The *decision* is unaffected because the comparison is pure SQL under a
UTC session, but the *display* makes a dead holder look alive — and it only stays
correct because that session TimeZone happens to be UTC.

---

## What I think actually gates "begin building the Agentic OS"

Grounded in `docs/architecture/agentic-os/build-plan.md`, whose Phase 0 gate is
"approved v1 scope, threat model, data-classification matrix, test fixtures,
sandbox deployment proof, Notion recovery objective, and the complete ADR set."
**None of that is done**, and no lane currently tracks the ADRs.

What exists today: `apps/agentic-os/` has three schema files
(`project`, `lane`, `coordination-event`), four migrations, a read-only `public`
guard, and no application code. The lane bus is live and rendering. That is the
substrate, not the product.

My read of the ordering, offered as argument not conclusion:

1. **`conflict-events`** — step 4, and the most retrofit-hostile item in the
   plan. A block or stale-takeover is computed in `file-claims.ts` and thrown
   away. Every day without it is evidence that can never be recovered.
   Note: `claim_degraded` is defined and **nothing emits it**, and `claim_blocked`
   has a lifetime count of zero — the lock has never blocked anyone. Whether that
   is health or blindness is currently unanswerable, which is the point.
2. **`claude-p-hang`** — three pipelines that die at the headless step. This is
   the one that will make the OS lie about its own health, and Phase 0 shows the
   always-emit contract faithfully recording a run that genuinely broke.
3. **`harness-security`** — post-commit sync replaces the global `mcpServers` key
   wholesale from a repo-tracked file, unvalidated, and `origin` is a third-party
   upstream with `git pull` in the documented workflow. A build-time risk, not a
   runtime one, which is exactly why it gets skipped.
4. **The ADRs.** Phase 1 cannot start without the runtime-adapter and
   `SessionStore` decisions, and nothing is tracking them.

**Stale on the board:** `agentic-os-board` still says the schema "holds only
project + project_alias and zero lanes." 22 lanes are seeded and the board renders
from the DB. That lane should move off backlog or be re-scoped.

---

## Open, explicitly not done

- **11 rows undecided.** A wider `--since 2026-07-11` window surfaced Fable-manual,
  tri-model and Game Plan commits I had no basis to type. Recover with
  `node scripts/work-tracker/propose-rows.mjs --since 2026-07-11`.
- **`--apply` has no undo.** A wrong row is corrected by hand in Notion.
- **Impact is the weak field.** 31 High / 85 Mid / 8 Low across 124 rows, and I
  set Impact on 46 of them from context, not from a rule. The provenance body
  records which values were corrected versus accepted, so a wrong one is
  traceable — but treat Impact as the least trustworthy column in the spine.
- **Phase 2a reconciler not built.** Specified in the plan, live specimen
  preserved, lane `reporting-registry-reconcile` seeded and unclaimed.
