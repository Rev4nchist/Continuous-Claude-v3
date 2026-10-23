# Tri-Model System — Current State Reference

<!-- machine:begin (sync-current-state.mjs — do not hand-edit this block) -->

**Auto-snapshot:** 2026-07-12T04:43:40Z · branch `feature/fable-harvest-loop` · HEAD `36f24e8 Merge pull request #20 from Rev4nchist/feature/fable-brain-transfer`

- Last tri-model change: `93c1de0 2026-07-11 docs(tri-model): hub-judgment reference — fable manual section 9 + standing trap harness pointer`
- preflight: ready=true | grok=0.2.93 (pin grok=0.2.93)
- Surfaces present on this checkout:
  - [x] /workroom skill (`.claude/skills/workroom/SKILL.md`)
  - [x] /game-plan skill (`.claude/skills/game-plan/SKILL.md`)
  - [x] /harness-update skill (`.claude/skills/harness-update/SKILL.md`)
  - [x] workroom protocol (`.workroom/PROTOCOL.md`)
  - [x] preflight gate (`scripts/tri-model/preflight.mjs`)
  - [x] static suite (`scripts/tri-model/tri-model-suite.sh`)

**Workrooms (runtime, gitignored):**

| Room | Phase | Milestone | Next actor |
|---|---|---|---|
| `2026-07-11-tri-model-preflight` | done | M1 | none |

_Refresh: `node scripts/tri-model/sync-current-state.mjs` (narrative below the marker is hand-maintained)._

<!-- machine:end -->

**Ground truth for any session on the tri-model system.** The auto-snapshot block above is machine-refreshed (`node scripts/tri-model/sync-current-state.mjs` — run it after any tri-model change; `--check` mode reports staleness without writing). Narrative below is hand-maintained at milestones.

## Layer status

| Layer | Where | Status |
|---|---|---|
| **Governance layer** — workroom disk bus, roster policy, preflight gate | `feature/game-plan-governance` → main | ✅ Built + dogfood-verified · ✅ **Gate 2 APPROVED (Dave, in-session 2026-07-11)** — merged same session (see auto-snapshot for live branch/HEAD) |
| Track D `/game-plan` orchestrator | `.claude/skills/game-plan/SKILL.md` | ✅ Shipped 2026-07-11 (built last, after dogfood, per plan; encodes dogfood learnings) |
| Track F Notion roster rewrite | page `39676fd7ac8281068c7ee4b6f793f5af` | ✅ Done 2026-07-11 (Game Plan section, roster TL;DR, status refresh, cockpit-guide link) |
| Operator cockpit guide | Notion page `39a76fd7ac82817abc0bffdfeaec1c54` (Project Board child) + `docs/tri-model/cockpit-guide.html` | ✅ Published + read-back verified 2026-07-11 |

**Hub judgment reference:** `docs/fable-manual/OPERATING-MANUAL.md` §9 — Fable-5-authored orchestration judgment for the hub role (milestone sizing, weasel-proof contracts, per-family failure signatures, thin-evidence asymmetry, fix-loop stop conditions), harvested 2026-07-11. Companion standing harness: `docs/fable-manual/TRAP-TESTS.md` — re-run before shipping any prompt-layer change. Note its gate result: an always-on distillation rule showed **no lift** over the existing rules layer (51/51 both arms) and was deliberately NOT installed.

## What exists on `feature/game-plan-governance`

| Track | Deliverable | Key paths |
|---|---|---|
| A | Workroom protocol + 7 templates, **gitignore-first** (`rooms/*` never committed) | `.workroom/PROTOCOL.md`, `.workroom/templates/` |
| B | `/workroom` skill: `new / status / post / advance / resume` | `.claude/skills/workroom/SKILL.md` |
| C | Workroom/role blocks in the Grok worker and adversary (fail-open without a `## Workroom` block); **Grok `research` role** = widened write-free `--tools` incl. `web_search` (documented egress expansion) | `.claude/agents/grok-worker.md`, `.claude/agents/grok-adversary.md`, `.claude/rules/grok-worker-safety.md` |
| E | Roster copy realigned: **Grok builds** | skills + rules copy |
| G | `scripts/tri-model/preflight.mjs` — auth/identity/allowlist/version-pin gate (closes the advisory-gate gap). **Built BY Grok THROUGH the first real workroom** (`2026-07-11-tri-model-preflight`), graded by booth, HIGH finding fixed in round 1 | `scripts/tri-model/preflight.mjs` (630 lines) |
| — | Operator docs: cockpit guide (also on Notion page `39a76fd7ac82817abc0bffdfeaec1c54`), system-overview HTML | `docs/tri-model/cockpit-guide.html`, `system-overview.html` |

**Dogfood proved the doctrine:** booth returned a thin approve (2 of 3 invocations fork-stormed) → the supplemental Claude critic caught a real HIGH (JSON.parse error path echoing `auth.json` secret bytes) → fixed it (fix-round 1/2) → hub verified with a canary-secret probe. Builder ≠ grader caught what self-grading would have shipped.

## Probe-backed facts added during governance dogfood (trust these)

1. **A read-only sandbox on Windows can fork-storm** on subprocess denial (about 40 orphaned processes). Rich checklists trigger it; compact prompts do not. Keep adversary prompts compact; after a timeout, check the process list; treat a 0-findings pass after storms as thin evidence and add a Claude-critic lens. Evidence: `docs/fable-manual/eval/LOOP-LOG.md`.
   **1b. GROK CAN FORK-STORM TOO (2026-07-12, live observation)** — a `grok-adversary` plan-mode run on this host accumulated ~27 descendant `grok.exe` processes before manual `taskkill /T` cleanup; the retry succeeded cleanly. Fork-storm-on-Windows is not limited to one family. Same hygiene for Grok dispatches: compact prompts, post-timeout `tasklist | findstr grok`, check for leftover processes after any Grok run. Evidence: `docs/fable-manual/eval/LOOP-LOG.md` iteration 3.
2. **`$CLAUDE_PROJECT_DIR` can be EMPTY in agent shells** — workroom dispatch blocks must pass ABSOLUTE paths.
3. **Grok cold start hit ~11–12 min once** (far past the documented 120s and even the 300s guidance) — on timeout, poll for the output file; do NOT re-invoke.
4. **`sync-to-active.sh` deliberately excludes `hooks/src`** (dist-only by design) — active `~/.claude/hooks/src` drifts; never `npm run build` there without first mirroring `src/shared/` from the repo.

## Standing facts from the connection layer (unchanged, evidence in DESIGN-RESEARCH docs)

- Grok read-only = `--tools "read_file,list_dir,grep"` ONLY (`--sandbox` decorative; `--permission-mode plan` doesn't block writes headless). `-w` ignored headless → `../.grok-worktrees/`. Identity pin = `auth.json .email`. CLI auto-updates.
- Any model/CLI change goes through `/harness-update` (edit-point registries; two-probe rule; rollback pins).

## Reading order for a fresh session

1. This file.
2. `docs/tri-model/SESSION-REVIEW-2026-07-11.md` — combined build order + corrections (Tracks A/B/C/E/G now DONE per above; remaining: merge, Track F, Track D).
3. `docs/tri-model/COLLABORATION-PLAN.md` — full governance design (roster doctrine §3.1, phase machine §3.4, open decisions §7).
4. `.workroom/PROTOCOL.md` (on the governance branch) — the live message/phase schema.
5. Safety rules: `.claude/rules-ondemand/grok-worker-safety.md`, `harness-update.md`.

## Dogfood room disposition (2026-07-11-tri-model-preflight)

Phase `done`. Gate 1 pre-authorized (pattern explicitly blessed by Dave in-session), Gate 2
approved by Dave 2026-07-11. Timeline: Grok built → hub smoke 3/3 → booth thin-approve
(2/3 fork-storms) → Claude critic caught HIGH H1 (secret-byte echo on malformed auth.json)
→ fixed R1/2 → hub canary-probe verified. Commits `d42eb6f` (baseline) + `73d2a63` (fix).
Worktrees removed; room retained on disk as the reference example.

## Open items (in order)

1. Fresh-session smoke: `/workroom resume`, `/game-plan` routing, rostered agent spawns (new agents register at session start).
2. Watch items: read-only fork-storm recurrence (keep adversary prompts compact; §14), Grok cold-start outliers (one ~11–12 min case), telemetry-row discipline on "trivial" runs.
3. Deferred roadmap: `--json-schema` structured output; grok-adversary as a standing `/review` reviewer (go/no-go on quota data); fork-storm bounding wrapper.
