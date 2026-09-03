---
name: codex
description: Hand a task to the OpenAI Codex harness (default gpt-5.6-luna @ max, on the ChatGPT subscription — no API key) to WORK THROUGH — answer it, or actually implement it with write access — not just review. Cross-model execution, complementary to Claude. Use when the user types /codex, says "hand this to Codex", "have Codex implement/do X", "delegate to Codex", "codex, work through this", or wants GPT-5.6 Luna to execute a well-specified task. For adversarial code/plan REVIEW use /review or /premortem (those already call Codex read-only); this skill is for getting work DONE.
---

# /codex — Delegate a task to the Codex harness (gpt-5.6-luna @ max)

Hands an arbitrary request to OpenAI Codex on Dave's **ChatGPT subscription** (never an API key) to work through it. A different training family (GPT-5.6 Luna) executing the task gives cross-model leverage — Theo's "let Codex do the well-spec'd execution, keep Claude for orchestration" pattern, realized in CCv3. The read-only `codex-adversary` reviewer is untouched; this is its write-capable sibling.

**Roster position (Game Plan):** Codex's primary roles are **reviewer and fixer** — deep review via `codex-adversary`, fix patches via `--implement` scoped to booth findings. For milestone *building*, **Grok is the default builder** (`/grok --implement`); Codex builds only as **failover** (Grok dead/quota-capped/hung) or when the human explicitly overrides with `--builder codex` for a specialized milestone. A failover-built milestone is then graded by Claude critics, never by Codex itself. Doctrine: `.workroom/PROTOCOL.md`.

**Safety contract:** `.claude/rules/codex-worker-safety.md` (confirm-first, sandbox-is-the-boundary, worktree isolation, review-gate). **Engine:** the `codex-worker` agent. **Cross-model review convention:** `.claude/rules/codex-adversarial.md`.

## When to Use

- `/codex <request>` — explicit invocation (primary path)
- "hand this to Codex", "have Codex implement …", "delegate this to Codex", "codex, work through …"
- You want GPT-5.6 Luna to actually DO a well-specified task — **fix patches, focused refactors, scripts, analysis**. For workroom milestone builds, default to `/grok --implement` (Grok is the rostered builder); reach for `/codex --implement` as failover or explicit `--builder codex` override
- NOT for code/plan review as a workflow → use `/review` / `/premortem` (they already run Codex read-only); `--review` below is the one-off alias

## Modes

| Mode | Invoke | Sandbox | Confirm? | Default effort | Writes land where |
|------|--------|---------|----------|----------------|-------------------|
| **ask** (default) | `/codex <question>` | `read-only` | no | max | nowhere (answer only) |
| **implement** | `/codex --implement <task>` | `workspace-write` | **yes** (unless `--yes`) | max | isolated git worktree → you review the diff → apply/discard |
| **resume** | `/codex --resume <followup>` | inherits | yes | inherits | same worktree/thread |
| **review** (alias) | `/codex --review [base]` | read-only | no | max | delegates to `codex-adversary` unchanged |

**Flags:** `--model gpt-5.6-luna|gpt-5.6-sol|gpt-5.6-terra|gpt-5.5|gpt-5.4|gpt-5.4-mini` (default `gpt-5.6-luna`; the current model cache fetched 2026-09-03 lists Luna with `max` support; any `-codex` or fabricated id is rejected — it 400s on the subscription). `--effort low|medium|high|xhigh|max|ultra` (`max` is the default for the default Luna profile; use a supported effort for an explicitly selected legacy model; `ultra` auto-delegates — unprobed, avoid unattended). `--yes` (skip the interactive confirm for orchestrator/Ralph use — still sandboxed, still logged, still produces a reviewable patch). `--complex` (multi_agent fan-out for genuinely BROAD ask/implement tasks — opt-in; requires `~/.codex/agents/explorer.toml` pinned to gpt-5.5 or it refuses; ~1,940 tok/call + fan-out latency; NOT re-applied on resume).

## Execution

### `ask` / `implement` / `resume` → spawn `codex-worker`

```
Task(
  subagent_type="codex-worker",
  prompt="""
  ## Mode
  ask | implement | resume

  ## Request
  [the user's task, verbatim + any clarifying context]

  ## Model
  gpt-5.6-luna

  ## Effort
  [max for the default gpt-5.6-luna profile; xhigh for ask or high for implement when an older model is explicitly selected — or the user's --effort]

  ## Autonomy
  confirm            # or "yes" if the user passed --yes

  ## Complex
  false              # or "true" if the user passed --complex (multi_agent fan-out; ask/implement only)

  ## Scope           # resume only — the Codex session id (UUID) from the implement run's summary
  <SESSION_ID>       # leave EMPTY to fall back to --last (do NOT pass the literal "last")

  ## Worktree        # resume only — the worktree path from the implement run's summary
  <path>

  ## Codebase
  $CLAUDE_PROJECT_DIR
  """
)
```

For **implement**, the worker will surface the exact command + target worktree and (unless `--yes`) wait for your explicit go-ahead, run Codex with `workspace-write` inside a throwaway worktree, independently `git diff` the result, and show you the patch before anything touches your live working tree. Present that diff to the user; on approval the worker applies it, otherwise it discards and removes the worktree. The worker also returns the Codex **session id** and **worktree path** — pass both back on a later `--resume` so it continues the exact thread (robust under concurrency, unlike `--last`).

### `--review` → delegate to the existing reviewer

```
Task(
  subagent_type="codex-adversary",
  prompt="""
  ## Mode
  code
  ## Scope
  base ref: [BASE_REF, default main]
  ## Codebase
  $CLAUDE_PROJECT_DIR
  """
)
```
`/codex --review` is a convenience alias so users have one mental entry point (`/codex`) — it reuses `codex-adversary`'s carefully-tuned read-only flags, it does NOT reimplement review.

## Guardrails (summary — full text in `.claude/rules/codex-worker-safety.md`)

- **Subscription only.** The worker asserts `codex login status` = "Logged in using ChatGPT" and strips `OPENAI_API_KEY`/`CODEX_API_KEY` from Codex's env. Fails loud, never silently uses an API key.
- **Confirm-first for `implement`/`resume`** (the only approval gate — `codex exec` has none). `--yes` skips only the interactive pause.
- **Worktree isolation by default** — write runs happen in a throwaway git worktree **outside** the repo (sibling `../.codex-worktrees/<repo>-<ts>-<pid>`), never in-place, so they can't collide with your live session or the `file_claims` DB. (An `--in-place` mode was considered and **dropped** in v2 — worktree isolation is the retained safety win.)
- **Auto worktree GC** — before each implement run, stale *clean* worktree dirs (~190MB each) older than `$CODEX_WT_GC_DAYS` (default 7d) are reclaimed; a worktree with unreviewed (dirty) changes is never touched, so a dormant awaiting-`resume` one is safe. Manual sweep: `scripts/codex/gc-worktrees.sh`.
- **Review-gate** — never auto-commits/auto-merges; produces a patch you approve first.
- **Model allowlist** — `gpt-5.6-sol/gpt-5.6-terra/gpt-5.6-luna/gpt-5.5/gpt-5.4/gpt-5.4-mini` only (live-probed 2026-07-11).
- **No hook can see inside Codex's sandbox** — enforcement is `--sandbox` + this preflight, not any Claude Code hook.
- **Usage-limit aware** — if the ChatGPT subscription quota is exhausted, `/codex` returns a clean "usage limit hit; resets ~<time>" message (never a fabricated result) and logs `usage_limited:true`. Detection is reactive — the subscription exposes no queryable quota surface to preflight.
- **`--complex` is gated** — multi_agent fan-out (ask/implement) runs only after asserting `~/.codex/agents/explorer.toml` pins the gpt-5.6-luna explorer profile (prevents the gpt-4.1 role-fallback 400); opt-in, never default, with a standing Windows re-probe caveat (openai/codex#19399). The primary `/codex` worker still defaults to gpt-5.6-luna @ max.

## Examples

```
User: /codex how does the report-registry upsert dedupe by Run ID?
→ ask mode, read-only. Returns GPT-5.6 Luna's answer sourced from the clean -o capture. No confirm, no writes.

User: /codex --implement add a --limit flag to scripts/report-registry/query.mjs
→ implement mode. Shows the codex exec command + worktree path, waits for your OK,
  runs Codex with workspace-write in an isolated worktree, shows you the diff,
  applies it to your working tree on approval. Logs a telemetry row.

User: /codex --implement --complex refactor the report-registry pipeline end-to-end
→ implement + multi_agent fan-out (explorer/worker sub-agents on gpt-5.6-luna). Asserts
  ~/.codex/agents/explorer.toml is pinned to gpt-5.6-luna first, prints the #19399 re-probe
  caveat, then the usual worktree + diff-review flow. For genuinely BROAD tasks; costs
  extra tokens + latency. Refuses if the explorer pin is missing.

User: /codex --resume also add a test for the new flag
→ continues the same Codex thread + worktree.

User: /codex --review main
→ runs the standard cross-model adversarial review (codex-adversary), read-only.
```

## Telemetry

One row per run → `.claude/logs/codex-worker.jsonl` (schema: `.claude/logs/codex-worker.README.md`). Distinct from `codex-lift.jsonl` (that logs review *lift* counts; this logs task *execution*).

---

<!-- archived-rule:codex-worker-safety.md ref:b800899 -->
## Reference: pre-split text of `rules/codex-worker-safety.md` (archived 2026-07-29)

The rule now carries only the invariants an agent must hold *before* deciding to use this
tool. The evidence trail, version pins, probe archaeology and long caveats live here, and
load only once this skill does. Verbatim snapshot, so nothing that was trimmed is lost:

```markdown
# Codex Worker Safety Rules

Companion to `.claude/skills/codex/SKILL.md` and the `codex-worker` agent. This is the **write-capable** sibling of `.claude/rules/codex-adversarial.md` (which stays read-only, review-only). Different safety posture → separate rule. The `/codex` skill hands a task to the OpenAI Codex harness (`gpt-5.5`) on Dave's **ChatGPT subscription** to actually execute — so it can write files and run commands. Treat every write mode with the same care as any destructive operation.

Grounding: verified 2026-07-06 against `codex-cli 0.131.0`, `Logged in using ChatGPT`; **re-verified 2026-07-11 against `codex-cli 0.144.1`** (upgrade + full §3 re-run: flags, workspace-write fixture, hooks-collision, resume/thread_id — all hold; rollback pin `npm i -g @openai/codex@0.131.0`). See `docs/codex-integration/DESIGN-RESEARCH.md` for the full evidence trail.

## The one thing to internalize

**`codex exec` has no approval dial, and no Claude Code hook can see inside Codex's sandboxed process.** The `codex exec …` command line itself passes through `destructive-command-guard` like any Bash call (and isn't itself a destructive pattern, so it's allowed), but everything Codex does *inside* its sandbox — every file write, every shell command — is invisible to Claude Code's hook layer. **The entire safety boundary is `--sandbox` + this rule's confirm-first preflight.** There is no second line of defense. Choose the sandbox deliberately and confirm write runs.

## Auth: subscription only (verify FIRST)

- The worker asserts `codex login status` reports **"Logged in using ChatGPT"** before any run. If not → STOP, tell the user to run `codex login`. **Never** fall back to an API-key path.
- Every `codex exec` is wrapped in `env -u OPENAI_API_KEY -u CODEX_API_KEY` — a repo-controlled or job-level env var must not silently switch auth to a paid API key.
- Never print `~/.codex/auth.json`, `OPENAI_API_KEY`, or `CODEX_API_KEY`.

## Confirm-first matrix

| Mode | Sandbox | Confirmation |
|------|---------|--------------|
| `ask` | `read-only` | **None** — read-only, matches the reviewer posture |
| `implement` | `workspace-write` | **Required every run** — show the exact `codex exec` command line, target worktree, model+effort; wait for explicit approval. `--yes` skips ONLY the interactive pause (for orchestrator/Ralph), never the sandbox, telemetry, or review step |
| `resume` | inherits the resumed session's sandbox (resume takes NO `--sandbox`/`-C` — `cd` into the worktree) | Required if resuming an `implement` thread |
| `danger-full-access` | none | **Not used by this agent.** If ever needed, confirm-first, never default, identical posture to `--dangerously-bypass-approvals-and-sandbox` |

## Write-mode hard rules (`implement` / `resume`)

1. **Worktree isolation is the default, and worktrees live OUTSIDE the repo.** Writes happen in `$(dirname "$PROJECT")/.codex-worktrees/<repo>-<ts>-<pid>` — a throwaway git worktree branched from HEAD, a SIBLING of the repo, **never inside `$PROJECT`** and never in-place against the live tree. This structurally prevents collision with the concurrent Claude Code session's edits and the `file_claims` DB. **Out-of-repo is mandatory (verified 2026-07-07 dogfood):** an in-repo worktree makes Claude Code re-scan the whole `.claude/skills` tree as ~150 duplicate path-scoped skills (context pollution) and is a ~190MB full checkout. The `-<pid>` suffix prevents same-second name collisions. (An `--in-place` mode was considered and **dropped** in v2 — worktree isolation is the retained safety win.)
2. **Git-clean note before creating a worktree.** A worktree branches from HEAD, not the working tree's uncommitted changes — if `git status --porcelain` is non-empty, warn the user that Codex won't see those pending edits.
3. **Independent verification, always.** After the run, the worker itself runs `git add -A && git diff --cached HEAD` in the worktree and shows that patch. Codex's own summary is never the sole evidence of what changed (RULES.md "External Verification").
4. **Review-gate — never auto-commit/auto-merge.** `implement` produces a patch the human reviews before it's applied to the working tree (`git apply --3way`). This is the strongest cross-source consensus in the research: it defends against prompt-injection via any content Codex reads (commit messages, issue text, fetched web content).
5. **Writable-root scoping.** `-C` is always the worktree path. `--add-dir` only for genuinely shared scratch space, never the live repo root, in v0/v1.
6. **Network stays off.** `workspace-write` keeps network access `false` by default. Enabling it requires an explicit flag + confirm (prompt-injection risk via fetched content).

## Worktree GC (v2) — reclaims only CLEAN abandoned worktrees

Before each `implement` run the worker opportunistically GCs stale worktree dirs in `../.codex-worktrees/` (each is a ~190MB checkout): `git worktree prune` + remove THIS repo's `<repo>-*` dirs older than `$CODEX_WT_GC_DAYS` (default **7**). **It skips any worktree with uncommitted changes** — `implement` only STAGES (never commits), so a dormant / awaiting-`resume` worktree holds UNREVIEWED work and is never reclaimed regardless of age (age alone is not a safety guarantee — a resume worktree can sit past a weekly quota cap). Reclaim is CONFIRMED-clean only: `git status --porcelain` must EXIT 0 AND be empty (a broken/unreadable worktree is KEPT, never mistaken for clean). Removal is ONLY via `git worktree remove --force` — there is **no `rm -rf`** anywhere in the auto path (that would route a recursive delete around the destructive-guard); an unregistered orphan is **reported, never auto-deleted**. The manual `scripts/codex/gc-worktrees.sh` follows the same rules (skips dirty/unreadable by default; `CODEX_WT_GC_FORCE_DIRTY=1` reclaims dirty *registered* worktrees; still no `rm -rf`). Race: the clean-check and remove aren't locked, but the age filter (a worktree you're resuming is recent, so never GC-eligible) makes the residual negligible.

## Model allowlist (enforced before shelling out)

Hard-reject any `--model` not in `{gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5, gpt-5.4, gpt-5.4-mini}` (5.6 family live-probed 2026-07-11 on 0.144.1, exit 0 each; ground truth `~/.codex/models_cache.json`), citing the verified evidence: `gpt-5.2-codex` and `gpt-5.5-codex` both return byte-identical HTTP 400 ("model is not supported when using Codex with a ChatGPT account") on this account, and `gpt-5.6-bogus` reproduced the same 400 on 0.144.1 (2026-07-11). Treat ANY future id as unverified-until-tested against this exact account via `/harness-update`, regardless of what the docs' model table says. Note: on 0.131.0 the 5.6 family returned a DIFFERENT 400 ("requires a newer version of Codex") — that message shape means upgrade-the-CLI, not model-unavailable.

## multi_agent

`--disable multi_agent` on every call by default. Global config has `[features] multi_agent = true`; leaving it on makes a complex task spawn built-in explorer/worker sub-agents that fall back to `gpt-4.1` (400 on subscription) and adds ~1,940 tokens/call even unused. The **`--complex` opt-in** (ask/implement; NOT resume) swaps in `--enable multi_agent`, but the agent HARD-REQUIRES `~/.codex/agents/explorer.toml` to pin `model = "gpt-5.6-luna"` FIRST — else it refuses (the pin mitigates the gpt-4.1 role-fallback 400; openai/codex #19399 / #16893). Standing caveat printed every `--complex` run: the pin was verified ONCE on Windows 2026-07-07 — **re-probe before trusting `--complex` unattended** (#19399: subagent TOML can be ignored on Windows). Confirm-gated like any write (implement already confirms); on read-only ask the explicit flag + printed caveat is the acknowledgment.

## Startup profile — `--ignore-user-config` is `ask`-ONLY (latency v1; write-bug v2)

The **`ask`** mode passes **`--ignore-user-config`** to skip loading Dave's interactive `~/.codex/config.toml` (~16 MCP servers whose network handshakes dominate cold-start), cutting a read-only smoke **~47s → ~18s** and removing the config-defined MCP connection-failure noise (verified 2026-07-07 v1 benchmark).

**`implement`/`resume` must NOT pass `--ignore-user-config`** (corrected 2026-07-07). A v2 dogfood + an independent A/B proved it **silently BREAKS workspace-write file creation on Windows**: `config.toml` carries the sandbox writable-root / approval policy, so stripping it makes Codex's sandbox reject the write (`exit 0`, **ZERO diff** — a silent no-op that looks like success). The v1 benchmark only exercised read-only `ask`, so this went unseen. Write modes take the slower cold-start in exchange for actually writing.

- **Auth is NOT affected.** `--ignore-user-config` still reads `CODEX_HOME`/`auth.json` (the flag's own doc guarantee; the benchmark ran rc=0 on the subscription). The model / `model_reasoning_effort` / `multi_agent=false` the worker needs are passed as explicit CLI flags regardless, so nothing worker-relevant is dropped.
- **Tradeoff to know:** Codex's shell also loses the base config's `shell_environment_policy.set` extras (e.g. `DATABASE_URL`, `CLAUDE_OPC_DIR`). Moot on Windows where `workspace-write` cannot spawn subprocesses anyway; if a specific task needs one, add `-c shell_environment_policy.set.KEY=VALUE` for that call.
- **Refuted alternative (do NOT use):** the design-doc §5.3 `--profile-v2 worker` + `~/.codex/worker.config.toml` overlay was **empirically refuted 2026-07-07** — overlay layering deep-merges, so an empty `[mcp_servers]` (or `-c mcp_servers={}`) does NOT remove the base MCP servers (MCP-fail count unchanged from baseline). No machine-local `worker.config.toml` is created; `--ignore-user-config` is self-contained and portable across machines.

## Windows / CLI hygiene

- **Always feed the prompt from a file** via `- < "$PROMPT_FILE"`, never an inherited TTY (hang bug openai/codex#20919). Same universal rule as `ntn` (`.claude/rules/notion-cli-safety.md`).
- **Rely on an external timeout** (the Bash-tool timeout or `timeout` wrapper), not Codex's own — documented Windows stall bugs (#18983, #20200) mean Codex doesn't reliably self-terminate a stuck run.
- **`-o <file>` is the mandatory clean-output contract** — it strips the ~100+ lines of startup noise (skill-YAML load errors, MCP auth failures, hook lines). Parse findings/answers from the `-o` file, fall back to the full log's post-`codex`-sentinel text only if `-o` is empty.
- **`workspace-write` sandbox blocks subprocess launches on Windows** (`CreateProcessAsUserW failed: 5`, verified 2026-07-07 dogfood). Codex can create/edit files but CANNOT run `git`/`node`/tests inside its own sandbox — it writes code BLIND and self-reports done without executing it. The orchestrator's out-of-sandbox verification is the ONLY verification, and it must actually **run** changed runnable code, not just `node --check` (syntax-check missed a real `spawnSync`-ENOENT bug in dogfooding). **`--sandbox read-only` blocks subprocess spawns too** (verified 2026-07-19): a codex-adversary review under read-only had EVERY spawn (`git`, `Get-Content`) denied the same way — not just writes. So a read-only reviewer must receive all needed context INLINE in the prompt and be told NOT to spawn tools, or it burns its whole budget on denied spawns and can fork-storm (see `.claude/agents/codex-adversary.md` Step 4 directive).
- **`codex exec resume` takes no `--sandbox`/`-C`** — it inherits the resumed session's cwd + sandbox; `--last` is cwd-scoped, so `cd` into the worktree, don't pass `-C`. Passing `--sandbox` errors RC=2. Prefer capturing + reusing the explicit Codex session id (v1) over cwd-scoped `--last`.

## Version drift

Installed CLI is `0.144.1` (upgraded from `0.131.0` on 2026-07-11 with full re-verification; rollback pin `npm i -g @openai/codex@0.131.0`). `exec --help` on 0.144.1 still shows NO `--full-auto`/`--ask-for-approval` — sandbox remains the only boundary. Code against the installed surface. Any CLI upgrade must go through `/harness-update` (re-runs the `docs/codex-integration/DESIGN-RESEARCH.md` §3 verification) before trusting new flags.

## Cost / quota (subscription, not dollars)

There is no per-call dollar price — the cost is ChatGPT-subscription quota (two clocks: a rolling 5-hour message window + a separate weekly cap; the 5h meter can look healthy while the weekly cap is exhausted). A multi-file `gpt-5.5` implement run can be a meaningful fraction of a Plus-tier weekly allowance, and a known unresolved regression (openai/codex#28879) inflates per-token cost for some accounts. The telemetry log records per-run usage so a weekly total can be reconstructed.

**Usage-limit handling (v2, reactive).** A quota **preflight** is impossible — `codex doctor --json` exposes no usage/quota surface (only `checks`/`codexVersion`/`generatedAt`/`overallStatus`/`schemaVersion`; verified 2026-07-07). Detection is **reactive**: the worker greps every run's log for `You've hit your usage limit … try again at <time>` (present in all modes — the `-o` clean file is EMPTY on a cap hit, and the run exits non-zero), returns a clean "usage limit hit; resets ~<time>" message instead of a fabricated result, and records `usage_limited:true` + the non-zero exit in telemetry. Implement/resume additionally skip verify/apply (no changes exist) and remove the worktree.

## Hooks-collision question — RESOLVED (spike, 2026-07-07)

`~/.codex/hooks.json` mirrors ~40 CCv3 hooks (git-auto-commit, sync-to-repo, file-claims, ralph enforcers) pointing at `~/.codex/hooks/dist/*.mjs`. The open question was whether these fire under non-interactive `codex exec`, risking double-commits / `file_claims` collisions. **Spike verdict: on this Windows host they do NOT cause commit/`file_claims` collisions.** In a throwaway git fixture, a `codex exec --sandbox workspace-write` write run: (a) created the file but did NOT auto-commit — commits stayed `1→1`, the file remained `?? untracked` → git-auto-commit did NOT fire; (b) left `file_claims` unchanged (`7481→7481`, zero fixture rows) → file-claims did NOT fire. Only Codex's OWN `SessionStart`/`UserPromptSubmit` hooks fired (mostly "Failed"), with no PostToolUse git/DB side effects — consistent with the community finding that `unified_exec` doesn't fire `PreToolUse`/`PostToolUse` hooks, reinforced by the Windows `workspace-write` subprocess block. This was the WORST case (in-place, NOT worktree-isolated) and still showed no collision, so worktree-isolated `implement` is doubly safe (hooks don't fire to collide, and the worktree is isolated regardless). **Re-verify after any Codex CLI upgrade or `~/.codex/hooks.json` change** (one fixture, one run).

## Quick decision table

| Pattern | Confirm? |
|---------|----------|
| `/codex <question>` (ask, read-only) | No |
| `/codex --implement …` (workspace-write, worktree) | **Yes** (unless `--yes`) |
| `/codex --resume …` (implement thread) | Yes |
| `/codex --review …` (delegates to codex-adversary) | No (read-only) |
| Applying the worktree patch to the live tree | **Yes** — human reviews the diff first |
| `git branch -D codex/<ts>` cleanup (interactive) | Yes (destructive-commands rule) |
| Enabling network / `danger-full-access` | **Yes**, never default |
| `--complex` (multi_agent; ask/implement) | Never default; confirms on write (implement already does); on read-only ask the explicit flag + printed caveat is the ack |

```

---

<!-- archived-rule:codex-adversarial.md ref:b800899 -->
## Reference: pre-split text of `rules/codex-adversarial.md` (archived 2026-07-29)

The rule now carries only the invariants an agent must hold *before* deciding to use this
tool. The evidence trail, version pins, probe archaeology and long caveats live here, and
load only once this skill does. Verbatim snapshot, so nothing that was trimmed is lost:

```markdown
# Codex Adversarial Review Rules

OpenAI Codex (default `gpt-5.6-luna @ max` since 2026-09-03; override via `CODEX_ADVERSARY_MODEL` env var; requires `@openai/codex` CLI **>= 0.144.1** — the gpt-5.6 family returns `400 requires a newer version of Codex` on `0.131.0`, so now that luna is the DEFAULT a 0.131 install fails every run; verified working on `codex-cli 0.131.0` as of 2026-06-01; CLI upgraded to `0.144.1` + re-verified 2026-07-11) is wired into CCv3 as a **cross-model adversarial reviewer** via:
- `codex-plugin-cc` plugin (slash commands `/codex:*`)
- `codex-adversary` agent (used by `/review` and `/premortem`)
- `plan-exit-premortem-prompt` hook (auto-offers `/premortem` after every approved plan)

**This rule governs read-only REVIEW only.** For write-capable task *execution* via Codex (`/codex` — ask/implement/resume, `workspace-write` in an isolated worktree), see the sibling rule `.claude/rules/codex-worker-safety.md` and the `codex-worker` agent. `/codex --review` delegates back to the `codex-adversary` agent covered here.

## When Codex Review Fires (default behavior)

| Trigger | Codex involvement |
|---------|-------------------|
| `/review` | codex-adversary runs in parallel Phase 1 alongside critic and plan-reviewer |
| `/premortem` | Codex adversarial pass after the inline failure-mode imagining step |
| After `ExitPlanMode` | AskUserQuestion offers `/premortem` (which includes Codex pass) |
| Manual: `/codex:adversarial-review --base <ref>` | One-shot review on demand |
| Manual: `/codex:review` | Standard (non-adversarial) review |

## When to Skip Codex

Use `--no-codex` on `/review` and `/premortem` for:
- Doc-only changes (.md, .json comments) - waste of Codex quota
- Hotfixes where latency matters more than depth
- Trivial diffs (<20 lines, single-file, no logic change)
- When the user has already explicitly burned through Codex quota this session

## Safe Commands (no confirmation needed)

- `codex login status` (check auth state without re-prompting)
- `codex --version`, `codex --help`
- `codex exec` with `--sandbox read-only`
- `/codex:review`
- `/codex:adversarial-review`
- `/codex:status`, `/codex:result`, `/codex:cancel`

## Confirm-First Commands (ALWAYS ask user)

Before running ANY of these, explain what it does and wait for explicit user approval:

- `/codex:rescue` - delegates *execution* of a task to Codex. Large blast radius, can modify files.
- `codex exec` with `--sandbox workspace-write` or `--sandbox danger-full-access`
- `codex exec --dangerously-bypass-approvals-and-sandbox`
- `/codex:setup --enable-review-gate` - **DO NOT enable**. Documented as high-cost (drains ChatGPT Codex quota), high-latency (900s timeout per turn), high-risk on Windows.

## Auth Model

Codex authenticates via OAuth against Dave's ChatGPT subscription (Plus/Pro). Quota usage counts against that subscription, not against an OpenAI API key. There is no separate API billing - if `codex auth status` shows a logged-in ChatGPT account, every adversarial-review call is on the subscription.

**Verified 2026-06-01:** with `codex-cli 0.131.0` and `codex login status` reporting "Logged in using ChatGPT", a smoke test of `codex exec --sandbox read-only --model gpt-5.5 -c model_reasoning_effort=xhigh` returned model output at exit 0. `exec` is authorized by the ChatGPT subscription **alone — no `OPENAI_API_KEY` is needed** (for the single-model path the adversary uses). The `no-API-key` finding holds. **Correction (2026-06-01):** an earlier version of this note dismissed the broken run's `o3`/`gpt-4.1`/`gpt-4o` model errors as "hallucinated noise after the binary hung." That was WRONG — those errors are REAL: Codex's multi-agent feature spawns built-in sub-agents that request `gpt-4.1`/`o3`, which a ChatGPT subscription rejects. See "Multi-agent / gpt-4.1" below. The lesson stands but inverts: do not dismiss a broken run's model errors as hallucination without verifying — here they pointed at a genuine feature bug.

## Startup Noise (cosmetic, not a failure)

A healthy `codex exec` on this machine still streams a large block of non-fatal startup noise to stderr/stdout *before* the real answer (which appears after the `codex` sentinel line). Treat all of the following as environmental, NOT as review findings or auth failures:
- ~150 `failed to load skill ... invalid YAML` lines — Codex scans `~/.agents/skills/` and `<project>/.agents/skills/` (the gitignored next-skills mirror + `_snapshots/`) with its stricter `SkillFrontmatter` schema and rejects Claude-format skills.
- MCP connection errors (Linear/Neon expired OAuth tokens; Paper `127.0.0.1:29979` not running) from `~/.codex/config.toml`.
- `[features].collab is deprecated. Use [features].multi_agent instead.`
- Many `hook: SessionStart/UserPromptSubmit Failed` lines from `~/.codex/hooks.json`.

The codex-adversary agent now captures the model's final answer via `codex exec -o <file>` and parses findings from that **clean** file (fix applied 2026-06-01), so this preamble no longer pollutes findings. The noise is therefore a cosmetic + latency tax only. Empirically (2026-06-01) it is NOT config-driven: `--ignore-user-config` still left ~106/125 noise lines, so the sources are hardcoded `.agents/skills/` scanning (a **673-file** mirror of the Claude skill library — `_snapshots/`/`archive/`/`.bak` dirs included), the separate `~/.codex/hooks.json`, and MCP connection attempts. The lone `config.toml` deprecation (`collab` -> `multi_agent`) is fixed. Cutting the remaining LATENCY would mean pruning/scoping `~/.agents/skills/` — but that is deletion of an unknown-provenance mirror, so check what regenerates it first and confirm before removing. Not needed for correct findings.

## Multi-agent / gpt-4.1 (the adversary disables it)

**The bug (root-caused 2026-06-01).** With `[features].multi_agent = true` in `~/.codex/config.toml`, a COMPLEX `codex exec` (e.g. reviewing a ~1900-line diff) makes Codex spawn its built-in `explorer`/`worker` sub-agents. A Codex role-config bug — `apply_role_to_config` drops the caller's runtime model for built-in roles that lack an explicit model (openai/codex #15170, #16893, #20077) — makes those roles fall back to **`gpt-4.1`**, which a ChatGPT subscription does NOT support:
`400 invalid_request_error: "The 'gpt-4.1' model is not supported when using Codex with a ChatGPT account."`
The whole review then fails. SMALL diffs don't spawn sub-agents, so they succeed on the main `gpt-5.5` model — which is why a single-file review worked but a large one didn't. There is NO config key for a default sub-agent model (openai/codex #19482); `-c features.multi_agent.model=...`, `[agents].default_model`, and an env var all do NOT exist (oracle-researched, sourced).

**The adversary fix.** The `codex exec` invocation in `codex-adversary.md` passes **`--disable multi_agent`** (equivalent to `-c features.multi_agent=false`). Adversarial review is single-shot; its cross-model value comes from the different model FAMILY (gpt-5.5 vs Claude), NOT from Codex's internal fan-out. Disabling it avoids the crash, removes the slow fan-out (a trivial multi-agent probe ran >165s without finishing), and loses no review quality. Verified 2026-06-01: a `--disable multi_agent` adversarial pass over the WS-2 Phase A diff produced 3 genuine findings — including a path-traversal bug the Claude-family reviewers had explicitly cleared (the textbook cross-model lift).

**Interactive multi-agent is kept intact.** `multi_agent = true` stays enabled globally for interactive Codex. A populated `~/.codex/agents/explorer.toml` with `model = "gpt-5.6-luna"` mitigates the role-model-drop for the `explorer` role — verified 2026-06-01: the explorer then spawns and runs WITHOUT the gpt-4.1 rejection (the trigger is the empty built-in `explorer.toml`, per #16893). Named custom agents in `~/.codex/agents/*.toml` can likewise pin `model = "gpt-5.6-luna"`. Caveat: openai/codex #19399 reports subagent TOML can be ignored on Windows; re-verify with a probe ("spawn an explorer subagent and have it report its exact model") if interactive multi-agent misbehaves. Supported ChatGPT-subscription models for Codex exec (live-probed 2026-07-11 on codex-cli 0.144.1): gpt-5.6-sol (flagship), gpt-5.6-terra, gpt-5.6-luna, gpt-5.5, gpt-5.4, gpt-5.4-mini. gpt-4.1 is API-key-only. (An earlier version of this line claimed `gpt-5.3-codex` was supported — WRONG: every `-codex`-suffixed id probed on this account 400s; see codex-worker-safety.md "Model allowlist".)

## Cost Awareness

Each `codex-adversary` invocation:
- Spends one Codex turn at gpt-5.6-luna (default) or whatever `CODEX_ADVERSARY_MODEL` resolves to, at `max` reasoning
- Latency: typically 30-90 seconds for code review, 45-120 seconds for plan review
- `max` reasoning is the expensive setting - we picked it because adversarial review needs depth (was `xhigh` until 2026-09-03; luna's ceiling is `max`, and gpt-5.5 has no `max` at all)

A typical `/review` run with codex enabled = 1 Codex call. A typical `/premortem` with codex enabled = 1 Codex call. The auto-prompt hook only OFFERS premortem - doesn't auto-run it.

## Synthesis Convention

When `review-agent` synthesizes Phase 1 findings, codex-adversary output is treated as a **distinct cross-model input source**, NOT pooled with critic's findings. Prefix Codex findings with `[Codex]` in synthesis output so cross-model agreement is visible at a glance.

Findings that BOTH critic and codex-adversary flag are high-confidence - the cross-model lift is exactly the findings only one side catches.

## Telemetry: codex-lift.jsonl

Every `/review` and `/premortem` run that includes Codex appends one row to `.claude/logs/codex-lift.jsonl` with: `claude_only`, `codex_only`, `both` counts plus `skill`, `scope`, `ts`, `via`. Schema and query patterns documented in `.claude/logs/codex-lift.README.md`. The `codex_only` count IS the cross-model lift — if it's consistently zero, the Codex pass isn't earning its quota cost and should be reconsidered.

## Integration Files

| File | Role |
|------|------|
| `.claude/agents/codex-adversary.md` | Agent definition - calls `codex exec` |
| `.claude/skills/review/SKILL.md` | Spawns codex-adversary in Phase 1 |
| `.claude/skills/premortem/SKILL.md` | Spawns codex-adversary --mode=plan |
| `.claude/hooks/src/plan-exit-premortem-prompt.ts` | Auto-prompts user to run /premortem after ExitPlanMode |
| `~/.claude/plugins/cache/.../codex-plugin-cc/.../prompts/adversarial-review.md` | Upstream adversarial system prompt (referenced by codex-adversary agent) |

```
