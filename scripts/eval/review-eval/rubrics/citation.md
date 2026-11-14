---
{
  "rubric": "citation",
  "version": 1,
  "kind": "deterministic",
  "appliesTo": "finding",
  "gates": true,
  "labels": [
    { "value": "valid", "description": "The cited path and line exist at the reviewed head, and the quoted text matches the line.", "score": 1 },
    { "value": "invalid", "description": "The path is missing, the line is past the end of the file, or the quote does not match.", "score": 0 },
    { "value": "insufficient_evidence", "description": "The git show call failed, so the quote cannot be checked. Left out of the mean.", "score": null }
  ],
  "inputs": ["finding", "git show"]
}
---
## Assess
- This rubric is deterministic. No model is used.
- Take the cited path:line and the quoted text from the finding.
- Run git show on the head for that path.
- If git show fails (for example the head is not available), the label is insufficient_evidence.
- Else the file must exist, the line must be inside the file, and the quote must match the text at that line.
- A match ignores leading and trailing white space. It does not ignore a changed word.
- All three hold: valid. Any one fails: invalid.

## Out of scope
- Whether the finding is a real defect.
- Whether the cited line is the best place for the finding.
- A finding that cites no path:line. It is not scored here.

## Reason contract
This rubric is deterministic. The runner computes the label and writes a computed reason: which check failed, or that all passed, with the finding id. No judge writes it.

## Examples
Pass: a case and its right label. Fail: a wrong label a judge could give for a case, and the right label.
### Pass
- valid: the path:line exists at the head, and the quoted line matches the output of git show.

### Fail
- (synthetic) The line number is past the end of the file at the head. A label of valid is wrong. The right label is invalid.
