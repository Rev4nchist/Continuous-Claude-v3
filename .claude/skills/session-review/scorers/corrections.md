# Scorer: corrections

## What to assess

How often did Dave have to correct the agent? Classify each prompt in `humans.prompts[]`, using its
`prev_assistant` field as context. Output one row per correction in `corrections[]`: `{uuid, class}`.

Classes (the 11 classes of the `failure-audit` classifier):
- `scope`: did more than asked, or unasked edits.
- `wrong_target`: wrong file, branch, directory, process or project.
- `no_verify`: claimed done without evidence, or did not check.
- `misread`: answered a different question than the one asked.
- `stopped_early`: stopped before the work was finished.
- `regression`: broke something that worked.
- `format`: output format, verbosity or style.
- `tool_misuse`: wrong tool, command or platform.
- `process`: skipped a required step or rule.
- `other_correction`: a correction that fits no class above.
- `none`: not a correction.

Rules:
- "keep going" after a stop is `stopped_early`.
- "yes do it" is `none`.
- A new task is `none`.
- A question is `none` unless it points at a missed step ("did you run it?" is `no_verify`).
- Only the last 40 prompts are in the digest. Say so in the note when the digest is capped.

Failure findings reuse these classes. Each `failures[]` row needs `class` (not `none`) and
`target_hint`: the file, hook, rule or skill name to edit, lowercase, no folder path. Use `unknown`
when none fits. The report groups findings by `class` + `target_hint`, so use the same name for the
same target in every session.

## Scale

Count corrections (class other than `none`):
- 1.0: zero.
- 0.8: one.
- 0.4: two or three.
- 0.2: four or more.

## N/A when

`humans.human_turns == 0`. Score `null`.
