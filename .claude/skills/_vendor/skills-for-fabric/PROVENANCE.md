# Provenance: skills-for-fabric (vendored)

- Source: https://github.com/microsoft/skills-for-fabric (MIT, see `LICENSE`)
- Tag: `v0.3.18`, commit `6c11ad58c25992e5d1435ce7cd80d217d5598a31` (2026-09-24)
- Vendored: 2026-10-03, intake Phase 3 of `docs/self-improvement/proposals/2026-10-02-skill-intake-fabric.md`
- Allowlist: `skills/spark-cli`, `skills/search-consumption-cli`
- `common/`: only the files the allowlist links to, followed transitively (16 of 25 upstream files)
- Per-file sha256: `vendor.lock.json`

## Rules for this folder

- Never edit a vendored file. Bytes stay identical to upstream: `.gitattributes` sets
  `.claude/skills/_vendor/** -text`. The skills gate (vendor profile rule X02, also in pre-commit) fails
  when a file under `skills/`, `common/` or `mcp-setup/` differs from `vendor.lock.json`, is missing,
  or is not listed in it.
- CCv3 owns three files here: `PROVENANCE.md`, `vendor.lock.json`, `overlay.json`.
- `overlay.json` records each line that conflicts with a CCv3 "never" rule and how it is resolved.
  `node scripts/skills/vendor-conflict-scan.mjs --source .claude/skills/_vendor/skills-for-fabric` must
  report 0 uncovered.
- Claude Code does not list a skill under a `_` folder. The `fabric` hub skill
  (`.claude/skills/fabric/SKILL.md`) is the only way in. Its never-lines win over vendored text.
- An upstream update is a pull PR: copy the new tag, update this file and `vendor.lock.json`, re-run the
  intake gate stages a-c on every changed skill.
- Retire: move to `.claude/skills/_archive/<date>/` with a note. Never delete.
