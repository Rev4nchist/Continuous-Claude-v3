# Skill intake for CCv3: Microsoft Fabric as the first case (2026-10-02)

Verdict: ADOPT, phased. Status: proposed. Built from workflow `wf_5ac1f1a6-65a` (5 research agents, 1 designer,
1 critic; verdict "ready with changes", all 15 critic fixes applied below). Research reports:
`.claude/cache/skills-intake/research-*.md` (gitignored). Upstream studied: `microsoft/skills-for-fabric`
v0.3.18 (`6c11ad5`, 2026-09-24), MIT, 25 skills, weekly releases mirrored from an internal Microsoft repo, no
tests or evals upstream.

## 1. Answer

- Do not install the Microsoft plugin globally. It is all-or-nothing (24 + 2 skills, 5 agents, 3-4 MCP
  servers), ungated, and adds 9,848 listing chars to every session in every repo (+66%; our ratchet allows +2%).
- Vendor a pinned copy of only the skills we need into `.claude/skills/_vendor/skills-for-fabric/`, keeping the
  upstream layout so the shared `../../common` links resolve. Expose it through ONE CCv3 hub skill, `fabric`.
- Author the gaps upstream does not cover: the Fabric Data Agent SDK now; AI Functions when the Rayfin track
  needs it (both exist upstream only as doc links).
- Every import passes a 5-stage intake gate (static, collision, behaviour, live smoke, harness fit). The same
  gate applies to any external skill, not only Fabric.
- Fabric rules stay in the global on-demand rule `fabric-playbook.md` (made project-neutral). Project facts
  (workspace, capacity, preflight) stay in each project's CLAUDE.md. Two "never" items become hard guards.
- Upstream updates never arrive on their own: a check reports a new release; a pull PR re-runs the gate.

## 2. Intake paths

| Path | Use when | Fabric |
|---|---|---|
| A. Repo skill, forward-synced (`.claude/skills/`) | CCv3 must gate, evaluate and own the behaviour; global in every repo | Default: vendored tree + hub |
| B. `npx skills` CLI (`~/.agents/skills` + junction) | A small single-folder skill used as-is | No: per-skill install breaks the shared `common/` links |
| C. Plugin marketplace | A vendor bundle we accept whole, at project scope, mainly for its MCP servers | Later, project scope, MCP only |
| D. claude.ai account skill | Must also work on claude.ai web | No (report-only by the skills-review decision) |

Why A: the gate never sees plugin skills; `skillOverrides` cannot switch plugin skills off, so a plugin cannot be
evaluated against a no-skill baseline; forward sync already carries `.claude/skills/**`.

## 3. The intake gate (any external skill)

Artifacts: `.claude/cache/e2e/<date>-intake-<source>-<stage>.*`.

(a) Static
- `audit-skills.mjs --profile vendor` (new): scans `.claude/skills/_vendor/*/skills/*` explicitly. Today the gate
  skips every `_`-prefixed folder (`audit-skills.mjs:44`), so vendored files would have NO pre-commit coverage.
  Pre-commit runs the vendor profile whenever a staged path is under `_vendor/`. Prove it with a deliberate
  failure.
- Hard for vendored skills: G01-G03, G06-G08, G11, G22 (resolved against the vendor root), G25, G27, G28.
  Advisory for vendored skills (their descriptions never reach the listing): G09-G10, G12-G14, G20-G24, G26.
  Hard for CCv3-authored skills: everything.
- Gate fixes found by the run: G26 must not flag `api-version=` pins; G12 must not read "Pay-As-You-Go" as
  first person.
- Conflict scan: grep vendored text for CCv3 "never" items; every hit needs an overlay entry. Seeds:
  `retry|backoff|Retry-After|429` (upstream `common/COMMON-CORE.md:284-449` says retry on 429; our playbook says
  stop on the first capacity error), capacity pause/resume/resize, bulk `PUT .../dataAccessRoles`, `python3`,
  `apt-get|brew`, `npm install -g`, unpinned `pip install`, ODBC Driver 18, `FabricOpenAI(`.

(b) Collision
- `trigger-probe.mjs` before and after the import on Sonnet, Opus and Fable, each case run 3 times (one sample
  per case cannot discriminate). Bar: every existing case keeps its owner; at least 8 of 10 Fabric cases route
  to `fabric`; plain SQL still routes to `databases`.
- Settle `kusto-cli` vs upstream `eventhouse-cli` before vendoring `eventhouse-cli`: `kusto-cli` keeps Kusto.Cli
  queries and export. Until then the hub description does not claim Eventhouse.
- `rule-router-probe.mjs`: the playbook fires on the hub skill, `sqlcmd`, and Kusto hosts.

(c) Behaviour
- `run_eval.py behavior --models sonnet,opus,fable --grade`, at least 3 evals per skill. Needs one runner change
  first: `--companion <dir>` copies the vendored root next to the eval copy (same relative layout) and adds a Read
  deny for `~/.claude/skills/_vendor/**`, or the hub's links dangle in the temp project.
- Third arm for the "never" cases: every eval run turns hooks off, so the rule-router never injects the playbook
  in either arm. "Never" cases compare playbook-in-context + no skill against playbook + hub, and are graded by a
  deterministic check (for example "no retry after 429") rather than the LLM grader.
- Eval sources: upstream `prompt_examples/` (13 prompts); the playbook "never" items; the 8 Learn failure modes
  (`FabricOpenAI`, wrong PySpark import, `temperature` on GPT-5, `ds.select("dbo", t)`, service-principal
  management of a data agent, T-SQL `UPDATE` without `ISNULL`, no cost sample, LLM judge); real
  FourthCompanyBrain tasks.
- Bar. Keep: skill-on beats no-skill on at least 2 of 3 models and breaks no "never". Adapt: it wins but one
  overlay line is needed (re-run must pass). Reject: no lift, or needs more than about 5 overlay lines.

(d) Live smoke, only where safe
- In the FourthCompanyBrain playground, with Dave present, after the project preflight (it covers the 4 token
  audiences and MFA expiry). One read-only call per kept skill. Stop on the first 429 or capacity error. Never
  pause, resume or resize a capacity. No `evaluate_data_agent` runs (they bill AI Query capacity).

(e) Harness fit
- Git Bash, not WSL bash; `python`, not `python3`; no `npm -g` or unpinned `pip`; MCP `npx` via `cmd /c`; no API
  key spend; never Haiku (do not import the 5 upstream agents); ASD-STE100 for CCv3-authored text only.

## 4. Adapt layer

- Vendored tree, never edited. Ships `LICENSE` (MIT notice is required in copies), `CHANGELOG.md` and a
  `PROVENANCE.md` (repo, tag, commit, date, allowlist). `.gitattributes` gets `.claude/skills/_vendor/** -text` so
  bytes stay identical to upstream (this machine has `core.autocrlf=true`; per-file hashes would otherwise drift).
- Hub `fabric` (CCv3-owned): description at most ~250 chars (the listing ratchet leaves ~297 chars of slack).
  Body: the "never" lines inline at the top (critical rules first, they survive compaction), then the
  workload-to-skill table. The table rows are generated from `vendor.lock.json`, so an upstream rename shows up
  in the same pull diff. The Data Agent and AI Functions skills are rows here, not separately listed skills,
  unless the trigger probe shows the hub hop loses them.
- Overlay entries are keyed by topic and the conflict-scan regex, not by line number (weekly renames would make
  line refs stale).
- Rules: `fabric-playbook.md` stays global; replace its FourthCompanyBrain-specific preflight path with "run
  the preflight the project's CLAUDE.md names". Widen its manifest triggers to the hub skill, `sqlcmd` and Kusto
  hosts.
- Hooks: no new hook. Add `destructive-command-guard` patterns for capacity suspend/resume/resize and bulk
  `PUT .../dataAccessRoles`: the two "never" items where one skipped read costs money or deletes access.

## 5. Any repo, any Fabric project

- Global (synced to `~/.claude`): the hub, the vendored tree, authored skills, the playbook rule, the guards.
- Per project: a CLAUDE.md "Working in Fabric" block (workspace, lakehouse, tenant, data rule, preflight
  command); a project `.mcp.json` only when that project needs the Fabric MCP servers.
- FourthCompanyBrain: the demo itself uses no Fabric (`docs/demo/demo-runbook.md:10`); the Fabric need is the
  playground and the hand-over to the Fourth test space. Its registry entry says "TypeScript, Node.js" but the
  code is Python and Fabric notebooks. Its reusable Fabric code (preflight, incident log, retry wrapper, SP
  runner) has hard-coded ids that break at the hand-over: a later phase moves it to shared `scripts/fabric/`.

## 6. Maintenance (kept small)

- `vendor-sync.mjs --check`: run by hand or folded into the existing Monday audit task; reports a new tag,
  changed or renamed allowlisted skills, and new conflict-scan hits.
- `vendor-sync.mjs --pull <tag>` on a branch; the PR shows the instruction diff (a human reads it) and re-runs
  stages a-c on changed skills.
- Retire = move to `.claude/skills/_archive/<date>/` with a note, never delete.
- Not now (YAGNI for a 2-skill pilot): a weekly scheduled task, a behaviour-score ratchet, usage-based
  retirement, a monthly Learn-page diff.

## 7. Phases (one PR each)

0. Probe (about 10 minutes, no PR): does Claude Code list a nested `_vendor/x/skills/probe/SKILL.md` under
   `~/.claude/skills`? Read the session's init skill list. If it does, rename vendored files `SKILL.vendor.md`
   with a scripted, hash-checked transform.
1. Rules first: playbook project-neutral; manifest widened; destructive-guard patterns; FourthCompanyBrain
   CLAUDE.md Fabric block. Evidence: `rule-router-probe.mjs`, the guard fed real payloads, context budget.
2. Tooling: gate `--profile vendor` + pre-commit trigger + conflict scan; G26/G12 fixes; run_eval
   `--companion` and the third arm. Evidence: deliberate-failure tests.
3. Pilot import: vendor `spark-cli` and `search-consumption-cli` (both work through `az rest` here) + `common/`;
   hub `fabric`; overlay. Not `sqldw-cli` yet: its only T-SQL path is an MCP server we do not enable globally.
   Evidence: gate, trigger probe x3, run_eval on 3 models, one live read call.
4. Authored gap skill `fabric-data-agent` (Responses API, pinned SDK, `ds.select` full path, owner-only
   management). AI Functions waits for the Rayfin decision.
5. Shared Fabric tooling in `scripts/fabric/`, then more vendored skills on demand.

## 8. Decisions for Dave

Answered 2026-10-02: all four as recommended (vendored pin + `fabric` hub; pilot `spark-cli` +
`search-consumption-cli` vendored and `fabric-data-agent` authored; split KQL ownership by job; keep the
telemetry header).

1. Intake default for Fabric: vendored pinned tree + `fabric` hub (recommended), or a project-scope plugin per
   Fabric repo.
2. Pilot set: `spark-cli` + `search-consumption-cli` vendored, `fabric-data-agent` authored (recommended).
3. Eventhouse: `kusto-cli` keeps Kusto.Cli query/export; `eventhouse-cli` owns KQL authoring when vendored
   (recommended).
4. The upstream `x-ms-fabric-skill` telemetry header on every Fabric REST call: keep it (recommended: not
   sensitive) or strip it in the overlay.

## 9. Risks

- [Speculation] The hub hop may lower lift against first-class skills; stage (c) compares hub vs direct.
- The Data Agent SDK is alpha (0.1.32a0) and renames methods between versions; the authored skill pins it.
- Learn pages disagree on the data agent token audience; stage (d) tests both.
- F2 capacity throttles hard (FourthCompanyBrain lost 27 of 40 answers in one pass); stage (d) stays at one
  read call per skill.
- Eval spend: about 3 models x 3 arms x 3+ evals per skill on the subscription; dry-run first.
- The Codex mirror (`~/.agents/skills`) is stale; Codex parity is out of scope.
