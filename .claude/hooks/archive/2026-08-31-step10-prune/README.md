# Step 10 prune — archived 2026-08-31

31 hook sources (+3 test files) archived per `docs/harness-strategy/README.md`
Step 10, approved by Dave 2026-08-31. Qualification (2026-08-30 sweep):
registered in NEITHER settings.json copy, zero telemetry rows (intel-bus +
`.tldr/stats/hook_activity.jsonl`), and every remaining reference is
docs/audits/backups — no live consumer in scripts/, package.json, src imports,
or dist-only callers.

Kept in src (NOT archived): `daemon-client` (11 importers),
`transcript-parser` (imported by pre-compact-continuity),
`skill-router` + `skill-validation-prompt` (imported by
`skill-activation-prompt`, whose live registration was retired 2026-08-19;
its stale repo-settings registration was removed in this same commit —
the source chain stays pending its own decision).

To resurrect a hook: move the `.ts` back to `.claude/hooks/src/`, rebuild,
re-register in both settings.json copies, and re-add its test.
