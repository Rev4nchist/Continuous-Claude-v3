# Ralph Autonomous Development System Audit & Hardening Plan

**Branch:** `ralph-improvements`
**Goal:** Harden Ralph to reliably execute PRD → Task List → Dev Cycle with NO human guidance
**Created:** 2026-02-04

---

## PREREQUISITE: No Active Ralph Workflow

**BEFORE implementing any changes:**

```bash
# Check for active Ralph sessions
docker exec continuous-claude-postgres psql -U claude -d continuous_claude -c \
  "SELECT id, project, working_on FROM sessions WHERE last_heartbeat > NOW() - INTERVAL '10 minutes';"
```

If a Ralph workflow is in progress, **WAIT** for it to complete or cancel before modifying hooks/settings. Changing hooks mid-workflow could break the active session.

---

## Executive Summary

Ralph is an autonomous multi-agent development orchestrator. The audit identified **4 critical** and **3 high-priority** issues that prevent reliable long-running autonomous execution. This plan provides a phased fix approach with verification at each step.

---

## Audit Findings

### CRITICAL Issues (Must Fix)

| # | Issue | Impact | Location |
|---|-------|--------|----------|
| C1 | **2 hooks not registered** | Signal detection disabled entirely | `settings.json` missing ralph-monitor.mjs, ralph-template-inject.mjs |
| C2 | **No crash recovery** | Progress lost on any failure | State exists but no resume mechanism |
| C3 | **State deleted on SessionEnd** | Recovery impossible | `maestro-cleanup.ts:26-37` unconditionally deletes |
| C4 | **Race conditions** | State corruption in multi-terminal | No file locking on state writes |

### HIGH Priority Issues

| # | Issue | Impact | Location |
|---|-------|--------|----------|
| H1 | No error logging | Debugging impossible | All hooks fail silently |
| H2 | No state validation | Corrupted state = silent failures | JSON.parse without schema check |
| H3 | Non-atomic writes | Crash during write = corruption | Direct writeFileSync |

### MEDIUM Priority (Future)

| # | Issue | Notes |
|---|-------|-------|
| M1 | No cost tracking | Runaway API costs possible |
| M2 | No watchdog/timeout | Hung agents never escalate |
| M3 | Signal pattern fragile | String matching for `<TASK_COMPLETE/>` |

---

## Implementation Plan

### Recommended Order
```
Phase 1 (Logging) → Phase 2 (Register Hooks) → Phase 3 (Atomic Writes)
→ Phase 4 (State Validation) → Phase 5 (Crash Recovery)
→ Phase 6 (Watchdog) → Phase 7 (Usage Tracking)
```

Start with logging so all subsequent phases have error visibility.

---

### Phase 1: Add Error Logging [HIGH - Do First]

**Files:**
- CREATE: `.claude/hooks/src/shared/logger.ts`
- MODIFY: All hooks to import and use logger

**Purpose:** Enable debugging for all subsequent work

**Verification:**
```bash
# After implementation:
echo '{"invalid":}' | node .claude/hooks/dist/ralph-delegation-enforcer.mjs
cat ~/.claude/logs/hooks.log | tail -5
# Should show error with timestamp, hook name, session ID
```

---

### Phase 2: Register Missing Hooks [CRITICAL]

**Files:**
- MODIFY: `.claude/settings.json`

**Changes:**
```json
// Add to PostToolUse section (after line 288):
{
  "matcher": "Bash",
  "hooks": [
    {
      "type": "command",
      "command": "node C:/Users/david.hayes/.claude/hooks/dist/ralph-monitor.mjs",
      "timeout": 5000
    }
  ]
}

// Add to PreToolUse:Task section (before maestro-enforcer, line 50):
{
  "type": "command",
  "command": "node C:/Users/david.hayes/.claude/hooks/dist/ralph-template-inject.mjs",
  "timeout": 5000
}
```

**Verification:**
```bash
# Test signal detection
echo '{"event":"PostToolUse","tool_name":"Bash","tool_result":{"stdout":"<TASK_COMPLETE/>"}}' | node .claude/hooks/dist/ralph-monitor.mjs
# Should output signal detection message
```

---

### Phase 3: Add Atomic Writes with Locking [HIGH]

**Files:**
- CREATE: `.claude/hooks/src/shared/atomic-write.ts`
- MODIFY: `session-isolation.ts`, all state-writing hooks

**Key functions:**
- `atomicWriteSync(path, content)` - Write temp, then rename
- `acquireLock(path, timeout)` - O_EXCL lock with stale detection
- `writeStateWithLock(path, content)` - Combined atomic + locked write

**Verification:**
```bash
# Test concurrent writes don't corrupt
node -e "
const { writeStateWithLock } = require('./dist/shared/atomic-write.mjs');
Promise.all([
  writeStateWithLock('/tmp/test.json', '{\"a\":1}'),
  writeStateWithLock('/tmp/test.json', '{\"b\":2}')
]).then(() => console.log('Both completed without error'));
"
```

---

### Phase 4: Add State Schema Validation [HIGH]

**Files:**
- CREATE: `.claude/hooks/src/shared/state-schema.ts`
- MODIFY: All hooks that read state

**Schemas to validate:**
```typescript
interface RalphState {
  active: boolean;      // required
  storyId: string;      // required
  activatedAt: number;  // required
  lastActivity?: number;
  sessionId?: string;
}

interface MaestroState {
  active: boolean;
  taskType: 'implementation' | 'research' | 'unknown';
  reconComplete: boolean;
  interviewComplete: boolean;
  planApproved: boolean;
  activatedAt: number;
}
```

**Behavior:** Invalid state → log warning → treat as no state (fail open)

---

### Phase 5: Crash Recovery [CRITICAL]

**Files:**
- MODIFY: `.claude/hooks/src/maestro-cleanup.ts`
- CREATE: `.claude/hooks/src/session-start-recovery.ts`

**Changes to maestro-cleanup.ts:**

Before deleting state:
1. Check if workflow was in-progress (not complete/failed)
2. If incomplete → archive to `~/.claude/recovery/`
3. Then delete from active location

**New hook session-start-recovery.ts:**
- Fires on SessionStart
- Checks `~/.claude/recovery/` for recent files
- If found → inject prompt: "Found incomplete Ralph workflow. Resume?"

**Verification:**
1. Start Ralph workflow
2. Kill session mid-task (Ctrl+C)
3. Start new session
4. Should see recovery prompt

---

### Phase 6: Watchdog/Timeout [MEDIUM]

**Files:**
- CREATE: `.claude/hooks/src/ralph-watchdog.ts`
- MODIFY: `settings.json` (add to UserPromptSubmit)

**Behavior:**
- Check `lastActivity` on each user prompt
- If active workflow + >30 minutes stale → warn user
- Suggest: resume, cancel, or check for blocked agents

---

### Phase 7: Usage Tracking via tldr-stats [LOW]

**Approach:** Integrate existing `/tldr-stats` skill rather than build new infrastructure.

**Files:**
- MODIFY: Ralph skill to call tldr-stats on workflow completion
- MODIFY: `.ralph/IMPLEMENTATION_PLAN.md` template to include usage section

**Behavior:**
- On workflow completion, run `python3 .claude/scripts/tldr_stats.py`
- Capture output and append to `.ralph/workflow-summary.md`
- No new infrastructure needed - reuses existing stats system

**Note:** User is on subscription plan, so this is for visibility only, not budget enforcement.

---

## Files to Modify Summary

| Phase | File | Action |
|-------|------|--------|
| 1 | `.claude/hooks/src/shared/logger.ts` | CREATE |
| 1 | All hooks | ADD logging |
| 2 | `.claude/settings.json` | MODIFY (add 2 registrations) |
| 3 | `.claude/hooks/src/shared/atomic-write.ts` | CREATE |
| 3 | `.claude/hooks/src/shared/session-isolation.ts` | MODIFY |
| 4 | `.claude/hooks/src/shared/state-schema.ts` | CREATE |
| 4 | State-reading hooks | MODIFY |
| 5 | `.claude/hooks/src/maestro-cleanup.ts` | MODIFY |
| 5 | `.claude/hooks/src/session-start-recovery.ts` | CREATE |
| 6 | `.claude/hooks/src/ralph-watchdog.ts` | CREATE |
| 6 | `.claude/settings.json` | MODIFY |
| 7 | Ralph skill completion flow | MODIFY (add tldr-stats call) |

---

## Testing Strategy

### After Each Phase
```bash
# Rebuild hooks
cd ~/continuous-claude/.claude/hooks && npm run build

# Test specific hook
node dist/<hook>.mjs < test-input.json
```

### Integration Test (After Phase 5)
1. Start `/ralph` workflow with simple task
2. Kill session after task 1 completes
3. Restart session → verify recovery prompt
4. Resume → verify continues from task 2

### Full E2E Test (After All Phases)
1. Create PRD with 5+ tasks
2. Let Ralph run autonomously
3. Verify: logging works, signals detected, no state corruption
4. Kill mid-way, restart, verify resume works

---

## Rollback Strategy

Each phase is independent:
- **Phase 1-4:** Remove new files, revert imports → hooks work as before
- **Phase 5:** Revert cleanup changes → state just deleted (current behavior)
- **Phase 6-7:** Remove registrations → warnings disabled

---

## Success Criteria

Ralph can autonomously:
- [ ] Execute 10+ task workflow without human intervention
- [ ] Survive session restart and resume correctly
- [ ] Handle multi-terminal without state corruption
- [ ] Log errors for post-mortem debugging
- [ ] Detect stuck workflows and warn user
