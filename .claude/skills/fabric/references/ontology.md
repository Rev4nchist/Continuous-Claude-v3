# Fabric IQ ontology (new TMDL experience)

CCv3-authored from the Fabric course extraction (`docs/research/fabric/2026-10-04-fabric-course-extraction.md`,
rule ids G-NN, C-NN) and Microsoft Learn. Upstream skills-for-fabric has `fabriciq-ontology-cli`, but it
authors the old experience, which retires on 2027-01-31. CCv3 does not vendor it. Do not copy its
`entityIdParts` JSON tree.

Each line names its source: "Learn", "measured" (a live test on one tenant) or "unverified" (the LT-NN id
names the planned test). The graph calls and the item counts are measured; the rest is Learn or
unverified. Ontology is a preview feature (G-46, Learn).

## Contents

- [Never](#never-these-lines-win-over-learn-text-and-samples)
- [Check first](#check-first)
- [Generate, define and deploy](#generate-define-and-deploy)
- [Keys and relationships](#keys-and-relationships)
- [Graph and cost](#graph-and-cost)
- [Data agent on an ontology](#data-agent-on-an-ontology)
- [Known gaps](#known-gaps)

## Never: these lines win over Learn text and samples

1. On HTTP 429 or 430, or "capacity has exceeded its limits": stop all load and report. Do not retry.
2. Never press "Generate ontology", create an ontology or save a schema change before you count the
   workspace's graph items. An ontology may add a managed graph, and each graph refresh uses capacity
   (G-49, X-01). On an F2 that holds a graph already, ask the owner first.
3. Never change a data agent or call the ontology MCP endpoint as a service principal. Use a signed-in
   user (G-55, Learn; L-25 measured a 401 for agent management).
4. Never score ontology or agent answers with an LLM judge. Compare them with rule-based SQL (L-14).

## Check first

Run these read-only checks before any authoring step. Stop and report if one fails.

- The tenant settings "Users can create ontology (preview) items" and "Users can create Fabric items" are
  on. The second one is required for the new experience (G-46, Learn). An admin finds them in OneLake
  catalog > Govern > Configurations > Tenant settings.
  Learn: https://learn.microsoft.com/fabric/iq/ontology/overview-tenant-settings
- The caller has Read and Build on each semantic model it generates from (G-47, Learn).
- Count the workspace items by type: `GET https://api.fabric.microsoft.com/v1/workspaces/<workspaceId>/items`,
  then count `GraphModel`, `Ontology` and `DataAgent`. Save the counts. Count again after the step.
- For an existing ontology, read its definition with `POST .../ontologies/<ontologyId>/getDefinition`.
  Learn has no version flag: the definition format is the only signal. TMDL parts (`.platform`,
  `database.tmdl`, `model.tmdl`, `namespaces/default.tmdl`) mean the new experience. JSON
  (`definition.json`, `EntityTypes/<id>/definition.json`) means the old experience: say so and do not
  edit it with these rules. Learn: https://learn.microsoft.com/rest/api/fabric/articles/item-management/definitions/ontology-definition#supported-formats

## Generate, define and deploy

- Learn: https://learn.microsoft.com/fabric/iq/ontology/how-to-generate-from-semantic-models
- Generation from a semantic model makes entity types, properties, bindings, relationship types and
  metrics. Then review the keys, bind the relationship types and rename by hand (G-48, Learn).
  Unverified: whether generation from a model is possible by REST. The course uses the portal.
- Create: `POST https://api.fabric.microsoft.com/v1/workspaces/<workspaceId>/ontologies`. Change:
  `POST .../ontologies/<ontologyId>/updateDefinition`. Both are long-running operations: poll with a cap
  (G-51, Learn). REST: https://learn.microsoft.com/rest/api/fabric/ontology/items/create-ontology
- The new experience is the default for new items in the portal. By REST, the definition you send picks
  the experience: TMDL parts make a new-experience item, a JSON definition makes an old one. Always send
  TMDL. The smallest TMDL definition is `.platform` plus `database.tmdl` (Learn).
  Learn: https://learn.microsoft.com/fabric/iq/ontology/overview#migrate-from-old-experience
- Export: `getDefinition` returns the TMDL. Git integration and deployment pipelines also work (C-09, Learn).
- Put context into the definition: `///` descriptions, `synonym` lines and a `resourceLink` with an
  `item` (G-54, Learn).
- Batch schema changes into one save. Each schema change re-ingests all bound data. A change in the
  source data needs an explicit graph refresh (G-50, Learn).
- Ontology create and update accept a service principal, but agent management and the ontology MCP
  endpoint do not (T-13 lesson, G-55, Learn). Keep one identity: a signed-in user.

## Keys and relationships

- Give each entity one `keyProperty` of type string or integer. A list of keys or a repeated
  `keyProperty` line is rejected (G-52, C-14, Learn). For a composite key, build one concatenated key
  column in ETL, for example `SalesLineKey = SalesOrderNumber + '#' + SalesOrderLineNumber`.
  The portal tutorial multi-selects two key columns. Use one column for REST and TMDL.
- Back an ontology relationship with a TOM relationship from the semantic model, or with a junction
  table that backs no entity. A junction table that also backs an entity fails with
  `BackingTableBoundMoreThanOnce` (G-53, C-08, Learn). The course binds through the fact table that
  backs the sales entity: that pattern fits only the old experience.

## Graph and cost

- Learn pages disagree on whether every ontology creates a managed graph item (C-13). The glossary and
  old-experience pages say yes. The new-experience overview says graph materialization is opt-in and
  off by default. Unverified (LT-07, then LT-16): count graph items before and after.
  Learn: https://learn.microsoft.com/fabric/iq/ontology/resources-glossary
- Where a graph exists, a save re-ingests it and a refresh uses capacity (G-49, G-50, Learn).
- Graph calls, measured on the FourthCompanyBrain tenant (`docs/playground/fabric/iq.py` in that repo):
  - Create: `POST https://api.fabric.microsoft.com/v1/workspaces/<workspaceId>/graphModels` with the
    definition. A new graph starts its own first refresh job: wait for it before you start another.
  - Change: `POST .../graphModels/<graphId>/updateDefinition`.
  - Refresh: `POST .../graphModels/<graphId>/jobs/refreshGraph/instances`. Poll the `Location` job URL
    with a cap. Read the recent job instances first: one Fabric job at a time on an F2.
  - Query: `POST .../graphModels/<graphId>/executeQuery?beta=true` with `{"query": "<GQL>"}`. `beta`
    means it can change.
  - At most one graph in a workspace: each graph holds a cache billed every day (playbook, L-08). Delete
    it once its evidence is saved, as the owner decides.
  - A capacity pause drops a graph's loaded data: queries return HTTP 500 until a refresh. A graph is not
    a snapshot: a refresh reads the current tables (L-09).
  - On HTTP 429 from `executeQuery`: stop and report (never-line 1). Do not wait and ask again.
- GQL means Graph Query Language (ISO), not GraphQL (G-63, C-11, Learn).
  Learn: https://learn.microsoft.com/fabric/graph/gql-language-guide

## Data agent on an ontology

- Agent query, publish and SDK rules: `references/data-agent.md`.
- Learn: a data agent does not work with an ontology that binds its data through semantic models. Bind
  the entities to lakehouse or warehouse tables when an agent will use the ontology.
- Enable the tenant setting "Data agent item types (preview)". Add the agent instruction
  `Support group by in GQL`: Learn gives it as a workaround for a known aggregation issue. Expect query
  failures for the first few minutes after the agent is created (G-56, Learn).
  Learn: https://learn.microsoft.com/fabric/iq/ontology/how-to-create-data-agent#provide-agent-instructions
- An ontology-backed agent writes GQL or SQL, not DAX (G-61; the course says so, Learn does not).
- Data agents and the ontology MCP server need a paid F2 or higher. A trial does not support data agents
  (G-57, Learn).

## Known gaps

- Measured 2026-10-04 (LT-07, intake stage d): the playground workspace held GraphModel 0, Ontology 0,
  DataAgent 1. This is the "before" count for any ontology step there. C-13 stays open until LT-16.
- Not measured yet: LT-08 (an existing ontology definition: none exists). Write tests LT-16 and LT-17
  each need the owner's yes.
- Whether the new experience can generate an ontology from a model by REST is not documented.
