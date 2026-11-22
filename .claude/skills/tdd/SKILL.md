---
name: tdd
description: "Test-driven development workflow: plan, write tests, implement, validate. Use when the user says \"implement X using TDD\", \"test-first\", \"/tdd\" or wants regression tests."
metadata:
  keywords: [tdd, test-driven, test-first, red-green-refactor]
---

# /tdd - Test-Driven Development

The Pocock tdd workflow (vendored, v1.3.1) owns this name. This page adds the CCv3 references and never-lines.

## Follow

1. Read [tdd](../_vendor/pocock-skills/skills/tdd/SKILL.md), [tests.md](../_vendor/pocock-skills/skills/tdd/tests.md)
   and [mocking.md](../_vendor/pocock-skills/skills/tdd/mocking.md). Follow its loop.
2. It says to call the Skill tool with "codebase-design". Read [deep modules](references/deep-modules.md) instead.
3. It names the code-review skill. That is the CCv3 code-review skill. The vendored Pocock code-review is for the cross-family review brief only.
4. Mock at system boundaries only: [mocking boundaries](references/mocking-boundaries.md).
5. Confirm the seams with the user before the first test. A subagent asks its parent. In `/build`, the seams in the approved plan count as confirmed. Any other headless run lists the seams in its report and stops.
6. A feature with several slices: run the agent loop in [CCv3 tdd loop](references/ccv3-tdd.md).
   The plan-agent splits the feature. Per slice, arbiter writes the failing test, kraken makes it pass, arbiter verifies.
7. Excuses and the final checklist: [philosophy](references/philosophy.md).
8. Before the first test, name the proof type from [pr-review-loop.md](../../rules-ondemand/pr-review-loop.md) "Proof in the PR body".
   Record RED (command, failing output, commit) and GREEN (command, passing output, head) for the Evidence block in
   [pr-and-commit-style.md](../../rules-ondemand/pr-and-commit-style.md). A refactor records BEFORE in place of RED.
   A subagent never commits, so the main session supplies the RED commit. For a pure addition, RED can be the base commit.
   Proof follows the project's testing rules (AGENTS.md "Testing", or docs/testing-standard.md): an end-to-end check first, with its output saved.
9. Last step before done: read [prove-it-works](../_vendor/pstack/skills/principle-prove-it-works/SKILL.md) and apply it.
   Keep the artifact in `.claude/cache/e2e/`. Never commit it.

## Never

- Never write production code before a failing test. Watch it fail, then watch it pass.
- Never commit, push, open a PR or merge. The main session does this after Dave says yes.
- Never edit CLAUDE.md, AGENTS.md, CONTEXT.md, GLOSSARY.md, a rule file or settings.json. Propose the diff to Dave.
- When vendored text conflicts with a CCv3 rule, the CCv3 rule wins.
- Never call the Skill tool for a name that only the vendored text uses (grilling, domain-modeling, codebase-design, how, why, arena, poteto-mode, unslop, principle-*). Read the file the wrapper names.
