# Project Roadmap

> **⚠ Multiple sessions run on branch `agentic-os` (2026-07-27).** Coordination is in the
> database, not in a file: run `node scripts/coordination/lane.mjs board` to see every lane
> and who holds it, and `claim <id>` before starting work. See
> [`COORDINATION.md`](COORDINATION.md) for the command list and the rules code does not
> enforce. This roadmap stays a record of work; the lane board is the live channel.

## Current Focus

### ▶ NEXT SESSION — PRIORITY 1 withdrawn

The `retired-skills-budget` lane tracked a skill-budget failure in the removed cross-model CLI. That CLI is gone, so the lane is not a live next step. Use `node scripts/coordination/lane.mjs board` for the current queue.

### ▶ ALSO QUEUED — the CRLF trap (Dave, 2026-09-03)

**Any script that edits a repo file by exact-string match can silently no-op, because the working tree has BOTH line endings.** Hit three times in one session on 2026-09-03: two edits raised an assertion (loud, recoverable) and two test fixtures no-opped without complaint — a replay that appeared to pass while testing nothing.

Root cause, verified not assumed:

- `.gitattributes` declares eol for **only** `*.sh` (lf), `*.bat` and `*.cmd` (crlf). `git check-attr` confirms `.md`, `.ts`, `.mjs` and `.ps1` are all **unspecified**.
- Those fall through to `core.autocrlf=true` (set at repo level), which writes CRLF on checkout and normalises to LF on commit.
- So a file git has checked out is CRLF, while a file a tool wrote directly (Python `newline=''`, Node `writeFileSync`) stays LF until git next touches it. Sampled: `.claude/hooks/src` 29 CRLF / 11 LF; `.claude/rules-src` 25 CRLF / 15 LF.

Both existing rules are load-bearing and must survive any fix: `*.sh` MUST stay LF (a CRLF shebang makes a git hook fail `bad interpreter` and BLOCKS commits) and `*.bat` MUST stay CRLF (cmd.exe seeks by byte offset; LF garbles execution latently). Read the comments in `.gitattributes` before changing anything.

Two directions, not yet chosen:

1. **Declare eol for text files** (`* text=auto` plus explicit `.md`/`.ts`/`.mjs`). Fixes it at the source, but renormalises the tree — a large one-time diff that will collide with other sessions' in-flight work. Needs a quiet moment and `--renormalize`.
2. **Make the edit tooling newline-agnostic** — read with `newline=''`, detect, and match on both. Smaller blast radius, but every future script has to remember.

Whichever is chosen, add a guard: an exact-string edit helper that FAILS when its anchor matches zero times, so a no-op can never masquerade as a successful edit. That property, not the line endings, is what actually cost time.

### Previously (2026-07-29)

**Harness repair — hook test suite GREEN and ratcheted (2026-07-29)**
- `npx vitest run` in `.claude/hooks`: **109 files / 2164 pass / 0 fail / 7 skipped**, down from 93 failures. Held by two ratchets, each demonstrated failing on purpose.
- Entry point: [`docs/harness-strategy/README.md`](docs/harness-strategy/README.md). Handoff: `thoughts/shared/handoffs/suite-green/2026-07-29_suite-green-handoff.yaml` (outcome SUCCEEDED, nothing half-done).
- Two live defects the tests were right about, both fixed: the Braintrust tracing **off switch never worked**, and `agent-error-capture` had **stored nothing for 161 days**.
- ⚠️ **Action for Dave, not code: rotate the Braintrust API key.** The old failing test read the real `~/.claude/.env` and printed `Bearer sk-…` into its output.
- Next: README §5.1 (search router on a 143-day-stale index), §5.2 (TLDR retarget 3KB→8KB), Step 9 (`paths:` frontmatter, 0 of 46), Step 10 (prune — the 12 unregistered hooks found this session are candidates). The 234 `tsc --noEmit` errors remain a separate, unmeasured axis.
- Previous focus (lane-board repair + Agentic OS project identity data layer, started 2026-07-27) is complete; see the lane board for that track.

## YouTube Research — REMOVED 2026-08-30, rebuilding from scratch (Dave)

This implementation is torn down. A next-generation system will be built differently; the
components below were deliberately retained to feed it.

**Where everything went:**
- **Pipeline, skill, corpus removed from `main`** — commit `20a800c`, 157 files, pushed to
  `fork/main`. Kept: `docs/research/youtube/_digests` (cited by the session-prep-2026-08-06 pack).
- **Reference copy retained on `fork/ai-frontier-research`** (deliberate archive, not a loose end).
  The full pipeline also sits on the local `ai-frontier-research` branch.
- **Plugin repo** (was `C:\Users\david.hayes\claude-youtube-research`, no remote, 5 commits) pushed
  to `fork` as branch **`archive/youtube-research-plugin`**, verified, then deleted locally.
- **Archives** under `C:\Users\david.hayes\archives\`: `youtube-corpus-2026-08-29.zip`
  (2,398 files / 229,605,962 bytes, manifest-verified), `youtube-skills-2026-08-29.zip`
  (all four divergent SKILL.md versions), `youtube-plugin-releases\` (v0.1.0–v0.1.3, SHA256-matched).
- **Scheduled task `CCv3-YouTube-Poll` unregistered.** It had been failing since 08-28.

**Retained for the next system (D6):** yt-dlp, both ffmpeg installs, Tesseract, the `.venv` ASR
stack, the Whisper model, and `C:\Users\david.hayes\.claude\secrets\youtube-cookies.txt`.

**⚠️ OPEN — needs Dave, console-only.** The enterprise org marketplace still has plugin
**v0.1.2** published under Dave's name. **Decided 2026-08-30: upload v0.1.3 first, then unpublish.**
Rationale: 0.1.2 is the release with the null-deref in `listTarget` — with `--ignore-errors`, a
fully-failed extraction exits non-zero AND prints the literal string `"null"`, so `JSON.parse`
succeeds and an unguarded `data._type` crashes, swallowing the real error (live case: a
TLS-intercepting proxy's `CERTIFICATE_VERIFY_FAILED`). Anyone who installed 0.1.2 gets that crash
instead of the cause. v0.1.3 adds `parseListOutput`, which throws yt-dlp's own error text.

Upload artifact staged at `C:\Users\david.hayes\Desktop\youtube-research-v0.1.3.zip`
(40.1 KB, SHA256-verified against the archive). **No CLI path exists** — `claude plugin
marketplace` only supports add/list/remove/update for *consuming* marketplaces, so publishing and
unpublishing are enterprise admin-console actions Dave must perform.

Plan and full execution log: `thoughts/shared/plans/youtube-system-removal.md` (local-only).

## Fable Follow-ups — parked backlog (gated behind the trap harness)
Not started; the organized parking spot so they aren't lost. Both build on the Fable harvest and are gated by `docs/fable-manual/TRAP-TESTS.md` (arm B must beat arm A). Full detail: memory `fable-intelligence-and-agent-model-policy-followup`.
- **A — Targeted per-surface Fable injection.** Encode high-leverage Fable frameworks INTO specific agents/skills where a MEASURED gap justifies it (contract-writing → game-plan/workroom/worker agents; verify-by-re-derivation → critic/review-agent/principal-reviewer; risk = cost × lateness → premortem/aegis). NOT always-on — that debate is settled by the `no_lift` data. Depends on `docs/fable-manual/HIGH-LEVERAGE.md`.
- **B — Per-agent model + effort policy.** Agents carry explicit `model: opus|sonnet`, but effort is ONE global `settings.json effortLevel` applied uniformly. Want an agent → model → effort matrix (mechanical `spark` low-effort; deep `sleuth`/`principal-reviewer` high/xhigh). Scope: audit tiers, determine the Task-spawn mechanism (Workflow `agent({effort})` can tune per-call; Task-spawn can't natively), add a drift-guard. Anchors: `.claude/rules/agent-model-selection.md`, `check-agent-model-drift.mjs`.

## Removed cross-model CLI

The worker, the reviewer, and their design notes were deleted in CCV3-2. Git history keeps the old sections.

## Completed
- [x] fix(github): plain `git` and bare `gh` now route themselves. ROOT CAUSE: with no `credential."https://github.com".username`, GCM could not choose between two accounts, and a second (`wincred`) helper answered from an ambiguous `git:https://github.com` entry mapping to the WORK account — so every PERSONAL repo silently authenticated as `david-hayes44` and returned "Repository not found" (a 404, not a permissions problem). Fixes: `~/.gitconfig` gains `credential."https://github.com".username = Rev4nchist` + a `url."https://david-hayes44@github.com/fourth/".insteadOf` rewrite; the global `wincred` helper is REMOVED (only the system `manager`/GCM remains). New `scripts/github/gh-shim.ps1` shadows bare `gh` with a directory-routing function, dot-sourced from BOTH PowerShell profiles (`~/Documents/PowerShell/…` created new + `~/Documents/WindowsPowerShell/…`) — EXPLICIT BEATS DIRECTORY (a `GH_CONFIG_DIR` differing from the User-scope default passes through untouched), never throws, works on pwsh 7 and PS 5.1. New `scripts/github/accounts-lib.ps1` holds the shared resolution (`Get-AccountsConfig`, `Expand-HomePath`, `Get-OwnerFromUrl`, `Get-AccountByName`, `Get-AccountNameForOwner`, `Get-AccountNameForPath`, `Resolve-AccountByPath`, `Resolve-AccountByRemote`), dot-sourced by `gh-for.ps1`, `git-for.ps1` and `gh-shim.ps1` — what stays split is WHICH remote to read (gh uses origin + route fallback; git uses a specific remote). New `audit-remotes.ps1` (insteadOf-rewrite coverage) and `sweep-remotes.ps1` (probes every remote read-only with prompts disabled — THE gate). **`gh-for.ps1` was broken in both of its documented forms until this commit**: `[CmdletBinding()]` with `[string]$Path` first made `$Path` positional 0, so `gh-for.ps1 api …` bound `api` to `-Path` and died with "cannot determine an account for 'api'" (a `--` separator does NOT help — `pwsh -File` hands `--` to its own binder); fixed with `[CmdletBinding(PositionalBinding = $false)]`, which `git-for.ps1` had all along — so the 2026-08-05 entry below overstated the prior state of `gh-for.ps1`. MEASURED: sweep 25 FAILURES / 64 remotes → **0 FAILURES / 63 remotes**. `verify-github-accounts.ps1` gained LAYER 5 (21 → 24 checks: bare probe resolves to the DEFAULT account, exactly one credential helper, URL rewrite actually fires against a real repo) and PASSES all 24. `accounts.json` gained per-account `emailAliases` (GitHub noreply addresses accepted when AUDITING; `email` stays canonical-for-WRITING because `apply-commit-identity.ps1` writes it — an alias is NOT a wildcard). `~/fourth-brain-demo` origin removed (404 under both accounts; its 2 local commits intact). Corrections to previously-documented beliefs: `git remote -v` does NOT stay clean under `insteadOf` (it prints the REWRITTEN url; the STORED config is untouched — `git config --get remote.origin.url`); deleting the ambiguous `git:https://github.com` credential does NOT stay done (GCM recreates it on the next successful auth — `credential.<url>.username` is the load-bearing fix, the deletion is hygiene only); a no-username `git credential fill` DOES still return a credential and should (the default account) — the invariant is WHICH account answers; `git-for.ps1`'s empty `-c credential.helper=` token now has no second helper to clear, but STAYS as defence (layer 5 catches a second helper); revoking the "GitHub CLI" OAuth grant breaks `gh` AND plain `git push` together for that account (both held the same `gho_` token) and there is NO reissue button in the GitHub UI — re-run the client login flow (2026-08-11) `65d1444` + `351a377` + `fd9c179` + `3779045`
- [x] fix(braintrust): turn spans finalize per TURN, not per session. `stop` was registered ONLY on `SessionEnd` while being written for per-turn incremental work (it tracks `turn_last_line`), so **7,610 of 8,726 turn spans (87%) across 1,637 sessions were opened and NEVER closed** — open-ended, unbounded duration in the Braintrust UI. `stop` is now ALSO registered on a new `Stop` event key in BOTH settings.json copies (repo `.claude/settings.json` and active `~/.claude/settings.json`; there was no `Stop` key before), command `python`, timeout 15000 — and REMAINS on `SessionEnd` (timeout 30000) deliberately, as a safety net for an abrupt exit mid-turn. **Supersedes the 2026-08-07 planning note "Remove the `stop` entry from `SessionEnd`"** — nothing was removed from `SessionEnd`. `stop` no longer writes `current_turn_span_id` (the only two-writer key; `user_prompt_submit` now owns it exclusively) and is idempotent — it returns early ("already finalized") when the transcript has no new lines, REPLACING the old clear-the-id re-entry guard. Two blockers resolved empirically and recorded in `docs/hooks/braintrust-stop-event-scope.md` §3: (3.1) `Stop` and `UserPromptSubmit` are SERIALIZED — the CLI does not fire `UserPromptSubmit` until every `Stop` hook returns, proven with 90s and 40s holds (next prompt fired at +90,444ms and +40,327ms); (3.2) Braintrust TOLERATES a parent span arriving after its children — a child with a dangling `span_parents` reference is accepted (HTTP 200) and the hierarchy resolves on read. Consequence: the spool needs NO parent-before-child ordering, the originally planned locked merge is NOT needed (deferred as Option B), and the planned concurrent-writers test was dropped as it would assert against a fiction. 3 guards in `.claude/hooks/src/__tests__/braintrust-hooks-shutdown.test.ts` (12 tests in that file); full hook suite 117 files / 2284 passed / 0 failed. Verified live: STOP HOOK CALLED count incremented, `turn_last_line` appeared, `current_turn_span_id` held the NEW turn's id rather than `""` (2026-08-11) `ccdd14b`
- [x] feat(github): git-for.ps1 routes git credentials per account, like gh-for.ps1 routes gh (2026-08-05) `271f4a6`
- [x] fix(artifacts): lane board republished, and the registry now has to verify before it records (2026-08-05) `5c25df0`
- [x] docs(roadmap): the PowerShell matcher is proven live, and turn the paired commit off (2026-08-05) `97220ca`
- [x] docs(hooks): record the two-gate failure mode where widening a matcher does nothing (2026-08-05) `5ba820d`
- [x] docs(artifacts): the lane-board URL is dead while the registry claims it was published today (2026-08-05) `df01d2a`
- [x] docs(roadmap): record the four reasons a commit can go unrecorded in the audit README (2026-08-05) `5a5ccff`
- [x] docs(harness): both closed — store lands rows, dead hook archived (2026-07-29) `c573384`
- [x] fix(memory): agent-error-capture stores again after 161 silent days — THREE stacked causes: the `"Agent '"` noise-prefix blacklist (`05abf54`), a detached store that never completed (`unref()` + parent exiting in the same tick kills the child; 4-arm isolation ruled out job-object teardown), and a 0.88 dedup collapse caused by the first fix's own boilerplate. Also archived `hook-error-pipeline` (dead code, 3 prior audits agreed) (2026-07-29) `24e47a2`
- [x] fix(memory): B1 — unblock the noise-prefix half + a guard that parses `NOISE_PREFIXES` out of `store_learning.py`; removed 6 fossil `recall_learnings.py` filters (2026-07-29) `84454e4`
- [x] docs(harness): the suite is green, and two of the four groups were real bugs (2026-07-29) `1c7731e`, `a571425`
- [x] test(hooks): two ratchets so the suite cannot silently rot again — pass/**collected**-count ratchet + shape guard (no module-scope `main()`, no `node:test`), each demonstrated failing on purpose. The `node:test` check shipped **vacuous** on first write and only the deliberate-violation control caught it (2026-07-29) `ea5187e`
- [x] fix(hooks): suite green — 10 remaining failures to 0. Braintrust **off switch was inert** (`~/.claude/.env` overwrote the env var inside the guard; fixed in TS *and* Python); `plan-exit-tracker` 7 failures were one stale path (the gate itself was never broken); 27 hooks — not the documented 15 — got the `argv[1]` guard, verified 3 ways; the 93↔94 flapper was a 5-minute dedup marker in the real `$TEMP` (2026-07-29) `688228f`
- [x] test(hooks): delete 83 fossil failures, salvage the 13 that were real — the arscontexta subsystem was removed by `f9cdbef`, but 13 of the 5 files' 32 *passing* tests were the only coverage of 254 `intentPattern` regexes and the only E2E spawn of a live hook (2026-07-29) `0773a9f`
- [x] fix(spawn): reap the process TREE on timeout, not just the direct child (2026-07-26) `449e80e`
- [x] fix(project-cards): give the pre-emit its own --out path (it was clobbering $emitFile) (2026-07-25) `d89c53a`
- [x] feat(reporting): retire VP Weekly via an active-vs-retired type split (2026-07-25) `3adda93`
- [x] fix(reporting): extend always-emit contract to dashboard-sync + project-cards (2026-07-25) `4f5f38b`
- [x] fix(self-improvement): always-emit registry contract + bounded claude -p (2026-07-25) `f43755e`
- [x] fix(reporting): drop angle brackets from skill description (2026-07-25) `0fd86e6`
- [x] Rank-3 agent portfolio prune (07-02+07-14): 6 zero-usage agents archived (evidence-based; "delete .json twins" REJECTED — sidecars are live), recall-injector repo registration gap closed, structured return contracts on 6 core agents, README tier drift fixed (2026-07-25) `a02911e`
- [x] Simplify CCv3 code-intel: cut Serena + codegraph + /code-intel facade (near-zero adoption; usage-data-driven) + smart-search-router false-deny fix (2026-07-25) `cb64d45`..`cdbae08`
- [x] fix(reporting): trustworthy Reports Hub table + root-cause weekly false-stale (2026-07-20) `ac180c3`
- [x] feat(self-improvement): triage cockpit — deterministic HTML proposal-review + prioritize + JSON/MD export (2026-07-18) `6e91693`
- [x] docs(roadmap): absorb hook-appended completed entry (2026-07-18) `a37a9b7`
- [x] docs(self-improvement): backfill INDEX to 16/16, commit 07-18 observability proposal; unify ROADMAP (2026-07-18) `ee7d026`
- [x] docs(roadmap): close out reporting optimization track + commit sweep/viz state churn (2026-07-18) `3b6450a`
- [x] feat(reporting): proposal 07 — /reporting ops verbs (status/run/heal) folded into the reporting skill (2026-07-17) `c38926b`
- [x] feat(reporting): proposals 05+09 — hub Reporting Health strip + trust metrics rollup (2026-07-17) `b534dd5`
- [x] feat(reporting): proposal 08 — registry conventions codified + enforced in make-run validation (2026-07-17) `62ff375`
- [x] docs(roadmap): curate stale Planned section + repoint Current Focus at reporting 04-09 (2026-07-17) `148b81c`
- [x] feat(reporting): ntn-first health mirror — replace claude -p Notion step with deterministic health-mirror.mjs (2026-07-17) `7fcee47`
- [x] feat(reporting): shared hub page-lock + watchdog/check-drift consolidation groundwork (2026-07-17) `9ff3414`
- [x] fix(reporting): remap-proof Current-run picker + cockpit disk artifact (2026-07-16) `2087e04`
- [x] fix(reporting): audit follow-ups — tool grants, watchdog, truthful statuses (2026-07-16) `462d1aa`
- [x] fix(fourthos-weekly): never record OK without artifact truth (2026-07-16) `dc71cca`
- [x] chore(maintenance): close out Fable build (verified zero Opus-surface footprint) + repoint ROADMAP + fix session-start handoff skip-check (complete vs completed) (2026-07-16)
- [x] Merge PR #26 — /init-project review + hardening; new projects initialized (2026-07-15) `a9e7383`
- [x] Merge PR #25 — claude-for-sales SKO package build complete + rep-facing skill-builder (2026-07-13) `7659f1e`
- [x] docs(rules): fix stale port-table reference in dev-server-cleanup (2026-07-15) `2fb4b2f`
- [x] feat(init-project): harden skill + canonicalize project registry (2026-07-15) `66713e4`
- [x] feat(retired): /retired worker v1 — robust resume + --ignore-user-config latency + telemetry cleanups (dogfood-hardened) (2026-07-07) `832ce5a`
- [x] feat(retired): /retired Retired task worker v0 — ship + dogfood-harden + safety-spike (PR #15) (2026-07-07) `12a21dd`
- [x] docs(self-improvement): 07-01 hooks + 07-02 agents proposals + digest queue (2026-07-03) `7c4c79c`
- [x] feat(fourthos-weekly): Thu-cadence reschedule + v3.1 render rules (2026-07-02) `6472a4d`
- [x] feat(ai-report-card): version-control the VP weekly-report pipeline + Week 27 narratives (2026-07-01) `5ce12d6`
- [x] feat(self-improvement): daily research loop + ratify SI-01 from first proposal (2026-06-30) `ccbc67e`
- [x] feat(memory-awareness): FH-02 recall_ready telemetry + record data-gated re-baseline (2026-06-30) `0368785`
- [x] fix(hooks,health): FH-01 warm tldr daemon at session start + health-check tolerates on-demand absence (2026-06-30) `80b1b0f`
- [x] docs(handoff): FINAL-session materials cleanup + archive superseded handoffs (2026-06-30) `965a5d1`
- [x] docs(handoff): add canonical FINAL SESSION directive to NEXT-SESSION-PLAN (cycle wrap-up) (2026-06-30) `9ac76d2`
- [x] docs(foundation): record Session 2 foundation-hardening (A1-A4/B/A6/D/SG-01) + follow-ups (2026-06-29) `dfaab16`
- [x] perf(tldr-context-inject): git-freshness cache + narrow to code agents (D) (2026-06-29) `1fd155c`
- [x] fix(memory-awareness): restore host-memory-pressure degradation gate, integrated with ST-05 probeDaemon (BLOCKER-2) (2026-06-29) `501365e`
- [x] fix(daemon): multi-week resilience hardening (A1-A4) — recall-loop watchdog, explicit idle-conn lifetime, stale-conn retry recycle, cheap redundant-spawn exit (2026-06-29) `237c72e`
- [x] docs(plan): Phase 3 DONE; record host-ram regression + tldr-context-inject finding for next session (2026-06-29) `110e423`
- [x] docs(st-05): mark ST-05 shipped + verified; record e2e + import-fix lesson; update plan (2026-06-29) `3fbdf9f`
- [x] fix(opc): ST-05 daemon recall import -- resolve do_recall in the live script context (2026-06-29) `31ffd8d`
- [x] feat(opc): ST-05 resident recall daemon -- Python recall op + query_vector seam (2026-06-29) `a9dd226`
- [x] docs(st-05): fold Retired premortem into design (v2 hardened) + go-decision (2026-06-29) `b67e5c2`
- [x] docs(st-05): resident recall daemon design proposal + premortem register (2026-06-29) `aa6c982`
- [x] fix(hooks): destructive-guard round-2 -- fix FPs + close verify-sweep holes (2026-06-29) `3707420`
- [x] fix(hooks): destructive-guard recurses into wrapper + substitution payloads (Phase 1b) (2026-06-29) `5a9abe5`
- [x] fix(hooks): agent-error-capture fire-and-forget + tightened trigger (Phase 1a) (2026-06-29) `09ba655`
- [x] docs(handoff): F4 interactive-gate verified — SAFE fully confirmed (2026-06-29) `9568ae5`
- [x] docs(handoff): 2026-06-29 review + remediation — closed 4 review-found SAFE S1 gaps (2026-06-29) `39379ac`
- [x] fix(hooks): close 4 review-found SAFE gaps (RCE daemon path, guard bypasses, Windows loop) (2026-06-29) `9613d3c`
- [x] docs(handoff): 2026-06-28 threshold-execution — LIVE/SAFE/HONEST shipped, USABLE partial (2026-06-29) `52de54d`
- [x] fix(settings): Phase 2 / SG-02 — reconcile fresh-install template + add validation guard (2026-06-29) `b219109`
- [x] fix(hooks): D5b-01 — sanitize raw recall in the 2 remaining injectors (poison-then-inject) (2026-06-29) `83c3f17`
- [x] perf(hooks): Phase 3 — drop dead checkLocalMemory from the recall hot path (D3b-04) (2026-06-29) `3201760`
- [x] fix(settings): QW-04 — flip agent safety+verification chain matcher Agent->Task (2026-06-29) `574e7f5`
- [x] fix(hooks): Phase 1b — argv-ify smart-search-router ripgrep fallback (close RCE) (2026-06-29) `4dab9f8`
- [x] docs(handoff): 2026-06-28 session close — Wave 1 7/9 + multi-session arc + incremental sync (2026-06-28) `b895010`
- [x] perf(sync): incremental forward-sync — copy only changed files, not the full .claude/ mirror (2026-06-28) `9cd77e1`
- [x] fix(hooks): QW-12 roadmap-sync guards — relatedness, cwd verification, path-containment (2026-06-28) `bb96a55`
- [x] fix(hooks): QW-11 post-edit-diagnostics — real tsc invocation + bus 'edited' before early-return (2026-06-28) `a8b10c5`
- [x] fix(memory): QW-06 repair hybrid recall relevance — floor-on-base + OR-FTS + cosine gate (2026-06-28) `10ee124`
- [x] docs(system-update): fold multi-session coordination into the backlog — ST-02 foundation + MS-01/02/03 arc + SG-04+ (2026-06-28) `aa3f6fa`
- [x] fix(skills): QW-08 remove 28 ghost skill registrations from skill-rules.json (2026-06-28) `f9cdbef`
- [x] fix(rules): QW-09 defuse hook-auto-execute — deny reasons are guidance, not authorization (2026-06-28) `90cb2b9`
- [x] fix(hooks): QW-05 revive epistemic-reminder Grep guard — tool_name + additionalContext (2026-06-28) `3429858`
- [x] fix(memory): QW-07 intent-pollution filter — drop machine-generated prompts before recall (2026-06-28) `b1967ba`
- [x] docs(system-update): snapshot branch + orientation library (`docs/system-update/`) + handoff for coordinated multi-session backlog execution (2026-06-27)
- [x] feat(viz): CCv3 state-of-rework deliverable — 4 Excalidraw diagrams + SVGs + briefing + generators (`scripts/viz/`); published as live interactive deck at rev4nchist.github.io/ai-enablement-decks/ccv3-state-of-rework/ (2026-06-27) `359843b`
- [x] fix(hooks): close ROADMAP cross-project contamination guard — stopword + positive own-plan flip + D2F-03 (QW-03, S0) (2026-06-12) `f7f3eba`
- [x] fix(hooks): relocate /tmp search-context handshake to os.tmpdir() (QW-02, S0; D2b-05) (2026-06-12) `89c9e5e`
- [x] fix(security): close store_learning.py shell-injection — execSync->spawnSync argv (QW-01, S0; D5a-01/D2c-04/D2d-06/D3a-01) (2026-06-12) `1788211`
- [x] review(wf3): Fable-5 deep review COMPLETE — 190 confirmed findings + ratifiable 4-tier backlog + 2 Retired cross-model passes (2026-06-12) `f143e5b`
- [x] review(wf2): 248 findings verified (190 CONFIRM, 48 DOWNGRADE, 10 KILL) (2026-06-11) `c695c63`
- [x] P1 — Bus-bias hybrid-recall lift: **KEEP ENABLED** — verified warm gate +7.3%/flat-hit (n=13, corpus 584); +33.6%/63->88% retired as a stale snapshot; tune focus-weighting deferred (2026-06-06)
- [x] fix(memory): stop test suite from spawning real embedding daemons (herd source #2) (2026-06-05) `c1b110d`
- [x] fix(memory): herd-proof embedding-daemon spawn — atomic lock + no-shell Windows spawn (2026-06-05) `ea1b03c`
- [x] fix(memory): address CodeRabbit findings on PR #7 (2026-06-04) `d996d7f`
- [x] docs(ws2): flip B.4b deferred -> DONE; record warm hybrid-gate re-run (2026-06-04) `72cee99`
- [x] fix(memory): canonical daemon discovery path -- end TMPDIR/TEMP rendezvous mismatch (2026-06-04) `032f940`
- [x] Merge PR #6 — WS-2 Phase B Phase 3 + B.4b into fork/main (2026-06-04) `0a2e75b`
- [x] feat(ws2): B.4b bus-tool-populator (Read→read_for_context / Grep→grep_hit) + path-containment hardening (2026-06-03) `fbb7b03`
- [x] docs(ws2): 3.4 close-out — Phase 3 Build Progress (B.1/B.2/B.5 DONE) (2026-06-03) `024eb38`
- [x] feat(ws2): 3.3 harden bus quality-gate — known-match cases + 0-DB-writes proof (2026-06-03) `d580fc9`
- [x] feat(ws2): 3.2 code-intel enforcer (inert) + pruneIntelBus wiring + dual registration (2026-06-03) `6beacca`
- [x] feat(ws2): 3.1 /code-intel facade (code-intel.mjs + SKILL.md) (2026-06-03) `b740723`
- [x] feat(ws2): 3.0 pre-commit build-forget guard + idempotent install-hooks.sh (2026-06-03) `3c5f659`
- [x] Merge PR #5 — WS-2 Phase B bus WRITE+READ+hardening into fork/main (2026-06-03) `1295fd4`
- [x] docs(ws2): address CodeRabbit PR#5 round-2 -- clarify test-count baseline + repo-relative path (2026-06-03) `ebe55ae`
- [x] docs(ws2): session-5 handoff + ROADMAP -- merge #5 then resume Phase 3 (2026-06-03) `7d27b91`
- [x] fix(ws2): address CodeRabbit PR#5 review -- gate failure-guard + focus_terms cap (2026-06-03) `1d1b3e7`
- [x] fix(ws2): B.3 premortem hardening -- bus-focus allowlist + biased-recall telemetry (2026-06-03) `d7557bd`
- [x] docs(ws2): session-4 handoff -- review-then-push-then-resume orientation (2026-06-03) `bcf457b`
- [x] docs(ws2): session-3 Build Progress -- B.3 read side + quality gate done (2026-06-03) `40180b1`
- [x] refine(ws2): B.3 quality gate -- gate query-bias to hybrid recall only (2026-06-03) `cfb0be4`
- [x] feat(ws2): B.3b -- memory-awareness READS the bus + shared bus-focus module (2026-06-03) `0e85d49`
- [x] feat(ws2): B.3a -- agent-recall-injector READS the context bus (2026-06-03) `8929667`
- [x] fix(ws2): B.0/B.4/B.4a review hardening -- 5 bus findings + self-regression (2026-06-02) `dd0d24b`
- [x] fix(retired-adversary): clean findings capture via -o; silence config noise (2026-06-01) `4febb8d`
- [x] docs(retired): verify CLI repair, reconcile version + auth claims (2026-06-01) `11f99ca`
- [x] docs(hardening): Phase-3 tail 1/2/3/5 done + 3rd reverse-sync vector fix; item 4 remains (2026-06-01) `cc1ec7f`
- [x] perf(memory): text-only recall fail-fast (12s->5s) in checkDbMemory (2026-06-01) `28184c3`
- [x] fix(hooks): deregister broken TLDR warm-cache SessionStart hook (2026-06-01) `a08014a`
- [x] docs(sync): forensics + fix-record for the 3rd hooks/src regression vector (2026-06-01) `ded901b`
- [x] docs(hardening): Phase 0-2 + agent-recall shipped; Phase 3 continuation handoff (2026-05-31) `df7ecad`
- [x] feat(memory): Phase 3 - activate agent-side recall (the audit's #1 gap) (2026-05-31) `017929a`
- [x] fix(session): Phase 2 Step 4 - Windows HOME fallback + drop dead import; no file_claims migration needed (2026-05-31) `f6a654e`
- [x] feat(hooks): Phase 2 Step 3 - lean per-prompt hot path + hook-manifest gate (2026-05-31) `7d858cf`
- [x] fix(sync): restore --skip-build as accepted no-op (post-commit hook passes it) (2026-05-31) `2702bbd`
- [x] fix(memory): complete WS-0.2 - sanitize type/id/subagentType + cap-before-encode (2026-05-31) `a16e7f9`
- [x] fix(memory): WS-0.2 sanitize recalled content against prompt injection (2026-05-31) `61625aa`
- [x] fix(hooks): Phase 0 - recovery-banner gating + knowledge-tree discovery noise (2026-05-31) `e48dc92`
- [x] feat(roadmap): preserve hand-written notes across planning + surface at session start (2026-05-30) `bf91c19`
- [x] fix(roadmap): make TaskUpdate advisory-only; demote focus on replan (2026-05-30) `091f19f`
- [x] [LOW] Close braintrust-emit audit blindness — widen `scripts/audit-braintrust-emits.sh` to assert `detectToolError`/`tool_response_keys` instrumentation is present (audit currently only counts awaited emit sites via `INVARIANT_4`, blind to Gate B2 success-signal reversions, `f681df7`). Optional belt-and-suspenders: PreToolUse Edit/Write guard on `.claude/hooks/src/*.ts`. Re-infection vector closed (`ddc0641`, `6c11a1a`), so low urgency. (2026-05-30)
- [x] Fix ROADMAP corruption: roadmap-completion TaskUpdate branch (2026-05-30)
- [x] Fix two session-start annoyances: tldr daemon error + PageIndex login popup (2026-05-29)
- [x] feat(viz): architecture-stats auto-sync script + post-commit hook (2026-05-27) `158ad4c`
- [x] feat(viz): CCv3 architecture hub + 4 subsystem deep-dives + refreshed overview (2026-05-27) `e1850bf`
- [x] fix(sync): add scripts/ to forward-sync SYNC_DIRS — propagate script fixes to active mirror (2026-05-26) `6c11a1a`
- [x] docs(architecture): refresh to current ops — Braintrust 6th pillar + factual fixes + roster gaps (2026-05-26) `4e3af28`
- [x] feat(braintrust): judge_session --force + cross-project recall aggregation (2026-05-26) `ca892a9`
- [x] fix: restore Gate B2 telemetry-tracker + untrack architecture-stats (4aefe81 over-committed) (2026-05-25) `43a1234`
- [x] docs(braintrust): correct Gate C recipe to local scheduled runner + add batch wrapper (2026-05-25) `4aefe81`
- [x] feat(braintrust): detectToolError + tool_response_keys instrumentation (2026-05-24) `f681df7`
- [x] feat(spark): R1+R3+R5+R6+R9 hardening — editing constraints, scope limits, post-spark verification (2026-05-23) `154b23d`
- [x] harden(audit): INVARIANT_4 rename + await-only grep + pattern banner (R2) (2026-05-23) `0b208d6`
- [x] Spark Agent Reliability Hardening — R1+R2+R3+R5+R6+R9 (2026-05-23)
- [x] fix(braintrust): await remaining 2 score emits so subprocess exit doesn't kill POSTs (2026-05-23) `faa99da`
- [x] fix(braintrust): await skill_trigger_accuracy emit so process.exit doesn't kill POST (2026-05-23) `7edea3c`
- [x] Phase 3b Pickup — Verify, Harden, Then Autoevals (2026-05-22)
- [x] Deeper Claude+Retired Adversarial Collaboration (Repair → Envoy Pilot) (2026-05-22)
- [x] Braintrust Review & Scoring Strategy for CCv3 (2026-05-21)
- [x] fix(memory): confidence-firming pass — sync project_memory, backfill 244 rows, tighten L0 gate (2026-05-21) `48a2157`
- [x] docs(memory): add animated HTML visualization of the memory system (2026-05-21) `4379630`
- [x] fix(memory): P0 audit fixes + close memory-cleanup-round-1 (2026-05-21) `885f8da`
- [x] Memory System Deep Audit — Go/No-Go Gate (2026-05-21)
- [x] docs(memory): Phase 5 verified GREEN; close memory-cleanup-round-1 (2026-05-21) `3712579`
- [x] test(memory): clean 42/42 reranker eval -- verdict reconfirmed opt-in (2026-05-21) `f9ca075`
- [x] fix(memory): raise daemon ping timeout to 1.5s; lift eval_recall core import to module scope (2026-05-20) `713deaa`
- [x] fix(memory): embedding daemon refuses to start if another instance is alive (2026-05-20) `7c95ca5`
- [x] test(memory): mock spawn in embedding-client tests; stop real daemon launches (2026-05-20) `c7412df`
- [x] fix(memory): hide cmd.exe window on daemon spawn (windowsHide) (2026-05-20) `b3b8177`
- [x] fix(memory): stop daemon-spawn cascade (ping cleanup + cross-process mutex) (2026-05-20) `0a2d4e1`
- [x] Make `plan-mode-approval-gate` actually block ExitPlanMode in `--dangerously-skip-permissions` mode (2026-05-19)
- [x] fix(memory): restore memory-awareness.ts (T#11 + Phase 1 regression from d47b970) (2026-05-19) `0b59faa`
- [x] fix(hooks): stop emitting broken [type](scope) markdown links in ROADMAP entries (2026-05-19) `a1397ee`
- [x] Memory System — Task #11 BGE embedding daemon shipped default-on (2026-05-18) — hook-time hybrid recall enabled, Phase 1 Windows timeout regression repaired. Commits: `36b241a` `0f12c43` `3912209` `e8566b3` `57b6724`
- [x] Memory System — Phase 2 follow-ups + Task #11 hook-time recall path (2026-05-19)
- [x] [fix](memory) hook subprocess timeout + test isolation + timeout diagnostic (2026-05-18) `e8566b3`
- [x] [fix](memory) mode-aware floor split (hybrid 0.01, text-only 0.05) (2026-05-18) `3912209`
- [x] Memory System Upgrade — Phase 2: Cross-encoder reranker shipped opt-in (2026-05-18) — NDCG@5 +110% lift; P95 latency 95s/5s fails 500ms gate; `--rerank` stays opt-in. Commits: `31169eb` `5d13b7f` `4f97be3` `b6cc578` `4d4dbff` `f40e4e2` `83d1308`
- [x] [fix](memory) correct rerank bench percentile + bump eval daemon timeout (2026-05-18) `83d1308`
- [x] [feat](memory) add NDCG@5 + latency eval harness for Phase 2 reranker (2026-05-17) `b6cc578`
- [x] [feat](memory) add Stage-2 cross-encoder reranker (Phase 2) (2026-05-17) `5d13b7f`
- [x] [test](memory) add Phase 2 recall eval set (42 query→relevant-id pairs) (2026-05-17) `511c246`
- [x] Memory System Upgrade — Phase 1 hardening (types, retrieval, agent recall, temporal) (2026-05-17) `e8444e6`
- [x] Diagnose & Remediate System Memory Pressure (AFK 50% → 99% Growth) (2026-05-16)
- [x] Plan — Headless 360 is live, what we ship next (2026-05-14)
- [x] [feat] manifest-driven hub with sidebar ToC, filters, status pills, OG meta, breadcrumbs (2026-05-13) `85f0e84`
- [x] [fix](continuous-claude-architecture) point footer source links at GitHub-rendered diagrams (2026-05-13) `187d4c2`
- [x] CCv3 Interactive Architecture Visualization (2026-05-13)
- [x] Add continuous-claude-architecture deck (2026-05-13) `5eebe29`
- [x] Resolve stashed hook simplification — `git stash list` shows `stash@{0}: deferred: hook simplification + sync-to-active.sh (pre-existing staged work, not kusto-cli scope)`. Stashed 2026-05-04 to clear the kusto-cli PR. 12 files: 11 `.claude/hooks/src/*.ts` + `.claude/scripts/sync-to-active.sh`. Net: ~590 deletions, 112 insertions (~478 net). Originated in the `claude/lucid-hellman` worktree alongside `stash@{1}: dist-noise-from-prior-esbuild`. Inspect via `git stash show stash@{0} --stat`; recover via `git stash pop stash@{0}`. Decide: ship as a separate PR, discard, or keep parked. (2026-05-12)
- [x] CCv3 Interactive Architecture Visualization (2026-05-12)
- [x] Diagnose & Remediate System Memory Pressure (AFK 50% → 99% Growth) (2026-05-12)
- [x] Add foundry-hosted-agents deck (2026-05-12) `bb3e498`
- [x] Adjust `ebr-presentations/CLAUDE.md` for Brinker / iQ360 (2026-05-12)
- [x] [fix](kusto-cli) apply self-review findings (factual + coverage + structural) (2026-05-04) `8d9a6a0`
- [x] [feat](kusto-cli) integrate Microsoft Kusto.Cli for KQL queries (2026-05-04) `183fe58`
- [x] [fix](health_check) fail loudly when hook-trace file is unreadable (2026-04-30) `b43accf`
- [x] [fix](misc) wizard quoting + hook-trace readability + dedup test cleanup (2026-04-30) `38b37bb`
- [x] PR #3 CodeRabbit Review — Remediation Plan (2026-04-29)
- [x] [test](memory-isolation) Phase 1 fix-up - commit recall scope acceptance tests (2026-04-29) `0acbb1a`
- [x] [test](plan-to-ralph) bump test timeouts to 15s for Phase 4 isolation tests (2026-04-29) `c5e3426`
- [x] [fix](stress-harness) Phase 5 - fix vitest + skill-eval exit-code parsing (2026-04-29) `61a6757`
- [x] [fix](coordination) Phase 4 - scope file_claims and hook state by project (2026-04-29) `331ce8b`
- [x] [fix](session-start) Phase 3 - warn on .claude skip + extend hasCodeFiles() (2026-04-29) `b9ec375`
- [x] [fix](hooks) Phase 2 - replace hardcoded user paths with os.homedir() (2026-04-29) `a495931`
- [x] [feat](memory-isolation) Phase 1 - filter recall by project_id (2026-04-29) `ebbcc95`
- [x] CCv3 System Coherence Stress Test — Comprehensive Suite (2026-04-28)
- [x] [refactor](memory-remediation) Phase 5 - lazy_tree.invalidate writes stale marker, never deletes (2026-04-28) `8b109dd`
- [x] [feat](memory-remediation) Phase 4A - route v1 store_learning through v2 quality gate (2026-04-28) `58d1da1`
- [x] CCv3 Memory System Remediation Plan (2026-04-27)
- [x] CCv3 Final System Review — Pre-Next-Task Verification (2026-04-27)
- [x] [docs](cleanup) Commit A -- archive MEMORY.md + strip drifty counts (2026-04-27) `0b00cf7`
- [x] [fix](rlm) route large prompts via stdin to avoid Windows argv overflow (2026-04-27) `5028903`
- [x] [fix](phase-5c) pre-push review followups (R5 completion + cleanup) (2026-04-27) `2aa0c57`
- [x] [docs](phase-5c) R4 sentinel<->browser-dev-cycle xref + R8 deployer neonctl awareness (2026-04-26) `3cb9aa8`
- [x] CCv3 System Coherence — Comprehensive Plan (2026-04-26)
- [x] [feat](phase-4) activate dormant tree+memory daemons; add tldr daemon health check (2026-04-26) `f80013f`
- [x] [feat](health-check) bridge category - skill present, page IDs stable, MCP configured (2026-04-26) `a285b52`
- [x] [feat](memory-awareness) raise proactive-injection floor (Phase 4.1) (2026-04-26) `ad27e9b`
- [x] [refactor](hooks) move 5 LIB modules to src/lib/ (Phase 3) (2026-04-26) `c90bf02`
- [x] [docs](phase-2) hook audit script + decisions doc (read-only) (2026-04-26) `61589a7`
- [x] CCv3 System Coherence — Comprehensive Plan (2026-04-26)
- [x] [feat](health-check) adaptive canary timeout (P95x2, floor 90s, ceiling 300s) (2026-04-26) `ed495a9`
- [x] [refactor](memory) canonicalize SKILL.md as single source, stub the 4 rule files (2026-04-24) `31e3670`
- [x] [feat](health-check) weekly system health audit with Notion dashboard integration (2026-04-24) `c766fcf`
- [x] [feat](rlm) production wrapper for Recursive Language Models with Docker sandbox (2026-04-24) `a72da5f`
- [x] Recursive Language Models (RLM) — Production Adoption Plan (2026-04-24)
- [x] Fix `permission-auto-allow` Hook: Unblock AskUserQuestion in Plan Mode (2026-04-23)
- [x] [feat] backfill V2 -- scan Fourth AI project pages for dated activity (2026-04-23) `47ca3b4`
- [x] [fix] declaw ralph-delegation-enforcer to stop blocking agents (2026-04-23) `1e30ac9`
- [x] [fix] em-dash regex in backfill + add REPO_PATHS override for outliers (2026-04-23) `837cb86`
- [x] [feat] backfill-tracker script + initial dry-run plan (2026-04-23) `6b3a4f4`
- [x] [feat] add collect_weekly_work_tracker + mark_published MCP tools (2026-04-23) `4583640`
- [x] [feat] restructure as multi-week report archive (2026-04-17) `f25df6d`
- [x] RAM Recovery Plan — Minimal-Disruption Actions (2026-04-16)
- [x] Add GTM status presentations: risk report Apr 16 (2026-04-16) `e4d65e9`
- [x] System Resource Recovery Plan (2026-04-15)
- [x] Integrate `openai/retired-plugin-cc` into CCv3 (2026-04-15)
- [x] Add CLAUDE.md with mandatory hub-update instructions for new decks (2026-04-11) `1ebae90`
- [x] Remove enablement flag from Pages workflow (2026-04-11) `cc7d52a`
- [x] Consolidate 6 decks into grouped landing page (2026-04-11) `3b64def`
- [x] Multi-Presentation Repo Pattern (2026-04-11)
- [x] Fix Cowork Plugin Upload + Full Audit Results (2026-04-11)
- [x] Add GitHub Pages deployment workflow (2026-04-09) `51732a4`
- [x] EBR Processor Project Setup + Zendesk Integration Consolidation (2026-04-07)
- [x] [fix] use sse transport type for fourth-playwright MCP connector (2026-04-02) `7f3df8a`
- [x] Zendesk Ticket Integration for EBR Builder (2026-04-02)
- [x] Eliminate Excessive Permission Prompts for Autonomous Agent Tasks (2026-04-02)

## Planned
- [ ] **Coordination repair — ST-02 identity + claim hardening (THE GATE for multi-session work)** (high priority). Verified 2026-07-26: `sessions` = 1,476 `s-*` + 894 uuid rows (two per real session); `file_claims` = 8,170 rows, **0 owned by a live session**, 3,168 orphaned, 5,002 stale-owner. Cause: `SessionStart` has no matcher so it fires for subagents; `session-register.ts:34` discards the payload `session_id` and stomps the machine-global `~/.claude/.coordination-session-id`, while `heartbeat.ts:62` uses the payload id. Fix = payload-first identity + per-terminal cache + `CC_TERMINAL_ID` sibling rule **in one commit** (splitting them makes subagent fan-out hard-block itself). Then `file_claims` lease/TTL/fence + the G5 migration (`DELETE … WHERE session_id LIKE 's-%'` wipes all 8,170 — `pg_dump` first). Plan: `~/.claude/plans/we-have-been-working-jolly-token.md` (medium priority)
- [ ] **Agentic OS — local-first Mission Control (Slice 1 of 4)** (high priority). **Supersedes this entry's earlier "psql for two weeks before any UI" scoping** — the plan approved 2026-07-25 (`~/.claude/plans/i-am-ready-to-noble-wilkinson.md`) deliberately inverts the documented phase order and makes the read-first dashboard Slice 1, not Phase 4. Localhost, single user, **writes nothing**: no auth/OIDC/RLS/`workspace_id`. Hybrid interface — fleet grid is home, click a project for its Canvas. Reads `agentic_os.*` joined to read-only `public.sessions`/`file_claims`/`archival_memory`. Port 3010 (registered). **Two plans are on disk and only this one is in force** — `docs/architecture/agentic-os/` (2026-07-18) describes a governed multi-tenant service and is the destination, not the spec; the five ADRs in `docs/architecture/agentic-os/adr/` record every departure. Lanes: `aos-scaffold` (prerequisite) → `aos-project-identity` (**the gate** — 111 raw `sessions.project` values hand-seeded into `project_alias`; get it wrong and Slice 1 is actively misleading, which is worse than shipping nothing) → `aos-fleet-grid`, `aos-project-canvas`. Counting hazards that must reach the UI: only **887 of 2,352** `sessions` rows are real (1,465 are `s-*` heartbeats), and only **342 of 494** transcripts join. Never `drizzle-kit push` (shared DB, 40 `public` tables belonging to 3 other apps); `schemaFilter: ['agentic_os']` + private `agentic_os.__migrations` journal, both already in `drizzle.config.ts`. (medium priority)
- [ ] **Harness supply-chain integrity (R1/R2)** (high priority). Verified live: `scripts/sync-to-active.sh:283,443` run `jq '.mcpServers = $mcp'` — a wholesale **replace** of the global `~/.claude/settings.json` MCP server set from a repo-tracked file, unvalidated, on post-commit. With `origin` = third-party upstream and `git pull` in the documented workflow this is the CVE-2025-59536 primitive. **The allowlist/hash manifest must be anchored OUTSIDE the synced repo** (Retired premortem: a manifest inside the repo is shipped by the same malicious commit and passes itself). Also: 75 active hook registrations vs 59 in repo — 16 execute undescribed by VCS; `dist/*.mjs` verified by file *count*, never hash. Source: `docs/self-improvement/proposals/2026-07-26-hooks.md` (medium priority)
- [ ] **Root-cause the headless `claude -p` hang** (high priority). 3 of 13 scheduled pipelines (Dashboard-Sync, Project-Cards, Self-Improvement-Research) exit `0xC000013A`. Identical signature: the always-emit registry row lands, then the process dies at the `claude -p` step, leaving every row `Failed`. The always-emit contract works; what it records is genuinely broken. Handoff: `thoughts/shared/handoffs/reporting-watchdog/2026-07-25-always-emit-shipped-verification-pending.md` (medium priority)
- [ ] CCv3 Harness Hardening — Fix the Git-Bash Fork Storm + tldr daemon-warm (high priority)
- [ ] Plan — Make the Reports Hub "Report pages" table trustworthy + root-cause the live failures (high priority)
- [ ] **Self-Improvement loop — visibility & pipeline, Part C remainder** (2026-07-24 status: artifactUrl fix + silent-failure Warn gate ALREADY SHIPPED in `0c58413`; remaining = host cockpit on GitHub Pages `ai-enablement-decks` (mirror `scripts/fourthos-weekly/promote.mjs`), wire `triage/build.mjs` regen into `run-research.ps1`, recreate broken hub linked-view (`reportRunsViews` re-pin in `report-runs.ids.json`), live-verify registry row chain. Plan: `~/.claude/plans/we-are-working-in-abstract-nebula.md` (high priority)
- [ ] **Self-Improvement triage backlog — ranked 2026-07-24** (Dave's cockpit export `Downloads/self-improvement-triage.json`, 16 proposals all bucket=next): in-flight this session → rank 2 memory routing defect (07-12 R1/R2) + rank 4 learning-loop distillation (07-09 R1-R3). Queued next sessions → rank 1 observability step-level scoring (07-18), rank 3 agents pruning/memory-blindness (07-14 + 07-02), rank 5 memory reranker wiring (06-30, reshaped async/manual-first per 07-12 R3), rank 6 workflows cheap ADOPTs (07-03/07-15), rank 7 skills hygiene+telemetry (07-07). SUPERSEDED: ranks 8+14 code-intel (07-04/07-16) — overridden by the 2026-07-24 Serena/codegraph cut (`cb64d45`); do not re-propose Serena. (high priority)
- [ ] Fable — close-out (CLOSED) (high priority)
- [ ] **Reporting optimization — remainder** (05/07/08/09 SHIPPED 2026-07-17: `62ff375` conventions, `b534dd5` health strip + trust metrics, `c38926b` /reporting ops verbs; statuses live in artifact `a45fad78`): **04 remainder** = reporting-efficiency Phase 2 (batched STDIN bind + meaning-based hash-gates — spec'd with premortem mitigations in `thoughts/shared/handoffs/reporting-efficiency/2026-07-17-phase1-shipped-phase2-next.md`; dedicated session; dashboard-sync deterministic repoint stays BLOCKED on GAP-1..4) · **06** unattended VP Weekly — IT ticket DRAFTED (`thoughts/shared/handoffs/reporting-optimization/it-ticket-batch-logon-draft.md`), Dave submits · manual follow-ups: live 7/02 hub-callout cleanup + reviewed-date stamps on human sections; ROADMAP-guard hook fix (H1/H2 file:line spec in the efficiency handoff) (high priority)
- [ ] Verify first unattended fourthos-weekly run — Thu 2026-07-23 07:00; check `~/.claude/logs/fourthos-weekly/` + verify-run.mjs classification (high priority)
- [ ] fourthos v4 report enhancements — design-approved, staged on main via PR #12; dedicated session, resolve the 4 open choices first (memory: `fourthos-v4-build-queued`) (medium priority)
- [ ] HELM — Notion-first command center (pivoted 2026-07-03: engine unchanged, presentation = Notion Projects DB + HTML daily brief via `ntn`; local SPA deferred behind daily-use gate) (medium priority)
- [ ] Grok check-back — externally blocked (corp egress). When probe.ps1 shows READY: `/harness-update grok` (0.2.99 unverified) → grok-adversary pass on the parked plan. IT allowlist ticket for `*.x.ai` (medium priority)
- [ ] Fleet-review residuals (post-PR #17): DEL-11 curation, Pocock 7-point deep-review pass, downgrade canary, `updatedInput` spike (low priority)
- [ ] CCv3 system-update backlog remainder — Tier 2 structural arcs, Tier 2b multi-session coordination, Tier 3 strategic programs, 12 deletions: tracked in `docs/system-update/BACKLOG.md` (medium priority)
- [ ] WS-2 remainder: Phase B/C RETIRED 2026-07-24 (Serena/codegraph/facade cut, `cb64d45`) → remaining scope only: D memory bridge (needs GIN index) → E observability (medium priority)
- [ ] P2 — Verify embedding daemon survives a REAL reboot (scheduled task only ad-hoc-verified; Retired flagged job-object detach). After next restart confirm `~/.claude/run/ccv3-embedding.json` appears <60s + warm recall (medium priority)
- [ ] P2 — Ops: full parallel `vitest run` hangs on a pre-existing Windows daemon/socket suite — add a hard per-test timeout (medium priority)
- [ ] P3 — Ops: async post-commit forward-sync race leaves active hook dist stale — hash-verify + `cp` after every hook commit until root-fixed (low priority)

## Notes
**CCv3 Hardening — durable pointers (preserved across planning per `bf91c19`):**
- Full handoff for the implementing session: `docs/ccv3-hardening-handoff-2026-05-30.md`
- Lean audit: `docs/ccv3-lean-audit-2026-05-30.md` · v3 design: `~/.claude/plans/we-have-recently-done-refactored-storm.md` · Retired raw: `.claude/cache/agents/retired-adversary/latest-output.md`
- **The 6 hard gates (do not violate):** G1 sync-fix-structural-before-WS2-hooks · G2 finish-UPS-prune-before-Phase-A · G3 injection-fix-before-agent-recall · G4 never-parallel-edit-the-same-memory-files (the May-2026 regression pattern) · G5 session-id-consolidation-needs-file_claims-migration · G6 skill-archive-cross-check-vs-Phase-B.5.
- Data note: use `count(*)` not `pg_stat` for usage calls (the latter mis-reported memory/PageIndex as empty). Live counts: archival_memory 569, pageindex_nodes 2418, file_claims 6720, sessions 1117.

## Recent Planning Sessions
### 2026-08-31: harness-security lane — clobber guard, repo sources, settings reconcile, ~/.claude history
**Key Decisions:**
- `dst` missing, or `dst == src` → copy / no-op, update manifest. Normal.
- `dst` differs from `src` but `dst` hash == manifest entry → active is just stale; copy, update manifest. Normal forward sync.
- `dst` differs from `src` AND (`dst` hash != manifest entry OR no manifest entry) → **active was edited since last sync**: move `dst` to `~/.claude/.sync-quarantine/<YYYY-MM-DD-HHmmss>/<relative-path>`, then copy, print a loud `CLOBBER-GUARD` report line per file and a summary block at the end. Never silently overwrite.
- Missing/corrupt manifest fails safe: treated as "no entry" → quarantine path (over-quarantines rather than over-clobbers). First run after this ships will quarantine any currently-diverged files — that is the correct behavior; review the quarantine once.
- Hash via `sha256sum` (Git Bash provides it); keep the manifest write atomic (temp file + `mv`).

**Files:** scripts/sync-to-active.sh, docs/harness-strategy/README.md, every-surface-checklist.md, memory-rules.md, pr-and-commit-style.md, node scripts/hooks/registration-reconcile.mjs, hooks/src/<name>.ts, hooks/dist/<name>.mjs


### 2026-08-07: Fix: Braintrust SessionEnd hooks cancelled at shutdown
**Key Decisions:**
- Add a `Stop` event containing `braintrust_hooks.py stop`, `timeout: 15000`.
- Remove the `stop` entry from `SessionEnd`.
- Lower `session_end`'s SessionEnd timeout to `5000` — it no longer does network I/O.
- Do not: register on `SubagentStop`. Subagents dominate hook firings on this machine; adding
- `SPOOL_FILE = ~/.claude/state/braintrust_spool.jsonl`.
- SUPERSEDED at implementation by `ccdd14b`: `stop` was KEPT on `SessionEnd` (timeout 30000) as a safety net for an abrupt exit mid-turn, not removed. Only the new `Stop` registration (timeout 15000, both settings.json copies) was added. See the `ccdd14b` entry under `## Completed`.
- ALSO NOT DONE, deliberately: the `session_end` timeout above was left at **10000**, not lowered to 5000 (verified live in both settings.json copies). `session_end` still spawns the detached spool flush, so the reduction buys nothing and risks a cancel. This bullet is a planning note that was never implemented — do not read it as current state.

**Files:** ~/.claude/settings.json, continuous-claude/.claude/settings.json, .claude/hooks/braintrust_hooks.py, .claude/hooks/src/__tests__/braintrust-hooks-shutdown.test.ts, braintrust_hooks.py, sync-to-active.sh

**Verification:** `npx vitest run src/__tests__/braintrust-hooks-shutdown.test.ts` — red before, green after.


### 2026-08-07: Using AI With Structure — build plan for this afternoon's team call
**Key Decisions:**
- Phase 3 — Build (1 agent, then 2 parallel) *
- `deck-builder` — assemble `index.html` from the design system and the slide data.
- `notes-writer` — `speaker_notes.md`, following the brief's talk track.
- Phase 5 — Fix *
- `fixer` — apply confirmed findings. Re-run the three critics' checks.

**Files:** C:\Users\david.hayes\Downloads\call w Ryan.docx, <scratchpad>\ryan-call.txt, ~/.claude/projects/C--Users-david-hayes-continuous-claude/9d208d7e-.../tool-results/artifact-db54f755-1785988397-6a70.html, Projects\ai-enablement-decks\governed-ai-access\index.html, Projects\claude-pricing-presentation\index.html, ~/.claude/CLAUDE.md, ~/.claude/rules/agent-model-selection.md, index.html

**Verification:** Open `index.html` in a browser. Confirm 22 sections render, scroll-snap works,


### 2026-08-05: Session plan — prove the roadmap matcher, then close three open threads
**Key Decisions:**
- A hook fix does not take effect until the NEXT commit.: `dist/*.mjs` reaches the live hook
- Claim a lane: `node scripts/coordination/lane.mjs next`, then `claim <id>`.
- Do not sweep in these 8 pre-existing uncommitted files: (verified unchanged this session;
- `RoadmapAuditRecord` (lines 63–89): add `tool: string` as a **required** field. Required, not
- `appendRoadmapAuditRecord` (373–375) needs no change — it takes a full record.

**Files:** windows-platform.md, settings.json, dist/*.mjs, .git/index.lock, docs/research/youtube/jake-van-clief/_channel.json, scripts/project-cards/state.json, scripts/youtube/state/watchlist.json, ~/.claude/plans/we-are-picking-up-lovely-crab-agent-a95421aa735afc91b.md


### 2026-07-27: Lane-board repair + Agentic OS project identity (data layer)
**Key Decisions:**
- Fix: drop `myId` from the params array, renumber `$4` → `$3`.
- Deliberately NOT fixed: the `WHERE` is `id=$1` with no ownership check, so any session
- `project` ← `.claude/project-registry.json` (19 entries), **`ON CONFLICT DO UPDATE`* —
- Encode the review decision in `confidence`, not in a NULL FK. `confidence` is already
- `note` is non-null wherever `project_key` is null.

**Files:** lane.mjs, apps/agentic-os/scripts/seed-projects.mjs, .claude/project-registry.json, apps/agentic-os/scripts/project-aliases.json, apps/agentic-os/src/server/queries/projects.ts, health.ts, .claude/backups/*.sql, scripts/project-cards/state.json

**Verification:** State plainly in the code comment what this does and does not prove: it proves no row

### 2026-07-26: Wrangle: Current State, Coordination Protocol, and Execution Order
**Key Decisions:**
- Correction: ROADMAP.md *does have a `## Planned` section — 17 items — at **line 243, beneath a 226-line `## Completed` changelog**. `Current Focus` is empty. Several Planned entries stale. `## Notes` preserves six hard gates; **G4 (never parallel-edit the same memory files)* and **G5 (session-id consolidation needs a `file_claims` migration)* both directly constrain this plan.
- Mechanism (traced to exact lines): `SessionStart` is registered with **no matcher**, so it fires for every subagent too. `session-register.ts:34` ignores `input.session_id`, calls `generateSessionId()`, and stomps the single machine-global file `~/.claude/.coordination-session-id`. Meanwhile `heartbeat.ts:62` correctly uses `input.session_id`. So a terminal **claims files under one identity while heartbeating as another**, and the claiming identity's heartbeat is frozen at session start.
- False negative:: past minute five every `s-*` identity is permanently stale, so every conflict resolves as "took over stale lock." **Zero of 8,170 claims are live-owned. The lock has not blocked a real cross-session edit in a long time.**
- Correction to the hooks proposal: its "6 `getSessionId` implementations" framing overstates the coordination impact. Five clones (`guardrail-enforcer.ts:98`, `lib/hook-trace.ts:34`, `shared/logger.ts:72`, `shared/resource-reader.ts:70`, `shared/session-isolation.ts:23`) only pick tmp-state filenames and are **not on the coordination path**. The break is entirely in the `session-id.ts` ↔ `session-register.ts` ↔ `heartbeat.ts` triangle. That makes the fix much smaller than the BACKLOG framing suggests.
- The good news: Claude Code already hands every hook a `session_id` that is distinct per subagent and stable per process tree — exactly the `agent_id` MS-01 planned to build. We don't need a new identity scheme; we need to stop discarding the one we're given.

### 2026-07-25: Planning Session
### 2026-07-24: Simplify CCv3 code-intel: cut Serena + retire dormant codegraph//code-intel facade
**Key Decisions:**
- `C:\Users\david.hayes\.mcp.json` — delete the `"serena"` block (lines ~71-79). Use Node atomic read-modify-write, not the Edit tool.
- Delete `scripts/code-intel.mjs` (the facade — confirmed guidance-only, no callers outside the skill).
- `code-intel-enforcer` hook: delete `.claude/hooks/src/code-intel-enforcer.ts` + its test if present, remove from `settings.json` registration **if registered* (scout: default-OFF, wrong matcher, zero events — verify with `/hook-audit`-style grep of both settings.json copies; settings.json is NOT synced, edit repo + `~/.claude/` copies via Node atomic write). Rebuild hooks (`cd .claude/hooks && npm run build`).
- Leave `shared/intel-bus.ts` and `shared/context-bus.ts` in place (substrate used by other hooks/tests; the `serena_lsp` type field and "serena" label comments are inert). Optional: drop `codegraph-platform-contract.test.ts` (it auto-skips when binary absent, but deleting removes ~7min of potential CI noise).
- Delete `.claude/rules/code-intel-boundaries.md`. Fix its inbound references: `windows-platform.md` (remove/condense the codegraph Phase C section to a one-line historical note), `cli-integration-strategy.md` (remove Serena from the MCP inventory row), `tldr-cli.md` (now unambiguously the symbol-search path — remove any "deprecated for symbol search" language if present).

### 2026-07-21: CCv3 Harness Hardening — Fix the Git-Bash Fork Storm + tldr daemon-warm
**Key Decisions:**
- Issue 1 has two compounding layers: *
- Issue 2: the **Retired* harness SessionStart hook
- Reuse the existing, tested converter:
- iolo stop-and-test: (user's chosen first AV move). Stop `ioloTrayApp` and the iolo
- Lever A dispatcher: (81 hooks → ~9 in-process; permissionDecision-merge risk) and
