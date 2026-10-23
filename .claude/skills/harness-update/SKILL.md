---
name: harness-update
description: Upgrade the Grok harness and re-verify its live-probed model allowlist. Use when the user says "/harness-update", "update grok", "enable model X", or hits a "requires a newer version" error.
disable-model-invocation: true
---

# Harness Update Playbook

One procedure for keeping the Grok harness current: **snapshot → pin rollback → upgrade → re-assert auth → re-verify → two-probe models → walk the edit-point registry → record evidence → sync → smoke.**

The other cross-model CLI was removed. This playbook does not upgrade it, probe it, or keep an edit-point registry for it. If someone asks to update that CLI, say it is not part of this harness.

## Usage

```
/harness-update grok
/harness-update grok --model <id>   # also probe + enable a specific new id
/harness-update grok --dry-run      # walk the registry, report drift, change nothing
```

## Iron laws

1. **Live probe or it doesn't exist.** A model id enters an allowlist ONLY after a real call on THIS account returns success. Docs, blogs, and even the vendor's model table are hypotheses.
2. **Pin rollback before upgrading.** Record the exact installed version and its reinstall command first.
3. **Subscription auth is asserted before AND after** — an upgrade must never silently fall to an API key.
4. **Idempotent registry walk.** Edit points are exact-string replacements; running the procedure twice produces zero diff (`--dry-run` twice must report clean).
5. **Evidence goes in the session handoff.** `docs/grok-integration/DESIGN-RESEARCH.md` is a dated record. Do not append to it and do not rewrite it.

## The procedure

### Step 1 — Snapshot + rollback pin
| Harness | Version | Auth assert | Model ground truth |
|---|---|---|---|
| grok | `grok --version` | `grok models` header contains "logged in" AND `jq -r 'to_entries[0].value.email' ~/.grok/auth.json` = expected email | `~/.grok/models_cache.json` |

Copy the models_cache aside to `docs/grok-integration/snapshots/models_cache.<version>.json`. Record the rollback command:
- grok: `grok update --install <old-version>` (verify the subcommand's current syntax via `grok update --help` first; grok also AUTO-updates — a version change may have already happened without you)

### Step 2 — Upgrade
- grok: `grok update` (or let auto-update land; either way, treat any version change as requiring this playbook)

### Step 3 — Re-assert auth
Same asserts as Step 1. FAIL → stop, tell Dave to log in again (`grok login` for the Grok harness). Never proceed on an API-key fallback.

### Step 4 — Re-verify the capability surface
Run the verification checklist. Compare the live CLI with the behavior this skill already states. `docs/grok-integration/DESIGN-RESEARCH.md` is a dated record, not the checklist target:

- `grok --help` — confirm `-p`, `--prompt-file`, `--tools`, `--no-subagents`, `--output-format`, `-r` present.
- **Re-probe the read-only guard**: `--tools "read_file,list_dir,grep"` still blocks a write attempt (this is the load-bearing safety fact; `--sandbox` was decorative on 0.2.93 — check whether it started validating).
- Headless-on-OAuth smoke; json still emits `sessionId`.
- `-w` headless behavior (was silently ignored on 0.2.93 — if it starts working, the worker could simplify).

Any regression → rollback (Step 1 pin) + record findings + stop.

### Step 5 — Two-probe model ids
For each candidate id (from the refreshed models_cache, or `--model` argument):
1. **Positive probe** — cheapest real call, expect success:
   - grok: `env -u XAI_API_KEY grok --prompt-file <file> -m <id> --tools "read_file,list_dir,grep" --no-subagents --output-format json --cwd <scratch>`
2. **Negative probe** — a fabricated id (e.g. `<id>-bogus`), expect the account's documented rejection shape.
3. Read the ground-truth models_cache and reconcile.

### Step 6 — Walk the edit-point registry
Update every registered location with the verified allowlist + new version stamps. **This table IS the registry — keep it current when files move.**

**Grok edit points:**
| File | What lives there |
|---|---|
| `.claude/agents/grok-worker.md` | the model `case` gate + input contract; **research-role `--tools` allowlist** (workroom research runs — widened write-free egress; re-probe the read-only guard AND that this list stays write-free on every version change) |
| `.claude/rules-ondemand/grok-worker-safety.md` | allowlist + probe evidence + version drift + §Research role egress list |
| `.claude/skills/grok/SKILL.md` | `--model` flags line |
| `.claude/agents/grok-adversary.md` | `GROK_ADVERSARY_MODEL` validation |
| `.claude/skills/cli-integration/SKILL.md` | Grok inventory row |
| `.claude/rules-ondemand/harness-update.md` | Evidence-trail table version pin (Grok row) |

**Workroom-coupled surfaces:** the Grok agents also carry an optional `## Workroom` block (`.workroom/PROTOCOL.md` is the schema owner). A harness update does not normally touch these, but if worker prompt contracts change shape, keep the workroom blocks + `.claude/skills/workroom/SKILL.md` dispatch snippet consistent in the same pass.

`--dry-run`: grep each edit point for the current allowlist + version strings and report consistent/drifted without editing.

### Step 7 — Evidence, sync, smoke
1. Write the dated evidence (versions, probe outputs, fixture results, new-behavior notes) into the session handoff. Leave `docs/grok-integration/DESIGN-RESEARCH.md` unchanged.
2. Commit on a branch FIRST, then `bash scripts/sync-to-active.sh` (the repo commit is the restore source; never sync uncommitted).
3. Smoke one real enabled-model run per newly enabled model through `/grok --model <id> <trivial question>` and confirm the telemetry row records the right model.

## Failure modes

| Symptom | Meaning | Action |
|---|---|---|
| Auth assert fails post-upgrade | login state lost | user re-runs login; never API-key |
| Guard probe regresses (grok --tools stops blocking) | safety boundary changed | STOP; do not ship; redesign guard; tell Dave |
| Registry drift in --dry-run | someone edited by hand | reconcile via this playbook, not ad-hoc |
| grok version changed without you | auto-update | run this playbook reactively |
