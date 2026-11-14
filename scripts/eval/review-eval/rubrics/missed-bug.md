---
{
  "rubric": "missed-bug",
  "version": 1,
  "kind": "hybrid",
  "appliesTo": "truth",
  "gates": true,
  "labels": [
    { "value": "caught", "description": "An engine finding names the same defect as the truth item, at the truth place.", "score": 1 },
    { "value": "partial", "description": "An engine finding names the same defect only in part, or names it with a fix that leaves part of the defect open.", "score": 0.5 },
    { "value": "missed", "description": "No engine finding names that defect. A different defect on the same lines counts as missed.", "score": 0 },
    { "value": "insufficient_evidence", "description": "The truth item or the hunk is too thin to decide. Left out of the mean.", "score": null }
  ],
  "inputs": ["truth", "finding", "hunk"]
}
---
## Assess
- Run the deterministic place match first (match.mjs). It compares the file and the line range of the truth item with each engine finding.
- No engine finding has a place match: the label is missed. The judge is not asked.
- At least one engine finding has a place match: the judge returns the label itself (caught, partial, missed or insufficient_evidence).
- The judge compares the defect, not only the place. A different defect on the same lines is missed.
- partial means the finding names the same defect but only in part. Example: the truth has two causes and the finding names one. Another example: the finding names the defect but its fix leaves part of it open.
- Several findings can match the place. Use the best label among them, in this order: caught, partial, missed. Use insufficient_evidence only when no matched finding gives one of those three.
- Too little in the truth item or the hunk to decide: insufficient_evidence.
- Read only the truth item, the engine findings and the hunk. Do not use outside knowledge of the fix.

## Out of scope
- Why the engine missed the bug. The miss-cause rubric answers that.
- Whether an engine finding is real or noise. The false-positive rubric answers that.
- The severity of the finding. The severity rubric answers that.

## Reason contract
The judge answers with one label value and one reason sentence. The sentence cites the finding id that decided the label. For missed, it cites the truth item id. The runner fills in those ids. The judge does not invent them.

## Examples
Pass: a case and its right label. Fail: a wrong label a judge could give for a case, and the right label.
### Pass
- caught: the truth says a review router keeps an old class value after a pull request goes back to draft, so a raised block never clears. The engine flags that the class value is not reset on the new checkpoint. Same defect, same code.
- partial (synthetic): the engine names the missing reset but proposes a fix that clears the value on only one path. The same defect is named, and the fix leaves part of it open.
- missed (synthetic): the engine flags a different defect on the same lines. The place matches and the defect does not, so the label is missed.

### Fail
- The truth says a lock check runs before the try block. A throw skips the deny catch, so a shell command passes the lock (fail-open). The engine says nothing about it. A label of caught is wrong. No finding names the defect, so the right label is missed.
