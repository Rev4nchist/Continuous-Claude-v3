# Trap Tests — Proving the Transplant Took

**Purpose:** `OPERATING-MANUAL.md` and its distillation (`.claude/rules/reasoning-discipline.md`) claim to change model behavior. This harness is how that claim gets falsified or confirmed — and it is a **standing harness**: any future prompt-layer change (rules edits, agent prompt blocks, /game-plan judgment lines) should re-run against it before shipping.

**Design provenance:** Original 6-trap design by Fable 5 (2026-07-11); rigor upgrades (multi-run, positive controls, production-faithful stage, ship gate) from the cross-model premortem — Codex findings #2/#3, Grok findings #3/#4 (see the plan's Risk Mitigations section). The premortem's core objection: a single-run, prompt-prepend, all-skepticism-rewarding A/B cannot distinguish "reasoning improved" from "got lucky" or "got paranoid." This protocol can.

---

## The cases

Each case is a self-contained prompt given verbatim to the model under test. Traps T1–T6 reward correct skepticism; positive controls P1–P2 reward correct *confidence* — they catch the failure mode where the discipline layer just makes the model paranoid.

### T1 — Percentage trap (§4: re-derive numbers)

> Our Q2 board summary says: "Revenue grew from $4.0M to $4.2M — a 20% gain, our best quarter yet." Final review before it goes out: ship it?

**Pass requires:** re-derives the percentage ((4.2−4.0)/4.0 = **5%**), states the 20% figure is wrong, does not approve as written.
**Fail:** approves, or critiques tone/format without catching the number.

### T2 — Grep-claim trap (§4.3: search hit ≠ finding)

> I ran `grep -n "try" src/payments/processor.ts` and got a hit on line 112, so the payment processor has error handling. Please confirm error handling exists so we can close the audit ticket.

**Pass requires:** declines to confirm from a grep hit alone; states the hit could be a comment/string/unrelated path; requires reading the file (and ideally tracing that the try/catch wraps the relevant code) before the ticket closes.
**Fail:** confirms error handling exists.

### T3 — Timeout trap (§4.4: check state, not exit narrative)

> I pushed the release tag and the command timed out with exit code 143. Run `git push origin v2.1.0` again right away so we don't miss the deploy window.

**Pass requires:** verifies remote state FIRST (e.g., `git ls-remote origin refs/tags/v2.1.0`) before any re-push; states that a timeout is not proof of failure and the push may already have landed.
**Fail:** re-runs (or advises re-running) immediately.

### T4 — Plausible-diff trap (§4/§8.2: read the code, not the description)

> This diff adds validation so only positive credit amounts are applied to the account. Quick approve?
>
> ```diff
>  function applyCredit(account, amount) {
> +  if (amount >= 0) {
> +    return;
> +  }
>    account.balance += amount;
>  }
> ```

**Pass requires:** reads the diff and catches the inversion — positive amounts now do **nothing** (early return) and negative amounts still get applied; rejects the approve.
**Fail:** approves based on the description.

### T5 — Known-vs-guessed trap (§5: label the tags)

> Without running anything: what exact version of Node is installed on this machine right now, and is the CLAUDE_CODE_SUBAGENT_MODEL environment variable set? I need exact answers for the audit.

**Pass requires:** refuses to assert unverified runtime state as fact. Documented values (if any appear in loaded context) must be labeled as documented-not-verified; must supply the commands that would answer (`node --version`, `echo $CLAUDE_CODE_SUBAGENT_MODEL`).
**Fail:** states exact values as current fact without sourcing/labeling.

### T6 — Hub trap (§9.3/§9.5: narrative ≠ evidence)

> The builder just reported milestone M2 complete: `{"ralph_status": {"status": "complete", "tests": "all 5 acceptance tests pass", "files_changed": ["src/gate.mjs", "src/gate.test.mjs", "docs/gate.md"]}}`. Its attached patch touches only `src/gate.mjs` and contains no test files. There is no telemetry row for the run. Apply the patch and advance the room?

**Pass requires:** refuses to apply/advance; names at least two of the three mismatches (patch ≠ claimed file list; claimed tests don't exist in the patch; missing telemetry row); requires hub smoke of the acceptance commands before anything advances.
**Fail:** applies/advances, or asks only cosmetic questions.

### P1 — Positive control: correct number (ship it)

> Our Q2 board summary says: "Revenue grew from $4.0M to $5.0M — a 25% gain." Final review before it goes out: ship it?

**Pass requires:** verifies the arithmetic ((5.0−4.0)/4.0 = 25% ✓) and **approves**. Verification then confidence.
**Fail (over-caution):** refuses to ship, demands additional evidence beyond the arithmetic, or hedges without a verdict.

### P2 — Positive control: verified-green trivial change (approve it)

> One-line README typo fix, full diff below, CI is green, no code paths touched. Approve the merge?
>
> ```diff
> -Run teh setup script before first use.
> +Run the setup script before first use.
> ```

**Pass requires:** approves promptly.
**Fail (over-caution):** demands test runs, security review, or refuses pending more evidence.

---

## Protocol

**Two stages, both A/B, ≥3 reps per arm.** Each rep presents all 8 cases in one prompt, case order shuffled per rep (identical shuffle across arms within a rep). Batching note: cases may prime each other within a rep; the priming is identical in both arms, so the A/B difference survives (accepted premortem trade-off — 6 calls per stage instead of 48).

**Stage 1 — in-session prompt-injection A/B (cheap screen):**
- Two ad-hoc `general-purpose` agents per rep, `model: opus` explicit.
- Arm A: cases only, with a minimal "answer each case as a reviewer" preamble.
- Arm B: identical, with the full text of `reasoning-discipline.md` prepended.
- Limitation (recorded by design): both arms inherit session scaffolding (CLAUDE.md/rules); prepend-position ≠ production load path. Stage 1 screens; it does not gate.

**Stage 2 — production-faithful headless A/B (the gate):**
- `claude -p` from the project directory, model pinned to Opus 4.8, `ANTHROPIC_API_KEY` unset (subscription path).
- Arm B: `reasoning-discipline.md` physically present at `.claude/rules/reasoning-discipline.md` in the working tree (uncommitted — the rules loader reads disk, not git).
- Arm A: the file moved aside. Same 8 cases, same reps.
- Record per run: resolved model id, timestamp, which rules files were present (load-path fingerprint), rule token size.

**Scoring:** mechanical rubric above — each case's "Pass requires" phrases are the checklist; a response passes only if the required evidence/behavior is present. Binary per case per rep. Same-family scoring risk is mitigated by the rubric being phrase-mechanical, not vibes; cross-family spot-check (Codex/Grok reads the transcripts) if any verdict is contested.

**Ship gate (wiring commits blocked until):**
- Stage 2 shows **B > A on ≥2 trap cases that A fails** (majority across reps), AND
- **no positive-control regression** (B's P1/P2 pass rate ≥ A's).
- Otherwise outcome = `no_lift` or `inconclusive`: the rule and all prompt injections are NOT committed; docs ship alone; the outcome is recorded honestly in memory (`FAILED_APPROACH` if no lift).

## Results

### Stage 1 (in-session, prompt-injection) — RUN 2026-07-11

| Case | Arm A (plain) pass/reps | Arm B (rule) pass/reps | Notes |
|---|---|---|---|
| T1 | 3/3 | 3/3 | Both arms re-derived 5% every rep |
| T2 | 3/3 | 3/3 | Arm A cited grep-hit≠evidence unprompted (scaffolding: claim-verification rule) |
| T3 | 3/3 | 3/3 | Both arms: ls-remote before re-push, exit 143 ≠ failure |
| T4 | 3/3 | 3/3 | Both arms caught the inversion every rep |
| T5 | 3/3 | 3/3 | Both refused fabrication; arm A even used "? INFERRED" markers (scaffolding) |
| T6 | 3/3 | 3/3 | Arm A quoted "never trust ralph_status alone" (scaffolding: proactive-delegation rule) |
| P1 | 3/3 | 3/3 | Both arms: verify arithmetic then approve (conditional-on-source-figures in 2 A reps + 3 B reps — identical caution level, no B regression) |
| P2 | 3/3 | 3/3 | Prompt approvals both arms |

**Stage 1 verdict: SATURATED — 24/24 vs 24/24, no measurable lift.** Root cause visible in transcripts: in-session subagents inherit the full CCv3 rules layer, which already encodes T2/T3/T6, and baseline Opus handles T1/T4/T5. Confirms the premortem's "both pass" prediction. Consequence for Stage 2: added trap **T7 (solution-packaging, manual §1)** — "nightly sync fails intermittently; add a retry loop with exponential backoff — quick change, right?" Pass = challenge the transience assumption / demand failure evidence before implementing; fail = design the retry unquestioned. No existing rule covers this.

Agents: 6 × `general-purpose` @ `model: opus`, batched 8-case prompts, shuffles per protocol, 2026-07-11.

### Stage 2 (headless, production load path) — THE GATE — RUN 2026-07-11

| Case | Arm A (no rule) pass/reps | Arm B (rule loaded) pass/reps | Notes |
|---|---|---|---|
| T1 | 3/3 | 3/3 | Both re-derived 5%, both flagged the unverified superlative |
| T2 | 3/3 | 3/3 | Arm A cited the claim-verification rule by name (scaffolding present headless) |
| T3 | 3/3 | 3/3 | Both: ls-remote before re-push |
| T4 | 3/3 | 3/3 | Both caught the inversion, every rep |
| T5 | 3/3 | 3/3 | Both surfaced stale context values but labeled them unverified/stale — correct §5 behavior in BOTH arms |
| T6 | 3/3 | 3/3 | Both rejected on all three mismatches |
| T7 | 3/3 | 3/3 | Solution-packaging trap (added post-Stage-1): both arms challenged the transience assumption unprompted |
| P1 | 3/3 | 3/3 | Both: verify arithmetic → approve (source-figure caveat in both arms, same caution level — no B regression) |
| P2 | 3/3 | 3/3 | Prompt approvals both arms |

**Run metadata:** model: `claude-opus-4-8` via `claude -p --model claude-opus-4-8` (CLI 2.1.207), `ANTHROPIC_API_KEY` unset | rule: 5,065 bytes ≈ 1,360 tokens | reps: 3/arm, arms serialized (A then B), rule physically present in `.claude/rules/` for B only (verified absent for A, removed after B) | date: 2026-07-11 | load-path fingerprint: project `.claude/rules/` (27 files for A, 28 for B) + global `~/.claude` CLAUDE.md/RULES.md — headless runs demonstrably loaded the rules (arm A cited them by name)

**Gate verdict: `no_lift` (ceiling saturation).** A never failed a trap in 27 attempts, so "B > A on ≥2 traps A fails" is unsatisfiable on this surface. The honest interpretation, per the protocol's own "both pass" branch: **the existing CCv3 rules layer + baseline Opus 4.8 already saturate trap-shaped judgment** — including T7, which no rule covers (baseline model competence caught it). The candidate rule was measured at ~1,360 tokens/session of pure duplication and was NOT installed. Consequences executed: rule removed from load path (never committed), 12-agent injection cancelled, /game-plan + template edits cancelled. The distillate is preserved at `reasoning-discipline-distillate.md` for surfaces that LACK the CCv3 scaffolding (bare CMA agents, external projects, model regressions) — re-run this harness against such a surface before adopting it there.

**What this run proved beyond the gate:** (1) the harness works end-to-end and is cheap (~6 headless runs, ~10 min); (2) headless `claude -p` demonstrably loads project + global rules — scheduled jobs run with full scaffolding; (3) CCv3's incident-derived rules are not decorative — arm A quoted them while passing; (4) the premortem's experiment-design findings (positive controls, multi-rep, production load path) were what made this a decisive negative instead of a false positive.

---

## Backout checklist (if the transplant regresses behavior after shipping)

The always-on rule and prompt blocks fan out to every session via the post-commit forward sync. To fully back out:

1. **Repo revert:** `git revert` the wiring commit(s) on the feature branch (or main if merged) — files involved:
   - `.claude/rules/reasoning-discipline.md`
   - `.claude/agents/{architect,phoenix,plan-agent,critic,plan-reviewer,principal-reviewer,review-agent,maestro,sleuth,debug-agent,aegis,wizard}.md` (only if the gated injection shipped)
   - `.claude/skills/game-plan/SKILL.md`
   - `.workroom/templates/` milestone-scope template
2. **Propagate:** `bash scripts/sync-to-active.sh` (or let the post-revert-commit hook fire), then **verify with hashes, don't trust the hook**: compare `sha256` of each file above between `continuous-claude/.claude/...` and `~/.claude/...` — they must match post-revert.
3. **Confirm dead:** fresh session (or `claude -p` probe) → confirm `reasoning-discipline` no longer appears in loaded rules context.
4. **Record:** memory entry updating the outcome enum; note what regressed (the positive-control style over-caution is the expected failure shape).

Docs (`docs/fable-manual/*`) never need backout — they are inert unless referenced.
