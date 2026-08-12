# Handoff → next session: Slice 1 is two-thirds built, the fleet grid is next

Written 2026-07-27 ~16:10 local, from session `2b0b3ae2`. Everything below was verified by
running it, not by reading it. Where something is inferred or unproven, it says so.

---

## START HERE

```
node scripts/coordination/lane.mjs board          # the board IS the state
node scripts/coordination/lane.mjs claim aos-fleet-grid
```

**Your lane is `aos-fleet-grid`.** It was blocked on `aos-scaffold` and
`aos-project-identity`; **both are now done and pushed**, so it is unblocked and is the
only thing standing between this project and a screen Dave can actually look at.

The board renders live from `agentic_os.lane`. There is also a published artifact of it —
regenerate and republish rather than hand-editing:

```
node scripts/coordination/render-board.mjs <out.html>
# then publish to https://claude.ai/code/artifact/9eb25020-1959-47b9-b51f-6589e0c0515a
```

---

## What shipped (all pushed — `fork/agentic-os` is at `f1d6cf3`, divergence `0 0`)

| commit | what |
|---|---|
| `18a24e5` | Slice 1 scaffold — Next 16 on **3010**, Drizzle over node-postgres, ADR-0002 lint boundary |
| `132cdb1` | `scripts/machine/crash-telemetry.ps1` — pre-crash sampler |
| `f1d6cf3` | project identity data layer + the `lane.mjs` fix + a `.gitignore` credential leak |

**The app runs.** `npm run dev` in `apps/agentic-os` serves on 3010, connects as
`agentic_os_app` (SELECT-only), and renders live data. Verified HTTP 200 with a rendered
count matching psql exactly, and an `INSERT` refused with *permission denied*.

**Identity is seeded:** `agentic_os.project` = **19**, `project_alias` = **115**,
`lane` = 28.

**The partition balances**, verified end-to-end through a live dev server:
```
877 mapped + 58 unmatched + 1483 heartbeats + 0 null = 2418 = every row in public.sessions
```
`continuous-claude` absorbs **16 raw spellings into 639 real sessions**.

**Six lanes closed** — the first completions ever recorded through the CLI (see below).

---

## Your lane: `aos-fleet-grid`

Everything it needs already exists. **`getFleetOverview()` in
`src/server/queries/projects.ts` is your data source** — do not write new SQL against
`sessions` in a component.

```ts
{
  projects: [{ key, displayName, status, port, url, sessionCount, rawSpellings, lastActivityAt }],
  unmatched: {
    sessionCount, rawCount,
    rejected:     { sessionCount, rawCount },   // confidence 0.0 — not a project
    notOnboarded: { sessionCount, rawCount },   // confidence 0.5 — real, not in the registry
    unseen:       { sessionCount, rawCount },   // no alias row at all
  },
  heartbeats, nullProject, totalSessionRows, reconciles
}
```

Four things that are load-bearing, not stylistic:

1. **Render the unmatched bucket from day one.** It is in the same DTO precisely so you
   *cannot* render per-project counts without holding the number you are failing to
   account for. A confidently-wrong fleet grid is the one outcome worse than shipping
   nothing — that is why this lane was gated behind identity at all.
2. **Show `reconciles`.** If it is ever `false` the projection is lying, and the UI should
   say so rather than render a confident total.
3. **Say that counts include subdirectory and worktree sessions**, or 639 for
   continuous-claude reads as double-counting.
4. **No component imports `db`** (ADR-0002). ESLint enforces it — three probes were
   confirmed to error through the real `npm run lint` path. `server-only` and
   `serverExternalPackages: ['pg']` are the backstops.

Still OUT for Slice 1: transcripts, indexer, SSE, search, Notion, and every write path.
Polling goes behind a **single** `useLiveData()` hook so Slice 3 can swap in SSE without
touching components.

---

## Known-broken and known-missing

**`lane.mjs` has no ownership check.** The state UPDATE is `WHERE id=$1`, so any session
can transition any lane. Deliberately not fixed — it is a behaviour change affecting live
sessions and did not belong in a parameter-binding fix.

**`lane.mjs` cannot edit `rationale` or `done_when`** — only `note`. The board renders
`rationale` verbatim as the `.why` block, so seeded rationale rots with no supported way
to correct it. One had to be fixed with direct SQL this session. **This is the mechanism
behind four separate stale-board incidents today** and is worth fixing properly.

**A lane note is a snapshot with no expiry.** Verify a note's factual claims before working
from them, and re-note when you falsify one.

**The telemetry sampler is unsupervised.** It died mid-session (probably swept up by a
`taskkill /T /F` during dev-server cleanup) and nothing noticed or restarted it — the gap
is visible in its own log. Restarted as pid 25844. A Startup-folder entry covers reboots,
but **not** mid-session death. `schtasks /create` returns *Access is denied* unelevated on
this machine, which is why it is not a scheduled task.

**`project_id_hash` is deliberately NULL** on all 19 projects. Slice 3's memory panel needs
it. Do **not** reimplement the hash — Python uses
`sha256(str(Path(p).resolve()))[:16]` and Windows `resolve()` returns the OS's canonical
on-disk casing, so hashing the registry string diverges silently. Derive it from
`SELECT DISTINCT project_id FROM archival_memory`, match, and record the rest as unresolved.

---

## Traps that cost real time today

**A green typecheck is not evidence the app runs.** Every relative import under `src/db`
carried a `.js` extension; `moduleResolution: "bundler"` rewrites it so `tsc --noEmit`
passes clean, while Turbopack hard-fails and every page 500s. Keep them extensionless.

**A lint rule can be present and enforcing nothing.** `eslint-config-next@16`
default-exports a *flat* config array; wrapping it in `FlatCompat` made ESLint exit 2
having linted **zero files** while the ADR-0002 rule sat there looking correct. Only
writing the violation found it. Never reintroduce `FlatCompat` here.

**Next.js App Router ignores `_`-prefixed folders.** A temp route at `src/app/api/__verify/`
404'd — a private folder, structurally excluded from routing. Easy to misread as your query
failing.

**`git-safe.ps1`'s default 4 retries were not enough.** The MSYS fork storm ate them; the
commit did not land and the files sat staged. `GIT_SAFE_MAX_ATTEMPTS=7` and
`GIT_SAFE_BACKOFF_SECONDS=12` got it through. The reaper found **zero** stuck processes, so
this was a live cohort collision, not leftover debris.

**Use `git commit --only <paths>`, never `add` then `commit`.** The exposure starts at
`add`, not at commit. Another session was live throughout this one.

---

## The machine

**It crashed twice today**, by two different mechanisms — check timestamps before blaming
code.

- **07:55:11** — NVIDIA bugcheck `0x116`, the eighth of that family.
- **13:31:13** — a **different class**: Kernel-Power 41 with **`BugcheckCode=0`**, no WER
  1001, **no minidump** (confirmed under an *elevated* read, which is the check a previous
  session got wrong by reading access-denied as empty). Dead 19 minutes despite
  `AutoReboot=1`. **Root cause not established** and deliberately not invented.

**The ASPM falsification clock is intact — 13.7 days to go**, and zero recovered TDRs since
the mitigation. The 13:31 crash was *not* a `0x116`, so it does **not** count against it.
Do not reset that clock.

**Correction to `windows-platform.md`:** its "do not re-chase running AV filter drivers
(**none**)" is wrong. An elevated `fltmc` shows `MsSecFlt` (Defender for Endpoint, **7
instances**) and `WdFilter` (**5**) both Running. No third-party AV; `rtp1`/`rtp2`/`BdSentry`
are confirmed gone. That exclusion belongs back on the list for the `msys-fork-storm` lane.

`MinidumpsCount` raised 5 → 50, and three surviving dumps rescued to
`~/.claude/logs/minidumps/`.

---

## Guardrails

- **`scripts/project-cards/state.json` is USER-OWNED** — read it, never commit it. It is
  dirty right now with machine runtime state; leave it.
- **`sites/fastmcp-v3/`** is a nested independent git repo plus 29,728 `node_modules` files.
  It needs a deliberate submodule/subtree decision — do not `git add` it.
- **NEVER `drizzle-kit push`.** Shared DB, 40 `public` tables owned by three other apps.
  Flow is generate → read the SQL → `db:check` → `migrate`. Seeding is DML and touches no
  migration; `db:generate` must keep reporting no changes.
- **Seeding writes with `AGENTIC_OS_INDEXER_DATABASE_URL`**, never the app URL — the app
  role is SELECT-only and that is the only real enforcement boundary in a no-auth v1.
- **`fork` = Rev4nchist. Never push `origin`** (parcadei, third-party upstream).
- **The `plan-to-ralph` guard state file for the previous session was deleted** by a
  delegated agent, so direct code edits were possible late in this session. A fresh
  `ExitPlanMode` will re-arm it; five stale `claude-plan-approved-*.json` files are sitting
  in `$TEMP` and nothing cleans them up.

## Verification you can re-run

```
node scripts/coordination/lane.mjs board
node apps/agentic-os/scripts/seed-projects.mjs --dry-run     # must report 0 changes
cd apps/agentic-os && npm run lint && npm run typecheck && npm run build
npm run db:check && npm run db:generate                      # must emit NO migration
powershell -File scripts/gpu/crash-watch.ps1                 # GPU verdict
powershell -File scripts/machine/crash-telemetry.ps1 -Report # find the GAP
```

Slice 1 is done when `npm run dev` on 3010 shows a fleet grid matching
`SELECT project, count(*) FROM sessions GROUP BY 1` after normalization — **including a
visible unmatched bucket** — and a session started in another terminal appears within 5s
without a refresh.
