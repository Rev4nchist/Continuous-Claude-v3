# Combined handoff → 2b0b3ae2 — begin building Agentic OS

Merged from two live sessions on 2026-07-27:

- **c22279d5** (this half) — coordination bus, `agentic_os.*` schema, GPU crash lane, the Slice 1 carve.
- **0e1e2e2b** — reporting tracker spine. Their half is its own file and is **not duplicated here**:
  [`2026-07-27-handoff-from-reporting-session.md`](./2026-07-27-handoff-from-reporting-session.md).
  Read it. It carries three inherited mistakes that generalize beyond reporting.

Where we disagreed, the disagreement is **resolved below** rather than left open.

---

## START HERE

Coordination is in the database, not in a file. This document explains how the board
got the way it is; the board is the state.

```
node scripts/coordination/lane.mjs board     # every lane, who holds what
node scripts/coordination/lane.mjs next      # what you may claim
node scripts/coordination/lane.mjs claim aos-scaffold
node scripts/coordination/lane.mjs say "..." # message the other sessions
node scripts/coordination/lane.mjs inbox
```

The `lane-context` hook injects the board at SessionStart and unread updates on every
prompt. **Claim before you edit** — the claim is how the other two sessions learn your
scope, and it is atomic. **Serialize commits**: same branch, three sessions, one
`.git/index.lock`. Say so on the bus before a commit run.

**Your lane is `aos-scaffold`.** It is the hard prerequisite for everything else in
Slice 1, and it is `ready` and unclaimed.

---

## The single most important thing: there are TWO plans, and one supersedes the other

This is the correction most likely to send you down a six-week path Dave did not ask for.

| | `docs/architecture/agentic-os/` (2026-07-18) | `~/.claude/plans/i-am-ready-to-noble-wilkinson.md` (2026-07-25) |
|---|---|---|
| Product | Governed **multi-tenant production run service** | **Local read-first Mission Control** |
| Security | OIDC, RLS, `workspace_id` everywhere | none — localhost, single user |
| Substrate | sandbox, durable worker, exactly-once Notion projection | one Next app, no worker, no API service |
| Dashboard | **Phase 4 of 6** | **Slice 1 of 4** |
| Status | design package, 15 files, tracked | **APPROVED WITH DAVE THIS WEEK** |

The approved plan says, in its own words, that it *"deliberately inverts the documented
phase order."* Its locked decisions cut auth, OIDC, RLS and `workspace_id` outright, and
its ADR #2 explicitly supersedes the `services/agentic-os-api` deployment unit in
`target-architecture.md` **for v1**.

**Consequence — and this is a correction to 0e1e2e2b's half.** Their "what gates the
build" section grounds itself in `build-plan.md`, whose Phase 0 gate demands *"approved
v1 scope, threat model, data-classification matrix, test fixtures, sandbox deployment
proof, Notion recovery objective, and the complete ADR set."* That is the gate for the
**superseded** governed-production plan. A threat model and a sandbox deployment proof
are not prerequisites for a localhost read-only dashboard that has no auth boundary and
writes nothing. Their list is real work; it is **not** on this runway.

Their ordering argument (`conflict-events` → `claude-p-hang` → `harness-security` →
ADRs) is sound engineering and wrong sequencing for the stated goal. Slice 1 is a
read-only projection over `sessions` + `file_claims`: it never exercises the claim write
path that `conflict-events` instruments, and `claude-p-hang` breaks reporting pipelines
that Slice 1 does not read. Both stay open and unclaimed. Neither blocks you.

**What actually gates Slice 1** is the plan's own pre-code list, which no lane was
tracking until today. It is now five lanes.

---

## What already exists — verified this session, not inherited

`apps/agentic-os/` is **substrate, not product**:

```
package.json          db tooling only — drizzle-kit, pg, typescript. NO Next, NO React, NO dev script
drizzle.config.ts     + 4 applied migrations, private journal
src/db/schema/        project.ts (project + project_alias), lane.ts, coordination-event.ts
src/db/readonly/      public.ts — typed views of shared tables we only read
scripts/              check-migration-sql.mjs
```

There is **no `src/db/index.ts`** — no db client. No `src/app/`, no `src/server/queries/`,
no component anywhere. That is precisely why `aos-scaffold` is the prerequisite.

Two corrections to lane notes **I myself wrote an hour ago** and had to walk back after
actually reading the files — both were inherited from the plan rather than verified:

1. **`docs/architecture/agentic-os/` is TRACKED.** 15 files, `git ls-files` confirms. The
   approved plan says it "is still untracked"; that was true on 07-25 and is stale now.
   The commit-the-design-package task is **done**.
2. **`project` and `project_alias` already exist and are migrated.** `aos-project-identity`
   is not create-the-schema — it is *populate* them, write the normalizer, and surface the
   unmatched bucket. Their comments already encode the design intent.

One load-bearing fact worth not rediscovering, already verified in `project.ts`:
`project_id_hash` is `sha256(absolute_path)[:16]` as computed by
`opc/scripts/core/project_memory.py:85`, and it is the **only** reliable join to
`public.archival_memory`. For the continuous-claude root it is `addc92d926988bb9`.

---

## The Slice 1 carve, and who has what

Seeded on the board today, priority 4–14 so they sort above everything else.

| lane | state | depends on | who |
|---|---|---|---|
| `aos-scaffold` | ready | — | **you (2b0b3ae2)** |
| `aos-adr-and-commit` | ready | — (parallel-safe) | 0e1e2e2b |
| `aos-project-identity` | backlog | scaffold | next free session |
| `aos-fleet-grid` | backlog | scaffold + identity | — |
| `aos-project-canvas` | backlog | scaffold + identity | — |

`agentic-os-board` is marked **SUPERSEDED** — it claimed `apps/agentic-os/**` *and*
`docs/architecture/agentic-os/**` in one undifferentiated scope, which would have
serialized the whole build behind one session and hidden the ordering. Don't claim it.

**The collision hazard in your lane, stated once more because it takes the board down for
everyone:** `apps/agentic-os/src/db/schema/lane.ts` is **live coordination
infrastructure** carrying its design rationale in its comments. A scaffold that
regenerates `src/db/schema/` wholesale destroys it. Add to the barrel; never rewrite it.

**The gate on Slice 1 being a product rather than a liability** is `aos-project-identity`,
and it is worth reading Codex's finding in full in that lane's note. Short version: the
fleet grid's entire value is per-project counts derived from normalizing 111 raw
`sessions.project` values down to ~20 projects. Get it wrong and Slice 1 is not merely
incomplete, it is **actively misleading — worse than shipping nothing**. Hence: seed by
hand, keep the table hand-editable, and show an unmatched bucket from day one. Also:
`sessions` holds 2,352 rows but only 887 are real — 1,465 `s-*` rows are coordination
heartbeats and must be excluded from any user-facing count.

---

## Known-broken, in your path

**`lane.mjs done` / `release` / `state` all fail.** The UPDATE passes `[id, to, myId, note]`
but the SQL references only `$1`, `$2`, `$4`; `$3` is unreferenced, so Postgres cannot
infer its type and rejects the statement. `$4` survives only because `COALESCE($4, note)`
types it. Exit code 1, nothing mutates — reproduced non-destructively via
`done zzz-nonexistent-lane`, which errors on the parameter type rather than "no lane".

**Nothing has ever been marked done through the CLI.** Every `done` lane on the board was
seeded that way. Until this lands, *the board is an intake register, not a completion
record* — do not read an absence of completions as an absence of work. `reporting-tracker-spine`
reads `active` and is **finished**.

c22279d5 holds the fix (drop `myId`, renumber `$4`→`$3`; `myId` stays in scope for
`logEvent` so attribution survives) and is waiting on `lane-coordination`'s lease to lapse
rather than subverting the guard in order to patch the guard's own file.

**The board renders a dead holder's last heartbeat 4.5 hours in the FUTURE.**
`sessions.last_heartbeat` is `timestamp WITHOUT time zone` holding UTC; node's pg driver
parses it as local, so `toISOString()` adds five hours. The *decision* is unaffected —
`RECLAIMABLE` is pure SQL under a UTC session — but the display makes a corpse look alive,
which is exactly the misread that makes someone "helpfully" take a live session's lane. It
also stays correct **only because** the DB session TimeZone is UTC; any client connecting
with another offset skews the staleness check silently. Unfixed.

---

## The machine is crashing — check timestamps before blaming code

Eight bugchecks in the System log's **entire retained window** (oldest retained event
06-15 08:13, first bugcheck 08:25 — so eight is a **floor**, not a total). Seven are
display-driver: five `0x116` with identical param3 `c000009a`, two `0x10E`.

It dies **idle**, not under load — 02:29, 04:34, 04:51, 06:48, 07:04, 07:55 — then sits
dead for hours despite `AutoReboot=1`. Modern Standby only, hybrid Intel UHD + NVIDIA
T1200. The 07-24 bugcheck is same-second with a `Netwtw10` D3-exit.

**This has already corrupted the diagnostic record once.** Self-Improvement's `0xC000013A`
at 07:30 was attributed to the headless `claude -p` hang; the machine died underneath it,
so that hang is **not** shown to have recurred. Any unexplained kill in the 07-25 evening
or 07-27 morning windows must be checked against these timestamps first.

A trap worth inheriting: `C:\Windows\Minidump` is **not readable unelevated** —
`Get-ChildItem` prints Access-denied *and returns count 0*, which reads as "empty". A
previous session concluded from exactly that "the dumps were never written" and ranked
fixing dump capture the #1 action. The dumps existed. Three were rescued; five had already
been overwritten.

Mitigation applied, **one variable**: PCIe ASPM `Maximum power savings` → `Off`, both AC
and DC. Verdict is runnable, not remembered: `scripts/gpu/crash-watch.ps1`. Another
`0x116` within a week eliminates ASPM; 14 clear days is ~2% likely if the rate were
unchanged.

---

## Guardrails

- **Claim first, serialize commits, announce before a commit run.** Three live sessions.
- **NEVER `drizzle-kit push`.** Shared DB, 40 `public` tables owned by three other
  applications, and a `drizzle.__drizzle_migrations` journal already owned by a different
  app. Flow is generate → *read the SQL* → `db:check` → `migrate`.
- **No React component ever imports `db`.** Every read goes through `src/server/queries/*.ts`.
  This is the one structural rule that keeps Slice 4's command seam possible.
- **`scripts/project-cards/state.json` is user-owned** — read it, never write it.
- **Check the ignore rules before promising a durable artifact.** `thoughts/`
  (`.gitignore:89`) and `.claude/logs/*.jsonl` (`.gitignore:35`) are both untracked —
  anything written there does not leave this machine. 0e1e2e2b got this wrong once and
  moved their Phase 0 record to `docs/reporting/`; this file is under `docs/` for the same
  reason.
- **Committing `.claude/hooks/dist/*.mjs` deploys the live harness** to every running
  session via post-commit sync. Stage only the bundle matching your source edit.
- **Do NOT push.** 12 commits sit unpushed on `agentic-os`. `fork` = Rev4nchist;
  `origin` = parcadei, **never** origin.
- **Reach for the PowerShell tool for git and docker.** Expect MSYS fork-storm retries on
  bash calls — it hit twice this session; it is not a failure. Commit via
  `pwsh -File scripts/git-safe.ps1 -C <repo> commit -F <msgfile>`.
- **A probe that passes first try is not trusted** — break the thing it guards. One that
  fails once is not trusted either — re-run before concluding.

## Verification

```
node scripts/coordination/lane.mjs board
node scripts/coordination/lane-race-probe.mjs --racers 24        # 10/10
node scripts/coordination/load-probe.mjs --hook ~/.claude/hooks/dist/file-claims.mjs --n 20 --rounds 3
powershell.exe -NoProfile -File scripts/gpu/crash-watch.ps1      # GPU verdict
```

Slice 1 is done when `npm run dev` on 3010 shows a fleet grid matching
`SELECT project, count(*) FROM sessions GROUP BY project` — including a visible unmatched
bucket — and a session started in another terminal appears within 5s without a refresh.
