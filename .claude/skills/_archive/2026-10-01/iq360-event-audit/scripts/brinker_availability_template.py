#!/usr/bin/env python3
"""Brinker availability metrics from iQ360 events (last 30 days)."""
import csv
import json
import os
import subprocess
import urllib.request

CUSTOMER_ID = "0016R00003Fr6NbQAJ"
DAYS = 30
CLUSTER = "https://de-adx-iq360-prodna.eastus2.kusto.windows.net"
DB = "LandingDB"
OUTDIR = "/Users/lee.wilson/Desktop/fourth-assistant/exports/brinker_availability"
os.makedirs(OUTDIR, exist_ok=True)

def token():
    return subprocess.check_output(
        ["az", "account", "get-access-token", "--resource", CLUSTER, "--query", "accessToken", "-o", "tsv"],
        text=True,
    ).strip()

TOK = token()

def q(kql):
    body = json.dumps({"csl": kql, "db": DB}).encode()
    req = urllib.request.Request(
        f"{CLUSTER}/v1/rest/query",
        data=body,
        headers={"Authorization": f"Bearer {TOK}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=600) as resp:
        d = json.loads(resp.read())
    table = d["Tables"][0]
    cols = [c["ColumnName"] for c in table["Columns"]]
    return [dict(zip(cols, r)) for r in table["Rows"]]

def write_csv(path, rows, cols=None):
    if not rows:
        print(f"  (no rows) {path}")
        return
    cols = cols or list(rows[0].keys())
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        for r in rows:
            w.writerow({c: r.get(c) for c in cols})
    print(f"  wrote {len(rows):>6} rows -> {path}")


# ---------------------------------------------------------------------------
# 1. Build comprehensive user_id -> name map by harvesting every HS event type
#    that carries an (id, name) pair in context. Take the most-recent name per id.
# ---------------------------------------------------------------------------
print("[1/6] Building user_id -> name lookup...")
user_lookup_kql = f"""
let scope = raw_feature_events
| where customer_id == "{CUSTOMER_ID}"
| where unixtime_milliseconds_todatetime(event_timestamp) >= ago({DAYS}d)
| where source_system == "HotSchedules";
let from_assigned_user = scope
| where event_type endswith "manual_shift_assigned" or event_type endswith "standard_shifts_assigned"
| project ts=event_timestamp, uid=tostring(context.assignedUserId), uname=tostring(context.assignedUserName);
let from_assignee = scope
| where event_type endswith "manual_shift_created" or event_type endswith "manual_shift_edit"
| project ts=event_timestamp, uid=tostring(context.assigneeId), uname=tostring(context.assigneeName);
let from_pickup = scope
| where event_type endswith "shift_pickup_requested" or event_type endswith "shift_pickup_approved" or event_type endswith "shift_pickup_declined"
| project ts=event_timestamp, uid=tostring(context.pickupEmployeeId), uname=tostring(context.pickupEmployeeName);
let from_release = scope
| where event_type endswith "shift_release_requested"
| project ts=event_timestamp, uid=tostring(context.shiftOwnerId), uname=tostring(context.shiftOwnerName);
let from_certification = scope
| where event_type endswith "certification_assigned"
| project ts=event_timestamp, uid=tostring(context.employeeId), uname=tostring(context.employeeName);
let from_mgr_edit = scope
| where event_type endswith "availability_updated_by_manager"
| extend mgr=parse_json(tostring(context.approvingManager))
| project ts=event_timestamp, uid=tostring(mgr.id), uname=tostring(mgr.name);
union from_assigned_user, from_assignee, from_pickup, from_release, from_certification, from_mgr_edit
| where isnotempty(uid) and isnotempty(uname)
| summarize arg_max(ts, uname) by uid
| project uid, uname
"""
user_rows = q(user_lookup_kql)
USER_NAME = {r["uid"]: r["uname"] for r in user_rows if r.get("uname")}
print(f"      {len(USER_NAME)} users with names harvested")

# ---------------------------------------------------------------------------
# 2. Pull every availability event with all relevant fields
# ---------------------------------------------------------------------------
print("[2/6] Pulling all availability events...")
events_kql = f"""
set notruncation;
raw_feature_events
| where customer_id == "{CUSTOMER_ID}"
| where unixtime_milliseconds_todatetime(event_timestamp) >= ago({DAYS}d)
| where event_type contains "employeeavailibility"
| extend ts = unixtime_milliseconds_todatetime(event_timestamp)
| extend mgr_obj = parse_json(tostring(context.approvingManager))
| extend mgr_id_in_context = tostring(mgr_obj.id)
| extend mgr_name_in_context = tostring(mgr_obj.name)
| extend employee_id_in_context = tostring(context.employeeId)
| extend reason = tostring(context.reasonForChange)
| project event_id, correlation_id, event_type, event_timestamp_iso=ts,
          external_location_id, external_user_id, employee_id_in_context,
          mgr_id_in_context, mgr_name_in_context, reason, is_valid
| order by event_timestamp_iso asc
"""
events = q(events_kql)
print(f"      {len(events)} availability events")

# Tag each row with type, actor name, employee name
# Convention learned from data:
#   * availability_update_requested:   external_user_id = employee (the requester)
#   * availability_updated_by_manager: external_user_id = manager (= mgr_id_in_context); employee_id is in context
#   * availability_requested_approved: external_user_id = approving manager
#   * availability_request_denied:     external_user_id = denying manager
SHORT = {
    "wfm.wfm_us.employeescheduling.employeeavailibility.availability_update_requested": "request_submitted",
    "wfm.wfm_us.employeescheduling.employeeavailibility.availability_updated_by_manager": "manager_direct_edit",
    "wfm.wfm_us.employeescheduling.employeeavailibility.availability_requested_approved": "request_approved",
    "wfm.wfm_us.employeescheduling.employeeavailibility.availability_request_denied": "request_denied",
}

for ev in events:
    et = ev["event_type"]
    short = SHORT.get(et, et)
    ev["action"] = short
    if short == "request_submitted":
        emp_id = ev["external_user_id"] or ev["employee_id_in_context"]
        ev["employee_id"] = emp_id
        ev["employee_name"] = USER_NAME.get(emp_id, "")
        ev["actor_id"] = emp_id
        ev["actor_name"] = USER_NAME.get(emp_id, "")
        ev["actor_role"] = "employee"
    elif short == "manager_direct_edit":
        ev["employee_id"] = ev["employee_id_in_context"]
        ev["employee_name"] = USER_NAME.get(ev["employee_id_in_context"], "")
        ev["actor_id"] = ev["mgr_id_in_context"] or ev["external_user_id"]
        ev["actor_name"] = ev["mgr_name_in_context"] or USER_NAME.get(ev["actor_id"], "")
        ev["actor_role"] = "manager"
    else:  # approved / denied
        ev["employee_id"] = ""  # not in approval context
        ev["employee_name"] = ""
        ev["actor_id"] = ev["external_user_id"]
        ev["actor_name"] = USER_NAME.get(ev["external_user_id"], "")
        ev["actor_role"] = "manager"

# ---------------------------------------------------------------------------
# 3. METRIC 1 — number of availability changes per location (by event type)
# ---------------------------------------------------------------------------
print("[3/6] Metric 1: changes per location...")
from collections import Counter, defaultdict
loc_counts = defaultdict(lambda: Counter())
for ev in events:
    loc = ev["external_location_id"] or "(none)"
    loc_counts[loc][ev["action"]] += 1

m1_rows = []
for loc, c in sorted(loc_counts.items(), key=lambda x: -sum(x[1].values())):
    m1_rows.append({
        "external_location_id": loc,
        "request_submitted": c.get("request_submitted", 0),
        "request_approved": c.get("request_approved", 0),
        "request_denied": c.get("request_denied", 0),
        "manager_direct_edit": c.get("manager_direct_edit", 0),
        "total_changes": sum(c.values()),
    })
write_csv(f"{OUTDIR}/metric1_changes_per_location.csv", m1_rows)

# ---------------------------------------------------------------------------
# 4. METRIC 2 — time to complete each change
# Join request_submitted -> next request_approved/request_denied with same
# correlation_id at the same location. correlation_id format: {locId}_{empId}.
# Pair each submission with the next approval/denial after it for that key.
# ---------------------------------------------------------------------------
print("[4/6] Metric 2: time-to-decision per submission...")
from datetime import datetime

def parse_ts(s):
    # ADX returns variable fractional digits like ".12" or ".1234567"; Python 3.9
    # fromisoformat only accepts 0/3/6. Pad/truncate to microseconds.
    import re
    m = re.match(r"(.*?)(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$", s)
    base, frac, tz = m.group(1), m.group(2) or "", m.group(3) or "+00:00"
    if frac:
        digits = frac[1:][:6].ljust(6, "0")
        frac = "." + digits
    if tz == "Z":
        tz = "+00:00"
    return datetime.fromisoformat(f"{base}{frac}{tz}")

key_groups = defaultdict(list)
for ev in events:
    key = (ev["correlation_id"] or "", ev["external_location_id"] or "")
    key_groups[key].append(ev)

paired = []
unpaired_submissions = 0
for key, evs in key_groups.items():
    evs.sort(key=lambda e: e["event_timestamp_iso"])
    submissions = [e for e in evs if e["action"] == "request_submitted"]
    decisions = [e for e in evs if e["action"] in ("request_approved", "request_denied")]
    decisions_used = [False] * len(decisions)
    for sub in submissions:
        sub_ts = parse_ts(sub["event_timestamp_iso"])
        # Find next decision after sub_ts not yet used
        match_idx = None
        for i, dec in enumerate(decisions):
            if decisions_used[i]:
                continue
            if parse_ts(dec["event_timestamp_iso"]) >= sub_ts:
                match_idx = i
                break
        if match_idx is None:
            unpaired_submissions += 1
            continue
        decisions_used[match_idx] = True
        dec = decisions[match_idx]
        dec_ts = parse_ts(dec["event_timestamp_iso"])
        dur_min = (dec_ts - sub_ts).total_seconds() / 60.0
        paired.append({
            "external_location_id": sub["external_location_id"],
            "correlation_id": sub["correlation_id"],
            "employee_id": sub["employee_id"],
            "employee_name": sub["employee_name"],
            "submitted_at_utc": sub["event_timestamp_iso"],
            "decision": "approved" if dec["action"] == "request_approved" else "denied",
            "decision_at_utc": dec["event_timestamp_iso"],
            "decision_minutes": round(dur_min, 2),
            "decision_hours": round(dur_min / 60.0, 2),
            "decision_days": round(dur_min / 60.0 / 24.0, 2),
            "approver_id": dec["actor_id"],
            "approver_name": dec["actor_name"],
            "submission_event_id": sub["event_id"],
            "decision_event_id": dec["event_id"],
            "reason_for_change": sub["reason"],
        })

print(f"      paired {len(paired)} submissions; {unpaired_submissions} unpaired (no matching decision in window)")
write_csv(f"{OUTDIR}/metric2_time_to_decision.csv", paired)

# Summary stats for metric 2
if paired:
    durs = sorted([p["decision_minutes"] for p in paired])
    n = len(durs)
    def pct(p): return durs[min(n-1, int(p/100.0*n))]
    print(f"      time-to-decision: min={durs[0]:.1f}m  p50={pct(50):.1f}m  p90={pct(90):.1f}m  p99={pct(99):.1f}m  max={durs[-1]:.1f}m")

# ---------------------------------------------------------------------------
# 5. METRICS 3 & 4 — who approved + volume per approver
# ---------------------------------------------------------------------------
print("[5/6] Metric 3: per-approval approver list...")
approval_events = [e for e in events if e["action"] in ("request_approved", "request_denied", "manager_direct_edit")]
m3_rows = []
for ev in approval_events:
    m3_rows.append({
        "event_timestamp_utc": ev["event_timestamp_iso"],
        "action": ev["action"],
        "external_location_id": ev["external_location_id"],
        "approver_id": ev["actor_id"],
        "approver_name": ev["actor_name"],
        "employee_id": ev["employee_id"],
        "employee_name": ev["employee_name"],
        "correlation_id": ev["correlation_id"],
        "event_id": ev["event_id"],
    })
write_csv(f"{OUTDIR}/metric3_approval_events.csv", m3_rows)

print("[6/6] Metric 4: volume per approver...")
volumes = defaultdict(lambda: Counter())
for ev in approval_events:
    aid = ev["actor_id"] or "(unknown)"
    volumes[aid][ev["action"]] += 1

m4_rows = []
for aid, c in volumes.items():
    m4_rows.append({
        "approver_id": aid,
        "approver_name": USER_NAME.get(aid, ""),
        "approvals": c.get("request_approved", 0),
        "denials": c.get("request_denied", 0),
        "manager_direct_edits": c.get("manager_direct_edit", 0),
        "total_actions": sum(c.values()),
    })
m4_rows.sort(key=lambda r: -r["total_actions"])
write_csv(f"{OUTDIR}/metric4_volume_per_approver.csv", m4_rows)

# Coverage summary
print("\n=== Coverage summary ===")
named_approvers = sum(1 for r in m4_rows if r["approver_name"])
print(f"Distinct approvers: {len(m4_rows)} ({named_approvers} with names = {100*named_approvers/max(1,len(m4_rows)):.0f}%)")
named_actions = sum(r["total_actions"] for r in m4_rows if r["approver_name"])
total_actions = sum(r["total_actions"] for r in m4_rows)
print(f"Total approval/denial/edit actions: {total_actions} ({named_actions} = {100*named_actions/max(1,total_actions):.0f}% with named approver)")

print(f"\nAll outputs in: {OUTDIR}")
