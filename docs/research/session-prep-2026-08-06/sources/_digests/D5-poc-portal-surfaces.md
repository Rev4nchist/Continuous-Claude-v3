# D5 — POC portal surfaces (agent-poc repo)

Digester: D5. Sources: the cloned `agent-poc` repo, portal-experience surfaces only (`site/`, `api-docs/`, `studio/`, `skills/`, `curation/`, `demo/`). All citations are repo-relative paths. **Everything in this repo is POC-stage** unless marked otherwise: every service defaults to localhost, and the backend for the entire developer experience is a .NET *mock* MCP gateway with scenario-driven fake data (agent-poc/CLAUDE.md §"Mock MCP Gateway").

## FACTS

**Repo-wide**
- The repo is a two-stack POC: a .NET 8 agent platform (3 agent layers + NBA pipeline + Mock MCP Gateway on port 5000) and a TypeScript stack (site, registry, curation, studio, demo) (agent-poc/CLAUDE.md).
- The Mock MCP Gateway serves all tool definitions with scenario-driven mock data; "agents developed against it work against production without code changes" is the stated intent (agent-poc/CLAUDE.md §"Mock MCP Gateway").
- Six mock location scenarios exist (camden-001 problem-rich, leeds-001, manchester-001, edinburgh-001, portland-001, default) (agent-poc/CLAUDE.md §"Mock MCP Gateway").

**site/ — marketing layer + developer portal (Next.js, port 3000)**
- `site/` contains two route groups: `(marketing)` (public site) and `(portal)` (gated dev portal) (site/src/app).
- The marketing homepage pitches "Fourth Performance Intelligence — The Restaurant Intelligence Platform", "Trusted by 15,000 customers worldwide", "300+ tools and 15 domains", with two CTAs: "I run restaurants" → /operators and "I build for restaurants" → /build (site/src/app/(marketing)/page.tsx).
- `/build` is the developer landing page: "MCP-compliant gateway with 200+ tools" and a three-path story — Connect your data / Consume intelligence / Author Skills — plus QuickStartCode, RateLimitsTable, SdkDownloads, BuildAgentSection components (site/src/app/(marketing)/build/page.tsx).
- A public (no-login) tool catalog exists on the marketing side, server-fetched from the gateway `/public/catalogue/tools` with 7 internal domains (`admin, platform, perf, agent, cos, intelligence, trust`) filtered out of public view (site/src/lib/tools.ts).
- A public Skill Marketplace browser exists (`/marketplace` with category, author, and skill-detail routes, ~30 components incl. performance charts, changelog timeline, certification badges, install-confirmation modal) (site/src/app/(marketing)/marketplace/, site/src/components/portal/marketplace/).
- The marketplace pulls from the real Registry service and only falls back to seed data when `REGISTRY_FALLBACK_TO_SEEDDATA=true`; the default is to surface a 503 "so it can never silently ship stale data to public traffic" (site/src/lib/registry/marketplace-source.ts header comment).
- The portal login screen is branded "Fourth MCP Portal", states "Sandbox developer portal", accepts an API key (`fp4_sandbox_...`) validated against the gateway via `/api/sessions`, and says "Sandbox keys only. Production tenant features live in the customer app." (site/src/app/(portal)/portal/layout.tsx).
- Portal navigation has exactly 5 items in 2 sections — Sandbox: FourthIQ, Tool Catalog, Playground; Connect: Sandbox Keys, Webhooks (site/src/lib/portal/constants.ts NAV_SECTIONS).
- A portal Dashboard page (HealthCards, DomainHeatmap, LiveActivityFeed, IntelligenceSummary) exists but is NOT in the nav sections (site/src/app/(portal)/portal/dashboard/page.tsx; site/src/lib/portal/constants.ts).
- The Keys page does real key lifecycle against the gateway — create with name, trust tier (T1–T4 mapped to unlimited/standard/trial), domain scopes, recipient type (internal/partner), reveal-once, revocation dialog, and a "requests" tab (PendingRequests) — but the per-key usage stats (calls today/month, top tools, daily bar chart) are `generateMockUsage()` random numbers (site/src/app/(portal)/portal/keys/page.tsx lines 49-60, 140-180).
- Trust tiers are hardcoded client-side: T1 600/min 100k/day auto-execute 0.95 … T4 10/min 1k/day auto-execute 0 (site/src/app/(portal)/portal/keys/page.tsx TRUST_TIER_INFO).
- The Webhooks page's delivery log is mock-generated (`generateMockDeliveries()`) (site/src/app/(portal)/portal/webhooks/page.tsx lines 69, 104).
- The Playground has two modes — Single Tool and Intelligence Flow (SandwichVisualizer, CodeSnippetPanel components) (site/src/app/(portal)/portal/playground/page.tsx; site/src/components/portal/playground/).
- FourthIQ is a real streaming LLM chat: the route validates the portal session, pulls the live tool catalog from the gateway (5-min cache), assembles a system prompt, and streams from `api.anthropic.com/v1/messages`; it 500s without `ANTHROPIC_API_KEY` (site/src/app/api/portal/fourthiq/chat/route.ts). It surfaces both as a full page (`/portal/iq`) and a portal-wide widget/popover (site/src/components/portal/iq/, site/src/app/(portal)/portal/layout.tsx).
- The portal proxies Anthropic's Managed Agents beta (`managed-agents-2026-04-01` header) for agents/environments/sessions/memory-stores, with a file-backed partner→resource ownership map added after a pessimistic review found cross-tenant id-guessing attacks (site/src/app/api/managed-agents/_proxy.ts; demo/src/lib/managed-agents/ownership.ts header comment).
- All portal server routes point at `MCP_GATEWAY_URL ?? 'http://localhost:5000'` — the mock gateway (site/src/app/api/tools/route.ts; site/src/app/api/portal/fourthiq/chat/route.ts).
- Only one site API route imports mock-data JSON directly (`/api/portal/skills` ← mock-data/skills.json); the rest of the portal fetches through the gateway (site/src/app/api/portal/skills/route.ts; grep of `mock-data` over site/src).

**api-docs/ — documentation hub (Docusaurus)**
- api-docs is a Docusaurus site titled "Fourth MCP Gateway — API Documentation for the Fourth Agent Platform" with `url: 'https://docs.fourth.com'` configured (api-docs/docusaurus.config.ts).
- The API reference is generated by `docusaurus-plugin-openapi-docs` from the live gateway spec at `http://localhost:5000/openapi/v1/openapi.json`; ~40 generated endpoint pages cover keys, testing keys, key requests (approve/deny), rotation/revocation, webhooks, tool catalogue, tool calls (single/batch/by-domain), analytics export, audit logs, scenarios, and MCP JSON-RPC + SSE endpoints (api-docs/docusaurus.config.ts; api-docs/docs/api/).
- Six hand-written guides exist: getting-started (5-minute curl quickstart: testing key → first tool call → explore), authentication (tiers unlimited/standard/trial, scopes `*`/`domain.*`/`domain.tool`, testing keys expiring in 90 days with `_sandbox: true`, 4-step key request workflow), mcp-protocol, rate-limits, tools, webhooks (api-docs/docs/).
- getting-started cross-links the Developer Portal at `http://localhost:3000/portal` and the OpenAPI spec for Postman/SDK generation (api-docs/docs/getting-started.md §3).
- The Docusaurus shell is unrebranded boilerplate: stock README, docusaurus.png / undraw_* images, sample markdown-page still present (api-docs/README.md; api-docs/static/img/).

**studio/ — customer-facing Skills Studio (port 3005)**
- studio's own description: "Customer-facing Skills Studio. Tenant-scoped onboarding, company-context buildup, locations, playbooks, KPIs, fiscal calendar, knowledge base, skills library and governance. Reads/writes the same filesystem store as the Fourth Intelligence Curation harness (curation/) but locks every request to the authenticated customer's tenant." (studio/package.json description).
- Studio surfaces: authored-skills editor + local drafts + per-skill reviews, skills library, skill install button, governance page, review decision panel, canary rollout controls, fleet pinning (per-skill pinning editor, policy dropdown), locations (studio/src/app/(nav)/).
- Studio's store is filesystem JSON shared with curation (studio/src/lib/_shared/store/, `data-root.ts`), with tests like `skills-root-prod-guard.test.ts` (studio/tests/).

**curation/ — internal authoring + validation harness (port 3003)**
- curation is the internal harness: "VALIDATION HARNESS — Test whether a Skill is producing good output… run the comparison, and see what difference it made — with evidence, not opinion", with sections Skills / Contexts (snapshots, variants, ground-truths) / Comparisons (baseline vs variant) / History / Calibration (human grading vs assessor) (curation/src/app/harness/page.tsx).
- curation also hosts registry operator dashboards: reviews, yanks, trust-center (incl. scope stats and audit), fleet overrides, queue status, cache invalidation (curation/src/app/api/registry/).
- CLAUDE.md pins curation as `SCOPE_LOCK=PLATFORM_INTERNAL` with a red-banner internal authoring UI (agent-poc/CLAUDE.md §"Skill Marketplace + Substrate Separation").
- curation carries substantial working-notes docs: CHOICES.md (dated decision log), LEARNINGS.md, HARNESS-LEARNINGS.md, RED-TEAM-CALIBRATION.md, ASSESSOR-CALIBRATION.md, SME-FRICTION.md, COORDINATOR-FAILURES.md (curation/).
- Storage decision: JSON files in per-customer directories, chosen over SQLite for inspectability during prototyping (curation/CHOICES.md §2026-04-29 Storage).

**skills/**
- `skills/` contains exactly one file: `skills/foundation/.gitkeep` — an empty placeholder directory (skills/foundation/.gitkeep).

**demo/ — localhost customer-experience prototype (port 3002, 445 files)**
- demo is a two-persona prototype: `(operator)` (NBA inbox, briefings, agents, knowledge-base employee chat, an ops coaching suite — bench, plays, cadences, portfolio, record) and `(admin)` (knowledge-base admin, sessions, trust-center, landing-zone vendor onboarding, external-MCP, OAS, analytics, plus a marketplace prototype) (demo/src/app/).
- demo runs on mock JSON data (~20 files: inbox-nbas, briefings, plays, portfolio, watch-agents, …) (demo/src/data/mock/).
- CLAUDE.md designates `demo/src/app/marketplace/` as the "Localhost prototype (canonical UI shape)" for the marketplace (agent-poc/CLAUDE.md §project structure).
- A real Skill Registry service exists behind the marketplace: Fastify + Azure Cosmos, "canonical store for every Skill in PerformanceOS", with substrate-isolated storage and migrations (registry/package.json; registry/src/).

## DECISIONS ALREADY MADE

- **MCP is the protocol surface of the developer platform** — the gateway is MCP-compliant (JSON-RPC + SSE endpoints documented), tools are namespaced by domain, and the portal calls itself "Fourth MCP Portal" (api-docs/docs/api/mcp-json-rpc.api.mdx; site/src/app/(portal)/portal/layout.tsx).
- **The dev portal is sandbox-only; production tenant features live in the customer app** — stated verbatim on the login screen (site/src/app/(portal)/portal/layout.tsx line 108).
- **Access management shape settled at POC level**: self-serve 90-day testing keys with `_sandbox: true` responses; production keys via a request → review → approve/deny workflow; tiers unlimited/standard/trial with per-tier rate limits; scopes at `*` / domain / tool granularity (api-docs/docs/authentication.md).
- **Public/internal split is enforced in two places**: 7 internal tool domains hidden from the public catalog (site/src/lib/tools.ts), and a hard PLATFORM_PUBLIC / PLATFORM_INTERNAL substrate boundary (two Cosmos containers, two signing keys, DAG validator rejecting cross-substrate invocation) that CLAUDE.md marks "never softened" (agent-poc/CLAUDE.md §"Substrate boundary").
- **Docs are generated from the gateway's OpenAPI spec**, not hand-maintained per endpoint — a single-source-of-truth pipeline (api-docs/docusaurus.config.ts specPath).
- **Marketplace never silently serves stale data to public traffic** — registry failure → 503 by default, seed-data fallback only behind an explicit env flag (site/src/lib/registry/marketplace-source.ts).
- **Three-path developer story** (connect data / consume intelligence / author Skills) is the framing of the /build landing page (site/src/app/(marketing)/build/page.tsx).
- **Internal authoring (curation) and customer authoring (studio) are separate apps sharing one store**, with tenant lock on the customer side (studio/package.json description; curation/src/app/harness/page.tsx).
- **JSON filesystem storage for the authoring/curation prototype**, swap-behind-interface if concurrency bites (curation/CHOICES.md §2026-04-29).

## OPEN QUESTIONS / UNKNOWNS

- **Nothing in these surfaces defines what "the Pillar 3 external developer portal" IS relative to this POC** — no doc in site/, api-docs/, studio/, curation/, or demo/ names the portal-vs-POC relationship, a production deployment target, or which surfaces graduate. Every base URL is localhost; only `docs.fourth.com` is configured as an aspiration (api-docs/docusaurus.config.ts). The Christian scope question (A0) is untouched by these sources.
- **Identity/auth for real external developers is unspecified** — portal login is bare API key in a cookie; no SSO, no org accounts, no developer registration flow beyond the key-request endpoints (site/src/app/(portal)/portal/layout.tsx; api-docs/docs/authentication.md).
- **Usage analytics are unbuilt** — analytics endpoints exist in the API docs (get-analytics, export-analytics) but the portal renders random mock usage per key; whether real per-key usage telemetry exists server-side is not shown in these surfaces (api-docs/docs/api/get-analytics.api.mdx; site/src/app/(portal)/portal/keys/page.tsx).
- **The dashboard page's status is ambiguous** — built but absent from portal nav; intentional retirement or unfinished wiring is not recorded (site/src/lib/portal/constants.ts; site/src/app/(portal)/portal/dashboard/page.tsx).
- **What fills `skills/foundation/`** is unstated — the directory is reserved and empty (skills/foundation/.gitkeep).
- **SDK reality** — /build renders an `SdkDownloads` component, but whether any SDK artifact exists is not evidenced in the surfaces read (site/src/app/(marketing)/build/page.tsx).

## CONTRADICTIONS

- **Tool counts disagree across every surface**: CLAUDE.md says the gateway "serves all 282 tools" yet three lines later annotates `GET /tools` as "All 211 tool definitions" and names a "Master spec for all 211 tools" (agent-poc/CLAUDE.md); api-docs says "211 tools across 15 domains" (api-docs/docs/getting-started.md) while CLAUDE.md lists 21 domain prefixes; the /build page says "200+ MCP tools across 15 domains" (site/src/app/(marketing)/build/page.tsx); the marketing homepage says "300+ tools and 15 domains" (site/src/app/(marketing)/page.tsx metadata). Internal drift, likely 211 = original spec and 282 = post-KB-domain reality, but no surface reconciles it.
- **Marketing claims vs the A0 honesty norm**: the homepage asserts "Trusted by 15,000 customers worldwide" as if live (site/src/app/(marketing)/page.tsx) — fiction for a localhost POC, and in tension with the LIVE / BUILT IN-REPO / DESIGNED·NEXT badge discipline of Dave's existing sponsor reporting (A0 §"Current portfolio facts"). Fine inside a demo; radioactive if any sponsor reads a POC page as a status claim.
- **Trust-tier vocabularies differ**: the portal UI uses T1–T4 with auto-execute thresholds and maps them onto only three gateway tiers (unlimited/standard/trial) at creation time — T2 has no distinct backend tier (site/src/app/(portal)/portal/keys/page.tsx line 159; api-docs/docs/authentication.md). Two taxonomies for the same concept, lossy at the seam.
- No contradiction found between these sources and A0's framing of Pillar 3 itself; the POC's interactive-sandbox shape is aligned with (not contrary to) A0's "not documentation wallpaper" demand.

## PORTAL IMPLICATIONS

- **The three-part portal vision already has a POC-grade instance of each part** — Documentation Hub = api-docs (OpenAPI-generated reference + guides), Access Management = keys/key-request/webhooks surfaces + auth docs, Tool Catalog = public marketing catalog + gated portal catalog with dependency graphs and playground. [inference] Dave's scoping conversation is therefore not "what to build" but "which of these graduate from mock-backed POC to maintained product, in what order."
- **The gap between demo-polish and production-truth is the portal-decay risk in concrete form**: real interaction flows (key creation, tool calls, IQ chat) sit on a mock gateway, random usage charts, and a boilerplate docs shell. [inference] The honest scoping move is to badge every portal surface the same way the weekly report badges work (LIVE / BUILT IN-REPO / DESIGNED·NEXT) — e.g. key lifecycle BUILT IN-REPO, usage analytics DESIGNED·NEXT — so sponsors see an interactive prototype, not a launched product.
- **The OpenAPI→Docusaurus pipeline is the strongest anti-decay asset in the repo**: docs regenerate from the gateway spec, so reference docs cannot rot independently of the API. [inference] Preserve that pipeline in any production portal; the decay risk concentrates in the hand-written guides and the marketing claims, not the generated reference.
- **Access management is the part with the clearest settled design and the biggest production gap** — the request/approve/tier/scope model is fully specified and demonstrated, but identity (who is the developer, which org, SSO) is absent. [inference] That is the first architecture question to put to Christian, since it decides whether the portal fronts Fourth's real identity stack or stays sandbox-keyed.
- **FourthIQ (docs-grounded chat over the live tool catalog) is a differentiator no static portal has** and it already works end-to-end against real Anthropic streaming. [inference] It is the strongest "strategic product surface, not wallpaper" exhibit for the sponsor conversation — and it's cheap to keep alive because it grounds itself on the same catalog the docs generate from.
- **Studio/curation/marketplace are a second, adjacent product surface (skills ecosystem), not the Pillar 3 portal itself.** [inference] Scoping should explicitly park them: the substrate-separation and registry work is real engineering, but folding skill authoring into the external portal scope would triple the surface Dave must keep alive — the exact portal-decay trap A0 warns about.
- **The POC embodies an implicit decision that the external developer product is MCP-first (tools + keys + sandbox), not REST-docs-first.** [inference] Worth surfacing to sponsors as a deliberate bet to ratify, since it shapes who the portal's audience is (agent builders and integration vendors, not generic API consumers).
