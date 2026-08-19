---
digest_id: 2026-08-19-theo-agents-md-skills
date: 2026-08-19
type: brief
title: "Theo's AGENTS.md and skills process vs the CCv3 instruction files"
topic: "writing CLAUDE.md / AGENTS.md and skill descriptions"
channels: "Theo - t3.gg"
verdict: adopt
videos: 2
citations: 24
corpus_path: docs/research/youtube/theo-t3-gg
---

# Theo's AGENTS.md and skills process vs the CCv3 instruction files

**Scope.** Two videos: "My AGENTS.md & SKILLS.md Breakdown (Don't copy them)" (51 min, 2026-08-11)
and "So I tried Matt's skills..." (38 min, 2026-08-19). Question: what should change in our
CLAUDE.md, RULES.md, rules and skills. Out of scope: T3 Code product detail, the Pstack/Pocock
skill packs themselves (Theo's own advice is not to install them wholesale). Both transcripts are
ASR (`transcript_source: auto`); quotes are paraphrase unless marked.

## 1. What the source actually demonstrates

Demonstrated on screen, not just asserted:

- **A skill description is a trigger, not a summary.** Theo shows his babysit-PR skill and says the
  description could be cut to "Use when the user asks to monitor, watch, or babysit a PR"
  [vid:e1snsuY4lTI @13:10]. Once keyword triggers worked he split one skill into two
  [vid:e1snsuY4lTI @13:36]. Restated in the second video: "It shouldn't be called a description. It
  should be called a trigger" [vid:0oXOOlqVu5M @6:14].
- **Audit your own history before writing rules.** He asked the agent to read his Claude Code and
  Codex history, break down the most common failure modes per model, and count them
  [vid:e1snsuY4lTI @19:51, @20:05]. The output was a corrections-per-100-user-messages table per
  model [vid:e1snsuY4lTI @21:35]; his "three ways to hurt yourself" section came from that audit
  [vid:e1snsuY4lTI @31:00].
- **Bad/good example pairs.** PR title and PR description pairs, shown on screen
  [vid:e1snsuY4lTI @15:14, @16:04]. "Agents are really good at bad and good examples"
  [vid:e1snsuY4lTI @15:40].
- **A glossary helps the agent talk to you.** [vid:e1snsuY4lTI @25:03, @25:41].
- **Small global lines that changed behaviour:** "Questions are read-only" [vid:e1snsuY4lTI @8:04];
  "Match ceremony to the task ... delegation is for breadth or adversarial review"
  [vid:e1snsuY4lTI @8:17]; "state file ownership up front" for parallel agents
  [vid:e1snsuY4lTI @8:27]; give the model a stop point [vid:e1snsuY4lTI @47:04].
- **AGENTS.md is not a README.** It tells the agent how to change things here and what never to
  compromise; write it as good defaults the user can override [vid:e1snsuY4lTI @24:14, @30:01].
- **"Hit every surface" checklist** for the repo's most common defect [vid:e1snsuY4lTI @32:54];
  "reverse states" [vid:e1snsuY4lTI @34:02].
- **Unslop A/B** on the same model, same prompt [vid:0oXOOlqVu5M @9:51, @11:05].
- **User-invoked vs model-invoked skills** (`disable-model-invocation`) [vid:0oXOOlqVu5M @14:17, @21:08].
- **Paste-test a skill before installing it** [vid:0oXOOlqVu5M @14:04].

Asserted (opinion): Opus 5 is "too proactive" and his top offender; Soul files draft PRs; Pstack is
philosophically closer to him than Pocock's pack. "Less context is best as long as it has the
context it needs" [vid:e1snsuY4lTI @48:56] is a principle, not a measurement.

## 2. Gap vs what we do today

Measured on this machine, 2026-08-19, before changes:

| Area | Measured |
|---|---|
| Skill descriptions | 148 repo skills. **93 had no trigger phrasing**, 29 were over 400 chars (`impeccable` 895, `ui-ux-pro-max` 806, `youtube-research` 770). 34 were reachable by neither trigger channel (native description router nor our `skill-rules.json` hook). 0 used `disable-model-invocation`. |
| Our own router | `skill-activation-prompt` hook on 45 probe prompts: **31% hit rate, 22/45 prompts fired an unrelated skill**. The native router named the right skill 45/45 (self-report via `claude -p`). |
| Failure audit | 1,359 human turns, 30 days, classified by three agents: **38 corrections**. Top class `no_verify` (12, 11 sessions, every model), then `format` (6), `wrong_target` (5), `misread` (3). Opus 5: 5.9 per 100 turns; Fable 5: 3.4; Opus 4.8: 2.8. |
| CLAUDE.md | 20.6 KB; a 90-line "System Capabilities" inventory (README-shaped); "Use subagents liberally"; one bad/good pair in the whole file. |
| Glossary | CLAUDE.md mandated reading `CONTEXT.md`; the repo had none. |
| Rules | 46 files, 137,184 bytes, all loaded every session. Four were pure "see the memory skill" stubs. |

## 3. Verdicts

| Idea | Verdict | Rationale | Citation |
|---|---|---|---|
| Descriptions as triggers, ratcheted | ADOPT | 93/148 lacked triggers; measurable | [vid:e1snsuY4lTI @13:10] |
| Failure audit from own history | ADOPT | 38 real corrections found; rules now cite incident counts | [vid:e1snsuY4lTI @19:51] |
| Bad/good pairs in CLAUDE.md and a PR rule | ADOPT | cheapest lever; pairs drawn from real corrections | [vid:e1snsuY4lTI @15:40] |
| CONTEXT.md glossary | ADOPT | mandated file did not exist | [vid:e1snsuY4lTI @25:03] |
| Questions read-only / ceremony / stop points | ADOPT | fixes the "liberally" contradiction; 2 `scope` + 2 `stopped_early` incidents | [vid:e1snsuY4lTI @8:04] |
| Inventory out of CLAUDE.md | ADOPT | every item has a rule or skill home | [vid:e1snsuY4lTI @24:14] |
| Every-surface checklist | ADOPT | our recurring two-copy defect; consolidates 2 rules | [vid:e1snsuY4lTI @32:54] |
| `disable-model-invocation` on orchestrators | ADOPT | key verified in the `claude` binary | [vid:0oXOOlqVu5M @14:17] |
| unslop | SKIP | ASD-STE100 rule already mandated | [vid:0oXOOlqVu5M @9:51] |
| Install Pocock/Pstack packs | SKIP | Theo's own advice; paste-test singles later | [vid:0oXOOlqVu5M @35:23] |
| Fleet repo | SKIP | `sync-to-active.sh` is this for one machine | [vid:e1snsuY4lTI @3:33] |

## 4. Integration sketch (what shipped, branch `ai-frontier-research`)

1. `scripts/self-improvement/failure-audit.mjs` + `.claude/skills/failure-audit/` (user-invoked).
   Output `docs/self-improvement/audits/2026-08-19-failure-modes.md` (repo-local, never published).
2. `scripts/skills/audit-descriptions.mjs` (ratchet, exit 1 on violation) and
   `scripts/skills/trigger-probe.mjs` + `trigger-cases.json` (hit and false-fire rate, both channels).
   All 120 violating descriptions rewritten; 20 orchestrator skills marked user-invoked.
3. `~/.claude/CLAUDE.md` (+ template): new "How we work together" block; ceremony rule replaces
   "liberally"; bad/good pairs for done-claims and the Next steps block; inventory cut to a pointer.
4. Rules: `pr-and-commit-style.md`, `every-surface-checklist.md`, `memory-rules.md` added;
   `manual-sync.md`, `sync-known-gaps.md` and four memory stubs removed. Net rule bytes down.
5. `CONTEXT.md` at the repo root.

How you know it worked: `audit-descriptions.mjs` exits 0; the trigger probe after the rewrite is
not worse than the baseline on either channel; the hook suite stays green; the next failure audit
shows `no_verify` below 12/30 days.

## 5. Sources

| Video | Uploaded | Track | Key timestamps |
|---|---|---|---|
| [My AGENTS.md & SKILLS.md Breakdown (Don't copy them)](https://youtu.be/e1snsuY4lTI) | 2026-08-11 | auto | [8:04](https://youtu.be/e1snsuY4lTI?t=484) read-only questions, [8:17](https://youtu.be/e1snsuY4lTI?t=497) ceremony, [13:10](https://youtu.be/e1snsuY4lTI?t=790) description = trigger, [15:40](https://youtu.be/e1snsuY4lTI?t=940) bad/good, [19:51](https://youtu.be/e1snsuY4lTI?t=1191) audit history, [21:35](https://youtu.be/e1snsuY4lTI?t=1295) corrections/100, [25:03](https://youtu.be/e1snsuY4lTI?t=1503) glossary, [30:01](https://youtu.be/e1snsuY4lTI?t=1801) good defaults, [32:54](https://youtu.be/e1snsuY4lTI?t=1974) every surface, [47:04](https://youtu.be/e1snsuY4lTI?t=2824) stop point, [48:56](https://youtu.be/e1snsuY4lTI?t=2936) less context |
| [So I tried Matt's skills...](https://youtu.be/0oXOOlqVu5M) | 2026-08-19 | auto | [6:14](https://youtu.be/0oXOOlqVu5M?t=374) trigger not description, [9:51](https://youtu.be/0oXOOlqVu5M?t=591) unslop A/B, [14:04](https://youtu.be/0oXOOlqVu5M?t=844) paste-test, [14:17](https://youtu.be/0oXOOlqVu5M?t=857) disable-model-invocation, [21:08](https://youtu.be/0oXOOlqVu5M?t=1268) user- vs model-invoked, [35:23](https://youtu.be/0oXOOlqVu5M?t=2123) don't install blindly |
