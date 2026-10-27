---
name: grill-with-docs
description: Interviews the user about a plan in rounds and records terms and decisions. Use when the user types /grill-with-docs.
disable-model-invocation: true
---

# grill-with-docs (Pocock, vendored)

Upstream calls two skills by the Skill tool. Read their files instead:
[grilling](../_vendor/pocock-skills/skills/grilling/SKILL.md) and
[domain-modeling](../_vendor/pocock-skills/skills/domain-modeling/SKILL.md), with its
[ADR format](../_vendor/pocock-skills/skills/domain-modeling/ADR-FORMAT.md) and
[glossary format](../_vendor/pocock-skills/skills/domain-modeling/GLOSSARY-FORMAT.md).

## Changes

1. Run the grilling rounds in its format. Ask the whole frontier each round.
2. For a fact, dispatch a scout subagent. Never ask the user for a fact you can look up.
3. Terms: CCv3 keeps its glossary in CONTEXT.md, an instruction file. Never write it or a GLOSSARY.md.
   Record each resolved term in `thoughts/shared/plans/<topic>-grill.md` under "Glossary proposals". Dave applies them.
4. ADRs: offer one only when all three domain-modeling tests hold.
   Write `docs/adr/<NNNN>-<slug>.md` only after the user says yes to that ADR.
5. Stop when the frontier is empty and the user confirms. Do not implement.

## Never

- Never commit, push, open a PR or merge. The main session does this after Dave says yes.
- Never edit CLAUDE.md, AGENTS.md, CONTEXT.md, GLOSSARY.md, a rule file or settings.json. Propose the diff to Dave.
- When vendored text conflicts with a CCv3 rule, the CCv3 rule wins.
- Never call the Skill tool for a name that only the vendored text uses (grilling, domain-modeling, codebase-design, how, why, arena, poteto-mode, unslop, principle-*). Read the file the wrapper names.
