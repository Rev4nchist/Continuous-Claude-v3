# W0 — Content pack for the 2026-08-05 fourthos-weekly preview (builders read this FIRST)

> Compiled 2026-08-05 late evening from the live FourthOS Projects DB (queried tonight), the session-prep
> pack (pillar1-research.md, pillar3-devportal.md, PROPOSAL-weekly-sponsor-update.md), and the 07-30
> promoted package. This is the single content source for the three preview tiers. Interactive generate —
> the Tier-3 Notion package page is deliberately NOT being written this session (Dave's no-Notion-writes
> call); the HTML tiers render from THIS pack instead.

## NAME SCRUBBING (MANDATORY — public site; G3)

Real person names never appear in Tiers 1–2 except **Carly** and **Christian** (the addressed sponsors).
Replacements: Toma Busarov → "the Principal Architect (Architecture)" · Vance/Cisco → "Engineering" ·
Ivan → "RevOps" · Danny → "IT/Admin" · Michael → "identity/provisioning lead" · Donna → "an independent
second review" · Jeff → "CS" · Lee/Kobe → "RevOps" · Marianne/Aztec → "the NetSuite admins" · Nisha →
"a tools engineer". Drop PR numbers and rev numbers from Tier 1 (deep-dive may keep ONE rev anchor).

## Data model (v2 fields)

- headline: "The portal has everything except one written answer"
- subheadline: "The plumbing is live, the prototypes exist, Engineering is building. Thursday's job is capturing Christian's boundary decision in writing."
- date: 2026-08-05 (preview; meeting Thu 2026-08-06)
- shipped[] (chips, each with anchor):
  1. { "Research: 25 talks → 5 pilot decisions", "briefing.html#outcomes" }
  2. { "Portal knowledge base assembled from 7 sources", "deep-dive.html#thesis" }
  3. { "New reusable asset: 13-role truth test (57 questions)", "briefing.html#outcomes" }
  4. { "Churn signal corrected in production — twice-verified", "briefing.html#portfolio" }
  5. { "NetSuite architecture decided (gate spike passed)", "briefing.html#portfolio" }

## Sponsor actions (For Your Decision — briefing #sponsor-actions)

- **action-01 (Christian)** — "Set the portal boundary — in writing, in the meeting."
  Recommendation: confirm/narrow/reject the three-part starting proposal (Documentation Hub · Access
  Management · Tool Catalog). Decide by: Thursday's session. Cost of waiting: Engineering starts its own
  customer token-request screens within weeks — every verbal week makes the eventual boundary more
  expensive; the default outcome is static documentation around someone else's surfaces (the standing
  portal-decay risk). Detail: the framing question verbatim — "Is the Developer Portal primarily a
  documentation/onboarding experience, or the customer-facing operational control centre for MCP
  integrations, token management and tool discovery?" Also resolves in one question whether
  "PerformanceOS" is a second platform or a naming artifact. Owner: Christian.
- **action-02 (Christian, conditional)** — "Name an owner for the tool-catalog security gate."
  Recommendation: assign now if any tool catalog survives scoping (escalated 07-30, still unowned).
  About a sprint of work; a POC-grade gated-pipeline pattern already exists to point at. If the answer
  is docs-only, this dissolves. Decide by: Thursday. Cost of waiting: catalog scope freezes with no gate.
- **action-03 (Christian + Carly)** — "Book the architecture review."
  Recommendation: a dated slot within two weeks. Open for 3+ weeks; three connectors keep building on a
  design Christian has not signed off — a late correction gets more expensive each week. Owner: sponsors.
- **FYI card (dashed .fyi variant)** — "Six research decisions from 07-30 get their checkpoint statuses
  in Thursday's meeting." The 08-05 auto-report correctly skipped (no recorded movement), so no
  checkpoint outcome exists on record for any of them; Dave states each status live and lands outcomes
  in the system the same day. No response needed — visibility only.

## Portfolio Live Look (briefing #portfolio — status-grade, Change → Benefit voice)

1. **Salesforce Connector** · live in ALPHA · Yellow. Two correctness releases live-verified this window:
   the customer-churn signal now reads live at-risk revenue instead of a stale year-old field, and the
   query layer refuses the workaround path — so churn answers are now trustworthy for any phrasing. A new
   reusable asset shipped: a 13-role, 57-question business test that checks answers are TRUE, not just
   that tools respond — it found 4 real defects, 2 fixed same day. Yellow for one measured reason: a
   silent multi-select filter undercount (129 returned where 10,269 is correct) has a built fix not yet
   merged/deployed — deploying it is the top priority. Next: deploy the fix; send the two written-but-
   unsent asks (security hardening to IT/Admin; a narrowed 4-field access ask to RevOps).
2. **External Developer Portal** · Shape · Yellow · DECISION NEEDED. Knowledge-transfer complete: the MCP
   server and token model are understood; the scope is not. The portal is not greenfield — a live tool
   server (300+ tools), a live 25-endpoint token-management API, and a working prototype of every portal
   surface (on mock data) already exist. Blocked on exactly one thing: Christian's written boundary
   answer (action-01). Three moves start regardless: walk-and-time a vendor's first tool call, an MCP
   tool-testing agent (generates the reliability data any catalog needs), a docs-from-registry spike.
3. **NetSuite Connector** · Shape · Yellow · DECISION NEEDED. The architecture gate passed: the chosen
   approach is confirmed viable in Fourth's own tenant, with a written decision record — the build path
   is decided without waiting on further admin access. Admin dependency partially cleared (the fallback
   path stays real). One governance finding worth a Christian-level conversation: the tenant already
   carries several active AI-labelled access roles today, ahead of this governed connector — a check is
   underway that none grants unrestricted data read. Next: secure the remaining admin items (sandbox
   access, integration rights, service tier).
4. **Connector Ecosystem** (program) · ActiveDev · Yellow. The three connectors now run as one program on
   a shared build pattern ("the mold"). Pending: Zendesk-vs-NetSuite sequencing and the architecture
   review (action-03).
5. **EBR Presentation Suite** · ActiveDev · Green. Platform decision locked (build inside the Fourth AI
   architecture platform); tech ~85–90% complete; remaining work is scaling, security, governance,
   adoption. Interim customer-support data flows via a manual CS report until the Zendesk rebuild.
6. **Agent-Arch Platform** · ActiveDev · Green. Confirmed as the interface home for the EBR builder and
   the GTM Risk dashboard; a 2–3 week dedicated build window is approved — so both tools get
   per-customer dashboards with role-based access on one platform instead of two one-offs.
7. **GTM Risk Intelligence Dashboard** · ActiveDev · Yellow. Data reliability is the gating risk:
   account-name mismatches until RevOps' canonical ID list lands, and call-trackers over-flag risk on
   positive calls — both fixes in flight so leadership sees true risk, not noise.
8. **Fourth Agent Delivery Platform** · Shape · Yellow. Model-routing strategy reframed as a governed
   agent-delivery platform (reusable agent packs, curated tools, deterministic validation). Next: the
   sponsor brief.
9. **AI Platform Architecture Alignment** · Shape · Yellow · DECISION NEEDED → action-03.
10. **AI Governance & Research Cadence** · Shape · Yellow. Reinstating the alternating weekly
    Governance/Education and Research meetings; needs Carly's note to leadership to lock the cadence.
11. **Zendesk Connector** · Shape · Yellow. Rebuild scoped on the Salesforce mold (~2 quarters out);
    interim manual report path confirmed for EBRs.

## Risk Radar (briefing #risk-radar)

1. **Portal boundary stays verbal** — Engineering's own token screens start within weeks; every verbal
   week raises the cost of drawing the line. Mitigation: action-01, in writing, Thursday.
2. **Multi-select undercount live in production** — a filter question can silently return ~1% of the
   right rows until the built fix deploys. Mitigation: deploy is the connector's top priority.
3. **Ungoverned AI access in the NetSuite tenant** — AI-labelled roles exist today ahead of the governed
   connector; verification underway that none has unrestricted read. Mitigation: named check + the
   provisioning session.
4. **Architecture review unbooked (3+ weeks)** — three connectors building on an unsigned design.
   Mitigation: action-03.
5. **Reporting starves without cockpit feeding** — the 08-05 auto-report skipped honestly on zero
   recorded movement. Mitigation: the weekly-rhythm proposal (daily landings + a Tuesday close).

## Outcomes / Evidence (briefing #outcomes)

- **Research became decisions:** 25 talks reviewed → 5 pilot decisions with kill criteria, 0 adopts,
  0 escalates — an honestly-graded week (3 demonstrated / 8 reported / 0 asserted evidence rows; every
  citation re-checked against transcripts). Held: 7 watch items with expiry dates.
- **The 13-role truth test** found a wrong-answer path a green unit suite could not: 4 verified defects,
  2 fixed same day. A shareable redacted report exists for stakeholders.
- **Live verification beat the documentation three times** in one window (a field assumed hidden was
  reachable; a "drop this" field is populated on 130,917 accounts; a documented field is ~94.5% empty) —
  querying production before trusting a document is now standing practice.
- **Portal knowledge base:** 7 sources synthesized (raw transcript, live API spec, architecture pages,
  the prototype repo itself) into one cited brief — so Thursday's scope conversation starts from
  evidence, not recollection.

## Deep-dive (Tier 2) — flagship: the External Developer Portal

- **#thesis**: "The portal is not a blank page." What exists (server, live token API, prototype
  surfaces, docs estate) vs the one missing decision. POC-stage honesty throughout.
- **#concept — Concept Spotlight (rotates weekly): "Two keys, two levels."** Teach the token model:
  customer-wide key (an integration acting for a whole business) vs user-scoped key (carries the person,
  so downstream systems enforce THEIR permissions); scopes filter twice (products the customer owns →
  subset per key). Why this matters: every portal surface — key creation, demo access, consultant
  delegation, tool visibility — is a view over this one model. Include the honest gaps: rotation,
  revocation flow, identity provider undecided.
- **#outputs**: the session-prep evidence pack (docket, portal brief, proposal) + the three ungated
  portal moves + the agent-readable docs pilot (D-10: the portal's first reader may be a customer's
  coding agent).
- **#architecture**: reuse the committed architecture SVG from fourthos/assets/ if present (do NOT
  generate new diagrams); otherwise a simple inline HTML/CSS flow strip (registry → server → backend
  APIs; two-key auth) built with styled divs, not hand-authored SVG paths.
- **#payoff**: what the written answer unblocks, and the weekly-rhythm proposal one-paragraph summary
  (delta-only portal ledger with age counters).

## Hub (#glance / #next / #seeds / #pillars)

- Needs you: the 3 actions above (link to briefing#action-0N).
- What moved: the shipped[] chips.
- Watch: risks 1–3.
- #seeds: the weekly-rhythm proposal (feeding discipline, ~3–4 h/week, honest skips); the research
  docket becomes a standing weekly section; the portal ledger renders delta-only from here on.
- #pillars (Mandate Pillars — "How this connects"): balance counts this week — Research 2 (research
  docket practice + AI Governance & Research Cadence) · Prototyping 6 (Salesforce, NetSuite, Zendesk,
  EBR, GTM, Agent-Arch) · Portal-direct 1 (External Developer Portal — FIRST week with a direct Pillar 3
  project row; until 07-29 the portal had no project record at all). One honest sentence: the portfolio
  still leans prototyping; the portal now has a record, a knowledge base, and one gating decision —
  sequencing, no longer invisibility.

## card.json

{ "tag": "Sponsor Update", "title": "FourthOS — August 5, 2026", "description": "The portal has everything except one written answer — plus 25 talks distilled to 5 pilot decisions and a new truth-test asset.", "meta": "August 5, 2026", "date": "2026-08-05" }

## Build notes

- Chrome/CSS: copy from the corresponding fourthos/2026-07-30/ file (index/briefing/deep-dive) — same
  shell, tabs, hover menus, week-switcher, footer. Update breadcrumb + dates to "preview" semantics
  (breadcrumb date "Aug 5, 2026 (preview)").
- All deck-internal links root-absolute /ai-enablement-decks/fourthos/preview/…; anchors per the
  generate prompt (§ Design system). scroll-margin-top:80px on targets.
- Badges: LIVE only for things running (MCP server QAI, Management API, Salesforce connector "live in
  ALPHA" — never "production GA"). Prototype surfaces = BUILT IN-REPO or DESIGNED·NEXT as fits.
- Banned words + activity openers per the Clarity Contract. No "topology". Jargon replaced per the
  skill table. One idea per sentence.
