# Source A7a — Confluence: Fourth MCP Tools (TechInfo space, page 6506938371)

> Fetched 2026-08-05 via Atlassian MCP. Author: Steve Lewins. Last modified: Jul 29, 2026.
> https://fourthlimited.atlassian.net/wiki/spaces/TechInfo/pages/6506938371/Fourth+MCP+Tools
> NOTE: the per-domain tool tables on this page are live INCLUDES from other Confluence pages (HR, Payroll,
> Fourth 360, etc.) and did NOT render through the API — the master list below shows section headings only.
> The color legend and access details DID render and are the load-bearing facts.

This page details the Fourth MCP tools — who owns each tool (in terms of building) and the state of each tool
in terms of deployment and testing.

## MCP SERVER ACCESS DETAILS

MCP Server:
- QAI — https://mcp-qai.fourth.com
- EMEA — https://mcp.fourth.com

MCP Admin API:
- QAI — https://mcp-qai.fourth.com/admin/
- EMEA — https://mcp.fourth.com/admin/

## MASTER LIST

Details of Fourth MCP tools (not just those set up for PE demo).

The list was compiled from the original list of JSON files (of mocked tools) from Christian, at:
https://github.com/fourth/MCPServer/tree/main/ap-input-data/tools

Each section pulls source data from its respective page (HR from the HR page, Payroll from the Payroll page,
Fourth 360 from the Fourth 360 page, etc.) — updates are made on those pages; this list is a read-only view.

**Status legend (deployment reality of the tool estate):**
- Green background = deployed and working with real data
- Orange background = deployed and returning mock data
- Pink background = deployed and has errors
- White background = not yet deployed to production

**Domain sections (tables not rendered via API):** PLATFORM · FOURTH 360 · PERFORMANCE OS · HR · PAYROLL · LP ·
INVENTORY · TRADE SIMPLE · MANAGER iQ

## Implications worth carrying (analysis, not source text)

- The tool estate spans at least 9 domain sections.
- The four-state legend confirms Toma's "tool quality is uneven / some tools on partial mock data" statement at
  the estate level: the official tracking page itself distinguishes real-data vs mock-data vs erroring vs
  undeployed tools.
- The MCPServer repo (`fourth/MCPServer`) is the tool-definition source of truth (`ap-input-data/tools`).
