---
{
  "rubric": "miss-cause",
  "version": 1,
  "kind": "hybrid",
  "appliesTo": "miss",
  "gates": false,
  "labels": [
    { "value": "not_in_impact", "description": "The truth path is not a diff file, not in the hunk and in no impact row.", "score": null },
    { "value": "in_impact_not_opened", "description": "The truth path is a diff file or an impact row, and filesRead does not hold it.", "score": null },
    { "value": "opened_dismissed", "description": "The truth path is only in an impact row, the reviewer read it, and the trace shows it judged the code fine.", "score": null },
    { "value": "in_diff_logic", "description": "The truth path is the diff file or in the hunk, the reviewer read it, no rule left the issue out, and it did not see the logic error.", "score": null },
    { "value": "policy_difference", "description": "The reviewer read the truth path, and the trace shows an engine rule or threshold left the issue out.", "score": null },
    { "value": "insufficient_evidence", "description": "The trace cannot split the classes.", "score": null }
  ],
  "inputs": ["truth", "hunk", "filesRead", "impactRows", "trace"]
}
---
## Assess
- This rubric is a classifier. It gives a class, not a score, and it does not gate.
- Apply the steps in this order. The first step that fits decides.
- Step 1: the truth path is a diff file, or is in the hunk. Diff files count as listed. If it is not in filesRead, the class is in_impact_not_opened. If it is in filesRead, the judge reads the trace and picks in_diff_logic or policy_difference.
- Step 2: the truth path is not a diff file but is in impactRows. If it is not in filesRead, the class is in_impact_not_opened. If it is in filesRead, the judge reads the trace and picks opened_dismissed or policy_difference.
- Step 3: the truth path is in no impact row and is not a diff file. The class is not_in_impact.
- The not-read cases and step 3 are deterministic. The judge is asked only for a file the reviewer read: in_diff_logic or policy_difference in step 1, opened_dismissed or policy_difference in step 2.
- in_diff_logic: the reviewer read the file and the trace shows no rule that left the issue out. It did not see the logic error.
- opened_dismissed needs a trace line that shows the reviewer read the file and judged it fine.
- policy_difference needs a trace line that shows an engine rule or threshold left the issue out. Without a trace line for either, use insufficient_evidence.
- No code of the files read is given here. The file inputs are names only.

## Out of scope
- Whether the engine caught the bug. The missed-bug rubric answers that. Use this rubric only for a miss.
- Whether a better prompt would catch it.
- The severity of the bug.

## Reason contract
Every class has a null score, so no mean is taken. Each class has its own citation rule:
- not_in_impact and in_impact_not_opened are deterministic. The runner writes the reason: the truth id, and which of the diff files, impactRows and filesRead holds the truth path.
- in_diff_logic, opened_dismissed and policy_difference come from the judge. It answers one class value and one reason sentence that cites the truth id and the trace line it used.
- insufficient_evidence cites the truth id only, and says which input is missing.
The runner fills in the ids. The judge does not invent them.

## Examples
Pass: a case and its right label. Fail: a wrong label a judge could give for a case, and the right label.
### Pass
- in_diff_logic: the fail-open lock check was in the changed hunk. The trace shows the reviewer read that file. It missed the ordering error.
- not_in_impact (synthetic): the bug sat in a module that no impact row lists, and the module is not a diff file.

### Fail
- (synthetic) The trace shows the file was never read. A label of opened_dismissed is wrong. The right class is in_impact_not_opened.
