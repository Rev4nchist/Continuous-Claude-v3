## Pillar 1 — Research → Decisions

### The read

**The read.** Two lanes now, not one. The first is unchanged: verification is moving from post-build review to standing structure the builder cannot touch. The second is new and lands closer to home — the AI Engineer Forward Deployed Engineering track argues that customer-integration work is product strategy, not delivery, and that its whole value is the moment bespoke work becomes self-serve. Fourth's connector programme is that motion, run without that discipline: connectors are built one customer at a time, and no threshold exists at which one becomes a platform capability. Decagon named theirs at the 25th bespoke integration, which they describe as too late.

`Confidence:` medium — the verification lane is broad design consensus with little measurement; the FDE lane is many practitioners telling structurally identical stories, none with throughput numbers.
`Would change this read if:` one week of D-7's scheduled grading files nothing the 13-role suite did not already catch, or the connector roadmap already names a productization trigger.
`Strongest case against it:` FDE talks are conference war stories, retold by people whose careers the frame flatters. The counter-talk in the same track argues the role is so overloaded it means nothing [vid:Byv311hdoHE @2:41].

**Corpus correction.** The 08-05 pass reported 25 talks. The AI Engineer channel had been ingested but barely mined — 22 talks on disk, 4 ever cited. This pass ingested 33 more (55 total, all with transcripts, the full FDE track included), read 6 at depth and swept the rest by search. The channel holds 983 videos; the two seams taken were everything since the last pull, plus the FDE track.

One further video was added by hand this session (All-In, 07-31) and feeds one regrade, not a decision.

6 decisions: 0 adopt · 6 pilot · 0 escalate · 8 watch · 3 set aside. New build asked for: an agent-consumable docs bundle on the portal (D-10). New spend: none. Evidence rows: 3 D · 13 R · 0 A — no decision rests on an `A` row, and the one A-only item was regraded down accordingly.

Every decision below is NEXT. Research produces decisions; a badge upgrades when the change is in a connector, the harness, or the portal.

### The docket

| # | Workstream → artifact | Verdict | Basis |
|---|---|---|---|
| D-7 | Salesforce connector → 13-role rubric on live traffic | **PILOT** | R |
| D-8 | Salesforce connector → connector call logs | **PILOT** | R |
| D-9 | NetSuite connector → planning decision map + term map | **PILOT** | D (2 maps) |
| D-10 | Developer portal → connector API docs bundle | **PILOT** | D (1 case) |
| D-11 | Internal harness → pre-build validation gate | **PILOT** | D (1 case) |
| D-12 | Connector programme → named productization threshold | **PILOT** | R (2, non-vendor) |

### Carried forward

The 08-05 report was skipped (`no-new-source-data`); no 07-30 checkpoint outcome is recorded. Every line is due.

- **D-1 ESCALATE** ordered write path — slipped: escalated to Carly, no recorded decision, kickoff status unrecorded — ask Dave. **New constraint:** do not scope it onto MCP tasks yet — see the WATCH below.
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

`Weakest link:` one solo-founder shop, all self-reported, no baseline against ordinary review. **33 new talks added nothing here** — the channel's eval work is pre-production simulation, not live-traffic grading. The gap is real, not unsearched.
`Wrong if:` alpha traffic is low enough that a human reading every conversation is cheaper.
`Cost:` days · owner David · checkpoint 08-13.

**D-8 · Salesforce connector → redundant-call check on connector call logs · PILOT · NEXT · extends**

A right answer reached through dozens of redundant calls is cost and latency the current test scores as a pass.

`Change:` a log-side check for repeated identical tool calls and no-progress loops, fed by the D-4 trace audit's logs. **Sharpened:** the log must be queryable per-run, not only flat — the check reads the path taken, not the final answer.
`Evidence:`
- `R ⓥ` Arize report their own agent looping and not recognising done — failures their fixed-rubric judges missed [vid:q2JrUKBMf0w @2:59, @3:14]
- `R` Uber's precondition: log the whole orchestration flat so single cases can be inspected [vid:31GUkCBD-Uc @6:25, @6:56]
- `R ⓥ` a judge must read the trajectory the agent took, not just the end state; long trajectories exceed one model call, so the trajectory itself has to be enriched and made queryable [vid:2aS7aKoXn64 @12:35, @15:31, @16:12]

`Weakest link:` still no one has shown a trajectory check catching an answer-check miss. The new row is a vendor selling environments, and it contradicts the Uber row on storage shape — flat is enough to inspect one case, not enough to judge many.
`Wrong if:` two weeks of logs show no redundant-call pattern above noise.
`Cost:` days · owner David · checkpoint 08-20.

**D-9 · NetSuite connector → the planning epic as a decision-ticket map, opened by a term map · PILOT · NEXT · extends**

NetSuite planning decisions become tracked tickets with blocking order. **Added:** the first ticket is the vocabulary — which nouns are overloaded across Fourth, ops, finance and the customer, and where the translation layers sit.

`Change:` run one NetSuite planning epic as typed decision tickets; the first resolves the term map (overloaded nouns and verbs, integration points, translation layers, systems of record that cannot be replaced); the spec links back to each ticket.
`Evidence:`
- `D (2 maps)` real repo maps on screen: 12 decision sub-issues under one, 14-of-17 resolved with blocking relationships on another [vid:F3lL98Pj90o @4:30, @4:43, @9:10]
- `R` specs stay dense and link to primary-source tickets [vid:F3lL98Pj90o @10:53, @11:08]
- `R` seven years of Palantir integrations: the same entity is customers to sales, clients to ops, billing entities to finance, org IDs to devs — the stated consequence is that integrations break and pipelines fail; the prescribed first pass is exactly overloaded terms, integration points, translation layers, systems of record [vid:1OMHGsUZiqA @12:26, @12:56, @14:56, @15:09, @15:22]
- `R ⓥ` a description layer over ERP-scale schemas, vendor-run [vid:NWyTsKTKka8 @47:29]

`Weakest link:` the maps prove the artifact stays current for its author; no throughput evidence. The vocabulary rows are narrated history, not a measured before-and-after.
`Wrong if:` the map costs more upkeep than the decisions it surfaces, or NetSuite's vocabulary turns out to be unambiguous across the four teams.
`Cost:` hours · owner David · checkpoint NetSuite kickoff.

**D-10 · Developer portal → agent-consumable docs bundle for the Salesforce connector API · PILOT · NEXT · extends**

The portal's first reader may be a customer's coding agent — vendors now ship docs the agent reads and integrates from directly.

`Change:` ship one agent-readable docs/skill bundle for the connector API; kill if no external coding agent uses it within an agreed window.
`Evidence:`
- `D (1 case) ⓥ` on stage a coding agent read docs shipped in the node package, made a working connection, queried it [vid:eD8pV7nSIxY @8:27, @8:41, @9:10]
- `R ⓥ` a one-command plugin (skills + MCP server) so Claude Code/Cursor "knows exactly the structure" [vid:m8VC2SV2igM @7:11, @7:50]
- `R` non-vendor: a practitioner's agents execute against agent-consumable playbooks on a schedule [vid:vJEy3nP2_C8 @25:42, @25:56]
- `R` a 500-person company rebuilt bespoke CRM integration as a self-serve path; work that needed an engineer writing custom code is now done by the customer [vid:7wu2hsRfvV0 @12:12, @12:22, @15:18]

`Weakest link:` the two rows that show an agent reading the docs are both Vercel-commercial; no external-adoption numbers anywhere. The new row proves self-serve, not agent-readable — it supports the portal, not the bundle format.
`Wrong if:` Fourth's external developers integrate only through humans reading reference docs.
`Cost:` days · owner David · checkpoint 08-20.

**D-11 · Internal harness (game-plan) → validation gate written before the build · PILOT · NEXT · extends**

The reviewer model writes the pass/fail gate before the build starts, so a connector milestone cannot pass on the builder's own claims.

`Change:` on one connector milestone the reviewer authors the gate first; fails loop back to the builder.
`Evidence:`
- `D (1 case)` the gate, written while the builder idled, ran twice on screen — failed before the build existed, all checks passed after [vid:AQl5Q-0l7FQ @5:14, @5:56, @6:06]
- `R` the builder is barred from editing the gate file; fails re-loop as feedback [vid:AQl5Q-0l7FQ @23:18]
- `R` non-vendor: a bank's production research system builds the eval first, then sends it to two critic agents — one for conceptual errors and information leakage, one writing unit and integration tests — and the loop does not end until both are satisfied; only then does the work run [vid:kiqubc5b5Yo @9:57, @10:13, @10:27]. The speaker names starting from a good eval as a monthly relearned lesson [vid:kiqubc5b5Yo @15:48]

`Weakest link:` **this now clears the ADOPT evidence bar and is held at PILOT anyway**, because its own falsifier is untested — nobody has shown gate-first catching a defect that build-then-test would miss. The bank's gate is reviewed before the build, not authored by the reviewer; that is a weaker claim than the one D-11 makes.
`Wrong if:` the pre-written gate catches nothing the existing post-build review does not — added latency, not added review.
`Cost:` hours · owner David · checkpoint 08-13.

**D-12 · Connector programme → a named threshold at which bespoke work becomes platform · PILOT · NEXT · new**

Fourth builds connectors one customer at a time with no stated point at which one becomes a platform capability. That point arrives whether or not it is named, and the cost of naming it late is carrying every shortcut forever.

`Change:` write the trigger down before the NetSuite build — a count of bespoke integrations, or a repeat-request count, past which the next one must ship self-serve. Review it at each connector kickoff.
`Evidence:`
- `R` a 500-person company built custom integrations repeatedly and only stopped at the 25th, which they describe as the point they should have reached far earlier; the guiding rule since is that custom becomes self-serve [vid:7wu2hsRfvV0 @12:12, @12:22, @15:18]
- `R` non-vendor: a throwaway script survived twelve months into a ~100,000-person customer and had to be supported for years; the stated rule is to ship everything as if it runs for 18 months, because every hack reaches production [vid:1OMHGsUZiqA @19:00, @19:39]

`Weakest link:` two narrated histories, no measured cost of getting the threshold wrong in either direction. A threshold set too low turns one customer's request into platform work nobody asked for.
`Wrong if:` connector demand stays single-digit, where naming a threshold is ceremony.
`Cost:` hours · owner David · checkpoint NetSuite kickoff.

### Set aside, shelved, confirmed

- **WATCH (trigger: a mainstream agent client ships MCP tasks on the V2 stateless spec; watcher David)** — long-running connector calls with human approval. The demo is real: a purchase-order flow validating against an ERP, pausing for human approval, retrying, and surviving a server that was down at submission [vid:s4r6nk5WsZw @2:47, @5:38]. The blocker is not the mechanism. The V1 spec shipped in November marked experimental and **no agent client implements it**; V2 goes stateless, drops `task list` and replaces the input-required tunnel [vid:s4r6nk5WsZw @0:38, @1:53, @17:19]. Client-side task-id persistence is a SHOULD, not a MUST, and losing the id loses the task [vid:s4r6nk5WsZw @19:04]; polling does not scale past thousands [vid:s4r6nk5WsZw @22:15]. **Bears on D-1** — do not design the ordered write path around this spec this quarter.
- **WATCH (09-03)** — framework-native safety: tool-layer approvals and a first-class eval API in the box; all vendor [vid:eD8pV7nSIxY @13:31, @18:48].
- **WATCH (09-03)** — tri-model hardening: pin reviewer effort below ultra; halt loudly on mid-run auth death [vid:zXZkuFxpwL0 @18:25, @17:13].
- **WATCH (09-03)** — last30days-style sentiment sweep vs opencli; kill by one opencli-plus-synthesis run [vid:ShYfGB3x5mM @1:09, @1:34].
- **WATCH (trigger: four-figure cloud-labeling corpus; watcher David)** — local bulk labeling: 9 TB, 48,000 clips → 12 MB searchable text, free, ~2 days on a Mac Mini [vid:mme027WZhgo @3:50, @8:09, @9:12].
- **WATCH (trigger: replication on one Fourth doc set; watcher David)** — folder-catalog navigation, first D, all vendor-run [vid:NWyTsKTKka8 @32:33, @56:20].
- **WATCH (09-30)** — post-training cost floor: ≈$131 LoRA on a 1T open model ⓥ ⚠asr [vid:kxstlfc8Lw4 @19:47]; ~$50K frontier RL narrated [vid:V-EDrhIhHzQ @32:12].
- **WATCH (trigger: any announced pacing commitment or access change from Fourth's model supplier; watcher David)** — frontier-access dependency. **Grade correction:** last week's endpoint-swap drill was listed as a PILOT held at the word cap. Its evidence is `A` throughout, and the stated gate caps an A-only finding at WATCH. It is regraded here, not promoted. The basis is now two dated commentaries rather than one: a two-week frontier-access suspension discussed [vid:wgdxSCsmS-Q @50:35], and a named public letter, *Pacing the Frontier*, which the panel says most of one frontier lab's leadership signed — two labs at the frontier arguing for slowing down [vid:ViqYWhLimGg @34:34, @49:42]. Both are panel commentary about third parties, not testimony from anyone with access to Fourth's contract. A prediction-market price quoted in the same segment (19% on a US AI safety bill this year) [vid:ViqYWhLimGg @59:07] is a market, not evidence, and carries nothing.
- **Confirms, no action (3):** a 15-year ML firm states the chassis thesis back [vid:ezRtp6K6zwE @30:25, @32:33]; file-based context reported surviving ~2 years of model swaps [vid:NWyTsKTKka8 @51:10]; the "detect the real problem" pattern — a 47-page requirements document and a three-month estimate collapsed to a four-hour alert once someone asked what the user does first on Monday [vid:1OMHGsUZiqA @5:07, @5:47, @6:15].
- **Held at the word cap (this week):** PILOT an hours-level Herdr workroom-visibility trial ⚠asr [vid:neK8ydl0Vlk @6:19, @8:14]; PILOT a chassis validation-density audit [vid:wpOA-UXynoM @12:23]; PILOT an endpoint-interception eval [vid:V-EDrhIhHzQ @22:07]; PILOT a named-smell vocabulary in the review skill [vid:A8mokin_YOs @7:13, @7:37]. The endpoint-swap drill leaves this list — regraded to WATCH above.

### Not counted

1 ingested talk not reviewed at depth (n0VhIVtviC0). 27 of the 33 talks added this pass were swept by search only — the post-training, data-curation and benchmark clusters carry no Fourth consumer and are counted, not titled. ~30 further segments failed relevance or well-known. **Excluded on the ASR rule:** open-weight benchmark placements [vid:DAKnynuGyy4]; token-economics figures [vid:vJEy3nP2_C8 @34:57]; vendor autonomy percentages [vid:wpOA-UXynoM @18:13]; a GPT-5.6 benchmark recap [vid:zXZkuFxpwL0]. **Pending:** 4 X-post bookmarks uncaptured; nothing claimed from them.

### Standing notes

**Grades.** `D` demonstrated: shown or counted on stage, size in brackets; one shown case establishes a failure mode exists, never its rate. `R` reported: the speaker describes what their team runs, or a mechanism on slides. `A` asserted: opinion, prediction, framing, or roadmap. `ⓥ` the speaker's employer sells the thing in that row; a `ⓥ` row never carries a decision alone.
**Gate.** ADOPT needs one D, or two independent R with at least one non-vendor, plus reversibility inside a week. PILOT needs one D or R plus stated kill criteria. An A-only finding caps at WATCH. ESCALATE keys off authority, not evidence strength, provided the basis is stated.
**Never evidence.** View counts, likes, applause, hand-raises, how many talks covered a theme, speaker seniority, speaker's employer.
**ASR.** All transcripts are auto-captions. Names and product spellings come from each talk's published description, not the captions; technical terms are paraphrased, never quoted. Instructive instance: one transcript renders one model name as "Kimiko 3", "Qwen 1.5 3", and "Gemini K3" [vid:DAKnynuGyy4] — its benchmark claims are excluded above. The FDE transcripts render Palantir as "Palunteer"/"Palenter" and Decagon as "Deckagon"/"Akkio gone"; both are corrected here from the published descriptions.
