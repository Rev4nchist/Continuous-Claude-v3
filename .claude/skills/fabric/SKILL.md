---
name: fabric
description: Routes Microsoft Fabric work (Spark notebooks, Livy, Materialized Lake Views, lakehouses, shortcuts, OneLake security roles, SQL endpoints, semantic models, TMDL, Direct Lake, DAX, ontology, graphs, GQL, data agents, pipelines, copy jobs, Dataflow Gen2, capacity throttling, item search) to guides. Use when work touches Fabric, OneLake, a lakehouse or a Fabric notebook. Not for KQL (kusto-cli).
---

# Fabric hub

Microsoft's `skills-for-fabric` v0.3.18 is vendored at `../_vendor/skills-for-fabric/` (see its
`PROVENANCE.md`). Claude Code does not list skills under a `_` folder. This page routes to them.

## Never: these lines win over any vendored text

1. On any HTTP 429 or 430, or "capacity has exceeded its limits": stop all load and report. Do not retry,
   even when `Retry-After` is set. This overrides `common/COMMON-CORE.md`. `Retry-After` on a 202 is only
   a poll interval. A 503 or 504 on a status poll may retry once; then stop and report. Cap every poll
   loop: `fabric_lro` in `common/COMMON-CLI.md` loops forever on a status it does not know.
2. Never pause, resume or resize a capacity. Do not recommend one either; the owner decides. Never bulk PUT
   `.../dataAccessRoles`: create roles one at a time.
3. Run the preflight the project's CLAUDE.md names before the first live call. One Fabric job at a time on
   an F2. Before a POST that starts a job, read the job history. Never resubmit a job POST whose outcome
   you do not know: find the job instance first.
4. Pin every pip install: `pkg==x.y` in a project venv on this machine, `%pip install pkg==x.y` in a
   notebook. Use `python`, never `python3`. T-SQL on this machine uses `mssql-python`, not ODBC Driver 18.
5. Vendored shell snippets are bash. Run them with the Bash tool (Git Bash). From PowerShell, `bash` is WSL:
   never use it. Tokens stay in memory; never print one.

## Route

| Task | Read this first |
|---|---|
| Notebook cell code (PySpark, `%%sql`, `%%configure`, notebookutils), notebook runs, Livy sessions, failed or slow Spark runs, Materialized Lake Views | [spark-cli](../_vendor/skills-for-fabric/skills/spark-cli/SKILL.md) |
| Find an item when the workspace is unknown, or list one item type across all workspaces | [search-consumption-cli](../_vendor/skills-for-fabric/skills/search-consumption-cli/SKILL.md) |
| Fabric data agent: ask a published agent a question, or create, configure and publish one with the SDK. CCv3-authored, not vendored | [data-agent](references/data-agent.md) |
| Lakehouse create and schemas, listing tables (HTTP 400 on a schema-enabled lakehouse), OneLake shortcuts and their auth modes, OneLake security roles, the SQL analytics endpoint (read-only data, access mode), medallion layout. CCv3-authored | [lakehouse](references/lakehouse.md) |
| Semantic models: create, change TMDL, measures, relationships, DAX and DAX performance, Direct Lake, refresh, deploy, connection binding, AI readiness. Then read the CCv3 reference [semantic-model](references/semantic-model.md) (Direct Lake mode, OneLake security, `executeQueries` limits, sempy). Where the two differ, the CCv3 reference and the overrides below win | [semantic-model-authoring](../_vendor/skills-for-fabric/skills/semantic-model-authoring/SKILL.md) |
| Fabric IQ ontology (new TMDL experience) and GraphModel: generate, keys, relationships, graph refresh and GQL queries, graph cost, a data agent on an ontology. CCv3-authored | [ontology](references/ontology.md) |
| Data pipelines, copy jobs and Dataflow Gen2: run, schedule, refresh, definitions, run identity, service principal limits. CCv3-authored | [data-factory](references/data-factory.md) |

A CCv3-authored row is a single file: read it in full. The vendored-skill steps at the end of this page do
not apply to it. Do not invent an `x-ms-fabric-skill` value for it.

Not vendored yet: Warehouse T-SQL (`sqldw-cli`), Eventhouse KQL authoring (`eventhouse-cli`), AI
Functions. Say so, then use the Microsoft Learn docs (microsoft-docs plugin) and the API
facts in the `fabric-playbook` rule. A vendored skill that routes to one of these: stop at that boundary.

Other owners: Kusto.Cli queries and CSV export go to `kusto-cli`. SQL outside Fabric and schema design go
to `databases`.

## Known upstream defects (v0.3.18): do this instead

- `fabric_lro` (`common/COMMON-CLI.md`) returns 0 on any non-202 response, a 429 too, and never times out.
  Check the HTTP status and cap the polls. It waits for `Succeeded`, but a job instance ends `Completed`:
  poll a notebook job's instance URL yourself. Its notebook example runs under `set -u` without the third
  argument (the body) and without `SKILL_NAME`, so it aborts: pass `''` as the body and set `SKILL_NAME`.
- `fetch_all_pages` (`common/COMMON-CLI.md`) hides a failed page. Check each `az rest` exit code.
- Catalog Search: on the next page send only `{"continuationToken": "<token>"}`. With `search` or `filter`
  it fails `ConflictingFilterParameters`. Show every match; never take `value[0]` blindly. `Type eq
  'Workspace'` finds a workspace.
- Notebook content: use the `POST .../updateDefinition` that `common/SPARK-AUTHORING-CORE.md` recommends;
  the `PATCH .../definition` it also lists is wrong. A notebook runs through the Jobs API (`jobType=RunNotebook`), never
  through a Livy session.
- `semantic-model-authoring`:
  - It has no mode table. Load the references its workflow names, then `references/semantic-model.md`.
  - Tier 1 `powerbi-modeling-mcp` is not registered here. For a model in a Fabric workspace use Tier 2:
    `getDefinition`, edit the TMDL, `updateDefinition` with all parts, by `az rest`. Its "Fallback" applies
    only to a Desktop-only PBIX: ask the user to save it as PBIP. A DAX trace needs the MCP: say so.
  - On "multiple datasets named", list the models with their ids (`configuredBy` from the Power BI dataset
    GET names who set each up) and report. Delete no model without the owner's yes. To change an existing
    model, `updateDefinition` it; do not delete and create.
  - Never create a Fabric connection: it is a shared item that holds credentials. If none matches, stop
    and ask, as its Example 3 says. `connection-binding.md` says to honor `Retry-After` on a 429: never-line
    1 wins, stop.
  - Never run DAX as a service principal on an RLS or SSO model, with or without `impersonatedUserName`.
    Run DAX as a signed-in user with Read and Build (`references/semantic-model.md` never-line 2).
  - "Poll LRO to completion": cap the polls. A refresh is a job: one at a time on an F2. Its history is
    `GET .../datasets/<id>/refreshes?$top=5`, not Fabric job instances. Status `Unknown` means running:
    start nothing. Never POST a refresh again when the first outcome is unknown: read the history.
  - A validation refresh is a job too: ask first, run one, and on failure report. Do not loop fix and
    refresh. A refresh schedule and a permission grant need the owner's yes. A parameter update and a bind
    run only when the task asks.
  - DAX performance tests: at most 5 measured runs per variant, one at a time; stop on a 429. A recurring
    `OPTIMIZE` is a scheduled job: the owner's yes.
  - `ask_user` means the AskUserQuestion tool.

## How to use a vendored skill

1. Pick one row. Read that SKILL.md in full, then the one `references/<mode>.md` its mode table names
   (`semantic-model-authoring`: see its overrides above).
2. Its links (`../../common/*.md`) resolve inside `../_vendor/skills-for-fabric/`.
3. Read-only calls may run after the preflight. A call that starts a job or changes an item runs only when
   the task asks for it. Report the job instance id.
4. Keep the `x-ms-fabric-skill: <vendored skill name>` header the vendored skill asks for. Dave chose to
   keep it.
5. The reviewed conflicts between vendored text and CCv3 rules are in
   `../_vendor/skills-for-fabric/overlay.json`. A new conflict: follow this page and tell Dave.
