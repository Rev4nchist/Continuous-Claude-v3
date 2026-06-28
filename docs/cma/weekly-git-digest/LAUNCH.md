# LAUNCH — weekly-git-digest (resumable)

Keyless build kit is staged. This is the exact sequence to make it live **once Part-C gate items are green**.
Call shapes: `.claude/skills/launch-your-agent/references/cma-api.md`. Safety: `.claude/rules/cma-safety.md`.
Each step appends new IDs to `IDS.env`; re-running skips objects that already exist. **Live docs win on any drift.**

## 0. Prerequisites Dave provides (the gate)
- **G1 — valid Console API key:** `setx ANTHROPIC_API_KEY "sk-ant-api03-…"`, restart shell. Verify: `curl -sS -o /dev/null -w "%{http_code}\n" https://api.anthropic.com/v1/models -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01"` -> **200** (currently 401).
- **G2 — Notion:** notion.so/my-integrations -> New internal integration -> copy the token (`ntn_…`). In Notion, create ONE child page under Claude Bridge HQ (`30e76fd7ac8281e99fe1c0b257088b34`) named e.g. "Weekly Git Digest". Open that page -> ... -> Connections -> add your integration. Copy the page id (32 hex chars from the URL). This is `NOTION_PARENT_PAGE_ID`. (Sharing only the child page = the agent can't touch the HQ tables — premortem E1.)
- **G3 — GitHub:** github.com/settings/tokens?type=beta -> fine-grained PAT -> only the target repos -> Repository permissions: Contents=Read, Pull requests=Read -> set an expiry. Copy (`github_pat_…`).
- **G9/G11 — confirm:** your IANA timezone and the final `REPOS` list; accept that commit history transits Anthropic's non-ZDR cloud (scope to non-sensitive repos).

Fill the `<FILL: …>` markers in `first_prompt.txt`, `build-sheet.json`, `deployment.json`, and (timezone) before launching.

## 1. Setup
```bash
cd docs/cma/weekly-git-digest
BASE=https://api.anthropic.com/v1
H=(-H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01" -H "anthropic-beta: managed-agents-2026-04-01" -H "content-type: application/json")
: > IDS.env   # fresh run; load with: set -a; source IDS.env; set +a
```

## 2. Environment  (CONFIRM, then create — billable objects start here; apply cma-safety)
```bash
curl -sS --fail-with-body "$BASE/environments" "${H[@]}" -d @environment.json -o /tmp/env.json -w '%{http_code}\n'
ENV_ID=$(python -c "import json;print(json.JSONDecoder(strict=False).decode(open('/tmp/env.json').read())['id'])")
echo "ENV_ID=$ENV_ID" >> IDS.env
```

## 3. Agent  (inject system.md into the payload, then create)
```bash
jq --rawfile s system.md '.system=$s | del(._notes)' agent.json > /tmp/agent.final.json
curl -sS --fail-with-body "$BASE/agents" "${H[@]}" -d @/tmp/agent.final.json -o /tmp/agent.json -w '%{http_code}\n'
AGENT_ID=$(python -c "import json;d=json.JSONDecoder(strict=False).decode(open('/tmp/agent.json').read());print(d['id'])")
AGENT_VERSION=$(python -c "import json;d=json.JSONDecoder(strict=False).decode(open('/tmp/agent.json').read());print(d['version'])")
printf 'AGENT_ID=%s\nAGENT_VERSION=%s\n' "$AGENT_ID" "$AGENT_VERSION" >> IDS.env
```

## 4. Vault + credentials  (store the two tokens write-only; cma-api.md §8)
```bash
VAULT_ID=$(curl -sS "$BASE/vaults" "${H[@]}" -d '{"display_name":"weekly-git-digest"}' | jq -r .id)
echo "VAULT_ID=$VAULT_ID" >> IDS.env
# GitHub token (paste at the prompt; do NOT put it in a committed file)
read -rsp 'GitHub token: ' GH; echo
curl -sS "$BASE/vaults/$VAULT_ID/credentials" "${H[@]}" -d "{\"auth\":{\"type\":\"environment_variable\",\"secret_name\":\"GITHUB_TOKEN\",\"secret_value\":\"$GH\",\"networking\":{\"type\":\"limited\",\"allowed_hosts\":[\"api.github.com\",\"github.com\"]}}}" -o /dev/null -w '%{http_code}\n'; unset GH
# Notion token
read -rsp 'Notion token: ' NT; echo
curl -sS "$BASE/vaults/$VAULT_ID/credentials" "${H[@]}" -d "{\"auth\":{\"type\":\"environment_variable\",\"secret_name\":\"NOTION_TOKEN\",\"secret_value\":\"$NT\",\"networking\":{\"type\":\"limited\",\"allowed_hosts\":[\"api.notion.com\"]}}}" -o /dev/null -w '%{http_code}\n'; unset NT
```

## 5. One validation run  (G1 proof end-to-end; ~cents — confirm with Dave first)
```bash
set -a; source IDS.env; set +a
SID=$(curl -sS --fail-with-body "$BASE/sessions" "${H[@]}" -d "{\"agent\":\"$AGENT_ID\",\"environment_id\":\"$ENV_ID\",\"vault_ids\":[\"$VAULT_ID\"],\"title\":\"validation run\"}" | python -c "import json,sys;print(json.JSONDecoder(strict=False).decode(sys.stdin.read())['id'])")
echo "SESSION_ID=$SID" >> IDS.env
EVT=$(jq -n --rawfile task first_prompt.txt --rawfile rubric outcome.md '{type:"user.define_outcome",description:$task,rubric:{type:"text",content:$rubric},max_iterations:3}')
curl -sS --fail-with-body "$BASE/sessions/$SID/events" "${H[@]}" -d "{\"events\":[$EVT]}" -o /dev/null -w '%{http_code}\n'
# poll (python, not jq):
curl -sS "$BASE/sessions/$SID" "${H[@]}" -o /tmp/s.json
python -c "import json;d=json.JSONDecoder(strict=False).decode(open('/tmp/s.json').read());print(d['status'],[e.get('result') for e in d.get('outcome_evaluations',[])])"
```
Grade the digest + confirm the Notion section landed (read it back). Save the verified output as eval case 1 (`build-sheet.json` evals).

## 6. Schedule  (only after the validation run passes)
```bash
jq --rawfile task first_prompt.txt --rawfile rubric outcome.md \
  '.agent=env.AGENT_ID | .environment_id=env.ENV_ID | .vault_ids=[env.VAULT_ID] | .initial_events[0].description=$task | .initial_events[0].rubric.content=$rubric | del(._notes)' \
  deployment.json > /tmp/depl.json    # then set timezone in /tmp/depl.json
curl -sS --fail-with-body "$BASE/deployments?beta=true" "${H[@]}" -d @/tmp/depl.json -o /tmp/depl.out.json -w '%{http_code}\n'
DEPL_ID=$(python -c "import json;print(json.JSONDecoder(strict=False).decode(open('/tmp/depl.out.json').read())['id'])"); echo "DEPLOYMENT_ID=$DEPL_ID" >> IDS.env
# confirm next runs, then ONE manual test fire:
python -c "import json;print(json.JSONDecoder(strict=False).decode(open('/tmp/depl.out.json').read()).get('schedule',{}).get('upcoming_runs_at'))"
curl -sS -X POST "$BASE/deployments/$DEPL_ID/run?beta=true" "${H[@]}" -d '{}' -o /dev/null -w '%{http_code}\n'
```

## Off switch / cost
- Pause: `curl -sS -X POST "$BASE/deployments/$DEPL_ID/pause?beta=true" "${H[@]}"` · unpause · archive.
- Set a **workspace spend cap** in the Console before trusting the cron. `max_iterations:3` is the per-run bound.
- Append a `.claude/logs/cma-spend.jsonl` row per billable create/send (see `cma-safety.md`).
- After the first good run, build the post-cron monitor (G10): read `GET $BASE/deployment_runs?deployment_id=$DEPL_ID&has_error=true` and verify the Notion section for the latest run-key; alert on miss.
