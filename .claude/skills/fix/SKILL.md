---
name: fix
description: "Runs the /fix bug workflow: reproduce, investigate, fix, re-run the repro, commit after Dave confirms. Use when the user types /fix."
allowed-tools: [Bash, Read, Grep, Write, Edit, Task]
disable-model-invocation: true
---

# Fix

Workflow orchestrator for bug investigation and resolution. Chains specialized agents based on issue scope.

Only the `/fix` slash command loads this skill. The method comes from the `systematic-debugging` skill: reproduce first, find the root cause, fix, then re-run the same repro.

**References:**
- Agent chains + implementation prompts: `references/agents.md`
- Investigation templates + handoff schema: `references/debugging-procedures.md`

## Usage

```
/fix <scope> [options] [description]
```

## Question Flow (No Arguments)

If the user types just `/fix` with no or partial arguments, guide them through this question flow.

### Phase 0: Workflow Selection

```yaml
question: "What would you like to fix?"
header: "Fix type"
options:
  - label: "Help me choose (Recommended)"
    description: "I'll ask questions to pick the right fix workflow"
  - label: "Bug - something is broken"
    description: "Chain: reproduce → investigate → diagnose → implement → re-run repro → commit"
  - label: "Hook - Claude Code hook issue"
    description: "Chain: reproduce → investigate → hooks skill → implement → re-run repro"
  - label: "Dependencies - import/package errors"
    description: "Chain: preflight → research → plan → implement → lint"
  - label: "PR Comments - address reviewer feedback"
    description: "Chain: fetch PR comments → research → plan → implement → commit"
```

**Mapping:**
- "Help me choose" → Continue to Phase 1-4 questions
- "Bug" → scope=bug, skip to Phase 2
- "Hook" → scope=hook, skip to Phase 2
- "Dependencies" → scope=deps, skip to Phase 2
- "PR Comments" → scope=pr-comments, skip to Phase 2

### Phase 1: Issue Type

```yaml
question: "What kind of issue are you dealing with?"
options:
  - label: "Something is broken/not working" → bug scope
  - label: "Claude Code hook not firing" → hook scope
  - label: "Import/dependency errors" → deps scope
  - label: "Need to address PR feedback" → pr-comments scope
```

### Phase 2: Issue Details

Free text — capture the error message, unexpected behavior, or PR link.

### Phase 3: Investigation Depth

```yaml
options:
  - label: "Diagnose and fix" → full workflow
  - label: "Diagnose only (dry run)" → --dry-run
  - label: "Quick fix" → reproduce → spark → re-run repro
```

### Phase 4: Testing & Commit

```yaml
multiSelect: true
options:
  - label: "Write a regression test" → include regression phase
  - label: "Commit the fix" → include commit phase
  - label: "Just fix, nothing else" → --no-test --no-commit
```

### Summary Before Execution

```
Based on your answers, I'll run:

**Scope:** bug
**Issue:** "Login button not responding on Safari"
**Chain:** reproduce → sleuth (investigate) → spark (fix) → re-run repro → arbiter (test) → commit
**Options:** (none)

Proceed? [Yes / Adjust settings]
```

## Scopes

| Scope | Chain |
|-------|-------|
| `bug` | reproduce → sleuth → diagnose → premortem → kraken (TDD) → re-run repro → kraken (test) → commit |
| `hook` | reproduce → sleuth → diagnose → premortem → kraken (hooks skill) → re-run repro → commit |
| `deps` | preflight → oracle → plan-agent → premortem → kraken → lint → commit |
| `pr-comments` | fetch PR comments → research-codebase → plan-agent → premortem → kraken → commit |

See `references/agents.md` for full per-scope flow diagrams.

### Investigator selection: sleuth vs debug-agent

The `bug` and `hook` chains shown above default to `sleuth` for the investigation phase. Both agents load the `systematic-debugging` skill, so the methodology is identical — the split is about *where* you point the agent:

- **sleuth** — deep forensics. Use when the bug is multi-file, intermittent, or needs evidence-grade reproduction with traced code paths. Sleuth produces file:line citations and a reproduction script.
- **debug-agent** — general root-cause analysis. Use when the failure mode is not yet localized and you just need a competent first pass to surface candidate causes.

Both have `model: opus` and overlapping toolsets; the agent frontmatter `description` fields encode this split (see `.claude/agents/sleuth.md` and `.claude/agents/debug-agent.md`). When a `/fix` invocation passes a multi-file or intermittent symptom, prefer `sleuth`. When the symptom is one error message in one file or the user is unsure where it lives, prefer `debug-agent`.

## Options

| Option | Effect |
|--------|--------|
| `--no-test` | Skip regression test creation |
| `--dry-run` | Diagnose only, don't implement fix |
| `--no-commit` | Don't auto-commit the fix |

## Workflow Phases

### Phase 1: Parse Arguments

```bash
SCOPE="${1:-bug}"
NO_TEST=false; DRY_RUN=false; NO_COMMIT=false
for arg in "$@"; do
  case $arg in
    --no-test) NO_TEST=true ;;
    --dry-run) DRY_RUN=true ;;
    --no-commit) NO_COMMIT=true ;;
  esac
done
```

### Phase 2: Reproduce, then Investigate

For `bug` and `hook`, reproduce first. Run the failing command or hook payload on the real surface. Save the failing output. Do not diagnose before you have a failing repro. The method source is the `systematic-debugging` skill.

Then spawn `sleuth` (bug/hook) or scope-appropriate agents (deps/pr-comments). Pass the repro command and its saved output to the agent.

See `references/debugging-procedures.md` for the full sleuth investigation prompt.

### Phase 3: Diagnosis Report

Present structured findings: logs, database state, git state, runtime state, root cause hypothesis, proposed fix, risk rating.

See `references/debugging-procedures.md` for the full diagnosis report template.

### Phase 4: Human Checkpoint (Diagnosis)

**REQUIRED — never skip.**

```
AskUserQuestion(
  question="Proceed with the proposed fix?",
  options=["yes", "no", "modify"]
)
```

If "modify" → gather new requirements and update approach.
If "no" → create diagnostic handoff and exit.
If `--dry-run` → create diagnostic handoff and exit here.

### Phase 4.5: Risk Assessment (Premortem)

Run `/premortem quick` after diagnosis approval.

See `references/debugging-procedures.md` for premortem context template.

**Risk decision:**
- No HIGH tigers → proceed to Phase 5
- HIGH tigers found → present to user: accept / modify / research mitigations

### Phase 5: Implementation

Route to `kraken` with scope-appropriate prompt.

For `bug` and `hook`, write the repro test first. Run it red and save the output. Make it the first change in the diff. Do not commit it here. After the fix, re-run the same repro command. The fix is done only when that repro passes. Save the passing output.

With `--no-test`, the repro is a temporary check: a command or a scratch file outside the repo. Run it red, fix, run it green. Add no test file to the diff.

See `references/agents.md` for per-scope kraken prompts.

### Phase 6: Regression Test (unless --no-test)

For `bug` and `hook`, promote the Phase 5 repro into the regression test. It ran red before the fix and green after. Write no second test. For other scopes, spawn `kraken` to write a focused regression test.

See `references/agents.md` for the regression test prompt.

### Phase 7: Human Checkpoint (Verification)

```
AskUserQuestion(
  question="Fix implemented. Please verify and confirm.",
  options=["looks good", "needs adjustment", "revert"]
)
```

If "needs adjustment" → return to Phase 5.
If "revert" → run rollback and exit.

### Phase 8: Commit (unless --no-commit)

Commit only here, after Dave confirms in Phase 7. Never commit under `--no-commit` or "Just fix, nothing else". Kraken never commits.

Spawn `general-purpose` agent following the commit skill: git diff review → descriptive message → await confirmation → execute.

## Handoff Creation

**Always create a handoff**, even with `--dry-run`.

See `references/debugging-procedures.md` for the full YAML schema.

**Location:** `thoughts/shared/handoffs/fix/{scope}/{timestamp}_{description}.yaml`

## Examples

```bash
/fix bug                  # Investigate → diagnose → implement → test → commit
/fix bug --dry-run        # Diagnose only, no code changes
/fix hook --no-commit     # Fix hook, skip auto-commit
/fix bug --no-test        # Fix and commit, no regression test
/fix pr-comments          # Fetch PR, plan, implement, commit
```

## Checkpoints Summary

| Checkpoint | Purpose | Skip Condition |
|------------|---------|----------------|
| After diagnosis | Confirm root cause | Never skip |
| After premortem | Accept or mitigate risks | No HIGH tigers |
| After fix | Verify resolution | Never skip |
| Before commit | Review changes | `--no-commit` |

Human checkpoints prevent wrong fixes, ensure user understands changes, and catch edge cases.
