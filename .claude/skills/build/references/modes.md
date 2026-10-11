# Build Skill — Mode Details & Examples

## Skill Execution Details

### discovery-interview

```
Task(
  subagent_type="discovery-interview",
  prompt="""
  [Contents of discovery-interview SKILL.md]

  ---

  ## Context
  Feature request: <description>
  Handoff directory: thoughts/shared/handoffs/<session>/

  Conduct the interview and create spec.
  """
)
```
Output: Spec file at `thoughts/shared/specs/<name>-spec.md`

### onboard

```
Task(
  subagent_type="onboard",
  prompt="""
  [Contents of onboard SKILL.md]

  ---

  Analyze this codebase and create continuity ledger.
  Handoff directory: thoughts/shared/handoffs/<session>/
  """
)
```
Output: TLDR caches, continuity ledger

### research-codebase

```
Task(
  subagent_type="research-codebase",
  prompt="""
  [Contents of research-codebase SKILL.md]

  ---

  Research question: How should we implement <description>?
  Focus areas: [based on spec or description]
  Handoff directory: thoughts/shared/handoffs/<session>/
  """
)
```
Output: Research document at `thoughts/shared/research/<date>-<topic>.md`

### tldr-code (refactor mode only)

```bash
# Run impact analysis on the function/module being refactored
tldr impact <target> src/ --depth 3 > thoughts/shared/handoffs/<session>/impact-analysis.json

# Also run architecture analysis
tldr arch src/ > thoughts/shared/handoffs/<session>/architecture.json
```
Output: Impact and architecture analysis files

### plan-agent

```
Task(
  subagent_type="plan-agent",
  prompt="""
  [Contents of plan-agent SKILL.md]

  ---

  ## Context
  Feature request: <description>

  [Include spec if exists from discovery-interview]
  [Include research findings if exists]
  [Include impact analysis if refactor mode]

  Handoff directory: thoughts/shared/handoffs/<session>/
  """
)
```
Output: Plan at `thoughts/shared/plans/PLAN-<name>.md`, handoff at `<session>/plan-<name>.md`

**CHECKPOINT after plan-agent:**
```
Plan created: thoughts/shared/plans/PLAN-<name>.md

Please review the plan. Options:
1. Approve and continue to [next phase]
2. Request changes to plan
3. Abort workflow

[Show plan summary]
```

### validate-agent

```
Task(
  subagent_type="validate-agent",
  prompt="""
  [Contents of validate-agent SKILL.md]

  ---

  Plan to validate: [Plan content]
  Plan path: thoughts/shared/plans/PLAN-<name>.md
  Handoff directory: thoughts/shared/handoffs/<session>/
  """
)
```
Output: Validation handoff at `<session>/validation-<name>.md`

**CHECKPOINT after validate-agent (if issues found):**
```
Validation complete with issues:
- [Issue 1]
- [Issue 2]

Options:
1. Proceed anyway (acknowledge risks)
2. Update plan and re-validate
3. Abort workflow
```

### tdd (tdd/refactor modes)

```
Load the tdd skill and follow it on the approved plan:
1. Decompose the plan into vertical slices
2. Per slice: arbiter writes 1-3 failing tests (RED), kraken makes them pass (GREEN), arbiter verifies
3. arbiter runs the full suite at the end
```
This phase is the implementation. Do not run a separate kraken phase after it.

### kraken

```python
# Check plan size
if task_count <= 3:
    # Direct implementation
    Implement the plan in the main conversation
else:
    # Agent orchestration mode
    For each task:
        Task(
          subagent_type="kraken",
          prompt="""
          Plan: [Plan content]
          Your task: Task N of M: <task description>
          Previous task: [Summary saved from the previous task, or "First task"]
          """
        )
        # kraken writes no handoff file. It returns status, a summary and followups.
        Save that return value to <session>/task-NN-<description>.md yourself.
        If status is "partial": re-spawn kraken with the followups text, before the next task.
        If status is "blocked": stop and go to Step 3 (Handle Errors).
```
Output: Task handoffs at `<session>/task-NN-<description>.md`, written by the orchestrator. Resume reads them.

**CHECKPOINT after each implementation phase:**
```
Phase [N] Complete

Automated verification:
- [x] Tests passing
- [x] Type check passed
- [ ] Manual testing required

Please verify:
- [Manual test items from plan]

Continue to next phase? [Y/n]
```

### commit

```
Follow commit skill:
1. Show git status and diff
2. Present commit plan
3. Execute on user approval
4. Generate reasoning file
```

### open-pr

```
Follow pr-and-commit-style.md (no skill for this step):
1. Push the branch to fork
2. Write the title and description: the problem first, then the fix, then Evidence
3. Create the PR with gh api (REST)
```

---

## Example Sessions

### Greenfield Feature

```
User: /build greenfield Add user authentication with OAuth

Claude: Starting greenfield workflow for "Add user authentication with OAuth"

Creating session: build-20260108-user-auth-oauth
Chain: discovery-interview -> plan-agent -> validate-agent -> kraken -> commit -> open the PR

Phase 1/6: Discovery Interview
[Spawns discovery-interview agent]

Interview questions:
1. What OAuth providers do you need? (Google, GitHub, etc.)
2. What user data should we store after auth?
3. Should sessions persist across browser closes?
...

[After interview completes]

Spec created: thoughts/shared/specs/2026-01-08-user-auth-spec.md

Phase 2/6: Planning
[Spawns plan-agent]

Plan created: thoughts/shared/plans/PLAN-user-auth.md

--- CHECKPOINT ---
Plan Summary:
- Task 1: Set up OAuth provider configuration
- Task 2: Create user model and session storage
- Task 3: Implement OAuth callback endpoints
- Task 4: Add auth middleware
- Task 5: Create login/logout routes

Approve plan and continue? [Y/n]

User: Y

Phase 3/6: Validation
[Spawns validate-agent]

Validation: PASSED
All tech choices are current best practices.

Phase 4/6: Implementation (5 tasks)
[Spawns implementation agents for each task]

Task 1/5: OAuth configuration... Complete
Task 2/5: User model... Complete
Task 3/5: OAuth callbacks... Complete
Task 4/5: Auth middleware... Complete
Task 5/5: Login/logout routes... Complete

--- CHECKPOINT ---
All implementation complete.
Tests: 24 passing
Manual verification needed:
- [ ] Test OAuth flow end-to-end
- [ ] Verify session persistence

Continue to commit? [Y/n]

User: Y

Phase 5/6: Commit
[Shows changes, creates commit]

Phase 6/6: PR Description
[Creates/updates PR]

Build complete!
PR #42: https://github.com/user/repo/pull/42
```

### TDD Mode

```
User: /build tdd Add rate limiting to API endpoints

Claude: Starting TDD workflow for "Add rate limiting to API endpoints"

Phase 1/2: Planning
[Creates plan with test specifications]

--- CHECKPOINT ---
Plan approved? [Y/n]

User: Y

Phase 2/2: TDD Implementation

Let's start with the first test. According to the plan, we need to test:
"Rate limiter returns 429 after 100 requests per minute"

RED - Write failing test:
def test_rate_limiter_returns_429_after_limit():
    limiter = RateLimiter(limit=100, window=60)
    for _ in range(100):
        assert limiter.check("user1") == True
    assert limiter.check("user1") == False

Running test... FAILED (as expected - RateLimiter doesn't exist)

GREEN - Implement minimal code:
[Guides through implementation]

Running test... PASSED

REFACTOR - Any cleanup needed?

Next test: "Rate limiter resets after window expires"
...

Last slice: "Endpoints use the rate limiter"
[Same RED, GREEN, VERIFY cycle]

Final full suite: PASSED

Build complete!
```

### Refactor Mode

```
User: /build refactor Extract auth logic into separate module

Claude: Starting refactor workflow for "Extract auth logic into separate module"

Phase 1/3: Impact Analysis
Running: tldr impact auth src/ --depth 3

Impact analysis complete:
- 12 files directly call auth functions
- 3 entry points affected
- No circular dependencies detected

Architecture analysis:
- auth is currently in: src/api/middleware/
- Callers in: src/api/routes/, src/api/handlers/

--- CHECKPOINT ---
Review impact before planning? [Y/n]

User: Y

[Shows detailed impact report]

Phase 2/3: Planning
[Creates refactor plan based on impact analysis]
...
```

---

## Error Recovery Details

### If a phase fails

```
Phase 3 (validate-agent) failed:

Error: WebSearch unavailable

Options:
1. Retry phase (recommended)
2. Skip validation (--skip-validate)
3. Abort workflow

Choice:
```

### If implementation is blocked

```
Task 3/5 blocked:

Blocker: Database schema doesn't match expected structure
Found: users.email (VARCHAR)
Expected: users.email (UNIQUE VARCHAR)

Options:
1. Create migration to fix schema
2. Adjust plan to work with current schema
3. Abort and investigate

Choice:
```

### Orchestration state on failure

```yaml
# orchestration.yaml
phases:
  - skill: plan-agent
    status: complete
  - skill: validate-agent
    status: blocked
    error: "Validation found deprecated library"
    blocker: "Need to replace X with Y"
```
