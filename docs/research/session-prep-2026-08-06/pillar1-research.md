## Pillar 1 — Research → Decisions

### The read

**The read.** Three lanes converged without coordinating: verification is moving from post-build review to standing structure the builder cannot touch — gates authored before work starts, scheduled rubric-grading over live traffic, and how often a system checks its own work as the readiness measure. The 13-role business test is the Fourth asset implicated: it should run on a schedule against live alpha traffic, not only at build time.

`Confidence:` medium — broad design consensus, little measurement.
`Would change this read if:` one week of D-7's scheduled grading files nothing the 13-role suite did not already catch.
`Strongest case against it:` every scheduled-loop row is one solo founder's self-report, and the loudest voices for standing verification sell it (Factory, Vercel).

25 talks ingested, 24 reviewed at depth (denominator, not progress) → 5 decisions: 0 adopt · 5 pilot · 0 escalate · 7 watch · 2 set aside. New build asked for: an agent-consumable docs bundle on the portal (D-10). New spend: none. Evidence rows: 3 D · 8 R · 0 A.

Every decision below is NEXT. Research produces decisions; a badge upgrades when the change is in a connector, the harness, or the portal.

### The docket

| # | Workstream → artifact | Verdict | Basis |
|---|---|---|---|
| D-7 | Salesforce connector → 13-role rubric on live traffic | **PILOT** | R |
| D-8 | Salesforce connector → connector call logs | **PILOT** | R |
| D-9 | NetSuite connector → planning decision map | **PILOT** | D (2 maps) |
| D-10 | Developer portal → connector API docs bundle | **PILOT** | D (1 case) |
| D-11 | Internal harness → pre-build validation gate | **PILOT** | D (1 case) |

### Carried forward

The 08-05 report was skipped (`no-new-source-data`); no 07-30 checkpoint outcome is recorded. Every line is due.

- **D-1 ESCALATE** ordered write path — slipped: escalated to Carly, no recorded decision, kickoff status unrecorded — ask Dave.
- **D-2 ESCALATE** portal tool-catalog security gate — slipped: owner unassigned, chained to Christian's open portal question — ask Dave.
- **D-3 ADOPT** third answer state in the 13-role test — slipped: no implementation trace — ask Dave.
- **D-4 PILOT** five-question live-trace audit — slipped: checkpoint missed, no artifact; D-8 consumes its logs — ask Dave.
- **D-5 ADOPT** confirm-first gate audit — slipped: no artifact, known gaps live — ask Dave.
- **D-6 PILOT** skill-registry eval/owner/version fields — not yet due (~08-13); first step shows no start.
- **07-30 Held at the cap (four items — A9 miscount):** #1 carded as D-8; #2 one-open-PR ceiling dropped, loop discipline bounds it; #3 one-reasoner dropped, double-counts one talk; #4 graph-traversal boundary dropped, no consumer.
- **Shelf trigger:** "re-resolve printed figures" fires at NetSuite kickoff — unrecorded, ask Dave.

### Decisions

**D-7 · Salesforce connector → 13-role rubric over live alpha conversations · PILOT · NEXT · extends**

The 13-role test can grade every real alpha conversation daily and file an issue for each one that scores below the bar.

`Change:` one scheduled pass grades a day of live alpha conversations against the rubric; below-threshold results auto-file issues.
`Evidence:`
- `R` a production team grades every real chat daily on a rubric; below-score chats spawn a fix session, ~3 fixes a day, self-reported [vid:vJEy3nP2_C8 @33:28, @33:56, @34:24]
- `R` their morning watchdog summarizes paid-customer events with live-UI links; a couple of defects, per the speaker, found only that way [vid:vJEy3nP2_C8 @30:43, @32:39]

`Weakest link:` one solo-founder shop, all self-reported, no baseline against ordinary review.
`Wrong if:` alpha traffic is low enough that a human reading every conversation is cheaper.
`Cost:` days · owner David · checkpoint 08-13.

**D-8 · Salesforce connector → redundant-call check on connector call logs · PILOT · NEXT · extends**

A right answer reached through dozens of redundant calls is cost and latency the current test scores as a pass.

`Change:` a log-side check for repeated identical tool calls and no-progress loops, fed by the D-4 trace audit's logs.
`Evidence:`
- `R ⓥ` Arize report their own agent looping and not recognising done — failures their fixed-rubric judges missed [vid:q2JrUKBMf0w @2:59, @3:14]
- `R` Uber's precondition: log the whole orchestration flat so single cases can be inspected [vid:31GUkCBD-Uc @6:25, @6:56]

`Weakest link:` lost its strongest non-vendor row in 07-30 verification; no one has shown a trajectory check catching an answer-check miss.
`Wrong if:` two weeks of logs show no redundant-call pattern above noise.
`Cost:` days · owner David · checkpoint 08-20.

**D-9 · NetSuite connector → the planning epic as a decision-ticket map · PILOT · NEXT · new**

NetSuite planning decisions become tracked tickets with blocking order, so Christian's architecture review can trace why each call was made.

`Change:` run one NetSuite planning epic as typed decision tickets; the spec links back to each ticket.
`Evidence:`
- `D (2 maps)` real repo maps on screen: 12 decision sub-issues under one, 14-of-17 resolved with blocking relationships on another [vid:F3lL98Pj90o @4:30, @4:43, @9:10]
- `R` specs stay dense and link to primary-source tickets [vid:F3lL98Pj90o @10:53, @11:08]

`Weakest link:` proves the artifact stays current for its author; no throughput evidence.
`Wrong if:` the map costs more upkeep than the decisions it surfaces.
`Cost:` hours · owner David · checkpoint NetSuite kickoff.

**D-10 · Developer portal → agent-consumable docs bundle for the Salesforce connector API · PILOT · NEXT · new**

The portal's first reader may be a customer's coding agent — vendors now ship docs the agent reads and integrates from directly.

`Change:` ship one agent-readable docs/skill bundle for the connector API; kill if no external coding agent uses it within an agreed window.
`Evidence:`
- `D (1 case) ⓥ` on stage a coding agent read docs shipped in the node package, made a working connection, queried it [vid:eD8pV7nSIxY @8:27, @8:41, @9:10]
- `R ⓥ` a one-command plugin (skills + MCP server) so Claude Code/Cursor "knows exactly the structure" [vid:m8VC2SV2igM @7:11, @7:50]
- `R` non-vendor: a practitioner's agents execute against agent-consumable playbooks on a schedule [vid:vJEy3nP2_C8 @25:42, @25:56]

`Weakest link:` both primary rows are Vercel-commercial; no external-adoption numbers.
`Wrong if:` Fourth's external developers integrate only through humans reading reference docs.
`Cost:` days · owner David · checkpoint 08-20.

**D-11 · Internal harness (game-plan) → validation gate written before the build · PILOT · NEXT · new**

The reviewer model writes the pass/fail gate before the build starts, so a connector milestone cannot pass on the builder's own claims.

`Change:` on one connector milestone the reviewer authors the gate first; fails loop back to the builder.
`Evidence:`
- `D (1 case)` the gate, written while the builder idled, ran twice on screen — failed before the build existed, all checks passed after [vid:AQl5Q-0l7FQ @5:14, @5:56, @6:06]
- `R` the builder is barred from editing the gate file; fails re-loop as feedback [vid:AQl5Q-0l7FQ @23:18]

`Weakest link:` a toy-problem demo; nobody showed gate-first catching a defect build-then-test would miss.
`Wrong if:` the pre-written gate catches nothing the existing post-build review does not — added latency, not added review.
`Cost:` hours · owner David · checkpoint 08-13.

### Set aside, shelved, confirmed

- **WATCH (09-03)** — framework-native safety: tool-layer approvals and a first-class eval API in the box; all vendor [vid:eD8pV7nSIxY @13:31, @18:48].
- **WATCH (09-03)** — tri-model hardening: pin reviewer effort below ultra; halt loudly on mid-run auth death [vid:zXZkuFxpwL0 @18:25, @17:13].
- **WATCH (09-03)** — last30days-style sentiment sweep vs opencli; kill by one opencli-plus-synthesis run [vid:ShYfGB3x5mM @1:09, @1:34].
- **WATCH (NetSuite kickoff)** — description layer over ERP-scale schemas; R-only, vendor-run [vid:NWyTsKTKka8 @47:29].
- **WATCH (trigger: four-figure cloud-labeling corpus; watcher David)** — local bulk labeling: 9 TB, 48,000 clips → 12 MB searchable text, free, ~2 days on a Mac Mini [vid:mme027WZhgo @3:50, @8:09, @9:12].
- **WATCH (trigger: replication on one Fourth doc set; watcher David)** — folder-catalog navigation, first D, all vendor-run [vid:NWyTsKTKka8 @32:33, @56:20].
- **WATCH (09-30)** — post-training cost floor: ≈$131 LoRA on a 1T open model ⓥ ⚠asr [vid:kxstlfc8Lw4 @19:47]; ~$50K frontier RL narrated [vid:V-EDrhIhHzQ @32:12].
- **Confirms, no action (2):** a 15-year ML firm states the chassis thesis back [vid:ezRtp6K6zwE @30:25, @32:33]; file-based context reported surviving ~2 years of model swaps [vid:NWyTsKTKka8 @51:10].
- **Held at the word cap (this week):** PILOT an hours-level Herdr workroom-visibility trial ⚠asr [vid:neK8ydl0Vlk @6:19, @8:14]; PILOT a chassis validation-density audit [vid:wpOA-UXynoM @12:23]; PILOT an endpoint-swap drill after a two-week frontier-access suspension [vid:wgdxSCsmS-Q @50:35]; PILOT an endpoint-interception eval [vid:V-EDrhIhHzQ @22:07]; PILOT a named-smell vocabulary in the review skill [vid:A8mokin_YOs @7:13, @7:37].

### Not counted

1 ingested talk not reviewed at depth (n0VhIVtviC0). ~30 further segments failed relevance or well-known — counted, not titled. **Excluded on the ASR rule:** open-weight benchmark placements [vid:DAKnynuGyy4]; token-economics figures [vid:vJEy3nP2_C8 @34:57]; vendor autonomy percentages [vid:wpOA-UXynoM @18:13]; a GPT-5.6 benchmark recap [vid:zXZkuFxpwL0]. **Pending:** 4 X-post bookmarks uncaptured; nothing claimed from them.

### Standing notes

**Grades.** `D` demonstrated: shown or counted on stage, size in brackets; one shown case establishes a failure mode exists, never its rate. `R` reported: the speaker describes what their team runs, or a mechanism on slides. `A` asserted: opinion, prediction, framing, or roadmap. `ⓥ` the speaker's employer sells the thing in that row; a `ⓥ` row never carries a decision alone.
**Gate.** ADOPT needs one D, or two independent R with at least one non-vendor, plus reversibility inside a week. PILOT needs one D or R plus stated kill criteria. An A-only finding caps at WATCH. ESCALATE keys off authority, not evidence strength, provided the basis is stated.
**Never evidence.** View counts, likes, applause, hand-raises, how many talks covered a theme, speaker seniority, speaker's employer.
**ASR.** All transcripts are auto-captions. Names and product spellings come from each talk's published description, not the captions; technical terms are paraphrased, never quoted. Instructive instance: one transcript renders one model name as "Kimiko 3", "Qwen 1.5 3", and "Gemini K3" [vid:DAKnynuGyy4] — its benchmark claims are excluded above.
