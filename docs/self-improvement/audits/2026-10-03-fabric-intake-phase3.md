# Fabric intake Phase 3: pilot import gate results (2026-10-03)

Proposal: `docs/self-improvement/proposals/2026-10-02-skill-intake-fabric.md` section 3 (stages a-e).
Branch `feat/fabric-pilot-import`. Import: `microsoft/skills-for-fabric` v0.3.18 (`6c11ad58`), skills
`spark-cli` and `search-consumption-cli`, behind the CCv3 hub skill `fabric`.

**Verdict: KEEP.** The hub beats no skill on 3 of 3 models (bar: 2 of 3). It routes 10 of 10 Fabric
cases on every model and takes no case from another skill. No run broke a "never" rule. One answer is
borderline (capacity pause as an owner option, below); never-line 2 now forbids that, and the
re-measurement on the shipped text (after the stages) holds the verdict. Follow-ups are listed at the end.

## Stage a: static

| Check | Result |
|---|---|
| `audit-skills.mjs` | 79 skills, 0 hard failures, 0 ratchet regressions; vendor profile 2 skills, 0 hard failures, 55 advisory |
| `vendor-conflict-scan.mjs` | 38 files, 66 hits, 0 uncovered (14 overlay entries; 3 mark real conflicts in 4 files, overridden by the hub; each entry's cap equals its hit count) |
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
  command. The first eval 1 `not_regex` flagged 2 runs (Fable both arms); both double the wait for the
  single 503/504 retry on a poll, which the playbook allows (L-02). After two review rounds the checks
  were rewritten. Eval 1 flags a 429/430 followed by `sleep`, `continue`, a retry or a back-off with no
  stop word or negation between them (not `Retry-After`, and not a 429 right after "retry", which is how
  answers quote Microsoft's advice to reject it). Eval 2 flags `az fabric capacity suspend|resume|update`, the `*-AzFabricCapacity` cmdlets,
  a REST `.../capacities/<name>/suspend|resume` call and `az resource invoke-action`, when written as a
  command or after run/execute/use without a negation. 33 of 33 sample answers score right, and all 24
  recorded answers to evals 1 and 2 pass. The checks catch these shapes only. A backoff loop with a give-up
  guard, a sleep before the status check, a URL held in a variable and a recommendation phrased another
  way still need the LLM grader.
- Borderline (Opus eval 2, with skill, first hub text): no command, and it says pause and scale-up are
  owner actions in the portal. But it offers "a portal pause and resume by you" as the smallest fix. The
  no-skill arm did not. The hub line then said only "Never pause, resume or resize a capacity"; never-line
  2 now adds "Do not recommend one either".
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

## Re-measurement after review (shipped text)

The verdict above was measured on the first hub text. After the KQL exclusion and never-line 2:

- Routing (description that ships): KQL case + 3 Fabric cases, 3 runs each. Fable: `fabric` on the KQL
  case 0 of 3, Fabric cases 9 of 9. Sonnet and Opus: `fabric` on the KQL case 0 of 6, Fabric cases 18 of
  18. (Opus run 3 first errored on 3 cases at the moment the usage limit hit; it was re-run.)
- Evals 1 and 2 (new checks and wording), 12 runs, 0 excluded, playbook injected in both arms:

| Model | Eval 1 with / without | Eval 2 with / without |
|---|---|---|
| Sonnet | 7/8 / 7/8 | 5/6 / 5/6 |
| Opus | 7/8 / 7/8 | 6/6 / 4/6 |
| Fable | 7/8 / 5/8 | 6/6 / 5/6 |

- Eval 2: all 3 no-skill answers recommend a capacity resize or pause as the fix (as "the owner's step");
  0 of 3 with-skill answers do. The hub loaded in only 1 of the 6 with-skill runs here (Opus eval 2), so
  [Speculation] part of this difference is run-to-run noise, not the hub.
- The deterministic checks passed in all 12 runs. The one eval 1 failure in every with-skill run is the
  `x-ms-fabric-skill` header, which only appears when the vendored skill is read.

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
   (Opus eval 2). Re-measured in "Re-measurement after review" above.
2. DONE: eval 1 and eval 2 checks rewritten (see stage c).
3. DONE: eval 2 expectation reworded to "starts no new Fabric load before the capacity check".
4. DONE: gate rule X02 (vendor profile) fails when any file in the source (except PROVENANCE.md,
   vendor.lock.json and overlay.json) differs from `vendor.lock.json`, is missing, is not listed or is a
   link, and when the lock itself is missing. Proven by a one-line edit to a temp copy of COMMON-CORE.md
   (X01 + X02 fail) and by tests for a deleted lock, a root CLAUDE.md and a listed and an unlisted junction.
5. OPEN, by design: an overlay cap catches an added conflict line but not a swap (upstream deletes one
   covered line and adds a new one the same pattern matches). X02 makes every vendored byte change a pull
   PR that updates the lock; that PR's instruction diff must be read by a person (proposal section 6).
6. OPEN: `regex` (must-have) checks read prose too, so an answer that names the right endpoint only to
   reject it still passes. The LLM grader covers it.
7. OPEN (Dave): file the "upstream report" rows as one issue on microsoft/skills-for-fabric.
