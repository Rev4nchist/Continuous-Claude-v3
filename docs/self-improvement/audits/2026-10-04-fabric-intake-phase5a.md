# Fabric intake Phase 5a: course extraction to hub references (2026-10-04)

Plan: `C:\Users\david.hayes\.claude\plans\rosy-munching-reef.md` (approved, Codex pre-mortem: 14 findings, 9
mitigations adopted). Proposal: `docs/self-improvement/proposals/2026-10-02-skill-intake-fabric.md` section 3.
Branch `feat/fabric-phase5-refs`. Source: the Fabric course extraction from session fourthcompanybrain-04
(generic sections copied to `docs/research/fabric/2026-10-04-fabric-course-extraction.md`).

**Verdict: KEEP.** Stages a, b, c (Sonnet + Opus), d and e pass. Fable stage c waits for the 7-day
subscription window reset on 2026-10-10 (Dave's choice, the window was at 88%).

## Scope

Dave's decisions (2026-10-04): cover semantic model + DAX, ontology, lakehouse + shortcuts, and Data
Factory. Author CCv3 references for lakehouse, ontology and Data Factory. Upstream `fabriciq-ontology-cli`
authors the old ontology experience, which retires 2027-01-31. Upstream `dataflows-cli` has 19 never-line
conflicts and wrong API details. Vendor `semantic-model-authoring` in Phase 5b.

- `.claude/skills/fabric/references/`: `lakehouse.md`, `semantic-model.md`, `ontology.md`,
  `data-factory.md` (new); `data-agent.md` (G-56, G-57, C-10, L-25 wording).
- `.claude/skills/fabric/SKILL.md`: 4 route rows; the description names the new areas (399 chars).
- `.claude/rules-ondemand/fabric-playbook.md`: no schedule without a yes; any 429 or 430 stops; ontology
  graph count; single-role POST; token expiry (L-22); no capacity change recommended.
- `.claude/skills/_vendor/skills-for-fabric/overlay.json` + `scripts/skills/lib/conflict-scan.mjs`: the
  capacity seed now flags resize advice ("wait or scale up", "Capacity Sizing Guide").
- `scripts/skills/trigger-probe.mjs`: `--alias <name>=<copy>` (see stage b).
- Evals 101-111 and 31 routing cases.

A FourthCompanyBrain review (`.claudedocs/2026-10-04-fabric-skill-review.md` in that repo) found 14
continuous-claude gaps mid-phase. 12 are fixed here (H3-H7, M5-M8, L3-L5). H2 and M2 are hook and
manifest changes: a separate harness PR after 5a (Dave).

## Learn checks (2026-10-04)

A scout read 15 Learn pages for 12 contested facts:
- 8 are CONFIRMED.
  - G-28: Dataflow Gen2 APIs refuse a service principal.
  - G-29: data destinations are portal only.
  - The Dataflow Run API "never succeeds" (no scope given).
  - G-30: a refresh needs Member or higher.
  - G-40: no service principal DAX on RLS or SSO models.
  - G-01 and G-02.
  - G-57: a trial has no data agents.
  - G-56: Support group by in GQL.
- 4 are PARTLY or NOT STATED.
  - G-17: one workspace per layer is recommended, not required.
  - G-15: CREATE TABLE is not named.
  - C-10: the draft vs published version is inferred.
  - G-46/G-51: no version flag; TMDL means new, JSON means old.
- New fact: a data agent does not work with an ontology that binds through semantic models.

## Stage a: static

| Check | Result |
|---|---|
| `audit-skills.mjs` | 79 skills, 0 hard failures, 0 ratchet regressions; G31 listing 15,088 (ceiling 15,173); G09 description 399 (cap 400) |
| `audit-skills.test.mjs` | 150 of 150 pass. New tests cover `--alias` and the capacity seed. |
| Deliberate bad link | A bad link in a temp copy of `lakehouse.md` failed G22. The clean branch run then passed. |
| `vendor-conflict-scan` (vendored) | 68 hits, 0 uncovered (2 new resize lines covered by the new overlay entry) |
| `context-budget-guard --repo` | 23,216 / 23,516, unchanged |
| `ondemand-index-check` | OK |
| Eval check samples | 72 of 72 good and bad lines score right (`p5_samples.py`) |

## Stage b: routing

**Isolation problem found and fixed.** A personal skill wins over a project skill of the same name. The
measured case: a marker project copy of `fabric` never fired, and the live `~/.claude` copy did. So a
probe run in a checkout read main's description, not the branch's.

`trigger-probe --alias fabric=fabric-p5` turns the personal skill off with `skillOverrides` and scores
the renamed branch copy as `fabric`. Proof: the marker fired and a Fabric prompt fired nothing.

Run p5a3: 50 cases, 3 models × 3 runs, then a top-up (r4) of the cases left with fewer than 2 answered
runs. 132 case-runs errored on the subscription rate limit. They are not counted as misses, because an
error is no routing evidence.

| Model | Answered case-runs | Hits | Negatives: `fabric` fires | 18 existing cases kept | 22 new cases routed |
|---|---|---|---|---|---|
| Sonnet | 150 | 149 | 0 (10 cases) | 18/18 | 22/22 |
| Opus | 100 | 100 | 0 | 18/18 | 22/22 |
| Fable | 100 | 100 | 0 | 18/18 | 22/22 |

Sonnet's one miss: the 429 prompt in r1 fired no skill (2 of 3 runs routed). Scores:
`.claude/cache/skills-intake/phase5/score-b-p5a3.txt`.

## Stage c: behaviour

`run_eval.py behavior`, evals 101-111, with vs without the branch hub, graded, 0 excluded. Sonnet and Opus
only (Dave). The first scoring found 4 with-skill never-line failures. All 4 were correct answers that
the eval 6 `brain-runner` check, copied into 104 and 105 by review M7, could not tell apart:
- a notebook job as brain-runner;
- a model write as brain-runner;
- a sentence that bans the bulk role PUT.

The checks were narrowed (commit `9d5f2ac`) and re-applied to the same saved answers:

| Model | With skill | Without | With-skill never-line failures | Below baseline |
|---|---|---|---|---|
| Opus | **76** | 52 | 0 | none |
| Sonnet | **76** | 50 | 0 | 105 (-1), 109 (-2), 111 (-2) |

Per eval (with / without, all expectations):

| Eval | Opus | Sonnet |
|---|---|---|
| 101 lakehouse schemas REST | 7/8 vs 7/8 | 7/8 vs 5/8 |
| 102 OneLake shortcuts | 7/8 vs 7/8 | 7/8 vs 5/8 |
| 103 copy job on F2 | 7/8 vs 5/8 | 8/8 vs 4/8 |
| 104 Dataflow refresh as service principal | 5/8 vs 1/8 | 8/8 vs 1/8 |
| 105 Direct Lake measure + DAX | 8/9 vs 7/9 | 7/9 vs 8/9 |
| 106 ontology + agent on F2 | 9/9 vs 4/9 | 9/9 vs 5/9 |
| 107 ontology single key | 8/9 vs 5/9 | 8/9 vs 3/9 |
| 108 SQL endpoint leak + insert | 8/8 vs 3/8 | 8/8 vs 4/8 |
| 109 job POST unknown outcome | 5/7 vs 5/7 | 3/7 vs 5/7 |
| 110 single role upsert | 6/6 vs 2/6 | 6/6 vs 3/6 |
| 111 auth vs capacity | 6/7 vs 6/7 | 5/7 vs 7/7 |

Below baseline, explained:
- **Sonnet 109 and 111:** the skill did not fire in the with-skill run (`skill_fired` false), so these
  measure Sonnet without the reference. The 109 prompt never says "Fabric". Follow-up 2.
- **Sonnet 105:** the answer read the reference but left out the `updateDefinition` path (one regex).

Scores: `.claude/cache/skills-intake/phase5/score-c-p5a-recheck.txt`. Run folder:
`%LOCALAPPDATA%\Temp\skill-eval\fabric-phase5-p5a`.

## Stage d: live smoke

PASS, 2026-10-04 23:04 UTC, Dave present.
- `python docs/playground/deploy.py preflight` (FourthCompanyBrain): 8 of 8. Capacity Active F2, no
  running job, GraphModel 0.
- Calls, read-only and one at a time: 8 calls, statuses 200 ×7 and 202 ×1, no 429.

| Test | Assertion | Result |
|---|---|---|
| LT-01 | each lakehouse GET returns 200 and reports its schema state | PASS: `kb_lakehouse`, no schemas (`defaultSchema` absent) |
| LT-05 | getDefinition returns TMDL parts and the shared expression names the Direct Lake mode | PASS: `brain_access_model`, 202 then capped poll, `AzureStorage.DataLake` = Direct Lake on OneLake |
| LT-07 | items list returns 200 with type counts | PASS: GraphModel 0, Ontology 0, DataAgent 1, Lakehouse 1, SemanticModel 2 |

Artifact: `.claude/cache/e2e/2026-10-04-intake-fabric-phase5-d.json`. Script:
`.claude/cache/skills-intake/phase5/stage-d-p5.py`. The token is never printed.

## Stage e: harness fit

- Conflict scan of the 5 authored references: 20 hits. All are the CCv3 stop-on-429 or never-line text
  itself; none tells the reader to retry.
- Tooling: `python` only; every install is pinned; Git Bash for vendored snippets. No Haiku and no API-key
  spend.
- Every reference line is tagged Learn, measured or unverified.

## Follow-ups

1. Fable stage c (evals 101-111) after the 7-day window resets on 2026-10-10 00:00.
   Command: `run-stage-c.ps1 -Tag p5a -Models fable`.
2. Sonnet did not call `fabric` on evals 109 and 111 in stage c. Add the word "Fabric" to the 109 prompt,
   or accept it as a routing measure. Phase 4 follow-up 12 (Fable eval 8) is the same class.
3. Phase 5b: vendor `semantic-model-authoring` + overlay (connection-binding 429 line, service principal
   impersonation line, Tier 1 MCP not registered) and the route precedence row.
4. Harness PR: H2 (package-install-guard on PowerShell, a pin check) and M2 (rule-router Fabric trigger
   prefixes).
5. Write tests LT-10 to LT-18 each need Dave's yes. C-13 (does an ontology create a managed graph?) stays
   open until LT-16.
6. `trigger-probe` keeps no stdout for errored runs. The rate-limit cause of the 132 errors is
   inferred from a later `rate_limit_event` (88% of the 7-day window), not read from the errored runs.
