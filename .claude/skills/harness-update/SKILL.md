---
name: harness-update
description: Upgrade a cross-model harness (Codex/Grok) and re-verify its live-probed model allowlist. Use when the user says "/harness-update", "update codex", "update grok", "enable model X", or hits a "requires a newer version" error.
disable-model-invocation: true
---

# Harness Update Playbook

One procedure for keeping any cross-model harness current: **snapshot → pin rollback → upgrade → re-assert auth → re-verify → two-probe models → walk the edit-point registry → record evidence → sync → smoke.** Codified from the 2026-07-11 Codex 0.131.0→0.144.1 + gpt-5.6 enablement and the Grok 0.2.93 spike.

## Usage

```
/harness-update codex                 # upgrade + full re-verify + refresh allowlist
/harness-update grok
/harness-update codex --model gpt-5.7 # also probe + enable a specific new id
/harness-update codex --dry-run       # walk the registry, report drift, change nothing
```

## Iron laws

1. **Live probe or it doesn't exist.** A model id enters an allowlist ONLY after a real call on THIS account returns success. Docs, blogs, and even the vendor's model table are hypotheses.
2. **Pin rollback before upgrading.** Record the exact installed version and its reinstall command first.
3. **Subscription auth is asserted before AND after** — an upgrade must never silently fall to an API key.
4. **Idempotent registry walk.** Edit points are exact-string replacements; running the procedure twice produces zero diff (`--dry-run` twice must report clean).
5. **Evidence is dated-append** — add a new dated section to the harness's DESIGN-RESEARCH doc; never rewrite history.

## The procedure

### Step 1 — Snapshot + rollback pin
| Harness | Version | Auth assert | Model ground truth |
|---|---|---|---|
| codex | `codex --version` | `codex login status` → "Logged in using ChatGPT" | `~/.codex/models_cache.json` |
| grok | `grok --version` | `grok models` header contains "logged in" AND `jq -r 'to_entries[0].value.email' ~/.grok/auth.json` = expected email | `~/.grok/models_cache.json` |

Copy the models_cache aside to `docs/<harness>-integration/snapshots/models_cache.<version>.json`. Record the rollback command:
- codex: `npm i -g @openai/codex@<old-version>`
- grok: `grok update --install <old-version>` (verify the subcommand's current syntax via `grok update --help` first; grok also AUTO-updates — a version change may have already happened without you)

### Step 2 — Upgrade
- codex: `npm i -g @openai/codex@latest`
- grok: `grok update` (or let auto-update land; either way, treat any version change as requiring this playbook)

### Step 3 — Re-assert auth
Same asserts as Step 1. FAIL → stop, tell Dave to re-login (`codex login` / `grok login`). Never proceed on an API-key fallback.

### Step 4 — Re-verify the capability surface (per-harness checklist)
Run the harness's verification checklist and diff against its DESIGN-RESEARCH doc:

**codex** (`docs/codex-integration/DESIGN-RESEARCH.md` §3, §13):
- `codex exec --help` — confirm `-o`, `--ephemeral`, `--ignore-user-config`, `--json`, `-s/--sandbox` present; confirm NO approval dial appeared (if one did, that's a design-level change — flag to Dave).
- Regression smoke on the current default model (read-only ask).
- Workspace-write fixture (throwaway git repo): file created, no auto-commit, `file_claims` count unchanged.
- Resume: `--json` still emits `thread_id`.

**grok** (`docs/grok-integration/DESIGN-RESEARCH.md` §2):
- `grok --help` — confirm `-p`, `--prompt-file`, `--tools`, `--no-subagents`, `--output-format`, `-r` present.
- **Re-probe the read-only guard**: `--tools "read_file,list_dir,grep"` still blocks a write attempt (this is the load-bearing safety fact; `--sandbox` was decorative on 0.2.93 — check whether it started validating).
- Headless-on-OAuth smoke; json still emits `sessionId`.
- `-w` headless behavior (was silently ignored on 0.2.93 — if it starts working, the worker could simplify).

Any regression → rollback (Step 1 pin) + record findings + stop.

### Step 5 — Two-probe model ids
For each candidate id (from the refreshed models_cache, or `--model` argument):
1. **Positive probe** — cheapest real call, expect success:
   - codex: `env -u OPENAI_API_KEY -u CODEX_API_KEY codex exec --model <id> -c model_reasoning_effort=low --sandbox read-only --skip-git-repo-check --disable multi_agent --ephemeral -C <scratch> -o <out> - < <prompt-file>`
   - grok: `env -u XAI_API_KEY grok --prompt-file <file> -m <id> --tools "read_file,list_dir,grep" --no-subagents --output-format json --cwd <scratch>`
2. **Negative probe** — a fabricated id (e.g. `<id>-bogus`), expect the account's documented rejection shape.
3. Read the ground-truth models_cache and reconcile.

Codex 400 taxonomy: "requires a newer version of Codex" = CLI too old (go to Step 2); "not supported when using Codex with a ChatGPT account" = id not on this subscription.

### Step 6 — Walk the edit-point registry
Update every registered location with the verified allowlist + new version stamps. **These tables ARE the registry — keep them current when files move or a new harness is added.**

**Codex edit points:**
| File | What lives there |
|---|---|
| `.claude/agents/codex-worker.md` | the `case` gate (Step 2b) — THE mechanical enforcement; prose in constraint #3, `## Model` input contract, effort note |
| `.claude/rules-src/codex-worker-safety.md` | "Model allowlist" section + Grounding line + "Version drift" section |
| `.claude/skills/codex/SKILL.md` | user-facing `--model`/`--effort` flags line |
| `.claude/agents/codex-adversary.md` | `CODEX_ADVERSARY_MODEL` validation `case` + comment |
| `.claude/rules-src/codex-adversarial.md` | header version stamp + "Supported ChatGPT-subscription models" line |
| `.claude/rules-src/cli-integration-strategy.md` | Codex inventory row |
| `.claude/rules-src/harness-update.md` | Evidence-trail table version pin (Codex row) |

**Grok edit points:**
| File | What lives there |
|---|---|
| `.claude/agents/grok-worker.md` | the model `case` gate + input contract; **research-role `--tools` allowlist** (workroom research runs — widened write-free egress; re-probe the read-only guard AND that this list stays write-free on every version change) |
| `.claude/rules-src/grok-worker-safety.md` | allowlist + probe evidence + version drift + §Research role egress list |
| `.claude/skills/grok/SKILL.md` | `--model` flags line |
| `.claude/agents/grok-adversary.md` | `GROK_ADVERSARY_MODEL` validation |
| `.claude/rules-src/cli-integration-strategy.md` | Grok inventory row |
| `.claude/rules-src/harness-update.md` | Evidence-trail table version pin (Grok row) |

**Workroom-coupled surfaces (both harnesses):** the four agents above also carry an optional `## Workroom` block (`.workroom/PROTOCOL.md` is the schema owner). A harness update does not normally touch these, but if worker prompt contracts change shape, keep the workroom blocks + `.claude/skills/workroom/SKILL.md` dispatch snippet consistent in the same pass.

`--dry-run`: grep each edit point for the current allowlist + version strings and report consistent/drifted without editing.

### Step 7 — Evidence, sync, smoke
1. Append a dated section to `docs/<harness>-integration/DESIGN-RESEARCH.md`: versions, probe outputs (verbatim result lines), fixture results, new-behavior notes.
2. Commit on a branch FIRST, then `bash scripts/sync-to-active.sh` (the repo commit is the restore source; never sync uncommitted).
3. Smoke one real run per newly enabled model through the skill path (`/codex --model <id> <trivial question>` / `/grok --model <id> <trivial question>`) and confirm the telemetry row records the right model.

## Failure modes

| Symptom | Meaning | Action |
|---|---|---|
| "requires a newer version" (codex) | CLI too old for the model | Step 2 upgrade, re-probe |
| Auth assert fails post-upgrade | login state lost | user re-runs login; never API-key |
| Guard probe regresses (grok --tools stops blocking) | safety boundary changed | STOP; do not ship; redesign guard; tell Dave |
| Registry drift in --dry-run | someone edited by hand | reconcile via this playbook, not ad-hoc |
| grok version changed without you | auto-update | run this playbook reactively |
