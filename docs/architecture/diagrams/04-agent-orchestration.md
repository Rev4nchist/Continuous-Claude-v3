# Agent Orchestration

Delegation patterns, agent categories, and retry escalation.

```mermaid
flowchart TD
    subgraph Modes["2 Delegation Modes"]
        D[Direct Delegation<br/>Claude spawns agent directly]
        M[Maestro Mode<br/>Multi-step orchestration]
    end

    subgraph Categories["Agent Categories (31 total)"]
        RES[Research<br/>scout, oracle, pathfinder<br/>session-analyst, braintrust-analyst]
        IMP[Implementation<br/>kraken, spark<br/>architect, phoenix]
        TST[Testing<br/>arbiter, atlas<br/>validate-agent]
        REV[Review<br/>critic, judge, liaison<br/>review-agent, plan-reviewer<br/>react-perf, ui-compliance, surveyor]
        DBG[Debug<br/>debug-agent, sleuth<br/>profiler]
        ORC[Orchestration<br/>maestro, plan-agent<br/>onboard]
        DOC[Documentation<br/>scribe, herald<br/>memory-extractor]
        SEC[Specialized<br/>aegis, agentica-agent]
    end

    D --> RES
    D --> IMP
    D --> DBG
    M --> RES
    M --> IMP
    M --> TST
    M --> REV

    subgraph Retry["Retry Escalation"]
        A1[Attempt 1: Same agent] --> A2[Attempt 2: Same + error context]
        A2 --> A3[Attempt 3: Escalate to spark]
        A3 --> A4[Attempt 4: Escalate to debug-agent]
        A4 --> BLK[BLOCKED: User intervention]
    end

    IMP --> Retry
```

## Delegation Modes

| Mode | Trigger | Human-in-Loop | Bounded? |
|------|---------|--------------|----------|
| **Direct** | Claude routes task to agent | Per-task approval | No |
| **Maestro** | `/maestro` command | Interview + phase gates | Phase-level |

## Agent Selection Guide

| Task | Primary Agent | Fallback |
|------|--------------|----------|
| Codebase exploration | scout | oracle |
| External research | oracle | pathfinder |
| Feature implementation | kraken (complex) | spark (simple) |
| Bug investigation | sleuth | debug-agent |
| Test execution | arbiter (unit) | atlas (E2E) |
| Code review | critic | principal-reviewer |
| Refactoring | phoenix (plan) | kraken (execute) |
| Documentation | scribe | herald (releases) |
| Security audit | aegis | - |

## Retry Escalation Chain

```
Attempt 1: Same agent, original instruction
Attempt 2: Same agent, error context added
Attempt 3: spark (quick fix specialist)
Attempt 4: debug-agent (root cause analysis)
Attempt 5: BLOCKED -- requires user intervention
```

Last verified: 2026-02-20
