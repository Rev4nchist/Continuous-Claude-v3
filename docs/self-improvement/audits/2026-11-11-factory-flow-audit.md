# Factory flow audit: sessions 2026-11-07 to 2026-11-11

Audit (repo-local). Written by llama #3c003362 on 2026-11-11 for Dave. On 11-11 Dave asked for a private page with the explanations and nine questions: https://claude.ai/artifact/UoaCF44TQXNomb5sPvx3HM (source: `2026-11-11-factory-flow-audit.html` in this folder). His answers are stored in that page.
Read-only: this audit changed no rule, hook, lane or page.

## Goal

Find where the multi-session work loses time, makes wrong claims or breaks. Rank the fixes by measured cost.

## Method

1. A script (`digest.mjs`) read every transcript with activity since 11-07 00:00 CST: 97 sessions, 176 subagent transcripts, 537 MB. It wrote 1.8 MB of digests and one metrics row per session.
2. 7 reader agents (Sonnet, high effort) read the digests of the 10 long sessions. 1 reader read the milestone files and the harness logs.
3. 2 refuter agents (Opus) searched for each quote and checked whether a rule or memory already covers each finding.
4. Result: 90 findings. 60 confirmed, 29 weakened, 1 refuted. Cost: 10 agents, 2.0M tokens, 18 minutes.

Raw data (git-ignored, primary checkout): `C:\Users\dkhay\continuous-claude\.claudedocs\2026-11-11-factory-flow-audit\`. `result.json` holds all 90 findings with quotes and refuter reasons. `metrics.json` holds one row per session. `digest.mjs` and `checks.mjs` are the scripts. The finding ids in this file, such as `records-1`, are keys in `result.json`. The digests stay in the session scratchpad and are not kept.

## Limits

- 10 sessions hold almost all the work. 11-11 holds 519 of the 537 MB.
- Digests drop tool output and cut the middle of long sessions to Dave lines, asks, answers, blocks, errors and peer messages. Counts from digests are lower bounds.
- 4 sessions were live. Their last minutes are missing.
- Costs in minutes come from timestamps. A wait can include time when Dave was away.
- `/insights` covered 57 of 594 sessions from 10-24 to 11-11. This audit covers the last 5 days in full.

## Window totals (script counts)

| Measure | Count |
|---|---|
| Sessions with activity | 97 (10 long, 87 short probes and headless runs) |
| User lines in the 10 long sessions (typed, pasted and command text) | 725 |
| AskUserQuestion calls in the 10 long sessions | 937 |
| Lane board publish attempts | 588: 535 published, 36 refused by the version check, 17 refused by the daily limit |
| Lane board publishes per CDT day, 11-07 to 11-11 | 93, 93, 104, 119, 126 |
| Portal and other asset uploads | 165 |
| Other page publishes | 17 |
| Compactions | 88 (up to 14 in one session) |
| Tool errors / blocks | 436 / 242 |
| Subagent spawns | 177 |
| Output tokens, main / subagents | 24.6M / 17.5M |
| pre-pr runs (gate log) | 285 on 138 branches, 999 minutes summed |

## Findings, ranked by cost

Cause classes: POLICY (a written rule causes it; only Dave can change it), NOT DELIVERED (a rule exists but did not reach the model), NOT FOLLOWED, TOOLING, PLATFORM, NO RULE.

### 1. Dave is the clock of every PR: about 5 taps per PR, and work stops when he is away. POLICY

- 937 asks against 725 user lines in the 10 long sessions. About 100 of 130 asks in one session were ship-ladder taps (`fleet-spend-1`).
- A typed "land N" does not count as a tap, so it costs one more turn. Dave typed it 22 times in one session (`hub-refresh-1`), 12 in another (`cd-residuals-5`) and 6 in a third (`fleet-spend-1`).
- Overnight stalls: builder A waited about 8 hours at a commit tap (11-10 23:23 to 07:19), on the program critical path (`re-seat-1`, `re-builders-1`).
- One "no review" pick took 6 asks in 11 minutes. Dave wrote "this is frustrating" (`re-builders-9`). The PR was risk band CRITICAL, so the CodeRabbit recommendation and the second confirm are the written design.
- The refuters weakened every finding in this group on cause, not on fact. The quotes are real and the rule was followed. A "one yes for the lane flow" offer exists and was honoured once (11-11 11:56). It covers one lane, and a merge of `main` needs a new ask.
- Source: `.claude/rules-ondemand/pr-review-loop.md` "Ship flow: five taps" and "A chat word is not a tap". The sessions follow the rule.
- Fix options, Dave's decision: (a) the "one yes for the lane flow" becomes the default offer on LOW and MID risk bands and survives a merge of `main`, with the land tap kept; (b) a typed "land N" counts when the head is unchanged; (c) no change.

### 2. A lane DM does not wake an idle session: 233 minutes of measured idle workers. NOT DELIVERED + TOOLING

- Four waits: 53, 32, 58 and about 90 minutes (`records-1`, `re-seat-3`, `re-builders-2`, `laneboard-m3-1`).
- Builder C, 11-11 15:18 to 16:52: the seat ruled by lane DM at 15:19. The worker never read it. Its lease ended at 16:48. Dave relayed by hand.
- The seat-check text said "Answer by lane DM and SendMessage". The seat sent only the DM. `docs/coordination/standard.md` M4.7 documents the gap.
- The `/insights` report blames a slow ruling. The cause is delivery.
- `[Speculation]` `SendMessage` wakes an idle session. One case supports it: builder B answered a 23:22 `SendMessage` at 23:24 with no line from Dave between them (`re-builders-2`). The standard marks `SendMessage` "Not verified" (M4.5).
- Fix, in order: (1) a wake test: send a `SendMessage` and a lane DM to an idle scratch session and record which one starts a turn; (2) if it wakes, one delivery verb: `lane.mjs say` also wakes an idle target, or prints "target idle, not woken"; (3) a seat-check line for any DM unread for more than 10 minutes.

### 3. The lane board page: 535 publishes in 5 days, the 200-a-day limit, and a stale page for about 2.5 hours. POLICY + PLATFORM

- 588 attempts on the lane board: 535 published, 36 refused by the version check, 17 refused by the limit. The board alone took 93 to 126 publishes per day. 165 asset uploads for the portals came on top.
- The limit hit at about 15:13 CST on 11-11. The page stayed stale until 18:00 CST, at the time of the heaviest merges (`re-seat-5`, `re-builders-4`, `records-6`).
- Dave asked "why is the lane board 104 min out of date?" (11-11 17:01).
- Each publish reads a 1.3 MB page first. Refused publishes: 15 in the builder sessions, with 5 identical resends (`re-builders-8`).
- Source: `lane-board.md` P5.7 and the Stop gate ask for a publish after every lane change, and line 166 says to resend after a refusal. A `say` DM also counts as a lane change. Dave's milestone rule of 11-10 (memory `milestone-rule-keeps-pages-current`) adds a board publish and a portal refresh at each milestone. The fix below cuts against that rule, so it is Dave's decision.
- Seen live in this audit: one DM to the seat cost 1 read, 1 render and 3 refused publishes.
- Fix: a publish budget. At most one publish per 10 minutes per board, only for claim, release, done and park. No publish for `say` or `note`. The gate reads today's count and stops asking at 150. One session per board publishes.

### 4. pre-pr: 285 runs, 16.6 hours summed, and reruns because `main` moved. TOOLING

- 70 runs failed. 29 failed only because the branch was behind `main`; 27 on the summary file; 12 on evidence (`records-11`).
- PR #509 needed 6 runs, about 40 minutes (`pkg5-guards-2`).
- A flake: `gate:github-tests` failed "1 of 1574" with no test name in the log (`laneboard-m3-8`).
- `EBUSY` on the pre-pr log file came back on 11-11.
- Fix: pre-pr merges `main` itself before the gates (one yes). It prints the failing test name. It writes console text to a scratch folder. It reruns only the gates whose inputs changed.

### 5. The 10,000-character hook cap cuts the rules that would prevent other findings. PLATFORM + NOT DELIVERED

- Sizes today: `pr-review-loop.md` 64,390 characters, `lane-board.md` 30,086 (`records-2`, `laneboard-m3-3`).
- Which paths are cut, as seen in this session on 11-11: the SessionStart banner (11.6 KB) arrived as a 2 KB preview. The `lane-board` rule arrived in full, because a block rule sends its text as the deny reason. An inject rule sends its text as hook context, which is the path the cap cuts. `pr-review-loop.md` is an inject rule. Seen at 17:58 CST in this session: the `pr-review-loop` inject (63.3 KB) arrived as a 2 KB preview. That fire was also a false fire: the call was a lane note whose text named the rule file.
- PR #496 landed on the belief that workers see the full rule text. The check after the land returned NOT LOADED. Fix chain: #499, #501 and the card `coord-banner-page-budget`.
- Several findings first marked "no rule" are rules that never arrived: merge `main` first, the stamp order, seat DMs.
- Fix: split `pr-review-loop.md` under 9,500 characters per part. Add a size gate for every on-demand rule and banner. Run the headless behaviour check before the land, not after.

### 6. The handoff, compact and resume ritual. NO RULE + skill design

- 88 compactions. Each long session ran 9 to 14 cycles. Dave typed the same 40-word resume text each time and answered the same outcome question (`pkg5-guards-4`, `hub-refresh-6`, `cd-residuals-7`, `fleet-spend-7`, `laneboard-m3-10`, `records-7`).
- The `create_handoff` skill assumes a new session. Dave resumes in the same session. Each cycle writes a Notion row and an outcome tap.
- Decisions made before a compaction were asked again after it (`fleet-spend-3`).
- The seat sent about 13 "seat moved" messages and then voided them (`re-seat-7`).
- Fix: an in-place path, one command. It writes a short state file with a "decisions made" block, compacts and resumes from the file. No Notion row, no outcome tap, no peer notice.

### 7. Guard friction: most blocks come from the launch mode, not from guard bugs. NOT FOLLOWED + TOOLING

- Real-session rows since 11-07: package-install-guard 115 denies, destructive-command-guard 92 denies and 46 overrides, decision-gate 83 denies, pre-pr-gate 41 (`records-5`).
- All 115 package denies and 138 of 140 destructive rows ran under `bypassPermissions`, where the guard denies in place of asking. Memory `bypass-launcher-rules` covers this. Sessions still asked Dave each time.
- 65 package denies are "cannot parse" on non-installs such as `$L add lane-...`. By day, 11-07 to 11-11: 9, 19, 20, 10, 7. Memory `package-guard-variable-leader` (11-10) covers it, and the case still happened 7 times on 11-11.
- 36 denies cite `GHSA-5xrq-8626-4rwp` on commands that start with `git worktree add` or `git status`. The cause is not confirmed.
- The decision-gate refused commands whose text only named the land script.
- Fix: triage the GHSA denies once. Make decision-gate match command tokens. Deliver the bypass rule in the deny text itself.

### 8. Accuracy: facts reach Dave without a check. NOT FOLLOWED

- "Hidden window" task flashed a console every 5 minutes (`hub-refresh-4`). Headless browser checks passed, and Dave found phone defects (`hub-refresh-5`).
- PR #506 nearly landed with wrong wording; held 81 minutes (`records-3`).
- Guessed prices and a price question put to Dave (`fleet-spend-5`). Hand-typed times that are wrong (`re-builders-12`).
- The seat approved a design, then withdrew it after a 43-minute build. The real done-check ran last (`re-builders-5`).
- Plan files contradicted each other after Dave had decided: 4 map contradictions, 13 schedule faults, `rank.json` built 3 times (`re-seat-2`).
- Fix: tool-side checks, because the rules exist. A clock stamp from the tool. The done-check scan as the first red test of a build. The program validators run before any decision question. A security review before the seat rules on a looser path rule.

### 9. READY is not a signal Dave can use. POLICY + TOOLING

- READY reaches Dave by toast only. He works on his phone and polls with "status?". Gaps of up to 116 minutes between READY and the land tap (`hub-refresh-2`, `cd-residuals-6`).
- READY read true for a head with no check runs, twice on 11-11 (`re-seat-11`, `records-4`). Card `ready-no-check-runs` exists.
- Fix: one line in the session and on the phone page when a PR turns READY. Land the card.

### 10. Smaller items

- Guard logs are 91% test rows (5,951 rows, 546 real). Any count from the raw log is about 10 times too high. Give test rows a `synthetic` field (`records-10`).
- The coordination standard cites `file:line`. Each merge made cites stale; 8 fix rounds. `check-cites.mjs` exists and is not a pre-pr gate (`laneboard-m3-2`).
- Worktrees: `land-pr` cannot delete its folder, junction checks, missing `node_modules`; one cleanup ask per landed worktree (`cd-residuals-9`, `fleet-spend-12`).
- Push-gate hardening ran as about 15 PRs over 3 days. Memory `guard-shell-lexer-arms-race` already says to stop (`cd-residuals-1`).
- The safety classifier stopped 7 review agents before any payload ran, twice (`cd-residuals-2`).
- One hooks test stayed red for two days with no lane (`cd-residuals-12`, weakened).

### Refuted

- "38% of subagent spawns inherit the parent model, so tiering is wrong" (`records-9`). Predefined agents carry their own tier (`agent-model-selection.md`). My first status message named this number. It is not a defect.

## What works (keep)

- Parents re-run a subagent's tests and `git show --stat` before they accept "done". This caught stacked branches, critic gaps and CodeRabbit majors.
- Opus and Fable review gates and the premortem found real defects before the build (22 tigers, 11 Grok faults, 2 blockers on PR #508).
- No PR merged without Dave's tap. The decision-gate held.
- Round 1 shipped 9 package PRs in order on 11-07 with no conflict.
- Recovery after the 11-07 restart used the workflow journals and saved CodeRabbit output.
- The seat's merge-ancestor and live smoke checks before each GO.

## Check of the `/insights` report

| Claim | Verdict |
|---|---|
| Publish limit of 200 hit because sessions republish the board | Supported. The rules drive the volume. |
| PR body edit after pre-pr breaks the stamp | Supported. The memory covers only a push, not a body edit. |
| Workers idle on a slow ruling | Partly. The ruling was on time; the DM did not wake the worker. |
| Critics find 6 to 7 defects | Partly. Critics find real defects; the number is in no digest. |
| New CLAUDE.md rules (no commands for Dave, no "Next steps: None", landing lock) | Not needed. Two exist; one contradicts CLAUDE.md. |

## For the RE program seat and the management portal

These bear on `re-program` and on `https://claude.ai/artifact/Fn77cw53rD1F5WEBwyXxFx`. I read the page source (`.claudedocs/re-tracker/page/index.html`), not the stored data. The seat is the writer of the portal; these are proposals.

1. Finding 2: until the wake test is done, send each ruling by lane DM and by `SendMessage`, then read `ListAgents`. The seat set this rule at 16:52 on 11-11.
2. Finding 8: run `program.mjs check` and the validators before each decision question to Dave. Ask for the independent security review before a ruling that loosens a path rule.
3. Finding 6: send no "seat moved" notice when the seat resumes in the same session.
4. Finding 3: publish the board and refresh the tracker on a budget. During a wave the seat is the natural single publisher of the board.
5. The Today tab (`#rp-today`) has "The road to GO", "Now" with "Waiting on Dave" and "The session at work", and the day chart. The losses of 11-11 were not visible there. Proposed additions to "Now":
   - "The session at work" shows one session. Show one row for the seat and for each worker: lane, state, "waits on", minutes since its last lane event.
   - "Waiting on a session": each DM with no reply, its receiver and its age. Builder C's 94 minutes would have shown here.
   - "Waiting on Dave": add the age of each open ask.
   - A limits line: board publishes used today out of 200, and the time of the reset (18:00 CST).
   - "Data as of" gets a reason when the data is old ("publish limit reached", "no milestone since").
   - Progress tab: pre-pr runs per day and the fail reasons (behind `main`, summary, evidence, flake).
   Sources that exist: the lane DB events, `~/.claude/logs/pre-pr-gates.jsonl`, `metrics.json` from `digest.mjs`.

## Decisions by Dave (AskUserQuestion taps, 2026-11-11 about 17:55 CST)

| Topic | Dave's answer | Where it went |
|---|---|---|
| Tap ladder (finding 1) | "Lane yes + typed land" | New lane `lane-flow-yes-typed-land` (backlog, design first) |
| Publish budget (finding 3) | Session Lane Board Multi #0f5ea433 makes the card; coordinate with it | DM sent to #0f5ea433 with the counts. Card `board-publish-budget` exists in backlog; not touched |
| In-place compact path (finding 6) | "Yes, build it" | Note on the existing lane `compact-session-breakpoint` |
| Wake test and delivery verb (finding 2) | Make it a lane | New lane `say-wake-test` (backlog; `say` changes need the seat, V7.1) |
| pre-pr merges `main` itself (finding 4) | Make it a lane | New lane `pre-pr-merge-main` (backlog) |
| Split `pr-review-loop.md` (finding 5) | Make it a lane | Note on the existing lane `pr-review-loop-10k-cut` |

No lane is claimed. No band is set: the band is Dave's choice.

## Replies from peers

- RE program seat #01895057, 17:54 CST: findings read, no conflict. Items 3 and 4 go into the seat runbook. Item 1 is a seat rule since 16:52. Item 2 is open with Dave. The portal belongs to the coordination session #0f5ea433; the seat passes it the file path. Recorded in `milestones/re-program.md`.
- Lane Board Multi #0f5ea433: DM sent 17:58 CST, no reply yet at the time of writing.
