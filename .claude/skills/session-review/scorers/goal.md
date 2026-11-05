# Scorer: goal

## What to assess

Was the goal of the session met? Judge the goal itself, not how well the work was done.

Inputs from the digest:
- `goal_candidates[]` in order: custom title, latest away summary, handoff goal, first typed prompt.
- `evidence.claim_text` (the final claim) and `evidence.handoff_outcome` (SUCCEEDED, PARTIAL_PLUS,
  PARTIAL_MINUS or FAILED, when a handoff was written).
- The last prompts in `humans.prompts[]`: did Dave end the session with a new complaint?

Pick the goal from the strongest candidate. A typed prompt beats a title. State the goal in one
sentence in your note. Cite a `uuid`.

Definitions:
- "Met and confirmed": the claim names an outcome, and a check, a merged PR or a Dave reply backs it.
- "Gap": one named part of the goal is missing or unverified.
- "Abandoned": the last human turn changes the subject with the goal open, or the claim says so.

## Scale

- 1.0: met and confirmed.
- 0.8: met with one gap.
- 0.4: partly met.
- 0.2: not met or abandoned.

A handoff outcome of FAILED caps the score at 0.4. A live session (`partial: true`) is scored on
what exists; say so in the note.

## N/A when

No goal candidate exists. Score `null`.
