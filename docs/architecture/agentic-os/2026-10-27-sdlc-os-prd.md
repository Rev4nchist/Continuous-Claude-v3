# SDLC Operating System: PRD (draft 1, session surface first)

Status: DRAFT for Dave's review. No build starts before his yes.
Date: 2026-10-27. Author: session 8ae5db83. Lane: `sdlc-os`.
Mockup (the visual spec): https://claude.ai/artifact/LjpVMpeH441CwK9Y1QJfx2
Inputs: `.claudedocs/2026-10-27-sdlc-os-assessment.md`, `.claudedocs/2026-10-27-sdlc-os-existing-map.md`,
Notion handoff "[Code→Next session] SDLC Operating System: PRD draft + prototype on Agentic OS (continuous-claude) — 2026-10-27",
`docs/architecture/agentic-os/` (ADR 0001-0005), `.claude/plugins/ccv3-mods/README.md`.

## 1. Summary

Dave wants one standard dashboard that shows what every Claude Code session is doing.
It has two surfaces that read the same data and share one look:

- **Session Pane**: a panel and a two-line band inside each terminal session (a mod in `ccv3-mods`).
- **Fleet Browser**: a localhost site on a second monitor that shows all sessions, lanes and PRs
  (an extension of `apps/agentic-os`).

This PRD is **slice 1 of the Agentic OS vision**. It builds the read-first session surface.
It builds none of the runner platform in `target-architecture.md` (orchestrator, workers, approval gateway).

## 2. Problem

- Dave runs several sessions at once. He cannot tell them apart, see their goals, or see which one waits for him.
- "Done" is claimed without proof. This is his top correction in 30 days (CLAUDE.md, "Done means proven").
- Session state exists but is scattered: per-session JSON in `~/.claude/state/agentic-os/`, `public.sessions`,
  `agentic_os.lane`, workflow journals, `review-status.mjs`. No screen joins them.
- The current Agentic OS page lists projects and sessions by raw prompt text. It has no titles, no drill-in, no ask list.

## 3. Goals and non-goals

Goals:
1. Every session answers six questions in a fixed order: **Goal, Plan, Now, Done with proof, Ask, Health**.
2. One "Ready for Dave" list across all sessions: every approval, question and decision waiting on him.
3. A new session appears in the Fleet Browser within 10 seconds, with no setup.
4. A task counts as done only when it carries proof (a file path or command output).
5. One design system. A new widget needs one registry entry and no change to the core.

Non-goals (this PRD):
- Chatting with sessions, starting or stopping them, or editing code from the UI.
- Auth, tenancy, mobile access (ADR-0005 holds; desktop only for v1).
- Agent swarm control, planning and resourcing tools, cross-session threads. The design leaves room for them (section 9). It does not build them.
- Replacing the FastAPI dashboard now (retired later, section 10).

## 4. Decisions recorded (Dave, 2026-10-27)

| # | Question | Answer |
|---|---|---|
| 1 | Notion | Replaced for Code-to-Code traffic only. Eve, Donna and Grok keep Notion. One-way export. New ADR 0006. |
| 2 | Mobile | Desktop only for v1. Keeps ADR-0005 (localhost). |
| 3 | Fleet host | Extend `apps/agentic-os`. Keeps ADR-0002 (no separate API). |
| 4 | FastAPI dashboard (port 3434) | Retire later, after the new Fleet passes its E2E check and Dave says yes. |
| 5 | Session titles | Set by the session through `brief_set`. |
| 6 | Visual direction | Deep dark terminal for both surfaces, built to expand (mockup boards 1-4). |
| 7 | Scope | One PRD. The session surface is its first section. |

## 5. Product requirements

### 5.1 The six sections (both surfaces)

| Section | Shows | Source |
|---|---|---|
| Goal | goal line, **stop-at** (Dave's literal stop point), title | `brief_set` |
| Plan | steps with status `todo`, `doing`, `done`, `blocked`; "3 of 7" | `ExitPlanMode`, `TaskCreate`, `TaskUpdate`, `TodoWrite` (exists) |
| Now | current step, tool, elapsed, running agents | exists |
| Done | finished steps, each with proof or "unproven" | task proof field (new) |
| Ask | open questions, approvals, blocks, each with a recommended answer | `brief_set` and the Next steps block |
| Health | ctx %, cost, limits, cache, PRs, peers, drift | exists (HUD, pr-loop) |

### 5.2 Session state and chip rules

States: `working`, `waiting-on-dave`, `blocked`, `done`, `idle`. One chip per session, same words everywhere.

- `waiting-on-dave` when any Ask is open and no tool runs.
- `blocked` when a tool is refused, a gate is red, or a peer holds the lane.
- `done` only when every plan step is done **and** proven. One unproven step keeps the chip off DONE.
- Amber means a person is needed. Green needs proof. Violet is for agents.
- Liveness in the Fleet: green when `GREATEST(last_heartbeat, last_activity_at)` is under 2 minutes, amber when older. Use the existing predicate guard.

### 5.3 Session Pane (terminal)

- **Band**: two lines above the prompt. Line 1: chip, project dot, repo, branch, lane, ctx, cost. Line 2: goal, plan bar, ASK count, UNPROVEN count. A widget may add one line below. The two core lines never move.
- **`/os` pane**: tabs Overview, Plan, Proof, Decisions. Tabs Comms, Swarm, Resources show as disabled with a NEXT or LATER tag.
- Opens at 110 columns or wider. Text gauges only (no Svg in the terminal). Zero model tokens.
- Observer only: it never denies or rewrites a tool call. Its single session-side write is `brief_set` (5.5).

### 5.4 Fleet Browser (`apps/agentic-os`, port 3010)

- **Home is the fleet** (ADR-0004): project cards filter the session list.
- **Ready for Dave** strip on top of every view, sorted oldest first.
- Stat tiles: live sessions, active lanes, blocked, open PRs, needs Dave.
- **Overview**: projects, live session cards, session detail (same six sections as the Pane), PR panel, data-source health, unmatched sessions, recently closed.
- **Board**: lane states `backlog, ready, active, blocked, review, done` (read-only in P1).
- **Sessions**: table, name = `project/branch/id4`.
- Nav items Workflows, Handoffs, Notes, Evidence, Swarm show disabled with NEXT or LATER tags.
- Footer states "SELECT-only, localhost, no login". No auth chrome (July non-negotiable).
- July non-negotiables stay: unmatched bucket visible, `reconciles` flag surfaced, stale states legible,
  no component imports `db`, exactly one `useLiveData()` hook.

### 5.5 `brief_set` (new mod tool)

The model calls it when the goal, stop-at, title or an open question changes.

```
brief_set {
  title?: string,          // short session title, shown in Fleet
  goal?: string,           // one line
  stopAt?: string,         // Dave's literal stop point
  ask?: [{ kind: 'question'|'approval'|'decision'|'block', text: string, recommend?: string }],
  decision?: { text: string, by: string },
  proof?: { step: string, artifact: string }   // marks a step proven
}
```

- Writes the `brief` key of `~/.claude/state/agentic-os/<session-id>.json`. It writes no database row.
- Fallbacks when it is not called: Goal shows `GOAL not set` (visible, on purpose). `public.sessions.working_on` shows as a dim fallback. Ask falls back to parsing the `## Next steps` block at turn end.
- All strings pass the redaction patterns in `opc/scripts/core/db/memory_redact.py` before storage or display.

## 6. Data and ownership

One source of truth per object. The OS reads where data lives. The UI writes only what Dave does (P2).

| Object | Source of truth | Read by Pane | Read by Fleet |
|---|---|---|---|
| Session identity, liveness | `public.sessions` (self-registers via hooks) | n/a | DB, read-only |
| Title, goal, stop-at, ask, decisions, proof | state file `brief` key | in-process atoms | server reads the files |
| Plan, tasks, agents, ctx, cost | state file (written by the mod) | in-process atoms | server reads the files |
| Lanes and lane events | `agentic_os.lane`, `lane_event` | `lane.mjs mine --json` | DB, read-only |
| PR state | `review-status.mjs --json` | pr-loop | cached 60 s |
| Workflow runs | journals in `~/.claude/projects/.../workflows/` | none in P1 | indexer (P1b, read-only) |

Facts that shape this table (from the map and the scout, not re-verified in code today):
- `public.sessions` has no title, branch or worktree column. P1 takes them from the state file. P2 adds columns (migration, confirm-first).
- The app reads only the database today. Reading state files is new: one module, `src/server/sources/state-files.ts`, behind `src/server/queries/` (keeps ADR-0002).
- The lane registry says 33 lanes; the DB holds 7 (DB recreated 2026-10-24). The Fleet shows a data-source health panel and does not trust one source alone.

## 7. Design system

- One token source, `tokens.json`. It generates `tokens.css` (Fleet, web) and the terminal tone map `hooks/shared/tones.ts` (Pane). The mockup boards already share one `tokens.css`. Generating `tones.ts` from the same JSON is design intent; confirm it is feasible in P1a.
- Components: card shell (head 11px caps, body 13px mono, radius 6, gap 10, pad 12), state chip, plan bar, item, gauge.
- Widget contract (registry entry): `id`, `source` (read-only), `surfaces` (pane, band, fleet, with a terminal text fallback), `size` (1x or 2x), `states` (loading, empty, error, stale; all four drawn), `redaction` flag.
- The Fleet moves to dark by default. The app has no dark class and no font set up today (scout, `layout.tsx`).

## 8. Phases and acceptance

Every phase ends with a saved E2E artifact in `.claude/cache/e2e/<date>-<name>.<ext>` (AGENTS.md "Testing").
Each phase is its own branch, worktree and PR to `fork`, label `review:coderabbit`. Dave merges.

| Phase | Scope | Proof of done |
|---|---|---|
| **P0** | Make `apps/agentic-os` run: `.env.local`, DB roles `agentic_os_app` and `agentic_os_reader` (**confirm-first**), seed `project` from the registry, dark theme, port 3010 | `npm run e2e` smoke passes at desktop and phone width; `psql` as `agentic_os_reader` is denied `INSERT INTO public.sessions` |
| **P1a Pane** | `brief_set`; snapshot fields (repo, branch, worktree, goal, stopAt, title, ask, proof); band and `/os` per mockup board 1-2; chip rules; redaction | headless `claude -p` run calls `brief_set`; snapshot holds the fields; a task with no proof keeps the chip off DONE; a seeded secret does not render |
| **P1b Fleet** | Ready for Dave, session cards with titles, session detail, lane board (read-only), PR panel, data-source health, unmatched, closed | open the site with 2 live sessions; a new session shows within 10 s; Ready for Dave lists asks from state files; Playwright E2E saved |
| **P2** | Dave's writes: move a card, notes. Migration for session title, branch, worktree. Local handoff table with one-way Notion export | move a card in the UI, `lane.mjs board` shows it; handoff round trip |
| **P3** | Code-to-Code handoffs local (ADR 0006 live); generated progress page; staleness alarms; SSE | `/create_handoff` writes locally and exports; a resumed session reads it locally |

P0 and P2 hold confirm-first items (DB roles, migrations). Each needs Dave's yes and a query-plan check (databases skill).

## 9. Growth path (designed in, not built)

Each item is a widget or a tab on the same shell. None needs a redesign.

- **Next**: Workflows from journals, Evidence from `.claude/cache/e2e/`, Handoffs and Notes (local), session titles in the DB.
- **Later**: Comms (`lane_event`, `say` and `inbox` as threads), Planning and resourcing (capacity per lane), Swarm (agent teams, fan-out, cost caps, using the agent ledger data), Conflict view (file claims across sessions), Mobile (needs an ADR-0005 review).

## 10. Risks and open items

| Risk | Plan |
|---|---|
| The model forgets `brief_set` | Band shows `GOAL not set`; fallbacks in 5.5; count calls per session as a metric |
| Mod API changes between engine versions (facts in the mods README are tied to 2.1.292-2.1.296) | Run `node scripts/mods/validate-mods.mjs` and `e2e-headless.mjs` in every P1a PR |
| One unmatched hook per event per plugin | New widgets use matchers (README, 2.1.295-296 facts) |
| Always-loaded context budget has 5 characters of headroom (`AGENTS.md`) | Put docs in the plugin README and this directory; add no always-loaded rule text |
| DB roles missing; lanes drifted (33 vs 7) | P0 first; data-source health panel; do not trust one source |
| Secrets in transcripts and logs | Redaction before display, tested with a seeded secret |
| `review-budget-ab` lane edits `ccv3-mods/hooks/pr-loop/` (shared plugin) | Work in `hooks/agentic-os/` only; serialize commits; watch the lane board |
| Notion replacement reverses `notion-operating-model.md` | ADR 0006 records it; Notion export stays one-way |

Open questions, answered 2026-10-27 (none block P0):

1. **Where does `brief_set` live?** Dave asked for a recommendation.
   **Decision: in `hooks/agentic-os/`, same module.** Why: the mods README (line 71) says a helper that takes `$`,
   or an atom read with `read($, atom)`, must sit in the file of the hook. The band and pane read the brief atoms,
   so the tool that writes them must share their file. Pure helpers (schema, merge, redaction) go in `model.ts`.
   A new module would also need its own atoms, declared twice with the same plugin and key.
2. **Terminal tones from `tokens.json`?** Dave: "If it is possible to create your artboard design in the terminal pane let's try."
   **Decision: yes, as a time-boxed spike at the start of P1a.** Build the Overview layout of mockup board 1
   (bordered panels, two columns, chips, plan bar, gauges) with the terminal element table, at 110 and 144 columns.
   Success: the rendered frame keeps the board's structure and the state colours. Generate `tones.ts` from
   `tokens.json` only if the engine accepts the token colours as given [unverified: the README says only that Svg is
   missing from the terminal table, not what colour values `Text` accepts]. If it accepts only named tones, keep
   `tones.ts` hand-mapped and add a test that fails when a token and its tone drift apart.
3. **What gates retiring the FastAPI dashboard?** Dave asked for a recommendation.
   **Decision: the P1b Playwright E2E (desktop and phone width) plus a parity list, then Dave's explicit yes.**
   The parity list names every FastAPI route Dave still uses and the Fleet view that replaces it; each row has a test.
   No soak period: the map says the old dashboard on port 3434 is not running today, so retiring it costs nothing
   that is in use. Run `rg` over `opc/scripts/dashboard/` routers in P1b to build the list.

## 11. Not yet verified

- Scout and map facts about `apps/agentic-os` come from reading source and docs. Nobody ran the app.
- The pane code (`hooks/agentic-os/index.tsx`) was not read. The six-section mapping assumes the README description is current.
- The mockup uses illustrative data. Lane names and PR numbers match the board on 2026-10-27.
