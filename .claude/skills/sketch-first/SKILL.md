---
name: sketch-first
description: Sketches types, signatures and module shape before code, then writes a plan file for approval. Use when the user types /sketch-first.
disable-model-invocation: true
---

# sketch-first (pstack architect, vendored)

Read [architect](../_vendor/pstack/skills/architect/SKILL.md) and follow its phases A to C with the changes below.
Its references: [design-red-flags](../_vendor/pstack/skills/architect/references/design-red-flags.md),
[runner-prompt](../_vendor/pstack/skills/architect/references/runner-prompt.md),
[rationale-template](../_vendor/pstack/skills/architect/references/rationale-template.md).

## Changes

1. Open the phase list with TaskCreate.
2. Phase A: for the "how" skill, run a scout subagent or the tldr-code skill over the touched code.
   For the "why" skill, read the git log and git blame of the touched files. Skip Phase A for greenfield work.
3. Phase B: read [arena](../_vendor/pstack/skills/arena/SKILL.md) for its frame, pick and graft steps only.
   Spawn 2 general-purpose subagents on Opus in one message. Each gets the runner prompt and a different design direction.
   Each returns its candidate in its reply and writes no file. Skip the cross-judge. You pick the base and graft.
4. Ignore pstack-models.mdc and every model name in the vendored text.
5. A principle skill name is prose. Apply the plain rule in that sentence.
6. Phase C: always stop for approval. Write `thoughts/shared/plans/<name>-plan.md` in the rationale-template shape.
   Skip the vendored advice to ship the sketch as its own commit. Skip its pointer to the interrogate skill.
7. Phases D and E apply only after Dave approves, in the session that implements.

## Never

- Never commit, push, open a PR or merge. The main session does this after Dave says yes.
- Never edit CLAUDE.md, AGENTS.md, CONTEXT.md, GLOSSARY.md, a rule file or settings.json. Propose the diff to Dave.
- When vendored text conflicts with a CCv3 rule, the CCv3 rule wins.
- Never call the Skill tool for a name that only the vendored text uses (grilling, domain-modeling, codebase-design, how, why, arena, poteto-mode, unslop, principle-*). Read the file the wrapper names.
- Never use Grok. Runners and judges are Claude subagents at the CLAUDE.md model tiers.
- Stop after the plan file. Implementation starts only after Dave approves the plan.
