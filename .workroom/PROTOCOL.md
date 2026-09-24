# Workroom Protocol — Tri-Model Game Plan

**Status:** committed, canonical. Rooms under `rooms/` are runtime state and gitignored
(`.workroom/rooms/` in the repo `.gitignore` — verify before creating the first room on a
fresh clone). Design rationale: `docs/tri-model/COLLABORATION-PLAN.md`; combined build
order: `docs/tri-model/SESSION-REVIEW-2026-07-11.md`.

## Doctrine (non-negotiable)

1. **Rostered roles** — hub / builder / reviewer-fixer / research are assigned by default;
   overrides require an explicit human flag.
2. **No self-grading** — the model family that produced the code under review never owns
   the grade; the fixer is never the final grader.
3. **Disk is the bus** — contracts, milestones, findings, patches, status live in the
   project tree (or documented sibling worktree paths), never only in chat or
   `~/.grok/sessions`.
4. **Claude is hub** — only Claude (plus human) advances `status.json` phase and merges
   findings.
5. **Human gates** — Gate 1 before build; apply-diff / Gate 2 before treating work as
   shipped. Under bypassPermissions, Gate 1 is a model-side AskUserQuestion (documented
   as model-side until a hook enforces it).
6. **Bounded loops** — max **2** fix rounds per review booth unless the human raises
   `fix_rounds_max` in ROOM.yaml.
7. **Fresh context at checkpoints** — after a milestone commit, prefer a new session +
   contract pointer over continuing a 300k thread.

## Default roster

| Role | Model / harness | Invocation |
|------|-----------------|------------|
| Hub & orchestrator | Claude (session) | this session; advances phase, runs smoke, merges findings |
| Builder & researcher | Grok `grok-4.5` | `/grok --implement` (milestones), `/grok` ask (research) |
| Reviewer & fixer | Codex `gpt-5.6-sol` | `codex-adversary` (review), `/codex --implement` (fix patches) |
| Failover builder | Codex `gpt-5.6-sol` | `/codex --implement` — only on Grok failure or explicit `--builder codex` |

**Failover rule:** a failover builder for milestone Mn **cannot** be the review-booth
primary for that same milestone. If Codex built Mn, the grade comes from Claude critics
(+ optionally a Grok pass on non-builder concerns); Codex does not sole-grade its own build.
Record every failover as a `failover` message in the room THREAD and inbox.

**Model ids are the verified allowlists**, never marketing names. Changes go through
`/harness-update` only.

## Phase machine (`status.json`)

```text
preflight → intake → research → contract_draft → gate1
    → building (M1..Mn) → smoke → review_booth → fix_loop (≤2)
    → bookkeeping → gate2_ship → done
         ↘ blocked / abandoned   (from any phase)
```

| Phase | Primary actor | Disk outputs |
|-------|---------------|--------------|
| preflight | Claude | THREAD note; **fail if CLIs unauth or live `--version` ≠ verified pin** (harness-update rule 7 gate) |
| intake | Claude + human | `intake/answers.md` |
| research | Grok | `research/*.md` |
| contract_draft | Claude | `CONTRACT.md` |
| gate1 | Human | `status.json` `gate1_approved_at` |
| building | Grok (Codex failover) | `milestones/M*-result.md` + `patches/` |
| smoke | Claude | smoke log w/ exit codes in milestone result |
| review_booth | Codex + Claude critics | `findings/*` |
| fix_loop | Codex fixes; Claude/Grok verify | `patches/codex-fix-R*.diff` |
| bookkeeping | Claude | decisions in THREAD; telemetry row; optional memory store |
| gate2_ship | Human | merge/tag permission |

`status.json` schema: see `templates/status.json`. Only hub/human writes it.

## Room layout

```text
.workroom/rooms/<room-id>/          # room-id: YYYY-MM-DD-<slug>
  ROOM.yaml         # goal, roster, participants, file scopes, fix_rounds_max
  CONTRACT.md       # ★ source of truth — the one file every session restart loads
  THREAD.md         # append-only human-readable log (one line per event)
  status.json       # phase, next_actor, blockers, worktree paths
  intake/           # grill-me Q&A answers
  research/         # Grok research dumps
  milestones/       # M<N>-scope.md / M<N>-result.md
  findings/         # premortem-merged.yaml, booth-codex-*.md, booth-claude-*.md
  patches/          # grok-M<N>.diff, codex-fix-R<N>.diff
  inbox/claude/  inbox/codex/  inbox/grok/  inbox/human/
```

## Message protocol (inbox)

Filename: `inbox/<to>/<from>-<utcstamp>-<slug>.md` (utcstamp: `YYYYMMDDTHHMMSSZ`).

```yaml
---
id: msg-<utcstamp>-<slug>
from: claude|codex|grok|human
to: claude|codex|grok|human
type: task|finding|question|answer|status|handoff|failover
room: <room-id>
milestone: M2        # optional
in_reply_to: null    # or a msg id
priority: normal|high|blocker
---
```

Body sections, in order: **Intent · Context (paths only, never inlined file bodies) ·
Deliverable · Done when**.

## Worker rules (any model)

```text
1. Read CONTRACT.md and status.json in the active room
2. Read your own inbox/ only
3. Do only the role assigned (builder | reviewer | fixer | research | hub)
4. Write results to milestones/ | findings/ | patches/ | research/
5. Append one line to THREAD.md
6. Do not advance phase unless you are hub (Claude) or human
7. Builder never marks review complete; reviewer never ships without hub smoke
```

Workers/adversaries: if a Task prompt includes a `## Workroom` block, read the contract +
status + own inbox FIRST and write outputs to the room. **Fail-open**: with no workroom
block, behave exactly as the one-shot `/codex` / `/grok` flows do today.

## Operational constraints (probe-backed — do not relearn these)

- **Grok dispatches need ≥300s external timeouts** (cold start killed a healthy run at the
  120s default; encoded in grok-worker's failure table).
- **Telemetry is completion evidence** — every workroom implement/fix run appends its
  jsonl row (`.claude/logs/*-worker.jsonl`); a milestone is not `complete` without it and
  Claude-recorded smoke evidence (exit codes) in `milestones/M*-result.md`.
- **Grok research role** uses a widened write-free `--tools` allowlist (see
  `.claude/rules-ondemand/grok-worker-safety.md`) — a deliberate egress expansion, distinct from
  the ask guard. Never silently reuse ask's allowlist for research or vice versa.
- **Worktree paths** for milestones live in `status.json.worktrees` — Grok/Codex implement
  runs happen in `../.grok-worktrees/` / `../.codex-worktrees/` siblings; the room only
  stores paths and diffs, never a second working tree.
- Smoke = hub-run commands with recorded exit codes. A worker's "tests passed" narrative
  is never smoke evidence.

## Complexity gate

Trivial tasks (single file, <10 lines, no design surface) skip the Game Plan entirely —
use direct edits or a one-shot worker call. Moderate/complex multi-model work gets a room.
