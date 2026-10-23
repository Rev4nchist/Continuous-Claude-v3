# Tri-Model Combined Session Review — 2026-07-11

> **STATUS: EXECUTED (same day).** The combined build order below was completed in full on
> `feature/game-plan-governance` → merged to `main` via PR #19 (`5ac338c`), including the
> dogfood and Tracks D/F/G. This is now a historical planning record — for current state
> read `CURRENT-STATE.md`.

**Purpose:** first-pass reconciliation of the two workstreams that landed on `feature/tri-model-workers` today, so the next session picks up ONE combined plan instead of two parallel reports.

| Workstream | Session | What it produced |
|---|---|---|
| **Connection layer** (harnesses) | Claude (Fable 5) session | Shipped + tested: `/grok` full worker, Codex 0.144.1 + gpt-5.6 family, premortem reviewer picker, `/harness-update` playbook, 61-check test suite, Notion combined guide, PR #18 (commits `720430d`, `b2457e6`) |
| **Governance layer** (roster + workroom) | Grok 4.5 session | Designed, not built: `docs/tri-model/COLLABORATION-PLAN.md` — Game Plan roster doctrine, `.workroom/` disk bus, phase machine, Tracks A–G |

## Verdict: build them in tandem — confirmed

The two layers are not sequential; they share edit surfaces. Track C (workroom blocks in worker prompts) patches the **same four agent files** the connection layer just shipped and tested; Track E (roster defaults) rewrites the **same skill/doc copy**; the workroom preflight overlaps `/harness-update` Step 1. Building governance separately would mean re-touching every shipped file twice and re-running the suite twice. One combined workstream, one edit pass per file.

## What the game plan gets right (endorsed as-is)

The COLLABORATION-PLAN's core doctrine is adopted without amendment: rostered roles, builder ≠ reviewer (fixes the self-grading failure class), disk-is-the-bus (`.workroom/` + `CONTRACT.md`), Claude-as-hub phase authority, human Gates 1/2, ≤2 fix loops, fresh-context checkpoints, in-repo plan placement. Its §2.5 critiques (name drift vs verified allowlist ids, no auto-merge, failover self-grade rule, complexity-gated intake) are all sound.

## Policy change adopted (differs from what shipped today)

**Default builder = Grok; default reviewer/fixer = Codex (gpt-5.6-sol).** Today's shipped copy presents `/codex --implement` and `/grok --implement` as symmetric co-equal builders. Next session, Track E re-aligns:

| File shipped today | Needs Track E copy change |
|---|---|
| `.claude/skills/codex/SKILL.md` | Position implement as failover/specialized (`--builder codex` override), review/fix as primary role |
| `.claude/skills/grok/SKILL.md` | Position implement as the default milestone builder |
| `.claude/agents/*-worker.md` ×2, `*-adversary.md` ×2 | Track C: optional `## Workroom` / `## Milestone` / `## Role` blocks (fail-open when absent) |
| Notion "Cross-Model Workers in CCv3" (page `39676fd7ac8281068c7ee4b6f793f5af`) | Track F: add roster doctrine + Game Plan section (confirm-first; page was rewritten today WITHOUT roster policy — it is now one revision behind the plan) |
| HTML artifact (claude.ai/code/artifact/edadfc5f-…) | Same drift: presents symmetric builders; refresh alongside Track F |

## Corrections/additions this review makes to the game plan

1. **Verified-fact footnotes for the roster table (§2.2).** "Grok 4.5 → live web/X research" is TRUE and probe-backed (web_search/x_* in Grok's tool list) — but note the worker's **ask-mode `--tools` allowlist excludes web/x tools**. Research-role runs need a widened (still write-free) allowlist, e.g. `read_file,list_dir,grep,web_search,web_fetch,open_page` — that is a **deliberate egress expansion** and belongs in `grok-worker-safety.md` when Track C adds the `research` role. Do not silently reuse the ask guard for research.
2. **Preflight (Track G) already has verified building blocks** from today's suite: auth asserts, identity pin, `--version` stamps, allowlist greps, guard probe. The static tier is committed at **`scripts/tri-model/tri-model-suite.sh`** (run: `bash scripts/tri-model/tri-model-suite.sh` — 53 static checks; the dynamic tier is documented in the handoff: hook vitest via `cd .claude/hooks && npx vitest run src/__tests__/plan-exit-premortem-prompt.test.ts`, plus live guard/auth probes per the DESIGN-RESEARCH command shapes). Promote this script to `scripts/tri-model/preflight.mjs` rather than writing fresh.
3. **The advisory-gate gap grok-adversary found today** (harness-update rule 7: version drift not mechanically enforced) is exactly what the workroom preflight phase should close: preflight compares live `--version` to the verified pin and blocks `building` phase on mismatch. Wire these together in Track G, not as two separate mechanisms.
4. **Timeouts:** any workroom dispatch to Grok must use ≥300s external timeouts (cold-start killed a healthy run at the 120s default today — encoded in grok-worker's failure table).
5. **Telemetry discipline:** codex-worker self-exempted from a telemetry row on a "trivial" run today. Workroom bookkeeping should treat the jsonl row as part of milestone completion evidence, not optional.
6. **`.workroom/` + auto-commit hooks:** rooms/* must be gitignored BEFORE first room creation — the repo has git-auto-commit behaviors and status-based hooks; an unignored room would leak runtime churn into commits. Track A item 3 is load-bearing, do it first.
7. **Plan-placement rule violation — RESOLVED this session:** the original tri-model build plan (session-local `~/.claude/plans/we-have-worked-in-snuggly-pony.md`) is now copied in-repo as `docs/tri-model/BUILD-PLAN-2026-07-11.md`. Note: it is a **historical record of the plan as approved** — several plan-era assumptions were corrected during execution (see its top-of-file erratum; DESIGN-RESEARCH docs are the source of truth for shipped behavior).

## Combined next-session order (supersedes both separate roadmaps)

1. **Track A** — protocol + templates + `.gitignore` (gitignore FIRST), copy the build plan in-repo, land this review's §corrections into COLLABORATION-PLAN.
2. **Track B** — `/workroom` skill (new/status/post/advance/resume).
3. **Track C** — workroom/role blocks in the four agents (incl. the research-role allowlist decision, safety-rule updates, edit-point registry updates in `/harness-update`).
4. **Track E** — roster-default copy alignment (skills, rules, Notion Track F, artifact refresh).
5. **Dogfood** — one small real feature through Phase 1 + one milestone + Codex booth (dogfood criteria §5 of the plan).
6. **Track D** — `/game-plan` orchestrator only after dogfood.
7. **Track G** — preflight helper folded from the test suite + version-pin gate.

## Open decisions carried to Dave (from plan §7, unchanged)

Workroom opt-in vs auto (rec: opt-in first) · gitignore rooms (rec: yes) · Codex failover-only vs `--builder codex` override (rec: override flag) · Gate 1 under bypassPermissions (rec: model-side AskUserQuestion until a hook exists) · max fix rounds (rec: 2).

**Resolution protocol for the next session:** proceed with the recommended defaults above and state them in the first response; only block and ask if Dave overrides or if a decision becomes irreversible in the current step (e.g. don't create unignored rooms).
