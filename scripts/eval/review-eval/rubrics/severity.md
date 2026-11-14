---
{
  "rubric": "severity",
  "version": 1,
  "kind": "llm",
  "appliesTo": "finding",
  "gates": true,
  "labels": [
    { "value": "exact", "description": "The severity field of the finding equals the truth severity.", "score": 1 },
    { "value": "off_by_one", "description": "The severity field is one step from the truth severity on the scale critical, major, minor, nit.", "score": 0.5 },
    { "value": "inverted", "description": "The severity field is two or more steps from the truth severity on that scale.", "score": 0 },
    { "value": "insufficient_evidence", "description": "The truth item has no severity to compare. Left out of the mean.", "score": null }
  ],
  "inputs": ["finding", "truth"]
}
---
## Assess
- Grade only the severity field of the finding against the truth severity. Do not grade the body text.
- The scale, from high to low: critical, major, minor, nit. Fold other words to this scale first.
- Same step: exact. One step apart: off_by_one. Two or more steps apart: inverted.
- If the body text of the finding disagrees with its severity field, grade the field. Say so in the reason only. It does not change the label.
- A truth item with no severity gives insufficient_evidence.

## Out of scope
- Whether the finding is real. The false-positive rubric answers that.
- Whether the engine found the bug at all.
- The wording of the finding and any mismatch between its field and its body.

## Reason contract
The judge answers with one label value and one reason sentence. The sentence cites the finding id and the truth severity. The runner fills in the id. The judge does not invent it.

## Examples
### Pass
- exact: a fail-open lock bypass is rated Major and the truth severity is Major.
- off_by_one (synthetic): a finding is rated Minor and the truth severity is Major. They are one step apart.

### Fail
- inverted (synthetic): a docs wording nit is rated Critical. A label of exact here is wrong.
