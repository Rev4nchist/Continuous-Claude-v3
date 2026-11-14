---
{
  "rubric": "test-value",
  "version": 1,
  "kind": "llm",
  "appliesTo": "test",
  "gates": true,
  "labels": [
    { "value": "e2e_behaviour", "description": "The test runs the feature the way a user or the harness runs it and checks a real result.", "score": 1 },
    { "value": "isolated_justified", "description": "A unit test of logic that an end-to-end check cannot reach cheaply, where a named code change breaks it.", "score": 0.5 },
    { "value": "tautological", "description": "The test restates the code or asserts a constant, so it cannot fail when the behaviour breaks.", "score": 0 },
    { "value": "insufficient_evidence", "description": "The test or its target is too thin to judge. Left out of the mean.", "score": null }
  ],
  "inputs": ["test", "hunk", "git show", "redRun"]
}
---
## Assess
- Read the test and the code it covers.
- Ask: what code change would make this test fail? Name it. If none can be named, the test is tautological.
- A test that copies the logic under test, or asserts that a constant equals itself, is tautological.
- A unit test of logic that an end-to-end check cannot reach cheaply, with a named code change that breaks it, is isolated_justified.
- A test that runs the built feature with a real input and checks the real output is e2e_behaviour.
- redRun is optional. It is the output of the test before the change. If the runner gives it, a test that failed before and passes after supports the label. Without it, judge from the test and the code.

## Out of scope
- Test style and naming.
- Coverage numbers.
- Whether the change under test is correct.

## Reason contract
The judge answers with one label value and one reason sentence. The sentence cites the test name. The runner fills in that name. The judge does not invent it.

## Examples
### Pass
- isolated_justified: a parser test of a rule that an end-to-end run cannot reach cheaply. The redRun shows it failed before the change and passes after it.
- e2e_behaviour (synthetic): a test that runs the built hook with a real payload and checks its output.

### Fail
- tautological (synthetic): a test that asserts a constant equals its own value. A label of e2e_behaviour here is wrong.
