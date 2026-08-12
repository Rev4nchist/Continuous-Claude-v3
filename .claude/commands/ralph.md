# /ralph - Ralph Autonomous Development Workflow

Autonomous feature development using deterministic loops, PRD-driven planning, and Docker-sandboxed implementation.

## Usage

```
/ralph                    # Full workflow: PRD → Tasks → Build → Review
/ralph plan               # Generate PRD and tasks only, no build
/ralph build <story-id>   # Build specific story from existing .ralph/
/ralph status             # Show current Ralph state
/ralph cleanup            # Remove orphaned worktrees and branches
```

## Workflow Steps

**MANDATORY: Follow ai-dev-tasks templates exactly.**

### Step 1: Load Templates
```bash
cat ~/.claude/ai-dev-tasks/create-prd.md    # PRD template
cat ~/.claude/ai-dev-tasks/generate-tasks.md # Tasks template
```

### Step 1.5: Load TDD Skill
```bash
cat ~/.claude/skills/tdd/SKILL.md           # TDD philosophy + workflow
```
If the feature uses TDD (recommended for all non-trivial features), this informs the interview questions and task format.

### Step 2: Requirements Gathering
1. Ask 3-5 clarifying questions (A/B/C/D format)
2. WAIT for user answers before generating
3. Generate PRD to `/tasks/prd-<feature>.md`

### Step 3: Task Breakdown
1. Generate parent tasks ONLY first
2. Present to user, wait for "Go"
3. Generate sub-tasks with TDD behavior slice format (`{RED: arbiter, GREEN: kraken}`)
4. Save to `/tasks/tasks-<feature>.md`

### Step 3.5: Validate Task Atomicity
Before proceeding to build, verify each task against constraints:
- Max 3-5 source files per task
- 1 observable behavior per task
- Under 2000 word description
- 1-3 test cases per behavior slice
If any task violates, split it before delegating.

### Step 4: Format Conversion
```bash
python ~/.claude/scripts/ralph/prd-to-ralph.py . --story-id STORY-001
```
Creates: `.ralph/PRD.json`, `.ralph/IMPLEMENTATION_PLAN.md`

### Step 5: Story Evaluation
- Target: 10-15 tasks per story
- If >15 tasks: Split into STORY-001, STORY-002, etc.
- Each story = independent, shippable increment

### Step 6: Spawn Ralph Loop (Docker)
```bash
~/.claude/scripts/ralph/spawn-ralph.sh <project> <story-id> <worktree>
```

### Step 7: Review & Merge
After Ralph completes:
- Review changes: `git diff main...HEAD`
- Run tests
- Merge if passing, escalate if failing

## State Machine

Ralph state tracked in `.ralph/state.json` (v2):
```bash
python ~/.claude/scripts/ralph/ralph-state-v2.py status  # Current state
python ~/.claude/scripts/ralph/ralph-state-v2.py story list  # All stories
```

## Signals

Ralph outputs status signals:
- `<TASK_COMPLETE/>` - Task done, continue to next
- `<COMPLETE/>` - All tasks in story done
- `<BLOCKED/>` - Needs intervention

## When to Use

Use Ralph for:
- Building new features from scratch (greenfield)
- Implementing well-defined requirements
- Autonomous "set and forget" development

Do NOT use for:
- Quick fixes (use /fix)
- Debugging (use /debug)
- Research tasks (use /explore)

## References

- Skill: `~/.claude/skills/ralph/SKILL.md`
- TDD Skill: `~/.claude/skills/tdd/SKILL.md`
- TDD Contract: `.ralph/CLAUDE.md` (auto-loads into agent sessions)
- Templates: `~/.claude/ai-dev-tasks/`
- Scripts: `~/.claude/scripts/ralph/`
- Docker: `~/.claude/docker/ralph/`
