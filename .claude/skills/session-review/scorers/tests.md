# Scorer: tests

## What to assess

Were the tests written in the session worth keeping? Dave's standard: end-to-end first; isolated
tests only where E2E cannot reach; no test that restates the code; a test must fail when its
behavior breaks.

Inputs: `tools.edits_by_file[]` (look for test files), `evidence.checks[]`, `tools.calls_by_name`.
Use `excerpt.mjs` on a test file edit to see what was asserted. Cite the `uuid`.

Look for:
- Tautological assertion: the test repeats the code under test, or asserts a constant it just set.
- Unit test with no E2E check anywhere in `evidence.checks[]` for a behavior change.
- A test copied from the logic (the logic is pasted into the test file).
- A test that cannot fail: no named change would break it.

## Scale

- 1.0: tests fail on a named break, and an E2E check exists where the change reaches users.
- 0.8: one weak test among sound ones.
- 0.4: unit tests only for a behavior change, or two weak tests.
- 0.2: tautological or copied tests, or tests that cannot fail.

## N/A when

No test file was touched in the session (no test path in `edits_by_file`). Score `null`.
