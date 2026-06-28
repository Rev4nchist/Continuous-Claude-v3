# weekly-git-digest — keyless build kit

A staged (NOT launched) Claude Managed Agent: each Thursday 19:00 it reads the week's GitHub commit
history across the configured repos, groups it by project, and idempotently publishes a digest to a
dedicated Notion page under Claude Bridge HQ — off-box, on a schedule. Authored 2026-06-27 from locked
design decisions (the interview was done live; this is the projection, not a re-interview).

## Files
| File | Role |
|------|------|
| `build-sheet.json` | **single source of truth** — the design; everything else is a projection of it + the Part-C gate status |
| `system.md` | the agent's system prompt (injected into `agent.json` at launch) |
| `agent.json` | `POST /v1/agents` payload (`web_search` off; toolset wrapper) |
| `environment.json` | `POST /v1/environments` payload (cloud, networking limited to GitHub+Notion) |
| `outcome.md` | the grading rubric (definition of done) |
| `first_prompt.txt` | the kickoff task (relative dates; names REPOS + the Notion page) |
| `deployment.json` | `POST /v1/deployments?beta=true` payload (cron `0 19 * * 4`) |
| `LAUNCH.md` | **the resumable step-by-step launch sequence** + secret setup + off switch |

## Status: PLANNED — blocked on a valid Console API key
The env `ANTHROPIC_API_KEY` returns `401 invalid x-api-key`. Nothing here has been launched ($0 spent).
To go live, follow `LAUNCH.md` once the gate items in `build-sheet.json` → `gate_status_part_c` are green.

See the session handoff at `../HANDOFF.md` for the full picture.
