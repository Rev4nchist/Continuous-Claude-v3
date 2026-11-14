---
{
  "rubric": "severity",
  "version": 1,
  "kind": "llm",
  "appliesTo": "finding",
  "gates": true,
  "labels": [
    { "value": "exact", "description": "The severity field of the finding equals the truth severity.", "score": 1 },
    { "value": "off_by_one", "description": "The severity field is one step from the truth severity on the scale critical, major, minor.", "score": 0.5 },
    { "value": "inverted", "description": "The severity field is two steps from the truth severity on that scale: critical against minor.", "score": 0 },
    { "value": "insufficient_evidence", "description": "The truth item has no severity to compare. Left out of the mean.", "score": null }
  ],
  "inputs": ["finding", "truth"]
}
---
## Assess
- Grade only the severity field of the finding against the truth severity. Do not grade the body text.
- The scale, from high to low: critical, major, minor.
- Fold other words to this scale first, as the matcher does: nitpick and trivial count as minor.
- Same step: exact. One step apart: off_by_one. Two steps apart: inverted.
- If the body text of the finding disagrees with its severity field, grade the field. Say so in the reason only. It does not change the label.
- A truth item with no severity gives insufficient_evidence.

## Out of scope
- Whether the finding is real. The false-positive rubric answers that.
- Whether the engine found the bug at all.
- The wording of the finding and any mismatch between its field and its body.

## Reason contract
The judge answers with one label value and one reason sentence. The sentence cites the finding id and the truth severity. The runner fills in the id. The judge does not invent it.

## Examples
Pass: a case and its right label. Fail: a wrong label a judge could give for a case, and the right label.
### Pass
- exact: a fail-open lock bypass is rated major and the truth severity is major.
- off_by_one (synthetic): a finding is rated minor and the truth severity is major. They are one step apart.
- exact (synthetic): a finding is rated nitpick and the truth severity is minor. Nitpick folds to minor, so the steps are the same.

### Fail
- (synthetic) A docs wording issue is rated critical, and the truth severity is minor. A label of exact or off_by_one is wrong. They are two steps apart, so the right label is inverted.
