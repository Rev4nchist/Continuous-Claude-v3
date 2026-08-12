# Hook Dispatcher Consolidation — Concurrency-Reduction Plan

**Status:** 2026-07-20 — **Phase 0 RESOLVED: Lever B (exec form) is available and is now the
primary fix.** Claude Code hooks support an "exec form" (`"command":"node","args":[...]`) that
runs the executable directly with NO shell — so it never spawns git-bash and the msys2 fork
storm cannot occur, regardless of hook count. Confirmed against the official hooks docs +
this repo's own `add_item`-on-`node`-commands evidence. **The dispatcher (Lever A, Phases 2–3
below) is DEMOTED to optional** (a latency / process-count nicety, not needed for stability).
Converter: scratchpad `hooks-to-execform.mjs` (backs up, `--restore` reverts). SessionStart
converted as the pilot (11/11); awaiting a fresh-session check that `add_item` is gone before
converting the 21 PreToolUse gates + the rest.
**Owner effort tasks:** Phase 0 (#7 ✅), exec-form rollout (#11), Phase 1 gating (#8, optional),
dispatcher (#9/#10, optional/deferred).

## Problem

Claude Code on Windows executes every hook `command` by wrapping it in a git-bash
subprocess (✓ verified: `SessionStart` hooks are `node`/`python` commands, yet the
startup errors are `bash.exe: *** fatal error - add_item`). The CCv3 config registers
**81 hooks**, and because most PreToolUse/PostToolUse hooks stack on the same tools,
a single tool call spawns a burst of concurrent `bash.exe` forks. msys2's `fork()` is
unreliable under that concurrency → `add_item` crashes (SessionStart) and hung hooks →
30s `UserPromptSubmit` phase timeouts with injected context discarded.

### Concurrent bash spawns per hot path (✓ verified from matcher config)

| Hot path | Frequency | Concurrent bash spawns |
|---|---|---|
| `Task` spawn | every subagent | ~16 (10 PreToolUse + 6 PostToolUse) |
| `Bash` call | every command | ~14 (3 pre + 11 post) |
| `Write`/`Edit` | every file write | ~11 (2 pre + 9 post) |
| every prompt | per prompt | 13 (all UserPromptSubmit) |
| startup | per session | 11 (all SessionStart) |

Total registered: PreToolUse 21, PostToolUse 27, UserPromptSubmit 13, SessionStart 11,
SessionEnd 6, PreCompact 2, PermissionRequest 1 = **81**.

## Two levers

### Lever B (verify first — may moot Lever A): drop the bash wrapper
If Claude Code can invoke hooks on Windows **without** a git-bash wrapper (direct
`node.exe`, cmd.exe, argv form, or a shell override), the fork storm disappears
regardless of hook count. **Phase 0** = `claude-code-guide` investigation into whether
this is user-controllable. If yes, it is the cheapest, highest-leverage fix and Lever A
becomes optional (still nice for latency, not required for stability).

### Lever A: one dispatcher per (event, matcher) group
Replace each event/matcher group's N registered commands with **one** registered
command — a dispatcher that runs its sub-hooks **in-process** (one node process,
`require()`s each sub-hook module, no per-hook bash fork). Effect:
- `Task` 16→1, `Bash` 14→2 (1 pre + 1 post), prompt 13→1, startup 11→1.
- 81 registered commands → ~9 dispatcher processes. ~10× fewer concurrent bash spawns.
- Survives even a corp-locked Defender (see EDR note below).

## Dispatcher contract (the hard part — fidelity)

Each sub-hook currently gets its own process with a stdin JSON payload and emits a
JSON result on stdout + an exit code. The dispatcher must preserve that faithfully:

1. **Input:** read the event payload once (stdin), pass the SAME object to each sub-hook.
2. **Isolation:** run each sub-hook in a `try/catch` with its own timeout (Promise.race).
   A sub-hook throwing/timing out must NOT kill siblings — **fail-open** (skip that
   hook's output), matching today's per-process isolation.
3. **Output merge semantics (event-specific):**
   - `additionalContext` (UserPromptSubmit / PostToolUse / SessionStart): **concatenate**
     all sub-hook contexts in a deterministic order.
   - `permissionDecision` (PreToolUse): **any `deny` wins**; else any `ask` wins; else
     `allow`. Preserve the deny `reason` from the denier. This is the highest-risk
     merge — a mis-merge could let a destructive command through.
4. **Ordering:** deterministic sub-hook order (config order) so behavior is reproducible.
5. **Matcher-awareness:** the dispatcher for `PreToolUse`/`PostToolUse` must run only the
   sub-hooks whose matcher matches the actual tool (the dispatcher owns the matching that
   settings.json currently does).

## Quick wins (Phase 1 — before the dispatcher, low risk)

- **Gate mode-specific hooks.** 5 of 13 UserPromptSubmit hooks are Ralph/Maestro-only
  (`ralph-watchdog`, `ralph-progress-inject`, `ralph-retry-reminder`,
  `maestro-state-manager`, `maestro-detector`) yet fire every prompt though both modes
  are usually off. Collapse to one `workflow-state` hook that early-exits when neither is
  active → 13→9. Same for the Ralph/Maestro entries on PreToolUse/PostToolUse.
- **Scope the per-`Bash` deploy-context hooks.** `vercel-deploy-context`,
  `sentry-deploy-release`, `linear-branch-context`, `architecture-stats-sync` fire on
  every Bash call — narrow their matchers or fold into one deploy-context hook.

## Phased plan

- **Phase 0** (#7): `claude-code-guide` — is Lever B available? Decides scope below.
- **Phase 1** (#8): quick-win gating (independent of Lever B; immediate relief).
- **Phase 2** (#9): build the dispatcher; pilot on `UserPromptSubmit` (13→1). Prove the
  contract (context concat, fail-open, timeout isolation) with regression tests.
- **Phase 3** (#10): extend to `PreToolUse`/`PostToolUse` (the per-tool-call storms —
  matcher-aware, permissionDecision merge), then `SessionStart` + the rest.

## Verification

- Measure concurrent bash-spawn count per hot path before/after (Process Monitor or a
  spawn counter) — target ~10× reduction.
- Regression: every consolidated hook's observable behavior preserved (esp. PreToolUse
  deny gates — destructive-command-guard, package-install-guard, plan-to-ralph-enforcer).
- Confirm the `add_item` spam and 30s UserPromptSubmit timeouts are gone in a fresh session.

## EDR / Defender note (why Lever A matters independently)

This is a Fourth-managed machine: `Get-MpComputerStatus` reports
`IsTamperProtected=True`, `AMRunningMode="EDR Block Mode"`. A local
`Add-MpPreference -ExclusionPath` reports "ADDED OK" but **EDR Block Mode enforces
centrally and Tamper Protection blocks local changes from sticking**, so the AV
exclusion likely will NOT take effect (needs verification / an IT request). The
dispatcher (Lever A) and Lever B are therefore the corp-independent fixes and should
not be blocked on the Defender path.
