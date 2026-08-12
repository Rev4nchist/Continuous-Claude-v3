# Handoff → next session: the data layer is hardened. UI/UX is now genuinely next.

Written 2026-07-28 from session `903600b6`. Supersedes
`2026-07-27-handoff-fleet-grid-to-uiux.md`, which is still worth reading for the
UI/UX brief — this file replaces its *data* sections and carries its design
sections forward with corrections.

**Everything claimed here was verified by running it.** Where something is
unproven or heuristic it says so, and those are the paragraphs that matter most.

---

## START HERE

```
node scripts/coordination/lane.mjs board          # the board IS the state
```

A dev server is running on **3010, pid 34904**. Open <http://localhost:3010> and
you are looking at the current product. To stop it:

```
taskkill /PID 34904 /T /F
```

`/T` is not optional — `Stop-Process` misses the spawn tree on this machine. To
start fresh: `cd apps/agentic-os && npm run dev`.

**Use the PowerShell tool for shell work.** The MSYS fork storm ate roughly half
this session's Bash calls (`add_item ... failed, errno 1`). It is annoying, not
dangerous: the crash is in DLL init before bash reads the command, so nothing
half-executes. Commits and pushes go through `scripts/git-safe.ps1` with
`GIT_SAFE_MAX_ATTEMPTS=7` and `GIT_SAFE_BACKOFF_SECONDS=12`.

`fork/agentic-os` is at **`0f2e8dd`**, divergence `0 0`, working tree clean.

| commit | what |
|---|---|
| `2a73a61` | ingestion writer + harness became a dimension |
| `0f2e8dd` | poller starvation + the absolute clock |

---

## What this session was for

The instruction was: *data ingestion, reporting, organization and interface
updates must be working correctly and reliably before we make things look good.*
That was the right call. A 12-agent, 6-dimension read-only audit (each finding
adversarially verified by a second agent) found one **critical** defect in every
dimension it looked at, including two that had been silently wrong for months.

---

## What shipped

### 1. `last_activity_at` finally has a writer

It has been declared in `docker/init-schema.sql` since the fork and read by the
fleet grid, and **nothing anywhere in the repo ever wrote it** — 0 of 2,435 rows.

`.claude/hooks/src/shared/session-touch.ts` is its writer, called from
`periodic-extract.ts`. That host is not arbitrary: it is the **only node hook
registered on PostToolUse with an empty matcher**, so it already spawns on every
tool call and a per-tool liveness stamp costs zero additional process spawns.
Measured **+29 ms** (78 ms vs 49 ms bare node). Throttled to 30 s, UPDATE-only,
fail-open, never rejects.

**Why this mattered more than it sounds.** `heartbeat.ts` runs on
`UserPromptSubmit` *only* — it measures the human typing, not the agent working.
Sampled every 20 s for 8 minutes against a session running a 12-agent workflow:

```
12:18:56  last_heartbeat=12:12:12   403s stale
12:20:37  last_heartbeat=12:12:12   505s stale   <- peak
12:20:57  last_heartbeat=12:20:52     6s stale   <- the ONE write in 8 minutes
12:26:44  last_heartbeat=12:20:52   352s stale   and climbing
```

A dashboard whose entire subject is autonomous agents was decaying toward "dead"
precisely while the agents did the most work.

`getActiveSessions` now admits and orders on `GREATEST(last_heartbeat,
last_activity_at)` and exposes `activitySecondsAgo` / `liveSecondsAgo`. The strip
colours its dot on liveness, not heartbeat. It caught the bug live on another
session: `9370e196`, 442 s of heartbeat silence and a 5-second-old tool call —
7.4 minutes from being declared dead mid-work.

The dashboard needed **no query change** to pick up the new column, because the
previous session wrote `GREATEST` rather than `COALESCE` precedence specifically
so this would happen. That paid off exactly as designed.

### 2. Harness is a dimension, not a filter

**`~/.codex/hooks.json` registers `session-register`, `heartbeat` and
`file-claims` from `~/.codex/hooks/dist/` dated 2026-05-04** — three months
stale, carrying the pre-identity-fix `generateSessionId()` code, and **still
writing into `public.sessions` today**. 168 rows carry UUIDv7 thread ids (Claude
Code writes v4), all with raw backslash paths, first appearing six days after
that mirror was built.

Per card, under the old number that just said "sessions":

```
agent-arch  40.9% Codex   ·   fourth-salesforce-mcp  36.5%   ·   linkmap  33.3%
```

So the `s-*` shape **no longer short-circuits the bucket CASE**. It was first,
which discarded 1,483 rows' project attribution before the alias join ever ran —
and those rows are SessionStart registrations from the pre-2026-07-26
double-registration bug, *not* the "coordination heartbeats" that three separate
files called them. `sessionCount` is now every session in every harness, minus
provable duplicates:

```
attributed 2011 + unaccounted 202 + duplicates 238 + null 0 = 2451   reconciles: true
byHarness  claude 768 · codex 138 · legacy 1101 · other 4  = 2011

continuous-claude 656 -> 1456    fourth-salesforce-mcp 63 -> 133    agent-arch 44 -> 89
```

**The duplicate match is a heuristic and the UI says so.** It is the STRICT
raw-path-within-90 s match (238 rows), not the alias-resolved one (564). The
resolved version collapses more but treats two unmapped paths as equal
(`NULL = NULL`) and would merge genuinely distinct sessions. So `legacy` is an
**upper bound** on distinct legacy sessions, and both the DTO comment and the UI
tooltip state that rather than implying a precision the join cannot support.

### 3. The poller no longer kills its own requests

`fetchOnce()` opened by aborting whatever was in flight, while the interval fired
unconditionally every 5 s. **Any response slower than 5 s was therefore cancelled
by the next tick, which started a request cancelled by the tick after it,
forever.** No fetch could complete again. And because the abort path returned
early *without* setting an error or counting a failure, the header never left
"refreshing", `consecutiveFailures` stayed 0, and the screen presented frozen
data with no indication anything was wrong.

The "only one request in flight" guarantee was right; enforcing it by killing the
**running** request rather than skipping the **new** one was not. Reproduced in a
real browser with fetch delayed 8 s against the 5 s interval:

```
started 4 · completed 4 · aborted 0 · header "updated 0s ago"
```

The audit measured the old code under identical conditions at 7 issued, 6
aborted, 0 completed.

Two things came with it. Requests get a **15 s deadline** — skip-alone would have
traded starvation for a different permanent stall, since one hung request with no
timeout blocks every future poll; a timeout counts as a real failure and says so.
And the polling effect's cleanup nulls the in-flight ref **synchronously** rather
than leaving it to the aborted request's `finally` (a microtask later), otherwise
the fetch on tab-refocus sees a stale ref and skips itself.

### 4. There is an absolute clock on screen

`generatedAt` had been computed on every snapshot since the endpoint was written
and rendered **nowhere**. The header now shows `data as of HH:MM:SSZ`.

It is **sliced from the ISO string, never parsed into a `Date`** — `new Date()`
renders local on the client and UTC during SSR (a hydration mismatch), and these
are UTC-bearing `timestamp without time zone` values, the exact class of bug this
project has already paid for twice.

The error state also stopped deleting the age. Verified under a simulated total
outage:

```
stale 32s — 6 failed refreshes · data as of 15:36:01Z · simulated network failure
```

The absolute stamp **frozen** while the relative age climbs. One says the data
has not moved; the other says the page is alive and trying. Previously this state
showed neither.

### 5. Hygiene

`.claude/settings.local.json` is untracked and ignored. It had been committed to
a pushed repo carrying 21 permission grants (including `Bash(powershell:*)` and
`Bash(node:*)`), **zero deny entries**, and `enableAllProjectMcpServers` — while
`.claude/rules/sync-known-gaps.md` declares it "NEVER sync". No secrets in it, so
nothing to rotate, and the file is untouched on disk.

---

## What is NOT done, ranked

**1. The stale Codex mirror is still writing.** Classifying its rows made it
visible; it did not stop it. Every new Codex session still lands raw
un-normalized paths in the shared table, which is what manufactures alias drift.
Dave's decision, recorded: *keep the sessions, show them separately.* That is
done — but the mirror should still be either rebuilt from current source or
deregistered, because it is running three-month-old code against a shared
database.

```
Select-String -Path "$env:USERPROFILE\.codex\hooks.json" -Pattern 'session-register|heartbeat|file-claims'
Get-Item "$env:USERPROFILE\.codex\hooks\dist\session-register.mjs" | Select-Object LastWriteTime
```

**2. ~~No session-END writer exists.~~ DONE 2026-07-28.** `sessions.ended_at` /
`end_reason` now exist and `coordination-release.ts` writes them, concurrently
with the claim release so a dead database costs one timeout at exit rather than
two. "Ended" is defined RELATIVELY at read time — `ended_at >= GREATEST(
last_heartbeat, last_activity_at)` — so a resumed session un-ends itself with no
clearing write anywhere, and no hook ordering requirement.

A missing `ended_at` still means **UNKNOWN, never "crashed"**: SessionEnd cannot
fire for a process that was killed, and every row written before this date
predates the writer. Lease expiry remains the backstop, which is why it still
exists. Gate: `node scripts/coordination/session-lifecycle-probe.mjs` (7/7,
exercises the real hook bundle against the real database and cleans up after
itself).

**3. ~~`public.sessions` has no index for the liveness query.~~ DONE 2026-07-28**
— along with item 2 above; both were DDL on the same table, so they were one
migration or none. Seq Scan → Index Scan, 48 buffers → 5, 0.412 ms → 0.054 ms,
and 2,450 rows discarded per poll → 0.

**CORRECTION to what this section originally said.** It prescribed "generate →
read the SQL → `db:check` → `migrate`". That is wrong for this table and would
have wasted the next session's time. `public.*` declarations live in
`src/db/readonly/` and are **deliberately excluded** from `drizzle.config.ts`'s
`schema` glob — the file says so, because drizzle table declarations are not
inert to drizzle-kit even under `schemaFilter`. Verified by running it:
`db:generate` reports `6 tables` (all `agentic_os`) and `No schema changes,
nothing to migrate`. It cannot see `public.sessions` and never will.

DDL on the shared `public` schema is **hand-written SQL**, following the
established `scripts/coordination/migrations/` pattern that
`docker/init-schema.sql` already points at for `file_claims`. The standing rule
is unchanged and load-bearing: **never `drizzle-kit push`.**

**4. 88% of `claim_takeover` rows carry an old detail schema** with
`holderClaimedAt` values up to 5 hours in the **future**.

**5. `lane.mjs` state UPDATE still has no ownership check** — any session can
transition any lane, including another session's active lane to done. Also still
cannot edit `rationale` or `done_when`, and `render-board` prints them verbatim,
which is the mechanism behind five stale-board incidents.

**6. The board's "held now" counter counts abandoned lanes as held** — it never
consults `lease_expires_at`, so the headline contradicts the detail rows below
it, which correctly print "lease lapsed".

**7. Three files still give three inconsistent definitions of an `s-*` row**
(`projects.ts`, `sessions.ts`, `readonly/public.ts`), and `readonly/public.ts`
carries stale counts — it says `fileClaims` is "8,138+ rows" when the table holds
103.

Everything above has a repro command on the `aos-data-hardening` lane note.

---

## Traps this session added

**Backticks inside a `` sql`` `` template literal terminate it.** This is the
second session to lose time to it. I wrote `` `duplicates` `` inside a SQL
*comment* and got three `TS1005` errors pointing ~40 lines away from the cause.
The fix is in the file as a comment so the next person does not repeat it. There
is now a one-line detector:

```
Select-String -Path apps/agentic-os/src/server/queries/*.ts -Pattern '^\s*--.*`'
```

**`git commit --only` fails on an untracked file** with `pathspec ... did not
match any file(s) known to git`. Run `git add -N <file>` first.

**A safety guard blocks `git rm --cached -r` on a protected path** because it
reads it as a deletion. It cannot distinguish untracking from removal. Do not
route around it — split the operation or leave it.

**PowerShell has no `<` redirect operator.** Pass SQL with `-c "..."`, not file
redirection.

**`node -e 0` is ~50 ms on this machine now, not the p50 2,611 ms** recorded in
the `machine-spawn-latency-pathology` memory. That pathology (the runaway Devin
git crawl) is genuinely gone. Do not budget against the old figure.

---

## The UI/UX phase

The previous handoff's design brief still stands and should be read in full:
`2026-07-27-handoff-fleet-grid-to-uiux.md`, plus
`docs/architecture/agentic-os/mockups/`, `product-brief.md`, and **ADR-0004**
(the fleet is home; every pillar is a drill-in from a project — an
information-architecture commitment, not a styling preference).

Its five non-negotiable constraints are unchanged: the unmatched bucket stays
visible, `reconciles` stays surfaced, liveness stays legible, no component
imports `db`, exactly one `useLiveData()`.

**What this session changes about that brief:**

- The stale/error states it called "functional and ugly" are now *correct* as
  well as ugly. They have real content to design around: a frozen absolute
  stamp, a climbing relative age, a failure count, and a server message.
- Cards now carry a harness breakdown line (`claude 583 · codex 85 · legacy 784`)
  in monospace under the count. It is truthful and plain. It has had **no design
  attention** and is the most obvious thing to fold into a real card layout.
- The numbers moved a lot. Any mockup drawn against `continuous-claude: 656` is
  now against 1,456. Sizes and column widths change.
- `sessionCount` now means *every session across every harness*. Dave's stated
  direction is that this dashboard should eventually **manage, run, spin up and
  interact with sessions** — so treat identity and liveness as load-bearing
  product surfaces, not chrome.

The six open design questions from the previous handoff are all still open, and
one is now sharper: **the active-sessions strip has three numbers per session**
(`active`, `tool`, `prompt`) where it used to have one. That is more honest and
visually worse. Deciding which of them a human actually needs at a glance is a
real design question, not a formatting one.

---

## Verification you can re-run

```
cd apps/agentic-os
npm run typecheck && npm run lint && npm run build      # all clean at 0f2e8dd
npm run db:check && npm run db:generate                 # MUST emit no migration
node scripts/seed-projects.mjs --dry-run                # MUST report 0 inserted
```

The partition, re-derived against the database rather than trusted:

```
docker exec continuous-claude-postgres psql -U claude -d continuous_claude -A -F '|' -c "SELECT CASE WHEN id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4' THEN 'claude' WHEN id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7' THEN 'codex' WHEN id LIKE 's-%' THEN 'legacy' ELSE 'other' END AS harness, count(*) FROM public.sessions GROUP BY 1 ORDER BY 2 DESC;"
```

Then compare to `curl -s http://localhost:3010/api/mission-control`. The API's
`byHarness` counts only *attributed* rows, so it will be lower than the raw
totals by the unaccounted + duplicate rows — that difference is the point of the
accounting bar.

Liveness, end to end:

```
docker exec continuous-claude-postgres psql -U claude -d continuous_claude -A -F '|' -c "SELECT id, last_heartbeat, last_activity_at FROM public.sessions WHERE last_activity_at > NOW() - INTERVAL '10 minutes';"
```

If your own session appears there with a fresh `last_activity_at`, the ingestion
fix is working in your session right now.

---

## Guardrails (carried forward, all still true)

- **`scripts/project-cards/state.json` is USER-OWNED** — read it, never commit it.
- **`sites/fastmcp-v3/`** is a nested independent git repo plus ~29,728
  `node_modules` files. Do not `git add` it.
- **NEVER `drizzle-kit push`.** Shared DB, 40 `public` tables owned by three
  other apps.
- **Seeding writes with `AGENTIC_OS_INDEXER_DATABASE_URL`**, never the app URL —
  the app role is SELECT-only and that is the only real enforcement boundary in a
  no-auth v1.
- **`fork` = Rev4nchist. Never push `origin`** (parcadei, third-party upstream).
- **Prefer `git commit --only <paths>`.** Exposure starts at `add`, not commit.
- **A lane note is a snapshot with no expiry.** Verify a note's factual claims
  before working from them, and re-note when you falsify one. This session
  falsified two: `file_claims` is 103 rows and not "8,138+", and the audit's own
  885-orphan figure was low (1,245 same-project).
