# `/codex` — General-Purpose Write-Capable Codex Delegation for CCv3

Design-research document. Compiled 2026-07-06 by synthesizing 2 internal audits, 3 external research passes, and 1 empirical verification gate. Goal: a `/codex <request>` command in Claude Code that hands an arbitrary task to the OpenAI Codex harness (`gpt-5.5`, on Dave's ChatGPT **subscription** — hard requirement, no API key) to actually **execute** — write files, run commands, implement — not just review.

**Grounding facts treated as ground truth for this doc** (see §7 for full verification table):
- Machine: Windows 11, PowerShell primary + Git Bash available. Project: `C:/Users/david.hayes/continuous-claude`.
- `codex-cli 0.131.0` installed; upstream stable is `0.142.5` — **meaningful version drift**, called out throughout.
- `codex login status` → `Logged in using ChatGPT`. `OPENAI_API_KEY` and `CODEX_API_KEY` both unset and confirmed unnecessary.
- `~/.codex/config.toml`: `model = "gpt-5.5"`, `model_reasoning_effort = "xhigh"`, `personality = "pragmatic"`, `[features] multi_agent = true` (global), `shell_snapshot = true`.
- Today's only production Codex usage in CCv3 is **read-only adversarial review** via `.claude/agents/codex-adversary.md`, wired into `/review` and `/premortem`.

---

## 1. Executive Summary

**What exists today:** CCv3's entire Codex integration is a single read-only reviewer. `.claude/agents/codex-adversary.md` shells out to `codex exec --sandbox read-only --ephemeral --disable multi_agent -o <file>` and is invoked only from `/review` (Phase 1) and `/premortem` (Step 2.5), plus a nudge hook (`plan-exit-premortem-prompt.ts`) that never itself calls Codex. There is **no mechanical enforcement** of any of this — no hook, no `settings.json` permission entry, nothing in `skill-rules.json` — the safety model is convention-only, living entirely inside one hardcoded agent file. The official `openai/codex-plugin-cc` plugin (which ships a write-capable `/codex:rescue` job-lifecycle command — background/wait, resume/fresh, status/result/cancel) is **not installed**; only a vendored prompt fragment (`vendor/codex-plugin-cc/prompts/adversarial-review.md`) exists on this machine.

**What's proposed:** a net-new `.claude/skills/codex/SKILL.md` (`/codex <request>` with `ask` / `implement` / `resume` modes) backed by a net-new `.claude/agents/codex-worker.md` (distinct from `codex-adversary` — write and read-only have too-different safety defaults to share one file), governed by a net-new `.claude/rules/codex-worker-safety.md`, logging to a net-new `.claude/logs/codex-worker.jsonl`. Sandbox — not approval policy — is the entire safety boundary for headless Codex, because `codex exec` has no interactive approval concept at all (confirmed empirically, §3). Default `implement` scope is an **isolated git worktree**, not the live working tree, to avoid collision with the concurrent Claude Code session's own edits and the `file_claims` coordination DB.

**The 5 decisions that most shape the build** (full tradeoffs in §8):
1. **Default `implement` scope = isolated git worktree**, not in-place writes to the shared working copy.
2. **Never offer a `-codex`-suffixed model.** Empirically confirmed: `gpt-5.2-codex` and a fabricated `gpt-5.5-codex` both return byte-identical HTTP 400s under ChatGPT-subscription auth. Only `gpt-5.5` / `gpt-5.4` / `gpt-5.4-mini` are real, subscription-eligible options.
3. **`--disable multi_agent` stays the default** for every mode; multi_agent is opt-in only, gated behind an explicit flag and a re-verification banner (the `gpt-4.1`-fallback bug is a documented bug *class*, not a one-off).
4. **`codex-worker` is a new agent, not a mode flag on `codex-adversary`.** Read-only critique and write-capable execution have incompatible blast radii to share a single hardcoded-flags file safely.
5. **Confirm-first governs `workspace-write`/`danger-full-access` exactly like the existing destructive-command convention** — and critically, **no Claude-Code-side hook can see or block anything Codex does inside its own sandboxed process**. The `codex exec` invocation line itself passes through `destructive-command-guard` like any other Bash call (it isn't `rm`/`git reset`), but Codex's internal shell-tool calls are invisible to Claude Code's hook layer entirely. Enforcement is `--sandbox` + skill-level preflight, full stop.

---

## 2. Current State — Component Inventory (from internal-A)

| File | Role | Reuse or Replace |
|---|---|---|
| `.claude/agents/codex-adversary.md` | The actual worker today — envelope agent: parse Mode/Scope/Focus/Codebase → assemble context → lookup-order system prompt → build prompt → invoke → `-o` clean-capture → `latest-output.md` | **Reuse the pattern**, do not extend the file itself |
| `.claude/skills/review/SKILL.md:122-190` | Spawns codex-adversary as 4th parallel reviewer; `--no-codex` skip flag; telemetry append | Reuse as-is (unaffected) |
| `.claude/skills/premortem/SKILL.md:218-356` | Step 2.5 cross-model pass, `sources:[claude,codex]` merge convention | Reuse as-is (unaffected) |
| `.claude/hooks/src/plan-exit-premortem-prompt.ts` | PostToolUse:ExitPlanMode nudge toward `/premortem`; never calls Codex; fails open | Reuse — unrelated to write-capable path |
| `.claude/hooks/src/plan-exit-tracker.ts` | Sibling hook; writes plan-approved state for plan-to-ralph-enforcer | Reuse — see §5 governance note |
| `.claude/logs/codex-lift.README.md` + `.jsonl` | Schema doc + 5 real rows (2026-07-04→07-06): `claude_only`/`codex_only`/`both` lift counts | **Replace** — wrong schema for a task worker; build a new log (§5.6) |
| `vendor/codex-plugin-cc/prompts/adversarial-review.md` | Only the vendored review-prompt fragment; **the full plugin is NOT installed** (`~/.claude/plugins/cache/` has 4 unrelated entries, recursive `*codex*` search returned nothing) | Reference architecture only (§4, §8) |
| `.claude/rules/codex-adversarial.md` | Home doc for today's review-only usage; documents the gpt-4.1/multi_agent bug and the `--disable multi_agent` fix | **Extend minimally** (cross-reference) + add a **new sibling rule** (`codex-worker-safety.md`) rather than overloading it |
| `~/.codex/AGENTS.md` | Confirmed to be a mis-templated clone of `CLAUDE.md` (broken find/replace casing) — not a purpose-built Codex doc | Replace with a small, purpose-built worker system prompt, not this file |
| `~/.codex/hooks.json` | Full parallel mirror of the CCv3 hook ecosystem (~40 entries: git-auto-commit, sync-to-repo, file-claims, ralph enforcers) pointing at `~/.codex/hooks/dist/*.mjs` | **Unresolved — spike required** (see below) |

**Registration surface — verified negative results:** `skill-rules.json` has zero `"codex"` matches anywhere in the repo. `settings.json`/`settings.local.json` have zero `"codex"` matches — no hook, no permission entry, `allowedTools: []`. 19 hook source files match `"codex"` as text but every one is a **provenance comment** ("Codex T1", "Codex #1") citing a past finding, not runtime logic. **Conclusion: today's entire safety model is convention-only.** A write-capable `/codex` cannot rely on any existing mechanical gate — it must bring its own (§5).

**The `~/.codex/hooks.json` collision question, updated with external evidence:** internal-A flagged this as the single highest-leverage unknown — does the ~40-entry hook mirror (git-auto-commit, sync-to-repo, file-claims, ralph enforcers) fire under non-interactive `codex exec`, risking double-commits and `file_claims` collisions with a concurrent Claude Code session? External community research (ext-community §3.5, the `destructive_command_guard` Codex-integration doc) supplies a partial, unverified-on-this-machine mitigation: Codex's `unified_exec` path — the path `codex exec`'s own internal shell-tool calls and the Windows Desktop app use — **does not fire `PreToolUse` hooks at all**. If that holds for `~/.codex/hooks.json`'s git-auto-commit/sync-to-repo/file-claims entries too, collision risk is reduced but not eliminated (SessionStart/Stop-class hooks could still fire). **This remains a required spike before v1** (§6), not a closed question — run it in a throwaway git fixture, never in this repo.

---

## 3. Verified CLI Capability Surface

Everything below is either the verify-memo's live smoke tests (`✓ EMPIRICAL`) or internal-B's direct `--help` text inspection (`✓ HELP-TEXT`) against the **installed** `codex-cli 0.131.0`. Where later CLI versions (per official docs, §4) diverge, it's called out explicitly as **version drift**, not a contradiction.

### 3.1 The load-bearing finding: approval is not a lever, sandbox is

```
$ codex exec -m gpt-5.5 -c model_reasoning_effort=low --sandbox read-only \
    --skip-git-repo-check --disable multi_agent -C "<project>" \
    -o c1-last.txt "Reply with exactly this text and nothing else: OK-C1"
```
Session banner (✓ EMPIRICAL): `provider: openai`, `approval: never`, `sandbox: read-only`. This banner appeared **with no `-a`/`--ask-for-approval` flag passed at all** — because that flag **does not exist on `codex exec`** in 0.131.0 (✓ HELP-TEXT, confirmed absent by direct grep of captured `--help` output). It exists only on the top-level `codex` (interactive) command, with values `untrusted|on-failure|on-request|never`. **For headless work, sandbox mode is the entire safety boundary — there is no approval dial to fall back on.**

| Sandbox | What it allows | Recommended for |
|---|---|---|
| `read-only` | No writes, no arbitrary exec beyond inspection | `ask` mode — research/Q&A/explain |
| `workspace-write` | Writes confined to `-C` dir + `--add-dir` paths; network stays off by default | `implement` mode default |
| `danger-full-access` | No sandbox at all | Never bare on this host — confirm-gated exactly like existing `--dangerously-bypass-approvals-and-sandbox` convention |

### 3.2 (a) Read-only research / Q&A shape

```bash
printf '%s' "$PROMPT" | codex exec \
  --model gpt-5.5 \
  -c model_reasoning_effort=high \
  --sandbox read-only \
  --skip-git-repo-check \
  --disable multi_agent \
  --ephemeral \
  -C "C:/Users/david.hayes/continuous-claude" \
  -o "C:/path/to/out/final.txt" \
  - < "$PROMPT_FILE"
```
`--ephemeral` is fine here — a one-shot research answer rarely needs to be resumed. Drop it if you want the option to `codex exec resume --last` afterward.

### 3.3 (b) Workspace-write AUTONOMOUS implementation shape

```bash
printf '%s' "$TASK_PROMPT" | codex exec \
  --model gpt-5.5 \
  -c model_reasoning_effort=high \
  --sandbox workspace-write \
  --skip-git-repo-check \
  --disable multi_agent \
  -C "C:/path/to/worktree" \
  --json \
  -o "C:/path/to/out/final.txt" \
  - < "$PROMPT_FILE"
```
Note `-C` points at an **isolated worktree path**, not the shared repo root — see §5.3/§8. No approval flag needed or possible; `exec` is autonomous-by-construction. `--json` is optional — add it only when the caller wants per-turn token/progress data (§3.5), not for the final answer (use `-o` for that, always).

### 3.4 (c) Multi-turn / resume shape

```bash
# First turn — do NOT pass --ephemeral if you intend to resume
printf '%s' "$TASK_PROMPT" | codex exec \
  --model gpt-5.5 -c model_reasoning_effort=high \
  --sandbox workspace-write --skip-git-repo-check --disable multi_agent \
  -C "C:/path/to/worktree" \
  -o "C:/path/to/out/turn1.txt" \
  - < "$PROMPT_FILE"

# Follow-up turn
printf '%s' "$FOLLOWUP_PROMPT" | codex exec resume --last \
  --sandbox workspace-write --disable multi_agent \
  -o "C:/path/to/out/turn2.txt" \
  - < "$FOLLOWUP_FILE"
```
`codex exec resume [SESSION_ID|--last] [PROMPT]` is the only continuation verb — no separate `continue` (✓ HELP-TEXT). `--ephemeral` sessions cannot be resumed (nothing was persisted) — mutually exclusive with this workflow.

### 3.5 Clean-output method: `-o` vs `--json` vs `--output-schema`

| Mechanism | Shape | Use for |
|---|---|---|
| `-o, --output-last-message <FILE>` | Plain-text final message only | **Primary contract, always use this.** Matches `codex-adversary`'s existing pattern, zero parsing risk. ✓ EMPIRICAL: diffing `-o` output (1 line) against full stdout+stderr (180 lines: stdin notice, ~106 skill-YAML load errors, ~6 MCP auth errors, hook lines, banner, transcript) proves `-o` fully strips the noise. |
| `--json` | JSONL to stdout, one event per line (`thread.started`, `turn.started`, `item.completed`, `turn.completed` with token usage) | Only when the orchestrator needs streaming progress or per-turn token accounting. Combine with `-o` for a belt-and-suspenders final answer — confirmed these give **JSONL on stdout but plain text in the `-o` file**, not the same shape. |
| `--output-schema <FILE>` | JSON Schema constrains the final message shape | When downstream needs a typed result object (e.g. `{"status":"ok","files_changed":[...]}`). Community-reported gotcha (unverified on this machine): the schema **must** set `additionalProperties: false` and list every property in `required`, or validation errors at runtime. |

**Recommendation:** `-o` is the mandatory baseline for every invocation. `--json` is additive for v1+ telemetry richness. `--output-schema` is a v2 nice-to-have once a stable result contract is designed.

### 3.6 Model reality — hard constraint, empirically proven

```
$ codex exec -m gpt-5.2-codex ...   → exit 1, 400 "The 'gpt-5.2-codex' model is not supported when using Codex with a ChatGPT account."
$ codex exec -m gpt-5.5-codex ...   → exit 1, IDENTICAL 400 shape with substituted name (gpt-5.5-codex isn't even a real model id)
```
`~/.codex/models_cache.json` lists exactly 4 models: `gpt-5.5` (default), `gpt-5.4`, `gpt-5.4-mini`, and a hidden `codex-auto-review` (internal auto-approval reviewer — never surface it in a picker). **Never offer a `-codex`-suffixed model in `/codex`.** This is strong evidence of a blanket "any `-codex` id + ChatGPT auth = 400" rule on this account, not a one-off typo — treat any future `-codex`-suffixed id (including ones documented as available, §4) as unverified-until-tested against this exact account.

### 3.7 `multi_agent` — verified accepted, real cost even when unused

`config.toml` has `[features] multi_agent = true` globally; `codex features list` confirms `multi_agent stable true`. Every exec call in this session's verification used `--disable multi_agent` with zero flag-parse errors (✓ EMPIRICAL). Community measurement (ext-community): enabling `multi_agent` adds **~1,940 tokens to every call even when no sub-agent spawns** — a pure tax with no benefit in single-shot use, independently corroborating why disabling it by default is correct for token economy, not only crash-avoidance.

### 3.8 Windows note carried forward

`--skip-git-repo-check` bypasses only the repo-existence guard — it does not widen the sandbox or mark a directory "trusted." Every verify-memo run showed "Reading additional input from stdin..." regardless of redirect, but never hung on this machine — still, **always redirect stdin from a file, never rely on an inherited TTY**, because a real Windows hang bug is documented upstream (`openai/codex#20919`) for non-TTY inherited stdin with nothing written to it. This matches the CCv3 `ntn` CLI lesson exactly (`.claude/rules/notion-cli-safety.md`) — treat "always redirect stdin explicitly on Windows" as a universal CLI-scripting rule, not a Codex-specific quirk.

---

## 4. External Best-Practices Distillation

### 4.1 Theo (t3.gg) — VERIFIED, cited quotes

- **Delegation pattern, most current (July 2026):** Claude Code (running "Fable"/Claude's flagship) is taught via a CLAUDE.md section to route work: *"I taught Claude Code how to use Codex as a fallback for lots of implementation tasks. GPT-5.5 is incredibly steerable... Things that are unnecessarily token hungry (computer use, codebase analysis, etc), I do with other models and report results back."* Follow-up: *"I still find Codex to be WAY better at computer use, verification of UI/UX work, and generally more efficient at execution on well spec'd work... I was throwing away ~50% of my end-to-end agent-driven PRs before building this workflow. I haven't had to close a single one today."* — [YouTube: A realistic comparison of Opus and Codex](https://www.youtube.com/watch?v=1SJGGUeEbQs), [x.com/theo/status/2072481845363822914](https://x.com/theo/status/2072481845363822914), [x.com/theo/status/2072482460122964067](https://x.com/theo/status/2072482460122964067)
- **Reasoning effort — his most repeated, and most contested-vs-CCv3 opinion:** *"I am running codeex on high. I almost never ever reach for extra high. I find high to be more than enough. Often medium feels better."* / *"extra high can perform worse because if it thinks too long it'll gaslight itself and then do something dumb."* — [YouTube: A realistic comparison of Opus and Codex](https://www.youtube.com/watch?v=1SJGGUeEbQs), [Never mind (OpenAI won again)](https://www.youtube.com/watch?v=RYWrK2hsIB8)
- **Subscription-only, unambiguous:** *"Codeex 5.3 is not available over the API yet unless you're one of the big companies they partnered with"* — [A realistic comparison of Opus and Codex](https://www.youtube.com/watch?v=1SJGGUeEbQs)
- **Bidirectional unblock pattern:** *"I'll often have Opus unblock Codex because if Codex is trying too hard to work around the blockers... it might get trapped."* — same source
- **T3 Code productizing exactly this:** *"Turns out Julius already had a branch on T3 Code that lets you spin up Codex subagents via Claude (and vice versa). Should we ship this?"* — [x.com/theo/status/2072869036615155735](https://x.com/theo/status/2072869036615155735)
- **Pitfall:** a 20+ hour, 85,000-line "fix everything" doom-loop vs. Opus solving the same task in 8 minutes — [A realistic comparison of Opus and Codex](https://www.youtube.com/watch?v=1SJGGUeEbQs)

### 4.2 ChaseAI — VERIFIED

- **Official plugin as the reference architecture:** `/plugin marketplace add openai/codex-plugin-cc` → `/plugin install codex@openai-codex` → `/reload-plugins` → `/codex:setup`, then `/codex:rescue [--background|--wait] [--resume|--fresh] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh>]` — this IS OpenAI's own answer to "delegate a real task from Claude Code to Codex."
- **Model:** start with plain GPT-5.5, not Pro tier, unless already deep in the ecosystem.
- **Sandbox:** his own tooling (`grill-me-codex`) pins `-s read-only` for review; `/codex:rescue` is write-capable by default.
- **Full autonomy earns trust via testable completion criteria written in plan mode first** — his headline autonomy feature is Codex's *native* `/goal` (enabled via `[features] goals = true`), architecturally a different, Codex-side-only autonomy loop that Claude Code cannot drive or monitor — **not** the same thing as `/codex:rescue` or our proposed `/codex --implement`.
- **Gap:** his content never surfaces the gpt-4.1/multi_agent bug CCv3 had to independently root-cause.
- **Scope limiter:** his real automated Codex-as-subagent pattern is `grill-me-codex` (review-only, read-only) — everything else is manual copy-paste between two chat UIs; "I haven't messed with [automated wiring] too much."

### 4.3 Official docs (`developers.openai.com/codex/*`) — VERIFIED, with named version caveat

- **OpenAI's own recommendation for CI/automation is the opposite of our hard requirement:** *"We recommend API key authentication for programmatic Codex CLI workflows... The right way to authenticate automation is with an API key. Use this guide only if you specifically need to run the workflow as your Codex account."* — [CI/CD auth](https://developers.openai.com/codex/auth/ci-cd-auth). We are deliberately going against the blessed path to stay on Dave's subscription — supported, not recommended. Treat `~/.codex/auth.json` with API-key-level secrecy.
- **Docs describe a newer CLI (`0.142.5`) than what's installed (`0.131.0`).** This explains two real conflicts with the empirical findings in §3: docs list `--ask-for-approval`/`-a` and `--full-auto` as flags on `exec`, and describe `-a` being silently coerced to `never` in non-interactive mode. **On the installed 0.131.0, neither flag exists on `codex exec` at all** (confirmed by direct `--help` grep). This is version drift, not a contradiction — but it means **the design must code against the empirically-verified 0.131.0 surface, not the docs' surface**, until an upgrade is deliberately performed and re-verified.
- **Codex SDK is OpenAI's recommended programmatic surface**, not raw `codex exec` shell-out. Python SDK (`openai-codex`, beta) explicitly documents **"Automatic Authentication: the SDK automatically leverages existing Codex authentication when one is already available"** — the cleanest documented subscription-auth story for a programmatic worker. The TS SDK's README describes injecting `CODEX_API_KEY` into the child env — ambiguous whether this is a hard requirement or a no-op under an active ChatGPT session; **flagged as an open question, not verified this session** (§6, open question #1).
- **`codex app-server` (JSON-RPC) is explicitly NOT recommended for this use case:** *"If you are automating jobs or running Codex in CI, use the Codex SDK instead."* Rule it out for v0-v2.
- **Codex ships its own hooks system**, near 1:1 structural mirror of Claude Code's (`PreToolUse`, `PostToolUse`, `SessionStart`, `Stop`, same JSON contract) — directly reusable for Codex-side guardrails independent of whether Claude Code is in the loop. Source: [Hooks](https://developers.openai.com/codex/hooks).
- **Network access is off by default** even under `workspace-write`; opt-in via `network_access = true` plus a `network_proxy` domain-allowlist feature. — [Agent approvals & security](https://developers.openai.com/codex/agent-approvals-security)
- **Version-note worth acting on:** `0.142.0` added *"app-server clients can set multi-agent delegation to `disabled | explicit-request-only | proactive`"* — a potentially cleaner replacement for the blunt `--disable multi_agent` toggle, worth testing after an upgrade (§6, v2).

### 4.4 Community (GitHub issues, blog writeups, gists) — VERIFIED unless marked otherwise

- **Job-lifecycle prior art**: `/codex:rescue`'s background/wait + status/result/cancel shape is the closest existing answer to "delegate an actual task" — treat as reference architecture (§8, decision on plugin-vs-bespoke).
- **`multi_agent`/gpt-4.1 is a bug *class*, not one issue**: `openai/codex#16893` (empty `explorer.toml` → model-ignore), `#14866` (sub-agents stuck, don't follow default model), `#14961` (worker launch fails outright on unavailable model), `#15250` (`.codex/agents/` custom agents unreachable from MCP-tool-backed sessions despite docs). Simon Willison's independent writeup corroborates ambiguity even in documented behavior — [Use subagents and custom agents in Codex](https://simonwillison.net/2026/Mar/16/codex-subagents/).
- **Windows-specific hang bugs, directly relevant on this host:** `codex exec "<prompt>"` can hang indefinitely on non-TTY inherited stdin (`openai/codex#20919`, workaround `< NUL`/`</dev/null`); large shell-tool output can stall (`#18983`); slow/large git repos can stall trivial tool calls for minutes (`#20200`).
- **No auto-compact historically** — big diffs pre-stuffed into a prompt can overflow context outright (`#3967`, `#19842`); mitigation consensus: let Codex read files itself, don't pre-paste diffs, chunk large tasks across multiple bounded `exec` + `resume` calls.
- **Quota reality, with a real regression:** two independent clocks (5-hour rolling window + separate weekly cap); the 5h meter can look healthy while the weekly cap is exhausted. An **open, unresolved** GitHub issue reports a 10-20x per-token rate-limit cost regression since mid-June 2026 draining the 5h budget in 2-3 prompts — `openai/codex#28879`.
- **Review-gate consensus, strongest cross-source finding:** never let a headless run auto-commit/auto-merge; patch-as-artifact + human/second-job review before applying, specifically to defend against prompt-injection via commit messages/PR titles/issue bodies.
- **Codex's own hooks don't cover the `unified_exec` path** — the `destructive_command_guard` Codex-integration doc states Codex-side `PreToolUse` hooks do **not** fire for `unified_exec` (the path `codex exec` and its shell-tool calls use), meaning a hook-based guard on the Codex side covers only the simple-shell path, not a complete boundary. Directly informs the `~/.codex/hooks.json` collision spike (§2, §6).
- **Worktree isolation, from oh-my-codex (OMX):** each parallel worker in its own git worktree, reconciled afterward by a "leader" — the safest pattern found for avoiding write collisions with a concurrently-edited working tree.

### Consensus vs. Contested Table

| Topic | Consensus | Contested / Version-Drift |
|---|---|---|
| Subscription-only auth (no API key) | **Consensus** — Theo, ChaseAI, official docs (supported-but-not-recommended), community, verify memo all agree it works | — |
| Model choice | **Consensus on `gpt-5.5`** as current flagship (Theo bundles harness+model as "Codex", ChaseAI explicit) | **Contested on `-codex`-suffixed variants**: official docs list `gpt-5.2-codex`/`gpt-5.3-codex` as sunset-but-selectable via API key + a Pro-only `gpt-5.3-codex-spark`; **our own account/version 400s on any `-codex` id under ChatGPT auth** — ground truth wins, never offer these |
| Reasoning effort for autonomous/long tasks | — | **Contested**: Theo/ChaseAI explicitly recommend `high`/`medium`, warn `xhigh` "gaslights itself" on long tasks; existing CCv3 `codex-adversary` always uses `xhigh` (works fine for bounded review). Resolve per-mode, not globally (§8) |
| `multi_agent` default posture | **Consensus: disable by default** — CCv3's own root-caused bug + 4 independent GH issues + token-tax measurement all agree | ChaseAI's `/goal` is a *different* feature (Codex-native autonomy loop), not multi_agent — don't conflate |
| Sandbox default for autonomous work | **Consensus: sandbox is the only real boundary**, `workspace-write` for implementation | **Contested on isolation**: official CI guidance is `workspace-write`+`never` in-place; community strongly recommends worktree/patch-as-artifact isolation instead. This doc resolves toward isolation (§8) |
| `--full-auto` / `-a` on `exec` | — | **Version drift, not true disagreement**: newer docs (0.142.5) describe these; installed 0.131.0's `--help` confirms neither exists on `exec`. Design against the installed version |
| Review-gate before merge | **Consensus, strongest finding in the entire research pass** — every automation-focused source agrees | — |
| Plugin (`codex-plugin-cc`) vs. bespoke | ChaseAI treats the plugin as reference | **Open decision** — plugin isn't installed on this machine; internal-A found only a vendor prompt fragment (§8) |

---

## 5. Proposed `/codex` Architecture

### 5.1 Skill: `.claude/skills/codex/SKILL.md`

**Trigger:** explicit slash command only — `/codex <request>` — mirroring `/review`/`/premortem`'s pattern of NOT being keyword-auto-triggered (verified today's `skill-rules.json` has zero Codex entries and both existing Codex-touching skills are slash-only by design; keep that convention).

**Modes** (flag-selected, `ask` is the safe default if omitted):

| Mode | Flag | Sandbox | Ephemeral | multi_agent | Confirm-gate |
|---|---|---|---|---|---|
| `ask` | (default) / `--ask` | `read-only` | yes | disabled | none — matches today's reviewer posture |
| `implement` | `--implement` | `workspace-write` | no (resumable) | disabled unless `--complex` | **required** before first invocation |
| `resume` | `--resume [id\|last]` | inherits prior turn's sandbox | n/a | inherits | required only if resuming an `implement` thread |
| complex opt-in | `--complex` (modifier on `implement`) | unchanged | unchanged | **enabled**, requires `explorer.toml` pin verified | additional confirm + warning banner (§5.3) |

**How each mode picks sandbox+approval+model:** approval is never a variable (§3.1 — no dial exists on `exec`); sandbox is fixed per the table above; model defaults to `gpt-5.5` with `--model gpt-5.4|gpt-5.4-mini` as the only other accepted values (hard-validated against the 3-id allowlist, §3.6, rejecting any `-codex` suffix before ever shelling out); effort defaults to `high` for `implement` (per Theo/ChaseAI's contested-vs-`xhigh` finding, §4 table) and `xhigh` only for `ask` (matches the existing, working reviewer precedent for bounded single-shot tasks).

**How output is captured and returned:** every invocation uses `-o <final.txt>` as the mandatory contract (§3.5). `implement` mode additionally passes `--json` and tees stdout to a per-run log for later parsing of `item.completed` (`file_change`, `command_execution`) events into the telemetry record (§5.6). The skill reads `-o`'s file, and for `implement` mode **independently runs `git status`/`git diff` inside the worktree** — Codex's self-reported summary is never trusted as the sole evidence of what changed (matches RULES.md's "External Verification" requirement). The diff is shown to the user before any merge step.

**Interaction with `plan-to-ralph-enforcer`:** this is a real governance gray area, flagged rather than silently resolved. `plan-to-ralph-enforcer` blocks direct `Edit`/`Write` on code files after `ExitPlanMode` unless Ralph is active — but `/codex --implement` never calls `Edit`/`Write`; it shells out via `Bash` to a separate agent (`codex-worker`) that does its own writes inside its own sandboxed process. Mechanically this bypasses the enforcer entirely (Bash isn't gated by it), but *conceptually* it satisfies the enforcer's actual intent — "Ralph orchestrates → agents implement, Claude itself doesn't touch code directly" — since `codex-worker` **is** an agent-shaped delegation, just not one routed through the `Task` tool. Recommendation (also listed as an open decision, §8): treat `/codex --implement` as agent-equivalent and **allow it post-plan-approval without requiring Ralph**, on the basis that a human still explicitly confirms the `workspace-write` invocation each time (§5.1 confirm-gate) — but surface this reasoning to Dave rather than assuming it, since it's a genuine gap in the existing hook logic, not something those hooks were designed to reason about.

**Interaction with `destructive-command-guard`:** the `codex exec ...` command line itself passes through the guard like any other Bash call and is not itself a destructive pattern (not `rm -rf`, not `git reset --hard`, etc.), so it is never denied by that hook. **Critically, the guard cannot see or gate anything Codex does *inside* its own sandboxed shell tool** — that boundary is enforced solely by `--sandbox`/`--add-dir`/`writable_roots`, not by any Claude-Code-side mechanism. This must be stated plainly in the safety rule (§5.4) so nobody assumes double coverage that doesn't exist.

### 5.2 Agent: new `codex-worker`, not a mode on `codex-adversary`

Per internal-A's reuse-vs-replace call: reuse the **envelope pattern** (parse request → assemble context → build prompt file → invoke with justified flags → `-o` clean-capture → structured return), but as a **separate agent file**, `.claude/agents/codex-worker.md`, because read-only-critique and write-capable-execution have too-different safety defaults to share one hardcoded-flags file. `codex-adversary.md` stays exactly as-is.

**Flag matrix** (codex-worker's internal decision table, mirrors §5.1):

| Input mode | `--sandbox` | `--model` (validated) | `-c model_reasoning_effort=` | `--disable multi_agent` | `--ephemeral` | `-C` target |
|---|---|---|---|---|---|---|
| ask | `read-only` | `gpt-5.5` default | `high` (or `xhigh` on request) | always | yes | project root |
| implement | `workspace-write` | `gpt-5.5` default | `high` | yes (unless `--complex` + verified pin) | no | isolated worktree path (§5.3) |
| resume | inherited (resume takes NO `--sandbox`) | inherited | inherited | inherited | n/a | **cd into worktree** (resume takes NO `-C`) — verified 2026-07-07 dogfood |

Every invocation additionally carries `--skip-git-repo-check` (worktrees are real git dirs so this is usually a no-op safety net, not load-bearing) and stdin is always fed from a prompt **file** (`- < "$PROMPT_FILE"`), never an inherited TTY, per the Windows hang-bug mitigation (§3.8).

### 5.3 Config/plumbing

- **Guaranteeing subscription auth at call time:** the agent's spawn step explicitly unsets `OPENAI_API_KEY` and `CODEX_API_KEY` from the child process environment before invoking `codex exec` (defensive — docs themselves warn *"Do not set `OPENAI_API_KEY` or `CODEX_API_KEY` as a job-level environment variable in workflows that check out or run repository-controlled code"*), and asserts `codex login status` reports `Logged in using ChatGPT` as a preflight check, failing loudly (not silently falling back to an API key path) if it doesn't.
- **Isolated worktree scope (default for `implement`):** **[UPDATED — v0 dogfood moved worktrees OUT of the repo; see §10/§11. The in-repo path in the original design was superseded.]** Worktrees are a **sibling of the repo** (`../.codex-worktrees/<repo>-<ts>-<pid>`), never inside `$PROJECT`:
  ```bash
  TS="$(date +%Y%m%d-%H%M%S)-$$"                        # -$$ (pid) avoids same-second collisions
  WT_BASE="$(dirname "$PROJECT")/.codex-worktrees"      # SIBLING of the repo, NOT under it
  WORKTREE="$WT_BASE/$(basename "$PROJECT")-$TS"
  git -C "$PROJECT" worktree prune                       # GC metadata for manually-removed worktrees
  git -C "$PROJECT" worktree add "$WORKTREE" -b "codex/$TS"
  # invoke codex exec with -C "$WORKTREE"
  # after: git -C "$WORKTREE" add -A && git -C "$WORKTREE" diff --cached HEAD   # present the patch to the user
  # on approval: git -C "$PROJECT" apply --3way <patch>; always: git -C "$PROJECT" worktree remove --force "$WORKTREE"
  ```
  Being outside the repo, worktrees need **no** `.gitignore` entry — the `.codex-worktrees/` line is kept only as a harmless backstop against an accidental in-repo path — and they cannot pollute Claude Code's skill scan (one of the two in-repo failures §10 fixed). This sidesteps the `file_claims` DB entirely (no concurrent-edit collision possible against an isolated worktree). `--in-place` (§8) was **dropped in v2** (Dave-approved) — worktree isolation is the retained safety win.
- **[Superseded 2026-09-03 — the pin is now `gpt-5.6-luna`; see §16, which also finds the pin's effect UNVERIFIED. Left as written because it records the July design.]** **`multi_agent` handling:** default `--disable multi_agent`. The `--complex` opt-in requires `~/.codex/agents/explorer.toml` to already have `model = "gpt-5.5"` pinned (the documented 2026-06-01 mitigation) — the skill checks this file exists and contains the pin before honoring `--complex`, and prints a standing caveat every time it's used: *"Windows subagent TOML pinning is unverified on this host per `openai/codex#19399` — re-verify with a probe before trusting `--complex` unattended."*
- **Profile overlay (v1+):** ~~`--profile-v2 worker` layering `$CODEX_HOME/worker.config.toml` to disable the 16 noisy MCP-server connection attempts specifically for worker invocations, without touching Dave's interactive config.~~ **REFUTED in v1 (2026-07-07) — see §11.** `--profile-v2` layering deep-merges, so an empty `[mcp_servers]` overlay (and `-c mcp_servers={}`) does NOT remove the base MCP servers. The confirmed replacement is **`--ignore-user-config`** (skips the whole base config where the MCP servers live; ~47s→18s; no machine-local file).

### 5.4 Safety rule: new `.claude/rules/codex-worker-safety.md`

A **sibling** to `codex-adversarial.md`, not an extension of it (materially different safety posture: write vs. read-only). Cross-referenced from `codex-adversarial.md` with a one-line pointer. Contents:

- **Confirm-first matrix:** `ask` mode = no confirmation needed (read-only, matches today's reviewer). `implement` mode = confirm-first on every invocation showing the exact `codex exec` command line, target worktree, and model/effort. `--complex` = additional confirm + the pinning caveat above. `danger-full-access` / `--dangerously-bypass-approvals-and-sandbox` = confirm-first, never default-on, identical posture to the existing rule.
- **Git-clean gate:** before creating a worktree, verify the base branch has no uncommitted changes that would be silently excluded from the worktree's view (a worktree shares the same object store but starts from a commit, not the working tree's uncommitted state) — warn the user if HEAD has pending changes they might expect Codex to see.
- **Writable-root scoping:** `implement` mode's `-C` is *always* the worktree path; `--add-dir` is only added for genuinely shared scratch space (e.g. a scratchpad dir), never the live repo root, for v0/v1.
- **Network policy:** `network_access` stays at its default `false`; enabling it requires an explicit flag and a confirm, since prompt-injection via fetched content is a named risk in official docs.
- **Model allowlist enforcement:** hard-reject any `--model` value not in `{gpt-5.5, gpt-5.4, gpt-5.4-mini}` before ever shelling out, citing the verified 400 evidence (§3.6) in the rejection message.
- **Stdin discipline:** always `- < "$PROMPT_FILE"`, never bare positional prompt text long enough to matter, never an inherited TTY (§3.8).
- **Quota awareness (v2):** parse `codex doctor --json` or the last `--json` turn's `.usage` before a long `implement` run and warn if usage looks close to a rolling-window or weekly cap, per the two-clock quota model and the known unresolved regression (`openai/codex#28879`).
- **`~/.codex/hooks.json` collision:** explicitly documents the open question and the partial `unified_exec`-bypasses-`PreToolUse` mitigation, states the required spike (§6) as a hard prerequisite before v1 ships `implement` mode for anything beyond a throwaway fixture.
- **Review-gate discipline:** codifies the strongest cross-source consensus finding — `implement` mode never auto-commits/auto-merges into the main working tree; it produces a worktree diff that a human (or a second, independent verification step) reviews before it's applied.

### 5.5 Telemetry: new `.claude/logs/codex-worker.jsonl`

Distinct from `codex-lift.jsonl` (that schema is specifically claude/codex/both *comparison* counts for review lift — wrong shape for a task-execution log). New schema, one row per invocation:

```json
{
  "ts": "2026-07-06T14:32:00Z",
  "mode": "implement",
  "model": "gpt-5.5",
  "effort": "high",
  "sandbox": "workspace-write",
  "multi_agent": false,
  "scope": "worktree",
  "worktree_path": "C:/.../.codex-worktrees/20260706-143200",
  "task_summary": "add pagination to the report registry query",
  "exit_code": 0,
  "wall_clock_s": 187.4,
  "tokens": { "input": 41200, "cached_input": 6100, "output": 3400, "reasoning_output": 900 },
  "files_changed": ["scripts/report-registry/query.mjs"],
  "git_diff_stat": "1 file changed, 22 insertions(+), 3 deletions(-)",
  "verification": "diff_reviewed_and_merged",
  "session_id": "019f3987-...",
  "via": "claude-code"
}
```
Companion `.claude/logs/codex-worker.README.md` documents the schema (mirrors the existing `codex-lift.README.md` convention).

### 5.6 Registration

- **`skill-rules.json`:** add `/codex` as an explicit slash-command entry with **no auto-trigger keywords** — matches the deliberate manual-invoke-only convention already used for `/review`/`/premortem`.
- **`settings.json`:** no new `PreToolUse` hook is added to *gate* Codex's internal behavior — per §2/§4, no hook can see inside Codex's own sandboxed process. An **optional, non-blocking audit hook** (v1+) can log (never deny) any Bash call matching `codex exec.*workspace-write` to `.claude/audit/YYYY-MM-DD.log` for visibility, consistent with RULES.md's "destructive operations → log" convention — this is visibility, not enforcement, and must be documented as such so nobody mistakes it for a safety gate.
- **Windows specifics:** invoke via the Bash tool exactly as `codex-adversary` already does (stdin-file redirect, proven to work cleanly in this session's verification runs) — do **not** reach for Node's `child_process.spawnSync` for v0/v1; if a future version needs Node-native invocation, re-apply the `windows-platform.md` codegraph lesson (invoke the real JS entrypoint directly via `process.execPath`, array args, no `shell:true`) rather than assuming Bash-tool parity.

---

## 6. Safety & Cost Model on the Subscription

**Default sandbox:** `read-only` for `ask`, `workspace-write` (worktree-scoped) for `implement`. `danger-full-access` never defaulted, always confirm-gated.

**Default approval:** moot — `codex exec` has no approval concept (§3.1). The *design's* approval gate lives entirely in the skill's confirm-first preflight, not in any Codex flag.

**Quota/rate-limit reality (community-sourced, [§4.4](#44-community-github-issues-blog-writeups-gists--verified-unless-marked-otherwise)):** two independent clocks — a rolling 5-hour message window and a separate weekly cap resetting 7 days from the week's first message. The 5h meter can show healthy remaining capacity while the weekly budget is already exhausted; a single multi-file `gpt-5.5` implement run (~250k in / ~25k out tokens, order-of-magnitude community estimate) can be a meaningful fraction of a Plus-tier weekly allowance. An **unresolved** upstream regression (`openai/codex#28879`) reports 10-20x per-token rate-limit cost inflation since mid-June 2026 for some accounts. **Design response:** the safety rule requires a quota check (`codex doctor --json` or last `.usage`) before any `implement` run beyond v0's smallest scope, and the telemetry log records token usage per run so a running weekly total can be reconstructed if needed.

**Kill/timeout:** rely on the calling process's own timeout (Claude Code's Bash tool timeout, or an external `timeout` wrapper) rather than trusting Codex's internal handling — this is explicit community guidance given the documented Windows stall bugs (`#18983`, `#20200`) where Codex itself doesn't reliably self-terminate a stuck run.

**Cost is NOT dollars** — there is no per-call price to log; the only "cost" that matters is subscription-quota consumption (tokens + session-hours-equivalent against the 5h/weekly caps), tracked via the telemetry log's `tokens` field, not a dollar ledger like the CMA safety rule's `.claude/logs/cma-spend.jsonl`.

---

## 7. Phased Build Plan

### v0 — Minimal working `/codex`

**Artifacts to create:**
- `.claude/agents/codex-worker.md` (ask + implement modes only; no resume, no `--complex`)
- `.claude/skills/codex/SKILL.md` (`/codex <request>`, `--implement` flag switches mode; defaults to `ask`)
- `.claude/rules/codex-worker-safety.md`
- `.claude/logs/codex-worker.jsonl` + `.claude/logs/codex-worker.README.md`
- `.codex-worktrees/` added to `.gitignore` (v0; worktrees were later moved OUTSIDE the repo per §10, so this entry is now a vestigial backstop — see §5.3)
- Registration in the relevant `skill-rules.json` (slash-command only, no keywords)

**Acceptance criteria:**
1. `/codex "explain how the report-registry upsert works"` returns a clean answer sourced from `-o`'s file, `read-only` sandbox, no confirm prompt.
2. `/codex --implement "create a file scratch/hello.txt containing HELLO"` — skill shows the exact command line + target worktree, waits for explicit confirmation, creates the worktree, invokes Codex with `workspace-write`, independently runs `git diff` inside the worktree, and shows the diff to the user before offering to merge or discard.
3. Any `--model` value other than `gpt-5.5`/`gpt-5.4`/`gpt-5.4-mini` is rejected before any `codex exec` call is made, with a message citing the verified 400 evidence.
4. A telemetry row is written for both runs above with the correct schema.

### v1

**Artifacts to create/edit:**
- Add `resume` mode to `codex-worker.md` and the skill (`/codex --resume <followup>`)
- Extend telemetry to parse `--json` events into `files_changed`/token usage (richer than v0's diff-stat-only)
- Add the `--profile-v2 worker` config overlay (`$CODEX_HOME/worker.config.toml`) disabling noisy MCP servers for worker calls only
- **Run the required `~/.codex/hooks.json` collision spike** in a dedicated throwaway git fixture (not this repo) — confirm or deny whether git-auto-commit/sync-to-repo/file-claims entries fire under `codex exec`'s `unified_exec` path; document the result in `.claude/rules/windows-platform.md`-style evidence format
- Optional non-blocking audit hook (`.claude/audit/YYYY-MM-DD.log`) logging `workspace-write` invocations for visibility

**Acceptance criteria:**
1. `/codex --implement "..."` followed by `/codex --resume "also add a test for that"` correctly continues the same Codex thread and the same worktree.
2. The hooks-collision spike produces a written, evidenced verdict (not a guess) that either clears `implement` mode for direct repo use or confirms worktree isolation must stay mandatory.
3. Worker-profile MCP noise reduction is measured (wall-clock before/after) and documented.

### v2

> **RECON DONE 2026-07-07 — scope narrowed. See `V2-HANDOFF.md` (the authoritative build brief) + `V2-KICKOFF-PROMPT.md`.** The original list below is superseded by the approved **lean scope**: (1) `--complex` — **probe-verified viable** (explorer.toml `gpt-5.5` pin honored on Windows, no gpt-4.1 trap; #19399 does not reproduce); (2) reactive usage-limit handling — **quota preflight REFUTED** (`codex doctor --json` has no quota/usage surface); (3) worktree GC automation; (4) doc sweep (this §7 + §5.3 in-repo-gitignore staleness IS that sweep). **OUT (Dave-approved):** `--in-place` (worktree isolation kept) + the `codex-plugin-cc` writeup (bespoke decided; plugin used for review). Open interaction for the build session: does `--enable multi_agent` honor `explorer.toml` under the worker's default `--ignore-user-config`? (verify after quota reset).

**Artifacts to create/edit (original scope — see the recon banner above for what actually ships):**
- `--complex` opt-in enabling `multi_agent` for genuinely broad tasks, gated behind the `explorer.toml` pin check + a fresh Windows-specific re-verification probe of `openai/codex#19399`
- Quota-awareness preflight (`codex doctor --json` parse + weekly-cap warning)
- `--in-place` mode for trusted, git-clean repos (still confirm-gated) as an alternative to worktree isolation, per the open decision in §8
- Formal evaluation of installing the real `openai/codex-plugin-cc` plugin vs. keeping the bespoke skill/agent, written up as a short comparison doc
- (Stretch) spike the Python `openai-codex` SDK's "automatic authentication" path as an alternative to shell-out, once open question #1 (`CODEX_API_KEY` injection ambiguity in the TS SDK) is resolved — only worth doing if shell-out proves to have a real limitation the SDK solves

**Acceptance criteria:**
1. A `--complex` run against a genuinely multi-file exploratory task completes without a `gpt-4.1` rejection, with the explorer-pin verification banner shown.
2. ~~Quota preflight correctly warns...~~ **REFUTED** — reframed to reactive usage-limit-error handling (detect + surface reset time + telemetry flag); preflight is impossible (no quota surface).
3. A written recommendation exists on plugin-vs-bespoke, with a clear decision recorded — **DONE** (bespoke for writes; plugin complements review, already used).

---

## 8. Open Decisions for Dave

**1. Default `implement` scope: isolated git worktree vs. write-in-place to the live repo.**
- *Options:* (a) worktree-isolated by default (this doc's recommendation), requiring an explicit merge step; (b) write directly into the shared working tree with only a git-clean-gate + confirm.
- *Recommendation:* (a). Rationale: strongest cross-source consensus in this entire research pass is "review-gate before merge, never let headless writes land directly" (§4.4); worktree isolation is the only pattern found that structurally prevents collision with the concurrent Claude Code session's own edits and the `file_claims` coordination DB, without needing new DB-awareness code in `codex-worker`. Tradeoff: extra ceremony (worktree create/remove, merge step) for every `implement` call, even trivial ones — a v2 `--in-place` opt-in was proposed to relieve this for trusted, small, git-clean-repo cases, but was **dropped in v2** (see the §7 recon banner); worktree isolation is retained as the safety win.

**2. Autonomy: confirm-gate every `implement` call vs. allow a Ralph-style `--yes` full-auto path.**
- *Options:* (a) always confirm-first, no exceptions; (b) allow an explicit `--yes` flag for orchestrator-driven calls (e.g. from a Ralph loop) that skips the interactive confirm but still logs and still worktree-isolates.
- *Recommendation:* (b), narrowly scoped. A hard "always confirm" rule would make `/codex --implement` unusable from any autonomous orchestration context (Ralph, scheduled jobs), which contradicts the stated goal of a general-purpose delegated worker. The worktree isolation (decision 1) plus mandatory telemetry plus the merge-step-stays-separate design keep `--yes` from being equivalent to unrestricted access — it only skips the interactive pause, not the sandbox boundary or the review step.

**3. Model: `gpt-5.5` vs. any codex-tuned variant.**
- *Options:* (a) `gpt-5.5` only, hard-block anything `-codex`-suffixed; (b) attempt to surface `gpt-5.3-codex-spark`/similar per official docs' model table.
- *Recommendation:* (a), non-negotiable given the empirical evidence (§3.6) — two different `-codex` ids both produced byte-identical 400s under this exact account's ChatGPT auth. If Dave's account or a future CLI version genuinely supports a codex-tuned variant, that must be re-verified live before it's ever added to the allowlist — never trust the docs' model table over an account-specific 400.

**4. Write-to-repo-directly vs. propose-a-patch.**
- *Options:* (a) `implement` mode always produces a mergeable worktree diff for human review (this doc's default, folded into decision 1); (b) `implement` mode auto-applies changes and auto-commits, trusting Codex's own judgment.
- *Recommendation:* (a) — this is really the same consensus finding as decision 1, restated: patch-as-artifact, not auto-merge, defends against prompt-injection via any content Codex might read (commit messages, issue text, fetched web content if network is ever enabled) that could otherwise steer it into a malicious auto-committed change.

**5. Headless-only vs. interactive-capable.**
- *Options:* (a) `/codex` is purely headless (`codex exec`/`codex exec resume`), no TUI attach; (b) also support a live-attach mode where Dave can watch/steer a Codex session interactively from within a Claude Code session.
- *Recommendation:* (a) for all of v0-v2. `codex exec`'s autonomous-by-construction nature (§3.1) is exactly what makes it safe to reason about from inside a skill/agent; attaching to an interactive TUI session from an agent context is a different (and significantly more complex, e.g. `app-server`-based) architecture that official docs explicitly steer *away from* for automation use cases. Revisit only if a concrete need for live human steering mid-task emerges.

**6. How `/codex` relates to the existing `codex-adversary` reviewer.**
- *Options:* (a) two fully separate agents/skills (`codex-adversary` for `/review`/`/premortem`, `codex-worker`+`/codex` for everything else), sharing only the envelope *pattern*, not files; (b) unify into one agent with a mode flag; (c) have `/codex --review` delegate internally to the existing `codex-adversary` agent rather than reimplementing review logic.
- *Recommendation:* (a) for the core split (matches internal-A's explicit reuse-vs-replace call and this doc's decision #4 in §1), with **(c) as an implementation detail** — `/codex`'s skill can offer a `--review` alias that simply invokes the existing `codex-adversary` agent unchanged, giving users one mental entry point (`/codex`) without duplicating the reviewer's carefully-tuned read-only flag set.

**7. (Bonus, surfaced by research, not in the required list) Adopt the official `openai/codex-plugin-cc` plugin vs. keep the bespoke skill/agent.**
- *Options:* (a) install the plugin fully and build guardrails around `/codex:rescue`; (b) build bespoke as designed in §5, treating the plugin as reference architecture only.
- *Recommendation:* (b) for v0-v1, with (a) as a formal v2 evaluation item. Rationale: the plugin is not installed today (only a vendor prompt fragment exists), its job-lifecycle shape is confirmed valuable as a *reference*, but installing it wholesale introduces an unaudited surface (its own hooks, its own skill-loading behavior, unverified Windows behavior) without the benefit of this doc's already-completed verification work against the exact installed CLI version. Building bespoke first, informed by the plugin's shape, is lower-risk; formally comparing the two once the bespoke version is proven (v2) avoids a premature commitment either way.

---

## 10. v0 Dogfood Findings & Hardening (2026-07-07)

v0 was dogfooded through the real `codex-worker` agent (ask + implement+resume + adversarial judge, workflow `wf_d9dd538b-673`). **Scores: ask 5/5, implement 5/5, resume 5/5, safety-contract 4/5, performance 3/5** — all three modes functional, worktree isolation airtight, live tree provably untouched, subscription-only (no API key) confirmed. Findings, all independently verified on disk:

**Fixed in v0:**
- **[HIGH] `codex exec resume` has no `--sandbox`/`-C`.** It inherits the resumed session's cwd+sandbox; `--last` is cwd-scoped → must `cd` into the worktree, not pass `-C`. Passing `--sandbox` errors RC=2. `codex-worker.md` Step 3c corrected.
- **[HIGH] Windows `workspace-write` sandbox blocks ALL subprocess launches** (`CreateProcessAsUserW failed: 5`). Codex can create/edit files but cannot run git/node/tests inside its sandbox — it writes code BLIND and self-reports "done" without executing it (the generated `preflight.mjs` had a real `spawnSync` ENOENT bug Codex never caught). Verification must RUN changed code, not just `node --check`. Documented in agent + safety rule; the verification step was upgraded.
- **[HIGH] In-repo worktrees pollute the skill list** — a worktree under `$PROJECT` makes Claude Code re-scan `.claude/skills` as ~150 duplicate path-scoped skills, plus a ~190MB / 3,079-file full checkout. Worktrees relocated OUTSIDE the repo (sibling `../.codex-worktrees/<repo>-<ts>-<pid>`); verified git accepts the out-of-repo path.
- **[MED] Worktree name second-resolution collision** → `-<pid>` suffix added.

**Deferred to v1/v2 (tracked):**
- **[MED] Telemetry schema drift** — the dogfood's combined `implement+resume` run emitted non-enum `mode`/`scope`/`verification`. Real single-mode runs conform; tighten emit to always use enums + log one row per turn (v1).
- **[MED] Worktree excludes uncommitted files** (branches from HEAD) — git-clean note should surface *which* files are excluded (v1).
- **[MED] No explicit Codex session-id capture** — `resume --last` is cwd-scoped global state, fragile under concurrency; capture the session id from the implement turn's `--json` `thread.started` event and thread it into `resume` + telemetry (v1).
- **[LOW] Worktree GC** (~190MB each; prune policy documented, automate in v1). **[LOW] `wall_clock_s` decomposition** — checkout vs model vs startup-noise (v1).

**Net:** v0 is functional and hardened for all 3 HIGH issues. The single most valuable dogfood lesson — *Codex on Windows writes code it literally cannot run* — makes the orchestrator's out-of-sandbox "actually run it" verification non-optional, not a backstop.

**v1 hooks-collision spike — RESOLVED (2026-07-07):** the `~/.codex/hooks.json` mirror does NOT cause commit/`file_claims` collisions under `codex exec --sandbox workspace-write`. Throwaway-fixture evidence: the file was created but NOT auto-committed (commits `1→1`, stayed untracked), and `file_claims` was unchanged (`7481→7481`, no fixture rows); only Codex's own `SessionStart`/`UserPromptSubmit` hooks fired (mostly failed), with no PostToolUse git/DB side effects. Tested in-place (worst case) → worktree-isolated `implement` is doubly safe. This clears the one open safety prerequisite; details in `codex-worker-safety.md` → "Hooks-collision question — RESOLVED".

## 11. v1 Build Findings (2026-07-07)

v1 (session-id capture + startup-latency + cleanups) built on `feature/codex-worker`. Two load-bearing CLI verifications on the installed `codex-cli 0.131.0`, then wired the confirmed mechanisms.

**Item A — session id: CONFIRMED (with a field correction).** The `--json` stream's FIRST event is `{"type":"thread.started","thread_id":"<uuid>"}` — the id field is **`thread_id`**, not `session_id` (internal-B named the event right, the field wrong). `codex exec resume <UUID>` accepts it positionally ("Conversation/session id (UUID) or thread name"). Wired: implement/resume capture `thread_id` from the `--json` log via `grep -m1 thread.started | sed`, thread it into `resume <id>` and telemetry (`scope:"resume:<id>"` + `session_id`). **Live acceptance (read-only sessions, shared cwd; sandbox is orthogonal to the property):**

| run | sequence | result |
|-----|----------|--------|
| resume **by-id(A)** | A="ALPHA-42" → B="BETA-99" (newer) → resume `<A-id>` | **ALPHA-42** — exact thread despite B newer ✓ |
| resume **--last** (clean control) | C="GAMMA-1" → E="DELTA-2" (newer) → resume `--last` | **DELTA-2** — targets most-recent (the wrong thread) ✓ |
| resume **by-id(C)** (same control) | …then resume `<C-id>` | **GAMMA-1** — exact thread despite E newer ✓ |

Conclusion: resume-by-captured-id is concurrency-safe; `--last` is cwd-global "most recent" and picks the wrong thread when any `codex` run intervenes (Ralph / parallel use). (First-pass control was contaminated by running by-id before `--last`; re-run with `--last` first is the clean proof above.)

**Item B — latency: the design-doc §5.3 approach was REFUTED; `--ignore-user-config` replaced it.** A/B benchmark (identical low-effort read-only ask; delta = mute mechanism):

| mechanism | wall | MCP-fail | skill lines | stderr |
|---|---|---|---|---|
| baseline | 47s | 6 | 106 | 112 |
| `--profile-v2 worker` + empty `[mcp_servers]` | 79s | **6** | 106 | 112 |
| `-c mcp_servers={}` | 62s | **6** | 106 | 112 |
| **`--ignore-user-config`** | **18s** | **2** | 106 | **108** |

`--profile-v2` (and `-c mcp_servers={}`) deep-merge the overlay, so they do NOT remove the base's 16 `[mcp_servers.*]` — MCP-fail count unchanged from baseline. **`--ignore-user-config`** skips the whole base config (where the MCP servers live), cutting cold-start ~47s→18s and MCP-fails 6→2 (2 residual sourced from plugins/runtime, not `config.toml`); auth still uses `CODEX_HOME` (rc=0, correct answer). Single flag, no machine-local file — more portable than the planned overlay. The **skill-YAML scan (106 lines) is untouched by every mechanism but is cheap (~6ms)** — it is log noise, not the latency bottleneck; the bottleneck was config-driven MCP network handshakes. Wired: `--ignore-user-config` on every worker `codex exec`/`resume`; no `worker.config.toml` created. Tradeoff (documented in `codex-worker-safety.md`): Codex's shell loses `shell_environment_policy.set` extras — moot on Windows (`workspace-write` can't spawn subprocesses); re-supply via `-c` if ever needed.

**Cleanups:** telemetry now emits **one row per turn** with enum-only `mode`/`scope`/`verification` + a `session_id` field (v0 drift being fixed: a combined `implement+resume` row, non-enum `ephemeral`/`human-verified-citations`/freeform values); git-clean now surfaces the exact "excluded from worktree" file list in the returned summary.

**v1 dogfood hardening (2026-07-07, workflow `wf_38e68933-765`):** the v1 commit was dogfooded through the live `codex-worker` agent (ask → exit 0, `--ignore-user-config` + enum-conformant telemetry confirmed) + a Claude wiring audit (11/11 hard constraints intact, live telemetry row conformant) + a cross-model `codex-adversary` pass. The adversarial pass earned real cross-model lift — it **empirically proved two bugs in the just-written v1 code**, both fixed before finalizing:
1. The "excluded from worktree" list used `awk '{print $2}' | paste -sd', '`, which **truncates spaced paths** (`?? src/has space/x.ts` → `src/has`) and **cycles the delimiter's characters** (`paste -sd', '` → `a,b c,d`, not `a, b, c, d`). Replaced with a whitespace-safe `sed` (strip XY + rename-arrow) + `awk`-printf join.
2. The resume contract invited the literal `SESSION_ID="last"`, but `codex exec resume last` **silently starts a NEW disconnected session** (exit 0, wrong thread — Codex verified vs a nonexistent UUID which errors loudly). Added a UUID guard (non-UUID → `--last`) and reworded the Step 1 / skill contract to "leave EMPTY for fallback."

Also hardened: resume now captures its own `RC` (the resume telemetry row's `exit_code` was stale), re-passes `--model` (constraint-6 precision), and the `thread_id` capture uses `grep + jq` (whitespace/field-order robust) instead of `grep + sed`; the telemetry variable seam (`SID`/`REQUEST_SUMMARY`/`DIFFSTAT` vs `SESSION_ID`/`REQUEST`) was reconciled so implement/resume rows actually populate `session_id`. Each shell fix was re-verified on synthetic inputs before wiring.

## 12. v2 Build Findings (2026-07-07)

v2 shipped the approved **lean scope** (4 items) AND — via mandated dogfooding — surfaced and fixed a **latent v1 regression that had silently broken every `implement` write**. Branch `feature/codex-worker-v2`. Built during a ChatGPT-quota-down window (non-Codex items first), then gated on the ~1:08 PM reset for the live/cross-model passes.

**The four items (all verified):**
- **Item 1 — `--complex` (multi_agent).** Opt-in that swaps `--disable`→`--enable multi_agent` for ask/implement, gated on `~/.codex/agents/explorer.toml` pinning `model = "gpt-5.5"` (regex accepts single- or double-quoted TOML; rejects `gpt-5.5-codex`/commented pins). **Live probe (decisive):** `--enable multi_agent --ignore-user-config` spawned an explorer that ran on **gpt-5**, ZERO gpt-4.1 400s — so `explorer.toml` (in `~/.codex/agents/`, not `config.toml`) IS honored even under `--ignore-user-config`. Mode-scoped to ask/implement (resume never re-fans-out); telemetry `multi_agent` reflects the actual flag (`MULTI_AGENT_ON`), not the raw request.
- **Item 2 — reactive usage-limit handling.** Preflight is impossible (`codex doctor --json` has no quota surface). All modes grep the log for `You've hit your usage limit … try again at <time>` (the `-o` clean file is EMPTY on a cap hit), short-circuit with a clean message (never a fabricated result), and log `usage_limited:true` + non-zero exit. Parser verified against the **real captured error** (the quota-down window handed us a genuine sample) + synthetic cases.
- **Item 3 — worktree GC.** Opportunistic reclaim before each implement, of THIS repo's CONFIRMED-CLEAN worktrees older than `$CODEX_WT_GC_DAYS` (default 7d). **Never touches unreviewed work** — implement only stages (never commits) → a dormant/awaiting-resume worktree is dirty → skipped; the skip is exit-code-checked, so a broken/unreadable worktree is kept, not deleted. No `rm -rf` in the auto path (removal only via `git worktree remove`; orphans reported). Fixture-verified across clean/dirty/broken/orphan/recent + `CODEX_WT_GC_FORCE_DIRTY`.
- **Item 4 — doc sweep.** §5.3/§7/§8 + the safety rule/skill corrected to the out-of-repo worktree reality and the dropped `--in-place`.

**Headline finding — `--ignore-user-config` silently broke every `implement` write (v1 regression).** The v1 latency fix (`--ignore-user-config`, ~47s→18s) was applied to EVERY worker call but only ever verified on a read-only `ask` smoke. The v2 live implement dogfood + an independent A/B proved it makes Codex's **workspace-write sandbox silently reject file writes on Windows** (`config.toml` carries the sandbox writable-root/approval policy): `exit 0`, ZERO diff — a no-op that looks like success. **Fix: `--ignore-user-config` is now `ask`-ONLY**; implement/resume drop it (mode-scoped `CFG_FLAG=""` + re-default fallback) and take the slower cold-start for a working write. Confirming re-dogfood: implement created the file (`1 file changed`, byte-verified), command line confirmed free of the flag.

**Review cascade (four passes, every finding fixed + re-validated):**
1. **Claude wiring audit** — 8 findings, incl. a **CRITICAL** GC data-loss (the "in-flight = recent" safety claim was false for the dormant awaiting-resume state → skip-dirty), a guard-landmine (`rm -rf` in a comment the destructive-guard matches), `--complex` mode-scope, single-quote regex, `COMPLEX` normalization.
2. **Cross-model codex-adversary (gpt-5.5 xhigh) on the diff** — 4 findings: a **regression I'd introduced** (parameterizing the invocation flags made a split-shell run silently drop `--disable multi_agent`/`--ignore-user-config` → defensive re-default + same-shell instruction), skip-dirty swallowing git-status's exit code, the script's recursive-delete fallback routing a delete around the guard (dropped entirely), and a low-probability GC race (mitigated by the age filter).
3. **Item 1 live probe** — explorer spawns on gpt-5, no gpt-4.1.
4. **Live dogfoods** — ask `--complex` (plumbing: gate + `--enable` + telemetry `multi_agent:true`, no 400) and implement (surfaced the write-bug, then confirmed the fix).

**Deferred to v3 (premortem findings — acceptable-as-designed for the lean scope):** version+hash-keyed `--complex` re-verification (today's failure is a loud 400, not silent); `subagents_spawned`/`subagent_models` telemetry (current `multi_agent` = fan-out ENABLED, not spawned — clarified in the README); a local burn-rate heuristic before expensive runs; fail-loud-on-split-shell `--complex` (currently degrades safely + a same-shell instruction); a keep/resume GC sentinel (committed work already survives as a branch, so low impact).

## 9. Sources Appendix

### Internal-A (current-state audit)
- `C:/Users/david.hayes/continuous-claude/.claude/skills/review/SKILL.md`
- `C:/Users/david.hayes/continuous-claude/.claude/skills/premortem/SKILL.md`
- `C:/Users/david.hayes/continuous-claude/.claude/hooks/src/plan-exit-premortem-prompt.ts`
- `C:/Users/david.hayes/continuous-claude/.claude/hooks/src/plan-exit-tracker.ts`
- `C:/Users/david.hayes/continuous-claude/.claude/agents/codex-adversary.md`
- `C:/Users/david.hayes/continuous-claude/.claude/logs/codex-lift.README.md` + `.jsonl`
- `C:/Users/david.hayes/continuous-claude/vendor/codex-plugin-cc/prompts/adversarial-review.md`
- `C:/Users/david.hayes/.codex/AGENTS.md`
- `C:/Users/david.hayes/.codex/hooks.json`
- `C:/Users/david.hayes/.claude/settings.json`, `settings.local.json`, `.claude/skill-rules.json`, `.claude/plugins/installed_plugins.json`, `known_marketplaces.json`
- Report: `scratchpad/codex-research/internal-a-current-state.md`

### Internal-B (CLI surface characterization)
- Live probes: `codex --help`, `codex exec --help`, `codex exec resume --help`, `codex exec review --help`, `codex resume --help`, `codex mcp --help`, `codex features --help`/`list`, `codex doctor --help`/`--json`
- `~/.codex/models_cache.json`, `~/.codex/config.toml`
- Report + evidence files: `scratchpad/codex-research/internal-b-cli-surface.md`

### External — Theo (t3.gg)
- [A realistic comparison of Opus and Codex](https://www.youtube.com/watch?v=1SJGGUeEbQs) (2026-02-17)
- [Never mind (OpenAI won again)](https://www.youtube.com/watch?v=RYWrK2hsIB8) (2026-02-06)
- [Claude Code vs Codex vs Cursor (an honest comparison)](https://www.youtube.com/watch?v=JMYspR42HFM) (2026-05-26)
- [x.com/theo/status/2072481845363822914](https://x.com/theo/status/2072481845363822914) — Fable/Codex delegation thread
- [x.com/theo/status/2072482460122964067](https://x.com/theo/status/2072482460122964067) — CLAUDE.md follow-up
- [x.com/theo/status/2072869036615155735](https://x.com/theo/status/2072869036615155735) — T3 Code subagent bridge
- [x.com/theo/status/2030071716530245800](https://x.com/theo/status/2030071716530245800) — T3 Code launch
- [x.com/theo/status/2054737293186126056](https://x.com/theo/status/2054737293186126056) — BYO-inference
- [x.com/theo/status/2073169842379891195](https://x.com/theo/status/2073169842379891195) — install 403
- [github.com/pingdotgg/t3code](https://github.com/pingdotgg/t3code)
- Secondary (unverified): [digg.com/tech/wmowks0x](https://digg.com/tech/wmowks0x), [digg.com/tech/2spgn23x](https://digg.com/tech/2spgn23x), [steipete/agent-scripts](https://github.com/steipete/agent-scripts)

### External — ChaseAI
- 4 YouTube transcripts (Chase AI channel, `@Chase-H-AI`)
- [chaseai-yt/grill-me-codex](https://github.com/chaseai-yt/grill-me-codex) GitHub repo
- [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) README (official plugin docs)

### External — Official docs
- [Authentication](https://developers.openai.com/codex/auth) · [CI/CD auth](https://developers.openai.com/codex/auth/ci-cd-auth) · [Quickstart](https://developers.openai.com/codex/quickstart)
- [Command line options](https://developers.openai.com/codex/cli/reference) · [Non-interactive mode](https://developers.openai.com/codex/noninteractive) · [llms-full.txt](https://developers.openai.com/codex/llms-full.txt)
- [Configuration Reference](https://developers.openai.com/codex/config-reference) · [Advanced Configuration](https://developers.openai.com/codex/config-advanced) · [Sample Configuration](https://developers.openai.com/codex/config-sample)
- [Features – CLI](https://developers.openai.com/codex/cli/features) · [CLI index](https://developers.openai.com/codex/cli) · [Rules](https://developers.openai.com/codex/rules) · [AGENTS.md guide](https://developers.openai.com/codex/guides/agents-md) · [Hooks](https://developers.openai.com/codex/hooks)
- [Sandbox](https://developers.openai.com/codex/concepts/sandboxing) · [Agent approvals & security](https://developers.openai.com/codex/agent-approvals-security) · [Windows](https://developers.openai.com/codex/windows)
- [Model Context Protocol](https://developers.openai.com/codex/mcp) · [App Server](https://developers.openai.com/codex/app-server) · [SDK](https://developers.openai.com/codex/sdk)
- [Models](https://developers.openai.com/codex/models) · [Changelog](https://developers.openai.com/codex/changelog)
- [openai/codex GitHub repo](https://github.com/openai/codex) · [TS SDK README](https://github.com/openai/codex/blob/main/sdk/typescript/README.md) · [Python SDK README](https://raw.githubusercontent.com/openai/codex/main/sdk/python/README.md) · [Releases](https://github.com/openai/codex/releases) · [app-server-daemon README](https://github.com/openai/codex/blob/main/codex-rs/app-server-daemon/README.md)
- [DeepWiki: MCP Server Implementation](https://deepwiki.com/openai/codex/6.4-mcp-server-implementation-(codex-mcp-server)) (community, not first-party)
- [Introducing GPT-5.5 – OpenAI](https://openai.com/index/introducing-gpt-5-5/)

### External — Community
- [Non-interactive mode – Codex | OpenAI Developers](https://developers.openai.com/codex/noninteractive)
- [Codex CLI exec mode experiments: 81 flag/feature tests (gist)](https://gist.github.com/alexfazio/359c17d84cb6a5af12bac88fa1db9770)
- [Agent approvals & security – Codex](https://developers.openai.com/codex/agent-approvals-security)
- [Codex Exec in CI: The Practical Guide to Headless OpenAI Agents](https://www.developersdigest.tech/blog/codex-exec-ci-headless-guide)
- [Running headless Codex CLI inside Claude Code](https://amanhimself.dev/blog/running-headless-codex-cli-inside-claude-code/)
- [How to skip Codex git repository checks](https://www.simplified.guide/codex/git-repo-check-skip)
- [openai/codex-plugin-cc README](https://github.com/openai/codex-plugin-cc)
- [destructive_command_guard/docs/codex-integration.md](https://github.com/Dicklesworthstone/destructive_command_guard/blob/main/docs/codex-integration.md)
- [Using Codex with your ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan)
- [Understanding the New Codex Limit System](https://community.openai.com/t/understanding-the-new-codex-limit-system-after-the-april-9-update/1378768)
- [Codex Weekly Limit Drained?](https://ofox.ai/blog/codex-weekly-limit-drained-2026/)
- GitHub issues: [#28879](https://github.com/openai/codex/issues/28879) (rate-limit regression) · [#16893](https://github.com/openai/codex/issues/16893), [#14866](https://github.com/openai/codex/issues/14866), [#14961](https://github.com/openai/codex/issues/14961), [#15250](https://github.com/openai/codex/issues/15250) (multi_agent/gpt-4.1 class) · [#20919](https://github.com/openai/codex/issues/20919) (Windows stdin hang) · [#18983](https://github.com/openai/codex/issues/18983), [#20200](https://github.com/openai/codex/issues/20200) (Windows stalls) · [#8609](https://github.com/openai/codex/issues/8609), [#20704](https://github.com/openai/codex/issues/20704), [#13918](https://github.com/openai/codex/issues/13918) (skill-YAML noise) · [#5913](https://github.com/openai/codex/issues/5913), [#6426](https://github.com/openai/codex/issues/6426), [#16664](https://github.com/openai/codex/issues/16664) (truncation/token drain) · [#3967](https://github.com/openai/codex/issues/3967), [#19842](https://github.com/openai/codex/issues/19842) (no auto-compact)
- [Simon Willison: Use subagents and custom agents in Codex](https://simonwillison.net/2026/Mar/16/codex-subagents/)
- [Why Does a Codex Skill Exist in the Directory but Still Not Show Up? (UTF-8 BOM)](https://knightli.com/en/2026/04/29/codex-skill-not-loaded-because-of-utf-8-bom/)
- [Structured CLI Output as Pipeline Glue](https://stevekinney.com/courses/self-testing-ai-agents/structured-cli-output-as-pipeline-glue)
- Context/compaction: [Codex CLI Context Compaction Architecture](https://codex.danielvaughan.com/2026/03/31/codex-cli-context-compaction-architecture/), [Context Management Strategies for OpenAI Codex](https://iceberglakehouse.com/posts/2026-03-context-openai-codex/), [Context Compaction Deep Dive](https://justin3go.com/en/posts/2026/04/14/context-compaction-deep-dive-codex-cli-claude-code-opencode)
- [One Queue, Three Agents: Cross-Vendor Wiring](https://agentconn.com/blog/cross-vendor-agent-queue-claude-codex-chatgpt/) (single-source, unverified pattern-level)
- [Evomap: oh-my-codex agent orchestration](https://evomap.ai/blog/oh-my-codex-agent-orchestration-claude-codex) (described-architecture, worktree-isolation idea)
- [Claude Code Docs: Orchestrate subagents at scale](https://code.claude.com/docs/en/workflows)

### Verify memo (ground truth)
- Report: `scratchpad/codex-research/verify.md`
- Live commands: `codex login status`, `codex exec` smoke tests (C1), `codex exec --help`/`codex --help`/`codex exec resume --help`/`codex exec review --help` (C2), model-id 400 tests (C3), `config.toml`/`codex features list` (C4), `-o`-vs-full-output diff (C5)
- Local grounding cross-referenced: `.claude/rules/codex-adversarial.md`, `.claude/agents/codex-adversary.md`

## 13. v3 — CLI 0.144.1 Upgrade + gpt-5.6 Family Enablement (2026-07-11)

Executed via the tri-model plan (`plans/we-have-worked-in-snuggly-pony.md`); this is the §3-style evidence record.

### Upgrade
- **0.131.0 → 0.144.1** (`npm i -g @openai/codex@latest`). Rollback pin: `npm i -g @openai/codex@0.131.0`. Pre-upgrade `models_cache.json` snapshotted at `docs/codex-integration/snapshots/models_cache.0.131.0.json` (note: that cache had already been server-refreshed 2026-07-11T15:06Z and listed the 5.6 family with `client_version: 0.144.0`).
- Auth: `codex login status` → "Logged in using ChatGPT" before AND after upgrade. No API-key fallback at any point.

### Model probes (two-probe method, all at `model_reasoning_effort=low`, `--sandbox read-only --ephemeral --disable multi_agent`)
| Model | 0.131.0 result | 0.144.1 result |
|---|---|---|
| gpt-5.6-sol | 400 "requires a newer version of Codex. Please upgrade" | **exit 0, clean answer** |
| gpt-5.6-terra | (not probed) | **exit 0** |
| gpt-5.6-luna | (not probed) | **exit 0** |
| gpt-5.5 (regression) | n/a | **exit 0** |
| gpt-5.6-bogus (fabricated) | n/a | 400 "not supported when using Codex with a ChatGPT account" |

**New 400 taxonomy:** "requires a newer version of Codex" = CLI-too-old (upgrade), distinct from "not supported with a ChatGPT account" = bad/unavailable model id.

### Flag/behavior re-verification on 0.144.1
- `exec --help`: still NO `--full-auto` / `--ask-for-approval` — sandbox remains the only boundary. `-o/--output-last-message`, `--ephemeral`, `--ignore-user-config`, `--json`, `-s/--sandbox` all present.
- `--ignore-user-config` ask path: exit 0, clean `-o` capture (70-line log, consistent with v1 latency profile).
- **Workspace-write fixture (Windows):** throwaway git repo — file created (content verified), commits 1→1 (git-auto-commit did NOT fire), `file_claims` 7597→7597 (no collision). Hooks-collision verdict from the 2026-07-07 spike HOLDS on 0.144.1. New behavior: 0.144 creates a `.claude/` directory inside the workdir.
- **Resume:** `--json` stream still emits `thread_id` (`thread.started`); `codex exec resume` continued a session and recalled state correctly. (Note: an empty resume target degraded to last-session behavior — keep passing the explicit thread_id.)
- Subprocess-block inside workspace-write sandbox: NOT re-tested this pass; treat the 2026-07-07 finding (blocked, `CreateProcessAsUserW failed: 5`) as standing until re-probed.

### models_cache ground truth (0.144.1, fetched 2026-07-11)
`gpt-5.6-sol` (priority 1, "Latest frontier agentic coding model") · `gpt-5.6-terra` · `gpt-5.6-luna` · `gpt-5.5` · `gpt-5.4` · `gpt-5.4-mini` · `codex-auto-review` (hidden). The 5.6 family exposes new effort levels **`max`** and **`ultra`** ("maximum reasoning with automatic task delegation" — unprobed) plus a `priority`/"Fast" service tier.

### Allowlist edits landed (edit-point registry)
`codex-worker.md` (case gate + constraint #3 + input contract + effort note + version stamps), `codex-worker-safety.md` (allowlist + grounding + version drift), `skills/codex/SKILL.md` (flags line), `codex-adversary.md` (env-override validation `case` + comment), `codex-adversarial.md` (fixed the WRONG "gpt-5.3-codex supported" claim; version stamp), `cli-integration-strategy.md` (inventory row). Default model stays **gpt-5.5**; 5.6 family is opt-in via `--model` until it has mileage.

## 14. Read-only sandbox fork-storm on Windows (2026-07-11, workroom dogfood booth)

**Observed live** during the first Game Plan review booth (codex-adversary grading Grok's M1, `--sandbox read-only`, gpt-5.5 @ xhigh):

- 2 of 3 `codex exec` invocations tried to shell out (e.g. `pwsh.exe` to read a skill file) despite an explicit "do not use tools" instruction, hit the same OS-level denial documented for workspace-write (`CreateProcessAsUserW failed: 5`), and then **retried in an unbounded fork loop** — ~40 and ~35 orphaned `codex.exe` children respectively, 4–5.5 min of zero output until the process trees were killed manually (`taskkill /F /PID <pid> /T`).
- Prior docs (§ codex-worker-safety "Windows platform notes") knew the subprocess block only for `workspace-write`, where it fails as a clean no-op. **Read-only shows the same denial with a much worse failure shape (fork storm), and it is prompt-shape-dependent**: a rich checklist-style prompt demanding item-by-item reasoning triggered it; a shorter prompt with the same no-tools instruction did not.
- The invocation that completed returned `{"verdict":"approve","findings":[]}` with no notes — treat a zero-finding read-only pass that follows storms as THIN evidence, not deep engagement.

**Operational guidance until bounded:** keep adversary prompts compact (embed the diff + contract, avoid long per-item checklists); rely on the external Bash-tool timeout AND check for orphaned `codex.exe` children after any adversary timeout (`tasklist | findstr codex`); a supplemental Claude-critic lens is warranted whenever the Codex pass returns empty findings after a storm. Follow-up candidate: a wrapper that watches child-process count and kills the tree on runaway fork (flagged from the 2026-07-11 booth run).

## 15. Default model moved to gpt-5.6-luna @ max (2026-09-03)

**What changed.** Every Codex lane now defaults to `gpt-5.6-luna` at `max`
reasoning — the worker (`/codex` ask / implement / resume) and the adversary
(`/review`, `/premortem`) alike. Dave's call, 2026-09-03: "all Codex use should
be using gpt 5.6 luna on MAX", explicitly including unattended runs.

**No new model id was admitted, so no admission probe was owed.** This is worth
stating plainly because the harness-update rule reads as though every model
change needs a fresh probe. `gpt-5.6-luna` entered the allowlist on 2026-07-11
(§13) through exactly that gate: live-probed on this account at exit 0, with a
fabricated id reproducing the documented HTTP 400. Today's change selects a
DIFFERENT ALREADY-VERIFIED id as the default. Nothing was added to any
allowlist; all six ids in §13 remain valid and unchanged.

**What DID need verifying, and was.** The edit that introduced the switch
asserted in two files that "the current models_cache fetched 2026-09-03 lists
Luna with `max` support" with no record behind it. Unsourced, that is precisely
the "never from docs or memory" failure the rule exists to prevent, so it was
checked against ground truth rather than deleted or believed:

```
$ node -e "...read ~/.codex/models_cache.json..."
fetched_at     = 2026-09-03T22:54:13.310763200Z
client_version = 0.151.0
gpt-5.6-sol       default=medium  efforts=[low, medium, high, xhigh, max, ultra]
gpt-5.6-terra     default=medium  efforts=[low, medium, high, xhigh, max, ultra]
gpt-5.6-luna      default=medium  efforts=[low, medium, high, xhigh, max]
gpt-5.5           default=xhigh   efforts=[low, medium, high, xhigh]
gpt-5.4           default=medium  efforts=[low, medium, high, xhigh]
gpt-5.4-mini      default=medium  efforts=[low, medium, high, xhigh]
```

The claim is TRUE: luna offers `max`. Two facts nobody had recorded fell out of
the same read, and both are load-bearing:

1. **Effort ceilings are not uniform, and `max` is not universal.** `gpt-5.5`
   tops out at `xhigh` — it has NO `max`. So `--model gpt-5.5 --effort max` is
   an invalid pair, and it is the exact combination someone gets by overriding
   the model back to 5.5 and leaving the new default effort alone.
2. **`ultra` is sol/terra only.** Luna does NOT offer it, so
   `--model gpt-5.6-luna --effort ultra` is invalid too.

Neither is a typo the model allowlist can catch — both are well-formed requests
that the account rejects only after the run is set up. So both workers gained an
effort guard that resolves the ceiling FROM the chosen model and downgrades
loudly instead of sending a doomed request. Verified by exercising all 6 models
x 8 effort inputs (48 combinations, including unset and a bogus value) against
the cache as the oracle: every combination resolves to a level that model
actually supports.

**Auth and CLI, re-asserted the same day:** `codex login status` -> "Logged in
using ChatGPT"; `codex --version` -> `codex-cli 0.144.1`, matching the pin in
`.claude/rules-src/harness-update.md`. No CLI upgrade happened and none was
needed.

**One unexplained observation, deliberately not resolved here.** The cache's own
`client_version` field reads `0.151.0` while the installed CLI is `0.144.1`. It
is not evidence of an upgrade — `codex --version` is authoritative and says
otherwise — and the field may simply record a server-advertised client version.
Recorded rather than explained: do NOT read it as a version pin, and do not
"correct" the pin to match it without a real `codex --version` disagreeing.

**Scope not included:** no `/harness-update codex` run, because no CLI version
changed and no new id was admitted. The next actual CLI upgrade still owes the
full §3 re-verification.

## 16. `--complex` fan-out could NOT be verified (2026-09-03) — negative result

Dave asked whether `~/.codex/agents/explorer.toml` should move to Luna with
everything else. Trying to answer it produced a more useful finding than the
question deserved: **there is no evidence that `--complex` spawns a sub-agent on
this machine at all**, so the pin it hard-requires may be guarding nothing.

Three attempts, each read-only, each on `codex-cli 0.144.1`:

1. **Probe A — ask the run to spawn an explorer and report its model.** Pin left
   at the existing `gpt-5.5 @ xhigh`. Result:
   `{"explorer_spawned":true,"explorer_model":"GPT-5","explorer_effort":"not available","orchestrator_model":"GPT-5"}`.
   **The built-in control invalidates the instrument:** the ORCHESTRATOR was
   launched with `--model gpt-5.6-luna` and described itself as `"GPT-5"`. A
   model cannot reliably report its own exact id, so `explorer_model` cannot
   distinguish a pin that was honoured from one that was ignored — and
   `explorer_spawned:true` is the same unreliable channel.

2. **Probe B — negative control, pin set to a known-400 id.**
   `explorer.toml` temporarily pinned to `gpt-5.6-bogus` (the id proven in §13
   to return HTTP 400 on this account). If the pin were honoured, the spawn had
   to fail. Result: **no 400, exit 0**, and
   `{"explorer_spawned":true,"explorer_model":null,...}`.

3. **Log inspection, both runs.** The only occurrences of "explorer" in either
   log are the prompt text echoed back. No agent-tool call, no spawn event, no
   second turn. Token counts (41,468 and 35,902) are consistent with a single
   agent answering in both runs.

**Conclusion, stated at the strength the evidence supports:** the most economical
reading is that no sub-agent spawned in either run, which would make both the
"pin honoured" and "pin ignored" hypotheses untested rather than one of them
proven. This is consistent with openai/codex#19399 (subagent TOML ignored on
Windows) but does not confirm it. What IS established: the pin cannot be called a
verified guard, and `--complex` must not be trusted unattended until a probe
shows an actual spawn in the logs.

**What was changed anyway, and why that is safe in both worlds.** The pin now
reads `model = "gpt-5.6-luna"`, `model_reasoning_effort = "max"`. If the pin is
inert, this changes nothing. If it is honoured, the explorer would run a
model+effort pair that probe A showed the CLI accepts at the TOP level — probe A
proved nothing about the explorer itself, which is the whole point of this
section. There is no third case in which
5.5 would have been better, so the change carries no risk the old value avoided,
and it satisfies the "all Codex on Luna MAX" decision. **Correction (same day, caught by review of PR #36).** The first version of this
section claimed "the five repo references asserting the literal
`model = "gpt-5.5"` precondition were retargeted". That was FALSE, and the miss
was the dangerous half. Those five were PROSE. The **executable** guard in
`codex-worker.md` Step 2 — a `grep -Eq` for `gpt-5.5` in `explorer.toml`, plus
its refusal string and its NOTE line — was NOT retargeted. So for the length of
one commit `--complex` was BROKEN on this machine: the config file said luna,
the guard demanded 5.5, and any `--complex` run would have exited 2. Changing a
config without its executable check is precisely the two-copy failure
`every-surface-checklist.md` exists to prevent, committed one message after
citing that checklist. The guard, its refusal text, its NOTE and three
`SKILL.md` references now all name `gpt-5.6-luna`.

**The apparent contradiction with 2026-07-07 is RESOLVED — the two findings were
never in conflict.** `codex-worker.md` and `V2-HANDOFF.md` both carry a July
claim that a probe "spawned an explorer subagent that ran and self-reported
GPT-5 ... the `model = "gpt-5.5"` pin **is honored** here." Reading the original
wording settles it: the pin conclusion was inferred FROM THE SELF-REPORT, which
is the exact channel this section's control invalidates. Today's orchestrator
was launched `--model gpt-5.6-luna` and also self-reported "GPT-5". That string
identifies a family, not a model, so it cannot separate a honoured `gpt-5.5` pin
from an explorer that inherited the caller's model with the pin ignored
entirely.

So the July record decomposes into a hard half and a soft half:

- **VERIFIED, and it still stands:** zero `gpt-4.1` rejections. That is
  log-visible, and it rules out the role-fallback the gate exists to prevent.
- **NOT ESTABLISHED:** that the pin was honoured. The observation is equally
  consistent with the pin being ignored, because the fallback model would have
  been another GPT-5 either way.

Nothing about July therefore contradicts today's inability to find a spawn: both
are consistent with "the gate has never been shown to do anything, and has never
needed to." `V2-HANDOFF.md` has been annotated in place rather than rewritten.
The operational conclusion is unchanged and now better founded: treat the pin as
a cheap precaution, not a proven guard.

**What would actually settle it** (not attempted; costs quota and needs a run
that genuinely fans out): a `--complex` task broad enough to force delegation,
with the log inspected for a spawn event, and only then a pin-vs-no-pin A/B.
Until someone does that, the caveat in `codex-worker-safety.md` stands.

`explorer.toml` backup from before this work: `~/.codex/agents/explorer.toml.bak-2026-09-03`.

## 17. The `--complex` explorer gate guards nothing — A/B, and a §16 correction (2026-09-03)

Two corrections and one verdict, in that order, because the second correction
is mine and it matters more than the verdict.

### Correction: §16's "no evidence of a spawn" was a FALSE NEGATIVE

§16 concluded that `--complex` might not fan out on this machine at all. That
was wrong, and the instrument was the problem, not the harness. Re-running with
**`codex exec --json`** — which streams harness events as JSONL, independent of
anything the model says about itself — produced, on a 328KB / 47-file inline
diff with the prompt explicitly inviting delegation:

```
item.started  :: collab_tool_call   x9      tool = "spawn_agent"
item.completed:: collab_tool_call   x8      receiver_thread_ids populated, agents_states = pending_init
```

Nine real spawns, each with its own per-file review prompt, all from one
`sender_thread_id`. **Fan-out is real.** §16's probes used a task that was not
broad enough and a prompt that did not ask for delegation; nothing fanned out,
and "no spawn observed" was read as "cannot spawn". The lesson is the same one
§16 was itself about: an instrument that cannot see a thing is not evidence the
thing is absent.

### The A/B: does `explorer.toml` do anything?

Same prompt, same flags, same model+effort. Arm 1 with the pin present. Arm 2
with `~/.codex/agents/explorer.toml` **deleted outright** (moved aside, restore
chained to the run's exit).

| | pin = `gpt-5.6-luna` | pin file ABSENT |
|---|---|---|
| total events | 25 | 26 |
| `spawn_agent` started | 9 | 7 |
| completed with receiver thread | 6 | 6 |
| **`gpt-4.1` mentions** | **0** | **0** |
| `explorer` mentions | 0 | 0 |
| `turn.completed` | 1 | 1 |

**Verdict: the file makes no observable difference.** The gate's entire premise
is "without the pin, sub-agents drop to `gpt-4.1` and 400 on this subscription".
Deleting the file did not produce a single `gpt-4.1` mention. And the string
`explorer` appears **nowhere** in either stream: this path spawns generic
`spawn_agent` workers, never the named role that `explorer.toml` configures.

Read honestly, this also retro-explains every earlier observation at once —
July's zero `gpt-4.1` 400s, §16's bogus-pin producing no 400, and the pin
appearing to "work" whatever its value. None of them were evidence the pin
worked; all are what you see when the pin is simply not consulted.

**What is NOT claimed.** The 9-vs-7 spawn difference is not an effect — an LLM
decomposes a 47-file diff differently run to run. This is n=1 per arm, on CLI
`0.144.1`; the July claim it supersedes was on `0.131.0`, so the harness may
genuinely have changed which agent machinery it uses. A binary `gpt-4.1` signal
would have been loud, which is why one pair is enough to act on and not enough
to close the question forever.

### What changed

The Step 2 check is **downgraded from refuse to warn**, not deleted. Refusing on
this file could only ever produce a FALSE refusal — blocking `--complex` on a
fresh machine for a hazard that is not there. It is kept as a warning because of
the n=1 caveat above, and the warning text tells the operator what to do if they
DO see `gpt-4.1` 400s: report it, because then this A/B is wrong for their case.

This is the "false-premise diagnosis" pattern this repo has paid for before —
hardening against a failure mode that was never occurring. The tell was the same
both times: a guard nobody had ever seen fire, protecting against a symptom
nobody had ever observed.

### Incidental, and its own lane

Both arms logged an identical error item: `Exceeded skills context budget of 2%.
All skill descriptions were removed and 921 additional skills were not included
in the model-visible skills list.` Every Codex run here starts with ZERO skill
descriptions visible to the model. Counted, not inferred: `~/.agents/skills`
holds 673 `SKILL.md`, of which **527 (78%) are under `archive/` or `_snapshots/`**.
Tracked as lane `codex-skills-budget`; not investigated here.


## 18. Upgrade 0.144.1 -> 0.153.4; gpt-6-astra admitted, gpt-5.4 / gpt-5.4-mini dropped (2026-09-08)

Run of `/harness-update codex`, reactive: a FourthBot session on 2026-09-07 saw
`codex exec` fail with `models_cache.json: missing field base_instructions`
(the CLI's cache schema had drifted). By the time this playbook ran, the cache
had self-refreshed (`fetched_at 2026-09-08T16:57`) and 0.144.1 answered a
read-only ask again, so the failure is recorded as transient cache drift, not
reproduced. The upgrade went ahead regardless: 0.144.1 was nine minor versions
behind.

### Snapshot and rollback pin

- Before: `codex-cli 0.144.1`, `codex login status` -> `Logged in using ChatGPT`.
- Cache copied to `docs/codex-integration/snapshots/models_cache.0.144.1.json`.
- Rollback: `npm i -g @openai/codex@0.144.1`.
- After: `npm i -g @openai/codex@0.153.4` -> `codex-cli 0.153.4`; auth re-asserted,
  still `Logged in using ChatGPT`. (The first `@latest` attempt hit a hook error in
  `package-install-guard`, "No stderr output"; the exact-version retry passed the
  guard cleanly. Not a block, a guard hiccup.)

### Capability surface on 0.153.4 (`codex exec --help`)

Present: `-o/--output-last-message`, `--ephemeral`, `--ignore-user-config`,
`--json`, `-s/--sandbox`, `--disable`/`--enable`, `-C`, `-m/--model`. Absent:
`--full-auto`, `--ask-for-approval`. **New: `--approve-for-me`** ("Route approval
requests through automatic review using the workspace-write sandbox") next to
`--dangerously-bypass-approvals-and-sandbox` and a new
`--dangerously-bypass-hook-trust`. None of the three is used by any worker; the
sandbox remains the only boundary. `codex exec resume [SESSION_ID]` unchanged.

### Fixtures

- Read-only ask (`gpt-5.6-luna`, effort low, `--ephemeral`, `--disable multi_agent`):
  `-o` file = `PONG`, rc 0.
- Workspace-write in a throwaway repo (`git init` + one empty commit), `--json`:
  `hello.txt` = `HELLO`, `git rev-list --count HEAD` = 1 (no auto-commit),
  `thread.started` carried `"thread_id":"01a0830c-ad2b-7230-a3f5-95148dec8987"`,
  event types seen: thread.started, turn.started, item.started, item.completed x4,
  file_change x2, agent_message x2, turn.completed, plus one `error` event (the
  skills-budget warning, non-fatal). Hooks-collision fixture NOT re-run this pass.
- Startup noise unchanged in kind: `failed to load skill ... invalid YAML` and
  `Exceeded skills context budget. All skill descriptions were removed and 353
  additional skills were not included` on every run (lane `codex-skills-budget`).

### Two-probe model ids (this account, 2026-09-08, effort low, read-only, ephemeral)

| id | result |
|---|---|
| gpt-5.6-luna | rc 0, `PONG` |
| gpt-6-astra | rc 0, `PONG` -- NEW, admitted |
| gpt-5.5 | rc 0, `PONG` |
| gpt-5.4 | rc 1, `{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account."}}` -- DROPPED |
| gpt-5.6-luna-bogus | rc 1, same 400 shape (negative control) |

Ground truth `~/.codex/models_cache.json` (`client_version 0.153.4`, fetched
`2026-09-08T22:03:15Z`), visible ids and effort levels:

| id | picker | efforts | default |
|---|---|---|---|
| gpt-6-astra | list | low medium high xhigh max ultra | low |
| gpt-5.6-sol | list | low medium high xhigh max ultra | medium |
| gpt-5.6-terra | list | low medium high xhigh max ultra | medium |
| gpt-5.6-luna | list | low medium high xhigh max | medium |
| gpt-5.5 | list | low medium high xhigh | xhigh |
| gpt-reserve | hide | low..max | medium |
| codex-auto-review | hide | low..max | medium |

`gpt-5.4` and `gpt-5.4-mini` are no longer in the cache. The two hidden ids were
NOT probed and are NOT admitted (a hidden id is not something a person should
type; admit only through this playbook if ever needed).

### Allowlist after this pass

`{gpt-6-astra, gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5}`. Effort ceiling
per model: astra/sol/terra `ultra`, luna `max`, gpt-5.5 `xhigh`. Default stays
`gpt-5.6-luna @ max` (Dave's call, §15); astra is available by explicit
`--model gpt-6-astra` and its `ultra` implies delegation, still unprobed, avoid
unattended.

### Registry walk

Idempotent exact-string patch over: `agents/codex-worker.md` (12 edits: constraint
header, sandbox note with the `--approve-for-me` caveat, allowlist prose, `## Model`
contract, effort table, ceiling `case`, gate `case`, reject message),
`agents/codex-adversary.md` (7), `rules-src/codex-worker-safety.md` (3),
`rules-src/codex-adversarial.md` (2), `rules-src/harness-update.md` (1),
`skills/codex/SKILL.md` (5), `skills/cli-integration/SKILL.md` (1). A second run
produced zero diff. The playbook's own registry table pointed at
`.claude/rules/`; corrected to `.claude/rules-src/` (the canonical copy per the
every-surface checklist). `codex-adversary.md` is CRLF on disk; the patch
normalises the search strings per file.

### Smoke through the skill path (2026-09-08)

`codex-worker` ask, `--model gpt-6-astra`, effort low, read-only, against FourthBot:
auth asserted, allowlist gate passed, exit 0, telemetry row records
`model: gpt-6-astra`. The model did NOT answer: asked to read one file, it
shelled out (`pwsh -Command Get-Content ...`) and the read-only sandbox rejected
the spawn (`exec_command failed ... blocked by policy`), the documented Windows
constraint (section 13). New observation, model-specific: gpt-6-astra reaches
for a subprocess where gpt-5.6-luna answered the same shape of question from
inline context. Consequence: an astra ask/review must carry its context INLINE
in the prompt (which the reviewer already does) and must be told not to spawn
tools; do not point astra at "read file X" tasks on Windows.


## 19. Upgrade 0.153.4 -> 0.162.1; gpt-6.1-sol admitted; implement lane frozen (2026-10-12)

Run of `/harness-update codex`. The upgrade admitted `gpt-6.1-sol`, the new
adversary default. The workspace-write fixture failed on 0.162.1, so the write
lane (`/codex --implement`, `--resume`) is frozen. Evidence file:
`.claude/cache/e2e/2026-10-12-codex-harness-update-0.162.1.txt`.

### Snapshot and rollback pin

- Before: `codex-cli 0.153.4`, `codex login status` -> `Logged in using ChatGPT`.
- Cache copied to `docs/codex-integration/snapshots/models_cache.0.153.4.json`.
- Rollback: `npm i -g @openai/codex@0.153.4`.
- After: `npm i -g @openai/codex@0.162.1` -> `codex-cli 0.162.1`; auth still
  `Logged in using ChatGPT`.

### Capability surface on 0.162.1 (`codex exec --help`)

Present: `-o`, `--ephemeral`, `--ignore-user-config`, `--ignore-rules`, `--json`,
`-s/--sandbox`, `--output-schema`, `--skip-git-repo-check`, `--enable/--disable`,
`-C`, `-m`, `--approve-for-me`, `--dangerously-bypass-hook-trust`. New since
0.153.4: `--worktree`, `--thread-source`, `--cyber-access-program`. No approval
dial on `exec`. `codex features list`: `hooks stable true`, `multi_agent stable
true`, so `--disable hooks` is a valid flag.

### Two-probe model ids (effort low, read-only, ephemeral, `--disable multi_agent --disable hooks`)

| id | result |
|---|---|
| gpt-6.1-sol (0.162.1) | rc 0, `PONG`, header `model: gpt-6.1-sol`, session `01a1323f-9dc5-70d0-b1e8-6103e0564974`, 140 tokens -- NEW, admitted |
| gpt-6.1-sol-bogus | rc 1, `{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The 'gpt-6.1-sol-bogus' model is not supported when using Codex with a ChatGPT account."}}` |
| gpt-5.6-luna | rc 0, `PONG` |
| gpt-6.1-sol on 0.153.4 (A/B after a rollback) | rc 1, the SAME "not supported when using Codex with a ChatGPT account" 400 |

**Taxonomy correction.** A version-gated id can return the "not supported" shape,
not only "requires a newer version". Upgrade the CLI before you conclude an id is
off the subscription.

### Read-only guard probe

Asked to create `guard-test.txt`, the model answered `Write blocked. Error: "patch
rejected: writing is blocked by read-only sandbox; rejected by user approval
settings"`. The file does not exist afterwards. The guard holds.

### Workspace-write fixture: FAILED

Throwaway repo, `gpt-5.6-luna`, effort low, `--json`. FAILED twice on 0.162.1:
`hello.txt` not created, rc 0, commit count 1, and `thread.started` still carries
a `thread_id`. The same fixture PASSED on 0.153.4 in the same hour (`hello.txt` =
`HELLO`, commit count 1).

- `~/.codex/.sandbox/sandbox.2026-10-12.log`: `setup refresh ... runtime
  read/execute validation failed: validate runtime read/execute access on
  C:\Users\david.hayes\AppData\Local\OpenAI\Codex\runtimes\cua_node\b63ee7ee40c23b77\bin\node_repl.exe:
  open ACL target for root-only update: The process cannot access the file because
  it is being used by another process. (os error 32)`
- `setup_error.json`: `helper_unknown_error`, `setup refresh had errors`.
- `codex doctor`: `sandbox  elevated Windows sandbox provisioning recorded a
  structured failure`.
- Cause [Speculation]: the Codex desktop app's sandbox service
  (`CodexSandboxService.OpenAI.Codex`) holds that runtime file open.

### Decision (Dave, 2026-10-12): stay on 0.162.1, freeze the write lane

This is not a guard regression. The sandbox denies more, not less.
`/codex --implement` and `--resume` are FROZEN until the fixture passes. The
worker returns `CODEX IMPLEMENT FROZEN (2026-10-12): the workspace-write fixture
fails on codex-cli 0.162.1. See docs/codex-integration/DESIGN-RESEARCH.md section
19. ask and review still work.` Unfreeze: quit the Codex desktop app, re-run the
fixture, and on a pass remove the freeze and add a dated note here.

### Ground truth `~/.codex/models_cache.json` after a 0.162.1 turn

`client_version 0.162.1`, fetched `2026-10-12T22:34:49Z`, 10 ids:

| id | picker | efforts | default | description |
|---|---|---|---|---|
| gpt-6.1-sol | list | low medium high xhigh max ultra | medium | Latest workhorse model for coding and everyday work. |
| gpt-6-astra | list | low medium high xhigh max ultra | low | n/r |
| gpt-6-sol | list | low medium high xhigh max ultra | n/r | Previous generation workhorse model. |
| gpt-6-luna | list | low medium high xhigh max | n/r | Fast and affordable model for easier tasks. |
| gpt-reserve | hide | n/r | n/r | n/r |
| gpt-5.6-sol | list | low medium high xhigh max ultra | n/r | n/r |
| gpt-5.6-terra | list | low medium high xhigh max ultra | n/r | n/r |
| gpt-5.6-luna | list | low medium high xhigh max | n/r | n/r |
| gpt-5.5 | hide | low medium high xhigh | n/r | n/r |
| codex-auto-review | hide | n/r | n/r | n/r |

`n/r` = not recorded in this pass. `gpt-6-sol` and `gpt-6-luna` were NOT probed and are NOT admitted.

**Caveat.** After an upgrade or a rollback the cache keeps the old
`client_version` and id list until the next real turn. A cache from another CLI
version is stale. The runner (`.claude/scripts/codex/adversary.mjs`) compares the cache's
`client_version` with `codex --version` and ignores a stale cache. The snapshot
`snapshots/models_cache.0.162.1.json` was taken after the first runner turn
(`client_version 0.162.1`, 10 ids).

### First runner turn (2026-10-12)

`adversary.mjs run --mode code --diff-file scripts/codex/fixtures/planted.diff`, default model:
`CODEX-RECEIPT v1 status=ok run=20261012T230017Z-1308 model=gpt-6.1-sol requested=gpt-6.1-sol effort=xhigh provider=openai cli=0.162.1 session=01a13258-6b7c-7540-a2e1-77bbe0f3069d exit=0 final_bytes=799 sha256=04beebf8bb945bd3 tokens=34691 duration_s=18.4 via=manual`.
Codex named both planted bugs (`invoice-access.js:12` inverted ownership check, `:17` slice off by one).
`verify 20261012T230017Z-1308` -> `VERIFY ok`. Evidence: `.claude/cache/e2e/2026-10-12-codex-adversary-live1.txt`.

### Allowlist after this pass

`{gpt-6.1-sol, gpt-6-astra, gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5}`.
Adversary default: `gpt-6.1-sol @ xhigh` (Dave, 2026-10-12). Worker default
unchanged: `gpt-5.6-luna @ max` (section 15). Workers use at most `max`. OpenAI's
model page says `gpt-5.5` retires from Codex on 2026-10-14: remove it at the next
`/harness-update codex` run.

### Registry walk

Updated: `agents/codex-worker.md` (allowlist prose, `## Model` and effort notes,
ceiling `case`, gate `case`, freeze reject), `rules-ondemand/codex-worker-safety.md`
(freeze section, matrix rows, allowlist, version drift),
`rules-ondemand/codex-adversarial.md`, `skills/codex/SKILL.md`,
`skills/cli-integration/SKILL.md`, `rules-ondemand/harness-update.md`. The
registry row for `codex-adversary.md` now points at
`.claude/scripts/codex/adversary.mjs` (the `MODELS` table).
