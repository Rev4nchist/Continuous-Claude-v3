# Report template

Write the report to `report_path` from `inventory.json`. It holds session text. It stays in the
primary checkout's `.claudedocs/`, which `.gitignore` covers for `*-session-review*.md`.
Never write it under `docs/`. Never stage, commit or publish it.

The HTML page is a second output: `<primary checkout>\.claudedocs\<YYYY-MM-DD>-session-review.html`
(`.gitignore` covers `*-session-review*.html`). Build it from `review.json`
(`references/review-json.md`) with `scripts/render-html.mjs`. Publish it only as a private Artifact (SKILL.md step 8).

Write in ASD-STE100 Simplified Technical English. Name sessions by label (`name #sid8`). Give times
as `local` with the zone name the digest holds (CST or CDT).

## Sections, in this order

### 1. Answer (3 lines)

- Sessions reviewed: N of M eligible (overflow: K). Skipped: counts by reason.
- Mean score and its delta against the prior run (from the ledger output). Say "first run" if none.
- Top fix: one sentence naming the target file and the expected saving.

### 2. Report card

A table: one row per scorer. Columns: mean, sessions scored, sessions N/A, unstable (yes or no).
Under the table list regression flags (scorer, previous, current, what changed).

### 3. Ranked improvements (at most 5)

One block per improvement, ranked by the rank key. Each block has:
- `class` and `target_hint` (the group key), and the target file (from `factory-stations.md`).
  A finding ranks only when 2 or more sessions from distinct chains share the same `class` and `target_hint`.
- A unified diff draft against the CURRENT file. Write diffs for the top 3 only. No raw quotes in a diff.
- Two or more cited labels, each with a `uuid`, from 2 or more distinct chains.
- Expected saving: the rank key in minutes, and USD when `cost.source` is `cost-state`. Label it an estimate.
- Verdict: ADOPT, WATCH or SKIP.

### 4. Software Factory

One row per station from `factory-stations.md`: ran, had evidence, passed. Rank the stations with the
same rank key and the same 2-chain gate. End with one example line, such as
"Build: 4 chains spawned opus for an execution task. Target: `.claude/agents/<name>.md` and its `.json` mirror."

### 5. Harness

Failures grouped by class with the edit target from `factory-stations.md`. Do not repeat
`/failure-audit` output; link to it.

### 6. Watch list

Findings from one chain only, or with `target_hint` `unknown`. One line each: label, `uuid`, `class`, `target_hint`.

### 7. Per-session breakdown

For each session:
- Label, `local` window (start to end), goal, outcome.
- Scores, with notes that cite a `uuid`.
- Done evidence: the check, `is_error`, `before_claim`, `after_last_edit`.
- Corrections (class and `uuid`), hook blocks (guard and response), errors by class.
- Active time. Wall time, or `n/a (live)`. Cost and its source. Never sum cost across a chain.

### 8. Skipped sessions

Counts by reason: `self`, `review_run`, `headless`, `no_human`. Name no session text.

### 9. Review cost

Tokens and USD of this run, from the agent results. Write "not reported" when a result carries none.

### 10. Next steps

Numbered actions for Dave. Each command goes in its own PowerShell block, starting from
`Set-Location -LiteralPath`, followed by a "You should see" line. Example:

```powershell
Set-Location -LiteralPath 'C:\Users\dkhay\continuous-claude'
```

You should see no output and the prompt in the repo folder.

Open items for Dave: confirm the station list, accept or reject the narrow `.gitignore` line, and
approve any spend (a behaviour run with `run_eval.py` costs money).
