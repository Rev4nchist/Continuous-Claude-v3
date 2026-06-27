# Project Roadmap

## Current Focus
**Reporting System — Document It + Make It Flow Better (2026-06-27)**
- **End goal — "one spine, two cuts":** every reportable unit of work → exactly one Weekly Work Tracker row (`Source`-tagged); the team dashboard + sponsor site are two filtered views of that single spine. Reporting quality is a *capture* problem, not a rendering problem.
- **Orient here:** read `docs/reporting-system/` (README → CURRENT-STATE → PLAN → RESOURCE-MAP) + the handoff `docs/HANDOFF-2026-06-27-reporting-system.md`.
- **Open gate:** `ai-reporting` MCP is registered (`~/.mcp.json`) but pending a `NOTION_TOKEN` (Dave) → the team dashboard is down until it's set + Claude Code restarted. **Next build:** make the FourthOS scheduled run log to the Tracker (PLAN Step 3).
- Branch **`snapshot/reporting-system`** off `main`; push **`fork`** (Rev4nchist), never `origin`. Windows-safe (git via PowerShell).
- Started: 2026-06-27

## Completed
- [x] docs(reporting): orientation library (`docs/reporting-system/`) + handoff + ROADMAP — reporting-system snapshot packaging (2026-06-27) *(this packaging commit)*
- [x] feat(reporting): Code reporting skill + reporting-system docs + fourthos-weekly pipeline (2026-06-27) `6592d46` → cherry-picked `e886f93` onto `snapshot/reporting-system`
- [x] chore(reporting): registered `ai-reporting` MCP in `~/.mcp.json` (stdio, `${NOTION_TOKEN}`) + import smoke test — pending Notion token (2026-06-27)
- [x] feat(decks): reporting-system doc deck + FourthOS sponsor site v2/v3 published to `ai-enablement-decks` (GitHub Pages) — `7aff251`, `3a1c501`, `52e5a52` (2026-06-24→27)
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
- [ ] CCv3-Hardening — Session 9: through Phase C (codegraph) (high priority)
- [ ] P2 — Verify embedding daemon survives a REAL reboot (scheduled task only ad-hoc-verified; Codex flagged job-object detach). After next restart confirm `~/.claude/run/ccv3-embedding.json` appears <60s + warm recall (medium priority)
- [ ] P2 — Ops: full parallel `vitest run` hangs on a pre-existing Windows daemon/socket suite — add a hard per-test timeout (medium priority)
- [ ] P3 — Ops: async post-commit forward-sync race leaves active hook dist stale — hash-verify + `cp` after every hook commit until root-fixed (low priority)
- [ ] WS-2 Phase B activation: facade/enforcer shipped INERT — wire real routing-through-facade + enforcement teeth, then Phase C (codegraph) → D (memory bridge, needs GIN index) → E (observability) (medium priority)
- [ ] CCv3 Full Hardening & Improvement Program — make the system lean, correct, and *used-correctly* (high priority)
- [ ] WS-0 — Present-day bugs + live hazards: session-id consolidation (0.1, +`file_claims` migration), memory prompt-injection fix (0.2), structural sync-footgun fix (0.3 — delete `npm run build` from `sync-to-active.sh`), stale-Ralph `ccv3-visualization` deactivation (0.4), knowledge-tree regen (medium priority)
- [ ] WS-1 — Lean prune/consolidate: per-prompt hot-path (P1), memory reliability + agent-recall activation (P2), dedup/dead-code + Neon-token security (P3), enforcement-docs fix (medium priority)
- [ ] WS-2 — v3 Cohesive Intelligence substrate: Phase A foundations (context-bus) → B facade (`/code-intel` CLI) → C codegraph → D memory bridge (needs GIN index) → E observability (medium priority)
- [ ] Hygiene gate (early): verify `architecture-stats-sync` hook registered/built/synced; triage scratch files; push 5 commits to `fork` (medium priority)
- [ ] Scope decision (next session): full v3 arc vs Phase 0+A (recommended) vs Phase 0 only (medium priority)

## Notes
**CCv3 Hardening — durable pointers (preserved across planning per `bf91c19`):**
- Full handoff for the implementing session: `docs/ccv3-hardening-handoff-2026-05-30.md`
- Lean audit: `docs/ccv3-lean-audit-2026-05-30.md` · v3 design: `~/.claude/plans/we-have-recently-done-refactored-storm.md` · Codex raw: `.claude/cache/agents/codex-adversary/latest-output.md`
- **The 6 hard gates (do not violate):** G1 sync-fix-structural-before-WS2-hooks · G2 finish-UPS-prune-before-Phase-A · G3 injection-fix-before-agent-recall · G4 never-parallel-edit-the-same-memory-files (the May-2026 regression pattern) · G5 session-id-consolidation-needs-file_claims-migration · G6 skill-archive-cross-check-vs-Phase-B.5.
- Data note: use `count(*)` not `pg_stat` for usage calls (the latter mis-reported memory/PageIndex as empty). Live counts: archival_memory 569, pageindex_nodes 2418, file_claims 6720, sessions 1117.

## Recent Planning Sessions
### 2026-06-10: CCv3 Fable-5 Deep Review — "Hone to Elegance" (2026-06-10)
**Summary:** > Supersedes the session-9 execution plan that previously lived in this file (completed SUCCEEDED 2026-06-07; durable record: `docs/ccv3-session9-completion-2026-06-07.md` + ROADMAP).

**Key Decisions:**
- User decisions (locked): (1) **merge PRs #8/#9/#10 first* — review one unified main; (2) **whole-system scope, recent-weighted* (extra depth on the 145 commits since the 2026-05-16 memory-upgrade era); (3) deliver **report + ratified backlog + quick-wins executed* this arc (structural refactors are a later ratified arc).
- Push **`fork`* (Rev4nchist), never `origin`. Never change BGE model/dim (`BAAI/bge-large-en-v1.5`, 1024).
- The review is READ-ONLY: — no fixes during discovery/verification/synthesis. Fixes happen only in Phase 4 (quick wins) after ratification.
- Windows-safe commands (array-arg spawns, `Remove-Item -LiteralPath`, no brace expansion). **Never run the full parallel vitest suite* (known hang on a Windows daemon/socket suite) — no test execution during the review at all.
- Gates G4 (no parallel edits to memory files), G5 (WS-0.1 blocked), G6 (P3 archive cross-check) remain binding for the fix arc.

**Files:** docs/ccv3-session9-completion-2026-06-07.md, .claude/hooks/src/*.ts, .claude/settings.json, .claude/docs/architecture/quick-ref/hook-catalog.md, docs/architecture/system-visualization/architecture.json, ~/.claude/plans/we-have-recently-done-refactored-storm.md, store_learning.py, architecture.json

**Verification:** WF-0: harvest tables exist + row counts sane; exclusion manifest + inventories committed to the review dir.

### 2026-06-06: CCv3-Hardening — Session 9 (reconciliation + P1 bus-bias)
**Key Decisions:**
- Step 0 repo reconciliation DONE: herd-fix PR #8 opened; 7 logical reconciliation commits on `chore/session9-reconciliation` (PR #9); 4 junk stderr-artifact files deleted; `.codex/` mirror + `tools/PerfView.exe` gitignored; leading-# memory-eval doc renamed + inbound ref fixed.
- P1 bus-bias hybrid-recall lift: **KEEP ENABLED** (user-ratified). Verified warm gate +7.3% top-score / flat 69% hit-rate (n=13, corpus 584); read-only PASS. The documented +33.6%/63->88% does NOT reproduce (stale snapshot; repr-only ~+14.5% matches the original +15.3%, diluted to +7.3% by the 5 STRONG cases). Deferred: tune focus-term weighting. Memory id 79da5d25.
- Two live-hazard findings flagged for follow-up (out of this push's scope): (a) a `store_learning.py` invocation with unquoted shell metacharacters creates junk files under `opc/` (one regenerated mid-session); (b) the `post-plan-roadmap` hook clobbered this Current Focus with a foreign project's goal (Salesforce/FastMCP plan `abstract-coral`) — the cross-project contamination guard did not catch it; this entry restores the correct session-9 record.

### 2026-06-05: Planning Session
### 2026-06-04: Fix BGE embedding-daemon `ping_failed` → warm hybrid quality-gate re-run
**Key Decisions:**
- Branch off `main`: `feature/embedding-daemon-ping-fix`. Push target is `fork`, never `origin`.
- Do NOT kill the live daemon casually (model reload is ~30-45s). Capture current discovery file first.
- Run the reproduce one-liner (from `$CLAUDE_OPC_DIR`):
- Single-shot ping in isolation (expect to SUCCEED, proving the daemon is fine when idle):
- Reproduce under load: fire several `recall_learnings.py` / direct `embed` calls concurrently while pinging, to

### 2026-06-03: Planning Session
