# Plan for approval: repair CCv3 with a ratchet — do not rebuild

Written 2026-07-28 by session `b9978324`, answering the handoff at
`docs/harness-strategy/2026-07-28-handoff-repair-vs-rebuild.md` (commit `b8f24d3`).

**Part 1 is done and committed** (`c77f85c`, `189fb46`) — see the last section.
**Part 2 is this document, and it is a plan, not work in progress.** Nothing has
been pruned, deleted, or migrated. Steps 0–10 below need your approval.

Every claim is marked VERIFIED (a command was run and its output read) or
REPORTED (inferred). That distinction is load-bearing: **two of the five
investigations below were refuted by their own adversary**, both on the same
fault — a count read from the wrong place. Those are instances seven and eight
of the house defect, produced *inside the verification pass for the plan meant
to cure it*. That is the single strongest argument in this document.

---

## The headline

**Q1 passes decisively. The repo IS a viable base.** The branch of the decision
tree that would have made "rebuild from live" coherent is closed.

**All 85 live hook registrations are reproducible from committed state**, and all
18 "live-only" hooks exist in git HEAD as **both** `src/*.ts` and `dist/*.mjs`
(18/18, verified with `git cat-file -e`, not filename globbing). Rebuilding
`~/.claude` from the repo is a file copy plus ~0.2 MB of capture, not a
reconstruction.

**Recommendation: UPHOLD the prune-and-ratchet proposal, with four amendments.**

---

## Q1–Q5

### Q1 — Is the repo a viable base? **YES.** VERIFIED, not refuted.

The adversary re-derived every number with a different parser (PowerShell
`ConvertFrom-Json` vs node) and a stricter sub-command-aware key, and got the
same residual.

| | live `~/.claude` | repo | `settings.json.template` |
|---|---|---|---|
| entries / distinct | 85 / 80 | 69 / 64 | 73 / 69 |

- Union of the two committed settings files covers **81 of 85**.
- The residual **4** (`permission-auto-allow`, `mcp-activity-tracker`,
  `architecture-stats-sync`, `vercel-deploy-context`) are all in committed
  `docs/reviews/2026-06-10/harvest/registrations-active.json` with matching event.
  Caveat the adversary sharpened: live `settings.json` has **zero `*` matchers**
  while the harvest uses `*` for 35 of 81, so 2 of the 4 need matcher
  translation, not a straight copy.
- **Genuinely uncommitted, ~0.2 MB:** 59 files in `~/.claude/commands/` (never in
  repo git on any branch — proven with a positive control that returned 90
  commits for `.claude/rules`), `~/.mcp.json` (7 servers), live
  `settings.local.json` (315 B, carrying the `rm`/`neonctl` deny rules).

### Q2 — Is the 86k figure real? **The loader does NOT de-duplicate.** Mechanism VERIFIED, magnitude MODELED.

The risk this question existed to catch — that identical rules loaded from two
scopes get de-duplicated, making the largest cheap win evaporate — **is not
real.** Falsified three independent ways: both agents observed all 46 rules
**twice, verbatim** in their own system prompts; binary extraction from
`claude.exe` 2.1.220 shows the dedup Set key is normalized-path + `toLowerCase`,
categorically not a content hash; and the token delta would be ~0 if dedup existed.

**But "~88% recoverable" is overstated**, and this is amendment 1:

| lever | recovered |
|---|---|
| drop the duplicate project rules copy | 45.4% (45,299 tok) |
| + gate 13 tool-conditional rules | 65.5% |
| + aggressive gate (8 safety rules stay always-on) | 78.0% |
| theoretical ceiling | 90.3% |

- `paths:` frontmatter **is implemented** in 2.1.220 (`dny()` parses it, `JPt`
  partitions, `pfo` glob-matches, with an explicit User-scope branch) — the
  mechanism the plan depends on exists. **0 of 46 rules use it**, re-verified at
  byte level, BOM-aware, with a positive control.
- **Scope correction that matters:** the 45% duplicate-drop applies *only inside
  continuous-claude*. 18 of 19 registered projects already load one copy.
  **Fleet-wide value of the biggest single lever ≈ 0.** The fleet-wide lever is
  `paths:` gating, not de-duplication.
- **Disagreement, unresolved:** the 99,861-token figure comes from `count_tokens`
  against a *reconstruction* of the loader's serializer. The adversary had no API
  key and could not replicate; its independent estimate is compatible with but
  cannot distinguish 86k from 100k. A byte-ratio cross-check agrees on the
  *fraction* (44.5% vs 45.4%). Treat the absolute number as one unreplicated
  measurement. The direction is safe; the magnitude is not settled.
- **A sixth vacuous gate, found in the proposed step itself:** the regression
  guard drafted for this step runs in `agent-arch`, which has **no `.claude/rules`
  directory at all**, so the exclude pattern can never match there and the guard
  cannot fail. Replaced in Step 8 below with a file-count-delta assertion.

### Q3 — Hook latency per turn? **REFUTED.** The answer is not established.

The investigation concluded ~1.15 s per Bash call and "97% is five hooks". The
adversary killed it:

- It read `TRACE_TO_BRAINTRUST` / `BRAINTRUST_API_KEY` from the **process
  environment** and concluded tracing was off → "295 ms of pure waste".
  `braintrust_hooks.py` main() (L883–897) unconditionally loads `~/.claude/.env`
  into `os.environ` **before** computing `TRACE_ENABLED`, and that file sets
  `TRACE_TO_BRAINTRUST = true` with a live key. **Wrong place, wrong key — the
  count read zero because the query looked where the value never lives.** The
  script's own comment names the reason.
- Every per-hook timing used `tool_name:"__probe__"`, which trips each hook's
  first guard. "39 of 46 hooks cost 51–82 ms" is a **no-op floor**, not per-turn
  cost.
- Tracing being ON means a **synchronous `httpx` POST on every Bash/Edit/Write
  turn**, unmeasured.

**Amendment 3: the latency counter-argument to "prune, don't rebuild" is NOT
disposed of.** The unmeasured real-payload cost runs in the direction that would
strengthen it. Step 6 re-measures before anyone claims otherwise.

**What survived, independently reproduced:**
- **7 registered hooks arm `setTimeout(()=>resolve(data), 1000)` in `readStdin()`
  with no `clearTimeout`/`.unref()`.** Work resolves in 2–18 ms; the process then
  idles ~1,050 ms. A/B control: 1,070 ms → 78 ms with `.unref()`. This is real,
  cheap, and fixed in Step 5.
- **`node -e 0` median 41–44 ms — the spawn pathology is gone.** (My own
  independent measurement during Part 1 agrees: load-probe p50 47 ms.) The
  memory note recording p50 2.6 s / 19% over 5 s is now stale.
- Dispatch is **parallel** (9 processes in an 89 ms window), so per-turn cost is
  MAX, not SUM.
- `msys-crash.jsonl` (76 events) is **100% `git commit`/`git push`** — zero
  correlation with hook fan-out. All 86 registrations invoke `node` or `python`,
  never bash.
- **Incidental but alarming:** 80 of 85 registrations carry `timeout` in
  **milliseconds** in a field Claude Code reads as **seconds**. `5000` = 83
  minutes. **No hook has effective timeout protection.**

### Q4 — Do advisory hooks matter? **REFUTED on its decisive result.**

The investigation's headline was that `agent-recall-injector` is 0-for-339 — its
nominated proof that advisory hooks are near-silent. It is **163 of 276 (59%)**,
and 34 of 54 in the last 7 days.

It read `kept_after_floor` from `agent-recall.jsonl`, which measures only the
*memory-recall* arm. Reading the source (`agent-recall-injector.ts:396–444`)
rather than grepping it shows **two** injection paths —
`injected = recallUsable || hasFocusBlock` — and `LogEntry` has no field for the
second. The real flag goes to `intel-bus.jsonl`, a file the investigation itself
measured as fresh (737.9 KB, 0.0 days old) and never queried.

**That hook was the #1 high-confidence delete. It comes off the list.**

Surviving and worth acting on: 14 of 15 named hooks emit `{result, message|reason}`
with **no** `additionalContext` and no `hookSpecificOutput` anywhere in source —
including `skill-activation-prompt` (760 lines, the flagship skill router) and all
five `session-start-*` loaders. Six test files assert that same shape, so **a green
suite cannot detect it**. `guardrail-enforcer.ts:170–175` states the intent is
`additionalContext` and emits a payload without it, three lines apart.

**Load-bearing caveat: nobody verified that Claude Code actually drops that
envelope.** The whole 15-hook finding rests on that inference. Cheapest
falsification available anywhere in this document — trigger a guardrail and look.

### Q5 — The dead set across all three registries. **31 dead, 27 deletable.** VERIFIED, not refuted.

The adversary re-derived 31 with a deliberately over-inclusive method (biased
toward a *smaller* dead set) and got the identical name list.

- 115 sources / 115 dist, 1:1, zero orphans either direction. Registered
  somewhere: 84.
- **Amendment 2 — "no hook imports another" is FALSE.** 4 of the 31 are library
  modules: `daemon-client` (11 importers), `skill-router`,
  `skill-validation-prompt`, `transcript-parser`. esbuild `--bundle` inlines them,
  which is why runtime independence still holds — but **deleting them breaks the
  next build, not the running harness.** A silent failure, i.e. the house defect
  reproducing inside the cure. The proposal's "a rebuild's structural payoff is
  zero because nothing imports anything" needs this correction; the *conclusion*
  survives, the *reason* was overstated.
- 15 of the 31 appear in `settings.json.bak` — deliberately deregistered.
  `diagnostics` is referenced by `settings.json.template`, so deleting it breaks
  a fresh install. `session-start-parallel` ships an old unfixed dist — a
  landmine, not cruft.
- **Vacuous-gate audit passed:** 8 plugin registries at
  `~/.claude/plugins/**/hooks/hooks.json` were found that neither party had
  checked — 0 hits against all 115 basenames.

**The handoff's Codex claim is REFUTED, and I measured this independently before
seeing the workflow's answer — two methods, same result.** The handoff said the
three coordination hooks (`session-register`/`heartbeat`/`file-claims`) are in the
stale cohort running the old python-subprocess transport. They are precisely the
**3 fresh ones**: all dated 2026-07-27, `uv run python` absent,
`connectionTimeoutMillis` present, SHA256-identical to the live Claude dist. The
6/60-intruder hazard does not apply. The 99/103 split itself is correct (99 at
2026-05-04 19:32, 1 at 07-21, 3 at 07-27).

> Method note on my own measurement: my first pass reported "0 files ≤ 2026-05-04"
> because I compared `LastWriteTime -le '2026-05-04'` against files stamped
> `2026-05-04 19:32`. I re-measured before reporting. Read the count before you
> believe the verdict — including your own.

**New hazard, observed live, created by my own Part 1 commit:** the Codex bundles
are **copies, not symlinks**, so the Bug 1 liveness fix does not propagate. Live
Claude `file-claims.mjs` bare-heartbeat count = 0; Codex = 3. **The fix is
currently half-deployed.** That is Step 1, and it needs your call (see the end).

---

## Verdict

**UPHOLD, with four amendments.**

1. Recoverable context is **45–78%**, not ~88% — and the single biggest lever is
   worth **~0 outside continuous-claude**. The fleet-wide lever is `paths:`.
2. **"No hook imports another" is false** — 4 build-time import edges. Runtime
   independence survives; *prune safety* does not.
3. **The Q3 latency argument is not disposed of** and must be re-measured with
   real payloads before anyone leans on it either way.
4. **Sequencing is not negotiable: ratchet first.** Two of five investigations
   here failed on wrong-place counts. If verification done deliberately, by
   independent agents, under instructions to measure rather than reason, produced
   two instances of the defect — then a prune run before the ratchet exists will
   delete live hooks on no data.

---

## The ordered step list

Every acceptance criterion asserts a **nonzero count**. Where zero is the target,
it is paired with a nonzero denominator so the check cannot pass by finding
nothing. Steps 5–7 are independent of registration state and may run in parallel
with 2–4.

**Step 0 — Capture the uncommitted config.** Commit `~/.claude/commands/` (59
files), `~/.mcp.json`, live `settings.local.json`.
→ **Accept:** `git ls-files .claude/commands` ≥ **59**; committed `.mcp.json`
parses to ≥ **7** `mcpServers` keys; `settings.local.json` has ≥ **4**
`permissions.deny` entries.

**Step 1 — Finish the Bug 1 propagation to Codex** (needs your approval; see below).
→ **Accept:** SHA256 matches live Claude for **3 of 3** bundles; `GREATEST(last_heartbeat`
occurrences in Codex `file-claims.mjs` ≥ **1** *and* bare `last_heartbeat >= NOW` = 0
— the ≥1 is what makes the 0 non-vacuous.

**Step 2 — RATCHET A: registration-set reconciliation.** A CI script parsing live +
repo `settings.json` + template + harvest, **args-aware** (`{"command":"node","args":[path]}`
— the exact `ee29181` fault).
→ **Accept:** parser yields ≥ **86** live entries and ≥ **81** distinct names, **and**
unparsed = 0 *given* parsed ≥ 86; committed union covers ≥ **82** of live; fails if
the live count drops below its recorded baseline.

**Step 3 — RATCHET B: output-contract shape assertion.** Every registered hook's
source must contain ≥1 field the harness actually reads (`hookSpecificOutput`,
`systemMessage`, `permissionDecision`, `decision`, `updatedInput`).
→ **Accept:** ≥ **44** hooks pass; the dropped-envelope set is pinned at exactly
**19** and the script fails if it grows.

> #### Step 3a — RUN, and CONFIRMED. The envelope IS dropped.
>
> This step is **not** void; it is the highest-priority repair in the document.
> Verified 2026-07-28 by a controlled natural experiment in session `b9978324`,
> with a positive control on the same prompt:
>
> - `guardrail-enforcer` is registered on `UserPromptSubmit` — VERIFIED in live
>   `settings.json`.
> - This session's **first prompt** contained "bugs" and "fix", matching its
>   `systematic-debugging` trigger. It **fired at 19:18:35** — VERIFIED by the
>   state file `$TEMP/claude-guardrails-45972.json`, written at that exact second
>   with `{"acknowledgedGuardrails":["systematic-debugging"]}`.
> - Its output is `{result:'block', reason: <🛑 text>}` with no
>   `hookSpecificOutput` — VERIFIED by reading `guardrail-enforcer.ts:170-175`,
>   whose comment three lines above says "Return valid JSON so Claude sees message
>   as additionalContext".
> - **That text reached context nowhere.** The only occurrence of "Debugging
>   methodology required" in the transcript is my own later `Read` of the source
>   file; every other hit is a grep command echoing itself.
> - **Positive control, same event, same prompt:** `memory-awareness`, which uses
>   `hookSpecificOutput.additionalContext`, **did** inject (8 occurrences).
>
> Two hooks, one event, one prompt, different output shape — one reaches the model
> and one does not. That is a clean controlled result, not an inference.
>
> **The systemic root is `shared/output.ts`.** Two of its three helpers —
> `outputWithMessage()` and `outputBlock()` — emit `{result, message}`, a shape the
> harness ignores. (`outputContinue()` is fine; it is only a no-op signal.) So this
> is one shared bug with four direct callers, not fifteen independent mistakes.
>
> **Measured blast radius: 19 of 80 registered hooks with a repo source emit ONLY
> the dropped envelope** (44 emit a field the harness reads). Named:
> `agent-verification`, `git-commit-roadmap`, `guardrail-enforcer`,
> `maestro-cleanup`, `maestro-detector`, `maestro-state-manager`,
> `prd-roadmap-sync`, `ralph-progress-inject`, `ralph-retry-reminder`,
> `ralph-watchdog`, `session-end-handoff-indexer`, `session-outcome`,
> `session-register`, `session-start-context-loaders`, `session-start-docker`,
> `session-start-init-check`, `session-start-memory-loaders`,
> `session-start-recovery`, `skill-activation-prompt`.
>
> **Do not fix all 19 blindly.** A meaningful subset (`session-register`,
> `git-commit-roadmap`, `prd-roadmap-sync`) are side-effect hooks whose real job is
> writing to the DB or git; for those a dropped envelope costs nothing. The ones
> that matter are the ones whose entire purpose is to tell the model something —
> `skill-activation-prompt` (760 lines, the flagship skill router), the five
> `session-start-*` loaders, the three `ralph-*` hooks, and `guardrail-enforcer`.
>
> **The tension to decide before fixing:** repairing these makes 19 hooks start
> injecting text that has never been in context. That is *more* context load, in a
> plan whose other half is cutting context. Triage by whether the hook needs to
> speak at all — and note that six test files assert the broken shape, so a green
> suite has never been able to detect this and will resist the fix.

**Step 4 — RATCHET C: timer census**, extending the pattern of
`audit-braintrust-emits.sh` — the only guard here with a catch record (6
regressions), precisely because it counts.
→ **Accept:** census finds ≥ **8** dist bundles matching the stdin timer-resolve
pattern **and** ≥ **8** carry `.unref()`/`clearTimeout`.

**Step 5 — Fix the 7 dangling-timer hooks** (`architecture-stats-sync`,
`git-commit-roadmap`, `roadmap-completion`, `post-plan-roadmap`, `pre-plan-memory`,
`session-start-continuity`, `prd-roadmap-sync`). One `.unref()` each.
→ **Accept:** Step 4 reports **8/8**; sampled wall-clock for ≥ **3** hooks drops
below 150 ms over ≥ **5** iterations each.

**Step 6 — RE-MEASURE Q3 with REAL payloads.** — **DONE 2026-07-28.**

> #### Step 6 result: the hook layer costs ~1s per tool call, and it is TWO processes
>
> Method: `scripts/hooks/hook-latency-sampler.ps1` polled during 20 real Bash
> turns and 20 real Write/Edit turns (300s, 7,585 polls, ~40ms interval, 266
> processes seen), plus `scripts/hooks/measure-fanout.mjs` which runs *every*
> registered hook for a tool with realistic payloads.
>
> **Corrected fan-out** (matcher-aware, from live `settings.json`). The reported
> "13 per Bash / 11 per Edit / 15 per Task" was close but wrong:
>
> | tool | PreToolUse | PostToolUse | total |
> |---|---|---|---|
> | Bash | 3 | 12 | **15** |
> | Edit / Write | 3 | 10 | **13** |
> | Task | 10 | 7 | **17** |
> | Read / Grep | 1 | 5 | **6** |
> | Glob | 0 | 3 | **3** |
>
> Plus **14** per user message (UserPromptSubmit) and **13** per SessionStart —
> those are per-message/per-session, NOT per tool call.
>
> **The cost is concentrated in two processes, both measured on real turns:**
>
> | process | n | p50 | max | fires on |
> |---|---|---|---|---|
> | `braintrust_hooks post_tool_use` | 29 | **1,017 ms** | 1,725 ms | EVERY PostToolUse |
> | `post-edit-diagnostics` | 16 | **1,364 ms** | 2,546 ms | every `.ts`/`.tsx` edit |
> | `claude-hud/launcher.mjs` *(plugin, not a hook)* | 22 | 581 ms | 2,833 ms | per turn |
>
> Every other hook measured **64–87 ms** with a realistic payload, and dispatch is
> parallel (peak 13 simultaneous observed), so the other ~13 hooks in a fan-out
> cost roughly **one** hook's wall time, not their sum.
>
> **This reshapes the plan: the prune's value is NOT latency.** Deleting the ~30
> quiet hooks would save close to nothing measurable. Turning off Braintrust
> tracing would save ~1s on *every tool call* — a far larger win than the entire
> prune, and it is Step 7.
>
> **Two methodological corrections, both recorded because both nearly misled me:**
> - `measure-fanout.mjs` timed `braintrust_hooks` at **285 ms** while the sampler
>   measured **1,017 ms** on real turns. The constructed payload lacks
>   `turn_span_id`, so the hook early-returns *before* the synchronous HTTP POST —
>   the exact trap that refuted Q3, reproduced here on purpose. **Constructed
>   payloads understate; the sampler number is the authoritative one.**
> - The sampler's first classifier matched any `.mjs`/`.py`, so it counted my own
>   tooling (`vitest`, `update-blocklist`, the embedding daemon) as hooks and
>   reported p50s in the tens of millions of ms — their *age*, not their duration.
>   The absurd numbers were the lucky case; `launcher` at 581 ms looked exactly
>   like a plausible hook and is a statusline **plugin**. Classification is now by
>   path, with plugins reported separately.
>
> **Acceptance criterion NOT met as written, and it cannot be.** It asked for ≥10
> distinct hooks from the sampler; polling caught **2**, an 8.7% capture rate,
> because without elevation `Win32_ProcessStartTrace` is denied and any hook
> shorter than a poll interval is invisible. Polling is biased toward slow
> processes *by construction*. That is why the fan-out census is taken statically
> and the fast hooks are timed directly — the ≥10-distinct requirement is met by
> `measure-fanout.mjs` (13 hooks timed for Edit, 3 for Bash), not by the sampler.
> Reported rather than worked around.

**Step 7 — Decide on Braintrust tracing.** It is ON, doing a synchronous POST per
Bash/Edit/Write turn.
→ **Accept:** ≥ **10** real PostToolUse invocations timed with tracing on and off;
report the delta as a number, not a verdict.

**Step 8 — Context lever, with a non-vacuous guard.** `claudeMdExcludes` in
`~/.claude/settings.local.json` (never synced), one key, revertible, no file moves.
→ **Accept:** `/context` memory-file count in continuous-claude drops ~**95** → ~**49**
and tokens by ≥ **30,000**; **and** in a project with no rules dir the count is
**unchanged at ≥ 49** and the session can still quote the first rule under
"Deletion Commands (ALWAYS ASK FIRST)".

**Step 9 — Fleet-wide: `paths:` frontmatter on the 13 tool rules, in USER scope.**
Keep user scope; gate or drop the *project* copy. **The proposal's step 3 was
inverted** — 18 of 19 projects have the user copy as their only copy of the 5
safety rules.
→ **Accept:** ≥ **13** rule files carry `paths:` (currently 0 of 46); memory-file
count in a non-continuous-claude project drops by ≥ **13**; the 8 always-on safety
rules still count ≥ **8** loaded.

**Step 10 — Re-derive the prune list against `intel-bus.jsonl`, then prune. LAST.**
`agent-recall-injector` is **off** the delete list. Never delete: the 13
outcome-changers, `epistemic-reminder`, `memory-awareness`, `post-edit-diagnostics`,
the 4 coordination writers, the 4 library modules, `diagnostics`, the 4 Codex-only hooks.
→ **Accept:** for each candidate, `intel-bus.jsonl` shows **0 `injected=true` rows
across ≥ 50 recorded invocations**; post-prune `npm run build` emits ≥ **88** bundles;
Step 2's ratchet still reports ≥ **86** live registrations.

---

## What we did NOT verify

- **`/context` was never run.** Every Q2 token number is `count_tokens` against a
  *reconstruction* of the serializer, replicated by neither agent. Step 8 is the
  first real measurement.
- ~~Whether Claude Code actually drops `{result, message|reason}`~~ — **RESOLVED
  2026-07-28, see Step 3a. It does.** Confirmed by controlled experiment with a
  positive control, not inference. 19 registered hooks affected; root cause is two
  helpers in `shared/output.ts`.
- **`claudeMdExcludes` was never executed** — read from the binary, never observed
  excluding a file.
- **`paths:` frontmatter end-to-end** — parser and both loader branches read; no
  gated rule was created and observed to load/not-load. User-scope glob base dir
  is unverified for files outside cwd.
- **Real-payload hook latency** — all Q3 per-hook numbers used `__probe__`.
- **58 of 79 hooks were never executed** — every SessionStart/UserPromptSubmit/
  SessionEnd hook, i.e. exactly the per-turn tax Q4 asked about.
- **Anything depending on `hook-trace.jsonl`/`traceHook`** — dead since 2026-05-18.
  **Absence from it is not evidence of silence.**
- **Whether Codex hooks fire at all under `codex exec`** — REPORTED in
  `codex-worker-safety.md`, not re-run. If they do not, the 4 Codex-only hooks
  become deletable. Cheapest follow-up available.
- **Whether the deny-capable hooks actually deny in practice** — the "Explore ban
  failed 81 times, hook caught all 81" figure remains REPORTED.
- **`braintrust_hooks.py`** (5 of 86 registrations) was never classified and never
  executed after tracing was found enabled.
- **Bucket classification** (a=13/b=28/c=19/d=4) is regex-over-source. String
  presence ≠ reachability. REPORTED.
- **The 251-file fossil at `~/.claude/hooks/src`** — one agent looked: 210/251
  byte-identical to repo src, 0 absent, 6-file mtime sample. The other 35 are inferred.
- **`session-start-tldr-cache`** — registered in Codex, present in Codex dist, **no
  source in the repo.** A registration the repo cannot rebuild. Noted, not traced.
- **Which hook owns each fossil DB write path** — the table-name grep was
  word-boundary loose and matched prose. **Do not delete a hook on those timestamps.**
- **Timing:** counts are a snapshot 19:21–19:35 on 2026-07-28, taken while Part 1
  was landing. Bug 2 moved the registration count 85 → **86** mid-pass. Bug 3 had
  not landed; now that it has, the dead set goes 31 → 32 and deletable 27 → 28.

---

## Part 1 — done, committed, verified

**`c77f85c` — the lock that called a working session dead.**

The handoff listed 7 sites, "VERIFIED by Select-String". **There were 13.** The
pattern searched was `make_interval`, which is narrower than the question, so it
missed every site spelled `INTERVAL '5 minutes'` — including `getActiveSessions`,
the peer-collision warning hook, the dashboard router, and the session **reaper**
(`cleanup_sessions.py`, which DELETEs, so an unattended run working >24 h without
a prompt was deleted while alive). An incomplete verified list is the same defect
class as the bug it was listing.

Ratchets shipped with it:
- `scripts/coordination/liveness-predicate-guard.mjs` — asserts every guarded file
  exists, each still contains ≥ N correct predicates, and zero bare-column
  staleness tests. Negative control run **both directions**: reinstating the
  regression → exit 1 naming file and line; restoring → exit 0.
- That negative control **caught a flaw in the guard itself**: the count check was
  initially satisfied by the doc *comment* above the query, which spells out
  `GREATEST(last_heartbeat, last_activity_at)`. A guard satisfiable by prose
  describing the fix is the defect it exists to catch. Both scans now strip
  comments and read code only.
- `claim-sql-probe` now requires `last_activity_at` in the extracted statement and
  gains **case 3c** — expired lease AND stale heartbeat (every condition the old
  rule needed for takeover) but current activity, so the holder keeps its claim.
  **Verified to fail, not assumed to:** reverting only the ON CONFLICT predicate
  returns `takeover`, FAILED 1/16. That run also showed `prior_holder_stale`
  reporting FALSE *while the statement handed the claim away* — classifier and
  action disagreeing because one half had been fixed and the other had not.

Also restored `.claude/hooks/package.json`, deleted in the working tree (unstaged,
in HEAD, removed by no commit) — `npm run build` could not run from source at all.

Verified: guard 6/6 files, 23 predicates, 0 violations · claim-sql-probe 16/16 vs
live Postgres · coordination-transport 15/15 · load-probe **HOLDS** · dist 6
GREATEST-form / 0 bare.

**Bug 2 — `periodic-extract` registered in user scope** (Node atomic
read-modify-write, backup at `settings.json.bak-2026-07-28-periodic-extract`).
End-to-end verified on a throwaway row: a session 20 minutes stale by heartbeat
now reads **alive** because the writer fires. Probe row deleted.
*My first test was wrong, not the hook* — `session-touch` is deliberately
UPDATE-only (row creation belongs to `session-register`) and my probe id had no row.

**Bug 3 — `sync-to-repo` deregistered from `~/.codex/hooks.json`** (72 → 71,
sync-to-repo count 0, backup written). The permission classifier did not block it.

**`189fb46` — the blocklist updater that failed 28 times and reported success.**
Two independent faults: `%ERRORLEVEL%` inside a parenthesized block expands at
*parse* time, before `call` runs, so the wrapper always exited 0 (**proven in
isolation**: identical fixtures, inner exits 3 → old pattern 0, new pattern 3);
and `execSync('sleep N')`, which does not exist on Windows, threw *from inside the
catch block* and so escaped the retry loop entirely, converting every transient
GitHub hiccup into total failure. A partial fetch now also exits 1 rather than
passing as clean.

**Still wrong, deliberately not patched — it needs a decision:** that task's tail
runs `git add`/`git commit` on **whatever branch is checked out**, then
`git push fork main`. On this branch it would commit to `agentic-os` and push a
stale `main`. The handoff had this as REPORTED; it is now VERIFIED by reading the
wrapper. Consider disabling the task during any mass edit.
