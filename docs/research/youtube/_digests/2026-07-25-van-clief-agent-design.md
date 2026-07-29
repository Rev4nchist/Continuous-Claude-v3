---
digest_id: 2026-07-25-van-clief-agent-design
date: 2026-07-25
type: brief
title: "Van Clief's anti-agent thesis is self-disclaimed and unmeasured — his connector arithmetic and negative routing survive"
topic: "agent and connector design"
channels: "Jake Van Clief"
verdict: adopt
videos: 62
citations: 29
corpus_path: docs/research/youtube/jake-van-clief
---

# Van Clief's anti-agent thesis is self-disclaimed and unmeasured — his connector arithmetic and negative routing survive

**Scope.** Full pass over the Jake Van Clief corpus: 67 videos, 62 with transcripts, ~262k
words, ingested 2026-07-25. Question asked: for an engineer designing agents and connectors,
what in this channel changes what you do on Monday? Five threads were searched — the "stop
building agents" thesis, which layer to automate, connectors/tools/MCP, the concrete
alternative he proposes, and failure modes. Thirty findings passed a mechanical citation audit
(every quote grepped back to its transcript line and timestamp); **zero were rejected**. This
brief uses 29 distinct citations across 13 videos; the other 49 transcripts are older
non-technical content (music, business, pre-2025 vlogs) and contributed nothing.

**Out of scope:** his community/course marketing, the ICM paper itself (arxiv 2603.16021, cited
in a video description but not read here), and the psychometrics research the ethics-engine
video is nominally about.

**Quality caveat.** Every transcript is ASR auto-captions. Terms are garbled in places
("customuilt", "chat GBT", "Q management" for queue management). No precise technical claim in
this brief rests on a garbled term — where ASR is mangled, the surrounding sentences carry the
meaning, and the audit notes flagged each instance.

## 1. What he actually argues

The strongest version of his thesis is narrower and better than his titles: **the unit of
composition should be the workspace, not the agent.** Frameworks push you to author one agent
per task — "I need a writing room agent, I need this agent, I need this agent" — and his
counter is to let one runtime "become the agent you need when you're working in the work space"
[vid:MkN-ss2Nl10 @12:14]. Identity becomes a property of *location*, not of a configured
persona.

He explicitly disclaims the maximal reading: "It's not that I'm saying agents suck or that I'm
creating some super structured framework" [vid:0fCQ-4J_jzk @28:50]. The real position is
structure first, complexity later — an escalation ladder, not a ban.

### Demonstrated (he built it, ran it, or took his own shipped system apart)

**The folder system, walked live.** Three-layer routing plus filename conventions declared in
CLAUDE.md, with "zero code, technically speaking, running any sort of Python injection or
framework or database" [vid:MkN-ss2Nl10 @18:18]. The load-bearing artifact is a routing table:
"This right here is the most important pattern in the whole system. It's just a simple table
that tells the AI" — per task, which files to read, which to skip, which skills it may need
[vid:MkN-ss2Nl10 @12:41]. Each workspace carries an ordered internal pipeline as directories:
"Four stages. You have to do a brief, you need a spec, which a specification, a build, and an
output" [vid:MkN-ss2Nl10 @13:33].

**Context as inheritance, not retrieval.** "Claude.md at the root cascades down. Context.md
inside the project layers on top" [vid:hALln9wrrQo @4:02] — by the time the model opens a scene
file it has brand voice, production rules, and shot list, with nothing embedded and nothing
retrieved.

**A full production pipeline on one runtime.** Per-product research, scripts, 11Labs voice,
animation, for a company that commissioned videos from him: "it's all in folders and markdown
files with one agent. One singular agent" [vid:956DPSPX4wg @18:29]. Because state is on disk,
he can close the session mid-pipeline: "All of the process has been saved. All of the context
is in the structure. I don't need to inject it back in at the right time" [vid:956DPSPX4wg
@17:30].

**The connector arithmetic — the single most useful thing in the corpus.** Taking apart his own
shipped ethics engine: "the actual AI calling is maybe 10% of the system volume"
[vid:UGyTimVObus @10:00], with orchestration (async coordination, rate limiting, retry logic,
queue management) around 30% and data processing around 60%. He adds that the ratio generalizes
and that the systems ignoring it are the bad ones.

**A measured failure against one-shot agentic refactor.** Three coding harnesses on his own
long-running research codebase: "None of them successfully were able to completely do what I
wanted in one or two shots" [vid:_rtyhVD4v4A @23:25]. He qualifies it as "within reason" and
notes models got close. The reproducible sub-failure is that models mangle large structured
prompt lists (misplaced or missing quotes → syntax errors), and his conclusion was to stop
automating that step: "There's no point automating and creating all these scripts to try to get
it in there if it's struggling so hard" [vid:_rtyhVD4v4A @16:33].

**A files-instead-of-MCP pattern.** For making a large data set queryable, a semantic layer that
"is essentially just a bunch of folders and files that instead of like a really, you know,
complicated MCP or you know, a whole bunch of tokens trying to describe every single part of the
data set" [vid:30N9gLucrHg @6:05].

**A supply-chain warning, browsed live on a public skills marketplace.** "These are markdown
files, but they could have code or a prompt injection hidden somewhere in here and it might not
notice it" [vid:AZ1l-oaD3tk @11:16] — the agent reads the markdown as instructions and runs
them. He does add that the marketplace is monitored and has good skills on it.

**A promotion threshold from a live client rollout** (spoken by a community member describing a
browser-only Claude deployment at a commercial real-estate firm, which Van Clief endorses):
"100 times in a row, maybe it's an automation. But like right now it's like it's easy enough
that you can go through and review" [vid:ZMDXs59Ntjc @13:05], with human intervention placed at
every layer of the folder structure rather than end-to-end automation.

### Asserted (opinion, prediction, or framing — no measurement shown)

- **The commercial argument for not building orchestration.** An orchestration layer is a
  third-party wrapper the vendor out-builds: "the AI can do it better, faster, and cheaper than
  everyone else who's creating the wrapper in a third party" [vid:0fCQ-4J_jzk @24:03]. His
  referent is his own abandoned project.
- **The durability test.** "Is the thing you just automated going to be builtin feature in 6
  months? Because if it is, you just spent your energy on something with an expiration date and
  not a long one" [vid:SjlCJIU9ODs @7:19], generalized as "The trap isn't AI replacing your job.
  The trap is you investing in automating something that the next model was always going to
  handle on its own anyway" [vid:SjlCJIU9ODs @7:33], with the positive half: invest in "the
  stuff that's specific to your context, your domain knowledge, your client relationships, your
  data" [vid:SjlCJIU9ODs @7:46].
- **A three-way triage before any build.** Per task, per department, "figure out one by one
  where AI actually helps, where traditional tooling is actually better than AI and where you
  just need a person to do it. That process alone is far more valuable than people realize"
  [vid:SjlCJIU9ODs @5:11].
- **The combinatorial case for a connector protocol.** "If every connection is customuilt, you
  have a scaling problem... Every new AI application requires its own connectors to every tool
  it wants to use" [vid:UGyTimVObus @6:14] — integrations grow as applications × tools.
- **Where tool-selection authority belongs.** In his MCP description the model does not call
  APIs directly: "The model does not call APIs directly. The orchestration layer determines what
  tools to use. The MCP client manages the connection and the MCP server translates"
  [vid:UGyTimVObus @8:14].
- **A frequency gate on whether a connector should exist.** Elaborate agent-to-agent
  integrations are often worse than a human moving data, given "a whole bunch of API calls and
  development time and even security issues and just have someone copy and paste something with
  a mouse" [vid:TCYtQ7J0g6A @6:37], grounded in a named client case (an agent pulling Snowflake
  data into a ticket, replaced by uploading a spreadsheet). The "often" is load-bearing — he
  allows that automation may come later.
- **A three-layer maturity ladder.** Layer 1 chat, layer 2 flows, layer 3 flows that generate
  data feeding self-improving systems; "Right now, most people are at layer 1"
  [vid:SjlCJIU9ODs @6:26]. He attributes the widely-cited 80–95% zero-ROI figure to "They're not
  measuring things the right way. There's no progression path and they're just treating AI as
  like this magic thing" [vid:jjV1ckgPzI0 @32:44].
- **Scaling order.** "Start niche, then find the scalability. Everyone tries to find the
  scalability and then niche down" [vid:AZ1l-oaD3tk @45:47] — from workshop Q&A, not prepared
  thesis.
- **The human-in-the-loop argument is throughput, not ethics.** An Engelbart reading: it "took
  30 years until the 1990s that we actually got workflow efficiency from computers because
  everyone was trying to automate human processes, not augmenting them from a collaborative
  aspect. We're hitting the same barrier now with AI" [vid:30N9gLucrHg @43:11].
- **The reframe of the skill itself.** Not what to automate but "when should I offload my
  thinking and when is it more" [vid:ZMDXs59Ntjc @27:15] — which thinking, and in what order.

### The one number, and why it does not count

The sole quantitative support for folder-over-framework is secondhand and unmeasured: people
are "seeing 20, 30, 40% token reduction, and really just getting outcomes a lot faster without
a lot of infrastructure" [vid:956DPSPX4wg @1:46]. No baseline, no method, no benchmark appears
anywhere in the corpus for the folder architecture. Treat it as a hypothesis, not a result.

## 2. Where this cuts against how we build

Being blunt: **this repo is the thing he is describing when he says "I need this agent, I need
this agent."** As of today it carries 37 agent definitions, 150 skills, 111 hook sources, and 46
rules. Several agent clusters are near-duplicates by function — critic / principal-reviewer /
review-agent; arbiter / atlas / sentinel; kraken / spark; debug-agent / sleuth. His critique
lands squarely on that inventory, and we have already conceded the underlying point once: the
Serena and codegraph specialists plus the `/code-intel` facade were cut on 2026-07-24 for
near-zero adoption. That is his argument, executed by us, before we watched these videos.

**But the critique lands less hard than it first appears, for a specific reason.** A Claude Code
agent is not an orchestration framework — it is a markdown context file plus a model tier plus a
context-isolation boundary. That is *already* folders and markdown. His thesis is really about
authored per-task **personas**, and the cost of 37 of them is routing ambiguity and maintenance,
not runtime infrastructure. He is not arguing against isolation; he teaches the harness-native
version of it himself, describing Claude as "Manager of these agents automatically"
[vid:KC0VEZuo4OI @11:06]. So "one singular agent" means one authored runtime with model-native
fan-out — not a rejection of delegation. His titles collapse that distinction; his content does
not.

**Where his evidence is thin, say so.** The efficiency case is one secondhand percentage range
[vid:956DPSPX4wg @1:46]. The 100-runs threshold is doubly hedged ("maybe if we can do it 100
times in a row, maybe it's an automation") and comes from a third party. The "vendor will
out-build your wrapper" claim [vid:0fCQ-4J_jzk @24:03] is unfalsifiable in advance — it is a
prior, not a test, and it would equally have argued against building the hooks layer that has
paid for itself here. The strongest empirical items are the connector ratio
[vid:UGyTimVObus @10:00] and the refactor bakeoff [vid:_rtyhVD4v4A @23:25], and both are n=1 on
his own codebase.

**Where his context differs from ours in a way that matters.** His workloads are single-operator
content production with a human present at every stage — he explicitly wants to "stop it every
step of the way." A meaningful share of our surface is *unattended*: scheduled report pipelines,
watchdogs, cron'd sweeps, where there is no human to interrupt and no copy-paste fallback. His
disk-as-state argument gets *stronger* in that setting (resumability without session memory);
his "just have someone paste it" argument does not apply at all.

**Where he is straightforwardly right about our connectors.** Read our own `codex-worker-safety`
and `grok-worker-safety` rules: they are almost entirely worktree isolation, auth assertion,
model allowlists, quota detection, Windows subprocess quirks, and prompt-file hygiene. The model
call is a single line in the middle. That is his ~10/30/60 split [vid:UGyTimVObus @10:00],
observed independently in our own artifacts. Any connector estimate that budgets for "wire up
the API" is off by roughly an order of magnitude.

**The gap that is genuinely open.** Our CLAUDE.md and skill routing tell an agent what *exists*.
They do not tell it what to *skip*. His routing table is explicitly tri-part — read these, skip
those, you might need these skills [vid:MkN-ss2Nl10 @12:41]. Negative routing is the half we
have not built, and with 46 always-loaded rules plus 150 skills it is the half most likely to
pay.

## 3. Verdicts

| Idea | Verdict | Rationale | Citation |
|---|---|---|---|
| Routing tables need a SKIP column, not only a nav index | **ADOPT** | Our context layer enumerates what exists but has no per-task exclusion. Cheapest, most testable change on this list. | [vid:MkN-ss2Nl10 @12:41](https://youtu.be/MkN-ss2Nl10?t=761) |
| Connector effort is ~10% model call, ~90% plumbing | **ADOPT** | Independently corroborated by our own worker-safety rules. Use it as the default estimate for any new integration. | [vid:UGyTimVObus @10:00](https://youtu.be/UGyTimVObus?t=600) |
| Frequency gate before an integration exists at all | **ADOPT** | A cheap pre-build question we do not currently ask; `cli-integration-strategy.md` starts at "how", not "whether". | [vid:TCYtQ7J0g6A @6:37](https://youtu.be/TCYtQ7J0g6A?t=397) |
| Position-addressed context: root cascades, local layers on top | **ADOPT** | Already how CLAUDE.md hierarchies work; his framing makes it a deliberate design choice rather than a default. | [vid:hALln9wrrQo @4:02](https://youtu.be/hALln9wrrQo?t=242) |
| Pipeline state on disk so a fresh session resumes mid-run | **ADOPT** | Matches handoffs and `.ralph/state.json`; strengthens the case for extending it to unattended pipelines. | [vid:956DPSPX4wg @17:30](https://youtu.be/956DPSPX4wg?t=1050) |
| Checkpointed multi-turn over one-shot agentic refactor | **ADOPT** | n=1 but consistent with our review-gate and worktree-patch posture; argues against fire-and-forget delegation. | [vid:_rtyhVD4v4A @23:25](https://youtu.be/_rtyhVD4v4A?t=1405) |
| Route a data class around the model when it reliably corrupts it | **ADOPT** | A clean stop rule: repair scaffolding can cost more than the manual path. | [vid:_rtyhVD4v4A @16:33](https://youtu.be/_rtyhVD4v4A?t=993) |
| Vet third-party skills as executable supply chain | **ADOPT** | We have `vet-skill`; his framing argues for making it pre-install rather than post-install. | [vid:AZ1l-oaD3tk @11:16](https://youtu.be/AZ1l-oaD3tk?t=676) |
| Collapse near-duplicate authored agents toward one runtime | **WATCH** | The direction is right and we already cut Serena/codegraph, but a 37→N rewrite needs invocation telemetry first, not a thesis. | [vid:MkN-ss2Nl10 @12:14](https://youtu.be/MkN-ss2Nl10?t=734) |
| Tool selection belongs in deterministic orchestration, not model free-choice | **WATCH** | Directly tensions our design, where the model picks skills and tools and hooks are the deterministic guard. Worth testing on high-blast-radius connectors only. | [vid:UGyTimVObus @8:14](https://youtu.be/UGyTimVObus?t=494) |
| Markdown semantic layer instead of an MCP server for read-mostly data | **WATCH** | Plausible and cheap to pilot on one data source; no comparison against an actual server is shown. | [vid:30N9gLucrHg @6:05](https://youtu.be/30N9gLucrHg?t=365) |
| "Don't automate what the next model ships in ~6 months" | **WATCH** | Useful as a question to ask out loud; unfalsifiable as a rule, and it would have argued against infrastructure here that has paid off. | [vid:SjlCJIU9ODs @7:19](https://youtu.be/SjlCJIU9ODs?t=439) |
| Three-layer maturity ladder as a diagnostic | **WATCH** | Coarse, and we already run a self-improvement loop that is his layer 3. Useful mainly as stakeholder vocabulary. | [vid:SjlCJIU9ODs @6:26](https://youtu.be/SjlCJIU9ODs?t=386) |
| "100 times in a row" as an automation threshold | **SKIP** | Doubly hedged, offhand, spoken by a third party. Adopt promotion-by-evidence; do not adopt the number. | [vid:ZMDXs59Ntjc @13:05](https://youtu.be/ZMDXs59Ntjc?t=785) |
| 20–40% token reduction from folder routing | **SKIP** | Secondhand, no baseline, no method. If selective loading is worth building, measure it here against load-everything. | [vid:956DPSPX4wg @1:46](https://youtu.be/956DPSPX4wg?t=106) |
| "Stop building AI agents" as literal guidance | **SKIP** | He disclaims it himself; taking the title at face value would misread the source. | [vid:0fCQ-4J_jzk @28:50](https://youtu.be/0fCQ-4J_jzk?t=1730) |
| "The vendor will out-build your orchestration layer" as a build/skip rule | **SKIP** | A prior dressed as a test, generalized from one abandoned project of his own. | [vid:0fCQ-4J_jzk @24:03](https://youtu.be/0fCQ-4J_jzk?t=1443) |

## 4. Integration sketch (ADOPTs only)

**1. Add negative routing to the context layer.** Today `skill-rules.json` and CLAUDE.md answer
"what exists". Add a per-task-class read/skip manifest so a doc edit does not pull 46 rules and
a connector change does not pull the frontend skills. Concretely: a small table keyed by task
class (doc / hook / connector / report / frontend) with `read:` and `skip:` lists, authored in
the root CLAUDE.md and enforced by the existing router hook rather than by new code. Measure
before/after context size on ten representative prompts — this is also the honest test of the
20–40% claim we just marked SKIP [vid:MkN-ss2Nl10 @12:41] [vid:956DPSPX4wg @1:46].

**2. Put an existence gate at position 0 of `cli-integration-strategy.md`.** That rule currently
opens with a decision tree for *how* to integrate. Prepend three questions: how often will this
actually run; is it read-mostly (if so, try files/markdown before a server); and is a person
moving this data today at acceptable cost. A connector that fails all three does not get built
[vid:TCYtQ7J0g6A @6:37] [vid:30N9gLucrHg @6:05].

**3. Re-baseline connector estimates at 10/30/60.** When scoping any new integration or worker,
budget roughly one unit for the model call, three for orchestration (retries, rate limits,
queueing, timeouts), and six for data handling and parsing. Our Codex and Grok worker rules are
the internal proof; use them as the reference shape for the next one [vid:UGyTimVObus @10:00].

**4. Extend disk-as-state to unattended pipelines.** Handoffs and `.ralph/state.json` already do
this interactively. The scheduled pipelines are where a resumable on-disk stage marker pays most,
because there is no human to re-inject context after a failure. One stage-marker file per
pipeline run, written before each stage, read on resume [vid:956DPSPX4wg @17:30].

**5. Make `vet-skill` a pre-install gate.** Treat a downloaded skill as executable supply chain,
not documentation: scan for embedded code and instruction-shaped content before it lands in the
skills tree, not after [vid:AZ1l-oaD3tk @11:16].

**6. Instrument agent invocations before touching the roster.** The 37-agent question is a
WATCH, not an ADOPT, precisely because we lack per-agent call counts and differentiated-outcome
data. Add that telemetry now so the next roster decision looks like the Serena/codegraph cut
(evidence-led) rather than a thesis-led rewrite [vid:MkN-ss2Nl10 @12:14].

## 5. Sources

| Video | Uploaded | Track | Key timestamps |
|---|---|---|---|
| I Charged $2000 For This AI Lecture (And I Underpriced It) | 2025-10-14 | failure modes | [32:44](https://youtu.be/jjV1ckgPzI0?t=1964) |
| One of These AI Coding Tools Failed Completely (You Won't Guess Which) | 2025-12-01 | failure modes | [16:33](https://youtu.be/_rtyhVD4v4A?t=993) · [23:25](https://youtu.be/_rtyhVD4v4A?t=1405) |
| From Nazi Psychology to AI Auditing: Inside the System I Built | 2026-02-04 | connectors / MCP | [6:14](https://youtu.be/UGyTimVObus?t=374) · [8:14](https://youtu.be/UGyTimVObus?t=494) · [10:00](https://youtu.be/UGyTimVObus?t=600) |
| The Ladder That Explains Every AI Failure (And How to Avoid Them) | 2026-02-26 | which layer to automate | [5:11](https://youtu.be/SjlCJIU9ODs?t=311) · [6:26](https://youtu.be/SjlCJIU9ODs?t=386) · [7:19](https://youtu.be/SjlCJIU9ODs?t=439) · [7:33](https://youtu.be/SjlCJIU9ODs?t=453) · [7:46](https://youtu.be/SjlCJIU9ODs?t=466) |
| Watch Me Build Something Claude Code Can't Do Yet | 2026-03-03 | thesis (counter-signal) | [11:06](https://youtu.be/KC0VEZuo4OI?t=666) |
| Stop Building AI Agents. Use This Folder System Instead. | 2026-03-10 | thesis / alternative | [12:14](https://youtu.be/MkN-ss2Nl10?t=734) · [12:41](https://youtu.be/MkN-ss2Nl10?t=761) · [13:33](https://youtu.be/MkN-ss2Nl10?t=813) · [18:18](https://youtu.be/MkN-ss2Nl10?t=1098) |
| Why I Stopped Building AI Agents and Started Using Claude Cowork | 2026-03-21 | thesis | [24:03](https://youtu.be/0fCQ-4J_jzk?t=1443) · [28:50](https://youtu.be/0fCQ-4J_jzk?t=1730) |
| The Real Skill in AI: Knowing What Not to Automate | 2026-04-19 | which layer to automate | [13:05](https://youtu.be/ZMDXs59Ntjc?t=785) · [27:15](https://youtu.be/ZMDXs59Ntjc?t=1635) |
| How I Run Creative, Software, and Business Work as One System | 2026-04-28 | alternative | [4:02](https://youtu.be/hALln9wrrQo?t=242) |
| Afternoon Tea #2: Stop Building Production-Ready AI. Solve for One Client First | 2026-04-29 | connectors / failure modes | [11:16](https://youtu.be/AZ1l-oaD3tk?t=676) · [45:47](https://youtu.be/AZ1l-oaD3tk?t=2747) |
| You're Automating The Wrong Layer (How 30,000 People Build AI Without Frameworks) | 2026-05-20 | thesis / which layer | [1:46](https://youtu.be/956DPSPX4wg?t=106) · [17:30](https://youtu.be/956DPSPX4wg?t=1050) · [18:29](https://youtu.be/956DPSPX4wg?t=1109) |
| 200 to 48,000 YouTube Subscribers in Four Months (Afternoon Tea Session 5) | 2026-05-27 | connectors | [6:37](https://youtu.be/TCYtQ7J0g6A?t=397) |
| Afternoon tea: Why Humans Belong in the Compute Layer | 2026-06-27 | connectors / which layer | [6:05](https://youtu.be/30N9gLucrHg?t=365) · [43:11](https://youtu.be/30N9gLucrHg?t=2591) |
