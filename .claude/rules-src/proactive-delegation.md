# Proactive Agent Delegation

Keep main context clean by delegating to agents. Don't wait to be asked.

## Pattern Detection

When user message arrives, detect:

| Pattern | Signal | Action |
|---------|--------|--------|
| Multiple tasks | "X and Y", "also", comma-separated | Suggest parallel agents |
| Research needed | "how does", "what is", "find" | Spawn scout/oracle |
| Implementation | "add", "implement", "create" | Route to /build workflow |
| Bug/issue | "fix", "broken", "failing", "debug" | Route to /fix workflow |
| Exploration | "understand", "explore", "how does X work" | Route to /explore |
| Mechanical multi-file fix | Same edit pattern across N files | Spawn N parallel sparks (1 file each), NOT one spark for N files |

## Workflow Suggestions

Detect and suggest appropriate workflows:

```
User: "Fix the auth bug and add tests"

Claude: "I detect a /fix workflow with 2 tasks:
  1. debug-agent → investigate
  2. spark → implement fix
  3. arbiter → add tests

  Proceed?"
```

## Main Context = Coordination Only

**Delegate to agents:**
- Reading 3+ files → scout
- External research → oracle
- Implementation → kraken/spark
- Running tests → validator/arbiter
- Debugging → debug-agent/sleuth

**Keep in main context:**
- Understanding user intent
- Workflow selection
- Agent coordination
- Presenting summaries

## Parallel Detection

When tasks are independent, spawn agents in parallel:

```
User: "Research auth patterns and check performance"

→ Detect: 2 independent tasks
→ Spawn: oracle + profiler (parallel)
→ Synthesize results
```

## Workflow Chaining

After completing a workflow, suggest the natural next step:

| After | Suggest |
|-------|---------|
| /explore | "Ready for /build brownfield?" |
| /plan | "Run /premortem before implementing?" |
| /fix | "Create /commit for the fix?" |
| Research complete | "Create plan from findings?" |

## Memory Check

Before research tasks, check for prior work:

```bash
# Quick memory check
(cd $CLAUDE_OPC_DIR && uv run python scripts/core/recall_learnings.py --query "<topic>" --k 3 --text-only)
```

If relevant memory found: "I researched this on [date] - reuse or refresh?"

## Don't Over-Delegate

Keep in main context when:
- Single simple question (just answer it)
- Quick file lookup (1-2 files)
- User explicitly wants direct response
- Latency matters more than context preservation

## Spark Scope Limits

**Spark works well for:**
- Single-file mechanical edits with known `old_string` / `new_string`
- Doc/script files (no TS, no LSP, no surrounding regenerable context)
- Isolated tasks with no session-thread collision risk

**Spark struggles with:**
- Multi-file iteration loops on TypeScript hook files (whole-file rewrite tempting → drops sibling emits)
- Session-thread carryover (a prior spark's edits become part of the next spark's "context" via re-read)
- Tasks where the same one-line change needs to be applied to N>1 files

**Rule:** If N files need identical mechanical change, spawn N sparks IN PARALLEL (one file each), not one spark for N files. The parallel pattern uses isolated context windows per spark, which is the whole point.

## Post-Spark Verification (Hook Edits)

When spark completes work touching `.claude/hooks/src/*.ts`, the orchestrator MUST independently re-run the emit-invariant guard before trusting completion:

```bash
bash scripts/audit-braintrust-emits.sh
```

Do not rely on spark's self-reported `Audit: PASS` alone — spark may have run the audit before its last edit. A second run from the orchestrator after spark exits catches late regressions.

**If the orchestrator's re-run FAILS after spark reported complete:**

1. `git diff HEAD -- <spark's edited files>` — confirm the regression is a pure deletion (spark dropped sibling content) and not an intentional restructure.
2. `git checkout HEAD -- <spark's edited files>` — restore the file to HEAD. Do this BEFORE attempting any new edit; otherwise the regression will appear in the next spark's context window.
3. Do NOT re-spawn the same spark for the same task. Spark's context window has the regression baked in; the next attempt will likely reintroduce it. Escalate to kraken (or do the fix directly in the orchestrator if it's a one-line patch).
4. Append the incident to `docs/spark-agent-issues-2026-05-23.md` (or a follow-up `spark-agent-issues-YYYY-MM-DD.md`) with: the failing edit diff, the spark's task ID, what regression slipped, and what recovery path was taken.

This is the missing exit ramp — without it, the orchestrator can loop on the same regression by re-prompting the same spark.

## Multi-Agent Orchestration (kraken/Ralph waves)

Hard-won from the PR #14 build (a registry + 6-pipeline feature built by ~8 sequential kraken waves, 2026-07-06):

### Serialize commits to the SAME repo — parallelize only on disjoint surfaces

When multiple agents (kraken/spark) both **edit and commit to the same repo**, run them **SEQUENTIALLY** — one wave completes and commits before the next starts. Two agents committing to one repo at once race on `.git/index.lock` (a stale `index.lock` from a killed op already blocked a commit once this session). Parallelize agents ONLY when they:
- work on **disjoint files AND don't commit** (orchestrator commits after), or
- use **`isolation: "worktree"`** (each gets its own working tree + index), or
- operate on **separate repos** (e.g. one on `continuous-claude`, one on the decks repo — safe to run concurrently).

Batch related work into one agent when files overlap (e.g. the `#5 NTN_EXE` de-dup touched a file the Phase-3 agent also edited → gate the second wave behind the first).

### Externally verify every agent — NEVER trust `ralph_status` alone [C:9]

After an agent reports `{"ralph_status": {"status": "complete"}}`, the orchestrator **independently re-checks against REAL state** before marking done:
- **`git show <commit> --stat`** — the claimed files/commit actually landed.
- **Re-run the test suite yourself** — agents can run the audit *before* their last edit, or over-report ("5 passed" when the summary line said `tests 1`). Use the exact reporter (`--test-reporter=spec` when the top-line count looks wrong).
- **Query the real external system** — the actual Notion DB row count, the live page, the DB state — not the agent's narration. (Kraken correctly *declined* a live mutating smoke per the confirm-first rule; the orchestrator ran it + cleaned up.)
- **Confirm no leftover test data** — an agent's real-API smoke must return the surface to baseline (e.g. DB back to its backfilled row count, temp rows trashed).

A timed-out agent/command (exit 143) is **not** proof of failure — verify state (see `windows-platform.md`). The orchestrator's job is coordination + independent verification; the agents do the work.
