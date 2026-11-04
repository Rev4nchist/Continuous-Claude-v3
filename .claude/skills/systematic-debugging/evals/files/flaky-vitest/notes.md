# hook-state.test.ts is flaky

Repo: ~/continuous-claude/.claude/hooks (vitest). The suite passes alone, fails about 1 run in 3 in the full suite.
Failing assertion: `expect(readState().lastHook).toBe('pre-pr')` in hook-state.test.ts.

Fixes I tried, in order. All three are still in the working tree:
1. Raised `testTimeout` from 5000 to 15000 in vitest.config.ts. No change.
2. Added `retry: 2` in vitest.config.ts. Fewer red runs, then the same failure came back.
3. Added `await sleep(200)` before the assertion in hook-state.test.ts. No change.

vitest-run.log in this folder = the last 7 full runs.
