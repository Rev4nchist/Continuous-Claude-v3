# Codex Worker Safety Rules

Companion to `.claude/skills/codex/SKILL.md` (which now carries the evidence trail: probe archaeology, benchmarks, flag history, the resolved hooks-collision spike) and the `codex-worker` agent. Write-capable sibling of `.claude/rules/codex-adversarial.md` (read-only review). `/codex` hands a task to the OpenAI Codex harness (`gpt-5.6-luna @ max` by default) on Dave's **ChatGPT subscription** to actually execute — it can write files and run commands. Treat every write mode with the same care as any destructive operation.

Grounding: verified 2026-07-11 against `codex-cli 0.144.1`, `Logged in using ChatGPT`. Full evidence: `docs/codex-integration/DESIGN-RESEARCH.md`.

## The one thing to internalize

**`codex exec` has no approval dial, and no Claude Code hook can see inside Codex's sandboxed process.** The `codex exec …` command line itself passes `destructive-command-guard` like any Bash call, but everything Codex does *inside* its sandbox — every file write, every shell command — is invisible to Claude Code's hook layer. **The entire safety boundary is `--sandbox` + this rule's confirm-first preflight.** There is no second line of defense. Choose the sandbox deliberately and confirm write runs.

## Auth: subscription only (verify FIRST)

- Assert `codex login status` reports **"Logged in using ChatGPT"** before any run. If not → STOP, tell the user to run `codex login`. **Never** fall back to an API-key path.
- Wrap every `codex exec` in `env -u OPENAI_API_KEY -u CODEX_API_KEY` — a repo- or job-level env var must not silently switch auth to paid API billing.
- Never print `~/.codex/auth.json`, `OPENAI_API_KEY`, or `CODEX_API_KEY`.

## Confirm-first matrix

| Mode | Sandbox | Confirmation |
|------|---------|--------------|
| `ask` | `read-only` | **None** — read-only, matches the reviewer posture |
| `implement` | `workspace-write` | **Required every run** — show the exact `codex exec` command line, target worktree, model+effort; wait for explicit approval. `--yes` skips ONLY the interactive pause (orchestrator/Ralph), never the sandbox, telemetry, or review step |
| `resume` | inherits the resumed session's sandbox (resume takes NO `--sandbox`/`-C` — `cd` into the worktree) | Required if resuming an `implement` thread |
| `danger-full-access` | none | **Not used by this agent.** If ever needed, confirm-first, never default — identical posture to `--dangerously-bypass-approvals-and-sandbox` |

## Write-mode hard rules (`implement` / `resume`)

1. **Worktree isolation is the default, and worktrees live OUTSIDE the repo.** Writes happen in `$(dirname "$PROJECT")/.codex-worktrees/<repo>-<ts>-<pid>` — a throwaway git worktree branched from HEAD, a SIBLING of the repo, **never inside `$PROJECT`** and never in-place against the live tree. This structurally prevents collision with the concurrent Claude Code session's edits and the `file_claims` DB. There is no `--in-place` mode.
2. **Git-clean note before creating a worktree.** A worktree branches from HEAD, not uncommitted changes — if `git status --porcelain` is non-empty, warn the user that Codex won't see those pending edits.
3. **Independent verification, always.** After the run, the worker itself runs `git add -A && git diff --cached HEAD` in the worktree and shows that patch. Codex's own summary is never the sole evidence of what changed (RULES.md "External Verification").
4. **Review-gate — never auto-commit/auto-merge.** `implement` produces a patch the human reviews before it is applied (`git apply --3way`). This is the defense against prompt-injection via any content Codex reads (commit messages, issue text, fetched content).
5. **Writable-root scoping.** `-C` is always the worktree path. `--add-dir` only for genuinely shared scratch space, never the live repo root.
6. **Network stays off.** `workspace-write` keeps network access `false`. Enabling it requires an explicit flag + confirm (prompt-injection risk via fetched content).

## Worktree GC — reclaims only CONFIRMED-CLEAN abandoned worktrees

Before each `implement` run the worker opportunistically GCs stale `../.codex-worktrees/<repo>-*` dirs older than `$CODEX_WT_GC_DAYS` (default **7**) via `git worktree prune` + `git worktree remove --force`. **It skips any worktree with uncommitted changes** — `implement` only STAGES, so a dormant / awaiting-`resume` worktree holds UNREVIEWED work and is never reclaimed regardless of age. Reclaim is confirmed-clean only: `git status --porcelain` must EXIT 0 AND be empty (a broken/unreadable worktree is KEPT, never assumed clean). **There is no `rm -rf` anywhere in the auto path** (that would route a recursive delete around the destructive-guard); an unregistered orphan is **reported, never auto-deleted**. `scripts/codex/gc-worktrees.sh` follows the same rules (`CODEX_WT_GC_FORCE_DIRTY=1` reclaims dirty *registered* worktrees only; still no `rm -rf`).

## Model allowlist + effort ceiling (both enforced before shelling out)

**Default since 2026-09-03 is `gpt-5.6-luna @ max`, for every lane** — worker
and adversary, attended and unattended (Dave's call; evidence in
`docs/codex-integration/DESIGN-RESEARCH.md` §15). No new id was admitted: luna
was already live-probed on 2026-07-11 (§13), so the allowlist below is unchanged.

**The effort ceiling is per-MODEL, not per-family, and a wrong pair is not a
typo the model allowlist can catch.** Ground truth `~/.codex/models_cache.json`
(read 2026-09-03): sol and terra offer `max` AND `ultra`; **luna offers `max`
but NOT `ultra`**; **gpt-5.5 / 5.4 / 5.4-mini top out at `xhigh` and have NO
`max`**. So `--model gpt-5.5 --effort max` and `--model gpt-5.6-luna --effort
ultra` are both well-formed requests this account rejects. Each worker resolves
the ceiling from the chosen model and downgrades loudly rather than sending one.
Re-read the cache before changing either table — do not carry these levels from
memory.

Hard-reject any `--model` not in `{gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5, gpt-5.4, gpt-5.4-mini}`. Any `-codex`-suffixed or fabricated id returns HTTP 400 on this account. Treat ANY other id as **unverified-until-live-probed on this exact account via `/harness-update`**, regardless of what public docs claim. (Probe evidence + the 400 taxonomy live in the skill / DESIGN-RESEARCH.)

## multi_agent and `--ignore-user-config`

- **`--disable multi_agent` on every call by default.** Leaving the global `[features] multi_agent = true` on makes complex tasks spawn built-in sub-agents that fall back to `gpt-4.1` and 400 on this subscription.
- **`--complex` (ask/implement only, never resume)** swaps in `--enable multi_agent` but **HARD-REQUIRES `~/.codex/agents/explorer.toml` pinned to `model = "gpt-5.6-luna"` first — else refuse.** **Standing caveat, strengthened 2026-09-03: the fan-out itself is UNVERIFIED on this machine.** Two read-only probes (`--enable multi_agent`, asking the run to spawn an explorer and report its model) produced NO log evidence of a sub-agent ever spawning, and a deliberate negative control — pinning `explorer.toml` to the known-400 id `gpt-5.6-bogus` — produced NO 400 and exited 0. Model self-report is not a usable oracle here either: in the same probe the ORCHESTRATOR, launched as `gpt-5.6-luna`, described itself as "GPT-5". So it is not established that the pin is honoured, nor that `--complex` fans out at all on Windows (consistent with openai/codex#19399). Treat the pin as a cheap precaution, NOT as a proven guard, and do not rely on `--complex` unattended until a probe shows a spawn in the logs.

  Never default. Print the standing caveat: the pin was verified once on Windows and must be re-probed before unattended use. Confirm-gated like any write; on read-only `ask` the explicit flag + printed caveat is the acknowledgment.
- **`--ignore-user-config` is `ask`-ONLY.** `implement`/`resume` must NOT pass it: it **silently breaks workspace-write file creation on Windows** — `exit 0` with ZERO diff, a no-op that looks like success. Write modes take the slower cold-start.

## Windows / CLI hygiene

- **Always feed the prompt from a file** (`- < "$PROMPT_FILE"`), never an inherited TTY (documented hang).
- **Rely on an external timeout** (Bash-tool timeout or `timeout` wrapper) — Codex does not reliably self-terminate a stuck run on Windows.
- **`-o <file>` is the mandatory clean-output contract** — parse answers/findings from it; fall back to post-`codex`-sentinel log text only if `-o` is empty.
- **Both `workspace-write` AND `--sandbox read-only` block subprocess launches on Windows** (`CreateProcessAsUserW failed: 5`). Codex can create/edit files but CANNOT run `git`/`node`/tests inside its sandbox — it writes code BLIND and self-reports done without executing it. **The orchestrator's out-of-sandbox verification is the ONLY verification, and it must actually RUN changed runnable code, not just syntax-check it.** A read-only reviewer must get all context INLINE and be told not to spawn tools, or it burns its budget on denied spawns and can fork-storm.
- **`codex exec resume` takes no `--sandbox`/`-C`** — it inherits the resumed session's cwd + sandbox (`--sandbox` errors RC=2); `cd` into the worktree. Prefer the explicit captured session id over cwd-scoped `--last`.

## Cost / quota (subscription, not dollars)

Cost is ChatGPT-subscription quota, not dollars (a rolling 5-hour window plus a separate weekly cap — the 5h meter can look healthy while the weekly cap is exhausted). A multi-file `gpt-5.6-luna` implement run can be a meaningful fraction of a weekly allowance. **A quota preflight is impossible**; detection is reactive — grep every run's log for `You've hit your usage limit … try again at <time>`, return a clean "usage limit hit; resets ~<time>" message **instead of a fabricated result**, and record `usage_limited:true` + the non-zero exit in telemetry. Implement/resume additionally skip verify/apply (no changes exist) and remove the worktree.

## Version drift

Installed CLI is `0.144.1` (rollback pin `npm i -g @openai/codex@0.131.0`). `exec --help` shows NO `--full-auto`/`--ask-for-approval` — sandbox remains the only boundary. Code against the installed surface. **Any CLI upgrade or new-model enablement must go through `/harness-update`** (re-runs the DESIGN-RESEARCH §3 verification, including the hooks-collision fixture) before trusting new flags.

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
| `--complex` (multi_agent; ask/implement) | Never default; confirms on write; on read-only ask the explicit flag + printed caveat is the ack |

## Standing constraints (restored by adversarial review, 2026-07-29)

- **Re-verify after any Codex CLI upgrade or `~/.codex/hooks.json` change** (one fixture, one run).
- **Refuted alternative (do NOT use):** the design-doc §5.3 `--profile-v2 worker` + `~/.codex/worker.config.toml` overlay was **empirically refuted 2026-07-07** — overlay layering deep-merges, so an empty `[mcp_servers]` (or `-c mcp_servers={}`) does NOT remove the base MCP servers (MCP-fail count unchanged from baseline). No machine-local `worker.config.toml` is created; `--ignore-user-config` is self-contained and portable across machines.
