# Tri-Model Collaboration Plan — Game Plan Roster + CCv3 Workroom

**Status:** DESIGN — EXECUTED. All tracks (A–G) shipped to `main` 2026-07-11 via PR #19 (merge `5ac338c`), dogfood-verified. This document is the design rationale; **live state = `CURRENT-STATE.md`**, live schema = `.workroom/PROTOCOL.md`.  
**Branch context (historical):** designed on `feature/tri-model-workers`, built on `feature/game-plan-governance`  
**Created:** 2026-07-11  
**Sources:**

1. Dave’s video outline — *Architectural Blueprint: Multi-Model “Game Plan” Roster Framework* (from [youtu.be/zXZkuFxpwL…](https://youtu.be/zXZkuFxpwL), local notes: Downloads `Great resource here___https___youtu.be_zXZkuFxpwL....md`)
2. CCv3 tri-model ship — plan `~/.claude/plans/we-have-worked-in-snuggly-pony.md`, commit `720430d`, skills + `/grok` + `/premortem` dual reviewers
3. Prior Grok session assessment of shared communication gaps (session plan was under `~/.grok/sessions/…` — **not** project-local; this doc is the correction)

**Canonical location:** this file under `docs/tri-model/` in the continuous-claude repo.  
**Rule:** multi-model plans and contracts live **in-repo on disk**. Session-tool plan paths (`~/.grok/sessions/…`, plan-mode temp files) are UI artifacts only — copy durable content here.

---

## 1. Executive summary

We already have **three execution harnesses** (Claude Code CLI, Grok CLI) with probe-backed safety. We do **not** yet have the video’s load-bearing idea: a **rostered pipeline** where roles are fixed, **builders never self-grade**, and **every cross-model handoff is a physical file** (stateful disk sessions), not chat memory.

This plan unifies:

| Layer | What we have | What we add |
|-------|----------------|-------------|
| Safety | Worktrees, subscription auth, confirm-first | Unchanged; stay load-bearing |
| Coordination | Task prompts, agent caches, telemetry jsonl | **Contract + Workroom on disk** (Game Plan core) |
| Human gates | ExitPlanMode, premortem picker, apply-diff | Explicit Gate 1 (plan/UI) + Gate 2 (ship) |
| Plan storage | Scattered (Claude plans, Grok sessions, chat) | **`docs/` + `.workroom/` only** for multi-model work |

---

## 2. Review of the video “Game Plan” outline

### 2.1 What the outline gets right (adopt)

| Principle | Outline statement | Why it maps to our problem |
|-----------|-------------------|----------------------------|
| **Roster, not monomodel** | Stop forcing one model to plan, build, and inspect | Same reason we built tri-model workers |
| **Anti self-grading** | Builder ≠ reviewer; fixer ≠ grader | Fixes the Ralph/monitor “self-report complete” failure class |
| **Stateful file sessions** | Every handoff R/W **physical disk files**, not transient chat | Exactly the gap between isolated CLIs |
| **Contract on disk** | One requirements / blueprint markdown is the source of truth | Replaces “re-explain in every Task prompt” |
| **Phased pipeline** | Phase 1 lock plan → Phase 2 build/grade/ship | Fits premortem + implement + review we already half-have |
| **Incremental milestones** | M1…Mn with smoke checks + clean commits | Matches Ralph-style task loops without trusting agent narrative alone |
| **Failover** | If Grok session dies, hand milestone block to GPT | Real for headless CLIs / quota / hangs |
| **Bounded fix loops** | Max **two** fix iterations | Prevents review thrash and quota burn |
| **Context hygiene** | Don’t run full pipeline in one 250k–300k thread; checkpoint + clean session | Aligns with CCv3 continuity/handoffs and worktree isolation |
| **Human Gate 1** | Mandatory plan/UI sign-off before build | Stronger than silent ExitPlanMode under bypass-permissions |

### 2.2 Role allocation in the outline (map to our stack)

| Game Plan role | Outline model | CCv3 harness (verified) | Notes |
|----------------|---------------|-------------------------|--------|
| **Hub & Orchestrator** | Claude Fable 5 | Claude Code session + hooks + Maestro/Ralph optional | State tracking, smoke checks, contract formation, command orchestration |
| **Builder & Researcher** | Grok 4.5 | `/grok` → `grok-worker` (default `grok-4.5`) | Live web/X research; primary incremental builder; worktree implement |

**Outline optimization note (adopt):** prefer **standard high-thinking GPT-5.6** (our `gpt-5.6-sol` + high/`xhigh` effort) over “Ultra / multi-agent” modes that spawn internal sub-agents and balloon 15–25 min. This matches our existing rule: **`--disable multi_agent` by default** on adversary/worker; `--complex` opt-in only.

**Verified-fact footnote (landed from SESSION-REVIEW 2026-07-11):** “Grok 4.5 → live web/X research” is TRUE and probe-backed (`web_search`/`x_*` in Grok’s tool list) — but the worker’s **ask-mode `--tools` allowlist excludes web/x tools**. Research-role runs need a widened (still write-free) allowlist, e.g. `read_file,list_dir,grep,web_search,web_fetch,open_page` — a **deliberate egress expansion** documented in `grok-worker-safety.md` alongside the Track C `research` role. Never silently reuse the ask guard for research.

### 2.3 Pipeline phases in the outline (map)

**Phase 1 — Lock the Plan**

| Step | Outline | CCv3 mapping today | Gap |
|------|---------|-------------------|-----|
| 1 Pre-flight | Auth, CLIs, git | Manual / partial; `/harness-update` exists | Need a single **preflight skill/script** (login, grok models, git clean) |
| 2 Grill me with docs | 15+ structured questions | discovery-interview skill exists but not 15-Q contract-shaped | Strengthen into **contract intake checklist** |
| 3 Live research | Grok researches unknowns | `/grok` ask + oracle/scout | Formalize: research artifacts land in workroom |
| 4 Contract init | Disk blueprint markdown | Plans often in `~/.claude/plans` or chat | **Contract must live under project path** |
| 5 Human Gate 1 | UI/UX + scope approval | ExitPlanMode + premortem picker | Gate must be **explicit** even under bypass |

**Phase 2 — Build, Grade, Ship**

| Step | Outline | CCv3 mapping today | Gap |
|------|---------|-------------------|-----|
| 6 Milestone dispatch | Grok builds M1…Mn | `/grok --implement` + worktrees | Need milestone files + failover to |
| 7 Hub smoke checks | Claude verifies locally | Skill/prose only; external verify culture | Automate smoke checklist per milestone |
| 8 Review booth | Claude + GPT multi-lens | `/review` only; premortem has Both | Align booth with Game Plan: ** grades Grok’s build** |
| 10 Bookkeeping | Lessons + clean commits | memory store + git | Workroom decisions + optional learnings |

### 2.4 Where the outline diverges from what we already shipped (resolve deliberately)

| Topic | Video Game Plan | Current CCv3 tri-model | Decision in **this** plan |
|-------|-----------------|------------------------|---------------------------|
| Who reviews plans | Not explicit | Premortem Grok/Both | **Both optional**; default for deep plan stress (already recommended in picker) |
| Communication bus | Implied “disk files” | No standard tree | **Specify `.workroom/` protocol** (below) |
| UI mockups | Fable renders for Gate 1 | Optional Paper/HTML skills | Optional; Gate 1 can approve **text contract + wireframe** if no UI |
| Headless Grok sessions | Assumed native | Headless worktrees hand-rolled; `-w` ignored | Document CCv3-specific mechanics in contract footer |

### 2.5 Critique / risks in the outline itself

1. **Name drift** — “Grock / Fable / Saul” must map to **verified allowlist IDs** (`grok-4.5`, `gpt-5.6-sol`, session Claude). Never bake marketing names into allowlists.
2. **“Automated” fix loops still need human apply** on our stack (review-gate on implement). Keep that — outline’s ship step should not mean auto-merge to main without Dave.
3. **Failover to Saul mid-build** can reintroduce self-grade if Saul both finishes and reviews — rule: failover builder for that milestone **cannot** be the review-booth primary for the same milestone.
4. **15+ questions every time** may be heavy for small fixes — gate discovery depth by complexity (trivial → skip Game Plan; moderate/complex → full roster).

---

## 3. Target architecture (reconstructed)

### 3.1 Doctrine (non-negotiable)

1. **Rostered roles** — orchestrator / builder / reviewer-fixer are assigned by default; overrides require explicit human flag.
2. **No self-grading** — the model family that produced the code under review does not own the grade; fixer ≠ final grader.
3. **Disk is the bus** — contracts, milestones, findings, patches, status live in the **project tree** (or documented sibling worktree paths), never only in chat or `~/.grok/sessions`.
4. **Claude is hub** — only Claude (plus human) advances `status.json` phase and merges findings.
5. **Human gates** — Gate 1 before build; apply-diff / Gate 2 before treating work as shipped.
6. **Bounded loops** — max 2 fix rounds per review booth unless human raises the cap.
7. **Fresh context at checkpoints** — after milestone commit, prefer new session + contract pointer over 300k thread continuation.

### 3.2 Default roster (CCv3 Game Plan)

```text
Human (Dave)
   │  Gate 1 (plan) · apply patches · Gate 2 (ship)
   ▼
Claude Code — HUB
   │  contract, status, smoke, synthesize, spawn CLIs
   ├──────────────► Grok 4.5 — BUILDER / RESEARCHER
   │                   /grok ask · /grok --implement (milestones)
   └──────────────► gpt-5.6-sol — REVIEWER / FIXER
                        · --implement (fixes, failover)
```

**Anti-pattern:** Grok implements M3 then Grok “reviews” M3.  
**Correct:** Grok implements M3 → Claude smoke → review booth → fix patches → Claude and/or Grok **verify** (run tests / re-read) does not sole-grade its own fix without a second lens (Claude smoke or second pass rules).

### 3.3 Stateful disk layout (Workroom + Contract)

> **Status: BUILT (2026-07-11)** — this tree shipped as designed (`.workroom/PROTOCOL.md` + `templates/`; `rooms/` gitignored before the first room was created). The live protocol file is the schema owner; this section is the design record.

All multi-model feature work uses a **room** under the project:

```text
<project>/
  docs/tri-model/                 # committed: this plan, protocol, how-to
  .workroom/                      # runtime rooms (gitignore rooms/*; commit templates)
    PROTOCOL.md                   # committed message + phase schema
    templates/
    rooms/
      <room-id>/                  # e.g. 2026-07-11-my-feature
        ROOM.yaml                 # goal, roster, participants, file scopes
        CONTRACT.md               # ★ Game Plan “system requirements” — SoT
        THREAD.md                 # append-only human-readable log
        status.json               # phase, next_actor, blockers, worktree paths
        intake/                   # grill-me Q&A transcript / answers
        research/                 # Grok research dumps
        milestones/
          M1-scope.md
          M1-result.md
          …
        findings/
          premortem-merged.yaml
          booth--*.md
          booth-claude-*.md
        patches/
          grok-M2.diff
          -fix-R1.diff
        inbox/
          claude/ / grok/ human/
```

**Contract.md is Step 4 of Game Plan** — the single file every session restart loads.

**Why not only Notion / Postgres:** Grok and workers reliably see **files in cwd/worktree**. Notion MCP and CCv3 hooks do not run inside their sandboxes. Notion remains optional **human** mirror (tri-model Track 5 how-to page).

### 3.4 Phase machine (`status.json`)

```text
preflight → intake → research → contract_draft → gate1
    → building (M1..Mn) → smoke → review_booth → fix_loop (≤2)
    → bookkeeping → gate2_ship → done
         ↘ blocked / abandoned
```

| Phase | Primary actor | Disk outputs |
|-------|---------------|--------------|
| preflight | Claude | THREAD note; fail if CLIs unauth |
| intake | Claude + human | `intake/answers.md` |
| research | Grok | `research/*.md` |
| contract_draft | Claude | `CONTRACT.md` |
| gate1 | Human | status `gate1_approved_at` |
| building | Grok (failover) | milestone results + patches |
| smoke | Claude | smoke log in milestone file |
| review_booth | Claude critics | `findings/*` |
| bookkeeping | Claude | decisions, optional memory store |
| gate2_ship | Human | merge/tag permission |

### 3.5 Message protocol (inbox)

Filename: `inbox/<to>/<from>-<utc>-<slug>.md`

```yaml
# frontmatter
id: msg-…
from: claude|grok|human
to: claude|grok|human
type: task|finding|question|answer|status|handoff|failover
room: <room-id>
milestone: M2   # optional
in_reply_to: null
priority: normal|high|blocker
```

Body sections: **Intent · Context (paths only) · Deliverable · Done when**.

Workers/adversaries: if prompt includes `## Workroom`, they **must** read `CONTRACT.md` + `status.json` + own inbox first; write results to `findings/` or `patches/` + one THREAD line. Fail-open if no workroom block (back-compat with today’s one-shot `/grok`).

### 3.6 Mapping existing CCv3 tools into the pipeline

| Pipeline need | Tool |
|---------------|------|
| Preflight CLIs | `/harness-update --dry-run`, ` login status`, `grok models` |
| Intake | `/discovery-interview` strengthened → writes `intake/` |
| Research | `/grok` ask (web/X native tools available to Grok) |
| Plan stress | `/premortem --reviewers \|grok\|both` → `findings/premortem-*.yaml` |
| Build milestone | `/grok --implement` with workroom paths + milestone id |
| Smoke | Claude: project test/typecheck scripts; record exit codes in milestone result |
| Review booth | `/review` (adversary + Claude critics); optional second Grok pass on **non-builder** concerns only |
| Continuity | New session: read `CONTRACT.md` + `status.json` (not prior chat) |

### 3.7 Plan and artifact placement rules (learned the hard way)

| Artifact | Put it here | Not here |
|----------|-------------|----------|
| Multi-model design plans | `docs/tri-model/*.md` | `~/.grok/sessions/.../plan.md` alone |
| Active feature contract | `.workroom/rooms/<id>/CONTRACT.md` | Chat-only summary |
| Claude-only scratch plans | `thoughts/shared/plans/` or `~/.claude/plans/` **plus** copy into room if multi-model | Session UI only |
| Telemetry | `.claude/logs/*-worker.jsonl`, `*-lift.jsonl` | Not a substitute for CONTRACT |

---

## 4. Implementation roadmap

### Track A — Protocol + templates (docs-first, 0.5–1 day)

1. This file (done).  
2. `.workroom/PROTOCOL.md` + templates (`ROOM.yaml`, `CONTRACT.md`, message, finding, milestone).  
3. `.gitignore` for `.workroom/rooms/*` (keep templates).  
4. Short `docs/tri-model/README.md` index linking skills + this plan.

### Track B — `/workroom` skill (1 day)

Commands: `new`, `status`, `post`, `advance`, `resume`.  
Creates room tree; prints next_actor; optional SessionStart one-liner if `active-room` pointer set.

### Track C — Worker/adversary contracts (0.5 day)

Patch prompts in:

- `.claude/agents/grok-worker.md`
- `.claude/agents/grok-adversary.md`

Optional `## Workroom` / `## Milestone` / `## Role` (builder|reviewer|fixer|research) blocks.

### Track D — Game Plan skill or Maestro pattern (1–2 days)

`/game-plan` (or Maestro pattern `roster-pipeline`) that walks Phase 1–2 with:

- preflight script  
- intake checklist  
- Grok research task  
- CONTRACT write  
- AskUserQuestion Gate 1  
- milestone loop (Grok) + smoke  
- review booth (review)
- fix loop ≤2  
- bookkeeping  

Complexity gate: skip full roster for trivial tasks.

### Track E — Align defaults with roster (0.5 day)

- Docs + skill copy: **default builder = Grok**, **default code reviewer/fixer = **.
- Premortem picker stays.  
- `/review` Grok standing pass remains **deferred** (quota); optional `--grok` later.  
- Failover rule documented in PROTOCOL.

### Track F — Human how-to (Track 5 leftover)

Evolve Notion “ in CCv3” → “Cross-Model Workers + Game Plan” linking **this** `docs/tri-model/` tree (confirm-first write).

### Track G — Preflight helper (optional, 0.5 day)

`scripts/tri-model/preflight.mjs` or skill step: assert +grok auth, allowlist models, git status, print ready/not.

**Corrections landed (SESSION-REVIEW 2026-07-11):**

- **Seed, don't rewrite:** verified building blocks already exist in the committed static
  suite `scripts/tri-model/tri-model-suite.sh` (auth asserts, identity pin, `--version`
  stamps, allowlist greps, guard probe). Promote that script rather than writing fresh.
- **Close the advisory version-gate gap here:** harness-update rule 7 (version drift not
  mechanically enforced) is exactly what workroom preflight closes — preflight compares
  live `--version` to the verified pin and **blocks the `building` phase on mismatch**.
  One mechanism, not two.
- **Timeouts:** any workroom dispatch to Grok uses ≥300s external timeouts (cold start
  killed a healthy run at the 120s default; encoded in grok-worker's failure table).
- **Telemetry discipline:** the per-run jsonl row is part of milestone completion
  evidence, not optional — workroom bookkeeping checks it (a worker self-exempting on a
  "trivial" run is the failure mode this guards).

---

## 5. Dogfood success criteria

1. **Disk bus:** cold Claude session reconstructs next step from `CONTRACT.md` + `status.json` alone.  
2. **Anti self-grade:** a Grok-built milestone is graded by findings on disk, not Grok self-report.
3. **Failover:** kill/expire a Grok implement; Claude hands same milestone to ; room THREAD records failover.
4. **Bounded fix:** second fix round then stops for human.  
5. **No session-dir SoT:** no required read of `~/.grok/sessions/**/plan.md` for project work.  
6. **Smoke is external:** milestone `complete` only after Claude-recorded test/typecheck evidence in `milestones/M*-result.md`.

---

## 6. Non-goals

- Replacing Ralph entirely (Ralph can **consume** workroom later).  
- CRDT shared live editing.  
- Forcing Grok into `/review` Phase 1 by default.  
- Auto-merge to `main`.  
- Trusting Grok “tests passed” without hub smoke.

---

## 7. Open decisions (Dave)

| # | Question | Recommended default |
|---|----------|---------------------|
| 1 | Auto-create workroom on every non-trivial `/build`, or opt-in `/workroom new` / `/game-plan` only? | **Opt-in skill first**, then auto for `/game-plan` |
| 2 | Gitignore room bodies vs commit contracts for team history? | **Gitignore rooms/**; allow `git add -f` CONTRACT when sharing |
| 3 | as failover builder only, or also primary for backend-heavy milestones? | Failover + **explicit** `--builder ` override |
| 4 | Gate 1 under `bypassPermissions`? | Still require AskUserQuestion / explicit “approve contract” message — document as model-side until hook exists |
| 5 | Max fix rounds | **2** (video); human can set `fix_rounds_max` in ROOM.yaml |

---

## 8. Immediate next actions (when implementing)

> **Ordering superseded (2026-07-11):** the authoritative combined build order is in `SESSION-REVIEW-2026-07-11.md` — notably **Track E (roster-default copy) runs BEFORE the dogfood**, because the §5 dogfood criteria presuppose the Grok-builds-reviews defaults are already in the skill copy. The list below is kept for track content, not sequence.

1. Land Track A templates next to this doc.  
2. Implement Track B `/workroom` skill.  
3. Wire Track C optional Workroom blocks into the four agents.  
4. Dogfood one small feature through Phase 1 + one milestone booth.
5. Only then build full `/game-plan` orchestrator (Track D).

---

## 9. Reference index

| Resource | Path |
|----------|------|
| This plan | `docs/tri-model/COLLABORATION-PLAN.md` |
| Grok evidence | `docs/grok-integration/DESIGN-RESEARCH.md` |
| Original tri-model build plan | `docs/tri-model/BUILD-PLAN-2026-07-11.md` (in-repo copy w/ post-execution erratum; session-local original at `~/.claude/plans/we-have-worked-in-snuggly-pony.md`) |
| Grok skill | `.claude/skills/grok/SKILL.md` |
| Premortem dual reviewers | `.claude/skills/premortem/SKILL.md` |
| Grok safety | `.claude/rules-ondemand/grok-worker-safety.md` |
| Coordination research | `docs/self-improvement/proposals/2026-07-10-coordination.md` |
| Video outline (Dave) | `Downloads/Great resource here___https___youtu.be_zXZkuFxpwL....md` |

---

## 10. One-page “how we work” for any model

```text
1. Read CONTRACT.md and status.json in the active .workroom/rooms/<id>/
2. Read your inbox/ only
3. Do only the role assigned (builder | reviewer | fixer | research | hub)
4. Write results to milestones/ | findings/ | patches/ | research/
5. Append one line to THREAD.md
6. Do not advance phase unless you are hub (Claude) or human
7. Builder never marks review complete; reviewer never ships without hub smoke
```

That is the Game Plan, localized to Continuous Claude.
