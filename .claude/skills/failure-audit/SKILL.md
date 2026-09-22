---
name: failure-audit
description: Audit Dave's own session history for agent failure modes and turn the recurring ones into rule edits. Use when the user says "/failure-audit", "audit my history", "what do you keep getting wrong", "corrections per model", or "where do agents fail".
disable-model-invocation: true
---

# Failure audit

Theo's method [vid:e1snsuY4lTI @19:51]: read your own history with the agent, count the
corrections per model, classify them, then write rules from the classes that recur. A rule
born from one incident is a guess. A rule born from five sessions is a fix.

## Steps

1. Regex pass + dump (cheap, read-only):

   ```
   node scripts/self-improvement/failure-audit.mjs --days 30 \
     --out docs/self-improvement/audits/<date>-failure-modes.md \
     --dump "$TEMP/human-turns.jsonl"
   ```

2. LLM pass. Split the dump into ~450-line slices (`split -l 450 -d`). Spawn one
   `general-purpose` (sonnet) agent per slice with the classifier prompt below. Each writes
   `classified-partNN.jsonl` (only non-`none` rows).

3. Merge, count per class and per model, count **sessions** per class. Append the LLM-pass
   section to the audit file (see `2026-08-19-failure-modes.md` for the shape).

4. Propose ONE rule edit per class with **>=2 independent sessions**. Each edit carries a
   bad/good pair quoted from the incidents. Single-session classes are provisional with a
   review date.

5. Keep the audit file repo-local. It contains session text. Never publish it.

## Classifier prompt (paste to each agent)

Classes: scope, wrong_target, no_verify, misread, stopped_early, regression, format,
tool_misuse, process, other_correction, none. Judge with the `prev` field (the agent's last
message). "keep going" after a stop IS stopped_early. "yes do it" is none. A new task is none.
Output one JSON per correction: `{i, ts, project, session, model, class, quote<=120, note<=80}`.

## Gotchas

- ~85% of "human turns" are automated prompts (card refreshes, headless jobs). Report the
  interactive denominator too, or the rate looks flattering.
- `model` is the last assistant model seen in that session; `unknown` = before any reply.
- The regex pass alone under-counts by ~3x and mislabels most hits. Use it only to dump.
