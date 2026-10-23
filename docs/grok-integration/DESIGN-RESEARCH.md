# Grok Integration — Design Research & Verified Capability Surface

Sibling of `docs/codex-integration/DESIGN-RESEARCH.md`. Same discipline: **nothing enters a rule/agent file without a live probe on this machine + this account.** Plan: `~/.claude/plans/we-have-worked-in-snuggly-pony.md` (tri-model system).

## 1. Executive summary

xAI's **Grok Build CLI** (`grok`) is installed, subscription-authenticated, and headless-capable on this Windows 11 machine. The `/grok` worker rides Dave's **X Premium+ subscription via OAuth (auth.x.ai, oidc)** — no API key, no per-token billing. The load-bearing question from planning ("does headless stay on OAuth?") is **answered YES by live probe**. The biggest surprises: headless mode **writes files with zero approval by default**, `--permission-mode plan` and `--sandbox` do **not** block writes, and the native `-w` worktree flag is **silently ignored** in `-p` mode — so read-only safety comes from the `--tools` allowlist and implement-mode isolation reuses the proven codex-worker hand-rolled worktree recipe.

## 2. Verified surface (all probed 2026-07-11, grok 0.2.93 stable, Windows 11)

### 2.1 Auth & identity
- `grok login` (browser OAuth) done by Dave 2026-07-11. `grok models` header: "You are logged in with grok.com."
- `~/.grok/auth.json` (keyed by `https://auth.x.ai::<uuid>`): non-secret fields `email = dkhayes44@gmail.com`, `auth_mode = "oidc"`, `principal_type = "User"`. **Preflight identity pin = `.email`** — read via jq, NEVER touch `.key` / `.refresh_token`.
- `~/.grok/models_cache.json`: `auth_method: "session"` (subscription session, not API key). This file is the **ground-truth model cache** (Codex analog: `~/.codex/models_cache.json`).
- **Negative control PASS:** with `XAI_API_KEY=bogus-key-negative-control` set, `grok -p` succeeded (exit 0) — a bogus key would have failed if used, so the run stayed on OAuth. The CLI does not hijack auth from that env var. (Worker still sanitizes it defensively.)
- Re-auth for headless environments exists: `grok login --device-auth`.

### 2.2 Models (live list, 2026-07-11)
```
* grok-4.5 (default)
- grok-composer-2.5-fast
```
**Allowlist = `{grok-4.5, grok-composer-2.5-fast}`.** Never add ids from docs/blogs — only from `grok models` output on this account (via `/harness-update`).

### 2.3 Headless mode (the worker's transport)
- `grok -p "<prompt>"` — single-turn, prints to stdout, exits. **Probe: exit 0, clean output** (`GROK-PROBE-OK`), no startup noise on stdout in plain mode.
- `--prompt-file <PATH>` — native prompt-from-file (Windows stdin hygiene solved without redirection tricks).
- `--output-format plain|json|streaming-json`; **json returns `{text, stopReason, sessionId, requestId, thought…}`** — `sessionId` verified present.
- `--json-schema '<schema>'` — constrained structured output (implies json). Unprobed; noted for later.
- `--cwd <dir>` works on the root command (NOT on subcommands like `inspect` — those use the process cwd).
- `--reasoning-effort <EFFORT>` (alias `--effort`) exists; values unprobed for grok-4.5.
- `--no-subagents` — the `--disable multi_agent` analog; worker passes it by default (single-agent discipline). `--best-of-n`, `--check` exist (headless-only; unprobed).

### 2.4 Write behavior & the ONLY working read-only guard ⚠️
| Guard attempted | Blocks writes in headless? | Evidence |
|---|---|---|
| default (no flags) | **NO** — created `write-test.txt` unprompted-approval | probe 2026-07-11 |
| `--permission-mode plan` | **NO** — file created anyway | probe |
| `--disallowed-tools "<guessed names>"` | NO (names must match exactly; guessed set failed) | probe |
| `--sandbox strict` (and any string) | **NO — accepted silently, file created.** `--sandbox` is unvalidated/decorative on this build | probe |
| **`--tools "read_file,list_dir,grep"`** | **YES** — model attempted writes 3× and failed; file NOT created; terminal escape also unavailable; reads still work (retrieved planted file content) | probe |

**Rule: ask mode MUST pass `--tools "read_file,list_dir,grep"`.** Treat `--sandbox` as untrusted until a future version validates profiles.

### 2.5 Built-in tool names (self-reported by the model, 2026-07-11)
`web_search, open_page, open_page_with_find, x_user_search, x_semantic_search, x_keyword_search, x_thread_fetch, run_terminal_command, read_file, search_replace, list_dir, grep, kill_command_or_subagent, todo_write, get_command_or_subagent_output, spawn_subagent, scheduler_create, scheduler_delete, scheduler_list, monitor, search_tool, use_tool, update_goal, enter_plan_mode, exit_plan_mode, ask_user_question, web_fetch, image_gen, image_edit, image_to_video, reference_to_video, write`
- Ask mode excludes `run_terminal_command` (a write path via shell), `search_replace`, `write`, `spawn_subagent`, schedulers, web/x/image tools.
- Implement mode adds `write, search_replace, run_terminal_command` (worktree-isolated; note run_terminal_command means Grok CAN run commands — unlike Codex's Windows subprocess block — so verify accordingly and treat its self-reports with the same skepticism).

### 2.6 Worktrees ⚠️
- **`-w/--worktree` is silently IGNORED in headless `-p` mode** — probe: `-w grok-probe` wrote directly into the live tree; `grok worktree list` → "No worktrees found"; `git worktree list` → only the main tree. The flag appears to be a TUI-session feature ("Start the session in a new git worktree").
- **Implement isolation therefore reuses the codex-worker recipe:** hand-rolled `git worktree add` in `$(dirname "$PROJECT")/.grok-worktrees/<repo>-<ts>-<pid>` (sibling, outside the repo), run grok with `--cwd "$WORKTREE"`, independent `git diff` after, review-gate before apply, GC mirroring `scripts/codex/gc-worktrees.sh` rules (skip-dirty, no `rm -rf`).

### 2.7 Sessions / resume
- `--output-format json` → capture `sessionId`. `grok -r <sessionId> -p "<followup>"` **verified**: recalled prior-session content exactly. `-c` = most recent for cwd. `--fork-session` exists.
- `grok sessions list|search|delete` for management.

### 2.8 Environment quirks (Windows)
- **`grok worktree <cmd>` requires `$HOME`** — errors `hub error: neither $GROK_HOME nor $HOME is set` under the PowerShell tool (HOME unset there). `grok -p` itself tolerates it. Worker runs from Bash (HOME set) or sets `HOME="$USERPROFILE"` defensively.
- `--cwd` is accepted by the root command only; subcommands (`inspect`, `worktree`) use process cwd.
- **Auto-update churn is real:** CLI went 0.2.82 → 0.2.93 between sessions without action. Version-stamp every verified claim; `/harness-update grok` re-probes on version change. `grok update` can pin/install specific versions.

### 2.9 Context ingestion / data egress ⚠️
`grok inspect` shows Grok auto-discovers and loads **Claude Code's own config**: Dave's `~/.claude/Claude.md` (~5,090 tokens), permissions from `settings.local.json`, and **292 Claude skills**. Every `/grok` run therefore ships that context (plus the prompt + any files the model reads) to xAI under Dave's account. Covered by the data-egress section of `grok-worker-safety.md` (first-use confirm, secret-scan, no `.env*`, payload awareness). `--verbatim`, `--rules`, `--system-prompt-override` exist as shaping levers; a future probe could test whether config ingestion can be disabled for worker runs.

### 2.10 Quota/billing
Subscription-gated (X Premium+); no per-token invoice observed. No quota surface found in the CLI this pass (mirror of Codex: detection will be reactive — parse the rate-limit error when it first appears, then codify).

## 3. Divergences from the Codex mold (design deltas)

| Topic | Codex | Grok (verified) |
|---|---|---|
| Read-only enforcement | `--sandbox read-only` (real) | `--tools "read_file,list_dir,grep"` (`--sandbox` decorative) |
| Write isolation | hand-rolled worktree | same hand-rolled worktree (`-w` ignored headless) |
| Prompt input | `- < file` stdin | `--prompt-file <PATH>` native |
| Clean output | `-o <file>` (startup noise on stdout) | plain stdout already clean; json for structured |
| Session id | `thread_id` in `--json` events | `sessionId` in json output |
| Multi-agent | `--disable multi_agent` | `--no-subagents` |
| Model ground truth | `~/.codex/models_cache.json` | `~/.grok/models_cache.json` |
| Auth assert | `codex login status` ("Logged in using ChatGPT") | `grok models` header + `auth.json` `.email` identity pin |
| Windows subprocess in write mode | BLOCKED (writes blind) | `run_terminal_command` AVAILABLE — Grok can run commands in implement mode; orchestrator verification still mandatory |

## 4. Open items / future probes
- `--reasoning-effort` accepted values for grok-4.5.
- `--json-schema` structured-output reliability (would let the worker skip output parsing).
- Whether Claude-config auto-ingestion can be disabled per-run (egress + latency win).
- `--best-of-n`, `--check` (headless self-verification loop) — potential quality levers.
- Quota error shape (reactive capture on first occurrence).
- `--sandbox` profile validation in future CLI versions (re-probe on upgrade via `/harness-update grok`).

## 5. 2026-07-12/13 — Intermittent completion stall; headless hardening; 0.2.99 UNVERIFIED

**Symptom:** `grok -p` intermittently hangs forever, pre-first-token (streaming probe = 0 bytes),
hang-not-error, on ALL invocation paths (tool shells 0/11+; user's interactive terminal 1 success
then the next identical call hung). grok.com browser chat unaffected. `grok models` genuinely
network-live throughout (`models_cache.json` mtime updates every call); TCP 443 to api.x.ai/grok.com
fine; no explicit proxy on the box. Persisted 18+ hours across CLI **0.2.93 AND 0.2.99**.
Full falsification chain + evidence tables: `thoughts/shared/handoffs/grok-diagnosis/2026-07-12-grok-inference-hang.md`.
Undischarged hypotheses: Premium+ rate/quota silent-hold; xAI backend flakiness around the Grok 4.5
free-trial rollout (same 48h window); transparent middlebox (hotspot test discriminates).

**Unattended version drift:** the CLI auto-updated **0.2.93 → 0.2.99 mid-diagnosis** with no action
taken (npm cadence that week: 6 releases in 4 days; v0.2.95 changelog fixed a "queued prompts wait
for the full timeout" blocking-wait class). **0.2.99 is UNVERIFIED** — none of §2's guard probes
(`--tools` read-only, worktree behavior, model rejection shape) have been re-run on it. Rollback
reference: last fully verified version was **0.2.93** (`grok update` can pin). Run `/harness-update grok`
before trusting write modes on 0.2.99+.

**Hardening adopted (2026-07-13), pending behavioral verification:**
- `--no-auto-update` + `--always-approve` added to every headless call site (grok-worker 3a/3b/3c,
  grok-adversary Step 5) — both are docs-recommended headless-stall mitigations. Accepted-by-CLI on
  0.2.99 (probed; invalid flags error instantly, these did not); behavior unverifiable until
  inference returns — re-probe both in the next `/harness-update grok`.
- `auto_update = false` pinned in `~/.grok/config.toml` **under `[cli]`** — placement matters:
  probed 2026-07-13, an unrecognized TOP-LEVEL config key makes the whole CLI HANG (even
  `grok models`; revert restored it instantly). Config-file errors on this CLI manifest as hangs,
  not error messages — sanity-check `grok models` (bounded) after ANY config.toml edit. Whether the
  key actually suppresses updates is unverified (behavior probe pending); the `--no-auto-update`
  flag at call sites is the primary mechanism.
- Bounded-probe helper checked in at `scripts/grok/probe.ps1` (Wait-Job bound + `Stop-Process grok*`
  sweep — GNU `timeout` verified UNABLE to kill the native grok.exe child on Windows).
- Runaway amplifier guard (foreground + Bash-tool timeout + sweep) merged via PR #23.

**2026-07-13 discrimination complete — account + service CLEARED; fault is the work-machine/corp-network
path.** Same account on a different machine + network: READY twice back-to-back. Work machine after
fresh re-login: still hung. Stalled process TCP: ESTABLISHED to Cloudflare (api.x.ai front) with the
response never arriving (established-but-silent, not connect-blocked). Cert issuers for api.x.ai /
grok.com from the work machine = genuine Google Trust Services → NO corporate TLS interception.
Residual hypotheses: Cloudflare/xAI bot-or-rate treatment of the corporate egress IP (`104.5.57.31`) —
completion POSTs held while `models` GETs pass — or non-decrypting flow-level firewall behavior on
streaming responses. Remediation = IT allowlist ticket for `*.x.ai` (evidence in the grok-diagnosis
handoff), hotspot split-test if policy allows, else xAI support. Grok PARKED on this machine until then.
