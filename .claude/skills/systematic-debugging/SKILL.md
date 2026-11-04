---
name: systematic-debugging
description: Finds the root cause of a bug before any fix, then fixes it with a failing test first. Use before proposing or making any fix when something is broken, even if the user asks for a quick fix. Covers "debug", "fix this bug", "why is X broken", "find the root cause", failing test, CI failure, flaky test, crash, repeated failure. Not for new features.
---

# Systematic Debugging

A guess that half works hides the real cause. The third patch often breaks what the first one touched.
Find out why the bug happens before you change anything.

## Iron Law

```
NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST
```

Finish Phase 1 before you propose a fix. A fix named in your reply counts as a proposed fix.
Use all four phases on every bug. A simple bug takes about a minute: read the error, confirm the cause, write the failing check, fix.

## Phase 1: Investigate the root cause

1. **Read the whole error.** Read the full message and stack trace, not the first line. Note file paths, line numbers and error codes.
2. **Reproduce it.** Find the exact command that triggers it. Check whether it fails every time. If it does not reproduce, gather more data. Do not guess.
3. **Check what changed.** Read `git diff`, recent commits, new dependencies, config and environment differences.
4. **Bisect when you have a known-good commit.** See "Find the commit that broke it" below.
5. **Log at each component boundary.** When the system has layers (CI, build, deploy; UI, API, database; CLI, config, child process), do not guess the broken layer. Add temporary logging at each boundary. Run once. Find where good data turns bad. Then investigate that one layer.
6. **Trace the data backward.** When the error shows deep in a call stack, ask where the bad value came from. Then ask what called that code. Continue to the source. Fix the source, not the crash site. Technique: [root-cause-tracing](references/root-cause-tracing.md).

Boundary logging example. Log whether a secret is set. Never log its value.

```powershell
"API_TOKEN: " + $(if ($env:API_TOKEN) { 'SET' } else { 'UNSET' })
"config: " + $(if ($env:CONFIG_PATH) { $env:CONFIG_PATH } else { '<unset>' })
if ($env:CONFIG_PATH -and (Test-Path -LiteralPath $env:CONFIG_PATH)) { 'config readable' }
node -e "console.log('NODE_ENV =', process.env.NODE_ENV)"
```

In bash, the same secret check is `[ -n "${API_TOKEN:-}" ] && echo SET || echo UNSET`.

Mark every temporary log line with `DEBUG-TMP`. Never commit temporary logging. Before a commit, run `git diff HEAD | Select-String DEBUG-TMP` (staged and unstaged changes) and remove every hit.

Phase 1 is done when you can say what is wrong and why, backed by something you observed and not something you assumed.

**Recurring identical failures point to infrastructure.** If the same defect returns after each "fix", something regenerates it. Suspect loops, syncs, daemons and stale baselines before you suspect a person or a session. Incident: the 2026-05-24 hook regression. Match the time of each recurrence to a log entry of a scheduled or background process.

### Find the commit that broke it

Other sessions share this working tree, and bisect checks out old commits. Run it in a scratch worktree.

```powershell
git worktree add "$env:TEMP\bisect-wt" <bad>
git -C "$env:TEMP\bisect-wt" bisect start <bad> <good>
git -C "$env:TEMP\bisect-wt" bisect run <repro-command>
git -C "$env:TEMP\bisect-wt" bisect reset
```

The repro command must exit 0 when the commit is good and non-zero when it is bad. Ask Dave before you remove the worktree.

### Hard or performance bugs

This skill stays the entry point. For a hard bug or a performance regression, also follow
[diagnosing-bugs](../_vendor/pocock-skills/skills/diagnosing-bugs/SKILL.md).
Build a tight loop that goes red before any hypothesis. Use its perf branch for a performance regression.
To use [its HITL script](../_vendor/pocock-skills/skills/diagnosing-bugs/scripts/hitl-loop.template.sh), copy it to the scratchpad and edit the copy.
Never edit or run the vendored file. The script waits for keyboard input, so ask Dave to run the copy in his terminal with Git Bash.
CCv3 rules win on conflict.

## Phase 2: Compare with working code

1. **Find working code** in the same codebase that does a similar thing.
2. **Read the reference completely.** If you follow a pattern, a library doc or an example, read every line before you apply it. Skimming causes "I adapted it slightly" bugs.
3. **List every difference** between the working case and the broken case. Do not assume a small difference cannot matter.
4. **Check dependencies:** the config, environment, versions and assumptions the broken code needs.

## Phase 3: Test one hypothesis

1. **State one hypothesis:** "X is the root cause because Y." Be specific.
2. **Name a rival.** Name at least one OTHER cause that produces the same symptoms. State the evidence that eliminates it. To stop at the first fit is how wrong diagnoses ship.
3. **Run the smallest experiment:** a log line, a debugger check or a temporary change. Change one variable at a time.
4. **Revert the experiment** once it has answered the question. The real fix comes in Phase 4, after the failing test. Never stack a new change on a failed one.
5. **Read the result.** Confirmed: go to Phase 4. Not confirmed: form a new hypothesis from what you learned.
6. **Say when you do not know.** "I don't understand X yet" is a valid status. Research more or ask Dave. Do not pretend.

## Phase 4: Fix

1. **Write a failing test first.** Use the smallest reproduction you can automate. Without a test framework, use a one-off script. Run it. Confirm it fails for the reason you expect.
2. **Make one fix** for the root cause. Add no "while I'm here" changes and no bundled refactor.
3. **Verify.** The new test passes. The existing tests pass. The Phase 1 reproduction no longer fails.
4. **Search for the same defect elsewhere.** Grep for the same pattern. Report each hit. Fix other hits in a separate change unless Dave says otherwise.
5. **Clean up.** Remove all `DEBUG-TMP` logging and temporary scripts. Keep any check that would catch this bug earlier. [defense-in-depth](references/defense-in-depth.md) shows where to put checks.
6. **Count failed fixes.** Fewer than 3: return to Phase 1 with what you learned. Three or more: stop.

### After 3 failed fixes: question the design

Stop at 3 failed fixes. This agrees with CLAUDE.md "Self-healing": after 3 attempts, stop and report what you tried, what failed and your recommended next step.

Signs that the design is the problem:
- Each fix shows new shared state or coupling in another place.
- Each fix needs a large refactor.
- Each fix creates a new symptom elsewhere.

Do not try fix number 4. Tell Dave what you tried and what each attempt showed. Say why the pattern is unsound. Decide together whether to refactor or keep patching.

## Red flags: return to Phase 1

Return to Phase 1 when you think or write any of these:

- "Quick fix for now, investigate later"
- "Let me just try changing X and see"
- "I'll make a few changes and run the tests"
- "It's probably X, let me fix that"
- "I don't fully understand it, but this might work"
- A list of likely problems followed by fixes, with no investigation
- "One more attempt" after two have failed

Dave may say "Is that actually happening?", "Stop guessing", "Will that show us anything?" or "Are we stuck?". Each phrase means you skipped the evidence. Return to Phase 1.

## Rationalizations

| Excuse | Reality |
|--------|---------|
| "It's simple, I don't need the process" | Simple bugs have root causes. The process is fast for them. |
| "It's an emergency, no time" | Systematic debugging is faster than guess and check. |
| "I'll try this first, then investigate" | The first guess sets the pattern for every later attempt. |
| "I'll add the test after the fix works" | A fix you never saw fail proves nothing. |
| "Several fixes at once saves time" | You cannot tell which fix worked or which one broke something. |
| "I can see the problem" | You see the symptom. That is not the cause. |
| "Just quick-fix it" | Dave wants a fix that stays fixed. A masked bug returns. |

## When the cause is not in the code

The cause can be environmental, timing dependent or external, for example a flaky network or a third-party outage. Then:

1. Write down what you investigated and ruled out.
2. Add proper handling: retry with backoff, a timeout or a clear error message.
3. Add logging so the next occurrence leaves evidence.

Be suspicious of this conclusion. An investigation that stopped early looks the same from inside. Ask what you have not checked. For a flaky test, check for a race condition first. See [condition-based-waiting](references/condition-based-waiting.md).

## Report

Put these four parts in your final reply, under these labels, before the Next steps block that CLAUDE.md requires:

- **Root cause:** what was wrong and why, with the evidence that showed it.
- **Fix:** what you changed and where.
- **Proof:** the test that failed before and passes now, plus the suite result.
- **Ruled out:** the rival causes you tested, each with the evidence that eliminated it.

## Supporting files

| File | Read it when |
|------|--------------|
| [root-cause-tracing](references/root-cause-tracing.md) | An error shows deep in a call stack and you need the original trigger. |
| [defense-in-depth](references/defense-in-depth.md) | The cause is fixed and you want checks at several layers. |
| [condition-based-waiting](references/condition-based-waiting.md) | A test uses sleeps or timeouts and fails under load. |
| [condition-based-waiting-example.ts](references/condition-based-waiting-example.ts) | You need helper code to adapt. It imports types from another project and does not run as is. |
| [find-polluter.sh](scripts/find-polluter.sh) | A test run leaves an unwanted file or state and you do not know which test does it. |

`find-polluter.sh` is a bash script. It runs the test command once for each matching test file. It deletes nothing. It stops at the first test that creates the target path. Run it from the project root in Git Bash, because `bash` on the PATH is WSL. Set `TEST_CMD` for your runner, for example `TEST_CMD="npx vitest run"`.

## Notice

Adapted from obra/superpowers `skills/systematic-debugging` (v2.0.0, Jesse Vincent, MIT), commit `2ce8aa15d05bd57213e6f746f953aafb7ded7a8b`, through claude-code-templates commit `d10f911da886ed166bb9fc0fd0563ad7218c4b97`. The licence is in [LICENSE.txt](LICENSE.txt). The files in `references/` and `scripts/` are vendored from that source.
