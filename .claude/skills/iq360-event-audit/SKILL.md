---
name: iq360-event-audit
description: Produce a multi-step iQ360 event coverage/quality audit report with CSVs and dev-gap callouts. Use when the user asks for "metrics", "an audit", "coverage", "EBR/QBR numbers" on an iQ360 event. Not for single ad-hoc counts — use iq360-events.
disable-model-invocation: true
---

# iQ360 Event Audit

Reusable, parameterised version of the analysis that produced the Brinker availability metrics. Given a customer + one or more events + a window, this skill produces standard coverage metrics, named-user resolution, time-to-decision pairing (where a request/decision pair exists), and a written callout of any data gaps that look like instrumentation bugs.

This is a workflow skill — it leans on `iq360-events` for ADX auth/queries, on the Rally MCP for raising stories, and on the local Confluence event reference for catalogue lookups.

---

## When to use

Trigger on prompts like:
- "Pull all `<event>` events for `<customer>` over the last `<N>` days"
- "Tell me how `<event>` is firing for `<customer>`"
- "Audit `<event>` for `<customer>`" / "build EBR metrics for `<customer>` on `<event>`"
- "How many distinct users/locations are involved in `<event>` at `<customer>`"
- "Is `<event>` valid? what's missing?"
- Any follow-on after an iQ360 event question where the user wants a structured CSV report

Do NOT trigger for:
- Generic "show me a count" — use `iq360-events` directly
- Defect investigations on PM events — use `pm-copilot`
- Pulling raw rows with no analysis — use `iq360-events` directly

---

## Inputs to confirm before running

Before any query, restate these back to the user (one short sentence) so they can correct you:

1. **Customer ID** — Salesforce-style ID (e.g. `0016R00003Fr6NbQAJ` = Brinker). If the user gives a name, look it up in the `RawCustomer` ADX table (`RawCustomer | where tostring(doc) contains "<name>" | take 5`) or ask. Do not guess. Known: Brinker = `0016R00003Fr6NbQAJ`, HMSHost = `868316f0-86d2-4e2c-a789-a7cf01054a5a` (PM), BurgerWorks Colorado = `8cab4d63-5ccc-40ee-b9f3-aed600f057de`.
2. **Event(s)** — full event_type string(s) from the iQ360 catalogue, OR a feature area (e.g. "availability", "shift swaps") that you'll resolve to specific event types via the [iQ 3.0 Event Reference](https://fourthlimited.atlassian.net/wiki/spaces/~71202084466b55996746e8a87d29d67b755b76/pages/6173229088/HotSchedules+iQ+3.0+Event+Reference).
3. **Window** — default `30 days`. Accept "last week", "last quarter", explicit dates.
4. **Region** — NA (default) or EMEA. Brinker, HMSHost, BurgerWorks → NA. UK customers → EMEA.

If any of these is missing or ambiguous, ask before running. Wrong customer ID is the most common reason for an audit returning zero events.

---

## Required connectors, MCPs, CLIs — and the access your coworker needs

| Tool | Used for | Access required | How to verify |
|------|----------|-----------------|---------------|
| **`az` CLI** | Bearer token for ADX (Kusto) | Azure login + read on `production-na-csp` and/or `production-emea-csp` subscription. Resource: `de-adx-iq360-prod{na,emea}.{eastus2,northeurope}.kusto.windows.net` | `az login` then `az account get-access-token --resource "https://de-adx-iq360-prodna.eastus2.kusto.windows.net" --query accessToken -o tsv` should print a JWT. If it returns 403 or empty, request access from the iQ360 / Data Engineering team. |
| **Python 3 + `curl`** | Run analysis scripts, hit Kusto REST API | Pre-installed on macOS | `python3 --version` and `which curl` |
| **`gh` CLI** | Look up which HotSchedules / PM repo emits the event when callouts surface | Authenticated as `LWilsonfourth` (or any Fourth GitHub account) | `gh auth status` |
| **Rally MCP** (`mcp__fourth-rally-mcp-azure__*`) | Raise a Rally story when an instrumentation gap is found; search for existing related stories before creating duplicates | MCP server configured in Claude Code settings; user must be a Rally subscriber on `Fourth` workspace | Call `mcp__fourth-rally-mcp-azure__get_feature` with `F29839` — should return the "IQ 360 Q2 Events" feature. If 401/404 → re-auth the MCP. |
| **Sumo Logic MCP** (`mcp__sumologic__search_sumologic`) | Optional — investigate why an event isn't firing in a code path | Sumo creds bound to MCP | Search for any recent log line; if it returns rows, you're in. |
| **Confluence event reference page** | Look up the spec for an event before auditing — what fields *should* be populated | Browser access to `fourthlimited.atlassian.net`. **There is no Confluence MCP** — read in browser and paste relevant section into the chat if needed. | Open the link below in a browser. |
| **iQ360 Events subskill** (`/iq360-events` in `~/.claude/skills/iq360-events/SKILL.md`) | Source of cluster URIs, schema, common KQL patterns | Already installed | `cat ~/.claude/skills/iq360-events/SKILL.md` should print it |
| **VPN** | NOT required for ADX or Rally MCP. Required only for downstream HS/PM SQL DB lookups (rare for this skill). | GlobalProtect / Fourth VPN | Try `ping 10.91.64.139` — if it responds, you're connected |

### Reference document — iQ 3.0 Event Catalogue

[HotSchedules iQ 3.0 Event Reference (Confluence)](https://fourthlimited.atlassian.net/wiki/spaces/~71202084466b55996746e8a87d29d67b755b76/pages/6173229088/HotSchedules+iQ+3.0+Event+Reference)

This is the canonical list of HotSchedules iQ360 event types and their expected payloads. **Always cross-check the audited event against this page before flagging anything as broken — what looks like a missing field may be intentional per the spec.** If the spec says a field is optional and it's empty, that's not a bug. If the spec says it should be populated and it isn't, that's a callout.

---

## First-time setup checklist (for your coworker)

Run through this once on a new machine before kicking off the skill:

```bash
# 1. Azure CLI
brew install azure-cli       # if not installed
az login                     # browser-based login with Fourth SSO
az account list --query "[].name" -o tsv     # confirm production-na-csp is in the list
az account set --subscription "production-na-csp"

# 2. Sanity-check the ADX token
az account get-access-token \
  --resource "https://de-adx-iq360-prodna.eastus2.kusto.windows.net" \
  --query accessToken -o tsv | head -c 20 ; echo

# 3. Python
python3 --version            # 3.9+ is fine

# 4. GitHub CLI (only if you'll do code lookups)
gh auth status

# 5. Confirm Rally MCP works inside Claude Code
# In the Claude Code session, run:
#   "Get feature F29839"
# It should return "IQ 360 Q2 Events". If it errors, the MCP server is not configured.

# 6. Open the Confluence event reference in a browser tab and keep it handy.

# 7. Output directory
mkdir -p ~/Desktop/fourth-assistant/exports
```

If any step fails, **stop and ask Lee or the iQ360 / Data Engineering team for access** before running an audit. Don't fall back to mock data — produce nothing rather than wrong numbers.

---

## Analysis workflow

For every audit, follow these steps in order. Communicate progress to the user with a one-line update at each step.

### Step 1 — Look up the event spec

Open the [iQ 3.0 Event Reference](https://fourthlimited.atlassian.net/wiki/spaces/~71202084466b55996746e8a87d29d67b755b76/pages/6173229088/HotSchedules+iQ+3.0+Event+Reference) and find the audited event. Note:
- Expected `actorType` and `actorId`
- Required vs optional `context` fields
- Whether the event is part of a request/approval pair (check sibling events)
- Source system (HotSchedules / Adaco / etc.)

If the user supplies a feature area (e.g. "availability"), resolve to all related event types from the catalogue.

### Step 2 — Confirm scope

Echo back to the user: "Auditing `<event>` for `<customer>` over `<window>` on `<region>`. Looking for `<list of expected fields>` and any pair-wise relationships. OK?" — wait for ack only if any input was ambiguous.

### Step 3 — Sample one row of each event type

Get a token, run a `take 1` query on each event_type, and inspect the full row. Confirm:
- `is_valid` distribution (any false?)
- `actor_id` populated?
- `context` populated? Is `context.someField` a stringified JSON (needs `parse_json(tostring(...))`) or a real nested object?
- What does `external_user_id` represent for this event — actor or subject?

### Step 4 — Compute baseline coverage

For each event type in scope, compute:
- Total count
- `is_valid` true / false counts
- For each documented field: how many rows have it populated (use `extend has_X = isnotempty(...)` then `summarize countif()`)
- Distinct values for actor_id, external_user_id, external_location_id

### Step 5 — Build a name lookup (optional, for human-readable output)

Harvest `(id, name)` pairs from any event type at the customer that carries them in context. Common HS sources: `manual_shift_assigned` (`assignedUserId`/`assignedUserName`), `manual_shift_created`/`edit` (`assigneeId`/`assigneeName`), `shift_pickup_*` (`pickupEmployeeId`/`pickupEmployeeName`), `shift_release_requested` (`shiftOwnerId`/`shiftOwnerName`), `availability_updated_by_manager` (`approvingManager.id`/`name`), `certification_assigned` (`employeeId`/`employeeName`).

**Critical KQL gotcha:** `summarize uname=arg_max(ts, uname) by uid` is a naming collision and will store the timestamp as the name. Use `summarize arg_max(ts, uname) by uid` (no alias) — Kusto returns `uname` correctly.

**Critical KQL gotcha 2:** Some context fields are stringified JSON, not nested objects. `context.approvingManager.id` returns empty if `approvingManager` is a string. Use `parse_json(tostring(context.approvingManager)).id`.

### Step 6 — Pair request → decision events (if applicable)

Where an event has a sibling approval/denial, pair them in Python (not KQL — easier to reason about).
- Group rows by `(correlation_id, external_location_id)`
- Sort by timestamp
- Walk submissions and pair each with the next unused decision after it
- Compute `decision_minutes = decision_ts - submission_ts`

Document unpaired submissions — they may be genuinely pending, OR the decision happened outside the window, OR the correlation_id pattern doesn't match (callout if >30%).

### Step 7 — Write CSVs

Write to `~/Desktop/fourth-assistant/exports/<customer_id>_<event_short>_audit/`:
- `summary.txt` — coverage stats, total events, percent valid, percent named, time-to-decision percentiles
- `metric1_volume_by_location.csv`
- `metric2_time_to_decision.csv` (if pair-wise)
- `metric3_actor_events.csv` — per-row with names attached
- `metric4_volume_per_actor.csv`

Customise column names and metrics to fit the event. The Brinker availability run is the reference template at `~/.claude/skills/iq360-event-audit/scripts/brinker_availability_template.py` — copy it next to your output dir, rename, and adapt the event-type filters and field projections.

### Step 8 — Write the report

Surface to the user:
- Headline numbers (total, distinct locations, distinct actors, time-to-decision percentiles)
- Top 5 / 10 by volume
- **Coverage caveats** — every spec field that is empty or only partially populated, with the % gap
- **Name resolution coverage** — what % of distinct actors got a name, what's the gap
- File paths

### Step 9 — Callouts (the dev-assist trigger)

If any of the following are true, raise them as a numbered list under **"⚠️ Callouts for dev"** at the end of the report:

| Symptom | Callout |
|---------|---------|
| `actor_id` empty on >5% of events but the spec says it should be populated | "Instrumentation gap: actor_id missing on N events. Expected per Confluence reference. Suggest Rally story under F29839 (HS) / F29532 (PM)." |
| `context` null on an event whose spec lists context fields | "Context payload missing on N events. Expected fields: `<list>`. Suggest Rally story." |
| `is_valid = false` on >1% of events | "Validation failures: N events invalid. Likely cause: empty `actor_id` or schema mismatch. Sample event_id: `<id>`." |
| Time-to-decision p99 > 7 days OR median > 24 hours | "Operational signal, not a bug. Worth flagging to product/CSM rather than dev." |
| Stringified-JSON context fields | "Schema inconsistency: `<field>` is emitted as a string, not a nested object. Decide whether to fix the emitter or document for consumers." |
| Field exists in spec but is never populated for any row | "Possible spec drift — field `<X>` is documented but not emitted. Confirm with HS dev whether the field was descoped." |
| Customer ID returns 0 events | "No events for this customer in the window. Possible causes: wrong customer ID, customer not on iQ360 yet, source system not emitting. Check `RawCustomer` table and HS provisioning." |

Always offer to **raise a Rally story** for the top 1–2 callouts (don't bulk-create). Ask before creating. Use `F29839` (HS iQ Q2 Events) or `F29532` (iQ360 events for Payroll) as the parent feature. Reference US213895 / US219084 / US216733 as sibling-pattern examples in the description.

---

## How to verify Claude's work

Hand this checklist to the coworker reviewing the output:

1. **Spot-check totals against KQL.** Take the headline number from the report and run a one-liner against ADX:
   ```
   raw_feature_events
   | where customer_id == "<id>" and event_type == "<event>"
   | where unixtime_milliseconds_todatetime(event_timestamp) >= ago(<N>d)
   | count
   ```
   Numbers should match within ±1 (a single event can land between query and analysis).

2. **Spot-check the named-user lookup.** Pick one named actor from `metric4_volume_per_actor.csv`. Find an event where their name appears in context. Confirm the ID matches.

3. **Spot-check time-to-decision pairing.** Pick a row from `metric2_time_to_decision.csv`. Pull both events by `event_id` from ADX. Confirm timestamps and that they share a `correlation_id`.

4. **Confirm coverage caveats are real.** For every callout in the report, run a KQL query that proves the gap. e.g. for "actor_id missing on N events": `... | where isempty(actor_id) | count` should match N.

5. **Cross-check against the Confluence spec.** Open the [iQ 3.0 Event Reference](https://fourthlimited.atlassian.net/wiki/spaces/~71202084466b55996746e8a87d29d67b755b76/pages/6173229088/HotSchedules+iQ+3.0+Event+Reference) and confirm that every "missing field" callout is actually a spec violation (vs an optional field).

6. **CSV sanity.** Open the largest CSV in DuckDB or pandas — `SELECT count(*), count(distinct ...)` — confirm row counts match what the report claims.

If any check fails, treat the report as suspect and re-run the audit.

---

## When to escalate to dev (not just file a story)

File a Rally story under F29839 / F29532 for the slow lane. Escalate directly to the iQ360 dev team (Bohdan Kovalchuk for HS iQ; PM analytics team for PeopleMatter) when:

- **An entire customer or source system shows zero events** — likely a broken emitter or provisioning gap; needs immediate investigation
- **`is_valid = false` on >50%** of an event in production — the validation rules diverge from the emitter
- **Schema breaking change** — context payload structure suddenly changed mid-window (compare two halves of the window). This affects every downstream consumer
- **Cross-region inconsistency** — same event behaves differently NA vs EMEA. Likely an env-specific config drift

For these, post in the iQ360 Slack channel and tag the relevant lead. Don't wait for a Rally story to be groomed — these block reporting for everyone.

---

## Output template

Always end the report with this exact structure so the user can scan quickly:

```
=== Headline ===
- Customer: <id>  (<name if known>)
- Event(s): <list>
- Window: <start> → <end>
- Total events: N across M locations / K actors

=== Coverage ===
- is_valid:   X% true / Y% false
- actor_id:   X% populated
- context:    X% populated (specific fields: <list>)
- name lookup coverage: X% of actors named

=== Files ===
- ~/Desktop/fourth-assistant/exports/<dir>/

=== ⚠️ Callouts for dev ===
1. <issue>  — suggested action: <story / escalation>
2. ...

=== Next ===
Want me to raise a Rally story for callout #1?
```

---

## Examples

### Example 1 — Single-event audit, simple
**User:** "Audit `manual_shift_assigned` for HMSHost over the last 14 days."

**Flow:** Resolve HMSHost → customer ID via `RawCustomer`. Single event type, no request/decision pair. Skip Step 6. Coverage focuses on `assignedUserId`/`assignedUserName` populated, `external_location_id` populated. Output: 1 location CSV, 1 actor CSV, 1 summary. Callouts only if validity drops or required fields missing.

### Example 2 — Multi-event feature area (the Brinker run)
**User:** "Pull availability metrics for `0016R00003Fr6NbQAJ` last 30 days. Want to know who approved what."

**Flow:** Feature area "availability" → resolve to 4 event types via Confluence. Steps 1–9 in full. Pair `availability_update_requested` with `availability_requested_approved` / `_denied` via `correlation_id`. Build name lookup from sibling HS events (76K names harvested for Brinker). Output: 4 CSVs + summary. Top callout: empty `actor_id` and missing `context` on approval/denial events → suggest Rally story under F29839. Worked example outputs at `~/Desktop/fourth-assistant/exports/brinker_availability/`.

### Example 3 — Diagnostic ("nothing's coming through")
**User:** "Why am I seeing no `shift_rated` events for `<customer>`?"

**Flow:** Step 3 sample query returns 0 rows. Skip to Step 9. Callout 7 fires: "No events for this customer in window." Check `RawCustomer` for the ID, check NA vs EMEA, check whether the source system is provisioned. Escalate to dev (zero-event rule) — don't sit in the slow lane. The output is a paragraph explaining what's missing and a single Slack-ready message for the iQ360 channel.

---

## Reference files

- Brinker availability run (template script): `scripts/brinker_availability_template.py` (relative to this skill) — copy, rename, adapt the event-type filters and field projections for the new event being audited
- Outputs from the Brinker run: `~/Desktop/fourth-assistant/exports/brinker_availability/`
- Reference Rally story (PM pattern): US219084 — "Fix actor_id for everify events"
- Reference Rally story (HS pattern, created during the Brinker run): US219177 — "Populate actor_id (and approver name) on availability approval/denial events"
- Original event story example (HS): US213895 — "employee Availability updated"
