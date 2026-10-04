<!-- Provenance: copied 2026-10-04 by the continuous-claude session from
     FourthCompanyBrain/.claudedocs/2026-10-04-fabric-course-extraction.md (written by session
     fourthcompanybrain-04). Source course: https://www.youtube.com/watch?v=fkrcJuOIs9A (Pragmatic Works).
     Paraphrase only; quotes are 15 words or fewer. Kept: sections 0, 3a, 3c, 3d, 4, 5, 6.
     Left out: 1 (outline), 2 (extraction table), 3b (tenant lessons, kept in FourthCompanyBrain).
     Phase 5 plan: C:/Users/david.hayes/.claude/plans/rosy-munching-reef.md -->

# Fabric course extraction: Fabric Beginner To Pro (Pragmatic Works)

- Source: https://www.youtube.com/watch?v=fkrcJuOIs9A ("Free Live Course: Fabric Beginner To Pro", Pragmatic Works)
- Presenters: Zayn Goodman (trainer; "Zane" in the video description) and Mitchell Pearson (moderator)
- Published: 2026-09-17. Duration: 2h24m47s.
- Extracted: 2026-10-04, by fourthcompanybrain-04 for the Fabric skills owner.
- Method: auto captions through yt-dlp (android_vr client); four chunk extracts; spot checks against the full transcript; every rule, endpoint and command checked on Microsoft Learn with `docs/playground/mslearn.py` (search and fetch), read 2026-10-04.
- Copyright: paraphrase only. Quotes are 15 words or fewer. Timestamps are `[HH:MM:SS]`.
- Source weight: a course video is a weak source. A rule with a Learn link is confirmed by Learn. A rule tagged `[course-only]` has no Learn backing.
- No Fabric tenant call was made for this file.

## 0. Summary

- The course builds one flow in the portal only: copy job, lakehouse with schemas, OneLake table shortcuts (bronze), Dataflow Gen2 (gold), a Direct Lake semantic model, a generated ontology, and a data agent on the ontology.
- Most portal steps have a Learn-confirmed REST route (copy job, lakehouse, shortcuts, Dataflow Gen2 items and refresh, semantic model, ontology definition). Portal-only by Learn: Dataflow Gen2 data destinations, the SQL endpoint access-mode switch (L-11), and take over of Fabric items. Unknown: ontology generation from a model by REST, the shortcut delegated flag by REST, and the admin "add self to workspace" API.
- Highest-value new facts: REST lakehouse creation has schemas OFF by default; List Tables returns HTTP 400 on schema-enabled lakehouses; Dataflow Gen2 APIs refuse service principals; ontology has a TMDL REST definition (`/ontologies`) with a single `keyProperty`.
- Ontology cost: Learn pages disagree on the graph (C-13). The glossary and old-experience pages say each ontology creates a managed graph child item. The new-experience overview says graph materialization is opt-in and off by default. Count graph items before and after any ontology step (LT-07, LT-16). Where a graph exists, a save re-ingests it. This hits L-07 and L-08 on our F2.
- Course claims Learn contradicts: shortcuts are "read-only" (wrong for OneLake shortcuts), the agent needs a refresh after an instruction change (Learn: applied automatically), and GQL is GraphQL (wrong).
- Conflicts with never-lines: the course calls "Generate ontology" harmless (it creates a billed graph). It also advises setting up a capacity and daily schedules. Learn's DAX API guide says retry on 429, and Learn shows unpinned installs. All are flagged, not adopted.
- Counts: 49 actions, 63 G rules (60 with a Learn link, 3 `[course-only]`), 13 T rules (12 with a Learn link, 1 `[course-only]`), 7 conflicts, 14 contradictions (2 are Learn vs Learn, added after a spot check), 8 evals, 24 routing cases, 18 live tests.

## 3. Rules

### 3a. Generic Fabric facts (candidates for fabric-playbook.md or a hub reference)

| id | rule | evidence | Learn link or [course-only] | status |
|---|---|---|---|---|
| G-01 | Create a lakehouse by REST with `"creationPayload": {"enableSchemas": true}`; REST does not enable schemas by default. | [00:16:54] | https://learn.microsoft.com/fabric/data-engineering/lakehouse-schemas#create-a-lakehouse-with-schemas-using-the-rest-api | NEW |
| G-02 | On a schema-enabled lakehouse, do not call `GET .../lakehouses/{id}/tables` or `.../tables/{t}/load`: they return 400 `UnsupportedOperationForSchemasEnabledLakehouse`. Use the OneLake table API at `https://onelake.table.fabric.microsoft.com/delta`. | [01:14:21] | https://learn.microsoft.com/fabric/data-engineering/lakehouse-api#list-the-tables-in-a-lakehouse ; https://learn.microsoft.com/fabric/onelake/table-apis/delta-table-apis-get-started | NEW |
| G-03 | Expect a `dbo` schema in every schema-enabled lakehouse; you cannot rename or remove it. | [00:17:36] | https://learn.microsoft.com/fabric/data-engineering/lakehouse-schemas#create-a-lakehouse-schema | NEW |
| G-04 | Name a lakehouse with a leading letter, then letters, digits or underscores, 123 characters at most. | [00:16:28] | https://learn.microsoft.com/fabric/data-engineering/create-lakehouse#create-a-lakehouse | NEW |
| G-05 | Use schema-enabled lakehouses for OneLake security and MLVs. Non-schema lakehouses do not preview RLS or CLS tables. | [00:16:54] | https://learn.microsoft.com/fabric/onelake/security/data-access-control-model ; https://learn.microsoft.com/fabric/data-engineering/materialized-lake-views/get-started-with-materialized-lake-views | NEW |
| G-06 | Create a OneLake shortcut with `POST /v1/workspaces/{ws}/items/{itemId}/shortcuts`, body `name`, `path` (starts with Tables or Files), `target.oneLake {workspaceId, itemId, path}`. | [00:18:56] | https://learn.microsoft.com/rest/api/fabric/core/onelake-shortcuts/create-shortcut | NEW |
| G-07 | Hold Write on the item that gets the shortcut and Read on the target before you create a shortcut. | [00:27:04] | https://learn.microsoft.com/fabric/onelake/onelake-shortcut-security#create-and-delete-shortcuts | NEW |
| G-08 | Expect same-tenant OneLake shortcuts to use passthrough by default. To change the mode, delete and recreate the shortcut. | [00:19:44] | https://learn.microsoft.com/fabric/onelake/onelake-shortcut-security#shortcut-authentication-models | NEW |
| G-09 | Through a delegated shortcut, a user sees the intersection of own access and the connection identity's access. RLS works only on the target side. | [00:28:16] | https://learn.microsoft.com/fabric/onelake/onelake-shortcut-security#delegated-onelake-shortcuts | NEW |
| G-10 | Do not treat OneLake shortcuts as read-only. A user with write on both the shortcut path and the target can write through it. | [00:24:05] | https://learn.microsoft.com/fabric/onelake/onelake-shortcut-security#accessing-shortcuts | NEW (course WRONG, C-01) |
| G-11 | Define OneLake roles for a passthrough OneLake-to-OneLake shortcut on the target item, not on the shortcut. Delegated shortcuts can carry roles. | [00:43:31] | https://learn.microsoft.com/fabric/onelake/security/data-access-control-model#shortcuts | NEW (related L-10) |
| G-12 | Expect Direct Lake on SQL and delegated-mode SQL endpoints to read shortcut targets as the item owner, then apply OneLake roles. [CCv3 2026-10-04: WRONG on the last part. Learn sql-analytics-endpoint-onelake-security: in delegated mode "security is governed exclusively by SQL permissions".] | [00:43:18] | https://learn.microsoft.com/fabric/onelake/onelake-shortcut-security#accessing-shortcuts | NEW (related L-11) |
| G-13 | Expect Admins, Members and Contributors to bypass OneLake roles on shortcut data too. | [00:43:06] (context: the course discusses OneLake security, not this bypass) | https://learn.microsoft.com/fabric/onelake/onelake-shortcut-security#onelake-security | matches L-12 |
| G-14 | New SQL endpoints start in delegated mode. Only an Admin or Member can switch to user identity mode. The switch cancels all queries on every SQL endpoint in the workspace. | [01:30:06] | https://learn.microsoft.com/fabric/onelake/security/sql-analytics-endpoint-onelake-security#change-the-onelake-access-mode | matches L-11 (extends it) |
| G-15 | Do not plan INSERT, UPDATE or DELETE on a SQL analytics endpoint. Write with Spark or a Warehouse. The endpoint allows views, functions, procedures and SQL security. | [01:16:18] | https://learn.microsoft.com/fabric/data-engineering/lakehouse-sql-analytics-endpoint#what-you-can-do | NEW |
| G-16 | Load a Warehouse from lakehouse tables with CTAS or `INSERT ... SELECT` and three-part names in the same workspace. | [01:16:47] | https://learn.microsoft.com/fabric/data-warehouse/ingest-data-tsql | NEW |
| G-17 | Build one lakehouse per medallion layer; Microsoft recommends one workspace per layer. Gold can be a Warehouse. | [00:45:05] | https://learn.microsoft.com/fabric/onelake/onelake-medallion-lakehouse-architecture#deployment-model | NEW |
| G-18 | Keep bronze exactly as the source delivers it. | [00:31:26] | https://learn.microsoft.com/fabric/onelake/onelake-medallion-lakehouse-architecture#what-is-medallion-architecture | NEW |
| G-19 | Restrict bronze, open silver to analysts, grant gold by need. | [00:38:12] | https://learn.microsoft.com/fabric/onelake/architecture-patterns#medallion-architecture-bronze,-silver,-gold | NEW |
| G-20 | Manage copy jobs at `/v1/workspaces/{ws}/copyJobs`. Run with `POST .../items/{id}/jobs/instances?jobType=Execute`. Schedule with `POST .../items/{itemId}/jobs/{jobType}/schedules`. | [00:07:34] | https://learn.microsoft.com/fabric/data-factory/copy-job-rest-api-capabilities | NEW |
| G-21 | Expect copy job write methods Append (default), Overwrite, Merge and SCD Type 2 (preview). Merge and SCD Type 2 use the primary key by default. | [00:10:46] | https://learn.microsoft.com/fabric/data-factory/what-is-copy-job#concepts ; https://learn.microsoft.com/fabric/data-factory/cdc-copy-job | NEW |
| G-22 | Set a rerunning full-copy job to Overwrite. Append adds rows without touching existing data [Judgement: duplicate rows follow]. | [00:11:47] | https://learn.microsoft.com/fabric/data-factory/copy-job-connectors | NEW |
| G-23 | Expect copy job to support PostgreSQL and Azure PostgreSQL as source, full and incremental. | [00:25:19] | https://learn.microsoft.com/fabric/data-factory/connector-postgresql-overview | NEW (course unsure, C-04) |
| G-24 | Use a ROWVERSION, datetime, date or datetime-string watermark. Incremental runs skip NULL watermark rows. Changing the incremental column resets to a full copy. | [00:10:46] | https://learn.microsoft.com/fabric/data-factory/incremental-copy-job | NEW |
| G-25 | Orchestrate copy jobs from a pipeline with the Copy job activity. | [00:11:32] | https://learn.microsoft.com/fabric/data-factory/copy-job-activity | NEW |
| G-26 | Create a Dataflow Gen2 as item type `Dataflow` with parts `queryMetadata.json` (`formatVersion` 202502) and `mashup.pq`. | [00:39:46] | https://learn.microsoft.com/rest/api/fabric/articles/item-management/definitions/dataflow-definition | NEW |
| G-27 | Refresh a dataflow with `jobType=Refresh` and `executionData` (DataflowName, OwnerUserPrincipalName, OwnerUserObjectId). Publish with `jobType=Publish`. | [01:06:49] | https://learn.microsoft.com/fabric/data-factory/dataflow-gen2-public-apis | NEW |
| G-28 | Do not call Dataflow Gen2 public APIs as a service principal: not supported. | [01:06:56] | https://learn.microsoft.com/fabric/data-factory/dataflow-gen2-public-apis#current-limitations | NEW (pairs with L-20, L-23) |
| G-29 | Add Dataflow Gen2 data destinations in the portal; the definition API cannot author them. | [01:03:41] | https://learn.microsoft.com/fabric/data-factory/dataflow-gen2-public-apis#current-limitations | NEW |
| G-30 | Refresh a dataflow only as Member or higher with access to every connection it uses. | [01:06:49] | https://learn.microsoft.com/fabric/data-factory/dataflow-gen2-refresh | NEW |
| G-31 | Expect new-table destinations to default to Replace with managed mapping. Schema options apply only to Replace. KQL databases do not support Replace. | [01:04:33] | https://learn.microsoft.com/fabric/data-factory/dataflow-gen2-data-destinations-and-managed-settings | NEW |
| G-32 | Use a left outer merge when you fold lookup tables into a dimension; unmatched rows stay. | [00:52:17] | https://learn.microsoft.com/power-query/merge-queries-left-outer | NEW |
| G-33 | Take over Fabric items in the portal (no API). Take over a semantic model with `POST .../datasets/{id}/Default.TakeOver`. Repair connections after any take over. | [00:53:49] | https://learn.microsoft.com/fabric/fundamentals/item-ownership-take-over ; https://learn.microsoft.com/rest/api/power-bi/datasets/take-over-in-group | NEW |
| G-34 | Create a semantic model with `POST /v1/workspaces/{ws}/semanticModels` and one format: TMDL (`definition/` plus `definition.pbism`) or TMSL (`model.bim`), never both. | [01:18:16] | https://learn.microsoft.com/rest/api/fabric/articles/item-management/definitions/semantic-model-definition | NEW |
| G-35 | Change measures and relationships with `POST .../semanticModels/{id}/updateDefinition` (LRO). Read back with `getDefinition`. | [01:34:01] | https://learn.microsoft.com/rest/api/fabric/semanticmodel/items/update-semantic-model-definition | NEW |
| G-36 | Expect Direct Lake on OneLake from the OneLake catalog, Desktop or a lakehouse's New semantic model. Direct Lake on SQL comes only from the SQL endpoint page. | [01:27:44] | https://learn.microsoft.com/fabric/fundamentals/direct-lake-web-modeling ; https://learn.microsoft.com/fabric/fundamentals/direct-lake-develop#create-the-model | NEW (course confirmed) |
| G-37 | Read the Direct Lake mode from the shared expression: `AzureStorage.DataLake` is OneLake, `Sql.Database` is SQL. | [01:27:44] | https://learn.microsoft.com/fabric/fundamentals/direct-lake-security-integration#key-concepts-and-terminology | NEW |
| G-38 | Secure Direct Lake on OneLake with OneLake security. It ignores SQL endpoint RLS and never falls back to DirectQuery. | [01:29:00] | https://learn.microsoft.com/fabric/fundamentals/direct-lake-overview#considerations-and-limitations ; https://learn.microsoft.com/fabric/fundamentals/direct-lake-how-it-works | NEW (related L-11) |
| G-39 | With OneLake security RLS on the source, avoid bidirectional relationships; expect no model backup; give each user one role. | [01:29:14] | https://learn.microsoft.com/fabric/fundamentals/direct-lake-security-integration#considerations-and-limitations | NEW |
| G-40 | Run DAX with `POST https://api.powerbi.com/v1.0/myorg/groups/{groupId}/datasets/{datasetId}/executeQueries`: one query, one table, 100k rows or 1M values, 15 MB, 120 per minute per user. Needs Read and Build. No service principal on RLS models. | [01:34:01] | https://learn.microsoft.com/rest/api/power-bi/datasets/execute-queries-in-group | matches L-13 (extends it) |
| G-41 | In a notebook, run DAX with `sempy.fabric.evaluate_dax`. Semantic link is preinstalled on Runtime 1.2+; do not install it again unpinned. | [01:34:01] | https://learn.microsoft.com/python/api/semantic-link-sempy/sempy.fabric ; https://learn.microsoft.com/fabric/data-science/semantic-link-power-bi | NEW (see X-05) |
| G-42 | Expect XMLA to be read-only by default. Read-write is a capacity admin setting: the owner's step. | [01:34:01] | https://learn.microsoft.com/fabric/enterprise/powerbi/service-premium-connect-tools#enable-xmla-read-write | NEW |
| G-43 | Expect "Keep your Direct Lake data up to date" to be on by default; it reframes when Delta tables change. | [01:34:50] | https://learn.microsoft.com/fabric/fundamentals/direct-lake-how-it-works#automatic-updates | NEW |
| G-44 | Do not expect a default semantic model with a new lakehouse; Fabric stopped creating them on 2025-09-05. | [01:18:05] | https://learn.microsoft.com/fabric/data-engineering/lakehouse-overview#lakehouse-sql-analytics-endpoint | NEW |
| G-45 | Expect Desktop live edit of a Direct Lake model to change the cloud model at once, with no report view and a version per session. | [01:34:01] | https://learn.microsoft.com/fabric/fundamentals/direct-lake-power-bi-desktop | NEW |
| G-46 | Treat ontology as preview. Check tenant settings "Users can create Ontology (preview) items" and "Users can create Fabric items" first. | [01:42:44] | https://learn.microsoft.com/fabric/iq/ontology/overview-tenant-settings | NEW |
| G-47 | Hold Read and Build on each semantic model before you generate an ontology from it. | [01:44:45] | https://learn.microsoft.com/fabric/iq/ontology/how-to-generate-from-semantic-models | NEW |
| G-48 | Expect generation to make entity types, properties, bindings, relationship types and metrics. Then review keys, bind relationship types and rename by hand. | [02:21:51] | https://learn.microsoft.com/fabric/iq/ontology/how-to-generate-from-semantic-models#process-overview | NEW (course confirmed) |
| G-49 | Expect an ontology to possibly add a managed graph child item: count graph items before and after. Graph refreshes consume capacity. | [02:05:13] | https://learn.microsoft.com/fabric/iq/ontology/resources-glossary ; https://learn.microsoft.com/fabric/iq/ontology/overview#key-capabilities ; https://learn.microsoft.com/fabric/iq/ontology/resources-troubleshooting#troubleshoot-capacity-usage | matches L-08; Learn pages conflict (C-13) |
| G-50 | Batch ontology edits: each schema change re-ingests all bound data. Source data changes need an explicit refresh. | [01:53:29] | https://learn.microsoft.com/fabric/iq/ontology/how-to-use-ontology-graph#refresh-the-graph-model | NEW (related L-07, L-09) |
| G-51 | Create an ontology with `POST /v1/workspaces/{ws}/ontologies`; change it with `POST .../ontologies/{id}/updateDefinition` (LRO). The new experience uses TMDL; the old experience retires 2027-01-31. | [02:05:00] | https://learn.microsoft.com/rest/api/fabric/ontology/items/create-ontology ; https://learn.microsoft.com/rest/api/fabric/ontology/items/update-ontology-definition ; https://learn.microsoft.com/fabric/iq/ontology/old-experience/concepts-generate | NEW |
| G-52 | Give each new-experience entity one `keyProperty` of type string or integer; a list or a repeat is rejected. Build one concatenated key column in ETL. | [00:59:45] | https://learn.microsoft.com/rest/api/fabric/articles/item-management/definitions/ontology-definition ; https://learn.microsoft.com/fabric/iq/ontology/how-to-bind-data#supported-property-types | NEW (course confirmed) |
| G-53 | Back an ontology relationship with a TOM relationship, or with a junction table that backs no entity. Otherwise TMDL fails `BackingTableBoundMoreThanOnce`. | [01:58:36] | https://learn.microsoft.com/rest/api/fabric/articles/item-management/definitions/ontology-definition | CONFLICT with course pattern (C-08) |
| G-54 | Put entity context in the definition: `///` descriptions, `synonym` lines, `resourceLink` with an `item`. | [01:54:02] | https://learn.microsoft.com/rest/api/fabric/articles/item-management/definitions/ontology-definition | NEW (course confirmed) |
| G-55 | Expect the ontology MCP server to need paid F2+ and to refuse service principals (known issue). | [02:18:00] | https://learn.microsoft.com/fabric/iq/ontology/how-to-use-ontology-mcp-server | NEW (related L-25) |
| G-56 | Add `Support group by in GQL` to a data agent on an ontology. Enable "Data agent item types (preview)". Expect early query failures for a few minutes. | [02:14:53] | https://learn.microsoft.com/fabric/iq/ontology/how-to-create-data-agent#provide-agent-instructions ; https://learn.microsoft.com/fabric/iq/ontology/resources-troubleshooting | NEW (check data-agent.md) |
| G-57 | Expect data agents to need paid F2+ or P1+. A trial does not support data agents, Copilot or AI functions. | [00:13:34] | https://learn.microsoft.com/fabric/fundamentals/fabric-trial ; https://learn.microsoft.com/fabric/data-science/how-to-create-data-agent | NEW |
| G-58 | Create MLVs through Spark SQL in a notebook, on a schema-enabled lakehouse with Runtime 1.3. | [01:17:07] | https://learn.microsoft.com/fabric/data-engineering/materialized-lake-views/get-started-with-materialized-lake-views | NEW for this file; check spark-cli |
| G-59 | Check cardinality and key columns of each relationship made in web modeling. | [01:22:06] | [course-only] | NEW |
| G-60 | Refresh the lakehouse view or restart the Spark session before you call a table missing. | [01:14:33] | https://learn.microsoft.com/fabric/data-engineering/troubleshoot-lakehouse#table-not-found-errors | NEW |
| G-61 | Expect an ontology-backed agent to generate GQL or SQL, not DAX. | [02:19:45] | [course-only] | NEW |
| G-62 | Prefer notebooks over Dataflow Gen2 for scripted ETL. G-28 and G-29 make Dataflow Gen2 hard to drive from Claude Code. | [01:17:28] | [course-only] | NEW |
| G-63 | Read GQL as Graph Query Language (ISO), not GraphQL. | [02:19:28] | https://learn.microsoft.com/fabric/graph/gql-language-guide | NEW (C-11) |

### 3c. Conflicts with never-lines (flagged, not adopted)

| id | source | claim | never-line | handling |
|---|---|---|---|---|
| X-01 | Course [02:21:00] | "Generate ontology" is "just a button", harmless to press | Playbook cost rule: at most one graph (L-08); preflight cost items | Not adopted. An ontology may create a billed managed graph (G-49, C-13). Run T-01 first; Dave decides. |
| X-02 | Course [00:13:39] | Set up a Fabric capacity and tie it to the workspace for the AI part | Never-line 2: do not pause, resume, resize or recommend a capacity change | Not adopted. State the requirement (paid F2+, G-57). Do not recommend a capacity change. |
| X-03 | Course [00:11:32], [01:06:55] | Schedule copy jobs and dataflows daily through a pipeline | Never-line 3: one job at a time on F2; read job history before a run POST. L-20: unattended jobs as an MFA admin fail | Not adopted for `kb-playground`. No schedule without Dave's yes. |
| X-04 | Learn (not course): https://learn.microsoft.com/power-bi/developer/execute-dax-queries-arrow/best-practices | On 429 wait for `Retry-After`, then retry; back off on 5xx | Never-line 1: stop all load on any 429 or 430 | Not adopted. Stop and report on 429. |
| X-05 | Learn (not course): semantic-link-power-bi; fabric-command-line-interface | `%pip install -U semantic-link`; `pip install ms-fabric-cli` (no version pin) | Never-line 4: pinned installs only | Not adopted. Use preinstalled sempy (G-41) or `pkg==x.y`. |
| X-06 | Learn (not course): https://learn.microsoft.com/fabric/data-science/evaluate-data-agent | Data agent evaluation SDK (preview) | No LLM judge; `evaluate_data_agent` is banned (L-14) | Not adopted. The course uses hand-written SQL checks instead (T-12). |
| X-07 | Course [01:30:06] | Turn on OneLake security for the SQL endpoint | L-11: portal-only switch; owner decides. Learn: cancels queries workspace-wide | Not a never-line breach. Confirm-first; Dave makes the switch (T-06). |

No conflict found for: `python3` (the course runs no code); service principal data agent management (the course uses a signed-in user in the portal, which fits L-25); 429 handling (the course never mentions throttling).

### 3d. Course vs Learn contradictions

| id | course claim | Learn says | verdict |
|---|---|---|---|
| C-01 | [00:24:05] Shortcut data is read-only. | A user with write on both paths can write through a OneLake shortcut. GCS and Dataverse shortcuts are read-only. (onelake-shortcut-security#accessing-shortcuts) | WRONG for OneLake shortcuts |
| C-02 | [00:43:31] You cannot make a OneLake role on a shortcut. | True for passthrough OneLake-to-OneLake shortcuts. Delegated shortcuts can have roles. (data-access-control-model#shortcuts; onelake-shortcut-security) | PARTLY WRONG |
| C-03 | [00:19:44] Delegated readers use the creator's identity. | A configured connection identity; the reader sees the intersection of both accesses. (onelake-shortcut-security#delegated-onelake-shortcuts) | IMPRECISE |
| C-04 | [00:25:19] Copy job may not support Postgres. | PostgreSQL and Azure PostgreSQL are copy job sources, full and incremental. (connector-postgresql-overview; copy-job-connectors) | WRONG (doubt unfounded) |
| C-05 | [00:16:54] Lakehouse schemas are on by default. | Portal default on; REST default off. (lakehouse-schemas) | CONDITIONAL |
| C-06 | [01:16:18] The SQL endpoint is read-only. | Read-only for data; views, functions, procedures and SQL security are allowed. (lakehouse-sql-analytics-endpoint#what-you-can-do) | IMPRECISE |
| C-07 | [01:30:06] The SQL endpoint OneLake security switch is still preview. | The Learn page shows no preview label (read 2026-10-04). (sql-analytics-endpoint-onelake-security) | UNCONFIRMED, likely stale |
| C-08 | [01:58:36] Bind each relationship to the fact table that also backs the sales entity. | New-experience TMDL rejects a junction table that backs an entity (`BackingTableBoundMoreThanOnce`); use a TOM relationship backing. Old-experience UI binds through a table holding both keys. (ontology-definition; old-experience/how-to-create-relationship-types) | CONDITIONAL (fails in TMDL) |
| C-09 | [02:05:00] Ontology export is unknown. | `getDefinition` returns the TMDL definition; Git integration and deployment pipelines work. (ontology-definition) | Course gap; Learn answers it |
| C-10 | [02:16:48] Refresh the agent after you change instructions. | "The agent applies the instruction automatically." (how-to-create-data-agent#provide-agent-instructions) | WRONG per Learn (maybe a UI lag) |
| C-11 | [02:15:20] GQL, GraphQL. | GQL is Graph Query Language for Fabric graph. (gql-language-guide) | WRONG |
| C-12 | [02:20:49] Build the ontology flow on a free trial. | Data agents and the ontology MCP server need paid F2+; trials do not support data agents. (fabric-trial; how-to-use-ontology-mcp-server) | PARTLY WRONG (agent half needs paid) |
| C-13 | Learn vs Learn (added by fourthcompanybrain-04 after spot check). Course [02:05:13] shows a graph per ontology. | Glossary and old-experience pages: creating an ontology creates a managed graph item (resources-glossary; old-experience/how-to-view-entity-type-details). New-experience overview: graph materialization is opt-in and does not load instance data by default (overview#key-capabilities; how-to-use-ontology-graph#about-graph-in-ontology). | UNRESOLVED: prove with LT-07 then LT-16 |
| C-14 | Learn vs Learn (added after spot check). Course [00:59:45] concatenates a composite key into one column. | TMDL definition: `keyProperty` is a single scalar; a list or repeat is rejected (ontology-definition). Portal tutorial part 3 multi-selects `StoreId`, `ProductId` as one entity key for graph eligibility (tutorial-3-preview-ontology#explore-ontology-graph). | Course matches the REST definition; the portal may allow more. Skill text: one key column for REST (G-52) |

## 4. Tests

### 4a. Offline evals (JSON)

```json
[
  {
    "id": 101,
    "name": "lakehouse-schemas-rest",
    "skills": ["fabric"],
    "query": "Give me the az rest commands for Git Bash that create a lakehouse called wwi_lh with lakehouse schemas in workspace FourthBrain-Playground, then list every table in it per schema. Do not run anything.",
    "expected_behavior": [
      "Creates the lakehouse with POST https://api.fabric.microsoft.com/v1/workspaces/<workspaceId>/lakehouses and \"creationPayload\": {\"enableSchemas\": true}.",
      "Says that the REST API does not enable schemas by default, unlike the portal.",
      "Does not list tables with GET .../lakehouses/<id>/tables, because a schema-enabled lakehouse returns HTTP 400 UnsupportedOperationForSchemasEnabledLakehouse.",
      "Lists schemas and tables with the OneLake table API at https://onelake.table.fabric.microsoft.com/delta (unity-catalog schemas and tables calls) or with T-SQL on the SQL analytics endpoint.",
      "Resolves the workspace id by listing and filtering on displayName, not by a guessed GUID."
    ],
    "checks": [
      {"type": "regex", "pattern": "\"?enableSchemas\"?\\s*:\\s*true"},
      {"type": "regex", "pattern": "creationPayload"},
      {"type": "regex", "pattern": "onelake\\.table\\.fabric\\.microsoft\\.com|UnsupportedOperationForSchemasEnabledLakehouse"}
    ]
  },
  {
    "id": 102,
    "name": "onelake-table-shortcuts-passthrough",
    "skills": ["fabric"],
    "query": "In lakehouse wwi_lh (schemas on) I need table shortcuts in the bronze schema to six tables in lakehouse src_lh in the same tenant. Readers must only see what they can see in src_lh. Give me the REST call and tell me where the OneLake security roles go. Do not run anything.",
    "expected_behavior": [
      "Uses POST https://api.fabric.microsoft.com/v1/workspaces/<workspaceId>/items/<lakehouseId>/shortcuts, one call per table.",
      "The body has name, a path under Tables for the bronze schema, and target.oneLake with workspaceId, itemId and path.",
      "Keeps the default passthrough mode, so each reader needs access on src_lh, and does not set up a delegated connection identity.",
      "Puts the OneLake security roles on src_lh (the target), not on the shortcut.",
      "Says the caller needs Write on wwi_lh and Read on the target, and that a mode change means delete and recreate."
    ],
    "checks": [
      {"type": "regex", "pattern": "/items/[^/\\s]+/shortcuts"},
      {"type": "regex", "pattern": "\"?oneLake\"?\\s*:"},
      {"type": "regex", "pattern": "Tables/bronze"}
    ]
  },
  {
    "id": 103,
    "name": "copy-job-run-and-schedule-f2",
    "skills": ["fabric"],
    "query": "Write the Git Bash steps that start the Fabric copy job cj_wwi now, wait for it, and then give it a daily 06:00 schedule. It runs on our F2 that throttles a lot. Do not run anything.",
    "expected_behavior": [
      "Starts the run with POST .../workspaces/<workspaceId>/items/<copyJobId>/jobs/instances?jobType=Execute, not RunNotebook, DefaultJob or Refresh.",
      "Creates the schedule with POST .../items/<copyJobId>/jobs/<jobType>/schedules and \"enabled\": true.",
      "Reads recent job instances before the POST and runs at most one Fabric job at a time on the F2.",
      "On an HTTP 429 or 430, or a 'capacity has exceeded its limits' message, stops and reports; it does not retry or back off.",
      "Polls the job instance from the Location header with a capped poll loop."
    ],
    "checks": [
      {"type": "regex", "pattern": "jobType=Execute"},
      {"type": "regex", "pattern": "/jobs/[^/\\s]+/schedules"},
      {"type": "not_regex", "pattern": "(?<!retry )(?<!retries )\\b(?:429|430)\\b(?:(?!\\b(?:return|exit|break|stop|abort|die|fail|halt|report)\\w*|\\b(?:not|never|no|without)\\b|n't)[\\s\\S]){0,160}?\\b(?:continue|sleep|(?:retry|retries|retried|retrying)(?!-after\\b)|back[ -]?off)\\b", "flags": "i"}
    ]
  },
  {
    "id": 104,
    "name": "dataflow-gen2-refresh-service-principal",
    "skills": ["fabric"],
    "query": "Our brain-runner service principal should refresh the Dataflow Gen2 WWI_DF every night, and I want to add its lakehouse data destination through the definition API so it is all in code. Give me the calls. Do not run anything.",
    "expected_behavior": [
      "Says Dataflow Gen2 public APIs do not support service principal authentication, so brain-runner cannot do this.",
      "Says a data destination cannot be authored through the definition API and must be added in the portal with Add data destination.",
      "Shows the refresh as POST .../items/<dataflowId>/jobs/instances?jobType=Refresh with executionData (DataflowName, OwnerUserPrincipalName, OwnerUserObjectId).",
      "Says the refresh caller needs Member or higher and access to every connection of the dataflow.",
      "Offers a notebook job run through the Jobs API as the scriptable alternative for nightly ETL."
    ],
    "checks": [
      {"type": "regex", "pattern": "jobType=Refresh"},
      {"type": "regex", "pattern": "executionData"}
    ]
  },
  {
    "id": 105,
    "name": "direct-lake-measure-and-dax",
    "skills": ["fabric"],
    "query": "Add a measure Total Sales = SUM('fact internet sales'[SalesAmount]) to our Direct Lake semantic model WWI_SM by REST, then run a DAX query from Claude Code to check it. The model is Direct Lake on OneLake and we would run as the brain-runner service principal. Do not run anything.",
    "expected_behavior": [
      "Reads the model with POST .../semanticModels/<id>/getDefinition and writes the changed TMDL with POST .../semanticModels/<id>/updateDefinition, polling the long running operation.",
      "Runs DAX with POST https://api.powerbi.com/v1.0/myorg/groups/<groupId>/datasets/<datasetId>/executeQueries (or sempy evaluate_dax in a notebook).",
      "Says the DAX check must run as a signed-in user with Read and Build, not the service principal, because a service principal cannot query a Direct Lake on OneLake model.",
      "States executeQueries limits: one query per call, one table, at most 100,000 rows or 1,000,000 values.",
      "On an HTTP 429 or 430 stops and reports; it does not retry or back off."
    ],
    "checks": [
      {"type": "regex", "pattern": "/semanticModels/[^/\\s]+/updateDefinition"},
      {"type": "regex", "pattern": "executeQueries|evaluate_dax"},
      {"type": "not_regex", "pattern": "(?<!retry )(?<!retries )\\b(?:429|430)\\b(?:(?!\\b(?:return|exit|break|stop|abort|die|fail|halt|report)\\w*|\\b(?:not|never|no|without)\\b|n't)[\\s\\S]){0,160}?\\b(?:continue|sleep|(?:retry|retries|retried|retrying)(?!-after\\b)|back[ -]?off)\\b", "flags": "i"}
    ]
  },
  {
    "id": 106,
    "name": "ontology-generate-on-f2-with-graph",
    "skills": ["fabric"],
    "query": "Generate an ontology from the semantic model WWI_SM and hook a new data agent to it so I can ask revenue by subcategory. We are on our F2 and brain_graph already exists in the workspace. List the steps. Do not run anything.",
    "expected_behavior": [
      "Counts graph items before the ontology step and says the ontology may add a managed graph, so the workspace could hold two graphs; it asks Dave or removes the old graph only after its evidence is saved.",
      "Checks the tenant settings 'Users can create Ontology (preview) items' and 'Users can create Fabric items', and Read plus Build on WWI_SM.",
      "Adds the agent instruction 'Support group by in GQL' for aggregation questions on an ontology source.",
      "Changes the data agent as a signed-in owner, not as a service principal.",
      "Does not score the agent with an LLM judge or evaluate_data_agent; it compares answers with rule-based SQL."
    ],
    "checks": [
      {"type": "regex", "pattern": "Support group by in GQL"},
      {"type": "not_regex", "pattern": "evaluate_data_agent\\s*\\("}
    ]
  },
  {
    "id": 107,
    "name": "ontology-tmdl-single-key",
    "skills": ["fabric"],
    "query": "Write the new-experience ontology TMDL for an entity Sales backed by table fact_internet_sales whose key is SalesOrderNumber plus SalesOrderLineNumber, and a relationship 'purchased' from Sales to Product. Then give me the call that deploys it. Do not run anything.",
    "expected_behavior": [
      "Uses one keyProperty on the entity, not two key properties or a comma list.",
      "Tells me to add one concatenated key column (for example SalesLineKey) in ETL, of type string or integer.",
      "Backs the relationship with a TOM relationship, or with a junction table that is not also an entity's backingTable.",
      "Deploys with POST .../workspaces/<workspaceId>/ontologies/<ontologyId>/updateDefinition (or POST .../ontologies to create) and polls the long running operation.",
      "Says ontology is a preview feature."
    ],
    "checks": [
      {"type": "regex", "pattern": "keyProperty"},
      {"type": "regex", "pattern": "/ontologies"},
      {"type": "not_regex", "pattern": "keyProperty\\s*:\\s*\\w+\\s*,\\s*\\w+"},
      {"type": "not_regex", "pattern": "keyProperty\\s*:[^\\n]*\\n\\s*keyProperty\\s*:"}
    ]
  },
  {
    "id": 108,
    "name": "sql-endpoint-viewer-leak-and-insert",
    "skills": ["fabric"],
    "query": "Our Viewer test user reads every table through the lakehouse SQL analytics endpoint, even though OneLake security roles should hide some of them. I also want to INSERT correction rows through that same endpoint. Fix both. Do not run anything.",
    "expected_behavior": [
      "Says the endpoint is in delegated identity mode, which ignores OneLake security roles.",
      "Fixes the leak by switching the endpoint to User's identity access mode in the portal Security tab, done by an Admin or Member.",
      "Warns that the switch cancels all running and queued queries on every SQL endpoint in the workspace, so Dave picks the time.",
      "Says the SQL analytics endpoint cannot INSERT, UPDATE or DELETE data, and offers Spark in a notebook or a Warehouse instead.",
      "Tests the fix with a Viewer identity, not an Admin, Member or Contributor."
    ],
    "checks": [
      {"type": "regex", "pattern": "user'?s identity", "flags": "i"},
      {"type": "regex", "pattern": "\\b(?:warehouse|spark|notebook)\\b", "flags": "i"}
    ]
  }
]
```

Citations, keyed by eval id:

- 101: https://learn.microsoft.com/fabric/data-engineering/lakehouse-schemas#create-a-lakehouse-with-schemas-using-the-rest-api ; https://learn.microsoft.com/fabric/data-engineering/lakehouse-api#list-the-tables-in-a-lakehouse ; https://learn.microsoft.com/fabric/onelake/table-apis/delta-table-apis-get-started ; workspace lookup: never-line style of eval 1.
- 102: https://learn.microsoft.com/rest/api/fabric/core/onelake-shortcuts/create-shortcut ; https://learn.microsoft.com/fabric/onelake/onelake-shortcut-security ; https://learn.microsoft.com/fabric/onelake/security/data-access-control-model#shortcuts
- 103: https://learn.microsoft.com/fabric/data-factory/copy-job-rest-api-capabilities ; never-lines 1 and 3 (fabric SKILL.md).
- 104: https://learn.microsoft.com/fabric/data-factory/dataflow-gen2-public-apis ; https://learn.microsoft.com/fabric/data-factory/dataflow-gen2-refresh
- 105: https://learn.microsoft.com/rest/api/fabric/semanticmodel/items/update-semantic-model-definition ; https://learn.microsoft.com/rest/api/power-bi/datasets/execute-queries-in-group ; L-13 ; never-line 1.
- 106: https://learn.microsoft.com/fabric/iq/ontology/resources-glossary ; https://learn.microsoft.com/fabric/iq/ontology/overview-tenant-settings ; https://learn.microsoft.com/fabric/iq/ontology/how-to-generate-from-semantic-models ; https://learn.microsoft.com/fabric/iq/ontology/how-to-create-data-agent#provide-agent-instructions ; L-08 ; L-14 ; L-25.
- 107: https://learn.microsoft.com/rest/api/fabric/articles/item-management/definitions/ontology-definition ; https://learn.microsoft.com/fabric/iq/ontology/how-to-bind-data#supported-property-types ; https://learn.microsoft.com/rest/api/fabric/ontology/items/update-ontology-definition
- 108: https://learn.microsoft.com/fabric/onelake/security/sql-analytics-endpoint-onelake-security ; https://learn.microsoft.com/fabric/data-engineering/lakehouse-sql-analytics-endpoint#what-you-can-do ; L-11 ; L-12.

### 4b. Routing cases (JSON)

Negatives use the existing optional `forbid` field (see the Copilot Studio case in trigger-cases.json).

```json
[
  {"prompt": "create a lakehouse with schemas in the playground workspace through the REST API", "expect": ["fabric"]},
  {"prompt": "add OneLake table shortcuts from src_lh into the bronze schema of wwi_lh", "expect": ["fabric"]},
  {"prompt": "why can a viewer read data through my lakehouse shortcut, is it passthrough or delegated", "expect": ["fabric"]},
  {"prompt": "start the copy job cj_wwi and give it a daily schedule", "expect": ["fabric"]},
  {"prompt": "refresh the WWI_DF Dataflow Gen2 from a script", "expect": ["fabric"]},
  {"prompt": "add a Total Sales measure to the Direct Lake semantic model WWI_SM and run a DAX query against it", "expect": ["fabric"]},
  {"prompt": "is our semantic model Direct Lake on OneLake or Direct Lake on SQL, check its definition", "expect": ["fabric"]},
  {"prompt": "generate an ontology from the WWI semantic model and set the sales entity key", "expect": ["fabric"]},
  {"prompt": "the data agent on our ontology cannot break revenue down by subcategory", "expect": ["fabric"]},
  {"prompt": "my viewer reads every table through the lakehouse SQL analytics endpoint despite the OneLake roles", "expect": ["fabric"]},
  {"prompt": "load the gold tables from the lakehouse into a Fabric warehouse with CTAS", "expect": ["fabric"]},
  {"prompt": "list the tables in our schema-enabled lakehouse, the tables API gives me a 400", "expect": ["fabric"]},
  {"prompt": "set up bronze, silver and gold lakehouses for the WWI data in Fabric", "expect": ["fabric"]},
  {"prompt": "query the Fabric eventhouse with KQL for yesterday's copy job failures", "expect": ["kusto-cli"]},
  {"prompt": "export the ItemJobEventLogs rows from workspace monitoring with Kusto.Cli to a CSV", "expect": ["kusto-cli"]},
  {"prompt": "write a KQL query that counts failed sign-ins per hour in our Azure Data Explorer cluster", "expect": ["kusto-cli"], "forbid": ["fabric"]},
  {"prompt": "this stored procedure on our on-prem SQL Server is slow, add the right index", "expect": ["databases"], "forbid": ["fabric"]},
  {"prompt": "write a migration that adds a star schema for sales to our Postgres database", "expect": ["databases"], "forbid": ["fabric"]},
  {"prompt": "in Power BI Desktop, how do I write a year-over-year measure on my imported Excel sheet", "expect": [], "forbid": ["fabric"]},
  {"prompt": "how do I merge two queries with a left outer join in Power Query in Excel", "expect": [], "forbid": ["fabric"]},
  {"prompt": "write a Databricks Delta Live Tables pipeline from bronze to silver", "expect": [], "forbid": ["fabric"]},
  {"prompt": "explain the difference between GraphQL and a REST API for my web app", "expect": [], "forbid": ["fabric"]},
  {"prompt": "build a star schema diagram for a slide about Kimball modelling", "expect": [], "forbid": ["fabric"]},
  {"prompt": "set up row-level security on my Power BI Pro report with an imported CSV", "expect": [], "forbid": ["fabric"]}
]
```

### 4c. Live tests (read-only first)

Every row needs: preflight 8/8 green (`python docs/playground/deploy.py preflight`) and Dave's yes, plus the items in "needs". Stop all load on the first 429 or 430.

| id | prompt | expected result | read-only | needs |
|---|---|---|---|---|
| LT-01 | "Get the playground lakehouse properties and tell me if schemas are on." | Properties return; schema state recorded for T-08 | yes | `kb-playground` access |
| LT-02 | "List the tables of a schema-enabled lakehouse with GET .../lakehouses/{id}/tables." | HTTP 400 `UnsupportedOperationForSchemasEnabledLakehouse` (G-02) | yes | A schema-enabled lakehouse exists |
| LT-03 | "List schemas and tables of that lakehouse through the OneLake table API." | `dbo` plus the other schemas and their tables (G-02, G-03) | yes | As LT-02; token audience: unknown, check the get-started page |
| LT-04 | "List the shortcuts in wwi_lh with GET .../items/{id}/shortcuts." | Shortcut list with targets; record whether a delegated one shows a `connectionId` (Open question 4) | yes | A lakehouse with shortcuts |
| LT-05 | "Read the brain semantic model definition and tell me its Direct Lake mode." | Shared expression `AzureStorage.DataLake` (OneLake) or `Sql.Database` (SQL) (G-37, T-07) | yes | Read and write on the model (getDefinition is a POST) |
| LT-06 | "Run one DAX COUNTROWS through executeQueries as the L-13 test user." | One-table result; a service principal call fails as in L-13 (G-40) | yes (interactive load) | Signed-in test user with Read and Build |
| LT-07 | "List the workspace items and count GraphModel, Ontology and DataAgent items." | Counts recorded before any ontology step (T-01) | yes | None |
| LT-08 | "Read an existing ontology definition with getDefinition." | TMDL parts; each entity has at most one `keyProperty` (G-52) | yes | An ontology exists; skip if none |
| LT-09 | "Read the copy job definition of an existing copy job." | `copyjob-content.json` with the write method field (G-20, G-21) | yes | A copy job exists; skip if none |
| LT-10 | "Create lakehouse lt_schema_lh by REST without creationPayload, then with enableSchemas true." | First has no schemas; second has `dbo` (G-01, G-03) | no | Item create rights; delete both after evidence |
| LT-11 | "Create a passthrough table shortcut into Tables/bronze, then write one Delta file through it as a Contributor." | Write succeeds when write exists on both paths (G-10, C-01) | no | Scratch source and target lakehouses only |
| LT-12 | "Read the passthrough shortcut as a Viewer with no role on the source." | Access denied; with a source role, read works (G-11) | no (needs a role create, one at a time, L-10) | Viewer test user (L-12) |
| LT-13 | "Run a copy job once with jobType=Execute and poll it." | Job instance ends Completed (G-20) | no | A source connection; no other job running |
| LT-14 | "Refresh WWI_DF with jobType=Refresh as David, then the same call as brain-runner." | David: record the real result (Open question 3). brain-runner: refused (G-28) | no | A test dataflow; L-20 MFA risk; Dave present |
| LT-15 | "Add measure Total Sales through updateDefinition, then read it back." | Measure present with the same expression (G-35) | no | A scratch semantic model |
| LT-16 | "Generate an ontology from the scratch model and list the workspace items." | Records whether a managed graph item appears; settles C-13 (G-49, T-01) | no | Ontology tenant settings on; Read and Build; one graph rule settled first (L-08); delete after evidence |
| LT-17 | "Ask the ontology agent 'revenue by subcategory' through its MCP endpoint, without and with 'Support group by in GQL'." | Without: wrong or no breakdown. With: correct numbers that match T-SQL (G-56, T-09, T-12) | no (agent change as signed-in owner, L-25) | Paid F2; data agent tenant setting; refs-based scoring (L-14) |
| LT-18 | "Generate an ontology in the personal trial tenant." | Record the exact result for C-12 and T-10 | no | Trial tenant; no customer data |

## 5. Terms

- Copy job: Data Factory item that copies data from a source to a destination, full or incremental. REST type `CopyJob`.
- Write method (copy job): Append (default), Overwrite, Merge (SCD Type 1), SCD Type 2 (preview).
- Watermark column: a column whose rising value marks new or changed rows for incremental copy.
- Lakehouse schemas: named groups of tables under Tables; default schema `dbo`.
- Medallion architecture: bronze (raw, unchanged), silver (cleaned, first shared), gold (modelled for reporting).
- OneLake shortcut: a pointer to data in another item or store; appears as a folder or table.
- Passthrough authentication: the shortcut uses the caller's identity at the target. Default for same-tenant OneLake.
- Delegated authentication: the shortcut uses a configured connection identity; the caller sees the intersection.
- Shortcut path / target path: where the shortcut appears / where it points.
- OneLake security role: a data-access role on an item (tables, folders, RLS, CLS). Letters and digits only (L-10).
- SQL analytics endpoint: the read-only T-SQL view of a lakehouse. Modes: delegated identity (SQL security) or user identity (OneLake security).
- Dataflow Gen2: Power Query item with data destinations. REST type `Dataflow`.
- Data destination: the Dataflow Gen2 setting that writes a query result to a table. Portal-only to author.
- Take over: make yourself the owner of an item; connections may need repair.
- Semantic model: tables, relationships and measures for Power BI. Definition in TMDL or TMSL.
- TMDL: Tabular Model Definition Language, the text format of model and ontology definitions.
- Direct Lake on OneLake: reads Delta tables through OneLake APIs; OneLake security; no DirectQuery fallback.
- Direct Lake on SQL: checks access through the SQL analytics endpoint; can fall back to DirectQuery.
- Framing: the refresh step that points a Direct Lake model at the latest Delta table versions.
- XMLA endpoint: the Analysis Services protocol endpoint; read-only by default.
- Microsoft IQ / Fabric IQ: Microsoft's context layers for agents; ontology is the Fabric IQ item.
- Ontology (preview): business entities, properties and relationships bound to data, for agents. Old (JSON) and new (TMDL) experiences.
- Entity type: one business object (sales, product). Bound to a backing table.
- Entity type key (`keyProperty`): the one property that identifies each entity instance. String or integer.
- Property: an entity attribute bound to a column.
- Relationship type: a named, directed business link between two entity types.
- Junction (mapping) table: a table that holds both entity keys to back a relationship.
- Synonym / resourceLink: alternate words for an entity / a link to a Fabric item.
- Managed graph item: the Graph child item of an ontology. Learn pages differ on whether Fabric creates it automatically (C-13).
- GQL: Graph Query Language, the ISO graph query language that Fabric graph and ontology agents use. Not GraphQL.
- Data agent: Fabric AI item that answers questions over lakehouses, warehouses, models, KQL databases or ontologies.
- Agent instructions: free text in a data agent; ontology sources need "Support group by in GQL".
- OneLake catalog: the picker that lists Fabric items in wizards and Desktop.
- Surrogate key: a generated unique column, here `SalesLineKey` (order number plus line number).

## 6. Open questions for the skills owner

1. Ontology experience. Which experience did the course use? Its relationship binding fits the old UI (C-08). Recommendation: write skill text for the new TMDL experience only. REST create without a definition gives generation 2, and the old experience retires 2027-01-31.
2. Graph count. Does an ontology's managed graph show as type `GraphModel` in List Items? If yes, `deploy.py preflight` counts it and `iq.py create_graph` refuses `brain_graph`. Recommendation: settle this with LT-07 and LT-16 before any ontology work.
3. Dataflow Run API. Learn's limitation says "You can invoke Run APIs, but the actual run never succeeds." The scope is unclear. Recommendation: mark Dataflow Gen2 refresh by API as unproven until LT-14 runs.
4. Shortcut mode by REST. The `oneLake` target has an optional `connectionId`. Learn does not say that it selects delegated mode. Recommendation: write "unknown" in the skill until LT-04 shows a delegated shortcut's body.
5. Preview status. Learn shows no preview label on OneLake security or user identity mode (C-07). Recommendation: drop "preview" from skill text, but keep the L-11 confirm-first rule.
6. Where the rules go. Recommendation: put G rules in hub reference files (`references/lakehouse.md`, `shortcuts.md`, `data-factory.md`, `semantic-model.md`, `ontology.md`). Promote only cost and safety lines (G-14, G-49, G-50, X-04) to fabric-playbook.md.
7. data-agent.md overlap. `C:\Users\david.hayes\continuous-claude\.claude\skills\fabric\` holds only `SKILL.md` and `evals/` in this checkout, so PR #93 is not here. Recommendation: check that `references/data-agent.md` carries G-56, G-57 and C-10 before you add them again.
   **Answered 2026-10-04 by continuous-claude-f6:**
   - PR #93 merged at main `f95ad9e`, and `references/data-agent.md` now exists.
   - G-57 is partly covered (line 152). Phase 5 updates that line with the fabric-trial link. Do not add G-57 as a new rule.
   - G-56 (ontology, GQL "group by") is not covered. Add it in Phase 5.
   - C-10 is not covered. A related fact sits at data-agent.md lines 144-145: an MCP caller reads the published version.
   - [Speculation] An instruction change reaches MCP only after a publish. LT-17 settles this.
8. Warehouse routing. Warehouse T-SQL prompts route to `fabric` in 4b, because SKILL.md says to name the gap and use Learn. Recommendation: keep that until `sqldw-cli` is vendored.
9. Eventhouse. The course does not cover Eventhouse; Warehouse appears only as the alternative to a read-only SQL endpoint. No Eventhouse rules come from this source.
