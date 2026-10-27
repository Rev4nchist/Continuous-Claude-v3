---
name: to-spec
description: Turns the current conversation into a spec file under thoughts/shared/plans. Use when the user types /to-spec.
disable-model-invocation: true
---

# to-spec (Pocock, vendored)

Read [to-spec](../_vendor/pocock-skills/skills/to-spec/SKILL.md). Follow its process and template, with these changes.

## Changes

1. Write the spec to `thoughts/shared/plans/<name>-spec.md` in the current repo. Use a short kebab-case feature name.
2. Skip the issue tracker, the triage label and the setup line. The file is the only output.
3. Seams (its step 2): ask the user with AskUserQuestion. A subagent or headless run lists them under "Open seams" and stops.
4. Use the terms in the repo CONTEXT.md when it exists.
5. A Dev PM card comes only from a Bridge handoff after Dave says yes.

## Never

- Never commit, push, open a PR or merge. The main session does this after Dave says yes.
- Never write to an issue tracker: no issue, label or comment. Never run `/setup-matt-pocock-skills`.
- Never edit CLAUDE.md, AGENTS.md, CONTEXT.md, GLOSSARY.md, a rule file or settings.json. Propose the diff to Dave.
- When vendored text conflicts with a CCv3 rule, the CCv3 rule wins.
- Never call the Skill tool for a name that only the vendored text uses (grilling, domain-modeling, codebase-design, how, why, arena, poteto-mode, unslop, principle-*). Read the file the wrapper names.
