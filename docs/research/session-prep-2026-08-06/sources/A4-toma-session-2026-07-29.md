# Source A4 — Toma Session — Dev Portal & MCP Auth Foundation (2026-07-29)

> Fetched 2026-08-05 from Notion page `2b0fb0def1c34f1abe17ad23626f5914` (child of FourthOS - Principal AI Mandate).
> PROVENANCE (from the page itself): reconstructed after the fact from two derived records — the Notion
> meeting-note AI summary ("Fourth360 MCP Server Architecture & Developer Portal Onboarding", Source A) and a
> hand-structured docx synthesis ("Fourth MCP Platform: Toma Knowledge Transfer", Source B). Neither is the raw
> transcript. Items the records are silent on are marked UNANSWERED, not inferred. All facts are POC-stage
> unless stated. "Fort360" in Source A = Fourth360.

**Purpose:** Build the foundational knowledge base for the External Developer Experience Portal mandate. Toma
(Principal Architect, Architecture) built the MCP auth infrastructure and owns the plumbing Christian described
on 7/23. Leave this call able to draw the full path: external developer → credentials → first successful tool
call → governed operation.

## Who's who (per the sources)

| Person | Role / affiliation as stated | Why they matter to Pillar 3 |
|---|---|---|
| Toma Busarov | Principal Architect, Architecture | Source of everything on this page; owns the MCP server side |
| Christian Berthelsen | CTO | Assigned the portal mandate; must rule on portal vs Fourth360 vs PerformanceOS vs landing zone; requested the market API |
| Michael | Role not stated | Must be in the meeting on how individual users get provisioned MCP access — named next step for the token-acquisition gap |
| Vance | Role not stated | Building out the migrated POC inside the Fourth360 codebase |
| Cisco | Role not stated | Same as Vance |
| Nisha (name as recorded, verify spelling) | Role not stated | Has prepared test queries and scenarios from tool-implementation work; Dave to reach out |
| Mark | Role not stated | Named stakeholder for the wanted MCP server architecture discussion (naming, descriptions, parameter standards, scaling) |
| Balaji | Role not stated | Same as Mark |

## Track 1 — The big picture

**Captured:**
- **Registry → server → backend path (the call-side half of the flow).** The MCP server uses a **tools
  registry, implemented as a database**, which does two jobs: (1) lists the available tools, and (2) routes an
  incoming request to the correct backend API endpoint. The MCP server authenticates to those backend APIs with
  **basic auth**, and customers never see those credentials.
- **Most backend APIs behind the registry are newly built.** Adapting the existing Fourth APIs proved too
  complex, so new backend APIs were created instead. A separate **"market API"** was built at Christian's
  request, to serve market data from the central server, replicating the data Christian had supplied in his POC.
- **Runtime language/framework: C# / .NET, on Microsoft's maintained MCP package/SDK.** Toma's read: the
  Microsoft SDK is stable and more standards-compliant than Christian's original POC implementation, but less
  feature-rich than FastMCP — e.g. no built-in metrics.
- **Component ownership.** The MCP server already exists and is **actively developed by Engineering**. Most of
  Christian's POC has been **migrated into the main Fourth360 codebase** and is being built out by the team —
  Vance, Cisco and others — with some tools still on partial mock data. Source B's explicit reframe: the
  expectation for Dave is **not** to build the MCP server, but to define and build the **Developer Portal
  experience** (documentation, onboarding, access management, developer experience).
- **The four surfaces, as the sources name them — including one unreconciled overlap:**
  - **MCP server** — C#/.NET, database-backed tools registry, actively developed by Engineering (Source B).
  - **Fourth360** (Source A) — the main codebase most of Christian's POC migrated into, built out by Vance,
    Cisco and others; contains a workspace and a developer/API configuration section (raw prototype).
  - **PerformanceOS** (Source B) — the broader application platform currently being developed, whose workspace
    offers chat interface, MCP access, external MCP support, and tool-execution visibility, plus the
    agent-management vision.
  - **Landing zone** (previously "integration hub") — concept for grouping integrations by vendor and
    configuring keys per vendor.
  - ⚠️ **Source A's "Fourth360" and Source B's "PerformanceOS" are described in near-identical terms** and
    neither record states whether they are the same platform, a rename, or two things. Do not assume. Resolving
    this naming is a prerequisite for the Christian scoping conversation.
- **"Otto"** — the name Christian gave his prototype portal (Source A): a marketing/landing page, a tool
  catalog with a playground for testing individual tools, and a workspace for chat interactions. Source B calls
  what is very likely the same artifact the Performance Intelligence Prototype Portal. The workspace
  **auto-injects** the internal MCP server and any configured external MCPs into the agent's context. Most of
  this has since migrated into the main Fourth360 codebase.
- **UNANSWERED:** the publish-side of the flow (how a tool gets from a domain team into the registry); the
  seams between domain teams / MCP server / Fourth360 (no domain-team ownership model described); hosting and
  gateway topology.
- **Architecture problems tackled vs open:** Tackled — the backend-API problem (new APIs rather than adapting);
  protocol compliance and naming (Christian's original POC MCP implementation was non-compliant with the MCP
  protocol standard — it worked only because purpose-built for one client; reworked toward standard
  implementations, naming standards introduced, dots → underscores for Claude compatibility, ADRs added to the
  repository). Open — **scale at 300+ tools**: context bloat, tool discoverability, tool-selection quality.

## Track 2 — Auth & identity

**Captured:**
- **Two types of personal access token:**
  - **Customer-wide token** — access to all data for a customer. Intended for integrations: head-office-level
    or service-to-service. Similar to legacy integration patterns (Source B).
  - **User-scoped token** — carries both customer identity and user identity. Downstream APIs then enforce that
    user's data-access rules (location, employee data, inventory…), supporting location-level and role-level
    authorisation.
- **Scopes filter access at two levels.** Each MCP tool is associated with a scope (worked example: tool
  `HR:GetEmployee`, `Scope: HR:Read`).
  - **Customer level** — which scopes/modules are available based on the Fourth products the customer owns
    (Scheduling, Forecasting, Inventory, HR). Customers only see tools for products they have.
  - **Token level** — a subset of the customer's available scopes assigned to a specific token, enabling
    narrowly scoped agents (e.g. `Inventory.Read`, `Inventory.Audit`, `Inventory.Write` — an inventory-only
    agent).
- **Where keys are created today (surface, not process):** the Fourth360 UI includes a developer/API
  configuration section for creating API keys and MCP keys, configuring webhooks, and viewing activity stats —
  **still a raw prototype**. Token management and provisioning interfaces already exist scattered across the
  estate (Source B).
- **Known security gap at POC stage:** *anyone who knows the token-acquisition APIs can obtain a token.*
  Recorded as a known gap; next step is a session with **Michael and Christian** on user provisioning. Treat as
  a pre-production gap with a named next step, not an incident.
- **UNANSWERED:** token rotation; token revocation; the actual agent-on-behalf-of-user token flow (the model is
  covered, the flow is not); who is authorised to mint a customer-wide/full-access key; whether a distinct
  central policy layer exists and where the authoritative enforcement point is; what identity provider(s) sit
  underneath (no OAuth 2.1 / PKCE / token-exchange discussion at all); the auth failure mode a developer sees.
- **Tool-level permission resolution (as far as records go):** a split — scope association + two-level
  filtering at the MCP layer; downstream APIs/systems evaluate the user's data-access permissions.

## Track 3 — Tool registry & lifecycle

**Captured:**
- **Naming standard:** `tool.name` (dots) caused compatibility issues across MCP clients (Claude specifically)
  → standard is now `tool_name`, underscores. Standardisation covers tool naming + parameter naming
  conventions; **ADRs added to the repository**. Fine-tuning tool descriptions and parameter naming is an
  ongoing need for correct LLM tool selection.
- **The only tool-count figure: "300+ tools"** (approximate current count discussed in the meeting) — a
  different fact from the original ~380-tool / ~200-use-case spec, whose location and live-percentage are
  UNANSWERED.
- **Progressive tool discovery is already implemented** by Engineering — search tools / progressive tool
  lookup; tools can still be listed in full. Claude and ChatGPT/OpenAI use different search-tool conventions —
  a known interoperability nuance.
- Dave raised the **Search Discovery Router Script** approach from his personal Claude Code setup — logged as a
  potential future enhancement (intelligent routing layer, context-aware tool selection, MCP orchestration).
- **Tool quality is uneven** — not all tools work reliably; built quickly, some still on partial mock data.
  Catalog tools were initially generated by Christian then modified.
- Dave flagged the need for a dedicated **MCP server architecture discussion** with stakeholders (Mark, Balaji)
  covering tool naming, descriptions, parameter standards, scaling.
- **UNANSWERED:** how a domain team registers a tool (self-serve vs gated review); how naming conventions are
  enforced; versioning & deprecation for external integrations; the canonical-ID problem.

## Track 4 — Developer onboarding today (the experience audit)

- **UNANSWERED — the most consequential blank on the page:** the literal steps a brand-new vendor takes to a
  first successful tool call, and how long it takes. No step sequence, no duration, no named path, not even an
  anecdote. Ask it first in the follow-up.
- **UNANSWERED:** whether a sandbox/test tenant exists or a new caller hits production data. Adjacent (not an
  answer): a demo/testing customer key and a market-only key were promised as action items; "demo token
  issuance" is listed among Access Management functions in Christian's portal vision.
- **Documentation that demonstrably exists** (all internal/architecture-facing): the ARCH-Fourth Product MCP
  architecture PDF (`ARCH-Fourth Product MCP-290726-122428.pdf`); the Confluence page for Fourth Product MCP
  architecture; ADRs in the MCP server repository; a Management API documentation endpoint (shared after the
  call).
- **UNANSWERED:** who maintains documentation; any developer-facing docs beyond internal artifacts + Confluence
  tool lists; where developers get stuck; the error/debugging experience (whether a developer can self-diagnose
  a failed call). Adjacent internal surfaces only: MCP Inspector (internal testing), Otto's tool playground,
  PerformanceOS tool-execution visibility.

## Track 5 — Fourth360 landing zone & external trust

- **The landing zone was described — as a concept**: previously "integration hub"; groups integrations by
  vendor, configures keys per vendor. Fourth360's developer/API configuration section is a raw prototype.
  On external-MCP configuration the two records differ: Otto's workspace auto-injects internal + configured
  external MCPs (Source A); Source B credits the PerformanceOS workspace with MCP access + external-MCP
  support, without describing auto-injection. **Nothing describes the landing zone as built or live.**
- **Managed agents:** Christian's vision — a user chats in the workspace, then **schedules that interaction as
  a recurring agent** (e.g. every Monday morning); Source B frames the same as agent management on
  PerformanceOS (convert conversations into recurring agents; weekly optimization routines, labor analysis,
  automated operational reviews). Source A's caveat: **the full agent loop / memory may not yet be
  implemented.** Nothing on where a recurring agent's session data is stored or replayed.
- **UNANSWERED:** registration mechanics for an external vendor (webhook vs API key vs external MCP,
  built-vs-planned per mechanism); the playbook-retrieval / compliance-check API for third-party AI vendors;
  session recording/replay for managed agents; whether MCP access requires an iQ subscription (customer-level
  scope filtering is entitlement-shaped but no source connects it to subscription packaging).
- **Compliance thread:** the current setup requires customers to **manually enter their own Anthropic API
  key**, partly for GDPR/EMEA compliance; key provisioning should ideally be automated.

## Track 6 — Where Dave plugs in

- **Toma's interpretation of Christian's portal vision** (not his own wish-list):
  - **Documentation Hub** — tool documentation, MCP documentation, usage guidance, consultant onboarding
    materials.
  - **Access Management** — token provisioning, demo token issuance, customer token management, consultant
    access workflows.
  - **Tool Catalog** — searchable catalog of available MCP tools with parameters, testing playgrounds, and
    per-tool documentation.
- **Pain points recorded:** the token-acquisition gap; 300+ tool discoverability and context cost; uneven tool
  reliability; ongoing tool-description/parameter-naming fine-tuning; manual Anthropic API key entry.
- **Access promised toward persona testing:** MCP server repository link; the two hosted application links
  (Otto + Fourth360) with API keys; the Confluence page link (to request space access); QAI MCP server URL with
  demo/testing customer key + market-only key. Nisha has prepared test queries and scenarios — Dave to reach
  out.
- **The decisions blocking portal work all sit with Christian**; scope is unclear after multiple meetings.
  Specifically open: portal vs the existing Fourth360 UI (explicit confusion about overlap); whether the portal
  mirrors Fourth360's API-key/webhook configuration; portal vs PerformanceOS vs Landing Zone; configuration
  (customers direct vs consultants vs delegated administration); token provisioning (how much exposed vs
  automated); documentation (developer docs vs product docs vs tool catalog vs integration onboarding — or
  all); how individual users get provisioned MCP access (needs Michael + Christian).
- **Source B's recommended framing question** (its conclusion): *"Is the Developer Portal primarily a
  documentation/onboarding experience, or is it intended to become the customer-facing operational control
  center for MCP integrations, token management, and tool discovery?"*
- **Agreed next step:** review Christian's POC and portal, then hold a scoping conversation with Christian.

### How Toma's team builds (Source A)
- Primary AI coding tool: Claude Code.
- Code review: GitHub Copilot (licensed) as a second reviewer after Claude reviews its own work.
- CodeRabbit — raised by Dave as highly effective for CI/CD-integrated reviews; no licence available. Standing
  enablement ask, no owner.
- MCP Inspector — used for testing MCP servers.

## Artifacts

**RECEIVED:** ARCH-Fourth Product MCP PDF; Confluence Fourth Product MCP architecture page; Management API
documentation endpoint.
**PROMISED (not delivered):** MCP server repo link; Otto + Fourth360 hosted links with API keys; Confluence
space-access link; QAI MCP server URL + demo/testing key + market-only key; agent POC repository (verify
whether in hand).
**STILL OPEN (no action item):** Slack channel invites (tool publishing + Fourth Agentic); auth-flow / topology
diagrams; sandbox/test credentials; the original ~380-tool spec; one sample authenticated tool call to replay;
auth-infrastructure repository name.

## Post-call synthesis (three biggest things learned)

1. **The MCP server already exists, and Dave's remit is the experience layer — not the server.** Actively
   developed by Engineering, C#/.NET, Microsoft MCP package, database-backed registry routing to backend APIs.
   This resets the mandate's centre of gravity.
2. **The two-token / two-level-scope authorization model is the real foundation to design against.** Every
   portal surface — key creation, consultant delegation, demo tokens, tool visibility — has to express this
   model. Known pre-production gap: unsecured token acquisition; next step = Michael + Christian session.
3. **The Fourth360 overlap problem is the actual blocker.** A developer/API configuration surface already
   exists as a raw prototype inside a codebase another team is building, alongside the landing-zone concept.
   Until Christian rules on what the portal owns vs Fourth360 vs PerformanceOS vs the landing zone, portal work
   risks rebuilding someone else's surface — and the records never reconcile whether Fourth360 and
   PerformanceOS are even two different things.

## Barrier-to-entry hypotheses (where the "giant wall" might be)

- Unsecured token acquisition at POC stage — whatever closes it likely becomes the front door; no design yet.
- No established time-to-first-call path — if nobody can describe the path, no external developer can walk it.
- 300+ tool discovery burden — the catalog is where a developer's "which tool do I call" hits the wall.
- Uneven tool reliability — a developer who picks a broken tool first cannot tell whether the fault is theirs.
- Manual customer-supplied Anthropic API key — a hard stop in any self-serve flow until automated.
- Scope ambiguity portal / Fourth360 / PerformanceOS / landing zone — four surfaces could plausibly own key
  creation; two of the four names may be the same platform.
- Rotation and revocation undefined — an enterprise vendor's security review will ask before integrating.

## Follow-ups / owners (as recorded)

| Follow-up | Owner |
|---|---|
| Call Christian to clarify true portal scope (committed 2026-07-30) | Dave |
| Schedule time next week to align on scope; reflect back Christian's vision in writing | Dave (with Christian) |
| Send MCP server repository link | Toma (implied) |
| Send Otto + Fourth360 links with API keys | Toma (implied) |
| Send Confluence space-access link | Toma (implied) |
| Send QAI MCP server URL + demo/testing + market-only keys | Toma (implied) |
| Send MCP architecture / context-window articles | Dave |
| Send Search Discovery Router Script details | Dave |
| Meeting with Michael + Christian on individual-user provisioning (token-acquisition gap) | No owner recorded |
| Reach out to Nisha for prepared test queries/scenarios | Dave |
| Dedicated MCP architecture discussion with Mark + Balaji | No owner assigned |
| CodeRabbit licence | No owner assigned |
| Slack channel invites (tool publishing + Fourth Agentic) | No owner — never raised |
