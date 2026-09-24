# Continuity Flow

Cross-session state transfer and recovery mechanisms.

```mermaid
flowchart LR
    subgraph SessionN["Session N (Work)"]
        W[Work in progress]
        W --> LED[Continuity Ledger<br/>thoughts/ledgers/]
        W --> HO[Handoff Document<br/>thoughts/shared/handoffs/]
        W --> MEM[Memory Extraction<br/>3 automatic layers]
        W --> RM[ROADMAP Update<br/>4 auto-sync hooks]
        W --> KT[Knowledge Tree<br/>.claude/knowledge-tree.json]
    end

    subgraph Transfer["Persistent Storage"]
        LED --> FS[(Filesystem<br/>Markdown + YAML)]
        HO --> FS
        MEM --> DB[(PostgreSQL<br/>archival_memory)]
        RM --> FS
        KT --> FS
    end

    subgraph SessionN1["Session N+1 (Recovery)"]
        FS --> R1[Load continuity ledger<br/>session-start-continuity]
        DB --> R2[Recall relevant memories<br/>memory-awareness hook]
        FS --> R3[Resume Maestro state<br/>session-start-recovery]
        FS --> R4[Load knowledge tree<br/>session-start-init-check]
        FS --> R5[Load ROADMAP context<br/>roadmap-reconcile hook]
        R1 --> READY[Session ready<br/>with full context]
        R2 --> READY
        R3 --> READY
        R4 --> READY
        R5 --> READY
    end
```

## State Artifacts

| Artifact | Location | Created By | Loaded By |
|----------|----------|-----------|-----------|
| Continuity Ledger | `thoughts/ledgers/CONTINUITY_*.md` | Manual or pre-compact hook | session-start-continuity |
| Handoff Document | `thoughts/shared/handoffs/*/current.yaml` | `/create_handoff` skill | `/resume_handoff` skill |
| Memory Learnings | PostgreSQL `archival_memory` table | 3 extraction layers + manual | memory-awareness hook |
| ROADMAP | `ROADMAP.md` | 4 auto-sync hooks | roadmap-reconcile hook |
| Knowledge Tree | `.claude/knowledge-tree.json` | knowledge_tree.py + hooks | session-start-init-check |

## ROADMAP Auto-Sync (4 Hooks)

| Hook | Event | Action |
|------|-------|--------|
| roadmap-reconcile | UserPromptSubmit | Inject current ROADMAP context |
| roadmap-auto-update | PostToolUse | Update after plan/commit actions |
| roadmap-plan-sync | PostToolUse | Sync plan decisions to ROADMAP |
| roadmap-commit-sync | PostToolUse | Sync commit outcomes to ROADMAP |

## Handoff Outcomes

Every handoff requires an outcome marker:

| Outcome | Meaning |
|---------|---------|
| `SUCCEEDED` | All goals met |
| `PARTIAL_PLUS` | Most goals met, minor items remain |
| `PARTIAL_MINUS` | Some goals met, significant work remains |
| `FAILED` | Goals not met, blockers documented |

Last verified: 2026-02-20
