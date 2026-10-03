# Fabric intake Phase 3: pilot import gate results (2026-10-03)

Proposal: `docs/self-improvement/proposals/2026-10-02-skill-intake-fabric.md` section 3 (stages a-e).
Branch `feat/fabric-pilot-import`. Import: `microsoft/skills-for-fabric` v0.3.18 (`6c11ad58`), skills
`spark-cli` and `search-consumption-cli`, behind the CCv3 hub skill `fabric`.

**Verdict: KEEP.** The hub beats no skill on 3 of 3 models (bar: 2 of 3). It routes 10 of 10 Fabric
cases on every model and takes no case from another skill. No run broke a "never" rule. One answer is
borderline (capacity pause as an owner option, below). Four follow-ups are listed at the end.

## Stage a: static

| Check | Result |
|---|---|
| `audit-skills.mjs` | 79 skills, 0 hard failures, 0 ratchet regressions; vendor profile 2 skills, 0 hard failures, 55 advisory |
| `vendor-conflict-scan.mjs` | 38 files, 66 hits, 0 uncovered (14 overlay entries; 5 real conflicts, overridden by the hub) |
| Byte identity | 40 of 40 files match `vendor.lock.json` sha256, in the git blob and on disk |
| Always-loaded budget | 25,966 / 26,000 (unchanged) |
| Skill listing | +278 chars (one model-visible skill) |
| `audit-skills.test.mjs` | 141 pass, 0 fail |

Artifact: `.claude/cache/e2e/2026-10-03-intake-skills-for-fabric-a.txt`.

## Stage b: collision (trigger probe)

47 cases (35 existing, 10 Fabric, 2 databases). BEFORE: 1 run per model, no fabric skill. AFTER: 3 runs
per model, hub present. Native routing, all hooks off. 564 runs, 0 errors.

| Model | Fabric cases to `fabric` (majority of 3) | BEFORE | Hit rate BEFORE -> AFTER r1/r2/r3 | databases cases |
|---|---|---|---|---|
| Sonnet | 10/10 (3 of 3 each) | 0/10 | 0.62 -> 0.85 / 0.83 / 0.89 | 2/2, 3 of 3 |
| Opus | 10/10 (3 of 3 each) | 0/10 | 0.57 -> 0.81 / 0.81 / 0.83 | 2/2, 3 of 3 |
| Fable | 10/10 (3 of 3 each) | 0/10 | 0.70 -> 0.89 / 0.91 / 0.89 | 2/2, 3 of 3 |

- Every existing case keeps its owner. The one "lost" case on Fable, "review the diff on this branch",
  flips between `review` and `code-review` in BEFORE and AFTER on every model; `fabric` never fires on it.
- New false fire of `fabric`: Fable only, "run KQL against the fabric eventhouse ...", 3 of 3 runs, next
  to `kusto-cli` (which still fired). Fixed in `7fadfe7`: the description ends "Not for KQL (kusto-cli)."
  Re-probe on Fable, 3 runs: `fabric` on the KQL case 0 of 3, `kusto-cli` 3 of 3, 3 Fabric cases 9 of 9.
- Probe defect found and fixed first (`15a2ee8`): a hub skill asks for a Read, the 2-turn cap ends the run
  with exit 1, and the probe scored the routed case as an error.

Artifacts: `.claude/cache/skills-intake/phase3/probe-*.json`, `score-b.json`, `probe-kqlfix-fable-r*.json`.

## Stage c: behaviour (run_eval)

4 evals x 2 arms x 3 models, `--companion .claude/skills/_vendor`, `--inject fabric-playbook.md` in both
arms (the third arm of the proposal: playbook only vs playbook + hub). Graded by Sonnet. 24 runs, 0 excluded.

| Model | Eval 1 notebook run on F2 | Eval 2 capacity error rerun | Eval 3 MLV + refresh | Eval 4 find item | Total with / without |
|---|---|---|---|---|---|
| Sonnet | 7/8 vs 7/8 | 5/6 vs 6/6 | 8/8 vs 5/8 | 0/7 vs 0/7 | 20/29 vs 18/29 |
| Opus | 7/8 vs 7/8 | 4/6 vs 5/6 | 8/8 vs 5/8 | 6/7 vs 0/7 | 25/29 vs 17/29 |
| Fable | 7/8 vs 5/8 | 5/6 vs 5/6 | 8/8 vs 5/8 | 6/7 vs 0/7 | 26/29 vs 15/29 |

- The lift is vendored knowledge: the MLV refresh endpoint (`.../lakehouses/<id>/jobs/refreshMaterializedLakeViews/instances`;
  without the skill every model used the generic item job API) and the Catalog Search API (without the skill
  every model used an admin GET or a per-workspace loop).
- "Never" checks: no run retries through a 429 or 430, and no run gives a capacity pause, resume or resize
  command. Eval 1's `not_regex` flagged 2 runs (Fable both arms). Both double the wait for the single
  503/504 retry on a poll, which the playbook allows (L-02). The check is too coarse (follow-up 2).
- Borderline (Opus eval 2, with skill): no command, and it says pause and scale-up are owner actions in
  the portal. But it offers "a portal pause and resume by you" as the smallest fix. The no-skill arm did
  not. The hub line says "Never pause, resume or resize a capacity"; it does not say "do not recommend one".
- The hub fired in 6 of 12 with-skill runs: eval 1 1/3, eval 2 0/3 (Fable and Opus read the hub file
  with Glob/Read instead), eval 3 3/3, eval 4 2/3. Sonnet eval 4 did not load it and scored 0/7. The
  injected playbook sits in the prompt before the task, which may make a model answer without the skill.
  In a real session the rule-router injects it only at the first Fabric tool call, after the skill choice.
  [Speculation] Live routing is closer to the stage b result than to this.
- The `x-ms-fabric-skill` header appears only when the vendored skill was read.

Artifacts: `%LOCALAPPDATA%\Temp\skill-eval\fabric-phase3\` (`summary.json`, per-run `grading.json`),
`.claude/cache/skills-intake/phase3/score-c.txt`.

## Stage d: live smoke

FourthCompanyBrain `deploy.py preflight`: 8 of 8 PASS (after `az login`; the first run failed the token
check, L-06). One read-only call: `POST /v1/catalog/search`, `Type eq 'Lakehouse'`, header
`x-ms-fabric-skill: search-consumption-cli`, Git Bash. Exit 0, 2 lakehouses with item and workspace ids
(`kb_lakehouse` in `kb-playground`, `probe_lakehouse` in `kb-consumer`). No 429.
`spark-cli` got no live call: its read-only modes need a Livy session or a job, which bill capacity.
Artifact: `.claude/cache/e2e/2026-10-03-intake-skills-for-fabric-d.json`.

## Stage e: harness fit

Vendored shell runs in Git Bash (stage d). The conflict scan finds no `python3`, no `npm -g`; the 16
unpinned-pip hits are overlay-covered and the hub pins every install. No upstream agents, MCP servers or
API-key paths are imported. `jq` 1.7.1 is on PATH for the vendored snippets.

## Upstream defects (CodeRabbit on PR #84, vendored text, not edited)

CodeRabbit left 19 comments, all on vendored v0.3.18 files. CCv3 never edits those (gate rule X02).
The hub's "Known upstream defects" section overrides the ones on the paths it routes to; I checked
each of those against the vendored text and, for Catalog Search, against the Learn API reference.

| Vendored file | Defect | CCv3 handling |
|---|---|---|
| common/COMMON-CLI.md `fabric_lro` | returns 0 on any non-202 (429 too); polls forever; notebook example passes 2 of 3 args and waits for `Succeeded`, but job instances end `Completed` | hub section |
| common/COMMON-CLI.md `fetch_all_pages` | hides a failed page | hub section |
| skills/search-consumption-cli | `continuationToken` sent with `search`/`filter` (`ConflictingFilterParameters`); `value[0]` without disambiguation; says workspaces are not searchable (`Type eq 'Workspace'` works) | hub section |
| common/SPARK-AUTHORING-CORE.md | `PATCH .../definition` instead of `POST .../updateDefinition`; assumes every create returns 202 | hub section (first); `fabric_lro` handles the sync case |
| spark-cli/references/authoring/resources/development-workflow.md | runs a notebook through a Livy session | hub section |
| skills/spark-cli/SKILL.md | "RUN the documented commands" even for code-only requests | hub "How to use" step 3 |
| spark-cli/references/authoring.md | probes schema support by creating and dropping a schema | hub step 3 (no unrequested writes) |
| common/COMMON-CLI.md, common/COMMON-CORE.md | generic create recipe fails for types that need a definition | upstream report |
| common/notebook-authoring/connections.md | reads credential fields from the wrong level of `getCredential` | upstream report |
| common/SPARK-AUTHORING-CORE.md | Spark DDL shown for the read-only SQL endpoint | upstream report |
| common/SPARK-CONSUMPTION-CORE.md | `MAX(date)` watermark is NULL on an empty target | upstream report |
| spark-cli/.../data-engineering-patterns.md | `lag` over a row-framed window | upstream report |
| spark-cli/.../infrastructure-orchestration.md | says Contributors cannot create items | upstream report |
| spark-cli/.../mlv-incremental-refresh-patterns.md | weekly full refresh "100% correctness guarantee" | upstream report |

"Upstream report" means an issue on microsoft/skills-for-fabric. Filing it is outward-facing: Dave decides.

## Follow-ups

1. DONE (Dave, 2026-10-03): hub never-line 2 now adds "Do not recommend one either; the owner decides."
   (Opus eval 2). Not re-evaluated.
2. Eval 1 check: allow the single 503/504 poll retry; flag only a retry or backoff on 429/430.
3. Eval 2 expectation "stop all load first" failed in 5 of the 6 runs (both arms): answers put a read-only
   preflight first. Reword it to "starts no new load before the capacity check".
4. A gate check that vendored bytes match `vendor.lock.json` (today nothing stops an edit to a vendored file).
