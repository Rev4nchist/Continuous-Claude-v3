# /codex — v2 Handoff Brief

**For:** a fresh session building v2 of the CCv3 Codex worker.
**Created:** 2026-07-07 (recon + plan session). **Scope approved by Dave:** lean high-value set; `--in-place` skipped.
**Companion:** `DESIGN-RESEARCH.md` (§7 phased plan, §10/§11 dogfood + v1 findings) · `.claude/rules/codex-worker-safety.md` · memory `codex-worker-v0` · full plan file `~/.claude/plans/idempotent-imagining-pancake.md`.

---

## Where things stand

`/codex` v0 + v1 are **merged to `main`** (PR #15 → `e10cd5f`). The write-capable worker (ask / implement / resume, ChatGPT subscription, no API key) is feature-complete + hardened. **v2 is enhancement-tier — nothing load-bearing.** This session ran the v2 recon and Dave chose the lean scope.

## Recon findings (verified 2026-07-07, `codex-cli 0.131.0`)

- **`--complex` is VIABLE on Windows.** A live `--enable multi_agent` probe spawned an `explorer` subagent that ran and self-reported **GPT-5**, with **zero `gpt-4.1` rejections** — the `~/.codex/agents/explorer.toml` `model = "gpt-5.5"` pin **is honored** here. The #19399 fear doesn't reproduce with a populated explorer.toml. (Verified once — keep a "re-probe if unattended" caveat.)

  > **CORRECTION 2026-09-03 (DESIGN-RESEARCH §16): the "pin is honored" half of this does not follow from the evidence.** It infers the pin was honoured from the explorer *self-reporting* "GPT-5". A re-probe on 2026-09-03 launched an orchestrator with `--model gpt-5.6-luna` and it ALSO self-reported "GPT-5" — so that string does not identify a model beyond its family, and cannot distinguish a honoured `gpt-5.5` pin from an explorer that simply inherited the caller's model with the pin ignored. What DOES survive is the hard, log-visible half: **zero `gpt-4.1` rejections**, which rules out the role-fallback this gate exists to prevent. Treat "no gpt-4.1 400s" as verified and "the pin is honored" as unproven. The pin moved to `gpt-5.6-luna` on 2026-09-03.
- **Quota preflight is NOT buildable as designed.** `codex doctor --json` has no quota/usage surface (only `checks/codexVersion/generatedAt/overallStatus/schemaVersion`). The only real signal is the runtime error the probe hit: `{"type":"error","message":"You've hit your usage limit ... try again at <time>"}` + `turn.failed`. → reframed to **reactive** handling.
- **Decisions:** `--in-place` = SKIP; `codex-plugin-cc` formal eval = already concluded (bespoke for writes; plugin used for review) — no writeup, just track releases.

## Hard constraints carried from v0/v1 — do NOT regress

1. Model allowlist `{gpt-5.5, gpt-5.4, gpt-5.4-mini}`; subscription-only (`env -u OPENAI_API_KEY -u CODEX_API_KEY`, assert "Logged in using ChatGPT").
2. Worktrees OUTSIDE the repo (sibling `../.codex-worktrees/<repo>-<ts>-<pid>`). Review-gate; never auto-commit/merge.
3. `resume` takes NO `--sandbox`/`-C`; `cd` into the worktree. Prefer captured `thread_id` (UUID) over `--last`; a non-UUID (incl. literal "last") to `resume` silently starts a NEW disconnected session.
4. Windows `workspace-write` blocks subprocess launches → the orchestrator RUNS changed code out-of-sandbox (not just `--check`).
5. Stdin-from-file, `-o` clean-capture, external timeout. **`--ignore-user-config` is `ask`-ONLY** (v2 correction — it silently breaks workspace-write file creation on Windows; `config.toml` carries the sandbox writable-root/approval policy, so implement/resume DROP it and take the slower cold-start. See DESIGN-RESEARCH §12).

## Step 0 — BEFORE building (do these first)

1. **Run `/premortem`** on this plan (Codex cross-model pass) — **after the quota reset** (see below).
2. **Quota gate:** the ChatGPT subscription usage limit was exhausted by the recon probe on 2026-07-07 (reset ~1:08 PM that day). Any codex-dependent step must run after the reset — check `codex login status` + a tiny `ask` smoke first.
3. **Resolve the one unverified interaction (Item 1):** does `--complex`'s `--enable multi_agent` still honor `explorer.toml` when the worker also passes `--ignore-user-config`? `--ignore-user-config` skips `config.toml` (holds `[features] multi_agent`) but `explorer.toml` lives in `~/.codex/agents/` (separate). Probe it: run `--enable multi_agent --ignore-user-config` with the spawn-an-explorer prompt; if the explorer 400s on gpt-4.1 or doesn't spawn, **`--complex` must drop `--ignore-user-config`** (accept the ~16-MCP latency tax for complex runs only).
4. Branch off `main`: `feature/codex-worker-v2` (never `main`).

## v2 scope — 4 items (lean high-value set)

### Item 1 — `--complex` opt-in (multi_agent)
Add `--complex` to `/codex` enabling multi_agent fan-out for broad tasks (opt-in, never default).
- **Agent enforces before honoring `--complex`:** assert `~/.codex/agents/explorer.toml` exists AND pins `model = "gpt-5.6-luna"` (as of 2026-09-03; was `gpt-5.5` when this brief was written) — else refuse; swap `--disable multi_agent` → `--enable multi_agent` for this call; print the "verified once 2026-07-07; re-probe if unattended (#19399)" caveat; keep allowlist/subscription/worktree/confirm unchanged.
- Cost: ~1,940 tok/call + fan-out latency (opt-in justifies it).
- **Files:** `.claude/skills/codex/SKILL.md`, `.claude/agents/codex-worker.md` (Step 1 parse + Step 3b invocation swap + explorer.toml assertion), `.claude/rules/codex-worker-safety.md`, `.claude/logs/codex-worker.README.md` (telemetry `multi_agent:true`).
- **Acceptance:** `/codex --implement --complex "<broad task>"` → sub-agents on gpt-5.5 (no gpt-4.1 400), reviewable worktree diff, caveat shown.

### Item 2 — reactive usage-limit handling
Detect the usage-limit error (preflight impossible — no quota surface) and handle it cleanly.
- Post-run parse (all modes): detect `"You've hit your usage limit ... try again at <time>"` + `turn.failed` → return a clean "usage limit hit; resets ~<time>" message (never a fabricated result), set telemetry `exit_code` + `usage_limited: true`. Optional soft heuristic: running-token total (README anticipates `.tokens`) — mark as heuristic, not a cap check.
- **Files:** `.claude/agents/codex-worker.md` (Step 3a/b/c + Step 4), `.claude/logs/codex-worker.README.md` (`usage_limited` field), `.claude/rules/codex-worker-safety.md`.
- **Acceptance:** parser check against the recorded error line → clean message + reset time + telemetry flag + non-zero exit (can't force a real limit).

### Item 3 — worktree GC automation (v1 deferral)
Opportunistic GC before each implement worktree-create: `git -C "$PROJECT" worktree prune` + remove `../.codex-worktrees/*` older than N days. Idempotent; **skips any worktree with unreviewed (dirty) changes** — never an active OR a dormant awaiting-`resume` one (an `implement` worktree only STAGES, never commits, so it stays dirty until applied). Optional `scripts/codex/gc-worktrees.sh`.
- **Files:** `.claude/agents/codex-worker.md` (Step 3b), optional `scripts/codex/gc-worktrees.sh`.
- **Acceptance:** after several runs, stale dirs cleaned; active preserved.

### Item 4 — doc sweep (CodeRabbit #4)
Fix `DESIGN-RESEARCH.md §5.3/§7` stale *in-repo gitignored* worktree references (out-of-repo is the reality per §10/§11).

## Explicitly OUT (approved)
`--in-place` (worktree isolation is the safety win) · formal `codex-plugin-cc` writeup (decision made: bespoke for writes) · Python SDK spike (only if shell-out shows a real limitation).

## Build process
`.md`/`.toml`/`.sh` only (plan-to-ralph won't block). Reuse this session's **dogfood pattern**: live `codex-worker` agent + Claude wiring audit + cross-model `codex-adversary` on the diff; verify shell fixes on synthetic inputs first. Re-sync active (`cp` for uncommitted → commit → post-commit auto-sync). Update `ROADMAP.md` + `DESIGN-RESEARCH.md §11` + memory `codex-worker-v0`.

## Kickoff prompt
See `V2-KICKOFF-PROMPT.md` (same folder).
