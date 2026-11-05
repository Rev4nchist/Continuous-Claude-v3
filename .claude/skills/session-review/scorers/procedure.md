# Scorer: procedure

## What to assess

Did the session follow the repo's working procedure? Check four things.

1. Right branch and directory. `cwd[]` and `branches[]` should match the task. Feature work is not on
   `main`. A session that only reads on `main` is fine.
2. Lane claim. When `rule_router_fires` or the prompts show lane work, a lane was claimed first.
3. Routed skill loaded. A bug asks for `systematic-debugging`, SQL for `databases`, a PR review for
   `code-review`, a handoff for `notion-bridge`. Check `factory.attribution_skills`.
4. Stop points. The agent stopped where Dave said to stop (commit, send, merge).

Name each miss in a note with a `uuid`. A miss needs evidence in the digest. Do not guess from the
absence of a field.

## Scale

Count misses:
- 1.0: none.
- 0.8: one minor miss (for example a skill loaded late).
- 0.4: two misses, or one wrong-target action.
- 0.2: three or more misses, or an action past a stop point.

## N/A when

Never. If the digest holds no signal for a check, skip that check and say so in the note.
