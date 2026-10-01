---
name: workroom
description: Manage tri-model Game Plan workrooms, the disk bus for Claude/Grok/Codex feature work. Use when the user types "/workroom", says "open a workroom", "room status", "advance the room", or "post to the room".
disable-model-invocation: true
---

# /workroom — Tri-Model Workroom Management

The hub-side operator for `.workroom/rooms/<room-id>/` — the stateful disk bus every
cross-model handoff flows through. **Read `.workroom/PROTOCOL.md` before first use in a
session**; this skill implements it, it does not replace it.

**You (Claude) are the hub.** Only the hub or the human writes `status.json` or advances
phase. Workers (Grok/Codex) write only to `milestones/ | findings/ | patches/ | research/`
+ one THREAD line.

## Commands

### `/workroom new <slug> [--goal "..."]`

1. **Preflight the gitignore** — run `git check-ignore .workroom/rooms/probe` and require a
   match. If not ignored, STOP and fix `.gitignore` first (auto-commit hooks would leak
   room churn into commits).
2. Compute `room-id` = `<UTC date YYYY-MM-DD>-<slug>` (get the date from the system, never
   from memory).
3. Create the tree by copying templates:
   ```
   .workroom/rooms/<room-id>/
     ROOM.yaml        (from templates/ROOM.yaml — fill room_id, goal, created)
     CONTRACT.md      (from templates/CONTRACT.md — fill title + room-id, leave draft)
     status.json      (from templates/status.json — fill room_id, updated, phase=preflight, next_actor=claude)
     THREAD.md        (create: "# THREAD — <room-id>" + first line "<utc> claude: room created")
     intake/ research/ milestones/ findings/ patches/
     inbox/claude/ inbox/codex/ inbox/grok/ inbox/human/
   ```
4. Write the room-id to `.workroom/active-room` (plain text, one line — the pointer
   `resume` and other skills read).
5. Run the **preflight phase** immediately (see `advance` rules below) and report the result.

### `/workroom status [room-id]`

Default room = contents of `.workroom/active-room`. Read `status.json` + `ROOM.yaml` +
last ~5 THREAD lines and report: phase, `next_actor`, current milestone + per-milestone
status, fix_round vs `fix_rounds_max`, blockers, worktrees, pending inbox counts per
participant (count files in each `inbox/<who>/`). One compact table, no file dumps.

### `/workroom post <to> <type> "<intent>" [--milestone M<N>] [--priority high|blocker]`

Write an inbox message from `templates/message.md`:

- Path: `inbox/<to>/<from>-<utcstamp>-<slug>.md` (`from` = `claude` when the hub posts;
  utcstamp `YYYYMMDDTHHMMSSZ` from the system clock).
- Fill frontmatter (`id`, `from`, `to`, `type`, `room`, `milestone`, `priority`) and the
  four body sections: **Intent · Context (paths only, never inline file bodies) ·
  Deliverable · Done when**.
- Append one THREAD line: `<utc> claude → <to> [<type>] <intent>`.

### `/workroom advance [<phase>]`

Hub-only phase transition on the machine:

```
preflight → intake → research → contract_draft → gate1
    → building → smoke → review_booth → fix_loop → bookkeeping → gate2_ship → done
         ↘ blocked / abandoned (from any phase)
```

Rules (enforce, don't just narrate):

- **Only forward moves along the machine** (or → blocked/abandoned). No skipping gates.
- **preflight → intake** requires: both CLIs authed on subscription, live `--version`
  equal to the verified pins in `.claude/rules-ondemand/harness-update.md` (mismatch = STOP, run
  `/harness-update <harness>` first — this is the mechanical version gate closing
  harness-update rule 7), git status clean-enough note in THREAD. Cheapest path: run the
  relevant checks from `scripts/tri-model/tri-model-suite.sh`. Record results in
  `status.json.preflight`.
- **gate1** and **gate2_ship** require the HUMAN: use AskUserQuestion ("Approve contract
  for build?" / "Approve ship?"). Under bypassPermissions this AskUserQuestion IS the
  gate — never self-approve. On approval stamp `gate1_approved_at` / `gate2_approved_at`.
- **building → smoke** requires the milestone's result file to exist with a captured diff
  + telemetry row noted (telemetry is completion evidence, not optional).
- **smoke → review_booth** requires hub-run smoke evidence (commands + exit codes) in
  `milestones/M<N>-result.md`. A worker's "tests passed" narrative never counts.
- **fix_loop**: increment `fix_round`; when it would exceed `fix_rounds_max` (default 2),
  do NOT loop — set phase `blocked` with blocker "fix rounds exhausted — human decision".
- Every transition: update `status.json` (`phase`, `next_actor`, `updated`, `updated_by`)
  and append one THREAD line.

`next_actor` by phase: preflight/contract_draft/smoke/bookkeeping → claude ·
intake/gate1/gate2_ship → human · research/building → grok · review_booth/fix_loop → codex.
(Failover: if a milestone's builder is codex, the review booth primary for that milestone
is claude critics — a failover builder never grades its own milestone. Record failovers in
`status.json.failovers` + a `failover` inbox message.)

### `/workroom resume`

Cold-session entry point (the whole point of the disk bus):

1. Read `.workroom/active-room` → room-id (if absent, list `rooms/` and ask which).
2. Read `CONTRACT.md` + `status.json` + unread `inbox/claude/` — **not prior chat**.
3. Report: goal, phase, next_actor, current milestone, blockers — then propose the next
   concrete action for the current phase.

## Dispatching workers from a room

When phase puts `next_actor` on grok/codex, spawn the worker (`grok-worker` /
`codex-worker` / adversaries per roster) with a `## Workroom` block in the Task prompt:

```
## Workroom
room: <ABSOLUTE path to .workroom/rooms/<room-id>>   # pass explicit paths — do not rely on $CLAUDE_PROJECT_DIR expanding in the agent shell
role: builder | reviewer | fixer | research
milestone: M<N>          # when applicable
```

Workers read CONTRACT.md + status.json + their inbox first, write outputs to the room,
and never advance phase (fail-open: without this block they behave as one-shot /grok
//codex). Grok dispatches: ≥300s external timeout, always.

## Guardrails

- Rooms are **opt-in** (`/workroom new`), never auto-created.
- `rooms/` is gitignored; share a contract deliberately via
  `git add -f .workroom/rooms/<id>/CONTRACT.md`.
- Complexity gate: trivial work (single file, <10 lines) gets no room.
- Roster defaults: **Grok builds, Codex reviews/fixes**; Codex builds only as failover or
  explicit `--builder codex` override.
- Fresh context at checkpoints: after a milestone commit, prefer a new session +
  `/workroom resume` over continuing a 300k thread.
