# Hook Lifecycle

Complete hook event flow showing the 7 lifecycle events in temporal order.

```mermaid
sequenceDiagram
    participant U as User
    participant S as SessionStart
    participant P as UserPromptSubmit
    participant Pre as PreToolUse
    participant Post as PostToolUse
    participant C as PreCompact
    participant E as SessionEnd

    Note over S: Session begins
    S->>S: session-start-continuity (load ledger)
    S->>S: session-register (register in DB)
    S->>S: session-start-recovery (resume Maestro)
    S->>S: session-start-init-check (knowledge tree)
    S->>S: smarter-everyday (inject learnings)

    Note over U,P: User types a prompt
    U->>P: Submit prompt
    P->>P: skill-activation-prompt (keyword + intent match)
    P->>P: skill-router.ts (graph: prereqs + co-activation)
    P->>P: memory-awareness (recall learnings)
    P->>P: roadmap-reconcile (sync ROADMAP)

    Note over Pre: Before tool executes
    Pre->>Pre: tldr-read-enforcer (token savings)
    Pre->>Pre: smart-search-router (route to AST)
    Pre->>Pre: maestro-enforcer (phase gate)
    Note right of Pre: Can BLOCK with deny

    Note over Post: After tool executes
    Post->>Post: post-edit-diagnostics (type check)
    Post->>Post: tree-invalidate (mark stale)
    Post->>Post: roadmap-auto-update (sync goals)

    Note over C: Context window filling up
    C->>C: pre-compact-continuity (save state)
    C->>C: pre-compact-extract (extract learnings)

    Note over E: Session ends
    E->>E: session-end-cleanup (cleanup)
    E->>E: session-outcome (mark outcome)
    E->>E: periodic-extract (extract learnings)
```

## Event Details

| Event | Timing | Can Block? | Key Hooks |
|-------|--------|-----------|-----------|
| **SessionStart** | Session opens | No | Load ledger, register DB, resume Maestro, init knowledge tree |
| **UserPromptSubmit** | Before processing prompt | No (inject only) | Suggest skills, recall memories, inject progress |
| **PreToolUse** | Before any tool call | **Yes (deny)** | Token savings, search routing, delegation enforcement |
| **PostToolUse** | After tool completes | No | Diagnostics, state tracking, tree invalidation |
| **PreCompact** | Context nearing limit | No | Save continuity state, extract learnings |
| **SubagentStop** | Agent task finishes | No | Save agent results to continuity |
| **SessionEnd** | Session closes | No | Cleanup, outcome marking, learning extraction |

## Blocking Hooks (PreToolUse)

These hooks can return `deny` to prevent a tool from executing:

| Hook | Blocks When |
|------|------------|
| maestro-enforcer | Phase-skipping in a Maestro workflow |
| tldr-read-enforcer | File read when TLDR summary available |
| smart-search-router | Grep when AST search is better |

Last verified: 2026-03-03
