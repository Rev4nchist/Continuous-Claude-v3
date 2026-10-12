---
name: review
description: Runs a multi-perspective code and plan review with a cross-model Codex pass. Use when the user says "review this code", "review my PR", "/review", or asks to check before merging.
---

# /review - Code Review Workflow

Multi-perspective code review with parallel specialists, including a cross-model adversarial pass via OpenAI Codex. Same-family reviewers share blind spots — Codex (different training family) provides cross-model triangulation. See `.claude/rules-ondemand/codex-adversarial.md` for the full convention.

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
         ┌──────────────┐  │
         │ plan-reviewer│ ─┤
         │   (plan)     │  │      ┌──────────────┐
         └──────────────┘  ├────▶ │ review-agent │
                           │      │ (synthesis)  │
         ┌──────────────┐  │      └──────────────┘
         │ plan-reviewer│ ─┤
         │   (change)   │  │
         └──────────────┘  │
                           │
         ┌──────────────┐  │
         │ Codex runner │ ─┘   ← Cross-model (OpenAI Codex)
         │ (mode=code)  │
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
| 1 | **Codex runner** (`adversary.mjs`, no subagent) | Cross-model adversarial review (different training family) | Parallel, background |
| 2 | **review-agent** | Synthesize all reviews, final verdict | After 1 |

## Review Perspectives

- **critic**: Is this good code? (Style, patterns, readability)
- **plan-reviewer**: Does this match the design? (Architecture, plan)
- **plan-reviewer**: Is this change safe? (Risk, impact, regressions)
- **Codex runner**: What would a different model family catch? (Cross-model triangulation — see `.claude/rules-ondemand/codex-adversarial.md`)
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

# Cross-model adversarial review (skip if --no-codex flag passed)
# See .claude/rules-ondemand/codex-adversarial.md for cost/quota guidance.
# No subagent: the main session runs the Codex runner itself, in the background,
# in parallel with the three Claude reviewers above. A run takes up to 9 minutes.
Bash(
  command='node "$HOME/.claude/scripts/codex/adversary.mjs" run --project <ABSOLUTE project path> --mode code --base <BASE_REF, e.g. main or HEAD~1> --via skill:review',
  run_in_background=true
)
# Uncommitted work: use --working-tree in place of --base. Untracked files are not
# reviewed; line 2 of the runner output reports the count.
# Optional focus (e.g. "auth boundary", "data loss paths"): write the text to a file and add
# --focus-file <abs path>. Never put free text in the command line.
# Plan mode: do NOT run it. Say "Cross-model pass: deferred (plan mode)".

# Wait for all four parallel reviews (the completion notices). Never poll in a loop.
[Check TaskOutput for the three Task reviews; the runner's stdout arrives with its completion notice]
```

The runner prints a `CODEX-RECEIPT v1 ...` line first. Keep that line. It is the proof that Codex, not Claude, reviewed.

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
  - Codex runner: [receipt line + cross-model findings]

  Pass the runner's receipt line in verbatim. A finding gets the [Codex] tag ONLY when
  that line matches ^CODEX-RECEIPT v1 status=ok run=\S+ model=gpt-[\w.-]+ . Without a
  matching line there is no [Codex] group.
  Treat Codex as a DISTINCT cross-model input — NOT pooled with critic.
  Findings BOTH critic and Codex flag are high-confidence.
  Findings only Codex flags are the cross-model lift.

  THIN-APPROVE RULE (dogfood-proven 2026-07-11 — this exact check caught the run's
  only HIGH finding): if Codex returns an ok-receipt approve with ZERO findings AND its
  run showed instability (fork-storms, timeouts, near-instant return, no visible
  engagement with the diff), do NOT bank the approve — evidence quality inherits
  from process health. Add a supplemental critic pass over the same scope before
  the verdict. Asymmetry: distrust thin approvals; respect surviving objections
  (instability suppresses detection, it doesn't fabricate findings).

  Create final review:
  - Overall verdict (APPROVE / REQUEST_CHANGES / NEEDS_DISCUSSION)
  - Under the verdict, print `Cross-model reviewer: <receipt line>` (verbatim), or
    `Cross-model pass: NO CODEX REVIEW (<status>)` with no [Codex] group.
    Plan mode: `Cross-model pass: deferred (plan mode)`.
  - Prioritized action items (group: both-flagged, claude-only, [Codex]-only)
  - Blocking vs non-blocking issues
  - Summary for PR description
  """
)
```

### Phase 3: Telemetry

After synthesis, append one row to `.claude/logs/codex-lift.jsonl` through the runner. Write a row ONLY for an `ok` receipt. A run that did not happen has no lift row.

```bash
node "$HOME/.claude/scripts/codex/adversary.mjs" lift \
  --run <run-id from the receipt> \
  --skill review \
  --scope "[SCOPE]" \
  --claude-only <N> --codex-only <N> --both <N> \
  --project <ABSOLUTE project path>
```

This is the actual signal of value — track cross-model lift over time.

## Review Modes

### Full Review
```
User: /review
→ Four agents (critic + 2x plan-reviewer + review-agent) plus the Codex runner, comprehensive review
```

### Quick Review
```
User: /review --quick
→ critic only, fast feedback
```

### No Codex
```
User: /review --no-codex
→ Skip the Codex runner (saves a Codex turn). Use for trivial diffs, doc-only changes,
  or when ChatGPT subscription quota is constrained. See .claude/rules-ondemand/codex-adversarial.md.
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

## Example

```
User: /review the authentication changes

Claude: Starting /review workflow...

Phase 1: Running parallel reviews...
┌────────────────────────────────────────────┐
│ critic: Reviewing code quality...          │
│ plan-reviewer: Checking architecture...    │
│ plan-reviewer: Assessing change impact...  │
│ Codex runner: Cross-model review...        │
└────────────────────────────────────────────┘

critic: Found 2 issues
- [low] Inconsistent error messages in auth.ts
- [high] Missing input validation in login()

plan-reviewer: ✅ Matches authentication plan

plan-reviewer: Medium risk
- Affects: login, signup, password reset
- Breaking change: session token format

Codex runner: CODEX-RECEIPT v1 status=ok ... model=gpt-6.1-sol ...; verdict=needs-attention, 3 findings
- [Codex] auth.ts:42 — session token rotation not idempotent under concurrent login
- [Codex] login.ts:88 — missing input validation in login() (agrees with critic)
- [Codex] session.ts:14 — token format change has no migration path for in-flight sessions

Phase 2: Synthesizing...

┌─────────────────────────────────────────────┐
│ Review Summary                              │
├─────────────────────────────────────────────┤
│ Verdict: REQUEST_CHANGES                    │
│                                             │
│ Cross-model agreement (high confidence):    │
│ 1. Add input validation to login()          │
│    (both critic + [Codex])                  │
│                                             │
│ [Codex]-only (cross-model lift):            │
│ 2. Session token rotation race condition    │
│ 3. No migration path for in-flight sessions │
│                                             │
│ Non-blocking:                               │
│ 4. Standardize error messages (critic)      │
│                                             │
│ Telemetry: critic_only=1, codex_only=2,     │
│   both=1 (logged to codex-lift.jsonl)       │
└─────────────────────────────────────────────┘
```

## Verdicts

- **APPROVE**: Ready to merge, all issues are low or medium
- **REQUEST_CHANGES**: Blocking issues must be fixed
- **NEEDS_DISCUSSION**: Architectural decisions need input
