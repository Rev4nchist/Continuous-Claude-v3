# Source A5 — External Developer Portal (FourthOS Projects row)

> Fetched 2026-08-05 from Notion page `3ad76fd7ac82817e8cb0f0e951a69dfa` (FourthOS Projects DB).
> Status: **Shape** · Health: **Yellow** · Decision Needed: **YES** · Pillar: External Developer Experience.

## Latest Update (2026-07-29)

Toma Busarov (Principal Architect) knowledge-transfer session held. Net position: the MCP server's shape and
token model are understood, the scope is not. Two corrections to the prior working assumption. (1) The MCP
server already exists and is being actively developed by Engineering — the likely expectation, as Toma read it,
is that Dave defines and builds the developer-portal EXPERIENCE, not the server; Christian has not confirmed
this. (2) The portal is not greenfield: Christian's "Otto" POC (marketing page, tool catalog with per-tool
playground, chat workspace that auto-injects internal + configured external MCPs), the Performance Intelligence
portal prototype, the Fourth360 developer/API-configuration section (API keys, MCP keys, webhooks, activity
stats — still a raw prototype) and, per the docx record, token management and provisioning interfaces all
already exist. Most of the POC is migrated and being built out by Vance, Cisco and others, some tools on
partial mock data and, per Toma, not all work reliably — a direct constraint on any portal tool catalog or
playground, and on persona testing (a failed sample call may be the tool, not the credentials). Architecture as
described: a tools registry (a database) that both lists tools and routes each request to the correct backend
API endpoint; most backend APIs newly created because adapting existing ones proved too complex; C#/.NET on
Microsoft's maintainer package — stable, no built-in metrics, more standards-compliant than Christian's
original POC, which Claude analysed as non-compliant with the MCP protocol; plus a separate market API built at
Christian's request. Naming standardised from tool.name to tool_name after client-compatibility problems, with
ADRs now in the repo. Progressive tool discovery already implemented by Engineering against a count discussed
as roughly 300+. One pre-production gap logged separately for Christian + Engineering: at POC stage anyone who
knows the token-acquisition APIs can obtain a token — named next step is a session with Michael and Christian
on user provisioning. Blocker unchanged: the portal boundary, settable only by Christian; Dave to call him
2026-07-30 (action item, not a booked slot). Note the two records disagree on whether Fourth360 and
PerformanceOS are the same surface — unresolved, and it matters to where the boundary is drawn.

## Current Focus

Scope definition is the work. After the 2026-07-29 Toma session the MCP server's shape and token model are
understood — registry-based tool routing, C#/.NET on Microsoft's MCP package, basic auth to backend APIs,
customer-wide vs user-scoped tokens with scopes filtered at both customer and token level. What is still
unsettled, across multiple meetings, is the boundary: what belongs to the Developer Portal vs the Fourth360 /
PerformanceOS front-end already in build (Vance, Cisco and others) vs the Landing Zone / Integration Hub. Only
Christian can set that line. Going into the 07-30 call with Toma's three-part reading of Christian's vision as
a proposal to confirm, narrow or reject — Documentation Hub, Access Management, Tool Catalog — rather than a
blank sheet. Not covered by the session and still uncollected: the developer onboarding journey itself (steps
to a first successful tool call, sandbox vs production data, documentation ownership), so no portal content
decision should be made off it yet.

## Next Milestone

Christian's scope answer captured in writing, sent back to him, and acknowledged — not "meeting happened". Four
checks: (1) scoping call held (target 2026-07-30) with his answer recorded to one question — is the portal
primarily a documentation and onboarding experience, or the customer-facing operational control centre for MCP
integrations, token management and tool discovery; (2) boundary written down across Developer Portal /
Fourth360-PerformanceOS / Landing Zone, including whether the portal mirrors the API-key and webhook config
already prototyped in Fourth360, how much token management is exposed vs automated, and how delegated
consultant administration works; (3) Dave's written statement of Christian's vision sent and confirmed at the
following week's session; (4) persona-test access in hand — MCP server repo link, both hosted app links + API
keys, Confluence space access, QAI MCP server URL with its demo/testing and market-only keys — then one sample
authenticated tool call replayed (MCP Inspector is the existing path). Milestone fails if the scoping call
happens and the boundary is still verbal.

## Strategic Bet

The portal is a maintained product surface that reinforces Fourth's position as a platform external developers
and partners want to build on — carrying them from discovery through productive integration, with feedback
coming back — rather than a documentation deliverable that ships once. Treating it as static documentation
would forfeit the pillar's whole point, and is the standing Portal-decay risk chosen rather than drifted into.

## Sponsors / Stakeholders

Christian Berthelsen (CTO) — assigned the portal, owns the scope decision that currently blocks it. Toma
Busarov (Principal Architect) — described the MCP server architecture and auth model. Michael — user
provisioning; joint session with Christian pending. Carly Hodges (VP Enterprise Transformation & Technology) —
mandate sponsor. Vance, Cisco and others — building out the migrated POC in Fourth360 / PerformanceOS. Nisha
(verify spelling) — prepared test queries and scenarios; outreach pending. Mark, Balaji — named for a dedicated
MCP server architecture discussion.

## Body — gaps this row must NOT be read as having closed

- **Onboarding audit, entirely.** Steps + elapsed time to a new vendor's first successful tool call; sandbox vs
  production; documentation beyond Confluence tool lists and who maintains it; where developers get stuck;
  self-diagnosis of a failed call.
- **Auth internals.** Key issuance, rotation, revocation; identity provider(s); OAuth 2.1 / PKCE /
  token-exchange patterns; who can mint full-access keys; the developer-visible failure mode. The token MODEL
  is understood; the internals are not. Do not conflate.
- **Registry lifecycle.** Self-serve vs gated registration; versioning/deprecation; canonical-ID problem; where
  the ~380-tool spec lives and what share is live (300+ is a count, not the spec).
- **Landing zone and external trust.** Built vs planned registration of external vendors; playbook-retrieval /
  compliance-check API; session recording/replay for managed agents; whether MCP access requires an iQ
  subscription.
- **Hosting and gateway topology.** Not stated; the records give language and framework only.

## Open items Dave owes

- Articles on MCP architecture + context-window concerns at large tool counts → Toma.
- Written description of the Search Discovery Router Script approach → Toma (input to Engineering's discovery
  work, not portal scope).
- CodeRabbit licence ask — no owner assigned.
