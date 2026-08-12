# D2 Digest — Platform docs: MCP server design, tool estate, live Management API

Sources: A7b (Confluence ARCH "Fourth Product MCP", Lazar Gramatikov, last mod 2026-05-28), A7a (Confluence TechInfo "Fourth MCP Tools", Steve Lewins, last mod 2026-07-29), A6 (live Management API OpenAPI v1, fetched 2026-08-05 from mcp-qai.fourth.com). A7b is a design page (POC/v.1-stage intent); A6 is the LIVE deployed surface on QAI; A7a is live estate tracking.

## FACTS

- One MCP server serves both internal and external (customer) agents — the stated plan is a single server, not separate internal/external servers (A7b §Plan).
- v.1 is explicitly "tailored toward speed of delivery and simplicity," building on the existing `fourth/MCPServer` GitHub repo (A7b §v.1).
- Access is via Personal Access Tokens because Azure AD B2C/Entra cannot support the OAuth flows the MCP spec mandates (cites csharp-sdk issue #648) (A7b §Design decisions).
- PAT design: manually issued via API call in v.1; scoped to products the customer owns; v.1 scopes cover ALL locations; immutable once created (new scopes = new PAT); expiration date/time plus an active/inactive flag described as "the one editable property"; stored hashed (A7b §Personal Access Tokens).
- PAT format: `frthcv1_` prefix + Crockford base32 string + crc32 checksum (last 8 chars) (A7b §PAT format).
- The MCP server exposes only tools linked to the presenting PAT — same customer, two PATs with different scope sets → two different tool lists; both list and invoke check expiry and active state (A7b §Personal Access Tokens).
- Management API is REST, employee-only in v.1 ("v.Next allows external customers"), secured with Fourth-issued access tokens (same security as iq360 multi-tenant) (A7b §Components — Management API).
- Storage is Azure SQL Database (relational): hashed PATs, scope catalogue, tools registry, referential integrity; PAT-action audit is deferred to v.Next (A7b §Local storage).
- Tools Registry records per tool: required scopes, downstream endpoint + credentials, and the endpoint's request schema (A7b §Tools Registry).
- Downstream APIs fall in five categories: existing MCP-used APIs, Decision Engine APIs, new dedicated APIs, mock APIs (Azure Blob mock data), and reference/search-by-name APIs ("for Bedford" → canonical ID) (A7b §Downstream APIs).
- Downstream design guidelines: basic auth + mandatory TLS on all agentic support endpoints; all requests POST; canonical customer/location/user IDs; schema governed by the Architecture team; full spec in `fourth/MCPServer/docs/mcp-backend-tool-endpoint-spec.md` (A7b §Downstream design guidelines).
- Commercial gateways (agentgateway.dev, Azure APIM GenAI gateway, microsoft/mcp-gateway) were reviewed and rejected: none supports custom tool definitions or PAT-based dynamic tool selection; microsoft/mcp-gateway dismissed as an abandoned one-person project (A7b §Why not a commercial gateway).
- Stack/deployment: C#/.NET 10; Kubernetes with per-component deployment/service/ingress; Azure SQL via Terraform (A7b §Platform + deployment).
- v.Next candidates: Fourth Platform IdP support, OpenTelemetry metrics into iq360 feature events, a Fourth-managed MCP Registry (A7b §v.Next).
- Live server URLs: MCP Server at https://mcp-qai.fourth.com (QAI) and https://mcp.fourth.com (EMEA); Admin API at the same hosts under `/admin/` (A7a §MCP Server Access Details).
- The tool estate spans at least 9 domain sections: PLATFORM, FOURTH 360, PERFORMANCE OS, HR, PAYROLL, LP, INVENTORY, TRADE SIMPLE, MANAGER iQ (A7a §Master List).
- Official four-state deployment legend per tool: deployed+real data / deployed+mock data / deployed+erroring / not yet deployed to production (A7a §Status legend).
- The master tool list was compiled from Christian's original JSON files of mocked tools at `fourth/MCPServer/ap-input-data/tools` (A7a §Master List).
- The Management API is LIVE on QAI with 25 endpoints across 5 tags: Customers, CustomerScopes, PersonalAccessTokens, Scopes, Tools (A6 §Endpoints).
- Live PAT lifecycle surface: POST create (required: `scopes`; optional tokenType, name, expirationDateTimeUtc), GET by id, GET all for customer, GET for customer+user, DELETE "(revokes)" by id (A6 §Endpoints; verified in openapi.json paths `/personal-access-tokens*`).
- The plain-text token value is "only returned once, in the response to a create request"; thereafter only a masked `preview` (e.g. last 4 chars) is available (A6-openapi.json `CreatePersonalAccessTokenResponse`).
- Live tool registration is full CRUD over HTTP: POST/PUT/DELETE `/tools`, plus scope CRUD and PUT `/scopes-tools` to assign a scope to a tool (A6 §Endpoints).
- `ToolModel` requires name (≤256), description (≤4096), apiInputSchema/apiOutputSchema (JSON schema, ≤6144 each), authenticationType ("Valid values: OAUTH, BASIC"); optional apiUri and apiDemoUri ("used when the primary URI is absent") (A6-openapi.json `ToolModel`).
- Per-customer entitlement is live: GET customer tools/locations/PATs, POST/DELETE `allowed-scopes`, PUT configuration (status + isDemoCustomer); customer status values ACTIVE/TERMINATED; scope names capped at 32 chars (A6 §Endpoints; A6-openapi.json `CustomerModel`, `ScopeModel`).
- Every Management API endpoint requires Bearer JWT (A6 §Security schemes) — consistent with A7b's "Fourth-issued access tokens" design.
- `apiDemoUri` in the live ToolModel structurally implements A7b's mock-API category: a tool can carry a demo endpoint used when the real one is absent (A6-openapi.json `ToolModel`; A7b §Mock APIs).

## DECISIONS ALREADY MADE

- Single MCP server for internal + external agents (A7b §Plan).
- PATs, not OAuth, as the customer auth mechanism — grounded in an Entra/B2C limitation, not preference (A7b §Design decisions).
- Manual, Fourth-employee-only PAT issuance and scope selection in v.1; external self-serve deferred to v.Next (A7b §Components; §Personal Access Tokens).
- Build in-house rather than adopt a commercial MCP gateway (A7b §Why not a commercial gateway).
- Scope model = product entitlements (customer sees only tools for products they own); dynamic entitlement-driven scoping deferred to v.Next (A7b §Personal Access Tokens).
- Uniform downstream endpoint contract (POST-only, basic auth + TLS, canonical IDs, Architecture-governed schema) (A7b §Downstream design guidelines).
- Stack: C#/.NET 10, Kubernetes, Azure SQL + Terraform (A7b §Platform + deployment).
- Tool definitions are registry-driven data (schema + endpoint + scopes), not code — confirmed shipped in the live `/tools` CRUD (A7b §Tools Registry; A6 §Endpoints).
- Tool-estate tracking lives on the TechInfo Confluence page as a read-only view over per-domain pages, with the four-state deployment legend (A7a §Master List).

## OPEN QUESTIONS / UNKNOWNS

- Who may call the live Management API today — which Fourth roles/JWT audiences get Bearer tokens, and whether any approval workflow gates PAT creation. The spec shows only "Bearer JWT"; no RBAC detail (A6 §Security schemes).
- How GET `/personal-access-tokens` "for a specific customer and user" identifies the customer and user: the live operation declares NO parameters — presumably derived from the caller's JWT, but the spec doesn't say (A6-openapi.json `GET_PERSONAL_ACCESS_TOKEN_BY_CUSTOMER_AND_USER`).
- `CreatePersonalAccessTokenRequest` carries no customerCanonicalId — how a PAT binds to a customer at creation is not visible in the spec (A6-openapi.json `CreatePersonalAccessTokenRequest`).
- `TokenType` and `CustomerStatus` are bare integers with no enum values documented (A6-openapi.json §Schemas).
- Actual per-tool deployment states (which tools are green/orange/pink/white) — the per-domain tables are live includes that did not render via the API (A7a fetch note).
- The two architecture diagrams on the design page did not render (media blobs) (A7b fetch note).
- v.Next scope, sequencing, and timeline: "customer-feedback driven; potential options" — nothing committed (A7b §v.Next).
- PAT-action audit trail: explicitly deferred to v.Next, so v.1 has no stated audit of issue/invalidate actions (A7b §Local storage).
- Metrics/usage telemetry: no live endpoint or shipped mechanism; OpenTelemetry-to-iq360 is a v.Next option only (A7b §v.Next; absent from A6 §Endpoints).
- How Octopus Deploy tool registration relates to the live `/tools` CRUD — the referenced Confluence page (6287425565) was not fetched (A7b §Tools registration with Octopus Deploy).

## CONTRADICTIONS

- **Active/inactive flag: design vs live API.** A7b says a PAT has an active/inactive flag as "the one editable property" and that tool list/invoke checks it (A7b §Personal Access Tokens). The live API exposes NO endpoint to edit a PAT (no PUT/PATCH) and `PersonalAccessTokenResponse` has no active field; the only lifecycle operation is DELETE "(revokes)" (A6 §Endpoints; A6-openapi.json `PersonalAccessTokenResponse` — verified by reading the schema). Either the flag was dropped in favor of hard revoke, or it exists internally without an API surface.
- **Downstream auth: basic-only vs OAUTH|BASIC.** A7b mandates "all agentic support endpoints secured with basic authentication" (A7b §Downstream design guidelines), but the live `ToolModel.authenticationType` documents "Valid values: OAUTH, BASIC" (A6-openapi.json `ToolModel`) — the shipped registry is broader than the design guideline.
- **Admin host/protocol.** A7a gives the Admin API as https://mcp-qai.fourth.com/admin/ (A7a §Access Details); the OpenAPI `servers` field says http://mcp-admin-qai.fourth.com/ — different hostname and plain http (A6 header note). Likely an internal-ingress artifact, but the docs disagree as written.
- **Immutability vs the known POC gap.** A7b itself acknowledges (in the source's carried analysis) that the "anyone who knows the token-acquisition APIs can obtain a token" gap coexists with the manual-issuance design (A7b §Implications) — consistent with A0's portal-decay/security framing, and confirmed structurally by A6: PAT creation requires only a Bearer JWT and a scopes array, with no visible approval step (A6-openapi.json `POST_PERSONAL_ACCESS_TOKEN`).
- Otherwise the live API matches the A7b design closely (PATs + scopes + tools registry + customer entitlement + Bearer-secured management): no further contradictions found.

## PORTAL IMPLICATIONS

- **The lifecycle machinery the portal needs already exists as an API.** PAT create/revoke, scope grant/revoke per customer, tool catalogue with input/output schemas — all live on QAI (A6). [inference] The portal's Access Management pillar is largely a UI + policy layer over this existing surface, not new platform work; Dave can scope the portal as "productize the Management API for external self-serve," which A7b explicitly names as v.Next ("v.Next allows external customers").
- **The tool catalogue is self-documenting.** Every registered tool carries a name, ≤4096-char description, and JSON input/output schemas (A6 `ToolModel`). [inference] Portal reference docs can be GENERATED from GET `/tools` + GET `/scopes` rather than hand-written — this is the single strongest lever against A0's portal-decay risk: docs that render from the live registry cannot go stale independently of the product.
- **The four-state deployment legend must surface in the portal.** The estate officially contains mock-data, erroring, and undeployed tools (A7a §Status legend). [inference] An external portal that lists tools without their real/mock/error status would misrepresent the platform; conversely the legend is a ready-made honesty badge system aligned with the fourthos-weekly LIVE/BUILT/DESIGNED convention (A0 §Current portfolio facts).
- **PAT UX constraints are fixed by design.** Immutable tokens, one-time plain-text display, masked preview thereafter, expiry (A7b; A6 `CreatePersonalAccessTokenResponse`). [inference] Portal token UX should copy the GitHub-PAT pattern: show-once + copy, rotation via create-new-then-revoke, expiry warnings. The design/live divergence on the active flag (see Contradictions) needs an answer from Lazar's team before the portal commits to a "disable token" affordance — today only hard revoke exists.
- **No usage telemetry exists yet.** Metrics are v.Next-optional (A7b §v.Next) and absent from the live API (A6). [inference] A0's mandate says the portal needs feedback loops; Dave should flag telemetry as a platform dependency the portal cannot supply alone — without tool-call metrics there is no adoption feedback loop to keep the portal alive.
- **Self-serve is gated on identity, not on portal effort.** The PAT/no-OAuth decision stems from an Entra/B2C limitation, and Fourth Platform IdP support is v.Next (A7b). [inference] The portal's v1 should assume manual, Fourth-mediated onboarding (request-a-token flow, human in the loop) and treat true self-serve as a roadmap item contingent on the identity platform — a clean scope boundary to present to Christian.
- **POC-vs-production framing for the sponsors.** The Management API is live but its spec still shows POC-stage seams (undocumented enums, parameterless customer/user lookup, no audit trail, no RBAC detail) (A6; A7b §Local storage). [inference] Dave can honestly present the platform as "live plumbing, pre-production governance" — the portal roadmap should sequence governance-critical gaps (audit, approval workflow, token-acquisition lockdown) ahead of cosmetic doc work.
