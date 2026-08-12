# Phase 0 — three observations, and none of them lets Phase 2 shrink

**Date:** 2026-07-27 · **Gate deadline:** 2026-07-29 · **Verdict: full Phase 2 scope stands.**

Canonical artifact is `.claude/logs/phase0-observations.jsonl` (gitignored by
`.gitignore:35`, so this file is the durable copy). Preserved run artifacts:
`.claude/logs/phase0-artifacts/*.specimen.json` — copied out of `$TEMP` before the
17:45 Project-Cards run overwrote them.

The gate said Phase 2 may only shrink once all three pipelines have a row. All three
now have one. None of them clears anything.

## The finding that matters

**Project-Cards exited 0, did real work, and left no trace in the registry.**

The 07:45 sweep refreshed 10 cards and the task returned `0`. There is no Project
Portfolio row for 2026-07-27. The pre-emit — the thing whose entire job is to record
that a run started — died on `ntn spawnSync ETIMEDOUT` and was swallowed as non-fatal;
the machine then died before anything wrote a completion row.

The local `$TEMP` artifact survived, carrying its `runId`. That is precisely the
artifact Phase 2a's reconciler replays. This is the reconciler's live justification,
and it is no longer hypothetical.

Honest caveat: the cause is a crash plus spawn starvation, not a Notion-side defect.
The reconciler is still the right fix — it decouples *recording that a run happened*
from *reaching Notion at that instant*, which is exactly the coupling that failed here.

## The correction

**The 08:05:53 boot followed an unexpected shutdown, not a reboot.** System event 6008,
last checkpoint 07:55:11. Nobody initiated it because nothing did — the machine fell
over. The earlier note on the lane bus recorded it as a reboot; it was a crash.

That crash **confounds both of this morning's runs.** Self-Improvement's
`0xC000013A` is fully explained by the shutdown, so this does **not** establish that
the `claude -p` hang recurred. Do not cite it as evidence either way.

## The three rows

| Pipeline | Period | Task | Rows | Pre-emit reached Notion | Verdict |
|---|---|---|---|---|---|
| Self-Improvement | 2026-07-27 | `0xC000013A` | 1 | yes | CONFOUNDED |
| Project-Cards | 2026-07-27 | `0` | **0** | **no** | **MISS** |
| Dashboard-Sync | 2026-07-26 | `0` | 1 | yes | PASS_WITH_WARN |

- **Self-Improvement** — `claude -p` started 07:38:44, no completion line, machine died
  ~08:01. Worth noting the always-emit contract *worked*: the pre-emit row exists and
  correctly still reads `Failed`. That is the design behaving as intended on a killed run.
- **Project-Cards** — see above. Second chance today at 17:45 on the post-boot box.
- **Dashboard-Sync** — section refreshed, exactly one row for the period, spine held.
  The `null-valued expression` verify error that Phase 0 expected to self-resolve as a
  spawn-starvation symptom **did recur** — but on the sick box (Devin crawl still
  active), so it is not yet disproven. Clean test is tonight at 20:00.

## What still needs observing

Every clean-box observation is still outstanding. The three runs above happened on a
box that was either sick or about to crash.

- Self-Improvement 07:30 on 2026-07-28 — the only clean test of the `claude -p` hang.
- Dashboard-Sync 20:00 on 2026-07-27 — the only clean test of the verify error.
- Project-Cards 17:45 on 2026-07-27 — whether the pre-emit reaches Notion at all.

Until those land, Phase 2 carries full scope. The deadline does not move.
