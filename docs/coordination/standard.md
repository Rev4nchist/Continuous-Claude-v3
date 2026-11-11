# Coordination standard for lane board sessions

| Status | Value |
|---|---|
| State | DRAFT |
| Date | 2026-11-10 11:42 CST; two reviews applied 12:13 CST; decisions by Dave and the milestone rules (M4.11 to M4.16) added the same day; cited lines checked again against main 9b784791 at 2026-11-10 19:07 CST; cited lines checked again against main b92f18f8 at 2026-11-10 22:36 CST |
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
- Evidence tags: **code today** is a line in the primary checkout that this draft opened, with a short quote. **planned** cites `.claudedocs/re-execution/analysis/pre-go.md` (draft) by section, or a contract note in `.claudedocs/re-execution/contracts/` by point. **not verified**: nobody opened or ran it.
- A line of a doc is "code today" for its text only. It is not proof of behaviour. "New rule" means no file holds the rule today. For M4.11 to M4.16 it means no file holds the rule outside the review-engine program.
- Seat: the review-engine coordinator seat, the session that holds `re-program` (#01895057 today). Wave and GO: see `docs/review-engine/README.md`.
- Gate-1 (#484), gate-2 (#486), the program database verbs (#487), gate-3 (#488) and the seat's map pull request (#489) are on `main` (b92f18f8). Park-owner is not. The rules describe the state after park-owner lands. A "today:" note gives the current difference.
- Loaders: see "Planned loaders". This lane edits no loader file without a written release by DM.

## Part 1. Session start

Today: the banner says `You hold no lane. Claim one by id before starting work:`, then `board --by priority` and `claim <id>` (code today `.claude/hooks/src/lane-context.ts:680-682`).
`next` skips a lane with an open dependency, but it can still offer an old lane (code today `lane.mjs:1512-1516`). The exit 3 message still says "Pick another: lane.mjs next" (`lane.mjs:1595`). Planned work gets its own lane: add it, then claim it by id.
A session can be of two kinds. Order: subagent, headless, cloud, then the folder rows (S1.1 to S1.3).

| Id | Kind | First commands, in order | Gets with no action | Loader | Level | Evidence | Verified |
|---|---|---|---|---|---|---|---|
| S1.1 | Interactive, board folder | 1. `kanban-sync` skill, when the board has a phone page. 2. `L mine`. If it lists the lane for this work, continue on it. 3. `L board --by priority`. If a lane for this work exists, read its scope, then `L claim <id>`. 4. Only when no lane exists and `L board --all` shows the id in no state: `L add <new-id> --title "..." --scope "..."` with no `--band` (Dave sets the band), then `L claim <new-id>`. 5. Publish the phone page (P5.7). 6. After a new claim only: read the note of each related lane, then send the start message (M4.11). | Two blocks: "MULTI-SESSION COORDINATION ACTIVE" and the lane banner (held lanes, live peers and scopes, reminders, "Claimable (claim by id)", commands). | SessionStart banner (`lane-context.ts`) | advice | code today `lane-context.ts:674` "`## Lane board ${board} (concurrent sessions on this board)`"; `:680` "You hold no lane. Claim one by id before starting work:"; `:713` "Claimable (claim by id):"; `session-register.ts:206` "MULTI-SESSION COORDINATION ACTIVE"; `lane.mjs:1342` (`board --all` lists done lanes too; `--by priority` does not) | yes (code read; no live run) |
| S1.2 | Worktree of a board repo | Same as S1.1. Run the shim from the worktree. Never run `lane.mjs` from the worktree copy. | Same as S1.1 when the worktree is under a registry root or is listed in the root's `.git/worktrees`. | SessionStart banner (`lane-context.ts`) | advice | code today `shared/lane-board.ts:211` "`isUnder(here, e.root) && (!best \|\| e.root.length > best.root.length)`"; `:221` "`source: 'worktree-gitdir'`" | yes (code read) |
| S1.3 | Unregistered folder | 1. `L board --project <key>` when the work belongs to a board. 2. Else no lane command. Ask Dave before `L project register`. | The session-register block with the line "no lane board (unregistered dir)", and direct messages. No lane banner. Lane verbs exit 1. | the session-register line; the hooks pull request adds the `board --project` command to it | deny (exit 1) | code today `session-register.ts:204-216` (the block); `shared/session-names.ts:188` "`'no lane board (unregistered dir)'`"; `lane-context.ts:607` "`isHeadless() ? {} : await directMessagesOnly(`"; `lane.mjs:237` "`no lane board for ${cwd}; register it:`" | yes (code read) |
| S1.4 | Headless `claude -p` | None, unless the prompt names a lane. Then `L claim <id>`. Before the run ends: `L release <id>`, or `L done <id>` when the work is merged. The launcher sets `LANE_CONTEXT_HEADLESS=1` before it starts `claude -p`; the session cannot set it. | By the code path: nothing from the lane hook, and an empty board line. The CLI still works. Not verified by a run; a memory note of 2026-11-04 says lane notes reached headless runs. | the prompt or the wrapper that starts the run; none in code | advice | code today `shared/lane-board.ts:145` "`startsWith('sdk') && env.LANE_CONTEXT_HEADLESS !== '1'`"; `shared/session-names.ts:186` "`if (isHeadless(env)) return '';`"; `lane.mjs:201` "`{ cli: true, projectFlag:`" | not verified |
| S1.5 | Subagent | None. Run no lane verb. Ask the parent. | Not verified. The CLI takes its identity from `CLAUDE_CODE_SESSION_ID`. | the parent's prompt; code today `CLAUDE.md.template:18` "subagents ask the parent" | advice | code today `lane.mjs:178` "`process.env.CLAUDE_CODE_SESSION_ID`" | not verified |
| S1.6 | Cloud | None until a probe runs. Ask Dave. | Not verified. No code path found. | none | advice | grep of `.claude/hooks/src` and `scripts/coordination` for `CLAUDE_CODE_REMOTE`, `REMOTE_CONTROL`, `remote_control`: no match | not verified |
| S1.7 | Remote Control (a local session that Dave drives from another device) | Use the row for its folder: S1.1, S1.2 or S1.3. | The same as that row. | as its folder row | advice | `~/.claude/settings.json:1001` "`remoteControlAtStartup`: true", so each interactive session is also Remote Control. No code reads the Remote Control state (grep as S1.6: no match) | not verified |
| S1.8 | Scheduled task | As S1.4. A wrapper that starts `claude -p` gives a headless run. | As S1.4. | the wrapper that starts the run; none in code | advice | code today `.claude/scripts/scheduled/scheduled-reminder-tick.ps1:8` (a comment) "the tick starts ONE headless `claude -p`" | not verified |

## Part 2. Lane life cycle

Loader: top of `lane-board.md`, except L2.13 (handoff skills).

| Id | Rule | Level | Evidence |
|---|---|---|---|
| L2.1 | Add a lane for planned work before you start: `L add <id> --title "..." --scope "..."`. A new lane is `backlog`. `add` on an id that exists replaces its title and its track (`unsorted` without `--track`), and its scope when `--scope` is given, with no owner check. Run `add` on an id that exists only for a lane you hold. | advice | code today `lane.mjs:1791` "`LANE_STATES.includes(flags.state) ? flags.state : 'backlog'`"; `:1783-1788` "`ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, track=EXCLUDED.track`" |
| L2.2 | Claim by id: `L claim <id>`. One session wins. The loser gets exit 3 and the holder's label. | deny | code today `lane.mjs:721` "`WHERE l.id = $1 AND l.project_key = $4 AND ${RECLAIMABLE}`"; `:1597` "`e.soft = true; throw e;`"; `:2351` "`e.soft ? 3 : 1`" |
| L2.3 | `claim` refuses a lane that is `blocked`, `done` or has an open dependency. It exits 4 with `REFUSED claim <id> [blocked]`, `[done]` or `[open-dependency]`. A lane that a live session holds still gives exit 3 (L2.2). To reopen a `done` lane: `L state <id> ready`, then `L claim <id>`. | deny | code today `lane.mjs:722` "`AND l.state NOT IN ('done','blocked')`"; `:707` (the dependency clause, only for a lane in `backlog` or `ready` or with no owner); `:785` "`A done lane is never claimed. To reopen it:`"; `:788` `[blocked]`; `:793` `[open-dependency]`; `:508` "`e.exitCode = 4;`"; `:1568-1571` (a refusal only when the lane is reclaimable). `--dep-override --reason` claims past an open dependency and logs a `dep_override` event (`:742`). Without table `lane_dep` the dependency gate is off with one warning (`:668`). The live table exists (SELECT `to_regclass`, 2026-11-10 19:02 CST). It still exists at 2026-11-10 22:15 CST (SELECT only) |
| L2.4 | Do not claim a lane that `next` or the banner offers before you read its scope. Old lanes stay claimable. Both skip a lane with an open dependency. | advice | code today `lane.mjs:1515` "`l.state IN ('ready','backlog') AND ${RECLAIMABLE}`"; `:1512` "`AND NOT ${openDepSql('l')}`"; `lane-context.ts:668` (banner, the same clause) |
| L2.5 | Claim before your first edit. The claim declares your scope. | advice | code today `COORDINATION.md:69` "The claim is the declaration of scope" |
| L2.6 | Scope text holds two parts: `OWNS: ...` and `NEVER: ...`. It can end with `RELATES TO: <lane ids>` (M4.12). Declare a wait as a dependency. The only writer is `L seed <file.json>` with an object `{"lanes": [...], "edges": [{"lane": "<id>", "dependsOn": "<id>"}]}`. It replaces every edge of each lane in `lanes`, and the title and the track of each lane (L2.1). No verb writes one edge. Also put `WAITS ON: <lane>` first in the scope text, not in the note. | advice; deny for a claim with an open dependency (L2.3) | code today `lane.mjs:1925` "`if (parsed.form === 'object')`"; `:931` "`DELETE FROM agentic_os.lane_dep WHERE lane_id = ANY($1::text[])`"; `:943` "`seed refused: cycle`"; `:980` (a missing lane "counts as open"); `lane-seed-file.mjs:52` (an edge has exactly `lane` and `dependsOn`); `lane.mjs:408` (`board` prints "waits on:"). Today: 0 edges are stored (SELECT count on `agentic_os.lane_dep`, 2026-11-10 19:02 CST; again 0 at 2026-11-10 22:15 CST). `note` replaces the whole note: code today `lane.mjs:1617` "`UPDATE agentic_os.lane SET note=$2, updated_at=now()`" |
| L2.7 | Note one status line at each phase: `L note <id> "..."`. The owner's note renews the lease. | advice | code today `lane.mjs:1618` "`lease_expires_at = CASE WHEN owner_session_id=$3`" |
| L2.8 | A lane stays held while its lease is live or its holder is active. A reclaim needs both: a lease that ended (90 minutes after the last renew) and a holder quiet for 5 minutes. | deny | code today `lane.mjs:144` "`const LEASE_MINUTES = 90;`"; `:376-387` (`reclaimableSql`, RECLAIMABLE) "`${alias}.lease_expires_at < now()`" |
| L2.8a | The hook renews your leases at each prompt. Run `L renew` before a wait that can pass 90 minutes. After an idle time of more than 90 minutes, run `L mine` before your next edit. Before you claim a lane another session held, read its note and check its worktree for uncommitted work. | advice | code today `lane-context.ts:599-604` "`SET lease_expires_at = now() + interval '${LEASE_MINUTES} minutes'`" |
| L2.9 | Park a lane that waits, with the `park` verb. The verb is not designed: no flags, no storage, no resume verb (pre-go §12 item 3, §9 D4). | deny (planned, not designed) | planned pre-go §3.4, §7 row 10. Today: `L state <id> review --note "WAITS ON: <what>. NEXT: <step>"`. The lane keeps its owner. It is reclaimable when the 90-minute lease ends and you are quiet 5 minutes. To resume: `L mine`; if you hold it, `L state <id> active`; if not, read the note and `L claim <id>` |
| L2.10 | Only the holder changes a lane's state, `release` and `done` included. In the review-engine program the seat can also change it. A reclaimable lane (L2.8) has no holder for this rule: any session may change it after a note that says why (Dave, 2026-11-10). | deny (planned) | planned pre-go §3.4. Today: any session can, `done --merged` and `done --no-pr` included (code today `lane.mjs:1682` "Known gap, deliberately left alone: WHERE is `id=$1` with no ownership check") |
| L2.11 | Release a lane you stop without finishing: `L release <id>`. It goes to `ready` and loses its owner. | advice | code today `lane.mjs:1688` "`owner_session_id = CASE WHEN $2 IN ('done','ready') THEN NULL`" |
| L2.12 | Mark done only after the merge: `L done <id> --merged <sha>`. A lane with no pull request: `L done <id> --no-pr --evidence <path>`. The path is a file under `.claudedocs/e2e-<lane-id>/`. The command records the SHA of `main` at that time. Both forms meet a dependency. A plain `L done <id>` still works but meets no dependency, and on a met lane it writes nothing. A wrong `done` opens the dependent lanes until the seat's recheck. | advice; deny for a `--merged` SHA that is not on `main` or an `--evidence` path outside the folder | code today `lane.mjs:58-60` (the three forms); `:539` `[not-a-commit]`; `:548` `[not-on-main]`; `:592` `[no-evidence]`, exit 4 (`:508`); `:644` "`no PR; main`"; `:661` "`a done without --merged meets no dependency`"; `:1679` "`already met`". The SHA must be on local `main` of the board root (`:59`). pre-go §7 row 4 planned the seat's recheck. It is `program.mjs check --board`, live on `main` since PR #487: code today `scripts/review-engine/program.mjs:206` "`'check --board': board('checkBoardVerb'),`". Read in code, not run. It gives a `FAIL` line only for lanes of the review-engine map (`scripts/review-engine/lib/board-check.mjs:133`). Run it from the primary checkout (`.claude/rules-ondemand/review-engine.md:5`). A map lane with a plain `done` gives `FAIL done-not-met` (`lib/board-check.mjs:30-31`), exit 1 (`lib/db-verbs.mjs:200`). A `--merged` SHA shared by lanes that are not one pack gives `FAIL shared-sha` (`lib/board-check.mjs:96-97`). A `--merged` SHA that touches none of the Owns files of the lane or its pack gives `FAIL sha-no-owns` (`lib/board-check.mjs:116`). A `--no-pr` done gets only a note (`lib/board-check.mjs:85`). For a SHA that git cannot read, the Owns check gives only a note (`lib/board-check.mjs:112`). It does not check that the SHA is on `main`. No hook or job runs it (git grep at cf0211e0 of `.claude/hooks/src`, `.github`, `scripts/coordination`, `.claude/scripts`: no match). The seat asked for this change (lane event 2841) |
| L2.13 | Hand off: before `/create_handoff`, note the lane with the next step. Write the lane id and your session id in the handoff. Keep the lane. On `/resume_handoff`: run `L mine`. If the lane is not listed, run `L adopt --from <old-session-uuid>`. Adopt works only when this session has the old session's chosen name (not an auto word) or names it as previous, and the old session ended or is quiet 5 minutes. It moves every open lane of the old session. If adopt is refused, do not claim: ask Dave. | advice (new rule) | code today `lane.mjs:1420` "`async adopt(c)`"; `:1433-1445` (old session ended or quiet); `session-label.mjs:157-163` "`return a !== '' && a === b && !isAutoName(a);`". No handoff skill has a lane step today (`resume_handoff/SKILL.md`: 0 matches for "lane", "board"). Both skills are outside this lane's write set |
| L2.14 | Drop a lane you added by mistake: `L done <id> --note "DROPPED: <why>"`. | advice (new rule) | code today `lane.mjs:58` "`done <id> [--note \"evidence\"]`" |

## Part 3. Ownership

Loader: top of `lane-board.md`.

| Id | Rule | Level | Evidence |
|---|---|---|---|
| O3.1 | One writer per file set at a time. A file that two lanes name has one writer at a time. | advice; deny inside one checkout for a file that another live session holds | code today `CLAUDE.md.template:18` "One writer per resource; agree the split through"; `file-claims.ts:148-153` "`permissionDecision: 'deny'`"; planned pre-go §4, §7 row 7 |
| O3.2 | The scope text lists the write set and the never-touch set. A program lane's overlap holds `ready`. | advice; deny (planned) for program lanes | planned pre-go §7 row 7 (`program.mjs ready`). It is live on `main` since PR #487: code today `scripts/review-engine/program.mjs:209` "`ready: board('ready'),`". Read in code, not run. An Owns overlap with another program lane in work gives a `HELD BACK` line with reason `owns-held` (`scripts/review-engine/lib/ready.mjs:60-61`, `:164`). The exit code is 0 (`lib/db-verbs.mjs:111`). It sees program lanes only. It holds a lane back but blocks no claim |
| O3.3 | Before a pull request opens, run `git diff --name-only main...<branch>`. Compare it with the scope. Put the output in Evidence. | advice; warn (planned) | planned pre-go §7 row 8 (`check --diff`). Today: a program lane can run `program.mjs check --diff <lane-id>` by hand; it exits 1 for a file outside the Owns list (code today `scripts/review-engine/program.mjs:168-170` "`diff-outside-owns`"). No hook runs it |
| O3.4 | A lane that changes tracked files works on its own branch. A new branch or a new worktree needs Dave's yes. For `re-` lanes after GO: one lane, one worktree, one branch `re/<lane-id>`, one pull request (one exception in the README: the one trial pack on the Pack line of `map.md`; Dave, 2026-11-10). | advice | code today `docs/review-engine/README.md:38-39` "One lane is one worktree, one branch `re/<lane-id>` and one PR" |
| O3.5 | A commit or a push needs Dave's yes for that task. Commit only your own files. Commits on one branch run one after another. Say so with `L say` before a commit run. | advice | code today `lane-context.ts:718` "same branch, two committers race .git/index.lock" (banner text, no check) |
| O3.6 | File claims deny inside one checkout. They do not see across worktrees. In a worktree, the scope text is the only guard. | advice; warn (planned, after GO) | code today `file-claims.ts:78` "`const filePath = input.tool_input?.file_path as string;`" (raw path); `shared/session-id.ts:191` folds the project to the git common dir, so the paths differ. planned pre-go §7 row 12 (T2.2) |
| O3.7 | Never edit a worktree copy of `lane.mjs` outside your lane's write set. Run a worktree copy only against a scratch database (`CONTINUOUS_CLAUDE_DB_URL`). | advice | code today `lane-board.md:9` "runs a stale copy in a worktree"; pre-go §7 (more hand rules) |
| O3.8 | Stage `.claude/hooks/dist/*` only for your own hook build. One hook build is in work at a time. A dist commit on `main` reaches every session. | advice | code today `COORDINATION.md:73` "Staging `.claude/hooks/dist/*.mjs` deploys the live harness"; planned pre-go §4 (dist row) |
| O3.9 | Run a `*-probe.mjs` only with `CONTINUOUS_CLAUDE_DB_URL` set to a scratch database. A probe can write to the live database by default. | advice | code today `scripts/coordination/lane-race-probe.mjs:64` "`process.env.CONTINUOUS_CLAUDE_DB_URL \|\| process.env.DATABASE_URL`"; on main 9b784791 this probe refuses a database that is not a scratch one, exit 2 (`:66-69`). The other probes were not checked; no code is planned (pre-go §7 row 16) |
| O3.10 | The shim prints one WARNING when the primary checkout is off `main`, and still runs. | warn | code today `.claude/scripts/lane.mjs:46` "`is on ${where}, not main; running its lane.mjs anyway`" |

## Part 4. Messages

Loader: top of `lane-board.md`. A message to an idle session waits until Dave types in that session.

| Id | Pathway | Use it for | What it guarantees | Level | Evidence |
|---|---|---|---|---|---|
| M4.1 | Lane DM `L say "..." --to <name>` | one live peer, any board | Stored as an event. Shown at the peer's next prompt only when it is one of the peer's newest 12 unread events, tagged `[from <board>]` across boards. For older unread events the hook prints only a count and `inbox --peek`, then moves the read cursor past all of them, so `inbox --peek` no longer lists them. No receipt. Prints "sent" even when the insert failed (warning on stderr). | advice | code today `lane-context.ts:515` "`for (const e of unread.slice(-MAX_EVENTS))`"; `:518` "`[from ${e.project_key}]`"; `:522-523` "older suppressed"; `:729` "`advanceWatermark(client, wmKey(me, board)`"; `lane.mjs:436-441` (unread is after the cursor); `:1758` (CLI `inbox` tag); `:341` "`[lane] warn: event not recorded`"; `:1727-1728` return "sent to" after `logEvent` |
| M4.2 | Broadcast `L say "..."` | the whole board: a commit run, a CLI change before it lands | Same limits as M4.1. Stays on this board. | advice | code today `lane-board.md:22` "`say` broadcasts stay on the board"; no code is planned (pre-go §7 row 15) |
| M4.3 | Lane note `L note <id>` | the status of your lane | Replaces the previous note. Peers see it in their inbox. | advice | code today `lane.mjs:1617` "`UPDATE agentic_os.lane SET note=$2`" |
| M4.4 | Notion handoff row | a future session, not a live peer | Found by `/resume_handoff`. No delivery time. | advice | code today `CLAUDE.md.template:173` "`/create_handoff` writes a 📬 Handoffs row" |
| M4.5 | `SendMessage` | your subagents; a session that `ListAgents` shows | Not verified. | advice | code today `CLAUDE.md.template:18-19` "agree the split through `SendMessage`" |
| M4.6 | AskUserQuestion | a choice for Dave; never a peer | Dave answers in this session. | advice | code today `CLAUDE.md.template:24` "Two or more open choices: `AskUserQuestion`" |
| M4.7 | Any | a session that is idle | `peers` lists only sessions active in the last 5 minutes. The banner shows at most 12 unread events and marks all as read (M4.1). | advice | code today `lane.mjs:146` "`const STALE_MINUTES = 5;`"; `lane.mjs:445-457` (`livePeers`); `lane-context.ts:642-658` (banner peers); `:126` "`const MAX_EVENTS = 12;`"; `:729` |
| M4.8 | Any | a reply | A held or unanswered message is not a reply. Do other work, not the shared resource. No reply after that: ask Dave. | advice | code today `CLAUDE.md.template:20-21` "A message held for approval or unanswered is not a reply" |
| M4.9 | Any | message form | Plain text with names, SHAs and paths. Write a session as "name #sid8". | advice | code today `CLAUDE.md.template:20` "Cross-session messages are plain text with names, SHAs and paths"; `CONTEXT.md:53` (Session handle) |
| M4.10 | Any | a message that must arrive | Also write it in your lane note. Ask Dave when no reply comes. | advice (new rule) | follows from M4.1 |

### Milestone messages

Related sessions exchange status at each milestone, without a prompt from Dave (Dave, in words, 2026-11-10; findings row 26).
The three review-engine sessions already send milestone DMs: 14 direct messages and 2 commit-run broadcasts between 12:49 and 15:14 CST on 2026-11-10 (lane events 2782 to 2812; findings rows 28 to 30).
The design: a file carries the items, the DM points to the file, and the reply is the receipt.

| Id | Rule | Level | Evidence |
|---|---|---|---|
| M4.11 | At each milestone, send one lane DM (M4.1) to each session that holds a related lane: `L say "..." --to <name> --lane <your lane>`. A session that holds two related lanes gets one DM. Milestones: you claim, adopt or reclaim the lane (send the scope); your write set changes; a commit, a revert or a pull request that the receiver builds on or must read; a decision by Dave on the receiver's files; a finding in the receiver's files; a block that waits on the receiver; an earlier item is now false; your lane is done, released, parked or handed off. Send decisions and findings with your next commit DM, or within 30 minutes. A subagent sends none: its parent sends (S1.5). A headless run sends the first and the last only (S1.4). | advice (new rule) | Dave, 2026-11-10 (findings row 26). Practice: lane events 2786 (a contract to review), 2792 (a design is done), 2798 (a commit, decisions and findings). Code today `.claude/rules-ondemand/review-engine.md:32` "Send one DM per milestone and receiver" (program lanes only) |
| M4.12 | A lane is related to yours when both scopes name one file path, or one lane waits on the other, or Dave says so. A phrase such as "every other file" names no path. Write the ids last in your scope text: `RELATES TO: <lane ids>`. Only `add` and `seed` write the scope, and both also replace the title and the track (L2.1, L2.6). So run `L add <id> --title "<same title>" --track <same track> --scope "<full scope>"`. When a related lane belongs to a program, send to the seat of that program only. The seat passes the items to its sessions (M4.14). A lane with no holder, or a reclaimable lane (L2.8), gets no DM. `say --to` fails for a session that is quiet for more than 2 hours: tell Dave (M4.16). | advice (new rule) | code today `lane.mjs:1784` "`title=EXCLUDED.title, track=EXCLUDED.track,`"; `:1790` "`flags.track \|\| 'unsorted'`"; `:833` "`> now() - interval '2 hours'`"; `:855` "`no recent session matching`". planned pre-go §5.3 points 1 and 5: a dependency names the lane that another lane waits on. Practice: lane event 2798 went to the seat only, and event 2803 passed the items to the builder sessions. Code today `.claude/rules-ondemand/review-engine.md:34` "sends program items to the seat only" (program lanes only) |
| M4.13 | Form of a milestone DM. The first sentence says what the message is. Then at most 5 numbered items. Each item gives the fact, its path or SHA, and the lane or file of the receiver that it bears on. The last sentence is "Reply once (M4.14)" for a decision, a finding or a request, and "No reply needed" for status. "No reply needed" means "do not block on a reply". It does not mean "send no more". Never put a holdout or gold PR id, or a secret, in a DM or in its file copy. | advice (new rule) | M4.9; lane event 2798 (4 items); code today `docs/review-engine/README.md:81` "no holdout or gold PR id, and no answer, in a note, a prompt or a PR body"; `.claude/rules-ondemand/review-engine.md:33` "A DM has at most 5 numbered items." (program lanes only) |
| M4.14 | The receiver of a DM that carries a decision, a finding or a request replies one time: read, conflict or no conflict, and where each item goes. It records the items in a file that the next holder of its lane can read. A DM that carries only status needs no reply. | advice (new rule) | lane event 2803: the seat's reply names a lane for each item and the file `.claudedocs/re-execution/contracts/seat-inputs.md` (findings row 29); code today `.claude/rules-ondemand/review-engine.md:33` "The receiver replies one time." (program lanes only) |
| M4.15 | Budget: one DM for each milestone and each receiver. Put all items of one milestone in one DM. Routine progress goes in your lane note (L2.7), not in a DM. Send no reply to a reply that says "no conflict". A reply that says "conflict" gets one answer. After that, ask Dave (M4.8). An idle receiver gets only its newest 12 unread events at its next prompt. A working receiver gets the newest 5 DMs between tool calls. Notes and broadcasts count against both limits. | advice (new rule) | code today `lane-context.ts:515` "`for (const e of unread.slice(-MAX_EVENTS))`"; `:141` "`const DM_MAX_EVENTS = 5;`"; `:468` "`const shown = dms.slice(-DM_MAX_EVENTS);`". Findings rows 18 and 20 (both UNCLEAR). Code today `.claude/rules-ondemand/review-engine.md:32` "Send one DM per milestone and receiver" (program lanes only) |
| M4.16 | The file is the carrier. Append each milestone to `.claudedocs/coordination/milestones/<lane-id>.md` in the primary checkout: the time from a clock, the receiver, the items. The DM gives the items and this path. Keep `MS: <path>` last in your lane note. A new note replaces the old one, so write `WAITS ON` and `NEXT` again in each note (L2.9, L2.13). The reply (M4.14) is the only receipt. No reply by your next milestone: write `NOT READ: <holder>` in the file and tell Dave. An idle session reads no message until Dave types in it (M4.7). | advice (new rule) | code today `lane.mjs:1617` "`UPDATE agentic_os.lane SET note=$2`"; follows from M4.1, M4.7 and M4.10; findings row 31 (a time in a message body differs from the stored time); code today `.claude/rules-ondemand/review-engine.md:35` "Take every time you write from a clock in the same command." (program lanes only) |

## Part 5. Shared pages

Loader: top of `lane-board.md`.

| Id | Rule | Level | Evidence |
|---|---|---|---|
| P5.1 | Read the live phone page (Artifact tool, action `read`, no `path`), render, publish at once. Render with the primary checkout's `render-board.mjs --project <key>`, never a worktree copy. | advice | code today `lane-board.md:53` "Order: read the live url (Artifact tool, action `read`, without `path`"; `.claude/rules-src/live-copy-before-use.md:4` "Before a step that needs the live copy, read it"; `shared/lane-board.ts:257` "`node ${primaryRepo(env)}/scripts/coordination/render-board.mjs --project ${board}`" |
| P5.2 | Publish a board's phone page only to that board's own url, with no `capabilities`. | advice | code today `lane-board.md:52` "Publish a board's page only to its own url, with no `capabilities`" |
| P5.3 | Before you sync, check the `<meta name="lane-board">` stamp names this board. Stop if it does not. | advice | code today `.claude/skills/kanban-sync/SKILL.md:32` "If it is missing or names another board, stop and report" |
| P5.4 | Fix a wrong status at the source (`L note`), never in rendered HTML. | advice | code today `create_handoff/SKILL.md:216-218` "correct it at the source of truth (for the lane board:" |
| P5.5 | A board with no `laneArtifact` renders a local page. Never publish it. | advice | code today `lane-board.md:51` "A board with no `laneArtifact` renders `lane-board-<key>.html`" |
| P5.6 | Never pass `force: true` unless Dave asks to discard that version. | advice | code today `create_handoff/SKILL.md:261` "Never pass `force: true` to skip the read-first check" |
| P5.7 | After a lane change on a board with a phone page, publish the phone page before the turn ends. Use the three steps the Stop gate prints: read live, render from the primary checkout, publish. The gate blocks the end of the turn once for each batch of lane changes. | warn (one block) | code today `lane-board-stop-gate.ts:54-66` "The lane board page for board ${board} is out of date"; `:7-8` "blocks the end of a turn ONCE per batch of lane changes" |

## Part 6. Board contract

Loader: top of `lane-board.md`.

| Id | Rule | Level | Evidence |
|---|---|---|---|
| B6.1 | A board needs an active registry entry. The longest matching root wins, then a worktree gitdir. | deny (no board: exit 1) | code today `shared/lane-board.ts:206` "`e.status.toLowerCase() !== 'inactive' && e.root`". Two boards resolve: `continuous-claude` (with `agentic-os`) and `greymatter-design`. Six entries are inactive (`.claude/project-registry.json`) |
| B6.2 | Register a folder only with Dave's yes, from the primary checkout, with `L project register`. Remove a board only with Dave's yes: `L project unregister <key>` (never `continuous-claude`). | advice | code today `lane-board.md:16` "Run it from the primary checkout only, and only with Dave's yes"; `.claude/rules-src/every-surface-checklist.md:45` "One writer for a board: `project register`, from the primary checkout"; `lane.mjs:99` "`project unregister <key>   # not continuous-claude`" |
| B6.3 | Lane ids are global. `add` refuses an id of another board. A new board's starter lane uses the `<key>-` prefix. | deny (foreign id) | code today `lane.mjs:1796` "`if (!rows.length) throw await foreignId(c, id);`"; `lane-board.md:23` "Lane ids are global across boards" |
| B6.4 | `continuous-claude` has the phone page in `.claude/artifacts.json`. Another board has a phone page only with `laneArtifact`. Dave starts one with `/publish-board <key>`. | advice | code today `lane-board.md:47` "Dave starts one with `/publish-board <key>`" |
| B6.5 | Reserved prefixes: `re-` (review-engine program, HOLD until Dave's GO) and `coord-` (lane tooling lanes). Other sessions claim neither. | advice; deny for a second `re-` lane per owner | code today `docs/review-engine/README.md:6` "No session may claim a `re-` lane before Dave's GO"; `lane.mjs:703` (`SECOND_RE_LANE`; a lane of the same `re/` branch does not count, `:696-698`); `:801` "`One re- lane per session.`", `[second-re-lane]`, exit 4; `:796` `[pack-held]`. `.claude/rules-ondemand/review-engine.md` loads at a claim of a program lane: `re-`, `force-high-security-tier` or `hf-judge-precheck` (code today `review-engine.md:3`). A `coord-` claim does not load it. Its manifest mode is `deny-first`, not `inject` (`.claude/rules-ondemand/manifest.json:240`). planned pre-go §3, §7 rows 2, 5 |
| B6.6 | A database writer sets `lane.client_version` before it writes. Without it, the trigger refuses a change or a delete of a lane on a board other than `continuous-claude` (error 42501). `continuous-claude` lanes are not protected. The setting is a cooperative flag, not security. | deny (other boards only) | code today `apps/agentic-os/drizzle/0004_per_project_lanes.sql:21-24` "`IF OLD.project_key <> 'continuous-claude'`"; `:12-13` "It keeps working on CCv3 lanes"; `lane-context.ts:596` "`SELECT set_config('lane.client_version'`" |

## Part 7. One service line

| Id | Rule | Level | Loader | Evidence |
|---|---|---|---|---|
| V7.1 | During a wave, no session changes verb behaviour, exit codes, banner text or `lane-board.md` without the agreement of the seat. | advice (new rule) | top of `lane-board.md` | planned pre-go §4.1 (Owns lists). pre-go §7 row 15 gives only a warning by say before a land; no code is planned |

## Loader text

The exact lines each loader gets. `<shim>` is `node C:/Users/dkhay/.claude/scripts/lane.mjs`.

- S1.1 and S1.2, banner, when the session holds no lane (3 lines). Today the banner prints `You hold no lane. Claim one by id before starting work:`, then `<shim> board --by priority` and `<shim> claim <id>` (code today `lane-context.ts:680-682`). These 3 lines replace them:
  `You hold no lane. 1. kanban-sync when the board has a phone page. 2. <shim> mine. 3. <shim> board --by priority, then claim the lane for your work by id.`
  `No lane for it: <shim> add <new-id> only when <shim> board --all shows the id in no state, then claim it. Never add on a lane you do not hold.`
  `Rules: lane-board.md. Rule ids: docs/coordination/standard.md.`
- S1.1 and S1.2, banner, when the session holds a lane (1 line, after `You hold:`; code today `lane-context.ts:677-678`):
  `Milestone (start, commit, decision by Dave, finding, block, done): send one DM to each holder in your RELATES TO list (M4.11).`
- S1.3, session-register line (2 lines):
  `no lane board (unregistered dir). Work for a board: <shim> board --project <key>. Else run no lane command.`
  `Register a folder only with Dave's yes.`
- `lane-board.md` gets the Id, Rule and Level columns of parts 2 to 7 only. It replaces only the lines a rule covers: `lane-board.md:9-10` (O3.7, O3.10), `:16-17` (B6.2, S1.4), `:22-23` (M4.2, B6.3), `:47` (B6.4), `:51-53` (P5.5, P5.2, P5.1). It keeps `:33` and `:40-43` (L2.4, L2.2, L2.3, L2.12, L2.6), which PR #488 wrote. Evidence stays in this file.

## Not verified

- What a cloud, Remote Control, subagent or scheduled-task session sees. No probe.
- The value of `CLAUDE_CODE_ENTRYPOINT` in a cloud or Remote Control session. A value that starts with `sdk` makes the hook treat it as headless (`shared/lane-board.ts:145`).
- Headless: the code gate (S1.4) conflicts with a memory note of 2026-11-04 that says lane notes reached headless runs. No headless run was made.
- How `ListAgents` builds its list and how `SendMessage` delivers. Neither is in the repo.
- The live `~/.claude/settings.json` hook registrations. Only the template was read by the scouts.
- Whether a worktree session outside a board root that holds no lane is listed as a peer.
- The Artifact tool refusal of a publish without a live read. It is tool behaviour, not repo code.
- The owner of a lane at the time of a past event. `adopt` moves the owner and logs no `claimed` event (`lane.mjs:1453-1456`).
- No probe was run. Some probes can write fixtures to the live database; `lane-race-probe.mjs` now refuses one (O3.9). The SQL that was run is in the findings log.
- The #486 claim and done refusals were read in code, not run. The #487 verbs `check --board` and `ready` were read in code, not run (L2.12, O3.2). The live `lane_dep` check used the default database URL of `lane.mjs:148-153`.
- The milestone rules (M4.11 to M4.16) are new outside the review-engine program. At cf0211e0, `.claude/rules-ondemand/review-engine.md:30-35` holds a short form for program lanes. No data shows yet if sessions follow them, or how many messages they make in a day.

## Decided by Dave (2026-11-10, by tap in session puffin #0f5ea433)

- Point 1: the banner says claim by id, not `next` (S1.1). PR #486 made the banner say so (`lane-context.ts:680`, `:713`). Still open for this lane's rules pull request, with Dave's yes: the repo `CLAUDE.md:10` (always loaded; same length or shorter) still says `lane.mjs next`. It needs the seat's release. PR #488 changed the pointer doc: `docs/harness/lane-board-claude-md-pointer.md:8` now says "Claim a lane by id first".
- Point 2: a session announces a commit run with `L say` (O3.5), not with `SendMessage` or a lane note.
- Point 8: O3.4 in full (one lane, one worktree, one branch, one pull request) applies to the review-engine program only. Any other lane that changes tracked files uses its own branch.
- Point 9: a reclaimable lane has no holder for L2.10. Any session may change it after a note that says why. Findings row 13 depends on this.
- Point 10: to reopen a `done` lane, run `L state <id> ready`, then `L claim <id>` (L2.3). Never claim a `done` lane directly (findings rows 3, 4 and 6).

Stated by Dave in words, not by tap (2026-11-10, findings row 26): sessions on related lanes exchange status at a high level from the start. Dave said yes to a rule for it, folded into this standard. The text of M4.11 to M4.16 is this lane's draft. Dave has not reviewed the text.

## Open points for Dave

The numbers are those of the first draft. Points 1, 2, 8, 9 and 10 are decided above.

3. Park-owner timing: before GO or after GO (pre-go §9 D2). L2.9 and L2.10 change level then.
4. `park` storage: reuse the lease or a new column (pre-go §9 D4). It decides what "parked" shows.
5. Headless: is the banner opt-in (`LANE_CONTEXT_HEADLESS=1`) the rule, or should a scheduled run get the board?
6. The cloud and Remote Control rule, and spend for one probe per session kind.
7. Coordinator seat: may it hold a second `re-` lane (proposal marks this OPEN)? Today the claim code refuses it (B6.5, `lane.mjs:801`).

## Planned loaders

Each row is a proposed edit by the seat or the holder of the file. This lane edits none of these paths without a written release by DM.
pre-go §3.2 and §4.1 name gate-2 as the owner of `lane-context.ts`. pre-go §3.3, §3.4 and §4.1 name gate-3 and park-owner as the owners of the three board docs.

| Part | Loader | When |
|---|---|---|
| 1 (the lines in "Loader text") | SessionStart banner: `lane-context.ts`, `session-register.ts`, `shared/session-names.ts`. Done by PR #486: the no-lane line says claim by id (`lane-context.ts:680-682`), the heading is `Claimable (claim by id):` (`:713`), and `Commands:` has no `next` (`:717`). Still this lane's proposal: the 3 no-lane lines and the milestone line in "Loader text", and the S1.3 line | after the seat (#01895057) releases each of these files by name in a DM: `.claude/hooks/src/lane-context.ts`, `.claude/hooks/src/session-register.ts`, `.claude/hooks/src/shared/session-names.ts`, `.claude/hooks/dist/*`, `.claude/hooks/dist/.build-inputs.json`; and the seat confirms that no hook build is in work |
| 2 to 7 (Id, Rule, Level) | top section of `.claude/rules-ondemand/lane-board.md` | after the seat releases by name: `.claude/rules-ondemand/lane-board.md`, `COORDINATION.md`, `docs/harness/lane-board-claude-md-pointer.md` |
| L2.13 | one lane step in `create_handoff` and `resume_handoff` | after Dave's yes; both skills are outside this lane's write set |
| All | `COORDINATION.md` becomes a pointer to this file | with row 2 |
| M4.11, M4.12 (proposal) | SessionStart banner, a data line parsed from `RELATES TO`: `Related: <lane-id> (<name #sid8> or no holder), ...` | with row 1, in this lane's hooks pull request. The seat decided: not in `coord-gate-2-cli` (lane event 2818) |
| M4.14 (proposal) | the footer of a DM that the hook shows (code today `lane-context.ts:479` "otherwise carry on"): `A DM with a decision, a finding or a request: reply one time (M4.14).` | with row 1, in this lane's hooks pull request (lane event 2818) |
| M4.11 (proposal) | `.claude/rules-ondemand/pr-and-commit-style.md`, which loads at each commit: `After a commit on a lane with RELATES TO: send the milestone DM (M4.11).` | with row 2. The seat released the file by name (lane event 2818). Dave decided by tap on 2026-11-10: the line lands with the rules pull request, not before |

No standard text goes in an always-loaded file: 118 characters are free of 27000 on main b92f18f8 (`node scripts/rules/context-budget-guard.mjs --repo`, 2026-11-10 22:36 CST: 26882 characters). pre-go §6 gave 180 of 26000. Dave raised the budget to 27000 on 2026-11-10 (`docs/review-engine/decisions.md`).
The hooks pull request also removes the false banner line "Research findings are shared automatically" (`session-register.ts:214`).

## Sources

- `C:/Users/dkhay/continuous-claude/.claudedocs/2026-11-10-coordination-standards-eval.md` (sections 1 to 8)
- `C:/Users/dkhay/continuous-claude/.claudedocs/re-execution/analysis/pre-go.md` (sections 3, 4, 7, 9, 12; draft plan)
- `C:/Users/dkhay/continuous-claude/docs/review-engine/README.md`
- `C:/Users/dkhay/continuous-claude/.claude/rules-ondemand/lane-board.md` and `manifest.json:223-233`, `:236-244`
- `C:/Users/dkhay/continuous-claude/COORDINATION.md`; `docs/harness/lane-board-claude-md-pointer.md`
- `C:/Users/dkhay/continuous-claude/.claude/templates/CLAUDE.md.template`
- `C:/Users/dkhay/continuous-claude/.claude/skills/create_handoff/SKILL.md`, `resume_handoff/SKILL.md`, `kanban-sync/SKILL.md`
- Code: `scripts/coordination/lane.mjs`, `lane-dep.mjs`, `lane-seed-file.mjs`, `session-label.mjs`, `lane-race-probe.mjs`; `scripts/review-engine/program.mjs`, `lib/board-check.mjs`, `lib/ready.mjs`, `lib/db-verbs.mjs`; `.claude/rules-ondemand/review-engine.md`; `.claude/scripts/lane.mjs`; `.claude/hooks/src/lane-context.ts`, `session-register.ts`, `file-claims.ts`, `lane-board-stop-gate.ts`, `shared/lane-board.ts`, `shared/session-names.ts`, `shared/session-id.ts`; `apps/agentic-os/drizzle/0004_per_project_lanes.sql`
- Lane database, SELECT only: `C:/Users/dkhay/continuous-claude/.claudedocs/coordination/findings.md`
