# Plan: get the hook suite green and ratcheted — one session

Written 2026-07-29 at the end of the session that made the suite complete at all.
Entry point: [`README.md`](README.md). Everything below was verified today; where
a fact is unverified it says so.

**Starting state:** `npx vitest run` in `.claude/hooks` completes in ~12 s.
113 files · **2164 pass · 93 fail · 7 skipped**. All four mechanised guards green.

**Target:** 0 fail, plus two ratchets so it cannot silently rot again.

**Excluded on purpose:** the 234 `tsc --noEmit` errors. Different axis, entirely
unmeasured, plausibly unbounded — putting it in this session is the likeliest way
this session doesn't finish. Measure it separately first.

---

## Why this is one session and not three

83 of the 93 failures are **fossils**, not bugs. That was mis-sized in this doc's
first revision (see the README correction) and it inverts the estimate: the block
that looked like 90% of the work is a file deletion.

---

## Step 1 — Delete the 5 arscontexta test files (−83 failures)

The subsystem does not exist. Verified today:

```
.claude/skills/arscontexta*      -> 0
.claude/agents/arscontexta*      -> 0
.claude/hooks/src/arscontexta*   -> 0
grep arscontexta skill-rules.json -> 0
```

The only `arscontexta*` files anywhere in the repo are the 5 test files. And the
removal was deliberate: **`f9cdbef` (2026-06-28) "fix(skills): QW-08 remove 28
ghost skill registrations from skill-rules.json"** deleted **61** arscontexta
lines from `skill-rules.json`. These tests read that exact file
(`arscontexta-data-integrity.test.ts:16` resolves `skills/skill-rules.json`) and
assert the purged registrations are present. Their failure signatures say the same
thing: 36× `expected undefined to be defined`, plus
`expected [] to include 'arscontexta-document'`.

```
git rm .claude/hooks/src/__tests__/arscontexta-data-integrity.test.ts \
       .claude/hooks/src/__tests__/arscontexta-graph-resolution.test.ts \
       .claude/hooks/src/__tests__/arscontexta-hook-e2e.test.ts \
       .claude/hooks/src/__tests__/arscontexta-keyword-matching.test.ts \
       .claude/hooks/src/__tests__/arscontexta-regression.test.ts
```

**Accept — exact numbers, computed from today's run, not estimated.** The 5 files
hold 115 tests: 83 failing and **32 passing**. So deleting them must give:

```
files: 113 -> 108        passed: 2164 -> 2132        failed: 93 -> 10
```

If passes land below 2132 you deleted something live; if failures land above 10,
something else regressed and it is not these files.

Do NOT chase the `.codex/hooks/src/__tests__/arscontexta-*.ts` copies — `.codex/`
is a gitignored regenerable mirror (`.gitignore:236`).

**If you'd rather not delete tests:** the only alternative is restoring the
subsystem, and there is nothing to restore it from. Deletion is the finding, not a
shortcut.

---

## Step 2 — `plan-exit-tracker`: 7 failures, ONE root cause

Do not treat these as 7 bugs. The first assertion to fail is
`writes state file when ExitPlanMode fires` (`expected false to be true`); the
other six are downstream nulls (`Cannot read properties of null (reading
'sessionId' / 'timestamp')`, `expected null not to be null`). Fix the write and
all 7 should go.

The state file is the plan-to-ralph gate's, at `$TEMP/claude-plan-approved-*.json`
(see `.claude/rules/plan-to-ralph-enforcement.md`). **Hypothesis, not verified:**
the test and the hook disagree about where that file lives or which session id
keys it — the same class as the bug found today in
`session-start-init-check`, where the hook derived `projectDir` from
`CLAUDE_PROJECT_DIR`/`process.cwd()` while the test passed `cwd` in the payload and
was silently ignored.

**Method:** run the failing test, print the path the hook writes and the path the
test reads, and compare. Don't fix until those two strings are on screen together.

**Accept:** 7/7 pass, and the fix is one cause — if you find yourself patching each
test separately, the diagnosis is wrong.

---

## Step 3 — `store-learning-injection`: decide fossil vs regression

3 failures asserting the **source shape** of `agent-error-capture.ts`:

- `stores via spawnSync with raw content argv` → `expected undefined to be defined`
- `no execSync building a store_learning command, no sh-escaping` →
  `agent-error-capture.ts must use spawnSync: expected false to be true`

So the test says that hook must invoke `store_learning.py` via `spawnSync` and must
not build a shell string. **Determine which is true before touching anything:**

```
git log --oneline -5 -- .claude/hooks/src/agent-error-capture.ts
grep -n "store_learning\|spawnSync\|execSync" .claude/hooks/src/agent-error-capture.ts
```

- If the hook still stores learnings but was refactored → **fix the test.**
- If the storing was intentionally removed → **the test is a fossil**, delete it
  like Step 1, citing the commit.
- If the hook was supposed to store and silently stopped → **that is a real
  regression in the memory pipeline** and matters more than the test. It would mean
  agent errors have not been reaching `archival_memory`.

The third branch is why this step is "decide", not "fix". Do not assume the first.

---

## Step 4 — `braintrust-score`: the OFF switch may be broken

1 of 19: `returns silently when TRACE_TO_BRAINTRUST is "false"` — the fetch mock
**was called once** when it must not be called at all.

This is worth more than its count. Tracing was just deliberately kept ON (~690 ms
per tool call, README §4.2) on the understanding that it can be turned off later.
If this test is right, **`TRACE_TO_BRAINTRUST=false` does not actually stop the
POST** — the off switch you're relying on doesn't work. Confirm by reading the
guard in `emitBraintrustScore` and checking whether it tests the string `'false'`
or mere presence.

Caveat: this file makes **real network calls** during the suite (`project lookup
claude-code failed: DNS failure` appears in the run log), and total failures moved
between 93 and 94 across two runs today, so treat one red run as suggestive, not
conclusive. Run it 3× before concluding.

**Accept:** either 19/19 with the off-switch guard corrected, or a recorded finding
that the test is wrong — with the reason.

---

## Step 5 — Guard the 15 unguarded `main()` hooks

The class that hung the suite. `maestro-detector.ts` ended with a bare `main();`
at module scope; `main()` awaits stdin, so importing the module to unit-test its
pure helpers blocked forever. **15 hooks still have that shape**, and the next unit
test written against any of them re-hangs the suite.

The guard (copy from `maestro-detector.ts` / `session-start-init-check.ts`):

```ts
if ((process.argv[1] || '').includes('<hook-name>')) {
  main();
}
```

**The risk is real:** if the guard string doesn't appear in `argv[1]` at runtime,
the hook silently stops running in production — a worse outcome than a hanging
test. So the registered filename must contain it. **Pre-computed today against live
`settings.json`, so you don't have to:**

| Hook | Registered as | Guard |
|---|---|---|
| `agent-verification` | `agent-verification.mjs` | safe |
| `bus-session-populator` | `bus-session-populator.mjs` | safe |
| `guardrail-enforcer` | `guardrail-enforcer.mjs` | safe |
| `maestro-enforcer` | `maestro-enforcer.mjs` | safe |
| `maestro-state-manager` | `maestro-state-manager.mjs` | safe |
| `mcp-activity-tracker` | `mcp-activity-tracker.mjs` | safe |
| `permission-auto-allow` | `permission-auto-allow.mjs` | safe |
| `ralph-delegation-enforcer` | `ralph-delegation-enforcer.mjs` | safe |
| `ralph-monitor` | `ralph-monitor.mjs` | safe |
| `ralph-template-inject` | `ralph-template-inject.mjs` | safe |
| `task-router` | `task-router.mjs` | safe |
| `code-field-protocol` | **not registered** | see below |
| `plan-mode-discovery` | **not registered** | see below |
| `prd-task-template-enforcer` | **not registered** | see below |
| `typescript-preflight` | **not registered** | see below |

For the 11 registered ones the guard is provably a no-op in production: the
registered path basename *is* `<hook-name>.mjs`.

The 4 unregistered ones are a **separate finding, not a blocker**: nothing in
`settings.json` invokes them, so guarding them cannot break a live path — but it
also means they are dead by the same test Step 10's prune uses. Guard them, and add
them to the prune candidate list rather than assuming they're live.

**Verify per hook, not in bulk** (this is the step where bulk edits bite):
rebuild, then invoke the built bundle with a realistic payload and confirm it still
emits — exactly as was done for `maestro-detector` today:

```
echo '{"session_id":"guard-check", ...}' | node dist/<hook>.mjs
```

**Accept:** all 15 carry the guard; each of the 11 registered ones demonstrably
still emits when invoked as `node dist/<hook>.mjs`; suite still returns a verdict.

---

## Step 6 — Only now, the two ratchets

Adding these earlier pins the red state, which is why they are last.

1. **Pass-count ratchet.** Fail if the passing total drops below a recorded
   baseline, in the style of `scripts/audit-braintrust-emits.sh` (the one guard
   here with a catch record — 6 regressions — precisely because it counts).
   → **Accept:** asserts a nonzero baseline ≥ the number reached in Step 4, and
   **prove it non-vacuous** by temporarily lowering a pass and watching it fail.
2. **Two shape guards**, both cheap greps over `src/`:
   - no test file may import from `node:test` (today: 0, was 3)
   - no hook may call `main()` unguarded at module scope (today: 15, target 0)
   → **Accept:** each reports its real current count and fails when you
   deliberately reintroduce one instance. A guard that has never been seen to fail
   is not yet a guard.

---

## Traps, all paid for already

- **`bash` on PATH is WSL** (`/mnt/c`, **no node**); git hooks use Git Bash (`/c`,
  node present). A node-dependent shell step degrades silently in manual runs only.
  Force Git Bash: `& 'C:\Users\david.hayes\AppData\Local\Programs\Git\bin\bash.exe'`
- **A synchronous `spawnSync`/`execSync` cannot be interrupted by `testTimeout`.**
  `--testTimeout=4000` let tests *pass* at 10463 ms. Slow-but-green hides better
  than red.
- **esbuild inlines shared modules.** Editing `src/shared/*` or a library module
  rewrites every bundle that imports it — the `daemon-client` one-liner touched 11.
  `git status .claude/hooks/dist` is the only reliable list of what to stage.
- **Commit via `pwsh -File scripts/git-safe.ps1 -C <repo> commit -F <msgfile>`.**
  MSYS crashed 3× today; the wrapper recovered on attempt 2 each time.
- **Check for leaked test runners before diagnosing a hang** — a vitest tree from
  the previous day was found alive 29 h later at ~0 CPU. `taskkill /PID <n> /T /F`;
  `Stop-Process` misses the descendants.
- **Every acceptance criterion needs a positive control.** Both tests added today
  initially "passed" because the hook returned early and never reached the code
  under test.

## Definition of done

- `npx vitest run` → **0 failures**, and the file count reflects the deletions
- both ratchets committed, **each demonstrated failing on purpose**
- README §1 updated with the new baseline
- `docs/harness-strategy/README.md` §5.4 points here and says what actually landed
