# Pillar 3 — External Developer Portal: What We Know, What We Need, How We Proceed

Synthesized 2026-08-05 from A0, D1 (A3 transcript), D2 (A6/A7a/A7b platform docs), D3 (A4/A5), D4–D5 (agent-poc repo), D6 (07-30 sponsor package + A9), with a direct pass over A4.

> **⚡ SCOPE ANSWER CONFIRMED — Dave, 2026-08-06 (pre-meeting).** The portal is **NOT just** a
> documentation-and-onboarding experience. It **IS the customer-facing operational control centre** for
> MCP integrations, token management, tool discovery, **skills, agents, etc.** North-star UX: **an agent
> on the page that sets everything up and coaches the customer through setup and use.** Consequences per
> §5: the "operational control centre" branch of the fork is taken — key/webhook/token surfaces pull into
> Dave's remit, the boundary against Engineering's active build (their token-request UI starts within
> weeks) must now be drawn feature-by-feature, D-2 (catalog security gate) LIVES and needs an owner, and
> the scope now explicitly includes skills + agents (the agent-poc skills-ecosystem surface that §6
> proposed parking is back in scope as a portal concern). Milestone bar still applies: this answer must be
> written back to Christian and acknowledged. §§5–7 below predate this confirmation — read them as the
> analysis that framed the fork, not the current state.

## 1. The read

The portal is not a blank page and it is not blocked on building anything. The plumbing — a tool server with 300+ tools and a live token-management API — already exists and Engineering owns it (D2, D3). A working prototype of every portal surface already exists inside Christian's own prototype repo, running on fake data (D4, D5). What is missing is one written answer from Christian: is the portal a documentation-and-onboarding experience, or the customer-facing control centre for tokens and integrations? That question was put to sponsors on 30 July with a decide-by of that day, and no source records an answer (D6). Thursday's job is to capture it in writing, live. Everything else sequences behind it.

## 2. What exists today — by surface

**MCP server + tools registry — live on QAI, POC-stage quality.** A C#/.NET server on Microsoft's MCP SDK, with a database-backed tools registry that lists tools and routes each call to a backend API; server-to-backend auth is basic auth invisible to customers (D1; D3). Most backend APIs were newly built because adapting existing Fourth APIs proved too complex (D1). Live URLs: mcp-qai.fourth.com (QAI) and mcp.fourth.com (EMEA) (D2 citing A7a). The tool estate: "300+ tools" is the only meeting figure on record — distinct from an original ~380-tool spec whose location is unknown (D3). The repo's own count drifts (211 vs 282 vs "200+" vs "300+", D4/D5 — see §4). The estate spans at least 9 domain sections and carries an official four-state deployment legend: real data / mock data / erroring / not yet deployed (D2 citing A7a). Reliability is uneven — Toma says not all of them work well because they were built quickly ("vibe coded," per D1's reading of a garbled transcript line) and "I don't know how much of them work" (D1, A3 @24:21). Progressive tool discovery (two search tools) is implemented, though not in the POC (D1, A3 @44:11).

**Management API — LIVE, 25 endpoints, pre-production governance.** Deployed on QAI: PAT create/get/revoke, scope CRUD, per-customer entitlement, and full tool CRUD where every tool carries a description plus JSON input/output schemas (D2 citing A6). This is the machinery the portal's Access Management pillar would front. Seams remain: no RBAC detail, no audit trail (deferred to v.Next), undocumented enums, and PAT creation requires only a Bearer JWT and a scopes array — no visible approval step, and no customerCanonicalId in the create request, so how a PAT binds to a customer is invisible in the spec (D2).

**Auth + token model — designed and implemented; internals unresolved.** Two PAT types (customer-wide; user-scoped with downstream enforcement of that user's data rules) and two-level scope filtering (customer level by products owned, then per-token subset) (D1, A3 @1:47–5:37; D3). Two disclosed trust holes: "anyone can get a token" if they know the acquisition APIs (D1, A3 @1:47), and vendor key grouping is unenforced — a key issued for one vendor works if handed to another (D1, A3 @40:25); portal copy must not promise per-vendor isolation (D1). Rotation, revocation flow, identity provider, and OAuth/PKCE were never discussed (D3 items 10–11; A4 §Track 2).

**Fourth360 front-end — Engineering's active build.** Most of Christian's POC "was integrated into the main [Fourth]360 code base," built out by Vance, Cisco and others; UI badges read "partial mock" (D1, A3 @30:15). It contains a workspace (chat, tool-call visibility, an F12-style diagnostic view) and a raw-prototype developer/API configuration section: API keys, MCP keys, webhooks, activity stats — webhook delivery data is already collected but has "no good APIs to expose" it (D1, A3 @36:18–37:18, @38:29). Onboarding today has two manual steps: the customer enters their own Anthropic API key (partly GDPR/EMEA-driven — Anthropic lacks the promised regional hosting) and copy-pastes a self-generated MCP gateway key into workspace settings (D1, A3 @34:25–35:33; A4 §Track 5). Engineering starts a customer token-request UI "in the next few weeks" with Vance (D1, A3 @6:57–7:28) — an active competing builder on Access Management.

**The agent-poc repo ("Otto" lineage — a label; the name appears in no transcript or repo file, D1/D4).** A POC-grade instance of all three portal pillars already exists: a Docusaurus docs hub whose API reference is generated from the gateway's OpenAPI spec (agent-poc/api-docs); a sandbox portal with key lifecycle (trust tiers, reveal-once, revocation, request/approve workflow), playground, webhooks, and a working streaming FourthIQ chat grounded on the live tool catalog — D5's strongest "not wallpaper" exhibit for the sponsor conversation (agent-poc/site/(portal)); public marketing pages with a tool catalog and marketplace (agent-poc/site/(marketing)) (D4, D5). Half the repo is a second, adjacent product surface — a skills ecosystem (marketplace, registry, curation/studio) — not the portal itself (D5). The registry enforces a "never softened" PLATFORM_PUBLIC/INTERNAL substrate boundary (DAG validator, dual signing keys) plus a governed promotion flow: author → review → sign → yank → audit (D4). Every surface runs against a localhost mock gateway; per-key usage stats are random numbers; portal auth is a cookie-length check; staff auth is an AD stub (D5). POC-stage throughout — but a moving upstream (sole commit 2026-08-04, actively debugged), and its marketing pages assert fiction ("Trusted by 15,000 customers") that is radioactive if a sponsor reads a POC page as status (D4, D5).

**Landing zone — concept only.** Previously "integration hub"; groups integrations by vendor, keys per vendor. Nothing describes it as built (D1, A3 @39:48; D3).

**Documentation estate.** Everything that demonstrably exists is internal/architecture-facing: the ARCH Confluence page, ADRs in the MCP repo, the Management API's Scalar docs endpoint, and the TechInfo tool-tracking page (D2; D3 citing A4 §Track 4). Toma's expectation for portal docs: "in most cases … skills, like instructions for LLM. We don't expect consultants to go and call the tools" (D1, A3 @29:47). Christian's prototype credentials sit outside any secrets store and rot on redeploy (D1, A3 @16:09, @28:23).

## 3. What is already decided

| Decision | Why / evidence | Owner | Source |
|---|---|---|---|
| PATs, not OAuth | Azure AD B2C/Entra cannot support the OAuth flows the MCP spec mandates — a platform limitation, not preference | Lazar/Architecture | D2 (A7b §Design decisions) |
| One MCP server for internal + external agents | Stated plan; no split servers | Architecture | D2 (A7b §Plan) |
| C#/.NET on Microsoft's MCP SDK | Team familiarity; more standards-compliant than Christian's original POC, which was protocol-non-compliant | Toma/Engineering | D1 (A3 @41:40–42:48); D3 |
| Build new backend APIs, not adapt existing ones; dedicated market API added at Christian's insistence | Adapting proved too complex | Engineering | D1 (A3 @0:38–1:10) |
| Build in-house, no commercial gateway | Reviewed and rejected: none supports PAT-driven dynamic tool selection | Architecture | D2 (A7b) |
| POST-only unified downstream contract: basic auth + TLS, canonical customer/location/user IDs, Architecture-governed schema | Spec in fourth/MCPServer repo | Architecture | D2 (A7b §Downstream design guidelines) |
| Kubernetes + Azure SQL via Terraform | Stack decision | Architecture | D2 (A7b §Platform) |
| Tool naming: underscores not dots, parameter standards, recorded as ADRs | Dots broke Claude Desktop (Claude Code worked) | Engineering | D1 (A3 @22:17–22:49) |
| Progressive tool discovery: implemented (two search tools, complementary to full listing) | Shipped, not proposed | Engineering | D1 (A3 @44:11); D3 |
| PAT UX: immutable tokens, show-once plaintext, masked preview, expiry | Design + confirmed in the live API | Architecture | D2 (A7b; A6) |
| Engineering builds the token-request UI itself, starting within weeks | Stated on the call | Toma/Vance | D1 (A3 @6:57–7:28) |
| Dave's remit = portal experience layer, not the server | Toma's reading of Christian's expectation — **not Christian's word**; presented to sponsors 07-30 on that basis | Pending Christian | D1 (A3 @6:41); D3; D6 |

## 4. What is unknown or contested

**Two structural unknowns first:**

1. **Fourth360 vs "PerformanceOS."** The two derived records of the Toma session describe them in near-identical terms without saying whether they are one platform, a rename, or two products (D3, A4 §Track 1 ⚠️). The raw transcript names only "the main [Fourth]360 code base" and never says "PerformanceOS" (D1, A3 @30:15) — the agent-poc repo carries "PerformanceOS" as a platform name in its registry description and intent-spec sources, though not as a self-label (D4, D5). Contradiction stands; the transcript evidence points to one platform plus Christian's separately-hosted POC. One question to Christian confirms or kills the label (D1 §Portal implications).
2. **The onboarding journey blank.** The literal steps a new vendor takes to a first successful tool call — sequence, duration, path — are entirely uncaptured; "the most consequential blank on the page" (D3, A4 §Track 4). Nobody measures time-to-first-call (D6). No portal content decision should be made off this hole (D3).

**Christian answers:** the boundary (Portal vs Fourth360 vs landing zone, and the naming above); docs/onboarding vs operational control centre; whether the portal mirrors the API-key/webhook surface; how much token provisioning is exposed vs automated; consultant/delegated configuration model; documentation scope; the D-2 security gate (below) (D3 items 1–7; D6).

**Christian + Michael:** how individual users get provisioned MCP access — the fix for the open token-acquisition gap — and who may mint a customer-wide key. Transcript correction: Toma named this meeting as his own need, not an unowned item (D1, A3 @1:10 vs D3 item 8).

**Toma / Michael / Engineering:** rotation and revocation (an enterprise security review will ask); identity provider and OAuth 2.1/PKCE — never discussed; the on-behalf-of-user token flow; the auth failure mode a developer actually sees; external-vendor registration mechanics (webhook vs API key vs external MCP — built vs planned); the publish path from domain team into the registry; versioning/deprecation; who maintains documentation and whether a developer can self-diagnose a failed call; gateway/network topology — the stack itself is decided (§3) but the design page's two architecture diagrams did not render (D2); whether an external-facing sandbox exists (QAI is an internal writable test environment, D1 A3 @43:28 — partially answers it; the live MCP Inspector demo touched production data for customer "ITHelp Express", D1 A3 @23:50); which of the 300+ tools actually work; whether MCP access requires an iQ subscription (D3 items 10–24; A4 §Tracks 2–5). The named OPEN architecture problem: scale at 300+ tools — context bloat, discoverability, tool-selection quality (A4 §Track 1); Dave's code-execution-over-tool-calls thread frames it at 300–600 tools (D1, A3 @25:28–27:16). A4's STILL-OPEN artifact list (auth-flow/topology diagrams, sandbox credentials, the ~380-tool spec, auth-infra repo name, Slack invites) and the ownerless CodeRabbit ask remain unclaimed (A4 §Artifacts, §Follow-ups).

**Contradictions on record, not averaged:** design says PATs carry an editable active/inactive flag; the live API has no edit endpoint — only hard revoke (D2). Design mandates basic-auth downstream; the live registry accepts OAUTH or BASIC (D2). Tool counts disagree across four surfaces in one repo (211/282/200+/300+) — the decay mechanism A0 warns about, live inside Christian's own POC (D4, D5). "Otto" and "Nisha" appear in the derived records but not the transcript; the test-scenario colleague is an unnamed "he" (D1). Christian is CTO in A0 but "CPTO & Co-Founder" in the repo's specs (D4) — a sponsor-material trip hazard. The prior records present "300+ tools" and "~380-tool spec" as different facts, which they are (D3, A4 §Track 3); the 07-30 sponsor package showed only the 300+ figure (D6).

## 5. The scope question for Christian

Verbatim (Source B's framing, carried into the 07-30 sponsor package): **"Is the Developer Portal primarily a documentation/onboarding experience, or is it intended to become the customer-facing operational control center for MCP integrations, token management, and tool discovery?"** (D3, A4 §Track 6; D6).

The starting proposal to confirm, narrow, or reject — Toma's three-part reading of Christian's vision, not Christian's own words (D3; the transcript's actual statement is one hedged sentence, D1 A3 @6:41):

- **Documentation Hub** — tool/MCP documentation, usage guidance, consultant onboarding. If confirmed: agent-first artifacts (skills, MCP configs, scenario prompts) generated from the live registry, per Toma's stated expectation (D1, A3 @29:47) and the tool schemas already in the Management API (D2).
- **Access Management** — token provisioning, demo tokens, customer token management, consultant workflows. If confirmed: this is a UI + policy layer over the live 25-endpoint Management API — the productization of what the design doc defers to v.Next (D2) — and it must be reconciled with Engineering's token-request UI starting within weeks (D1, A3 @6:57).
- **Tool Catalog** — searchable catalog with parameters, testing playgrounds, and per-tool docs (A4 §Track 6). Propose rejecting the per-tool playground within this pillar: Dave judged it low-value on the call ("I can't imagine this would get a lot of use"), Toma agreed, and MCP Inspector is the professional's tool (D1, A3 @23:20–23:39). If confirmed: the catalog inherits the uneven-reliability problem (curate/badge a subset, not all 300+, D3) and triggers **D-2**, the unowned ESCALATE from the 07-30 docket: the portal cannot publish installable tools without a security gate (~a sprint, owner unassigned, decision owner Christian, "before scope freezes"). If Christian picks docs-only, D-2 dissolves by its own wrong-if clause (D6).

What each answer implies: "docs + onboarding" keeps key/webhook config, token management, and consultant admin inside Fourth360 with Engineering; the portal wraps them with guidance. "Operational control centre" pulls those surfaces into Dave's remit and collides directly with Vance/Cisco's active build unless the boundary is drawn feature-by-feature (D6 §Risk radar: "Pillar 3's first delivery may duplicate a surface already in build"). Either way the answer must land **in writing** — the recorded milestone bar is "boundary written and acknowledged; milestone fails if the scoping call happens and the boundary is still verbal" (D3, A5 §Next Milestone). The portal-decay connection: the longer the boundary stays verbal, the more the default outcome is static documentation around someone else's surfaces — exactly A0's named portal-decay risk, and already observable as doc drift inside agent-poc (A0; D4).

## 6. Proposed approach (Dave's recommendation)

*Sections marked [proposal] are Dave's recommendation, not established fact.*

**Phase 0 — not gated on Christian (start now).** [proposal]
- **Chase the promised access items and walk the journey.** A4 lists five promised items; the fifth — the agent POC repo — is since in hand (D4/D5 were built from it). The other four (MCP repo link, hosted links + keys, Confluence access, QAI URL + demo/market keys) remain undelivered (D3, A4 §Artifacts). Once in hand: personally walk vendor-to-first-call via MCP Inspector and time it. This produces the experience audit nobody can currently narrate and the portal's first metric — time-to-first-call — answering both the mandate's feedback-loop demand and the open hypothesis the 07-30 deck logged (D6; A0).
- **The MCP tool-testing agent.** Toma wanted it and "never progressed"; QAI is writable with keys promised (D1, A3 @24:45, @43:28). It generates the reliability data any catalog needs (which tools actually work) — a Pillar 2/3 bridge with a warm sponsor.
- **Registry-generated docs spike.** Prove docs can render from GET /tools + /scopes (D2) and from the OpenAPI→Docusaurus pipeline already demonstrated in agent-poc (D5). This is the strongest anti-decay mechanism available: reference docs that cannot rot independently of the product (D2, D4).

**Phase 1 — gated on Christian's written answer.** [proposal] Scope the confirmed pillars as branches of the fork (§5). Badge every surface with the existing honesty vocabulary — LIVE / BUILT IN-REPO / DESIGNED·NEXT (A0) — mapping naturally onto the platform's own four-state tool legend (D2). Do not build key-provisioning UI: Engineering owns that build; the portal's play is the experience wrapper (D1 §Portal implications). Park the skills-marketplace/studio ecosystem explicitly — folding it in triples the surface Dave must keep alive, the exact portal-decay trap (D5). If a catalog survives scoping, D-2's gated-pipeline demand already has a POC-grade instance to point at: the registry's author → review → sign → yank → audit promotion flow (D4; D6). Treat self-serve signup as DESIGNED·NEXT at most until the token-acquisition gap, the identity questions, and the two manual key steps (customer-supplied Anthropic key — GDPR/EMEA-driven, a hard stop in any self-serve flow until automated; copy-paste MCP gateway key) close — all sit with Christian/Michael/Engineering, not Dave (D3; A4 §Barrier hypotheses; D1, A3 @34:25–35:33).

**Phase 2 — sequenced with platform work.** [proposal] Portal auth-flow content waits on rotation/revocation/IdP answers ("do not conflate" the understood model with unresolved internals, D3 citing A5). Usage telemetry is a platform dependency the portal cannot supply alone — metrics are v.Next-optional and absent from the live API (D2); flag it to sponsors as such.

**Standing escalation to carry into the session:** D-2 (catalog security gate) remains ESCALATE with no owner (D6). And the mandate posture governs all of it: a maintained product surface with feedback loops, "not documentation wallpaper"; a stale portal is worse than no portal (A0).

## 7. Sequenced next steps

1. **Thursday session (2026-08-06): put the framing question + three-part proposal to Christian; capture the boundary in writing during or immediately after.** Owner: Dave. Gate: the A5 milestone bar — written and acknowledged, not verbal (D3). Open with the status of the 07-30 cliffhanger, not a re-presentation of it as new (D6).
2. **Same session: resolve the Fourth360/"PerformanceOS" naming in one question; confirm front-end ownership** ("double check with Christian," D1 A3 @34:13). Owner: Dave → Christian.
3. **Same session: assign D-2 (catalog security gate) an owner if any tool catalog survives scoping.** Owner: Christian decides (D6).
4. **Chase the four promised access items from Toma; then walk and time vendor-to-first-call via MCP Inspector.** Owner: Dave → Toma. These block persona testing and the experience audit (D3).
5. **Confirm the Michael + Christian provisioning session is booked** (Toma's stated need; closes the token-acquisition gap that blocks any self-serve flow). Owner: Toma, with Dave tracking (D1, A3 @1:10).
6. **Reflect Christian's clarified vision back to Toma** — Dave's on-record commitment "so that we stay on the same page" (D1, A3 @46:20). Owner: Dave, week of 08-10.
7. **Land Thursday's outcomes in the FourthOS cockpit the same day** — the 08-05 weekly was skipped for zero cockpit movement; the reporting pipeline is starving and the no-record-no-claim rule depends on rows (D6). Owner: Dave.
8. **Deliver the two items Dave owes Toma** (MCP-architecture articles; written Search Discovery Router description) — both feed the dedicated Mark/Balaji MCP-architecture session on the open scale-at-300+-tools problem, which has no owner assigned and needs one (A4 §Follow-ups; D1, A3 @25:28–27:16) — and reach the unnamed colleague with prepared test scenarios (verify the "Nisha" name with Toma) (D1, A3 @46:20; D3). Owner: Dave.
9. **Track the 07-30 sponsor-visible commitment: the multi-platform developer-access spike** — displaced twice, reset "out loud", promised to run after the undercount fix merges. If it surfaces Thursday it appears as CARRIED FORWARD with status, not silently dropped (D6). Owner: Dave.

## 8. Source map

| Source | What it is | Sections relying on it |
|---|---|---|
| A0 | Mandate extract + session context (Notion) | 1, 5, 6 (posture, portal-decay risk, badge vocabulary) |
| D1 (A3) | Raw 47-min Teams transcript of the 2026-07-29 Toma meeting | 2, 3, 4, 5, 6, 7 (verbatim quotes, timestamps; corrects derived records) |
| D2 (A6, A7a, A7b) | Confluence MCP design page, tool-estate page, live Management API OpenAPI | 2, 3, 4, 6 (PAT/no-OAuth rationale, 25 live endpoints, four-state legend, contradictions) |
| D3 (A4, A5) | Reconstructed Toma session record + FourthOS project row | 2, 3, 4, 5, 7 (three-part vision, milestone bar, consolidated open questions, access items) |
| D4 (agent-poc) | Repo architecture digest | 2, 4, 6 (POC portal layer, substrate boundary, tool-count drift, doc decay) |
| D5 (agent-poc surfaces) | Portal-experience surfaces digest | 2, 5, 6 (mock gateway, keys/docs/catalog/FourthIQ detail, OpenAPI-docs pipeline) |
| D6 (07-30 package, A9) | Last promoted sponsor package + reporting pointers | 1, 4, 5, 6, 7 (cliffhanger, D-2 ESCALATE, risk radar, cockpit starvation) |
| A4 (direct) | Reconstructed session source read in full | 4, 7 (owner table, artifacts lists, barrier hypotheses) |
