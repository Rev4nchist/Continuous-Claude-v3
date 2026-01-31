# Workflows Subsystem

## Workflow Types

```
┌─────────────────────────────────────────────────────────────┐
│                    WORKFLOWS                                │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  /ralph    - Full product: PRD → Design → Architecture     │
│  /maestro  - Coordinate multiple specialists               │
│  /fix      - Debug → Implement → Test                      │
│  /build    - Plan → Implement → Review                     │
│  /explore  - Codebase research at varying depths           │
│  /review   - Parallel specialized reviews                  │
│  /release  - Audit → Test → Changelog                      │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## /ralph Workflow

Full autonomous development from idea to implementation.

```
brainstorm → validate → refine → prd → design → architecture
     │          │         │       │       │          │
     ▼          ▼         ▼       ▼       ▼          ▼
  Generate   Score     Loop    Create  Create    Build
  ideas      PMF       until   PRD     design    plan
             dims      9.5+    doc     spec
```

**Stages:**
1. `idearalph_brainstorm` - Generate startup ideas
2. `idearalph_validate` - Score on 10 PMF dimensions
3. `idearalph_refine` - Iterate until score ≥9.5
4. `idearalph_prd` - Generate Product Requirements
5. `idearalph_design` - UI/UX specifications
6. `idearalph_architecture` - Implementation plan

**Usage:** `/ralph "build a task management app"`

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
Investigate ──→ Implement ──→ Test ──→ Commit
     │              │           │         │
     ▼              ▼           ▼         ▼
debug-agent      spark      arbiter    /commit
  (find root     (apply     (verify    (if asked)
   cause)         fix)       fix)
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
       │
       ├── critic (feature review)
       ├── judge (refactor review)
       ├── liaison (API review)
       └── surveyor (migration review)
       │
       ▼
   Synthesize findings
```

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
| Full product build | /ralph |
