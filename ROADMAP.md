# Project Roadmap

## Current Focus
_(none — set with /roadmap focus)_

## Fable Follow-ups — parked backlog (gated behind the trap harness)
Not started; the organized parking spot so they aren't lost. Both build on the Fable harvest and are gated by `docs/fable-manual/TRAP-TESTS.md` (arm B must beat arm A). Full detail: memory `fable-intelligence-and-agent-model-policy-followup`.
- **A — Targeted per-surface Fable injection.** Encode high-leverage Fable frameworks INTO specific agents/skills where a MEASURED gap justifies it (contract-writing → game-plan/workroom/worker agents; verify-by-re-derivation → critic/review-agent/principal-reviewer; risk = cost × lateness → premortem/aegis). NOT always-on — that debate is settled by the `no_lift` data. Depends on `docs/fable-manual/HIGH-LEVERAGE.md`.
- **B — Per-agent model + effort policy.** Agents carry explicit `model: opus|sonnet`, but effort is ONE global `settings.json effortLevel` applied uniformly. Want an agent → model → effort matrix (mechanical `spark` low-effort; deep `sleuth`/`principal-reviewer` high/xhigh). Scope: audit tiers, determine the Task-spawn mechanism (Workflow `agent({effort})` can tune per-call; Task-spawn can't natively), add a drift-guard. Anchors: `.claude/rules/agent-model-selection.md`, `check-agent-model-drift.mjs`.

## Codex Integration — /codex worker (parallel track)
- **v0 SHIPPED (2026-07-07):** `/codex` write-capable Codex task worker (ask / implement / resume, on the ChatGPT subscription, no API key). PR #15 (`feature/codex-worker`), commit `12a21dd`. Built from an 8-agent research pass, dogfood-hardened, hooks-collision safety spike RESOLVED.
- **v1 SHIPPED (2026-07-07):** (A) session-id capture (`thread_id` → concurrency-safe `resume <id>`, live-verified vs `--last`); (B) startup latency via `--ignore-user-config` (~47s→18s, MCP-fails 6→2 — the planned `--profile-v2` overlay was empirically REFUTED); + telemetry one-row-per-turn/enum cleanups. Dogfood-hardened: a cross-model `codex-adversary` pass caught 2 real shell bugs (spaced-path/delimiter parsing + a `"last"` silent-failure), both fixed. Commit `832ce5a`. Evidence: `docs/codex-integration/DESIGN-RESEARCH.md` §11.
- **v2 SHIPPED + MERGED to `main` (2026-07-07, PR #16, merge commit `2918259`):** approved **lean scope** built + dogfood-hardened. (1) `--complex` opt-in multi_agent (explorer.toml `gpt-5.5` pin gate, mode-scoped ask/implement; live probe: explorer spawned on gpt-5, ZERO gpt-4.1), (2) reactive usage-limit handling (preflight impossible — no quota surface; parser verified on the real error), (3) worktree GC (skip-dirty + exit-code-checked, no recursive delete, 7d default), (4) doc sweep. **Plus a CRITICAL v1 regression fix surfaced by dogfooding:** `--ignore-user-config` silently broke ALL `implement` writes on Windows (`config.toml` carries the sandbox write policy) → now `ask`-ONLY (confirming re-dogfood: implement writes again). Four review passes (Claude audit 8 + codex-adversary 4 + live probe + 2 dogfoods), every finding fixed + verified. Evidence: `DESIGN-RESEARCH.md` §12; CodeRabbit review addressed (PR #16). Enhancement candidates tracked in the v3 line below.
- **v3 BACKLOG (deferred 2026-07-07 — address later):** none blocking — all are premortem enhancement candidates: `subagents_spawned`/`subagent_models` telemetry (today's `multi_agent` field records fan-out ENABLED, not spawned), version+hash-keyed `--complex` re-verification (guards against a Codex CLI upgrade silently reintroducing the gpt-4.1 fallback), a local burn-rate heuristic before expensive implement/`--complex` runs, split-shell fail-loud for `--complex`, and a keep/resume GC sentinel. Full detail: `docs/codex-integration/DESIGN-RESEARCH.md` §12.

## Completed
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
- [x] feat(codex): /codex worker v1 — robust resume + --ignore-user-config latency + telemetry cleanups (dogfood-hardened) (2026-07-07) `832ce5a`
- [x] feat(codex): /codex Codex task worker v0 — ship + dogfood-harden + safety-spike (PR #15) (2026-07-07) `12a21dd`
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
- [x] docs(st-05): fold Codex premortem into design (v2 hardened) + go-decision (2026-06-29) `b67e5c2`
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
- [x] review(wf3): Fable-5 deep review COMPLETE — 190 confirmed findings + ratifiable 4-tier backlog + 2 Codex cross-model passes (2026-06-12) `f143e5b`
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
- [x] fix(codex-adversary): clean findings capture via -o; silence config noise (2026-06-01) `4febb8d`
- [x] docs(codex): verify CLI repair, reconcile version + auth claims (2026-06-01) `11f99ca`
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
- [x] Deeper Claude+Codex Adversarial Collaboration (Repair → Envoy Pilot) (2026-05-22)
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
- [x] Integrate `openai/codex-plugin-cc` into CCv3 (2026-04-15)
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
- [ ] P2 — Verify embedding daemon survives a REAL reboot (scheduled task only ad-hoc-verified; Codex flagged job-object detach). After next restart confirm `~/.claude/run/ccv3-embedding.json` appears <60s + warm recall (medium priority)
- [ ] P2 — Ops: full parallel `vitest run` hangs on a pre-existing Windows daemon/socket suite — add a hard per-test timeout (medium priority)
- [ ] P3 — Ops: async post-commit forward-sync race leaves active hook dist stale — hash-verify + `cp` after every hook commit until root-fixed (low priority)

## Notes
**CCv3 Hardening — durable pointers (preserved across planning per `bf91c19`):**
- Full handoff for the implementing session: `docs/ccv3-hardening-handoff-2026-05-30.md`
- Lean audit: `docs/ccv3-lean-audit-2026-05-30.md` · v3 design: `~/.claude/plans/we-have-recently-done-refactored-storm.md` · Codex raw: `.claude/cache/agents/codex-adversary/latest-output.md`
- **The 6 hard gates (do not violate):** G1 sync-fix-structural-before-WS2-hooks · G2 finish-UPS-prune-before-Phase-A · G3 injection-fix-before-agent-recall · G4 never-parallel-edit-the-same-memory-files (the May-2026 regression pattern) · G5 session-id-consolidation-needs-file_claims-migration · G6 skill-archive-cross-check-vs-Phase-B.5.
- Data note: use `count(*)` not `pg_stat` for usage calls (the latter mis-reported memory/PageIndex as empty). Live counts: archival_memory 569, pageindex_nodes 2418, file_claims 6720, sessions 1117.

## Recent Planning Sessions
### 2026-07-24: Simplify CCv3 code-intel: cut Serena + retire dormant codegraph//code-intel facade
**Key Decisions:**
- `C:\Users\david.hayes\.mcp.json` — delete the `"serena"` block (lines ~71-79). Use Node atomic read-modify-write, not the Edit tool.
- Delete `scripts/code-intel.mjs` (the facade — confirmed guidance-only, no callers outside the skill).
- `code-intel-enforcer` hook: delete `.claude/hooks/src/code-intel-enforcer.ts` + its test if present, remove from `settings.json` registration **if registered* (scout: default-OFF, wrong matcher, zero events — verify with `/hook-audit`-style grep of both settings.json copies; settings.json is NOT synced, edit repo + `~/.claude/` copies via Node atomic write). Rebuild hooks (`cd .claude/hooks && npm run build`).
- Leave `shared/intel-bus.ts` and `shared/context-bus.ts` in place (substrate used by other hooks/tests; the `serena_lsp` type field and "serena" label comments are inert). Optional: drop `codegraph-platform-contract.test.ts` (it auto-skips when binary absent, but deleting removes ~7min of potential CI noise).
- Delete `.claude/rules/code-intel-boundaries.md`. Fix its inbound references: `windows-platform.md` (remove/condense the codegraph Phase C section to a one-line historical note), `cli-integration-strategy.md` (remove Serena from the MCP inventory row), `tldr-cli.md` (now unambiguously the symbol-search path — remove any "deprecated for symbol search" language if present).

**Files:** thoughts/shared/handoffs/agentic-os/2026-07-24_08-39_serena-evaluation.yaml, docs/self-improvement/proposals/2026-07-04-code-intel.md, 2026-07-16-code-intel.md, C:\Users\david.hayes\.mcp.json, C:\Users\david.hayes\.codex\config.toml, continuous-claude/.serena/memories/cross_tool_workflow.md, scripts/code-intel.mjs, .claude/hooks/src/code-intel-enforcer.ts

**Verification:** Fresh Claude Code session: `mcp__serena__*` tools absent from the deferred-tool list; `Get-CimInstance Win32_Process -Filter "name='serena.exe'"` shows no new serena.exe spawned by the new session.

### 2026-07-21: CCv3 Harness Hardening — Fix the Git-Bash Fork Storm + tldr daemon-warm
**Key Decisions:**
- Issue 1 has two compounding layers: *
- Issue 2: the **Codex* harness SessionStart hook
- Reuse the existing, tested converter:
- iolo stop-and-test: (user's chosen first AV move). Stop `ioloTrayApp` and the iolo
- Lever A dispatcher: (81 hooks → ~9 in-process; permissionDecision-merge risk) and

### 2026-07-20: Plan — Make the Reports Hub "Report pages" table trustworthy + root-cause the live failures
**Key Decisions:**
- Preserve the `missing` (watchdog miss-row) and `no runs` / `unscheduled` verdicts unchanged.
- Also apply the same per-cadence maxAge in `check-drift.mjs`: so the standalone `/reporting status` drift check stops false-flagging the 3 weekly types (currently reports "3/6 in drift"). Keep `DEFAULT_MAX_AGE_HOURS` as the daily default; add an optional `maxAgeHoursByType`/cadence override consumed by both `computeDrift` callers.
- Reuse (do not reinvent): `SCHEDULE`, `computeCandidate`/`nextExpectedDeadline` already encode cadence — the map is the minimal change; the `computeCandidate`-precise alternative (is the newest genuine row the currently-expected period's row?) is noted as a future tightening, not required now.
- Reuses the existing `notionPageUrl` helper and `REPORT_CHILD_PAGES` (already in scope). This satisfies the chosen "live artifact, fallback to child page — never blank" behavior. The Report-name column already links to the child page; the Artifact column now deep-links to the real artifact when one exists and degrades to the page otherwise.
- Result: `make-run` no longer throws, the upsert runs, a **genuine row lands* (superseding the watchdog miss), and the Artifact cell shows a working link. Keep the emit block non-fatal, but add a `Log` line that make-run **succeeded* vs skipped so a future emit regression is visible in the dated log rather than silent.

### 2026-07-18: Unified Session Plan — Merge the two workstreams, make the Self-Improvement loop visible & actionable
**Key Decisions:**
- Reporting efficiency/optimization: — Phase 1 shipped & pushed (`bc19ef2`, `9090e0f`, `9ff3414`, `7fcee47`); Phase 2 (batched STDIN bind + meaning-based hash-gates) + a spec'd ROADMAP-guard hook fix remain. Plan `~/.claude/plans/mellow-enchanting-zebra.md`; handoff `thoughts/shared/handoffs/reporting-efficiency/2026-07-17-phase1-shipped-phase2-next.md`.
- Self-improvement loop: — a daily 7:30am Task-Scheduler job (`CCv3-Self-Improvement-Research`) researches one component and writes a proposal `.md`. **The problem Dave hit: the loop's output is invisible.* The Reports Hub "Self-Improvement Research" row shows Artifact = "—" (no report linked), and an anchor on the hub is broken.
- The two workstreams actually converge. The self-improvement "no report" symptom is a *reporting-registry bug, and its fix (give proposals a real hosted URL) is the same artifact Dave wants for triage. One build closes both.
- "No report in Notion" / Artifact = "—":: `run-research.ps1:100-107` passes a **local repo path* (`docs/self-improvement/proposals/<date>-<component>.md`) as `--artifactUrl`. Since proposal 08 (`62ff375`, 2026-07-17) `make-run.mjs` `buildRun()` **hard-rejects any non-`http(s)` URL* → throws exit 1 → `upsert.mjs` never runs → **no registry row is written at all**. The visible row is stale (pre-08). Confirmed in `.claude/logs/self-improvement/2026-07-18.log:19`: `make-run emitted no path (exit=1) -- skipping upsert`.
- Broken anchor: `…#39576fd7ac8281d6be38000ce9bbd794` = the shared **"All Report Runs — by Type (hub)"* linked-view block (`reportRunsViews` in `report-runs.ids.json`), NOT Self-Improvement-specific. It was appended headless with no owning heading and was plausibly swept up by one of the 3 racing hub writers doing a heading→end-of-page splice. Repo can't confirm live Notion state — needs a live read to recreate.

### 2026-07-15: /init-project Review + Hardening Plan
**Key Decisions:**
- Interview → CLAUDE.md: — auto-scan (package.json/README/configs/git), confirm with user, fill 8-section template from `references/claude-md-template.md`
- ROADMAP.md: — created with user's current focus
- Sentry: (conditional, deploy targets) → **7. E2E scaffold* → **8. dev-server scripts* (conditional web) → **9. summary**
- Hook table at bottom: all names verified real in dist except "memory-extraction" (actual family: `pre-compact-extract`, `session-end-extract`, `periodic-extract`)
- P1 — would cause a wrong outcome on the next run: *
- Normalize schema: in BOTH `continuous-claude/.claude/project-registry.json` and `~/.claude/project-registry.json` to the project-registry skill's schema: `name, path, stack[] (array), description, port, url, devCommand, status` (+ keep optional extras `github`, `deploy`, `kind`, `notes`, `sentryProject`, `linearTeam`). Convert the 7 string-stack entries to arrays; add missing `description` fields; make the two files byte-identical (repo ordering wins).
- Add `project-registry.json` to forward sync: edit `scripts/sync-to-active.sh` to copy `.claude/project-registry.json` → `~/.claude/`, and add a row to `rules/sync-known-gaps.md`.
- Rewrite init-project Phase 5: write the REPO copy (`~/continuous-claude/.claude/project-registry.json`) using the array schema, then run `bash ~/continuous-claude/scripts/sync-to-active.sh` (or copy both). Keep the port-conflict check, sourcing ports from the registry itself.
- `references/dev-server-pattern.md`: delete the static port list; replace with "derive used ports from `~/.claude/project-registry.json` at run time; assign next free 3xxx."
- `rules/dev-server-cleanup.md` + `rules/project-registry.md`: replace/trim their static tables the same way (keep 2–3 rows as *examples*, marked as examples, or point at the JSON). Prevents this class of rot permanently.
