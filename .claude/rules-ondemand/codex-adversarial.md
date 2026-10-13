# Codex Adversarial Review Rules

**Scope: read-only REVIEW only.** For write-capable Codex *execution* (`/codex` ask/implement/resume, `workspace-write`, worktree isolation) the governing rule is the sibling `.claude/rules-ondemand/codex-worker-safety.md`. `/codex --review` calls the same runner covered here.

Codex is wired in as a **cross-model adversarial reviewer**. Every review goes through one runner: `node "$HOME/.claude/scripts/codex/adversary.mjs"` (repo copy `.claude/scripts/codex/adversary.mjs`). **A review never types `codex exec` by hand.** Callers are the `/codex-adversary` skill, `/review`, `/premortem`, `/codex --review` and `/game-plan` (main session, runner called directly), and the `codex-adversary` agent (an envelope for Workflow stages). The `plan-exit-premortem-prompt` hook only OFFERS `/premortem` after an approved plan; it never auto-runs it. No Codex plugin is installed, so there are no `/codex:*` commands.

Every runner reply starts with a `CODEX-RECEIPT v1 ...` line that names the model that answered.

Detail — startup-noise archaeology, the multi_agent/gpt-4.1 root cause and issue trail, synthesis + telemetry mechanics, the integration file map — lives in `.claude/skills/review/SKILL.md`, `.claude/skills/premortem/SKILL.md`, `.claude/skills/codex/SKILL.md`, and `docs/codex-integration/DESIGN-RESEARCH.md`.

## Safe Commands (no confirmation needed)

- `codex login status`, `codex --version`, `codex --help`
- `node "$HOME/.claude/scripts/codex/adversary.mjs" run`, `verify`, `models` and `lift` (the runner always uses `--sandbox read-only`; `verify`, `models` and `lift` spend no quota)

## Confirm-First Commands (ALWAYS ask user)

Before running ANY of these, explain what it does and wait for explicit user approval:

- `codex exec` with `--sandbox workspace-write` or `--sandbox danger-full-access`
- `codex exec --dangerously-bypass-approvals-and-sandbox`
- A Codex review gate that runs on every turn. **DO NOT enable.** High cost (drains ChatGPT Codex quota), high latency, high risk on Windows.

## Auth: subscription only

Codex authenticates via OAuth against Dave's **ChatGPT subscription** (Plus/Pro). Every adversarial-review call spends that subscription's quota; there is no separate API billing. **Never fall back to an `OPENAI_API_KEY` / `CODEX_API_KEY` path.** If `codex login status` does not report a logged-in ChatGPT account, STOP and have Dave run `codex login`. Never print `~/.codex/auth.json` or any key value.

## Model allowlist

**Supported ChatGPT-subscription models** for Codex exec (CLI `0.162.1`, re-verified 2026-10-12; live-probed on this account): `gpt-6.1-sol`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`. The single allowlist for review is the runner's `MODELS` table (`.claude/scripts/codex/adversary.mjs`). `gpt-5.5` was removed on 2026-10-12, ahead of its 2026-10-14 Codex retirement. `gpt-6-astra` was removed on 2026-10-12 by Dave's rule: only ids he names. `gpt-5.4` and `gpt-5.4-mini` left the subscription (400 on 2026-09-08). **Default for review is `gpt-6.1-sol @ xhigh`** (Dave, 2026-10-12; override via `CODEX_ADVERSARY_MODEL`, effort via `CODEX_ADVERSARY_EFFORT`). The worker default stays `gpt-5.6-luna @ max`. Effort ceilings differ by model and are NOT uniform (ground truth `~/.codex/models_cache.json`, `client_version 0.162.1`, fetched 2026-10-12T22:34:49Z): `gpt-6.1-sol`, sol and terra offer `max` and `ultra`, luna offers `max` but NOT `ultra`. The runner never sends `ultra`. `gpt-4.1` is API-key-only. **Never admit an id from docs or memory** — an earlier claim that `gpt-5.3-codex` was supported was WRONG: every `-codex`-suffixed id probed on this account 400s. New ids enter only via `/harness-update codex` (live probe on this exact account).

## Hard requirements for every adversary run

- **`--sandbox read-only`.** The sandbox is the ONLY boundary — no Claude Code hook can see inside Codex's process. Read-only also blocks subprocess spawns, so the reviewer must get its context INLINE and be told not to spawn tools.
- **`--disable multi_agent` and `--disable hooks` on every `codex exec`.** With multi_agent on, a large diff makes Codex spawn built-in sub-agents that fall back to `gpt-4.1`, which a ChatGPT account rejects (400) — the whole review fails and the quota is spent for nothing. Single-shot is where the cross-model value is anyway. `--disable hooks` stops the mirrored CCv3 hooks in `~/.codex/hooks.json` from firing in a review run.
- **The runner parses findings only from the clean `-o <file>` capture.** A healthy run streams ~150 lines of non-fatal startup noise (skill-YAML rejects, MCP connection errors, `hook: … Failed`) before the real answer. Never report that noise as review findings or as an auth failure.
- **The runner bounds every run at 540 s by default (`--timeout-s` up to 1800 for a named run) and stops only its own process tree.** Never run a blanket `Get-Process codex* | Stop-Process` sweep. It kills parallel Codex runs.

## Receipt gate (every caller)

- A result with no line that matches `^CODEX-RECEIPT v1 status=ok run=\S+ model=gpt-[\w.-]+ ` is not a Codex review.
- Never tag a finding `[Codex]` or `sources: codex` without that line.
- Never substitute a Claude reviewer silently. Say `Cross-model pass: NO CODEX REVIEW (<status>)`.
- Quote the receipt line to Dave verbatim.
- Run `node "$HOME/.claude/scripts/codex/adversary.mjs" verify <run-id>` before you tag findings `[Codex]`. It spends no quota.
- The limit: the receipt proves what the local Codex CLI printed. It is not cryptographic. A stub run or an overridden binary prints `stub=1` or `bin=env` and can never pass the gate.
- `json=0` in the receipt means Codex answered in prose. Show the raw answer and say so.
- Plan mode: run no Codex pass. Say it is deferred. Offer the pass after plan mode ends.

## Workflow stages

- The `codex_receipt` contract below is REQUIRED for every new workflow script. No saved script carries it yet.
- The envelope stage passes `agentType: 'codex-adversary'`, `model: 'sonnet'`, `effort: 'high'`.
- The GPT model goes in the stage prompt as a `## Model` block.
- The stage schema carries a required `codex_receipt` string and a `no-review` verdict value.
- The script counts a result as Codex only when `codex_receipt` matches the gate regex.
- Triage of Codex findings is a separate stage, labelled as Claude.
- Re-check loops pass `gpt-5.6-luna` to protect the usage window.

## Cost / quota

One `/review` or `/premortem` with Codex enabled = **one** Codex turn at `gpt-6.1-sol @ xhigh` by default. A run takes up to 9 minutes, so start it in the background. It spends ChatGPT-subscription quota. Skip it with `--no-codex` for doc-only changes, trivial diffs (<20 lines, single-file, no logic change), latency-critical hotfixes, or when the session has already burned the quota. Cross-model lift is logged to `.claude/logs/codex-lift.jsonl` (`adversary.mjs lift`); every run also leaves a receipt row in `~/.claude/logs/codex-adversary.jsonl`. If `codex_only` is consistently zero, the pass is not earning its quota cost.
