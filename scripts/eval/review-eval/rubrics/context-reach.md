---
{
  "rubric": "context-reach",
  "version": 1,
  "kind": "deterministic",
  "appliesTo": "record",
  "gates": false,
  "labels": [
    { "value": "ratio", "description": "Impact coverage from 0 to 1: the impact rows the reviewer opened, divided by the impact rows listed. It is reported and never averaged into a gate.", "score": null }
  ],
  "inputs": ["filesRead", "impactRows"]
}
---
## Assess
- This rubric is deterministic. No model is used.
- Count the impact rows of the record.
- Count how many of those files appear in filesRead.
- The ratio is opened rows divided by listed rows. A record with no impact rows has no ratio.
- Report the ratio next to the other results.

## Out of scope
- Any pass or fail verdict. This rubric does not gate.
- Whether the opened files were useful.
- Files the reviewer read that no impact row lists.

## Reason contract
This rubric is deterministic. The runner computes the ratio and writes a computed reason: the opened count and the listed count. No judge writes it. The ratio has a null score, so it is left out of every mean.

## Examples
Pass: a case and its right label. Fail: a wrong label a judge could give for a case, and the right label.
### Pass
- ratio (synthetic): 4 impact rows, 3 opened, ratio 0.75. The ratio is printed and not gated.

### Fail
- (synthetic) A run turns the ratio into a pass or fail result. That is wrong. The right output is the ratio alone, with no verdict, because this rubric has gates false.
