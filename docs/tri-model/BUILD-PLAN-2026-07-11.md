# Plan: Tri-Model System — Grok + Codex + Claude Code in CCv3

Session: grok-integration-codex-upgrade (2026-07-11). Supersedes and absorbs `can-i-start-grok-vivid-haven.md`.

> **ERRATUM (2026-07-11, post-execution).** This is the historical record of the plan **as approved**. It was executed the same day (PR #18), and several plan-era assumptions were CORRECTED by live probes — do not implement from this document. The shipped reality (source of truth: `docs/grok-integration/DESIGN-RESEARCH.md`, `docs/codex-integration/DESIGN-RESEARCH.md` §13, and the safety rules):
> 1. Grok's native `-w` worktree flag is **silently ignored in headless mode** — implement uses a hand-rolled out-of-repo worktree (`../.grok-worktrees/`), not "native worktrees" as Track 2 step 3b assumes.
> 2. Grok read-only enforcement is the **`--tools "read_file,list_dir,grep"` allowlist** — `--sandbox` (referenced in Track 2 step 3a as `<read-only-profile>`) is decorative and blocks nothing.
> 3. "gpt-5.6" shipped as **three ids**: `gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-5.6-luna` (all probe-verified). The live default remains **`gpt-5.5`**; 5.6 is opt-in via `--model` (see `.claude/skills/codex/SKILL.md` for the authoritative flag line).

## Context

Dave wants Grok, Codex, and Claude Code working together inside Claude Code sessions:

1. **Pick models with commands** — `--model` selection on both `/codex` (incl. new `gpt-5.6`) and `/grok`, with probe-verified allowlists.
2. **Plan reviewers** — after a Claude planning session (ExitPlanMode), be offered Codex and/or Grok as cross-model plan reviewers via one prompt: **Codex / Grok / Both / Skip**.
3. **On-demand workers** — `/grok` as the full mirror of `/codex` (ask / implement / resume / review), per the proven pattern in the Notion "Codex in CCv3 — How-To Guide".
4. **Living documentation** — evolve the existing Notion Codex How-To page into a combined **Cross-Model Workers in CCv3** guide with the final command + workflow list for both models.
5. **Harness-update playbook** — reusable skill/rule so future sessions can pull new models/CLI versions for any harness correctly.

### Decisions locked with Dave
- Grok tier: **X Premium+** (eligible for subscription OAuth). Grok scope: **full mirror** (ask + implement + resume + review) — upgraded from "ask+review" once we confirmed the CLI's native worktree/session primitives.
- Plan-review UX: **one prompt, pick reviewers** (Codex / Grok / Both / Skip per plan).
- Codex: **upgrade CLI + full re-verification** to enable gpt-5.6.
- Notion: **evolve the existing page in place** into the combined guide.

### Ground truth (verified)
- **Grok CLI already installed**: `grok` v0.2.82 alpha at `C:\Users\david.hayes\.grok\bin\grok.exe`, on PATH, **not yet authenticated** (`grok models` → "not authenticated"). Real `--help` captured (2026-07-11): headless `grok -p "<prompt>" --output-format plain|json|streaming-json`; **native worktrees** (`-w/--worktree`, `grok worktree list|rm|gc`); first-class sessions (`-c/--continue`, `-r/--resume`, `grok sessions list|search|delete`); `-m/--model` + `grok models`; `--sandbox <PROFILE>` (profile names unconfirmed); `--permission-mode default|acceptEdits|auto|dontAsk|bypassPermissions|plan`; `grok login [--oauth|--device-auth]`; up to 8 parallel sub-agents (`--agents`, avoid until proven).
- **Codex surface map**: model allowlist enforced in ONE mechanical gate (`case` statement, `.claude/agents/codex-worker.md` ~line 74) + prose in 5 more places (see Track 1 table). Installed CLI 0.131.0; `~/.codex/models_cache.json` knows only gpt-5.5/5.4/5.4-mini → gpt-5.6 needs the upgrade (~0.142.x) + rule-mandated re-verification. Doc drift found: `codex-adversarial.md` line ~70 claims `gpt-5.3-codex` works (contradicts "any -codex id 400s") — fix.
- **Notion page**: `Codex in CCv3 — How-To Guide` (39676fd7ac8281068c7ee4b6f793f5af) — 4-mode table, flags, safety model, integration-files table, status/roadmap. Template for the combined guide.

Branch: `feature/tri-model-workers` off main, push to `fork` (never `origin`).

---

## Phase 0 — Evidence before code (two spikes, independent)

### 0A. Codex CLI upgrade + gpt-5.6 probe
1. Snapshot: `codex --version`, `codex login status`, copy `~/.codex/models_cache.json` aside. **Record rollback pin** (`npm i -g @openai/codex@0.131.0`) in DESIGN-RESEARCH v3 section BEFORE upgrading.
2. Baseline probe on 0.131.0: `codex exec -m gpt-5.6 --sandbox read-only --ephemeral` smoke (record the datapoint either way).
3. Upgrade to exact pinned latest; confirm `codex login status` = "Logged in using ChatGPT"; **smoke the existing default `/codex` ask path before any edits**. Re-verification fails → immediate rollback.
4. Re-run §3 verification per `codex-worker-safety.md` "Version drift": `-o`, `--ephemeral`, `--skip-git-repo-check`, `--disable multi_agent`, `exec resume` semantics, `--ignore-user-config` ask-only behavior, workspace-write file-write fixture on Windows, hooks-collision re-check (one fixture, one run).
5. Two-probe models: `gpt-5.6` (expect success) + fabricated id (expect 400); read new `models_cache.json` as ground truth. **Stop condition:** if gpt-5.6 still 400s → Track 1 becomes doc-only (record evidence, allowlist unchanged, tell Dave; playbook makes re-checking cheap later).

### 0B. Grok auth + probe spike (CLI already installed — no install step)
1. **Dave runs interactively** (cannot be scripted): `grok login` (`--oauth` browser flow; `--device-auth` fallback). Verify inference succeeds post-login on the X Premium+ subscription (watch for the reported 403-despite-OAuth quirk).
2. Record + pin **account identity** (non-secret identifier from login/status output) — worker preflight will fail closed on mismatch.
3. Agent-safe probes (read-only):
   - `grok models` → lock exact model ids (the "Grok 4.5" string + full list) for the allowlist. Never guess ids.
   - `grok -p "reply with the word OK" --sandbox <candidate> --output-format plain --cwd <repo>` → confirm headless single-turn works **on OAuth** (load-bearing), capture stdout shape/startup noise; test 2-3 sandbox profile names to find the read-only one.
   - **Negative control:** run with `XAI_API_KEY` set to a bogus value → require OAuth-or-fail (proves no silent API-key fallback; determines whether we need an `env -u XAI_API_KEY` pattern and how to express it on Windows).
   - `grok worktree list` before/after a `-w` test → confirm worktree storage location is OUTSIDE the repo (the in-repo-worktree skill-scan pollution problem from Codex dogfooding).
   - `--permission-mode` mapping test → which mode corresponds to our ask (read-only) vs implement (write-in-worktree, no auto-approve beyond files).
   - `grok mcp list` → note only (no MCP wiring in v0).
   - Timeout/hang behavior, exit codes, `--output-format json` event shape (for session-id capture → robust resume).
4. Billing/quota: confirm subscription-gated (no per-token spend); note any visible quota surfaces.
5. Document everything in `docs/grok-integration/DESIGN-RESEARCH.md` ("verified 2026-07-11 against grok 0.2.82" evidentiary style, mirroring the Codex doc).
6. **Gate:** headless-on-OAuth fails → stop; fallback decision with Dave (interactive-only lane vs explicit API-key — never silent).

---

## Track 1 — Codex model picker (gpt-5.6)

After 0A passes, update every edit point (only probe-confirmed ids):

| # | File | Edit |
|---|------|------|
| 1 | `.claude/agents/codex-worker.md` ~74 | Add `gpt-5.6` to the `case` gate |
| 2 | `.claude/agents/codex-worker.md` ~22/39/60 | Update prose restatements |
| 3 | `.claude/rules/codex-worker-safety.md` "Model allowlist" | New allowlist + upgrade date + evidence; update 0.131.0 version refs |
| 4 | `.claude/skills/codex/SKILL.md` line 28 | `--model gpt-5.6|gpt-5.5|gpt-5.4|gpt-5.4-mini` — default stays `gpt-5.5`, gpt-5.6 opt-in until it has clean mileage |
| 5 | `.claude/agents/codex-adversary.md` ~154 + frontmatter | Document gpt-5.6 as valid `CODEX_ADVERSARY_MODEL` override; add lightweight pre-exec validation of the env value against the allowlist (warn + fall back to default on mismatch) |
| 6 | `.claude/rules/codex-adversarial.md` ~70 | Fix the `gpt-5.3-codex` drift to match probe results |

## Track 2 — Grok full-mirror worker (`/grok`)

Built only after 0B verifies the real surface. Mirrors the Codex mold; simpler where Grok's native primitives allow.

- **`.claude/skills/grok/SKILL.md`** — modes table (ask default / `--implement` / `--resume` / `--review` → grok-adversary); flags `--model <probe-verified list>` (default = the flagship id from `grok models`), `--effort` only if the CLI exposes one, `--yes` for autonomous use. Triggers: `/grok`, "hand this to Grok", "have Grok audit/implement X", "delegate to Grok". Examples include the founding use case: `/grok "audit the CCv3 .claude system architecture and report findings"`.
- **`.claude/agents/grok-worker.md`** (`model: sonnet`, tools Read/Grep/Glob/Bash; no `.json` mirror — matches the confirmed Codex-agent exception) —
  - Step 1 parse field-block contract (`## Mode`, `## Request`, `## Model`, `## Autonomy`, `## Scope`, `## Codebase`); validate model via `case` allowlist.
  - Step 2 preflight: auth assertion (login/status), **account-identity check (fail closed on mismatch)**, API-key sanitization per 0B finding, **data-egress gate**: first-use-per-session confirmation naming xAI when repo content (not just a question) is included; secret-scan assembled prompt/diff; never include `.env*`/key-pattern files; payload cap.
  - Step 3a ask: `grok -p "<prompt>" --sandbox <read-only-profile> --output-format plain --cwd "$PROJECT" -m "$MODEL"` (prompt-from-file if the probe shows TTY footguns; per-run GUID scratch dir; external timeout).
  - Step 3b implement: `grok -w <name> -p ... -m "$MODEL" --permission-mode <mapped>` using **native worktrees** — confirm-first (unless `--yes`), independent `git diff` verification in the worktree after, review-gate: never auto-commit/auto-merge; patch applied only on Dave's approval. GC via `grok worktree gc` (documented, not hand-rolled).
  - Step 3c resume: `grok -r <session-id>` (capture id from `--json` events; `-c` fallback), inherits mode posture.
  - Step 4 telemetry → `.claude/logs/grok-worker.jsonl` (+ README; schema mirrors codex-worker: `ts, mode, model, sandbox, scope, task_summary, exit_code, git_diff_stat, session_id, usage_limited, via`).
  - Step 5 structured summary. Failure-modes table (not-authenticated, bad model, 403 quirk, hang, worktree conflict).
- **`.claude/agents/grok-adversary.md`** — read-only cross-model reviewer, `GROK_ADVERSARY_MODEL` env default, output-capture convention mirroring codex-adversary; findings prefixed `[Grok]`.
- **`.claude/rules/grok-worker-safety.md`** — auth = subscription-only (verify-first), account-identity pin, model allowlist + probe evidence, confirm-first matrix, data-egress section, worktree/native-GC notes, Windows hygiene, version-drift clause ("re-verify on CLI upgrade" → /harness-update), quota notes.
- Registration: skill-rules.json if applicable; Grok row + checklist score in `.claude/rules/cli-integration-strategy.md`.

## Track 3 — Cross-model plan-reviewer panel

The "offered as plan reviewers after a planning session" ask:

- **`.claude/hooks/src/plan-exit-premortem-prompt.ts`** — change the injected post-ExitPlanMode AskUserQuestion from the Codex-only premortem offer to: **"Run cross-model plan review?" → Codex / Grok / Both / Skip** (descriptions note quota cost; Both = parallel passes). Hook dev lifecycle applies: edit TS → `npm run build` → vitest (update/add test) → `bash scripts/audit-braintrust-emits.sh` → registration unchanged.
- **`.claude/skills/premortem/SKILL.md` Step 2.5** — generalize the adversarial pass: spawn the selected adversary agent(s) (codex-adversary and/or grok-adversary) in plan mode, parallel when Both; merge convention gains source tags `[Codex]`/`[Grok]`, `sources: [claude, codex, grok]`, cross-model-agreed marking.
- **Telemetry** — generalize: add a `model` field to the lift row schema; Codex rows keep writing to `codex-lift.jsonl` (back-compat), Grok passes write `grok-lift.jsonl` with the same schema + README. (Full unification deferred.)
- `/review` Phase 1 integration (grok-adversary as a standing third reviewer) is **deferred** — standing quota cost deserves its own go/no-go after mileage.

## Track 4 — Harness-update playbook

- **`.claude/skills/harness-update/SKILL.md`** — parameterized procedure (`codex` | `grok` | future): snapshot (version, auth, model cache) → record rollback pin → upgrade → re-assert subscription auth → re-run the harness's verification checklist → two-probe model ids (candidate expect-success + fabricated expect-reject; read ground-truth cache) → walk the **edit-point registry** (embedded per-harness tables: the 6 Codex points; the Grok points from Track 2) → dated evidence in the harness's DESIGN-RESEARCH → sync → one smoke run per changed model. Idempotent by construction (exact-string replacements; dry-run twice → zero diff; evidence sections dated-append).
- **`.claude/rules/harness-update.md`** — any CLI upgrade or new-model enablement MUST go through `/harness-update`; never add a model id from public docs without a live probe on this account; keep registries current when adding a harness.
- Optional: `scripts/codex/verify-models.sh`, `scripts/grok/verify-models.sh` probe helpers.

## Track 5 — Notion combined guide

Evolve the existing page (`39676fd7ac8281068c7ee4b6f793f5af`, "Codex in CCv3 — How-To Guide") in place into **"Cross-Model Workers in CCv3 — Codex + Grok How-To"**:
- Shared concepts once (Claude orchestrates → workers execute; subscription-only auth; confirm-first + diff-review; worktree isolation; telemetry).
- Per-model command tables: `/codex` 4 modes + flags (updated for gpt-5.6) and `/grok` 4 modes + flags (final verified list).
- Workflow list: on-demand ask, delegated implement + diff review, resume threads, `/review`//`premortem` cross-model passes, the new post-plan reviewer picker (Codex/Grok/Both/Skip), `/harness-update`.
- Gotchas per model (Codex Windows subprocess block; Grok's from the spike). Status/roadmap refresh.
- Mechanics: Notion MCP `notion-update-page` (page is outside job-owned surfaces → confirm-first with Dave before writing; keep the "Navigation Artifact" subpage link intact).

---

## Verification (end-to-end)

1. **Codex:** post-upgrade default-path smoke green; `/codex --model gpt-5.6 <question>` → clean answer + telemetry row `model: gpt-5.6`; `gpt-5.6-codex` rejected pre-exec; rollback command documented.
2. **Grok:** `/grok <question>` answers on subscription (bogus `XAI_API_KEY` negative control passes); `/grok --implement` on a disposable target → isolated worktree + reviewable diff + no auto-commit; `/grok --resume` continues the thread; `/grok --review` yields `[Grok]` findings; telemetry rows land; disallowed model rejected pre-exec.
3. **Plan-reviewer panel:** exit a toy plan → prompt offers Codex/Grok/Both/Skip; "Both" runs two parallel adversary passes with merged, source-tagged findings; hook vitest green; `audit-braintrust-emits.sh` passes.
4. **Playbook:** dry-run `/harness-update codex` reports all edit points consistent; greps for stale strings (`0.131.0`, `gpt-5.3-codex`) → zero hits.
5. **Docs:** grok DESIGN-RESEARCH exists with dated probe evidence; codex DESIGN-RESEARCH has v3 section; Notion page updated (confirm-first) with the final command/workflow list.
6. Commit on feature branch BEFORE `sync-to-active.sh` (repo commit = restore source); `/sync-drift` clean; PR to fork/main via REST.

## Risk mitigations (pre-mortem 2026-07-11, deep + Codex pass — carried forward)

All folded into the tracks above: data-egress gate (Track 2 Step 2.5 + rule), Codex rollback pin (0A.1), commit-before-sync restore path (Verification 6), headless-OAuth gate + interactive-only fallback shape (0B.6), account-identity preflight (0B.2/Track 2), Windows API-key sanitization negative control (0B.3), install provenance (moot — CLI already installed; version pinned 0.2.82), gpt-5.6 stop condition (0A.5), adversary env-override validation (Track 1 #5), per-run scratch dirs (Track 2), playbook idempotency (Track 4). Accepted: quota stacking (sized later via telemetry; the per-plan reviewer picker keeps it user-controlled).
