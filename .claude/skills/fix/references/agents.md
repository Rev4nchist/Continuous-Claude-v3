# Fix Skill — Agent Reference

## Agent Roster

| Agent | Role | Used In |
|-------|------|---------|
| `sleuth` | Investigation after the repro (logs, db, git, runtime) | bug, hook |
| `hooks` (skill) | Hook source, build, registration and test patterns | hook |
| `kraken` | TDD implementation, regression tests | all scopes |
| `oracle` | External research (correct versions, alternatives) | deps |
| `scout` / `research-codebase` | Codebase context gathering | pr-comments |
| `gh` CLI | Fetch PR comments and context | pr-comments |
| `plan-agent` | Create multi-step fix plan | deps, pr-comments |
| preflight (plain step) | Check current dependency state | deps |
| lint (plain step) | Post-fix quality verification | deps |
| `premortem` | Risk assessment before implementation | all scopes |
| `general-purpose` | Git commit workflow | all scopes |
| `create_handoff` | Session handoff doc | always |

## Chain Flows by Scope

### bug

```
reproduce (run the failing command, save the failing output)
  |
  v
sleuth (logs + git + runtime investigation)
  |
  v
[HUMAN CHECKPOINT: confirm diagnosis]
  |
  v
[PREMORTEM: quick risk check]
  |
  v
kraken (implement + TDD)
  |
  v
re-run the same repro (must pass)
  |
  v
kraken (regression test)
  |
  v
[HUMAN CHECKPOINT: verify fix]
  |
  v
commit
```

### hook

```
reproduce (feed a real payload to the hook, save the failing output)
  |
  v
sleuth (structured hook investigation)
  |
  v
[HUMAN CHECKPOINT: confirm diagnosis]
  |
  v
[PREMORTEM: quick risk check]
  |
  v
kraken (implement + hooks skill patterns)
  |
  v
re-run the same repro (must pass)
  |
  v
[HUMAN CHECKPOINT: verify fix]
  |
  v
commit
```

### deps

```
preflight (check current state)
  |
  v
oracle (find correct versions/alternatives)
  |
  v
plan-agent (create fix plan)
  |
  v
[HUMAN CHECKPOINT: plan review]
  |
  v
[PREMORTEM: quick risk check]
  |
  v
kraken (implement the plan)
  |
  v
lint
  |
  v
[HUMAN CHECKPOINT: verify fix]
  |
  v
commit
```

### pr-comments

```
fetch PR comments (gh CLI)
  |
  v
research-codebase (understand context)
  |
  v
plan-agent (plan for each comment)
  |
  v
[HUMAN CHECKPOINT: plan review]
  |
  v
[PREMORTEM: quick risk check]
  |
  v
kraken (implement the plan)
  |
  v
[HUMAN CHECKPOINT: verify fix]
  |
  v
commit (reference PR comments)
```

## Implementation Prompts

### bug — kraken prompt

```
Implement fix with TDD approach. Method source: `systematic-debugging`.

Root cause: {diagnosis.root_cause}
Files: {diagnosis.files_to_modify}
Approach: {diagnosis.approach}

Repro command: {repro.command}

Steps:
1. Write the failing repro test, run it red, save the output. Make it the first change in the diff. Do not commit. Kraken never commits. With `--no-test`: run the repro as a command or a scratch file outside the repo, and add no test file.
2. Implement minimal fix to pass the repro
3. Re-run the same repro command and see it pass
4. Refactor if needed
5. Run full test suite
```

### hook — kraken prompt

```
Fix hook issue.

Root cause: {diagnosis.root_cause}

Repro command: {repro.command}

Follow the `hooks` skill:
1. Check hook registration in settings.json
2. Verify shell wrapper exists and is executable
3. Write the failing repro (mock input), run it red, save the output. Make it the first change in the diff. Do not commit. Kraken never commits. With `--no-test`: keep the mock input outside the repo, and add no test file.
4. Rebuild if TypeScript source was modified
5. Re-run the same repro and see it pass
6. Verify hook fires correctly
```

### deps — kraken prompt

```
Fix dependency issue.

Root cause: {diagnosis.root_cause}

Follow plan-agent workflow:
1. Research correct dependency versions
2. Create implementation plan
3. Update lockfiles
4. Run the dependency preflight
5. Run lint
```

### pr-comments — kraken prompt

```
Address PR feedback.

Comments: {diagnosis.pr_comments}

Follow plan-agent workflow:
1. Research codebase for context
2. Create implementation plan for each comment
3. Implement changes
4. List which comment each change answers. Do not commit. Kraken never commits.
```

### regression test — kraken prompt

```
Create regression test for the fix.

Bug: {original_issue}
Fix: {implementation_summary}

For `bug` and `hook`, promote the Phase 5 repro into the regression test. It ran red before the fix and green after. Write no second test.
For other scopes, follow the `tdd` skill:
1. Write test that would have caught this bug
2. Run it against pre-fix code and see it fail
3. Run it against fixed code and see it pass
4. Test should be minimal and focused
Kraken never commits.
```

---

## Integration with Other Skills

This skill orchestrates:
- `systematic-debugging`: Method source (reproduce first)
- `debug`: Initial investigation
- `sleuth`: Investigation agent
- `kraken`: TDD implementation agent
- `tdd`: Test creation
- `hooks`: Hook source, build and registration patterns
- `plan-agent`: Complex fix planning
- preflight (plain step): Dependency checks
- `oracle` / `research-codebase`: Context gathering
- `gh` CLI (fetch PR comments): PR context fetching
- lint (plain step): Quality verification
- `premortem`: Risk assessment before implementation
- `commit`: Git commit workflow
- `create_handoff`: Session handoff
