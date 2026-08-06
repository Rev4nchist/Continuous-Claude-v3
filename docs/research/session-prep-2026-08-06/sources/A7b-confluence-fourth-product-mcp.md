# Source A7b — Confluence: Fourth Product MCP (ARCH space, page 6160154633)

> Fetched 2026-08-05 via Atlassian MCP. Author: Lazar Gramatikov. Last modified: May 28, 2026.
> https://fourthlimited.atlassian.net/wiki/spaces/ARCH/pages/6160154633/Fourth+Product+MCP
> This is the official Architecture-team design page for the MCP server. Two embedded architecture diagrams did
> not render through the API (media blobs).

## Why do we need this

Fourth Product MCP server will make it easier to build and manage both internal and external (customer) AI
agents. It will allow intelligent systems to securely access and use internal data through a standardized
interface. This will help connect business systems, databases, and APIs without custom integrations. Internal
and external developers will be able to quickly extend or update agent capabilities as new tools become
available. Overall aim: faster, safer, consistent deployment of AI-driven automation across the organization
and customers.

## Plan

**Single MCP Server used for both internal and external agents.**

## v.1 — tailored toward speed of delivery and simplicity

Starting point is the existing Fourth MCP Server implementation https://github.com/fourth/MCPServer, enhanced
with support for PATs, dedicated management API, local storage and calls to downstream APIs (both real and
mock).

### Design decisions

- **Access to Fourth MCP Server is done using Personal Access Tokens (PAT).** With current security
  infrastructure (Azure Active Directory B2C or Entra) it is NOT possible to support the OAuth flows mandated
  by the MCP specification (cites csharp-sdk issue #648 and the MCP spec authorization section).
- In the interest of speed, certain actions are manual (like issuing PATs).
- To support dynamic mapping between MCP tools and downstream APIs, all APIs provide a unified request schema.

### Components

**Management API**
- REST design; for v.1 used only by Fourth employees; v.Next allows external customers.
- Maintains: PATs and scopes per customer; mapping between MCP tools and downstream APIs; credentials for
  calling downstream APIs; catalogue of all available MCP tools.
- Secured using access tokens issued by Fourth (same security as iq360 multi-tenant implementation).

**Local storage** — relational (Azure SQL Database):
- Secure PAT storage (hashed); catalogue of all available scopes; tools registry.
- v.Next: audit of all PAT actions (issue, invalidate, etc.).
- Referential integrity maintained between tool catalogue, scopes, and scope-to-PAT assignments.

### Personal Access Tokens

- Issued **manually via API call for v.1**. v.Next: Management UI or a dedicated MCP tool.
- PATs support scopes based on available MCP server tools.
- **Scopes are limited to products owned by customers** (e.g. no Fuego earned-wage-access tools if the customer
  does not use Fuego). v.1: scopes selected manually by Fourth. v.Next: dynamic, based on customer entitlements
  (links to the TechInfo entitlements page).
- v.1 scopes cover ALL locations; v.Next can scope to specific locations.
- **The MCP server exposes only tools linked to the specific PAT** — one customer with two PATs (different
  scope sets) sees two different tool lists.
- **PATs are immutable once created** (need different scopes → create a new PAT). They have an expiration
  date/time and an active/inactive flag (the one editable property). Tool calls (list and invoke) check both.
- Stored hashed.

**PAT format** (based on kerkour.com/api-keys and vjay15.github.io/blog/apikeys):
`frthcv1_` prefix ("fourth customer" + version) + base32-encoded string (double-click selectable) + crc32
checksum. Example: `frthcv1_60rkjs1s6rs68bb565hp6b9qcct6ab9scgt64b9k6shkce1qcnjk6sb3c87cb4fa6d` (last 8 chars =
checksum). .NET lacks a built-in base32 encoder; uses a Crockford base32 implementation.

### Tools Registry

For each exposed tool: required scopes; which downstream API endpoint to call + credentials; the downstream
endpoint's request schema.

### Downstream APIs — five categories

1. Existing APIs already used in Fourth MCP Server (e.g. iQ alerts and actions) — stay as-is.
2. Existing APIs built to support Decision Engines — extended as needed (built with future agents in mind).
3. New dedicated APIs — completely new, or new endpoints in existing DE APIs, built to support MCP tools.
4. Mock APIs — placeholders enabling parallel development; replaced over time.
5. Reference information and search APIs — e.g. locations use canonical IDs, but no customer asks "show me next
   week's schedule for location 001UB000006MCgeYAG"; they ask "for Bedford" → dedicated search-by-name APIs
   return proper IDs.

### Downstream design guidelines

- All agentic support endpoints secured with **basic authentication (mandatory TLS)**.
- **All requests use POST**, even where GET is more natural.
- Endpoint schema governed by the Architecture team (as with the Orchestration model) — uniform naming and
  platform-level identifiers.
- All IDs are canonical: customer / location / user canonical IDs.
- Full spec: https://github.com/fourth/MCPServer/blob/main/docs/mcp-backend-tool-endpoint-spec.md

### Mock APIs

Can be a single API with many endpoints; same design + auth as real ones; mock data in Azure Blob storage.

## Why not a commercial MCP/Agents gateway?

Reviewed: agentgateway.dev, Azure API Management GenAI gateway, microsoft/mcp-gateway. All allow proxying REST
APIs but do NOT allow custom tool definitions, and none allows API-key/PAT-based dynamic tool selection.
(microsoft/mcp-gateway dismissed as an abandoned one-person project.) May change in future
(agentgateway + cerbos).

## Security checks

Tools like snyk/agent-scan can be used to scan the implementation.

## Platform + deployment

- Fourth MCP Server and Management API: **C# / .NET 10**, Fourth best practices.
- Deployed in **Kubernetes** — each component has its own deployment, service, ingress.
- SQL Server: Azure SQL Database, managed via Terraform.

## v.Next (customer-feedback driven; potential options)

- Support for Fourth Platform IdP.
- Metrics (tool calls etc.) via OpenTelemetry or similar, exported to iq360 feature events.
- A Fourth-managed MCP Registry (modelcontextprotocol.io/registry).

## Tools registration with Octopus Deploy

Referenced: https://fourthlimited.atlassian.net/wiki/spaces/ARCH/pages/6287425565

## Implications worth carrying (analysis, not source text)

- This page ANSWERS several questions the Toma session left UNANSWERED — notably: hosting (Kubernetes + Azure
  SQL), why no OAuth (Entra/B2C cannot support MCP-mandated OAuth flows → PATs), PAT lifecycle rules
  (immutable, expiring, active-flag, hashed, manual issuance in v.1), scope model source of truth, and the
  registry's三-part record (scopes, endpoint+credentials, schema).
- It CONFIRMS the known gap shape: v.1 PAT issuance is manual and employee-only via the Management API; the
  "anyone who knows the token-acquisition APIs can obtain a token" POC gap coexists with this design.
- Key tension for the portal: v.1 explicitly defers external self-serve (Management API "v.Next allows external
  customers") — the portal's Access Management pillar is effectively the productization of v.Next.
