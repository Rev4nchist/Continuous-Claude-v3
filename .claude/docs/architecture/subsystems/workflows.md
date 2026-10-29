# Workflows Subsystem

## Workflow Types

```
┌─────────────────────────────────────────────────────────────┐
│                    WORKFLOWS                                │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  /fix      - Reproduce → Investigate → Fix → Re-run repro  │
│  /build    - Plan → Implement → Review                     │
│  /explore  - Codebase research at varying depths           │
│  /premortem- Adversarial failure-mode analysis of a plan   │
│  /review   - Parallel specialized reviews                  │
│  /release  - Audit → Test → Changelog                      │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## /premortem Workflow

First-class adversarial failure-mode analysis of an approved plan. Auto-offered
by the `plan-exit-premortem-prompt` hook after every `ExitPlanMode`.

```
Plan ──→ Imagine failure modes ──→ optional Grok pass ──→ Folded mitigations
 │            (inline)              (cross-model)             │
 ▼                                                            ▼
ExitPlanMode                                          Hardened plan
```

- Identifies "tigers" (likely failures) and "elephants" (unspoken risks).
- An optional Grok pass adds a different training family. Findings only one model catches are the cross-model lift.
- Skip Grok for doc-only or trivial diffs. There is no second CLI reviewer.

**Usage:** `/premortem` (or auto-offered after a plan is approved)

## /fix Workflow

Bug investigation and resolution.

```
Reproduce ──→ Investigate ──→ Implement ──→ Re-run repro ──→ Commit
    │              │              │               │            │
    ▼              ▼              ▼               ▼            ▼
 real surface    sleuth      spark / kraken   same command   /commit
 (failing out)  (root cause)  (apply fix)    (must pass)  (after Dave
                                                            confirms)
```

**Usage:** `/fix "login button not responding"`

## /build Workflow

Feature development with planning.

```
Plan ──→ Implement ──→ Review ──→ Test
  │          │           │         │
  ▼          ▼           ▼         ▼
architect  kraken      critic    arbiter
```

**Usage:** `/build "add dark mode toggle"`

## /explore Workflow

Codebase exploration with depth control.

```
/explore quick      - Surface scan, file structure
/explore medium     - Key patterns, main flows
/explore deep       - Full analysis, relationships
/explore "<query>"  - Targeted search
```

**Usage:** `/explore "how does auth work"`

## /review Workflow

Comprehensive code review via parallel specialists.

```
┌─────────────┐
│   /review   │
└──────┬──────┘
       │   Phase 1 (parallel reviewers)
       ├── critic (code review)
       ├── plan-reviewer (plan / change review)
       └── grok-adversary (optional cross-model pass)
       │
       ▼
   review-agent synthesizes findings
```

**Cross-model lift:** `/review` runs critic and plan-reviewer. An optional Grok
pass is `grok-adversary`. The other CLI reviewer was removed. Do not call it.

## /release Workflow

Release preparation and validation.

```
Security Audit ──→ E2E Tests ──→ Review ──→ Changelog
       │              │            │           │
       ▼              ▼            ▼           ▼
     aegis          atlas       critic      herald
```

## Creating Custom Workflows

Skills in `~/.claude/skills/` can compose workflows:

```yaml
# ~/.claude/skills/my-workflow/SKILL.md
1. Detect trigger
2. Spawn agents in sequence/parallel
3. Synthesize results
4. Present to user
```

## Workflow vs Direct Agent

| Situation | Use |
|-----------|-----|
| Single focused task | Direct agent |
| Multi-step with dependencies | Workflow |
| Need coordination | Workflow tool |
| Stress-test a plan before building | /premortem |
