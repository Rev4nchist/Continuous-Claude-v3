---
name: review
description: Runs a multi-perspective code and plan review with a Grok cross-model pass when the user asks for one. Use when the user says "review this code", "review my PR", "/review", or asks to check before merging.
---

# /review - Code Review Workflow

Multi-perspective code review with parallel Claude specialists. The cross-model CLI
reviewer has been removed. Do not spawn it, do not look for a receipt line, and do not
tag findings with that name.

## When to Use

- "Review this code"
- "Review my PR"
- "Check this before I merge"
- "Get feedback on implementation"
- Before merging significant changes
- Quality gates

## Workflow Overview

```
         ┌──────────────┐
         │   critic     │ ─┐
         │   (code)     │  │
         └──────────────┘  │
                           │
         ┌──────────────┐  │      ┌──────────────┐
         │ plan-reviewer│ ─┼────▶ │ review-agent │
         │   (plan)     │  │      │ (synthesis)  │
         └──────────────┘  │      └──────────────┘
                           │
         ┌──────────────┐  │
         │ plan-reviewer│ ─┘
         │   (change)   │
         └──────────────┘

         Parallel                Sequential
         perspectives            synthesis
```

## Agent Sequence

| # | Agent | Focus | Execution |
|---|-------|-------|-----------|
| 1 | **critic** | Code quality, patterns, readability | Parallel |
| 1 | **plan-reviewer** | Architecture, plan adherence | Parallel |
| 1 | **plan-reviewer** | Change impact, risk assessment | Parallel |
| 2 | **review-agent** | Synthesize all reviews, final verdict | After 1 |

## Review Perspectives

- **critic**: Is this good code? (Style, patterns, readability)
- **plan-reviewer**: Does this match the design? (Architecture, plan)
- **plan-reviewer**: Is this change safe? (Risk, impact, regressions)
- **review-agent**: Overall assessment and recommendations

## Execution

### Phase 1: Parallel Reviews

```
# Code quality review
Task(
  subagent_type="critic",
  prompt="""
  Review code quality: [SCOPE]

  Evaluate:
  - Code style and consistency
  - Design patterns used
  - Readability and maintainability
  - Error handling
  - Test coverage

  Output: List of issues with severity (critical/high/medium/low)
  """,
  run_in_background=true
)

# Architecture review
Task(
  subagent_type="plan-reviewer",
  prompt="""
  Review architecture alignment: [SCOPE]

  Check:
  - Follows established patterns
  - Matches implementation plan (if exists)
  - Consistent with system design
  - No architectural violations

  Output: Alignment assessment with concerns
  """,
  run_in_background=true
)

# Change impact review
Task(
  subagent_type="plan-reviewer",
  prompt="""
  Review change impact: [SCOPE]

  Assess:
  - Risk level of changes
  - Affected systems/components
  - Backward compatibility
  - Potential regressions
  - Security implications

  Output: Risk assessment with recommendations
  """,
  run_in_background=true
)

# Wait for the three parallel reviews (the completion notices). Never poll in a loop.
```

Plan mode: say "Review pass: deferred (plan mode)".

### Phase 2: Synthesis

```
Task(
  subagent_type="review-agent",
  prompt="""
  Synthesize reviews for: [SCOPE]

  Reviews:
  - critic: [code quality findings]
  - plan-reviewer: [architecture findings]
  - plan-reviewer: [change impact findings]

  Findings that two reviewers flag are high-confidence.

  Create final review:
  - Overall verdict (APPROVE / REQUEST_CHANGES / NEEDS_DISCUSSION)
  - Prioritized action items (group: both-flagged, single-reviewer)
  - Blocking vs non-blocking issues
  - Summary for PR description
  """
)
```

## Review Modes

### Full Review
```
User: /review
→ critic + 2x plan-reviewer + review-agent
```

### Quick Review
```
User: /review --quick
→ critic only, fast feedback
```

### Security Focus
```
User: /review --security
→ Add aegis (security agent) to parallel phase
```

### PR Review
```
User: /review PR #123
→ Fetch PR diff, review changes
```

## Verdicts

- **APPROVE**: Ready to merge, all issues are low or medium
- **REQUEST_CHANGES**: Blocking issues must be fixed
- **NEEDS_DISCUSSION**: Architectural decisions need input
