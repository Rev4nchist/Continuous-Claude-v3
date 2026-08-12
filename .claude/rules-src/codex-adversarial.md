# Codex Adversarial Review Rules

**Scope: read-only REVIEW only.** For write-capable Codex *execution* (`/codex` ask/implement/resume, `workspace-write`, worktree isolation) the governing rule is the sibling `.claude/rules/codex-worker-safety.md`. `/codex --review` delegates back to the `codex-adversary` agent covered here.

Codex is wired in as a **cross-model adversarial reviewer**: the `codex-adversary` agent (used by `/review` and `/premortem`), the `codex-plugin-cc` slash commands (`/codex:*`), and the `plan-exit-premortem-prompt` hook (it only OFFERS `/premortem` after an approved plan — never auto-runs it).

Detail — startup-noise archaeology, the multi_agent/gpt-4.1 root cause and issue trail, synthesis + telemetry mechanics, the integration file map — lives in `.claude/skills/review/SKILL.md`, `.claude/skills/premortem/SKILL.md`, `.claude/skills/codex/SKILL.md`, and `docs/codex-integration/DESIGN-RESEARCH.md`.

## Safe Commands (no confirmation needed)

- `codex login status`, `codex --version`, `codex --help`
- `codex exec` with `--sandbox read-only`
- `/codex:review`, `/codex:adversarial-review`, `/codex:status`, `/codex:result`, `/codex:cancel`

## Confirm-First Commands (ALWAYS ask user)

Before running ANY of these, explain what it does and wait for explicit user approval:

- `/codex:rescue` — delegates *execution* of a task to Codex. Large blast radius, can modify files.
- `codex exec` with `--sandbox workspace-write` or `--sandbox danger-full-access`
- `codex exec --dangerously-bypass-approvals-and-sandbox`
- `/codex:setup --enable-review-gate` — **DO NOT enable.** High-cost (drains ChatGPT Codex quota), high-latency (900s timeout per turn), high-risk on Windows.

## Auth: subscription only

Codex authenticates via OAuth against Dave's **ChatGPT subscription** (Plus/Pro). Every adversarial-review call spends that subscription's quota; there is no separate API billing. **Never fall back to an `OPENAI_API_KEY` / `CODEX_API_KEY` path.** If `codex login status` does not report a logged-in ChatGPT account, STOP and have Dave run `codex login`. Never print `~/.codex/auth.json` or any key value.

## Model allowlist

**Supported ChatGPT-subscription models** for Codex exec (CLI `0.144.1` + re-verified 2026-07-11; live-probed on this account): `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`. Default for review is `gpt-5.5 @ xhigh` (override via `CODEX_ADVERSARY_MODEL`). `gpt-4.1` is API-key-only. **Never admit an id from docs or memory** — an earlier claim that `gpt-5.3-codex` was supported was WRONG: every `-codex`-suffixed id probed on this account 400s. New ids enter only via `/harness-update codex` (live probe on this exact account).

## Hard requirements for every adversary run

- **`--sandbox read-only`.** The sandbox is the ONLY boundary — no Claude Code hook can see inside Codex's process. Read-only also blocks subprocess spawns, so the reviewer must get its context INLINE and be told not to spawn tools.
- **`--disable multi_agent` on every `codex exec`.** With multi_agent on, a large diff makes Codex spawn built-in sub-agents that fall back to `gpt-4.1`, which a ChatGPT account rejects (400) — the whole review fails and the quota is spent for nothing. Single-shot is where the cross-model value is anyway.
- **Parse findings only from the clean `-o <file>` capture.** A healthy run streams ~150 lines of non-fatal startup noise (skill-YAML rejects, MCP connection errors, `hook: … Failed`) before the real answer. Never report that noise as review findings or as an auth failure.

## Cost / quota

One `/review` or `/premortem` with Codex enabled = **one** Codex turn at xhigh reasoning (typically 30–120s), spending ChatGPT-subscription quota. Skip it with `--no-codex` for doc-only changes, trivial diffs (<20 lines, single-file, no logic change), latency-critical hotfixes, or when the session has already burned the quota. Cross-model lift is logged to `.claude/logs/codex-lift.jsonl` — if `codex_only` is consistently zero, the pass is not earning its quota cost.
