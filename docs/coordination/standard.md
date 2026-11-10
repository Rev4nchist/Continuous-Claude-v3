# Coordination standard for lane board sessions

| Status | Value |
|---|---|
| State | DRAFT |
| Date | 2026-11-10 11:42 CST; two reviews applied 12:13 CST |
| Lane | `std-coordination` (holder: puffin #0f5ea433) |
| Branch | `docs/coordination-standard` |
| Loaded by | no session loads this file yet |
| Findings log | `C:/Users/dkhay/continuous-claude/.claudedocs/coordination/findings.md` |

## How to read this file

- `L` means `node C:/Users/dkhay/.claude/scripts/lane.mjs`. Run every lane command through this shim.
- Each rule has an id, the rule, a level, a loader and evidence.
- Levels: **advice** (text only; the session must remember), **warn** (code prints a warning), **deny** (code blocks the action).
- A rule moves up one level only with a probe result. Deny needs a yes from Dave.
- A rule gets code only after `.claudedocs/coordination/findings.md` shows a FAILED row for it.
- "warn (planned)" and "deny (planned)" mean the review-engine draft plan adds the code.
- Evidence tags: **code today** is a line in the primary checkout that this draft opened, with a short quote. **planned** cites `.claudedocs/re-execution/analysis/pre-go.md` (draft) by section. **not verified**: nobody opened or ran it.
- A line of a doc is "code today" for its text only. It is not proof of behaviour. "New rule" means no file holds the rule today.
- Seat: the review-engine coordinator seat, the session that holds `re-program` (#01895057 today). Wave and GO: see `docs/review-engine/README.md`.
- The rules describe the state after the gate-2, gate-3 and park-owner pull requests land. A "today:" note gives the current difference.
- Loaders: see "Planned loaders". This lane edits no loader file without a written release by DM.

## Part 1. Session start

Today: the banner says `You hold no lane. Claim one before starting work: ... next` (code today `.claude/hooks/src/lane-context.ts:672`).
`next` can offer an old lane. Planned work gets its own lane: add it, then claim it by id.
A session can be of two kinds. Order: subagent, headless, cloud, then the folder rows (S1.1 to S1.3).

| Id | Kind | First commands, in order | Gets with no action | Loader | Level | Evidence | Verified |
|---|---|---|---|---|---|---|---|
| S1.1 | Interactive, board folder | 1. `kanban-sync` skill, when the board has a phone page. 2. `L mine`. If it lists the lane for this work, continue on it. 3. `L board --by priority`. If a lane for this work exists, read its scope, then `L claim <id>`. 4. Only when no lane exists and `L board --all` shows the id in no state: `L add <new-id> --title "..." --scope "..."` with no `--band` (Dave sets the band), then `L claim <new-id>`. 5. Publish the phone page (P5.7). | Two blocks: "MULTI-SESSION COORDINATION ACTIVE" and the lane banner (held lanes, live peers and scopes, reminders, "Claimable next", commands). | SessionStart banner (`lane-context.ts`) | advice | code today `lane-context.ts:667` "`## Lane board ${board} (concurrent sessions on this board)`"; `session-register.ts:206` "MULTI-SESSION COORDINATION ACTIVE"; `lane.mjs:912` (`board --all` lists done lanes too) | yes (code read; no live run) |
| S1.2 | Worktree of a board repo | Same as S1.1. Run the shim from the worktree. Never run `lane.mjs` from the worktree copy. | Same as S1.1 when the worktree is under a registry root or is listed in the root's `.git/worktrees`. | SessionStart banner (`lane-context.ts`) | advice | code today `shared/lane-board.ts:211` "`isUnder(here, e.root) && (!best \|\| e.root.length > best.root.length)`"; `:221` "`source: 'worktree-gitdir'`" | yes (code read) |
| S1.3 | Unregistered folder | 1. `L board --project <key>` when the work belongs to a board. 2. Else no lane command. Ask Dave before `L project register`. | The session-register block with the line "no lane board (unregistered dir)", and direct messages. No lane banner. Lane verbs exit 1. | the session-register line; the hooks pull request adds the `board --project` command to it | deny (exit 1) | code today `session-register.ts:204-216` (the block); `shared/session-names.ts:188` "`'no lane board (unregistered dir)'`"; `lane-context.ts:606` "`isHeadless() ? {} : await directMessagesOnly(`"; `lane.mjs:224` "`no lane board for ${cwd}; register it:`" | yes (code read) |
| S1.4 | Headless `claude -p` | None, unless the prompt names a lane. Then `L claim <id>`. Before the run ends: `L release <id>`, or `L done <id>` when the work is merged. The launcher sets `LANE_CONTEXT_HEADLESS=1` before it starts `claude -p`; the session cannot set it. | By the code path: nothing from the lane hook, and an empty board line. The CLI still works. Not verified by a run; a memory note of 2026-11-04 says lane notes reached headless runs. | the prompt or the wrapper that starts the run; none in code | advice | code today `shared/lane-board.ts:145` "`startsWith('sdk') && env.LANE_CONTEXT_HEADLESS !== '1'`"; `shared/session-names.ts:186` "`if (isHeadless(env)) return '';`"; `lane.mjs:188` "`{ cli: true, projectFlag:`" | not verified |
| S1.5 | Subagent | None. Run no lane verb. Ask the parent. | Not verified. The CLI takes its identity from `CLAUDE_CODE_SESSION_ID`. | the parent's prompt; code today `CLAUDE.md.template:18` "subagents ask the parent" | advice | code today `lane.mjs:165` "`process.env.CLAUDE_CODE_SESSION_ID`" | not verified |
| S1.6 | Cloud | None until a probe runs. Ask Dave. | Not verified. No code path found. | none | advice | grep of `.claude/hooks/src` and `scripts/coordination` for `CLAUDE_CODE_REMOTE`, `REMOTE_CONTROL`, `remote_control`: no match | not verified |
| S1.7 | Remote Control (a local session that Dave drives from another device) | Use the row for its folder: S1.1, S1.2 or S1.3. | The same as that row. | as its folder row | advice | `~/.claude/settings.json:1001` "`remoteControlAtStartup`: true", so each interactive session is also Remote Control. No code reads the Remote Control state (grep as S1.6: no match) | not verified |
| S1.8 | Scheduled task | As S1.4. A wrapper that starts `claude -p` gives a headless run. | As S1.4. | the wrapper that starts the run; none in code | advice | code today `.claude/scripts/scheduled/scheduled-reminder-tick.ps1:8` (a comment) "the tick starts ONE headless `claude -p`" | not verified |

## Part 2. Lane life cycle

Loader: top of `lane-board.md`, except L2.13 (handoff skills).

| Id | Rule | Level | Evidence |
|---|---|---|---|
| L2.1 | Add a lane for planned work before you start: `L add <id> --title "..." --scope "..."`. A new lane is `backlog`. `add` on an id that exists replaces its title and its track (`unsorted` without `--track`), and its scope when `--scope` is given, with no owner check. Run `add` on an id that exists only for a lane you hold. | advice | code today `lane.mjs:1356` "`LANE_STATES.includes(flags.state) ? flags.state : 'backlog'`"; `:1348-1353` "`ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, track=EXCLUDED.track`" |
| L2.2 | Claim by id: `L claim <id>`. One session wins. The loser gets exit 3 and the holder's label. | deny | code today `lane.mjs:1127` "`WHERE l.id = $1 AND l.project_key = $4 AND ${RECLAIMABLE}`"; `:1172` "`e.soft = true; throw e;`" |
| L2.3 | `claim` refuses a lane that is `blocked`, `done` or has an open dependency. The exit code is not settled (pre-go §5.3 point 6). | deny (planned) | planned pre-go §3.2, §7 rows 1-2. Today: a claim on `blocked` or `done` succeeds and keeps the state (code today `lane.mjs:1124` "`CASE WHEN l.state IN ('backlog','ready') THEN 'active' ELSE l.state END`"). Read the state on `L board` before you claim. To reopen a `done` lane: `L state <id> ready`, then `L claim <id>` |
| L2.4 | Do not claim a lane that `next` or the banner offers before you read its scope. Old lanes stay claimable. | advice | code today `lane.mjs:1084` "`l.state IN ('ready','backlog') AND ${RECLAIMABLE}`" |
| L2.5 | Claim before your first edit. The claim declares your scope. | advice | code today `COORDINATION.md:68` "Claim a lane before you start. The claim is the declaration of scope" |
| L2.6 | Scope text holds two parts: `OWNS: ...` and `NEVER: ...`. Declare a wait as a dependency; the command is not designed (pre-go §5.3 points 1, 2 and 5). | advice; deny (planned) for a claim with an open dependency | planned pre-go §3.2. Today: put `WAITS ON: <lane>` first in the scope text, not in the note (pre-go §7 rows 1, 13). `note` replaces the whole note: code today `lane.mjs:1192` "`UPDATE agentic_os.lane SET note=$2, updated_at=now()`" |
| L2.7 | Note one status line at each phase: `L note <id> "..."`. The owner's note renews the lease. | advice | code today `lane.mjs:1193` "`lease_expires_at = CASE WHEN owner_session_id=$3`" |
| L2.8 | A lane stays held while its lease is live or its holder is active. A reclaim needs both: a lease that ended (90 minutes after the last renew) and a holder quiet for 5 minutes. | deny | code today `lane.mjs:137` "`const LEASE_MINUTES = 90;`"; `:363-373` (RECLAIMABLE) "`l.lease_expires_at < now()`" |
| L2.8a | The hook renews your leases at each prompt. Run `L renew` before a wait that can pass 90 minutes. After an idle time of more than 90 minutes, run `L mine` before your next edit. Before you claim a lane another session held, read its note and check its worktree for uncommitted work. | advice | code today `lane-context.ts:598-603` "`SET lease_expires_at = now() + interval '${LEASE_MINUTES} minutes'`" |
| L2.9 | Park a lane that waits, with the `park` verb. The verb is not designed: no flags, no storage, no resume verb (pre-go §12 item 3, §9 D4). | deny (planned, not designed) | planned pre-go §3.4, §7 row 10. Today: `L state <id> review --note "WAITS ON: <what>. NEXT: <step>"`. The lane keeps its owner. It is reclaimable when the 90-minute lease ends and you are quiet 5 minutes. To resume: `L mine`; if you hold it, `L state <id> active`; if not, read the note and `L claim <id>` |
| L2.10 | Only the holder changes a lane's state, `release` and `done` included. In the review-engine program the seat can also change it. A reclaimable lane (L2.8) has no holder for this rule: any session may change it after a note that says why (Dave, 2026-11-10). | deny (planned) | planned pre-go §3.4. Today: any session can (code today `lane.mjs:1250` "Known gap, deliberately left alone: WHERE is `id=$1` with no ownership check") |
| L2.11 | Release a lane you stop without finishing: `L release <id>`. It goes to `ready` and loses its owner. | advice | code today `lane.mjs:1256` "`owner_session_id = CASE WHEN $2 IN ('done','ready') THEN NULL`" |
| L2.12 | Mark done only after the merge: `L done <id> --merged <sha>`. A dependency is met only by `done` plus a SHA on `main`. A lane with no pull request: `L done <id> --note "NO MERGE: <evidence path>"`. It meets no dependency. | deny (planned) | planned pre-go §7 row 4. Today: `L done <id>` with the note "LANDED #N (main <sha>)" |
| L2.13 | Hand off: before `/create_handoff`, note the lane with the next step. Write the lane id and your session id in the handoff. Keep the lane. On `/resume_handoff`: run `L mine`. If the lane is not listed, run `L adopt --from <old-session-uuid>`. Adopt works only when this session has the old session's chosen name (not an auto word) or names it as previous, and the old session ended or is quiet 5 minutes. It moves every open lane of the old session. If adopt is refused, do not claim: ask Dave. | advice (new rule) | code today `lane.mjs:990` "`async adopt(c)`"; `:1003-1015` (old session ended or quiet); `session-label.mjs:157-163` "`return a !== '' && a === b && !isAutoName(a);`". No handoff skill has a lane step today (`resume_handoff/SKILL.md`: 0 matches for "lane", "board"). Both skills are outside this lane's write set |
| L2.14 | Drop a lane you added by mistake: `L done <id> --note "DROPPED: <why>"`. | advice (new rule) | code today `lane.mjs:57` "`done <id> [--note \"evidence\"]`" |

## Part 3. Ownership

Loader: top of `lane-board.md`.

| Id | Rule | Level | Evidence |
|---|---|---|---|
| O3.1 | One writer per file set at a time. A file that two lanes name has one writer at a time. | advice; deny inside one checkout for a file that another live session holds | code today `CLAUDE.md.template:18` "One writer per resource; agree the split through"; `file-claims.ts:148-153` "`permissionDecision: 'deny'`"; planned pre-go §4, §7 row 7 |
| O3.2 | The scope text lists the write set and the never-touch set. A program lane's overlap holds `ready`. | advice; deny (planned) for program lanes | planned pre-go §7 row 7 (`program.mjs ready`) |
| O3.3 | Before a pull request opens, run `git diff --name-only main...<branch>`. Compare it with the scope. Put the output in Evidence. | advice; warn (planned) | planned pre-go §7 row 8 (`check --diff`) |
| O3.4 | A lane that changes tracked files works on its own branch. A new branch or a new worktree needs Dave's yes. For `re-` lanes after GO: one lane, one worktree, one branch `re/<lane-id>`, one pull request (OPEN in the README: several small lanes in one pull request). | advice | code today `docs/review-engine/README.md:38-39` "One lane is one worktree, one branch `re/<lane-id>` and one PR" |
| O3.5 | A commit or a push needs Dave's yes for that task. Commit only your own files. Commits on one branch run one after another. Say so with `L say` before a commit run. | advice | code today `lane-context.ts:707` "same branch, two committers race .git/index.lock" (banner text, no check) |
| O3.6 | File claims deny inside one checkout. They do not see across worktrees. In a worktree, the scope text is the only guard. | advice; warn (planned, after GO) | code today `file-claims.ts:78` "`const filePath = input.tool_input?.file_path as string;`" (raw path); `shared/session-id.ts:191` folds the project to the git common dir, so the paths differ. planned pre-go §7 row 12 (T2.2) |
| O3.7 | Never edit a worktree copy of `lane.mjs` outside your lane's write set. Run a worktree copy only against a scratch database (`CONTINUOUS_CLAUDE_DB_URL`). | advice | code today `lane-board.md:9` "runs a stale copy in a worktree"; pre-go §7 (more hand rules) |
| O3.8 | Stage `.claude/hooks/dist/*` only for your own hook build. One hook build is in work at a time. A dist commit on `main` reaches every session. | advice | code today `COORDINATION.md:72` "Staging `.claude/hooks/dist/*.mjs` deploys the live harness"; planned pre-go §4 (dist row) |
| O3.9 | Run a `*-probe.mjs` only with `CONTINUOUS_CLAUDE_DB_URL` set to a scratch database. Probes write to the live database by default. | advice | code today `scripts/coordination/lane-race-probe.mjs:61-62` "`process.env.CONTINUOUS_CLAUDE_DB_URL \|\| process.env.DATABASE_URL`" (live database by default); no code is planned (pre-go §7 row 16) |
| O3.10 | The shim prints one WARNING when the primary checkout is off `main`, and still runs. | warn | code today `.claude/scripts/lane.mjs:46` "`is on ${where}, not main; running its lane.mjs anyway`" |

## Part 4. Messages

Loader: top of `lane-board.md`. A message to an idle session waits until Dave types in that session.

| Id | Pathway | Use it for | What it guarantees | Level | Evidence |
|---|---|---|---|---|---|
| M4.1 | Lane DM `L say "..." --to <name>` | one live peer, any board | Stored as an event. Shown at the peer's next prompt only when it is one of the peer's newest 12 unread events, tagged `[from <board>]` across boards. For older unread events the hook prints only a count and `inbox --peek`, then moves the read cursor past all of them, so `inbox --peek` no longer lists them. No receipt. Prints "sent" even when the insert failed (warning on stderr). | advice | code today `lane-context.ts:514` "`for (const e of unread.slice(-MAX_EVENTS))`"; `:517` "`[from ${e.project_key}]`"; `:521-522` "older suppressed"; `:718` "`advanceWatermark(client, wmKey(me, board)`"; `lane.mjs:421-426` (unread is after the cursor); `:1323` (CLI `inbox` tag); `:328` "`[lane] warn: event not recorded`"; `:1292-1293` return "sent to" after `logEvent` |
| M4.2 | Broadcast `L say "..."` | the whole board: a commit run, a CLI change before it lands | Same limits as M4.1. Stays on this board. | advice | code today `lane-board.md:22` "`say` broadcasts stay on the board"; no code is planned (pre-go §7 row 15) |
| M4.3 | Lane note `L note <id>` | the status of your lane | Replaces the previous note. Peers see it in their inbox. | advice | code today `lane.mjs:1192` "`UPDATE agentic_os.lane SET note=$2`" |
| M4.4 | Notion handoff row | a future session, not a live peer | Found by `/resume_handoff`. No delivery time. | advice | code today `CLAUDE.md.template:173` "`/create_handoff` writes a 📬 Handoffs row" |
| M4.5 | `SendMessage` | your subagents; a session that `ListAgents` shows | Not verified. | advice | code today `CLAUDE.md.template:18-19` "agree the split through `SendMessage`" |
| M4.6 | AskUserQuestion | a choice for Dave; never a peer | Dave answers in this session. | advice | code today `CLAUDE.md.template:24` "Two or more open choices: `AskUserQuestion`" |
| M4.7 | Any | a session that is idle | `peers` lists only sessions active in the last 5 minutes. The banner shows at most 12 unread events and marks all as read (M4.1). | advice | code today `lane.mjs:139` "`const STALE_MINUTES = 5;`"; `lane.mjs:430-440` (`livePeers`); `lane-context.ts:648` (banner peers); `:125` "`const MAX_EVENTS = 12;`"; `:718` |
| M4.8 | Any | a reply | A held or unanswered message is not a reply. Do other work, not the shared resource. No reply after that: ask Dave. | advice | code today `CLAUDE.md.template:20-21` "A message held for approval or unanswered is not a reply" |
| M4.9 | Any | message form | Plain text with names, SHAs and paths. Write a session as "name #sid8". | advice | code today `CLAUDE.md.template:20` "Cross-session messages are plain text with names, SHAs and paths"; `CONTEXT.md:49` (Session handle) |
| M4.10 | Any | a message that must arrive | Also write it in your lane note. Ask Dave when no reply comes. | advice (new rule) | follows from M4.1 |

## Part 5. Shared pages

Loader: top of `lane-board.md`.

| Id | Rule | Level | Evidence |
|---|---|---|---|
| P5.1 | Read the live phone page (Artifact tool, action `read`, no `path`), render, publish at once. Render with the primary checkout's `render-board.mjs --project <key>`, never a worktree copy. | advice | code today `lane-board.md:46` "Order: read the live url (Artifact tool, action `read`, without `path`"; `.claude/rules-src/live-copy-before-use.md:4` "Before a step that needs the live copy, read it"; `shared/lane-board.ts:257` "`node ${primaryRepo(env)}/scripts/coordination/render-board.mjs --project ${board}`" |
| P5.2 | Publish a board's phone page only to that board's own url, with no `capabilities`. | advice | code today `lane-board.md:45` "Publish a board's page only to its own url, with no `capabilities`" |
| P5.3 | Before you sync, check the `<meta name="lane-board">` stamp names this board. Stop if it does not. | advice | code today `.claude/skills/kanban-sync/SKILL.md:32` "If it is missing or names another board, stop and report" |
| P5.4 | Fix a wrong status at the source (`L note`), never in rendered HTML. | advice | code today `create_handoff/SKILL.md:216-218` "correct it at the source of truth (for the lane board:" |
| P5.5 | A board with no `laneArtifact` renders a local page. Never publish it. | advice | code today `lane-board.md:44` "A board with no `laneArtifact` renders `lane-board-<key>.html`" |
| P5.6 | Never pass `force: true` unless Dave asks to discard that version. | advice | code today `create_handoff/SKILL.md:261` "Never pass `force: true` to skip the read-first check" |
| P5.7 | After a lane change on a board with a phone page, publish the phone page before the turn ends. Use the three steps the Stop gate prints: read live, render from the primary checkout, publish. The gate blocks the end of the turn once for each batch of lane changes. | warn (one block) | code today `lane-board-stop-gate.ts:54-66` "The lane board page for board ${board} is out of date"; `:7-8` "blocks the end of a turn ONCE per batch of lane changes" |

## Part 6. Board contract

Loader: top of `lane-board.md`.

| Id | Rule | Level | Evidence |
|---|---|---|---|
| B6.1 | A board needs an active registry entry. The longest matching root wins, then a worktree gitdir. | deny (no board: exit 1) | code today `shared/lane-board.ts:206` "`e.status.toLowerCase() !== 'inactive' && e.root`". Two boards resolve: `continuous-claude` (with `agentic-os`) and `greymatter-design`. Six entries are inactive (`.claude/project-registry.json`) |
| B6.2 | Register a folder only with Dave's yes, from the primary checkout, with `L project register`. Remove a board only with Dave's yes: `L project unregister <key>` (never `continuous-claude`). | advice | code today `lane-board.md:16` "Run it from the primary checkout only, and only with Dave's yes"; `.claude/rules-src/every-surface-checklist.md:45` "One writer for a board: `project register`, from the primary checkout"; `lane.mjs:95` "`project unregister <key>   # not continuous-claude`" |
| B6.3 | Lane ids are global. `add` refuses an id of another board. A new board's starter lane uses the `<key>-` prefix. | deny (foreign id) | code today `lane.mjs:1361` "`if (!rows.length) throw await foreignId(c, id);`"; `lane-board.md:23` "Lane ids are global across boards" |
| B6.4 | `continuous-claude` has the phone page in `.claude/artifacts.json`. Another board has a phone page only with `laneArtifact`. Dave starts one with `/publish-board <key>`. | advice | code today `lane-board.md:40` "Dave starts one with `/publish-board <key>`" |
| B6.5 | Reserved prefixes: `re-` (review-engine program, HOLD until Dave's GO) and `coord-` (lane tooling lanes). Other sessions claim neither. | advice; deny (planned) for a second `re-` lane per owner | code today `docs/review-engine/README.md:6` "No session may claim a `re-` lane before Dave's GO"; planned pre-go §3, §7 rows 2, 5 |
| B6.6 | A database writer sets `lane.client_version` before it writes. Without it, the trigger refuses a change or a delete of a lane on a board other than `continuous-claude` (error 42501). `continuous-claude` lanes are not protected. The setting is a cooperative flag, not security. | deny (other boards only) | code today `apps/agentic-os/drizzle/0004_per_project_lanes.sql:21-24` "`IF OLD.project_key <> 'continuous-claude'`"; `:12-13` "It keeps working on CCv3 lanes"; `lane-context.ts:595` "`SELECT set_config('lane.client_version'`" |

## Part 7. One service line

| Id | Rule | Level | Loader | Evidence |
|---|---|---|---|---|
| V7.1 | During a wave, no session changes verb behaviour, exit codes, banner text or `lane-board.md` without the agreement of the seat. | advice (new rule) | top of `lane-board.md` | planned pre-go §4.1 (Owns lists). pre-go §7 row 15 gives only a warning by say before a land; no code is planned |

## Loader text

The exact lines each loader gets. `<shim>` is `node C:/Users/dkhay/.claude/scripts/lane.mjs`.

- S1.1 and S1.2, banner, when the session holds no lane (3 lines):
  `You hold no lane. 1. kanban-sync when the board has a phone page. 2. <shim> mine. 3. <shim> board --by priority, then claim the lane for your work by id.`
  `No lane for it: <shim> add <new-id> only when <shim> board --all shows the id in no state, then claim it. Never add on a lane you do not hold.`
  `Rules: lane-board.md. Rule ids: docs/coordination/standard.md.`
- S1.3, session-register line (2 lines):
  `no lane board (unregistered dir). Work for a board: <shim> board --project <key>. Else run no lane command.`
  `Register a folder only with Dave's yes.`
- `lane-board.md` gets the Id, Rule and Level columns of parts 2 to 7 only. It replaces only the lines a rule covers: `lane-board.md:9-10` (O3.7, O3.10), `:16-17` (B6.2, S1.4), `:22-23` (M4.2, B6.3), `:40` (B6.4), `:44-46` (P5.5, P5.2, P5.1). Evidence stays in this file.

## Not verified

- What a cloud, Remote Control, subagent or scheduled-task session sees. No probe.
- The value of `CLAUDE_CODE_ENTRYPOINT` in a cloud or Remote Control session. A value that starts with `sdk` makes the hook treat it as headless (`shared/lane-board.ts:145`).
- Headless: the code gate (S1.4) conflicts with a memory note of 2026-11-04 that says lane notes reached headless runs. No headless run was made.
- How `ListAgents` builds its list and how `SendMessage` delivers. Neither is in the repo.
- The live `~/.claude/settings.json` hook registrations. Only the template was read by the scouts.
- Whether a worktree session outside a board root that holds no lane is listed as a peer.
- The Artifact tool refusal of a publish without a live read. It is tool behaviour, not repo code.
- The owner of a lane at the time of a past event. `adopt` moves the owner and logs no `claimed` event (`lane.mjs:1024-1025`).
- No probe was run. Probes write fixtures to the live database. The SQL that was run is in the findings log.

## Decided by Dave (2026-11-10, by tap in session puffin #0f5ea433)

- Point 1: the banner says claim by id, not `next` (S1.1). This also changes one line in the repo `CLAUDE.md:10` (always loaded; same length or shorter) and in the pointer doc (`docs/harness/lane-board-claude-md-pointer.md:8`). Both need the seat's release.
- Point 2: a session announces a commit run with `L say` (O3.5), not with `SendMessage` or a lane note.
- Point 8: O3.4 in full (one lane, one worktree, one branch, one pull request) applies to the review-engine program only. Any other lane that changes tracked files uses its own branch.
- Point 9: a reclaimable lane has no holder for L2.10. Any session may change it after a note that says why. Findings row 13 depends on this.
- Point 10: to reopen a `done` lane, run `L state <id> ready`, then `L claim <id>` (L2.3). Never claim a `done` lane directly (findings rows 3, 4 and 6).

## Open points for Dave

The numbers are those of the first draft. Points 1, 2, 8, 9 and 10 are decided above.

3. Park-owner timing: before GO or after GO (pre-go §9 D2). L2.9 and L2.10 change level then.
4. `park` storage: reuse the lease or a new column (pre-go §9 D4). It decides what "parked" shows.
5. Headless: is the banner opt-in (`LANE_CONTEXT_HEADLESS=1`) the rule, or should a scheduled run get the board?
6. The cloud and Remote Control rule, and spend for one probe per session kind.
7. Coordinator seat: may it hold a second `re-` lane (proposal marks this OPEN)?

## Planned loaders

Each row is a proposed edit by the seat or the holder of the file. This lane edits none of these paths without a written release by DM.
pre-go §3.2 and §4.1 name gate-2 as the owner of `lane-context.ts`. pre-go §3.3, §3.4 and §4.1 name gate-3 and park-owner as the owners of the three board docs.

| Part | Loader | When |
|---|---|---|
| 1 (the lines in "Loader text") | SessionStart banner: `lane-context.ts`, `session-register.ts`, `shared/session-names.ts` | after the seat (#01895057) releases each of these files by name in a DM: `.claude/hooks/src/lane-context.ts`, `.claude/hooks/src/session-register.ts`, `.claude/hooks/src/shared/session-names.ts`, `.claude/hooks/dist/*`, `.claude/hooks/dist/.build-inputs.json`; and the seat confirms that no hook build is in work |
| 2 to 7 (Id, Rule, Level) | top section of `.claude/rules-ondemand/lane-board.md` | after the seat releases by name: `.claude/rules-ondemand/lane-board.md`, `COORDINATION.md`, `docs/harness/lane-board-claude-md-pointer.md` |
| L2.13 | one lane step in `create_handoff` and `resume_handoff` | after Dave's yes; both skills are outside this lane's write set |
| All | `COORDINATION.md` becomes a pointer to this file | with row 2 |

No standard text goes in an always-loaded file: 180 characters are free of 26000 (pre-go §6).
The hooks pull request also removes the false banner line "Research findings are shared automatically" (`session-register.ts:214`).

## Sources

- `C:/Users/dkhay/continuous-claude/.claudedocs/2026-11-10-coordination-standards-eval.md` (sections 1 to 8)
- `C:/Users/dkhay/continuous-claude/.claudedocs/re-execution/analysis/pre-go.md` (sections 3, 4, 7, 9, 12; draft plan)
- `C:/Users/dkhay/continuous-claude/docs/review-engine/README.md`
- `C:/Users/dkhay/continuous-claude/.claude/rules-ondemand/lane-board.md` and `manifest.json:223-233`
- `C:/Users/dkhay/continuous-claude/COORDINATION.md`; `docs/harness/lane-board-claude-md-pointer.md`
- `C:/Users/dkhay/continuous-claude/.claude/templates/CLAUDE.md.template`
- `C:/Users/dkhay/continuous-claude/.claude/skills/create_handoff/SKILL.md`, `resume_handoff/SKILL.md`, `kanban-sync/SKILL.md`
- Code: `scripts/coordination/lane.mjs`, `session-label.mjs`, `lane-race-probe.mjs`; `.claude/scripts/lane.mjs`; `.claude/hooks/src/lane-context.ts`, `session-register.ts`, `file-claims.ts`, `lane-board-stop-gate.ts`, `shared/lane-board.ts`, `shared/session-names.ts`, `shared/session-id.ts`; `apps/agentic-os/drizzle/0004_per_project_lanes.sql`
- Lane database, SELECT only: `C:/Users/dkhay/continuous-claude/.claudedocs/coordination/findings.md`
