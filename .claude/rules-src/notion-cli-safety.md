# Notion CLI (ntn) Safety Rules

Companion to `.claude/skills/notion-cli/SKILL.md`. The CLI's user-scoped token can read AND write
everything Dave can — treat writes with the same care as the Notion MCP, plus CLI-specific traps.

## Safe Commands (no confirmation needed)

- `ntn doctor`, `ntn --version`, `ntn api ls`, `ntn api <path> --spec`
- Any `ntn api` GET (no body, no `-X POST/PATCH/DELETE`)
- `ntn pages get <id>`
- `ntn datasources resolve <id>`, `ntn datasources query <id>` (all filters/sorts)
- `ntn files list`, `ntn files get <id>`
- `ntn workers list/get/capabilities list/runs list/runs logs/sync status`
- `ntn login`, `ntn login poll`, `ntn logout` (auth/session only)

## Dangerous Commands (ALWAYS confirm first)

Before running ANY of these, explain what it does and wait for explicit user approval:

- `ntn pages trash <id>` — trashes a page
- `ntn pages edit <id>` on any page NOT created this session — **full-page content replace**; especially with `--allow-deleting-content` (can delete child pages/databases)
- `ntn pages create` under a shared parent (Bridge HQ, Life Buckets, team pages)
- Any mutating `ntn api` call (POST/PATCH/DELETE) targeting shared surfaces, by ID:
  - Bridge HQ `30e76fd7ac8281e99fe1c0b257088b34`
  - Bridge Archive `30e76fd7ac8281258cd9d281aa873298`
  - Reports hub `38f76fd7ac8280478e50dd2956ba6e8a` (exception: the registered dashboard-sync job's own scoped update)
  - Life Buckets DB `9ec76fd7-ac82-8342-8bc3-87129f7cf1dc`, Projects DB `33b76fd7-ac82-8234-a202-8719384ac5b1`, Tasks DB `c3176fd7-ac82-825c-a03c-073837e5493c`
- `ntn api -X DELETE v1/blocks/<id>` — deletes a block
- `ntn files create` (uploads content to the workspace)
- `ntn workers deploy / delete / create`, `ntn workers env set/unset/push`, `ntn workers sync trigger/pause/resume/state reset`, `ntn workers oauth start`
- `ntn update` / `winget upgrade Notion.ntn` — version churn breaks scheduled jobs; manual, deliberate only

## Job-owned pages (scoped exception)

Registered scheduled jobs may write WITHOUT per-run confirmation ONLY to pages declared job-owned:
- Reports hub scheduled-tasks section (dashboard-sync job)
- The **Report Runs** registry database `4e4c9460-8818-4352-a056-88badbaa94ce` (data source `c7d2d9e3-d388-4640-a66e-88f7dd50f854`) under the Reports hub — **row upserts only** (`ntn api v1/pages` create/update keyed by unique `Run ID`, append-all-attempts) by the 6 report pipelines via `scripts/report-registry/upsert.mjs`. Machine-owned; humans read the views, don't hand-edit rows. Its 6 report-type child pages (VP Weekly / FourthOS Sponsor / Team Dashboard / System Health / Project Portfolio / Self-Improvement) are likewise job-owned for machine `## Current run` refreshes. IDs pinned in `scripts/report-registry/report-runs.ids.json`.
- The Helm page + `Helm Projects` DB (helm sync job, once created)
Everything else in the workspace is human/Eve territory — confirm first.

## Non-interactive contract (prevents hangs, not just accidents)

- Every scripted call: stdin redirected from NUL (`</dev/null`) — `ntn` waits on open stdin (proven hang).
- Confirm-gated verbs (e.g. `ntn workers delete`, `ntn workers env pull/push`, `ntn pages trash`) need `--yes` (or the equivalent confirm flag) — without it they error `Cannot confirm in a non-interactive environment` and deadlock automation.
- Hard timeout; nonzero exit fails loud; log `ntn --version` per run.
- Payloads via stdin JSON / `--data`; never inline fields with `:` or spaces in values.
- Auth probe = `ntn doctor` or `pages get` on a known page; `v1/users` 403s on personal tokens by design.

## Token hygiene

- Never print `NOTION_API_TOKEN`, keychain entries, or `auth.json` contents.
- If `NOTION_KEYRING=0` file auth is used for a task: pin `NOTION_HOME` to a local non-roaming dir, ACL-restrict to the task user, never commit.
- Bridge writes stay on the Notion MCP per the notion-bridge skill — do not migrate them to ntn without a fresh fidelity spike on selection-string semantics.
