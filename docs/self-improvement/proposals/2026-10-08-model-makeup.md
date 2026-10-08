# Model makeup: Opus plans, Sonnet edits, Haiku reads, Fable advises (2026-10-08)

Verdict: ADOPT in part (the advisor and the Opus effort pin). SKIP the Haiku and medium-effort parts.
Status: applied in the repo. Dave applies the `NEVER_SYNC` parts to `~/.claude` by hand.

Source: Alvaro Cintas, https://x.com/dr_cintas/status/2107939634705559974. Its claims were checked
against the Claude Code docs: https://code.claude.com/docs/en/advisor,
https://code.claude.com/docs/en/model-config#adjust-effort-level and
https://code.claude.com/docs/en/env-vars.

## 1. Answer

The post gives each model a role. CCv3 already had a two-tier model map that is stricter than the
post's, so almost all of it was in place. The post added two things CCv3 lacked:

- **A Fable advisor.** Set `advisorModel: "fable"`. The main model consults it with the full
  transcript, and subagents inherit it.
- **An Opus 5.5 effort pin.** Per the docs, a top-level `effortLevel` in user settings does not count
  for Opus 5.5, and Opus 5.5 defaults to medium. So the main Opus sessions were most likely running at
  medium, not the high Dave set. `modelSettings.claude-opus-5-5.effortLevel: high` fixes that.

## 2. Verdicts

| Post item | Verdict | Why |
|---|---|---|
| Haiku 5.5 for explorer and researcher | SKIP | Dave, 2026-10-08: keep the Haiku ban and use Sonnet 5.5 for read-only work. scout, oracle and pathfinder are already on Sonnet. The post's own benchmark (39.2% for Haiku vs 70.6% for Sonnet on Terminal-Bench 4.0) is the accuracy gap that led to the ban. |
| An agent named `Explore` overrides the built-in | SKIP | `explore-to-scout.ts` already blocks `Explore` and redirects to `scout` (Sonnet). |
| Sonnet worker at medium effort | SKIP | Dave, 2026-10-08: keep high. Before the 2026-09-30 pin, 46 of 99 Sonnet runs had silently run at medium. |
| `advisorModel: fable` | ADOPT | Added to `.claude/settings.json` and the template. |
| Consult at 3 moments (before a big plan, a repeated error, before done) | ADOPT | One line in `.claude/templates/CLAUDE.md.template`, "Agents and delegation". |
| `modelSettings.claude-opus-5-5.effortLevel: high` | ADOPT | Template `modelSettings`. Recorded as policy in `sync-known-gaps.md`. |
| Check the env vars that disable the advisor or force a model | DONE | None is set in the repo, the template or the scripts: `CLAUDE_CODE_DISABLE_ADVISOR_TOOL`, `DISABLE_TELEMETRY`, `DISABLE_GROWTHBOOK`, `DO_NOT_TRACK`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `CLAUDE_CODE_EFFORT_LEVEL`, `CLAUDE_CODE_SUBAGENT_MODEL`. `no-haiku-enforcer.ts` already fails if `CLAUDE_CODE_SUBAGENT_MODEL` is set. Dave should still check his Windows user env, which this repo cannot see. |
| CLI v2.1.293 or later | OK | 2.1.294 in the cloud container. Using Fable 5.1 as the advisor needs v2.1.257 or later. |

## 3. Facts from the docs that matter here

- `CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1` overrides `advisorModel`. Any variable that turns off
  feature-flag fetching (`DISABLE_TELEMETRY`, `DISABLE_GROWTHBOOK`, `DO_NOT_TRACK`,
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`) also keeps the advisor off, silently.
- The advisor is API-only. It is not available on Bedrock, Vertex or Foundry.
- Fable is billed without a consent prompt in `-p` runs. Every headless run (`run-research.ps1`,
  `sweep.mjs`, `sync-tasks-dashboard.ps1`) now pays for Fable advisor calls. Watch
  `scripts/usage/token-report.mjs` for the first week.
- `/advisor off` turns it off for a session. `/advisor` writes `advisorModel` to the user settings.

## 4. Risks

- **Fable access.** `docs/fable-manual/OPERATING-MANUAL.md` records that Fable plan access ended on
  2026-07-11. If Dave's account cannot use Fable 5.1, the advisor stays off. Run `/advisor` with no
  argument to see the current state.
- **Cost.** Each advisor call sends the full transcript to Fable, so a long session makes for an
  expensive call. If the bill jumps, fall back to `advisorModel: "opus"`.
