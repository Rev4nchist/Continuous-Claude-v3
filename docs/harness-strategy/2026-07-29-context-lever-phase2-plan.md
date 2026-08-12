# Context lever, phase 2 — the user rules

Written 2026-07-29, session `5d7e7343`, for a **new session** to execute.
Tracked in git deliberately; `~/.claude/plans` does not survive the machine.

Prerequisite: phase 1 (`6bd7ffa`, `9f9b9d4`, `c6594b7`) is shipped and pushed.

---

## Context

`/context` was run for the first time in this lineage on 2026-07-29 and replaced
a week of `bytes/4` modelling with one real number.

| | continuous-claude | control project (no `.claude/rules`) |
|---|---|---|
| memory files | **145.6k** (96 files) | **82.1k** (51 files) |
| total | 462.3k / 1M (46%) | 118.5k (12%) |

Phase 1 removed the duplicate: all 46 rules were loaded **twice**, byte-identical,
once as user scope and once as project scope. That was **~61k tokens per session,
13% of the window**, carrying zero information. Expected post-fix: ~85k.

**Phase 2 is the remaining ~61k — the user rules themselves.** They are loaded
into *every* project regardless of relevance. Concretely, editing a React
component in an unrelated repo still loads:

| rule | tokens |
|---|---|
| `codex-worker-safety.md` | 6.2k |
| `grok-worker-safety.md` | 5.0k |
| `codex-adversarial.md` | 4.3k |
| `kusto-cli-safety.md` | 3.0k |
| `cma-safety.md` | 2.8k |
| `cli-integration-strategy.md` | 2.8k |
| `notion-cli-safety.md` | 1.8k |
| ~10 more tool rules | ~8k |
| **cross-model / tool-specific subtotal** | **~34k** |

That is the target. Everything else in the rules tree is either genuinely global
(`windows-platform`, `destructive-commands`, `claim-verification`) or already small.

Two calibration facts that must carry forward:

- **`bytes/4` runs ~37% low.** It estimated the duplicate at 38k; the real figure
  was 61k. Any token claim not from `/context` is a lower bound, not a number.
- **MCP tooling is already optimal** — 291 tools, **0 tokens**, deferred. Do not
  spend effort there. Skills are 14.1k for 199; also not the lever.

## The thesis, and why the obvious approach fails

The queued idea was `paths:` frontmatter to scope rules by file glob. **That does
not work for the rules that actually cost the most**, and this is the single most
important thing for the next session to internalise before writing code.

`paths:` scopes by *the file being edited*. But `codex-worker-safety` isn't
triggered by editing a path — it's triggered by **invoking the Codex CLI**. Same
for grok, cma, kusto, notion, linear, sentry, railway, neonctl. The 34k of
tool-safety rules are **action-triggered, not path-triggered**, so path globs
would either miss them entirely or scope them wrongly — and a safety rule that
fails to load when the tool runs is strictly worse than paying 6.2k for it.

**The thesis instead: a rule should carry only what must be true *before you know
what you are doing*. Everything else belongs in the on-demand skill.**

Every one of those tool rules already has a paired skill that loads on demand
(`.claude/skills/codex/`, `/grok/`, `/cma/`, `/notion-cli/`, `/kusto-cli/`, …).
So the split is:

- **Rule keeps** the hard invariants an agent must know *unprompted* — the
  confirm-first matrix, the "never fall back to an API key", the one-line
  "`--tools` is the only real guard". Target ≤ 800 tokens each.
- **Skill absorbs** the evidence trail, version pins, probe history, model
  allowlists, flag archaeology, and the long caveat prose — all of which are only
  needed once you have already decided to use the tool, at which point the skill
  loads anyway.

This is progressive disclosure, and it is independently what Nate B. Jones'
`n-agentic-harnesses` skill prescribes: *"load minimal reference set based on
needs — don't chain references."*

Estimated recovery: ~34k → ~8k, so **~26k/session**, on top of phase 1's 61k.

## Execution — use a workflow

This is a genuine fan-out: ~13 tool rules, each needing (a) an invariant/detail
split, (b) verification the paired skill exists and is the right home, (c) a check
that no hook or script greps the rule text it moves. That is per-rule independent
work with a shared contract — exactly the shape a workflow handles better than a
serial pass.

Suggested shape (the next session should adapt, not follow blindly):

```
phase('Audit')     — one agent per tool rule: classify every section as
                     INVARIANT (stays) or DETAIL (moves to skill). Return
                     structured {rule, keep[], move[], skill_path, hazards[]}.
phase('Verify')    — per rule, adversarially check the split: would an agent
                     that loads ONLY the kept text still refuse the dangerous
                     operation? Anything ambiguous stays in the rule.
phase('Apply')     — serialize. Same repo, same branch: commits must not race
                     .git/index.lock (see proactive-delegation.md).
```

Keep it under ~15 agents. **The Verify phase is not optional** — it is the only
thing standing between this change and a silently weakened safety rule.

## Hard constraints

1. **Never weaken a safety gate to save tokens.** If a split is ambiguous, the
   text stays in the rule. 26k is not worth one unguarded `--sandbox` decision.
2. **The repo copy lives at `.claude/rules-src/`.** Editing `.claude/rules/` in
   the repo recreates the phase-1 duplicate. It should not exist; if it
   reappears, something regressed.
3. **`sync-claude.sh --to-repo` is the regression vector.** It is fixed
   (`c6594b7`) but its reverse mapping was verified by reading and `bash -n`
   only — the pre-flight guard refused a dirty-tree dry-run. **Confirm it
   empirically on a clean tree before relying on it.**
4. **18 of 19 projects have `~/.claude/rules/` as their ONLY copy** of the safety
   rules. Every change must preserve that.
5. **Back up `~/.claude/rules/` before any git operation** that touches the tree.
   Phase 1 did; `~/.claude/rules-BACKUP-2026-07-29` still exists.

## Verification

- `/context` in a fresh session, before and after. **This is the only acceptance
  measure** — no `bytes/4` estimate substitutes for it.
- Target: memory files ~85k → ~60k.
- Control: `/context` in a project that uses none of these tools should show the
  same drop, confirming the rules were global cost and not project-specific.
- Behavioural check: invoke `/codex` and `/grok` and confirm the confirm-first
  gates still fire from the *kept* rule text alone, with the skill unloaded.
- `node scripts/hooks/registration-reconcile.mjs` and
  `node scripts/hooks/hook-contract-guard.mjs` stay green.

## Known-uncertain

- **Whether `paths:` frontmatter is supported at all** in the current Claude Code
  build was never verified — it came from an earlier proposal, not from docs. The
  thesis above routes around it, but if a future pass wants path-scoping for the
  genuinely path-shaped rules (`prefer-drizzle-orm`, `next-*`), confirm the
  mechanism exists first.
- **The ~26k estimate is `bytes/4`-derived** and therefore likely low, in the
  favourable direction. Do not quote it as a result.
- **`~/.claude/rules/` is itself a git repo** tracking 41 files while the repo
  tracks 46. That discrepancy was noticed but not chased; it may matter when
  editing the active tree directly.

## Explicitly out of scope

- TLDR. Its plan (`2026-07-29-tldr-remediation-plan.md`) is premortem-hardened and
  still worth doing, but it is ~4 orders of magnitude smaller than this lever.
- MCP tools (already 0 tokens) and skills (14.1k total).
- Pruning `MEMORY.md` (9.2k) — Claude Code's own `/context` suggestion recommends
  it, but it is small and the index was just compacted 20.5KB → 11KB.
