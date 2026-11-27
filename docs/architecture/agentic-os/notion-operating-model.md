# Notion Operating Model

## Role of Notion

Notion is the canonical human database and project-management surface for Agentic OS. It owns portfolio/project intent, tasks, curated decisions and knowledge, the human-facing approval inbox, and links to run artifacts. PostgreSQL owns the operational approval state consumed by workers. Notion does not own worker leases, every tool event, raw prompts, high-volume logs, secrets, or queue semantics.

This boundary is required because Notion applies per-connection and workspace rate limits: [official limits](https://developers.notion.com/reference/request-limits). PostgreSQL stores high-frequency runtime facts; Notion receives concise, idempotent projections.

## Existing resources to reuse

| Resource | ID |
|---|---|
| Claude Bridge HQ | `30e76fd7-ac82-81e9-9fe1-c0b257088b34` |
| Claude Bridge bucket | `30e76fd7-ac82-81e1-b30e-d170600896a7` |
| Projects data source | `33b76fd7-ac82-8234-a202-8719384ac5b1` |
| Tasks data source | `c3176fd7-ac82-825c-a03c-073837e5493c` |
| Weekly Work Tracker data source | `6e8d9b17-f8ef-4d56-9f13-00344650ac03` |
| Default AI Enablement project | `34b76fd7-ac82-8104-82ca-df3e801695c0` |

The live Projects schema uses `Project` as title, `Status` values `Inbox|Planned|In progress|Completed`, `Timeline`, `Bucket`, and relations to Tasks and Tracker Entries. The Tasks schema uses `Task` as title, `Description`, `Priority` values `High|Mid|Low`, `Progress`, completion checkbox ` `, `Due Date`, `Project`, and `Bucket`.

## Live v1 project structure

The [Agentic OS project](https://app.notion.com/p/3a276fd7ac828122a0d5f57eb93cb5b1) exists with status **In progress** and is related to the Claude Bridge bucket. Its six phase tasks are:

1. [Phase 0: workflow audit and architecture validation](https://app.notion.com/p/3a276fd7ac82815d8d2cc3b500aadb34)
2. [Phase 1: contracts, migrations, and registry](https://app.notion.com/p/3a276fd7ac828136be25fd044161fb28)
3. [Phase 2: durable runner and sandboxed worker](https://app.notion.com/p/3a276fd7ac828106b37dc4cee52913da)
4. [Phase 3: Notion sync, approvals, and reference workflows](https://app.notion.com/p/3a276fd7ac8281fe8e28db37cc13032c)
5. [Phase 4: operator dashboard and live telemetry](https://app.notion.com/p/3a276fd7ac82817b88e0cf3121215e2b)
6. [Phase 5: security review, acceptance, and production deployment](https://app.notion.com/p/3a276fd7ac8281d6b411c3d21be24fb4)

All six tasks are related to both the project and Claude Bridge bucket. Relations were set after page creation to follow the database contract.

Do not guess due dates. Set progress from verified implementation state, not elapsed time.

## Ownership and synchronization

| Change | Authoritative write | Projection behavior |
|---|---|---|
| Project name/status/timeline | Notion Projects | Webhook enqueues refresh; dashboard updates. |
| Task description/priority/completion | Notion Tasks | Webhook creates/updates an execution request only when an explicit automation property or approved command is present. |
| Run state | PostgreSQL | Sync concise status, run URL, artifact links, and last error to the related Notion page. |
| Approval display/command | PostgreSQL operational approval state | Notion or dashboard submits an idempotent decision command with expected version; PostgreSQL resolves conflicts/expiry/revocation, then projects the result everywhere. |
| Artifact | Object store/repository + PostgreSQL metadata | Notion receives link/embed and summary, not duplicate large payloads. |
| Implementation handoff | Bridge child page | HQ receives one-liner; Tracker receives deduplicated row by writeback URL. |

## Idea to product path

This is the one map of how an idea becomes a product, stage by stage. It extends the ownership split above: Notion owns the idea and the brief, Git owns the code, PostgreSQL owns the lane board and runtime state. It is also the checklist for the first customer run (lane `factory-first-customer`). The states were read against `main` on 2026-11-27. A state that was not checked says "not verified".

| # | Stage | Tool today (repo path) | Owner | State | First-run check |
|---|---|---|---|---|---|
| 1 | Capture: an idea is written down | Notion captures and Eve on claude.ai. The repo has no capture or intake skill (`.claude/skills/`); the YouTube intake was removed 2026-08-30 (`ROADMAP.md:44`). | Dave, Eve | Not built in the repo | Write the capture time as clock line 1. Count captures in Notion once, as the baseline. |
| 2 | Brief: a vague idea becomes a brief that Dave approves | `.claude/skills/discovery-interview/SKILL.md`, `.claude/skills/to-spec/SKILL.md`, `.claude/skills/grill-with-docs/SKILL.md`. `synthesize-brief` and `approve-brief` are claude.ai account skills and are in no repo file. | Dave (claude.ai account skills) | Partly: the skills exist, and nothing joins an approved brief to a lane or a program map | Write the acceptance statement in the brief. Write the approval time as clock line 2. |
| 3 | Plan: the brief becomes cards with dependencies | `.claude/skills/plan-agent/SKILL.md`, `.claude/skills/premortem/SKILL.md`, `lane.mjs seed` (`scripts/coordination/lane.mjs:105`), the master card (`docs/review-engine/README.md`) | The seat, with Dave's plan tap | Partly: `seed` loads a hand-written JSON file (`scripts/coordination/lane-seed-file.mjs`); no path from an approved brief to a seed file | Write the plan GO time as clock line 3. List every hand copy from brief to cards. |
| 4 | Build: a builder makes the change | A lane claim, one worktree and one branch (`docs/coordination/standard.md`, rules L2.2 and O3.4); RED test first (`docs/testing-standard.md`) | A builder session | Built | Write the first merge time as clock line 4. |
| 5 | Check: proof before a PR opens | `scripts/github/pre-pr.mjs`, `scripts/coordination/run-lock.mjs`, `.claude/agents/aegis.md`, `.claude/agents/critic.md`, the review engine (`docs/review-engine/README.md`) | A builder and the seat | Built for CCv3. Partly outside it: in a new repo pre-pr fails until the repo has its own review config, summary file and gate scripts (see Gates outside CCv3). | List which of these gates ran in the new repo and which did not. |
| 6 | Ship: the change is merged and live | `scripts/github/ship-ask.mjs`, `scripts/github/wait-ci.mjs`, `scripts/github/review-status.mjs`, `.claude/hooks/src/decision-gate.ts`, `scripts/github/land-pr.ps1` | A builder, the seat and Dave's taps | Built for a land in CCv3. Partly outside it: the decision gate does not apply in an unregistered folder, and the land script was read, not run, outside CCv3 (see Gates outside CCv3). | Write the in-use time as clock line 5. Log every ask to Dave outside idea, plan and final check. |
| 7 | Learn: the result is read back | `.claude/skills/create_handoff/SKILL.md` (handoffs), `opc/scripts/core/recall_learnings.py` (memory), `scripts/coordination/friction-counts.mjs`, `docs/self-improvement/` | Dave and the seat | Partly: these measure how the process behaves. Nothing reads a result back into the brief. | Add a dated result line to the brief and compare it with the acceptance statement. |

The five clock lines (captured, brief approved, plan GO, first merge, in use) are lane notes with a time from a clock read, not an estimate. The lane board (`scripts/coordination/lane.mjs`, `docs/coordination/standard.md`) holds the lane of each card from stage 3 on. The Agentic OS app (`apps/agentic-os`) shows it.

### Gates outside CCv3

Tried on 2026-11-27 in a scratch git repo outside CCv3: no remote, no registry change, no spend, nothing pushed. The land script was read, not run. The evidence files (`gate-list.md` and the saved outputs) are in `.claudedocs/e2e-factory-gate-list/` in the primary checkout: local, not in Git.

| Gate | Result | What a new project needs |
|---|---|---|
| pre-pr preflight and run | Fails until set up. It stops at each missing piece in turn: `review-router.config.json`, then `.claude/cache/pre-pr/summary.md`, then `scripts/rules/context-budget-guard.mjs` (the always gate runs a script from the repo). With the config, a path that no surface owns gets only the always gate. | A `review-router.config.json` with the project's surfaces and gates, the gate scripts, and the summary file each run. A stamp needs the CodeRabbit CLI step. |
| Decision gate (PR create, merge) | Does not apply in an unregistered folder: three payloads for a foreign repo were allowed, and the same text naming CCv3 was denied (`.claude/hooks/src/decision-gate.ts:2597`). A folder covered by a registry entry gets the app rule; not tried. | A project registry entry, with Dave's yes. Without it a builder can open a PR or merge with no tap. |
| Land script | Read, not run. `-Repo`, `-RepoPath` and `-NoSync` exist (`scripts/github/land-pr.ps1:87`); every merge call is `gh api repos/$Repo/...`; the sync step runs unless `-NoSync`. | The three parameters set, a `gh` login that can merge there, a remote of the expected name, and the Land tap above. |
| Review router `bandOf` | Works with CCv3's config; returns null with none. | The project's own config with its critical paths. |
| `lane.mjs` | No board: exit 1 with the register hint. | A board, by `lane.mjs project register` with Dave's yes. Not tried. |
| Session hooks (rule-router, decision gate by command text) | Fire outside CCv3. | Nothing. |
| Repo git hooks (secret scan, sync after commit) | Missing in a new repo. | The secret-scan commit hook, by `factory-init`. |

Order for the first customer idea: the registry entry (so the taps apply), the repo config and gate scripts, the commit hook, the land flags, then a board.

## Outbox protocol

1. State transition and `outbox` row commit in one PostgreSQL transaction.
2. Sync worker claims the outbox row with a lease.
3. Operation id is `notion:<workspace>:<aggregate>:<projection-version>`.
4. Worker queries for an existing receipt/Notion URL before create.
5. `429` and `529` honor `Retry-After`; other transient failures back off with jitter.
6. Success stores Notion page id, URL, content hash, and last edited time.
7. Reconciliation job compares authoritative hashes and reports drift; it never overwrites human-owned fields.

Approval projections use the same outbox path. They are never treated as evidence that an action may run until the versioned decision command has committed in PostgreSQL.

## Bridge completion writeback

After this design package or a future implementation milestone:

1. Fetch Bridge HQ.
2. Create a `[Code→Eve]` child page with the canonical template.
3. Add a one-line entry to Code → Eve.
4. Mirror a Weekly Work Tracker row, deduplicated by writeback URL.
5. Add an Implementation Log entry for shipped work.
6. Update Sprint State only if an existing commitment changes.

## Security

- Use an internal integration for server automation and a PAT only for local personal workflows.
- Store tokens in Railway/environment secret storage, never Git or Notion content.
- Grant the integration only the required databases/pages.
- Verify webhook signatures before enqueueing.
- Require an approval for schema changes, bulk updates, deletes, moves, or relation rewrites.
- Record every Notion write as a tool operation with request hash and response receipt.

Official guidance: [authorization](https://developers.notion.com/guides/get-started/authorization), [API key handling](https://developers.notion.com/guides/get-started/handling-api-keys), and [MCP security](https://developers.notion.com/guides/mcp/mcp-security-best-practices).
