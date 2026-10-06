# Workflows Subsystem

## Workflow Types

```
┌─────────────────────────────────────────────────────────────┐
│                    WORKFLOWS                                │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  /maestro  - Coordinate multiple specialists               │
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
Plan ──→ Imagine failure modes ──→ codex-adversary ──→ Folded mitigations
 │            (inline)              (cross-model pass)        │
 ▼                                                            ▼
ExitPlanMode                                          Hardened plan
```

- Identifies "tigers" (likely failures) and "elephants" (unspoken risks).
- The codex-adversary pass (OpenAI `codex exec`) adds cross-model triangulation —
  findings only one model catches are the cross-model lift.
- Skip the Codex pass with `--no-codex` for doc-only or trivial diffs.

**Usage:** `/premortem` (or auto-offered after a plan is approved)

## /maestro Workflow

Versatile orchestrator for complex multi-step tasks.

```
Analyze Request
      │
      ▼
Spawn Specialists (parallel where possible)
      │
      ├── scout (if research needed)
      ├── oracle (if external docs needed)
      ├── kraken (if implementation needed)
      └── arbiter (if testing needed)
      │
      ▼
Synthesize Results
```

**Usage:** `/maestro "research auth patterns and implement OAuth"`

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
       └── codex-adversary (cross-model pass, OpenAI codex exec)
       │
       ▼
   review-agent synthesizes findings
```

**Cross-model lift:** `codex-adversary` runs in parallel with critic and
plan-reviewer. Because Codex is a different model family, it catches blind spots
the Claude-family reviewers share. Findings flagged by BOTH are high-confidence;
`[Codex]`-only findings are the cross-model lift. Skip with `--no-codex` for
doc-only or trivial diffs. See `.claude/rules-ondemand/codex-adversarial.md`.

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
| Need coordination | /maestro |
| Stress-test a plan before building | /premortem |
