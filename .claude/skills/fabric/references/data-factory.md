# Fabric copy jobs and Dataflow Gen2

CCv3-authored from the Fabric course extraction (`docs/research/fabric/2026-10-04-fabric-course-extraction.md`,
rule ids G-NN) and Microsoft Learn, checked 2026-10-04. Upstream skills-for-fabric has `dataflows-cli`, but
CCv3 does not vendor it: it has 19 lines that conflict with CCv3 never-lines, authors data destinations
through the definition API (Learn says you cannot), and waits for the wrong job status.

Each line names its source: "Learn", "measured" (a live test on one tenant) or "unverified" (the LT-NN id
names the planned test). Nothing here is measured yet.

## Contents

- [Never](#never-these-lines-win-over-learn-text-and-samples)
- [Copy jobs](#copy-jobs)
- [Dataflow Gen2](#dataflow-gen2)
- [Scripted ETL](#scripted-etl)
- [Known gaps](#known-gaps)

## Never: these lines win over Learn text and samples

1. On HTTP 429 or 430, or "capacity has exceeded its limits": stop all load and report. Do not retry.
2. Never create a schedule (copy job, dataflow or pipeline) without the owner's yes. One Fabric job at a
   time on an F2. Before a POST that starts a job, read the item's recent job instances.
3. Never call a Dataflow Gen2 public API as a service principal. Learn: "Service principal authentication
   isn't supported" (G-28). Use a signed-in user, or a notebook job (below).
4. Never wait for `Succeeded` on a job instance. A job instance ends `Completed`, `Failed` or `Cancelled`.
   Cap every poll loop.

## Copy jobs

- Learn: https://learn.microsoft.com/fabric/data-factory/copy-job-rest-api-capabilities
- Manage copy jobs at `https://api.fabric.microsoft.com/v1/workspaces/<workspaceId>/copyJobs` (G-20, Learn).
- Run once: `POST .../workspaces/<workspaceId>/items/<copyJobId>/jobs/instances?jobType=Execute`. Read the
  job instance URL from the `Location` header and poll it with a cap (G-20, Learn).
- Schedule (only with the owner's yes): `POST .../items/<copyJobId>/jobs/<jobType>/schedules` (G-20, Learn).
- Write methods: Append (the default), Overwrite, Merge, and SCD Type 2 (preview). Merge and SCD Type 2
  use the primary key by default (G-21, Learn). A full copy that runs again: use Overwrite. Append adds
  the rows again (G-22).
- Incremental copy reads a watermark column: ROWVERSION, datetime, date or a datetime string. Rows with a
  NULL watermark are skipped. A change of the incremental column starts a full copy again (G-24, Learn).
- PostgreSQL and Azure PostgreSQL are copy job sources, full and incremental (G-23, C-04, Learn).
- A pipeline runs a copy job with the Copy job activity (G-25, Learn).
- Unverified (LT-09, LT-13): the copy job definition part name and a full run on this tenant.

## Dataflow Gen2

- Learn: https://learn.microsoft.com/fabric/data-factory/dataflow-gen2-public-apis
- Item type `Dataflow`. The definition has `queryMetadata.json` (`formatVersion` 202502) and `mashup.pq`
  (G-26, Learn). Learn: https://learn.microsoft.com/rest/api/fabric/articles/item-management/definitions/dataflow-definition
- Refresh: `POST .../items/<dataflowId>/jobs/instances?jobType=Refresh` with `executionData`
  (`DataflowName`, `OwnerUserPrincipalName`, `OwnerUserObjectId`). Publish: `jobType=Publish` (G-27, Learn).
- The user who refreshes needs Member or higher on the workspace and access to every connection of the
  dataflow (G-30, Learn). Upstream says Contributor is enough: Learn says Member.
  Learn: https://learn.microsoft.com/fabric/data-factory/dataflow-gen2-refresh#prerequisites
- You cannot author a data destination through the definition API. Add it in the portal with "Add data
  destination". A dataflow made only by API stages and transforms data but does not write it to a
  destination (G-29, Learn). Upstream's `DataDestinations` annotation in `mashup.pq` contradicts this.
- Learn: "You can invoke Run APIs, but the actual run never succeeds." The page gives no scope for it.
  Treat a Dataflow Gen2 refresh by API as unverified (LT-14). Check the job instance status; never report
  a POST that returned 202 as a successful refresh.
- New table destinations default to Replace with managed mapping. Schema options apply only to Replace.
  A KQL database does not support Replace (G-31, Learn).
- To fold lookup tables into a dimension, use a left outer merge: unmatched rows stay (G-32, Learn).
- Take over Fabric items in the portal: there is no API. Take over a semantic model with
  `POST .../datasets/<id>/Default.TakeOver`. Repair the connections after any take over (G-33, Learn).
- Upstream "ServicePrincipal credentials" for a refresh can only mean the data connection's credential,
  not the API caller (never-line 3).

## Scripted ETL

- Prefer a notebook job for ETL that Claude Code drives. Dataflow Gen2 refuses a service principal
  caller, its destinations are portal-only, and its Run API is unverified (G-62, G-28, G-29).
- Run a notebook through the Jobs API (`jobType=RunNotebook`), never through a Livy session. The
  vendored `spark-cli` row covers it.
- An unattended job as an admin user with MFA fails with `AADSTS50076` (playbook, L-20).

## Known gaps

- Nothing here is measured on the FourthCompanyBrain tenant. LT-09 (read a copy job definition) is
  read-only. LT-13 (one copy job run) and LT-14 (one dataflow refresh) are writes: each needs the owner's
  yes.
- Learn's Dataflow Gen2 public API page shows no preview label. An untyped item call returns
  "Dataflow Gen2 (CI/CD, preview)".
