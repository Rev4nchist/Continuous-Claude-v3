# Fabric Direct Lake semantic models and DAX

CCv3-authored from the Fabric course extraction (`docs/research/fabric/2026-10-04-fabric-course-extraction.md`,
rule ids G-NN) and Microsoft Learn, checked 2026-10-04. It holds the course facts and CCv3 rules for
semantic models. For TMDL authoring, DAX patterns and model design, Microsoft's `semantic-model-authoring`
skill is the full guide. CCv3 plans to vendor it behind this hub (intake Phase 5b). Until then, use Learn.

Each line names its source: "Learn", "measured" (a live test on one tenant, with its L-NN lesson id) or
"unverified" (the LT-NN id names the planned test).

## Contents

- [Never](#never-these-lines-win-over-learn-text-and-samples)
- [Create and change a model by REST](#create-and-change-a-model-by-rest)
- [Direct Lake mode and security](#direct-lake-mode-and-security)
- [Run DAX](#run-dax)
- [Known gaps](#known-gaps)

## Never: these lines win over Learn text and samples

1. On HTTP 429 or 430, or "capacity has exceeded its limits": stop all load and report. Do not retry.
   Learn's DAX best-practices page says to wait for `Retry-After` and retry: CCv3 overrides it.
2. Never run DAX as a service principal on a model with RLS or SSO. Learn: "Service Principals aren't
   supported for datasets with RLS", whatever the tenant setting, and SSO datasets are excluded too.
   `impersonatedUserName` does not change that (G-40). Measured: a service principal could not run DAX
   on a Direct Lake on OneLake model or get Build (L-13). Use a signed-in user with Read and Build.
3. Never install semantic link (`sempy`) unpinned. It is preinstalled on Fabric Runtime 1.2 and later.
4. Never turn on XMLA read-write yourself. It is a capacity admin setting: the owner's step (G-42, Learn).

## Create and change a model by REST

- Learn: https://learn.microsoft.com/rest/api/fabric/articles/item-management/definitions/semantic-model-definition
- Create: `POST https://api.fabric.microsoft.com/v1/workspaces/<workspaceId>/semanticModels` with one
  format: TMDL (`definition/` plus `definition.pbism`) or TMSL (`model.bim`), never both (G-34, Learn).
- Change measures and relationships: `POST .../semanticModels/<id>/updateDefinition` with all parts. Read
  the current parts first with `POST .../semanticModels/<id>/getDefinition`. Both are long-running
  operations: poll with a cap (G-35, Learn).
- Check the cardinality and key columns of each relationship made in web modeling (G-59, course only).
- Desktop live edit of a Direct Lake model changes the cloud model at once. It has no report view, and
  each session makes a version (G-45, Learn).

## Direct Lake mode and security

- Learn: https://learn.microsoft.com/fabric/fundamentals/direct-lake-overview
- Read the mode from the model's shared expression: `AzureStorage.DataLake` is Direct Lake on OneLake,
  `Sql.Database` is Direct Lake on SQL (G-37, Learn).
- Direct Lake on OneLake comes from the OneLake catalog, Power BI Desktop, or a lakehouse's "New semantic
  model". Direct Lake on SQL comes only from the SQL analytics endpoint page (G-36, Learn).
- Direct Lake on OneLake uses OneLake security. It ignores SQL endpoint RLS and never falls back to
  DirectQuery (G-38, Learn).
- With OneLake security RLS on the source: avoid bidirectional relationships, expect no model backup, and
  give each user one role (G-39, Learn).
- "Keep your Direct Lake data up to date" is on by default. The model reframes when its Delta tables
  change (G-43, Learn).
- A new lakehouse no longer gets a default semantic model (G-44, Learn).

## Run DAX

- REST: `POST https://api.powerbi.com/v1.0/myorg/groups/<groupId>/datasets/<datasetId>/executeQueries`.
  One query per call, one table in the result, at most 100,000 rows or 1,000,000 values, 15 MB, and 120
  calls per minute per user. The caller needs Read and Build (G-40, Learn). A dataset with SSO is not
  supported for a service principal either.
  Learn: https://learn.microsoft.com/rest/api/power-bi/datasets/execute-queries-in-group
- In a Fabric notebook: `sempy.fabric.evaluate_dax` (G-41, Learn).
  Learn: https://learn.microsoft.com/python/api/semantic-link-sempy/sempy.fabric
- XMLA is read-only by default (G-42, Learn).

## Known gaps

- LT-05 (read the brain model definition and its Direct Lake mode) is read-only and planned. LT-06 (one
  DAX query as the L-13 test user) needs the test user. LT-15 (add a measure by updateDefinition) is a
  write: it needs the owner's yes.
