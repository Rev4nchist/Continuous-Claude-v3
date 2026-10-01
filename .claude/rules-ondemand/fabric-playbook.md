# Fabric playbook (loads on the first Microsoft Fabric call)

Each line comes from a real mistake. The evidence and history: `docs/playground/FABRIC-LESSONS.md` in
FourthCompanyBrain (`L-NN` ids below). A project without that file: keep the rules, start its own log.

## Before you start
- Run the project's preflight first (FourthCompanyBrain: `python docs/playground/deploy.py preflight`). It checks
  the az account, four tokens without interaction, the capacity state, running jobs, cost items and untriaged
  incidents. MFA expires tokens per resource without warning (L-06).
- Unattended Fabric jobs (pipelines, notebook jobs) fail with `AADSTS50076` when they run as an admin user whom
  security defaults force through MFA. `az login` and a portal sign-in do not fix it. Run them as a service
  principal, or by hand in the portal (L-20).
- "Failed to create session" can be an auth failure, not throttling. Read the job's full `failureReason` before
  you classify or stop a run (L-21).
- Never pause, resume or resize a capacity from a script. That is the owner's step.
- Invented data only in a playground tenant. Never a customer account, customer data or customer system.

## Capacity and cost
- Small capacities (F2) throttle after hours of steady load. Interactive calls fail first (HTTP 429: graph
  queries, data agent, DAX), then background jobs ("capacity has exceeded its limits"). On the first capacity
  error: stop all load and report. Retries keep the throttling going (L-07).
- One Fabric job at a time on an F2. Time-box every Fabric agent and report at least every 60 minutes (L-19).
- Graph compute bills at about 5 times the normal rate. Each graph item holds a cache billed about $0.82 a day.
  At most one graph; delete it once its evidence is saved. Never one graph per test case (L-08).
- A graph is not a snapshot: a refresh reads the current tables. A pause drops a graph's loaded data; queries
  return HTTP 500 until a refresh (L-09).

## API facts
- Tokens come from `az account get-access-token` and stay in memory. Never print one.
- A dead poller never stops a Fabric job. Re-attach by job instance id. A timed-out command is not a failure (L-02).
- Call the SQL endpoint `refreshMetadata` after every pipeline run, before any T-SQL (L-04).
- T-SQL on this machine: `mssql-python`. There is no ODBC Driver 18 (L-05).
- OneLake security role names: letters and digits only. Create roles one at a time. The bulk PUT deletes every
  role missing from its body, `DefaultReader` too (L-10).
- Data agent: the Assistants endpoint retired 2026-08-26; use the agent's MCP endpoint. Require a references
  line in every answer and score by references in code, never by an LLM judge (L-14).

## Security model
- The SQL endpoint's default (delegated) mode ignores OneLake roles: a Viewer reads every table. User identity
  mode is a portal-only switch and cancels running queries (L-11).
- Admins, Members and Contributors bypass OneLake security. Test tiers with Viewers only (L-12).
- A service principal cannot run DAX on a Direct Lake on OneLake model or get Build. Power BI viewer checks need a
  real signed-in test user (L-13).
- `DefaultReader` grants `*` (Files too) to every ReadAll holder. Publish to web bypasses every tier (L-18).

## Evidence and capture
- Every Fabric claim names a job instance id or a query result, saved under `.claudedocs/`.
- An ontology, graph or agent result that differs from the rule-based SQL result is a failed test.
- Serve local HTML over `python -m http.server` on 127.0.0.1 for Playwright; it refuses `file://` (L-01).
- A new Fabric mistake: the scripts log it to `.claudedocs/fabric-incidents.jsonl`. Triage it with
  `deploy.py incidents` at phase end and in every handoff: match a lesson or add one; promote it to this file
  when it cost money, cost more than 30 minutes, or happened twice. Prefer a guard in code.
