# Handoff → next session: Slice 1 is functionally complete. The next phase is UI/UX.

Written 2026-07-27 ~17:00 local, from session `6c9cad30`. Supersedes
`2026-07-27-handoff-identity-to-fleet-grid.md` (that one's lane is closed).

**Everything below was verified by running it.** Where something is unproven it says so,
and those places are the most important paragraphs in this file.

---

## START HERE

```
node scripts/coordination/lane.mjs board       # the board IS the state
```

A dev server is **already running on 3010** (pid 34904 at time of writing). Open
<http://localhost:3010> and you are looking at the current product. To stop it:

```
taskkill /PID 34904 /T /F
```

`/T` is not optional — `Stop-Process` misses the spawn tree on this machine (see
`windows-platform.md`). To start a fresh one: `cd apps/agentic-os && npm run dev`.

Live board artifact (regenerated from `agentic_os.lane`, not hand-edited):
<https://claude.ai/code/artifact/9eb25020-1959-47b9-b51f-6589e0c0515a>

```
node scripts/coordination/render-board.mjs <out.html>   # then republish to that URL
```

---

## Where the work stands

`fork/agentic-os` is at **`9e772c7`**, divergence `0 0`. Six commits, all pushed:

| commit | what |
|---|---|
| `9305461` | five ADRs + a ROADMAP entry that had been describing a superseded plan |
| `18a24e5` | Slice 1 scaffold — Next 16 on 3010, Drizzle over node-postgres, ADR-0002 lint boundary |
| `132cdb1` | `scripts/machine/crash-telemetry.ps1` — pre-crash sampler |
| `f1d6cf3` | project identity data layer + the `lane.mjs` fix |
| `35d9837` | previous handoff |
| `9e772c7` | **the fleet grid** — this session |

**Slice 1's functional target is met.** The app renders 19 project cards with real
per-project session counts, a live active-sessions strip, the unmatched bucket, and the
partition arithmetic. Verified end to end against psql on a live server.

```
877 attributed + 58 unaccounted + 1,483 coordination + 0 null = 2,418
= every row in public.sessions          reconciles: true
continuous-claude: 639 sessions from 16 raw path spellings
```

---

## THE NEXT PHASE: UI/UX for the application interface

What exists now is **correct and plain**. Every number on screen is true and every claim
is qualified — that was the whole point of gating the grid behind identity. What it is
*not* is designed. That is the next phase, and the honest starting position is:

### What you are inheriting, visually

- **Tailwind v4, configured in CSS** (`src/app/globals.css`), no `tailwind.config.js`.
- **The shadcn/ui token set is already in place** — the same one the old FastAPI
  dashboard used, so components salvaged from
  `opc/scripts/dashboard/frontend/src/components/ui/` drop in without a restyle.
  Light and dark are both defined; `.dark` class variant, not media-query-only.
- **`cn()` exists** (`src/lib/utils.ts`, clsx + tailwind-merge). `lucide-react` and
  `class-variance-authority` are installed. **No shadcn components have been generated
  yet** — there is no `src/components/ui/`. That is a deliberate blank slate, not an
  oversight.
- **The palette is neutral greys plus semantic accents** picked ad hoc by me
  (emerald = live/ok, amber = attention, sky = in-development, `--destructive` = broken).
  Those are placeholders. There is no design system decision recorded anywhere.
- **`src/app/layout.tsx` is deliberately almost empty** and says why: per ADR-0005 there
  is no auth in v1, and a UI that *looks* authenticated while it is not is worse than one
  that visibly is not. **No login screen, no user menu.** If you add chrome, do not add
  chrome that implies an account.

### Design constraints that are not negotiable

These come from the ADRs and from what this screen is *for*. A redesign that violates
them is a regression no matter how good it looks.

1. **The unmatched bucket stays visible.** 58 sessions are unaccounted for. They live on
   screen next to the numbers the grid is confident about, structurally, because a
   confidently-wrong fleet grid is the one outcome worse than shipping nothing. Do not
   "clean it up" into a collapsed panel that defaults closed.
2. **`reconciles` stays surfaced.** If the partition ever fails, the UI says the numbers
   are unreliable instead of rendering a confident total. That failure state needs a
   design too — right now it is a red box I wrote in ten minutes and have never seen fire.
3. **Liveness stays legible.** A dashboard that silently stops updating is worse than one
   that is obviously broken. The header states `live / refreshing / error / paused` and
   keeps last-good data on failure. Design the *stale* and *error* states deliberately;
   they are currently functional and ugly.
4. **No component imports `db`** (ADR-0002, eslint-enforced, verified firing). Every read
   goes through `src/server/queries/`. This survives any amount of visual redesign.
5. **One `useLiveData()`** (ADR-0002). Exactly one client component calls it; everything
   else is pure props. Slice 3 swaps polling for SSE by editing that one file.

### Open design questions nobody has answered

- **19 cards with no hierarchy.** Sorted by session count descending, archived and
  zero-session projects sink to the bottom at 60% opacity. Is a flat grid right, or does
  the fleet want grouping (active / dormant / archived), filtering, or a density toggle?
- **The active-sessions strip and the grid restate each other.** A live session is both a
  card in the strip and a "just now" on a project card. That redundancy might be the
  point (two questions, two answers) or might be noise.
- **`working_on` is raw prompt text**, truncated to 140 chars in SQL. It is often a
  `<task-notification>` blob or a mid-sentence fragment. It is the most human thing on
  the screen and currently the ugliest.
- **Nothing is clickable.** Project cards are `<article>`, not links. The drill-in target
  (`aos-project-canvas`, `/project/[key]`) does not exist yet, so wiring navigation is
  blocked on that lane — or that lane is blocked on this design. Decide the order
  deliberately.
- **No empty state has been seen.** Every panel has one written, none has ever rendered.
- **Mobile is untested.** Breakpoints are declared (`sm/lg/xl`), never verified below
  1280px.

### Where to start if you are doing the design work

Read the four mockups and the product brief before drawing anything — there is prior
intent here that predates the working code:

```
docs/architecture/agentic-os/mockups/index.html
docs/architecture/agentic-os/mockups/current-state.html
docs/architecture/agentic-os/product-brief.md
docs/architecture/agentic-os/adr/0004-replace-dont-extend-the-fastapi-dashboard.md
```

ADR-0004 is the one that matters most: **the fleet is home, and every pillar is a
drill-in from a project.** That is an information-architecture commitment, not a styling
preference.

---

## The other live lane: `aos-project-canvas`

Unblocked (all three prerequisites done) and **re-noted this session** — its old note
still said "BLOCKED ON aos-scaffold AND aos-project-identity", which was false for hours.
The full brief is on the lane. The short version:

- Drill-in for one project: sessions, file claims, recent memories. Read-only.
- **The join it needs does not exist yet.** `archival_memory` joins on `project_id_hash`,
  which is deliberately NULL on all 19 rows. Do **not** reimplement the hash — Python uses
  `sha256(str(Path(p).resolve()))[:16]` and Windows `resolve()` returns the OS's canonical
  on-disk casing, so hashing the registry string diverges silently. Derive it from
  `SELECT DISTINCT project_id FROM archival_memory`, match, record the rest as unresolved.
  That is a task inside the lane, not a footnote.
- **`file_claims` is not what it looks like.** 8,138+ rows, and per the
  `coordination-layer-is-lying` finding **zero are live-owned**. Do not render them as
  current locks without saying so.

---

## Known-broken and known-missing

**Not verified: that a NEWLY INSERTED session appears within 5s.** Polling and repaint are
proven (3 fetches in 12s, `navigationEntries` stayed 1 — no reload). The `WHERE` clause
treats an insert and an update identically. But proving it outright means writing a
synthetic row into `public.sessions`, a shared table this app is deliberately SELECT-only
against, so it was left as a named gap rather than an assumption. To close it: insert one
UUID-shaped row, watch the strip, delete it, confirm the count returns to 2,418.

**`getScaffoldHealth()` is now unreferenced by the app.** Its page (`src/app/page.tsx`)
was deleted because it collided with the new route-group page at `/`. The function was
kept, not quietly deleted, because it is the ADR-0002 conventions example that
`projects.ts` cross-references. Either wire it into a real health surface or retire it
deliberately — do not let it rot as ambiguous dead code.

**`lane.mjs` still has no ownership check.** The state UPDATE is `WHERE id=$1`, so any
session can transition any lane. Carried forward from the previous handoff, still true.

**`lane.mjs` still cannot edit `rationale` or `done_when`** — only `note`. The board
renders `rationale` verbatim, so seeded rationale rots with no supported way to correct
it. This is the mechanism behind five stale-board incidents now, including the
`aos-project-canvas` note I had to fix by hand this session. **Worth fixing properly.**

**A lane note is a snapshot with no expiry.** Verify a note's factual claims before
working from them, and re-note when you falsify one.

**The telemetry sampler is unsupervised** and has died unnoticed once. A Startup-folder
entry covers reboots but not mid-session death. `schtasks /create` returns *Access is
denied* unelevated on this machine, which is why it is not a scheduled task.

---

## Traps that cost real time (this session's additions are the first two)

**Backticks inside a `` sql`` `` template literal terminate it.** A SQL comment I wrote
containing `` `count(last_activity_at)` `` produced five `TS1005` parse errors ~50 lines
from the actual cause. `tsc` points at the wreckage, not the collision.

**`tsconfig` includes `.next/types/**`, so DELETING a route leaves `tsc --noEmit` failing
on a generated validator that still imports it.** Two of my three typecheck errors named a
temp route from a *previous* session that no longer exists on disk. It reads exactly like
your own code being broken. Clear `.next`.

**`react-hooks/set-state-in-effect` will reject the obvious tab-visibility handling, and
it is right to.** Visibility is a browser subscription — read it with
`useSyncExternalStore`, do not mirror it into state from an effect.

**`sessions` timestamps are `timestamp WITHOUT time zone` holding UTC.** Any `to_char` you
write needs an explicit `Z` or the browser parses it as local — 5 hours wrong in July,
**0 hours wrong in January**. Better: compute ages server-side in seconds and never let
the browser parse a timestamp, which is what the fleet grid now does.

**A green typecheck is not evidence the app runs.** (Carried forward, still the single
most expensive lesson in this project.) Every relative import under `src/db` once carried
a `.js` extension; `moduleResolution: "bundler"` rewrites it so `tsc` passes clean while
Turbopack hard-fails and every page 500s. Keep them extensionless.

**A lint rule can be present and enforcing nothing.** `eslint-config-next@16`
default-exports a *flat* config array; wrapping it in `FlatCompat` made ESLint exit 2
having linted **zero files** while the ADR-0002 rule sat there looking correct. Never
reintroduce `FlatCompat` here.

**Next.js App Router ignores `_`-prefixed folders.** A temp route at `src/app/api/__verify/`
404s — it is a private folder, structurally excluded from routing.

---

## The machine

**MSYS fork storm is active and intermittent.** It ate roughly half my Bash tool calls
today. It is *annoying, not dangerous*: the crash is in Git-for-Windows' MSYS DLL
initialization, **before** bash reads the command, so nothing half-executes. Checked this
session: `reap.ps1` found **0 stuck processes**; the dangerous *hang* variant was not
occurring. **Use the PowerShell tool for git and shell work** — it does not go through
MSYS. Commits and pushes go through `scripts/git-safe.ps1` with
`GIT_SAFE_MAX_ATTEMPTS=7` and `GIT_SAFE_BACKOFF_SECONDS=12`; the default 4 retries were
not enough today, and a push printed a fatal MSYS line **immediately before succeeding**.
An errored line is not proof of failure — verify state.

**Two crashes on 2026-07-27, by two different mechanisms.** 07:55:11 was an NVIDIA
bugcheck `0x116`, the eighth of that family. 13:31:13 was a **different class** —
Kernel-Power 41 with `BugcheckCode=0`, no WER 1001, no minidump, dead 19 minutes despite
`AutoReboot=1`. Root cause not established and deliberately not invented.

**The ASPM falsification clock is intact — do not reset it.** The 13:31 crash was not a
`0x116`, so it does not count against the mitigation. `crash-watch.ps1` reads TOO EARLY
with ~13.7 days to go.

**Correction to `windows-platform.md` still outstanding:** its "do not re-chase running AV
filter drivers (**none**)" is wrong. An elevated `fltmc` shows `MsSecFlt` (7 instances)
and `WdFilter` (5) both Running. That exclusion belongs back on the list for the
`msys-fork-storm` lane.

---

## Guardrails

- **`scripts/project-cards/state.json` is USER-OWNED** — read it, never commit it. It is
  dirty right now with machine runtime state; leave it.
- **`sites/fastmcp-v3/`** is a nested independent git repo plus ~29,728 `node_modules`
  files. It needs a deliberate submodule/subtree decision — do not `git add` it.
- **NEVER `drizzle-kit push`.** Shared DB, 40 `public` tables owned by three other apps.
  Flow is generate → read the SQL → `db:check` → `migrate`. Seeding is DML and touches no
  migration; `db:generate` must keep reporting no changes.
- **Seeding writes with `AGENTIC_OS_INDEXER_DATABASE_URL`**, never the app URL — the app
  role is SELECT-only and that is the only real enforcement boundary in a no-auth v1.
- **`fork` = Rev4nchist. Never push `origin`** (parcadei, third-party upstream).
- **Prefer `git commit --only <paths>`.** The exposure starts at `add`, not at commit, and
  another session is often live. Untracked files need `git add -N` first — check
  `sessions` for live peers in *this* repo before you do (a session in a different repo
  cannot touch this index).

---

## Verification you can re-run

```
node scripts/coordination/lane.mjs board
cd apps/agentic-os && npm run lint && npm run typecheck && npm run build
npm run db:check && npm run db:generate                      # must emit NO migration
node apps/agentic-os/scripts/seed-projects.mjs --dry-run     # must report 0 changes
powershell -File scripts/gpu/crash-watch.ps1                 # GPU verdict
powershell -File scripts/machine/crash-telemetry.ps1 -Report # find the GAP
pwsh -File scripts/msys/reap.ps1                             # dry-run stuck-bash check
```

Live truth check against the database, which is the one that actually matters:

```
curl -s http://localhost:3010/api/mission-control | node -e "..."   # vs:
docker exec continuous-claude-postgres psql -U claude -d continuous_claude -c \
  "SELECT count(*) FILTER (WHERE id LIKE 's-%') AS hb, count(*) AS total FROM public.sessions;"
```

**Slice 1 is functionally done.** It is done *well* when the screen above is something
Dave opens by choice rather than to check whether it still works.
