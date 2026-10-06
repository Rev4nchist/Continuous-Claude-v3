---
name: systematic-debugging
description: Root-cause investigation framework applied before writing any fix. Use when user says "debug", "fix this bug", "why is X broken", "find the root cause".
---

# Systematic Debugging

No fix before you know the root cause. A fix without a repro and a cause masks the bug, and the bug comes back.

Copy the 5 steps into the task list. A step you skip stays in the list as `skip: <reason>`.

## 1. Reproduce and save the failing output

- Run the failure on the surface where it happens: the built hook with a real payload, the CLI, the
  browser flow, the query. Use the project's E2E command when it has one (`AGENTS.md` "Testing").
- Save the command and its failing output to a file (in CCv3: `.claude/cache/e2e/`). This is the repro.
- Cannot reproduce? Stop. Collect more evidence (logs, timestamps, inputs) before you form a theory.
  Do not fix what you cannot see fail.
- Read-only task ("just tell me", "no fix yet"): still give the exact repro command, and say what
  output proves the bug.

## 2. Find what changed and why the code is the way it is

Follow `references/why.md`. In short:
- `git log --follow -- <file>`, `git log -S '<string>'`, `git blame -L <a>,<b> <file>`.
- `gh pr view <n> --json body,comments,reviews` for the PR that added the line.
- Check recent deploys, syncs, config edits and restarts against the first failure time.

List 2-3 candidate causes. For each, give the check that confirms or rules it out, and run the
checks you can. Then name the cause: "The root cause is X because Y", with a file and line.

- **Rival causes.** For the cause you name, state the evidence that rules out each other candidate.
  Stopping at the first fit ships wrong diagnoses.
- **Recurring identical failure** (the same defect after each "fix"): suspect a process that
  regenerates it (a sync, loop, daemon or stale baseline), not a person.
- **Same pattern elsewhere.** Search for the same code shape. Report each other site, even when the
  ask names only one.

## 3. Make the smallest fix

- Change one thing. Fix the cause, not the symptom. Name what else the change can touch.
- Several changes at once hide which one worked. "Try this and see" is not a fix.

## 4. Run the same repro and see it pass

- Run the exact command from step 1. Save the passing output next to the failing one.
- Also run the checks for the surface you changed (tests, type check, lint, build).
- Ask which test should have caught this. Add the missing case to it.
- The repro still fails: return to step 2. After 3 failed fixes, stop and report what you tried.

## 5. Keep the repro as a test

- Turn the repro into a test or probe that fails without the fix. Make it the first change in the
  diff, and name its red and green runs in the commit or PR.
- Commit only when the task allows commits. The repro does not give you a separate permission to commit.
- No test framework reaches it cheaply: keep the saved repro command and output as the artifact,
  and name it in the commit or PR.

## Hand-off checks

- The cause has a file and line, and each other candidate is ruled out with evidence.
- The step 1 command fails before the fix and passes after it. Both outputs are saved.
- Other sites with the same pattern are listed.
