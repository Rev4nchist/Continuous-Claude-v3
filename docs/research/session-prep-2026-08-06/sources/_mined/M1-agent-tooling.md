# M1 — Claude/agent tooling & skills workflows (miner output)

> Lane: Dave's bookmarked agent-tooling videos (Pocock skills, Chase AI, IndyDevDan, Kacper, RoboNuggets).
> Relevance anchor: Fourth's own harness and eval practice; the connector-build workflow.
> All transcripts are ASR auto-captions. Proper nouns below come from titles/descriptions, never captions.

## CANDIDATES

### C1 — Cross-model validation gate written BEFORE the build

**Claim:** A validator model writes an executable pass/fail gate script before the builder model starts, the builder cannot edit the gate, and fails loop back as feedback — a delta over Fourth's build-then-review game-plan ordering.
**Fourth artifact:** game-plan / workroom pipeline (Codex-reviewer role); one connector milestone as the trial.
**Suggested verdict:** PILOT
**Evidence:**
- `D (1 case)` live demo: builder agent idles while the other model writes a validation script with per-check fail messages; the work had not started yet [vid:AQl5Q-0l7FQ @5:14, @5:29, @5:42]
- `D (1 case)` the gate ran twice on stage: an initial run failed (no file yet), the post-build run showed all checks passing [vid:AQl5Q-0l7FQ @5:56, @6:06]
- `R` because the speaker owns the harness, the builder is barred from editing the gate file; fails re-loop to the builder [vid:AQl5Q-0l7FQ @23:18]
- `R` the companion /fusion step reports consensus, divergence, and what was discarded between two models' answers — shown once on a toy question [vid:AQl5Q-0l7FQ @3:21, @3:35, @4:20]
**Weakest link:** both demos are toy problems (a library listing, a bulk-insert benchmark); nobody showed gate-first catching a defect that build-then-test would have missed.
**Wrong if:** on a real connector milestone the pre-written gate catches nothing the existing post-build Codex review does not — then it is added latency, not added review.

### C2 — Decision-ticket planning maps for multi-session work (Wayfinder pattern)

**Claim:** Big foggy work is planned as an issue-tracker map of typed decision tickets (research / prototype / grilling / task) with blocking relationships; resolutions write back to the parent map, and the final spec links to each decision's primary source.
**Fourth artifact:** NetSuite connector planning; Fourth's plan/handoff practice (specs today are lossy summaries of the session that produced them).
**Suggested verdict:** PILOT
**Evidence:**
- `D (2 maps shown)` real repo maps on screen: one map with 12 decision sub-issues, another at 14-of-17 resolved with blocking relationships between decisions [vid:F3lL98Pj90o @4:30, @4:43, @9:10]
- `D (1 case)` a resolved decision ticket's outcome written back up to the parent map, shown in the tracker [vid:F3lL98Pj90o @4:58]
- `R` the stated fix for the spec-as-summary weakness: Wayfinder specs stay dense and link back to the original decision tickets, so an agent can consult the primary source [vid:F3lL98Pj90o @10:53, @11:08]
- `R` scoping rule: work plannable in one session is planned in one session; the map is only for fog-of-war scale [vid:F3lL98Pj90o @11:50]
- `R` ticket types defined in the tracker itself — research runs AFK in a sub-agent, prototype for "how should it behave", grilling for decisions, task for real-world chores [vid:F3lL98Pj90o @7:43, @7:56, @8:46]
**Weakest link:** the maps demonstrate that the artifact exists and stays current for the author; no evidence anyone else's throughput improved, and Fourth's Ralph/plan-agent stack already covers part of this.
**Wrong if:** a NetSuite planning epic run as a decision map costs more upkeep than the decisions it surfaces — then handoff docs already do the job.

### C3 — Interview skills self-answer their own questions; separate facts from decisions and gate the exit

**Claim:** Interview-style planning skills fail two ways in the wild — the agent grills itself, and the session ends straight into implementation; the fixes are a facts-vs-decisions distinction and an explicit user-confirmation gate.
**Fourth artifact:** Fourth's discovery-interview / grilling-style skills; extends prior docket D-3 (confirm-first gates — same failure class: the model satisfies a checkpoint by itself).
**Suggested verdict:** PILOT
**Evidence:**
- `R` users across models reported grilling sessions ending and proceeding directly to implementation; a "do not enact until I confirm" gate was added [vid:A8mokin_YOs @3:04, @3:14]
- `R` the self-grilling failure was reported "especially with Fable"; the fix distinguishes facts (found by exploring the code base) from decisions (only the user can make), and the author reports far fewer complaints since [vid:A8mokin_YOs @3:27, @3:40, @3:53]
**Weakest link:** all self-reported by the skill author from user complaints; no counts, no before/after measure, and his fix is prompt prose — the class of gate the prior docket found bypassable.
**Wrong if:** an audit of Fourth's interview skills shows they already separate facts from decisions and hold the exit gate — then this is confirmation, not work.

### C4 — Named refactoring-smell vocabulary makes agent code review actionable

**Claim:** Listing classic named code smells (one sentence each) in a review skill leads the agent to name and fix them, because the vocabulary is deep in model priors — about ten lines of prompt.
**Fourth artifact:** /review and code-review skill in Fourth's harness.
**Suggested verdict:** PILOT
**Evidence:**
- `R` the author added ~10 lines naming smells (duplicated code, feature envy, data clumps, message chains, etc.); the agent repeats the term back and fixes it; two weeks of personal use reported as strongly useful [vid:A8mokin_YOs @7:13, @7:37, @7:49]
- `R` in the full workflow the review skill falls back to these classics when a repo documents no coding standards [vid:M6mYodf0dJM @15:32]
- `R` supporting rationale for review in fresh-context sub-agents: the writing agent is a poor critic of code it just wrote [vid:M6mYodf0dJM @15:43]
**Weakest link:** one author's self-report, no shown review transcript or defect counts; the third row is a design Fourth already runs.
**Wrong if:** two weeks of Fourth reviews with the vocabulary added surface no finding the current critic pass missed — then it is redundant prompt weight.

### C5 — Agent-forward terminal multiplexer makes headless cross-model runs visible (Herdr)

**Claim:** An open-source, Windows-capable multiplexer shows per-agent state (working / needs input / done), persists sessions as a server across terminal exits, and can render normally-headless Claude↔Codex exchanges in visible panes.
**Fourth artifact:** workroom / tri-model harness operations — Fourth has documented pain with headless runs that stall with zero output.
**Suggested verdict:** PILOT
**Evidence:**
- `D (1 case)` live demo: a Claude→Codex plan-review exchange that normally runs headless was spawned into a visible pane, the Codex critique and "revised" verdict readable in real time [vid:neK8ydl0Vlk @6:19, @7:40, @7:52]
- `D (1 case)` persistence shown: terminal closed mid-work, agents kept running as a background server, session reattached [vid:neK8ydl0Vlk @8:14, @8:26]
- `R` agent-state sidebar distinguishes running / needs-input / done across harnesses; runs on Windows and Mac; an agent-facing skill lets agents open their own panes [vid:neK8ydl0Vlk @1:56, @2:07, @6:49]
- `A` positioning: like the Claude Code agent view but for any harness combination [vid:neK8ydl0Vlk @9:49; vid:BY3N8hYOCr4 @0:13]
**Weakest link:** one creator's demo on a friendly setup; no evidence it survives Fourth's PowerShell/MSYS environment or long tri-model sessions. Product name is caption-mangled (Herder/Hurder); spelling taken from the video description ⚠asr.
**Wrong if:** it fails to run Fourth's Windows shell stack, or workroom visibility turns out not to change any operator decision — then it is a toy, drop after an hours-level trial.

### C6 — The three-model roster with builder-never-grades is now commodity; two operational lessons transfer

**Claim:** An independent practitioner runs Fourth's shipped pattern (Claude plans, Grok builds, a third model reviews; disk-file handoffs; builder never grades its own work) and surfaced two operational lessons: cap the reviewer's effort mode, and design for silent auth expiry mid-run.
**Fourth artifact:** game-plan / workroom skill (corroboration of shipped design plus two cheap hardening items).
**Suggested verdict:** WATCH (confirms shipped design; the auth-failover and reviewer-effort items can fold into existing workroom work)
**Evidence:**
- `R` two standing rules: the model that builds never reviews its own work, and the fixer's fixes are checked by the other two models [vid:zXZkuFxpwL0 @6:36, @6:46, @6:57]
- `R` every handoff is a file on disk, not chat memory; a contract file updates phase to phase [vid:zXZkuFxpwL0 @6:07, @6:18]
- `D (1 case)` full run shown end-to-end: working app from an empty folder in about an hour, verified milestone by milestone, the app exercised on screen [vid:zXZkuFxpwL0 @20:03, @22:31]
- `D (1 case)` reviewer in sub-agent-spawning ultra mode ballooned review to tens of minutes for 3 of 11 fix groups; the author demotes review to the non-ultra tier [vid:zXZkuFxpwL0 @18:25, @18:36]
- `D (1 case)` a silent auth expiry occurred live mid-run; the skill halted and named the dead session instead of silently switching models, with an explicit pre-authorized failover path [vid:zXZkuFxpwL0 @12:39, @17:13, @17:21]
**Weakest link:** one run, one author, self-declared "testing phase"; the ~$1 build-cost figure could not be confirmed on his own usage dashboard and is not used here.
**Wrong if:** Fourth's workroom already detects mid-run auth death and already pins reviewer effort — then nothing here is new and the row is pure corroboration.

### C7 — Multi-platform sentiment sweep as a middle tier between web search and deep research (last30days)

**Claim:** A skill that scrapes ~8 social/dev platforms in parallel with deterministic scripts, ranks findings by cross-platform repetition, and synthesizes a brief occupies a useful middle ground for research sweeps — but overlaps Fourth's existing opencli adapters.
**Fourth artifact:** Pillar 1 research tooling inside Fourth's own harness (borderline relevance — flagged for synthesis).
**Suggested verdict:** WATCH
**Evidence:**
- `D (1 comparison)` same prompt run with and without the skill, both reports on screen: the plain web-search report reads as article summaries; the skill's report pulls dozens of items per platform including comment-level sentiment [vid:ShYfGB3x5mM @1:09, @1:34, @1:44]
- `R` mechanism: query rewrite, parallel platform hits via deterministic Python scraping, ranking by repetition across platforms, ~5-minute runs [vid:ShYfGB3x5mM @5:27, @5:38, @7:13]
- `R` cost self-reported at roughly ten cents per run, the X scrape being the only paid source [vid:ShYfGB3x5mM @4:06]
**Weakest link:** the comparison is qualitative, chosen by the presenter, one topic; Fourth's opencli already covers the same platforms with browser-session auth, so the unproven delta is only the synthesis/ranking layer.
**Wrong if:** one Fourth research question run through opencli plus a synthesis prompt matches the skill's output — then there is nothing to install.

## NOT COUNTED

- [vid:6jNuGP5SdCM] Scroll World animated-websites skill (36s short) — fails relevance: no bearing on connectors, portal, or harness.
- [vid:3D8R4pjXvG0] CLI Proxy API trick (34s short) — fails relevance/governance: exposing subscription accounts as an API contradicts Fourth's subscription-auth safety rules; A-only.
- [vid:M6mYodf0dJM @10:33] "smart zone ~140k / attention degradation" — A-only opinion, number-bearing, and already internalized in Fourth's context-budget practice; well-known fails.
- [vid:zXZkuFxpwL0 @1:40–@2:48] GPT-5.6 benchmark recap — ASR-excluded: vendor-reported percentage claims (e.g. terminal-bench scores) with high caption mangle risk on the figures; also never-evidence-adjacent (vendor's own numbers).
- [vid:AQl5Q-0l7FQ @14:13–@14:30] claimed 300x / 250–10,000x insert speedups — excluded: figures are the models' own in-run claims, not measured evidence; number-bearing with ASR risk.
- [vid:A8mokin_YOs @14:57; vid:M6mYodf0dJM @0:00; vid:ShYfGB3x5mM @0:37] star counts and download counts throughout — never evidence (popularity).
- [vid:M6mYodf0dJM] install/setup walkthrough content — tutorial mechanics, no decision for Fourth beyond what C3/C4 already carry.
- [vid:neK8ydl0Vlk @1:33–@2:19] tmux/zellij comparison framing — well-known category; only the agent-state and headless-visibility deltas counted (C5).

## LANE READ

The practitioner lane has stopped arguing about which model wins and converged on the same architecture Fourth already ships: multi-model rosters where the builder never grades its own work, with disk-file handoffs. The frontier inside that consensus is moving to *when* verification is authored — gates written before the build by a model that cannot be overruled by the builder — and to making planning state durable outside the session (decision-ticket maps, primary-source-linked specs) instead of trusting lossy spec summaries. The repeated failure being engineered against is the same one Fourth's prior docket named: an agent satisfying a checkpoint by itself.
