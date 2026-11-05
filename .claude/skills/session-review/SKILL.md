---
name: session-review
description: Reviews recent Claude Code sessions from their transcripts and logs, scores each one, and ranks harness and Software Factory improvements with cited session labels. Use when the user says "/session-review", "review my sessions", or "what went wrong this week".
disable-model-invocation: true
---

# Session review

A per-session breakdown and ranked fixes for the CCv3 harness and the Software Factory.
`/failure-audit` reports corpus-wide correction rates. Link to it. Do not repeat its output.

## Guardrails (read first)

- Never read a raw transcript. Read only the extractor digests and `excerpt.mjs` output.
- History is read-only. Never write to transcripts, `~/.claude/logs`, `~/.claude/state`, the memory store or `~/.claude/skills`.
- Never apply an edit. A proposal is a diff for Dave.
- The report holds session text. Write it only to `report_path` from `inventory.json`
  (the primary checkout's `.claudedocs/`). Never under `docs/`. The markdown report stays local
  and is never committed. The HTML page is published only as a private Artifact (step 8).
- Every note and proposal cites a session label and a `uuid` from a digest. Drop any claim without both.
- Never ask Dave to label findings.
- Fan out with the Agent tool: `general-purpose`, model `sonnet`, effort high. Never haiku.
  Do not use the Workflow tool: a skill cannot authorize a Workflow run.
- A headless `claude -p` strips API keys first.
- STOP and report, with no loop, when `sessions_sampled == 0`, when `stop_reason` is set
  (parse errors in over 20% of files), or when one agent fails twice.

## Steps

1. Extract. Flags: `--days D` (45), `--max-sessions N` (12, a hard cap), `--session <id>`,
   `--include-headless`, `--include-subagents`, `--out <dir>`, `--project-prefix <folder-prefix>`.
   Pass only what Dave asked for. When you pass `--project-prefix`, pass the same value to `excerpt.mjs`.

   ```
   node "${CLAUDE_SKILL_DIR}/scripts/extract.mjs" --days 45 --max-sessions 12
   ```

   It prints the output folder. Read `inventory.json` there. Report skipped sessions by reason
   and `overflow_count`. Do not ask Dave about overflow; the cap is final.
2. Score. Three sessions or fewer: review inline from the digests. More than three: one Agent per session.
   Each agent reads its one digest and every file in `scorers/`, then returns ONLY this JSON:
   `{sid, scores{}, notes[{scorer, uuid, text<=160}], corrections[{uuid, class}], failures[{class, target_hint, uuid, root_cause<=120}]}`.
   Every failure carries `class` (one of the 11 classes in `scorers/corrections.md`) and `target_hint`
   (the file, hook, rule or skill name to edit, lowercase, no folder path; `unknown` when none fits).
   `root_cause` is free text for the reader. It is never a grouping key.
   A scorer with no data scores `null`. Drop any note or failure whose `uuid` is not in the digest.
   A subagent does not know the skill folder. In every subagent prompt, pass ABSOLUTE paths for the
   digest, the `scorers/` folder and `scripts/excerpt.mjs`. Resolve `${CLAUDE_SKILL_DIR}` first.
   An agent may run `excerpt.mjs` for a quote:

   ```
   node "<absolute path to scripts/excerpt.mjs>" --session <id> --uuid <uuid> --context 3
   ```
3. Stability check. Pick one random session with any score below 0.5. Re-score it with a fresh
   agent. Record the delta per scorer. A delta over 0.2 marks that scorer "unstable".
4. Rank over the agent JSON only. Do not re-read digests for ranking.
   - Below 0.5 is a fail. `null` is left out of every mean.
   - Group findings by `class` + `target_hint`, never by `root_cause` text. A finding ranks only when
     2 or more sessions from distinct `chain_id` values share the same `class` and `target_hint`.
     A group with one chain, or with `target_hint` `unknown`, goes to "Watch". Breakdowns show every session.
   - Rank key: distinct chains times the median `active_ms` of those sessions. State it as minutes
     of "expected saving", labelled an estimate. Add USD when `cost.source` is `cost-state`.
   - Edit targets by class: `references/factory-stations.md`.
5. Ledger. Write a scores file in the output folder, then run it. It appends to a fixed path in the
   primary checkout and prints the previous run's means and regression flags.

   ```
   node "${CLAUDE_SKILL_DIR}/scripts/extract.mjs" --append-scores <out>/scores.json
   ```

   The file is `[{sid, chain_id, scores, session_models, judge_model}]`. Show deltas against the
   prior run. A mean drop over 0.1 after a model or harness change is a regression flag.
6. Report. Follow `references/report-template.md` for sections 1 to 10, in order. Write the file to
   `report_path`. Show times as `local` with the zone name from the digest. Use `n/a (live)` when
   `wall_ms` is null.
7. Reply with the three-line answer, the report path and a Next steps block. Write the diffs
   for the top 3 proposals only, with no raw quotes in a diff.
8. Page. This is the one allowed outward step. Dave's `/session-review` is the request for it.
   Write `review.json` in the output folder (schema: `references/review-json.md`). Only redacted,
   truncated digest text may enter it. Then render and publish:

   ```
   node "${CLAUDE_SKILL_DIR}/scripts/render-html.mjs" --in <out>/review.json --out "<primary checkout>\.claudedocs\<YYYY-MM-DD>-session-review.html"
   ```

   Publish that file with the Artifact tool. First publish: `icon: "chart"` and a one-sentence
   `description` that names the date and the session count. No `capabilities`. The artifact is private
   to Dave. Never pass `url`: each run is a new artifact. Never change sharing. Give Dave the link.
   If the renderer prints problems, fix `review.json` and render again before you publish.

## Scorers

`scorers/` holds eight rubrics: goal, done-proven, corrections, efficiency, hook-response,
verbosity, tests, procedure. Each file has "What to assess", "Scale" and "N/A when".
Scores run 0.0 to 1.0. Done-proven starts from the digest's `evidence.proof`: the judge may only
lower it.

## Software Factory

Working definition, confirm with Dave: the CCv3 harness seen as a production line from prompt to
merged PR, in seven stations plus a Coordinate rail. Signals, stage mapping and example output:
`references/factory-stations.md`. Score each station "ran / had evidence / passed". Use the same
2-chain gate as step 4.

## Gotchas

- The extractor skips `self`, past `/session-review` runs, `sdk-cli` headless runs and sessions
  with no human turn. A live session (no `cost-state`, touched in 15 minutes) is kept as `partial`.
- Files that share any record `uuid` form one chain. The earliest file owns shared records.
  Cost is per file and is never summed over a chain.
- `hook_ms_by_name` is keyed by script name in older transcripts and by hook event in newer ones.
- `--include-subagents` streams about 1.3 GB of history. Use it only when Dave asks.
- `wf_*.json` token totals and `.meta.json` files are read always; they are small.
- No lane database join, no GitHub join and no Notion write in this version.
- With `--session`, only that file is scanned, so a resumed session may repeat replayed records.
- On Dave's yes only, draft `docs/self-improvement/proposals/<YYYY-MM-DD>-<name>.md` with no raw quotes.
