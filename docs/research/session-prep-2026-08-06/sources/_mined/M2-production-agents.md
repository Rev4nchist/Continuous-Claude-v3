# M2 — Production agent frameworks & agent-reliability practice (mined 2026-08-05)

Lane: production agent frameworks + reliability practice. Corpus: 5 videos (Cole Medin m8VC2SV2igM, Vercel workshop eD8pV7nSIxY, AI Engineer/Factory wpOA-UXynoM, Jake Van Clief/NLP Logix ezRtp6K6zwE, Greg Isenberg/Ryan Carson vJEy3nP2_C8). All transcripts are auto-captions; proper nouns (Eve, Droid, Devin, Untangle, Grace, Agent Forge) taken from titles/descriptions, never captions. Overlaps with the 2026-07-30 docket are flagged as extends/confirms D-n, not re-mined.

## CANDIDATES

### C-1 · Developer portal → agent-consumable docs/skill bundle for the connector API

**Claim:** Platforms now ship agent-readable docs and skills inside their SDK/plugin so a customer's coding agent can integrate against the platform without the developer reading docs — the portal's first "reader" may be an agent, not a human.
**Fourth artifact:** developer portal (complementary to 07-30 D-2's security gate — that gates inbound tools, this shapes outbound docs).
**Suggested verdict:** PILOT (ship one agent-consumable docs bundle for the Salesforce connector API; kill if no external coding-agent integration uses it within an agreed window).
**Evidence:**
- `D (1 case) ⓥ` live on stage, a coding agent asked to "add an OpenAPI connection" went straight into the docs Vercel ships inside the node package and produced a working connection file — audience watched the agent read in-package docs and then queried the new data source successfully [vid:eD8pV7nSIxY @8:27, @8:41, @9:10]
- `R ⓥ` Vercel ships a plugin (skills + MCP server) so Claude Code/Cursor "knows exactly the structure" and can scaffold, run, and deploy an agent from one prompt; installed with a single command [vid:m8VC2SV2igM @7:11, @7:23, @7:50] — sponsored video, treated as commercial
- `R` non-vendor corroboration of the shape: a practitioner maintains "playbooks" — agent-consumable procedure docs distinct from skills — that his cloud agents execute against on a schedule [vid:vJEy3nP2_C8 @25:42, @25:56]
**Weakest link:** both primary rows are Vercel-commercial (employees on stage; the Medin video is a disclosed partnership); the non-vendor row is adjacent (operational playbooks, not SDK docs). No one showed external-developer adoption numbers.
**Wrong if:** Fourth's external developers integrate through humans reading reference docs and no customer coding agent ever fetches the bundle — then this is packaging effort with no consumer.

### C-2 · Shared chassis / harness → approval gates and eval-gated deploys are now framework primitives (confirms 07-30 D-5)

**Claim:** The newest open agent framework ships tool-layer human approvals, eval suites as deploy gates, and a no-direct-egress channel contract as in-the-box primitives — the chassis' safety floor should match what frameworks now give away free.
**Fourth artifact:** shared connector chassis + internal harness. **Extends/confirms 07-30 D-5** (confirm-first in tools, not prose); do not re-ship as new.
**Suggested verdict:** WATCH (Eve as a reference design for chassis runtime patterns; adopting the framework itself is not on the table this week).
**Evidence:**
- `D (1 case) ⓥ` a mutate tool marked `requires approval` was blocked until a human clicked allow in Slack; audience saw the approve/deny buttons and the query run only after approval [vid:eD8pV7nSIxY @13:31, @13:49; vid:m8VC2SV2igM @14:40, @14:50] — Medin row is sponsored
- `R ⓥ` the channel contract: the agent has no direct Slack access at all; the channel is a deterministic contract mapping agent events to the surface, so the agent cannot post anywhere on its own [vid:eD8pV7nSIxY @23:15, @23:32, @23:46]
- `D (1 repo) ⓥ` evals as a first-class primitive: the framework's own public test suite is built on its eval API (deterministic checks + LLM-as-judge), shown on GitHub during the workshop [vid:eD8pV7nSIxY @18:48, @19:10, @20:05]
- `R ⓥ` evals positioned as a deploy gate — green checks before an agent update ships [vid:m8VC2SV2igM @4:32, @4:43]
**Weakest link:** every row is Vercel-commercial or Vercel-sponsored; nothing measured, no failure rates, and the live demo hit two unexplained tool-call failures on stage [vid:eD8pV7nSIxY @5:43, @7:06].
**Wrong if:** Fourth's chassis already enforces all three (tool-layer approvals, eval-gated release, mediated egress) — then this row is corroboration for D-5's carried-forward line, not a new WATCH.

### C-3 · Chassis / NetSuite build → agent-readiness = density of deterministic validation loops

**Claim:** An enterprise agent vendor scores codebases on "agent readiness" — how many deterministic validation loops (linters, type checks, tests, scans) exist — and holds that long-running agent output quality is directly proportional to validation density.
**Fourth artifact:** shared chassis repo before the NetSuite build; internal harness/eval practice.
**Suggested verdict:** PILOT (score the chassis repo's deterministic-check coverage before NetSuite kickoff; kill if the audit finds coverage already at the level the build needs).
**Evidence:**
- `R ⓥ` agent readiness defined as a measure of how many deterministic validation loops are present; with a high volume of feedback loops, agents operate longer on more complex tasks without human intervention [vid:wpOA-UXynoM @12:23, @12:35, @12:47]
- `R ⓥ` quality of long-running harness output described as directly proportional to the degree the work can be validated; "if you can frame any problem as the set of verification systems that need to validate it, you can solve that problem with AI today" (paraphrased) [vid:wpOA-UXynoM @13:00, @14:33]
- `R ⓥ` the ceiling is verification, not the model: their own core harness cannot be autonomously maintained because visual defects (e.g. flickering) lack validators, while a contained internal legal workflow is close to fully autonomously maintained [vid:wpOA-UXynoM @18:57, @19:10, @19:23]
- `R` independent, non-vendor echo: a solo founder's browser-test loop (record video → agent reviews its own video → files fixes) is a validation loop bolted on precisely where deterministic checks end [vid:vJEy3nP2_C8 @26:32, @26:48]
**Weakest link:** all Factory rows are vendor-reported mechanism (nothing measured in front of the audience), and Factory sells the remediation; the training-reward rationale [vid:wpOA-UXynoM @15:59] is theory, not evidence.
**Wrong if:** connector-chassis work is small-surface enough that agent session length never exceeds what the 13-role test already validates — then check density buys nothing NetSuite needs.

### C-4 · Salesforce connector → scheduled rubric-grading of live conversations with auto-filed fixes

**Claim:** A production team runs a daily automation that grades every real agent conversation against a rubric and spawns a fix session for anything below threshold, plus a daily "production watchdog" summarizing all customer events with links into real UI.
**Fourth artifact:** Salesforce connector (alpha) — extends the 13-role test from a point-in-time suite to a standing loop over live traffic. **Extends 07-30 D-3/D-4** (third answer state; live trace audit).
**Suggested verdict:** PILOT (one scheduled pass: grade a day of live alpha conversations against the 13-role rubric, auto-file anything below threshold; kill if a week of grading files nothing the existing test didn't catch).
**Evidence:**
- `R` daily automation grades the paralegal agent's real chats on a rubric; anything below score kicks off a child session that opens a fix PR; speaker reports shipping roughly three such fixes a day [vid:vJEy3nP2_C8 @33:28, @33:56, @34:24]
- `R` production watchdog: every morning an automation summarizes all production events for paid customers into a JSON digest surfaced in admin, with per-customer links into the live UI — several defects found only by eyeballing the linked sessions [vid:vJEy3nP2_C8 @30:43, @32:10, @32:39]
- `R` the same team's scheduled end-to-end signup test (3×/week, browser-driven) exists because the automated test suite alone missed production breakage [vid:vJEy3nP2_C8 @26:14, @28:31, @28:47]
**Weakest link:** one solo-founder shop, self-reported, no baseline for what the rubric loop catches that ordinary review would not; the "three a day" figure is self-reported and unverifiable.
**Wrong if:** alpha traffic volume is too low for a scheduled loop to beat manually reading every conversation — at small n, a human pass is cheaper and stricter.

### C-5 · Chassis write path → no standing production write credentials in agent environments

**Claim:** A practitioner running 5–10 concurrent cloud agents keeps all production write keys outside every agent environment; write credentials are injected by a human per-operation at approval time.
**Fourth artifact:** chassis write path before NetSuite (a write-heavy connector). **Extends 07-30 D-1** (ordered commit path) and D-5 (confirm-first): credential absence enforces the gate structurally rather than by policy.
**Suggested verdict:** WATCH (fold into the D-1 chassis-scope conversation; single-practitioner R, and plain least-privilege is near the "well-known" line).
**Evidence:**
- `R` prod write keys live only in a password manager; agents are never given them; "production writing is dangerous... your agents will do something bad" (paraphrased), so the agent must ask and the human pastes the key into the session for that operation [vid:vJEy3nP2_C8 @5:26, @5:43, @5:56]
**Weakest link:** one person's habit, one evidence row, no incident data; the differentiating step (credential injected at approval time, not merely approval required) may not survive multi-tenant service architecture.
**Wrong if:** the chassis write path already brokers credentials server-side per-call — then this is implemented and belongs in D-1's carried-forward line, not on the docket.

### C-6 · Chassis strategy → independent corroboration that the shared platform IS the product (confirms, no action)

**Claim:** A 15-year ML services firm argues the invisible 80% — governance, monitoring, runtime, guardrails — is the real production system, and builds one shared company platform so every agent solution lives under the same monitoring, model access, and policy rather than per-solution infrastructure.
**Fourth artifact:** shared connector chassis — this is Fourth's chassis/mold pattern stated back independently.
**Suggested verdict:** SET ASIDE (confirms shipped strategy; independent corroboration, no new work — not counted as progress).
**Evidence:**
- `R ⓥ` the 80/20 framing: the demoable agent is ~20% of effort; governance, monitoring, runtime, databases, and observability are the 80% that makes it operable [vid:ezRtp6K6zwE @30:25, @31:47, @32:04]
- `R ⓥ` their platform is exactly that 80% built once at company level: all future solutions live on one platform, monitored the same way, with the same tool and model access and the same policies [vid:ezRtp6K6zwE @32:33, @32:48, @33:18]
- `A ⓥ` demo-vs-production gap named as security first: who has access to the agent, what the agent can reach, why it chose a tool, validation loops, guardrails — none of it visible in a demo [vid:ezRtp6K6zwE @37:03, @37:21]
**Weakest link:** all rows from a firm selling the platform (Agent Forge); nothing demonstrated.
**Wrong if:** n/a — a confirmation carries no action; if the chassis pattern were failing internally, outside corroboration would not rescue it.

## NOT COUNTED

- Isenberg/Carson "everyone is a manager of agents", cloud VMs vs local dev, working from the phone, pin-your-threads cadence [vid:vJEy3nP2_C8 @10:09–24:07] — fails relevance: general workflow advice, no Fourth artifact.
- Carson token economics: "$20k last month", "~$5k/month per employee", "$5/session", model-routing claims [vid:vJEy3nP2_C8 @34:57–36:22] — ASR-excluded: number-bearing, captions mangle the model name ("SUI 1.7"), and the per-employee figure is a prediction (A), not a report.
- Carson's PR-count screen (22–40/day) [vid:vJEy3nP2_C8 @17:32] — activity count, not evidence of anything Fourth-relevant; near the never-evidence line.
- Carson "don't build your engineering on a frontier-lab stack; independent agent labs optimize your cost" [vid:vJEy3nP2_C8 @36:49–37:37] — A-only opinion bearing on our harness choice; well-known lock-in argument, no checkable condition offered; caps at WATCH and doesn't earn the slot.
- Factory autonomy figures ("15 to 20% ... autonomy ratio in the upper 80%") [vid:wpOA-UXynoM @18:13–18:27] — ASR-excluded: number-bearing, captions self-conflicting on what each figure denotes.
- Factory "maybe 87% less likely to hit a bug" [vid:wpOA-UXynoM @9:17] — a hypothetical spoken with "maybe", not a measurement; excluded.
- Factory forward-deployed-engineering org model, Epcot/theme-park analogy, hiring pitch [vid:wpOA-UXynoM @2:08–4:35, @16:38–20:49] — fails relevance: org design for a vendor, no Fourth artifact.
- Factory air-gapped Droid deployments [vid:wpOA-UXynoM @7:56–8:11] — R ⓥ, fails relevance: Fourth has no air-gap requirement on the docket.
- NLP Logix agent-definition debate, vibe-coding definitions, 60/30/10 rule, Engelbart 1962 [vid:ezRtp6K6zwE @5:43–17:28] — fails relevance (definitional/philosophical) and well-known.
- NLP Logix AWS→Azure one-parameter swap [vid:ezRtp6K6zwE @43:53–44:13] — R ⓥ, fails relevance: multi-cloud portability is not on any current Fourth artifact.
- NLP Logix "use an agent only where a decision on input is needed; deterministic flow → script" [vid:ezRtp6K6zwE @28:18–28:34] — well-known fails; already Fourth practice.
- Eve stateless-harness-on-Workflow-SDK architecture, pricing, multi-tenant memory [vid:eD8pV7nSIxY @28:18–33:00, @36:57] — interesting fails: no Fourth decision hangs on Vercel's internals this week.
- Carson X-reputation-building segment [vid:vJEy3nP2_C8 @41:18–43:41] — fails relevance.

## LANE READ

The lane converged from three unrelated directions — a framework vendor, an enterprise agent vendor, and a solo operator — on the same move: reliability work is migrating out of prompts and answers into standing structure around the run (tool-layer approval gates, eval-gated deploys, validation-loop density, scheduled rubric-grading of live traffic). That extends the 07-30 read rather than replacing it: last docket moved the check onto the run; this corpus shows the check becoming *scheduled infrastructure* that files its own fixes. The genuinely new signal for Fourth is C-1: platform vendors now write docs for the customer's coding agent first and the human second — which is a portal-shaping claim, not a harness one.
