# Provenance: pocock-skills (vendored)

- Source: https://github.com/mattpocock/skills (MIT, see `LICENSE`, "Copyright (c) 2026 Matt Pocock")
- Tag: `v1.3.1` (2026-10-04). The tag is an annotated tag object, `0b6cee10f260a2e048279cf737bfd3e37b1fce0b`.
  It points to commit `24fe0ef7737efae15c87225755e9f6f5965e4888`. All bytes here come from that commit.
- Vendored: 2026-10-27, DevWork card CCV3-P4-VENDOR (https://app.notion.com/p/40676fd7ac82819aafc7e8b7e6ee0216)
- Allowlist: `grill-with-docs`, `to-spec`, `tdd`, `diagnosing-bugs`, `pr`, `code-review`
- Closure: `grilling` and `domain-modeling`. `grill-with-docs/SKILL.md:7` calls both by name and does nothing without them.
- Not vendored: `codebase-design` (`tdd/SKILL.md:26` calls it by name; CCv3 `tdd/references/deep-modules.md` replaces it)
  and every `agents/openai.yaml` (no skill links it).
- Layout: upstream folders are flattened to `skills/<name>/`. Upstream paths are in `vendor.lock.json` (`upstream_path`).
- Per-file sha256: `vendor.lock.json`

## Why each skill

- `grill-with-docs` (+ `grilling`, `domain-modeling`): interview rounds before a plan. User-only wrapper.
- `to-spec`: turns a conversation into a spec file. User-only wrapper.
- `tdd`: owns the name `tdd` (ADR-C). `.claude/skills/tdd/SKILL.md` is its wrapper. `name_shadows` in the lock lists the collision.
- `diagnosing-bugs`: red-first loop for hard and performance bugs. `systematic-debugging` stays the entry point and routes here.
- `pr`: Summary visual and Merge Danger template. One pointer line in `.claude/rules-ondemand/pr-and-commit-style.md`. Its Evidence section is replaced by the CCv3 Evidence block there (P4b).
- `code-review`: hidden. Cross-family review brief only. CCv3 `code-review` stays the verification gate. `name_shadows` lists both the skill and the bundled name.

## Ways in

| Vendored skill | Way in |
|---|---|
| `to-spec` | `.claude/skills/to-spec/SKILL.md` (user-only wrapper) |
| `grill-with-docs`, `grilling`, `domain-modeling` | `.claude/skills/grill-with-docs/SKILL.md` (user-only wrapper) |
| `tdd` | `.claude/skills/tdd/SKILL.md` |
| `diagnosing-bugs` | the route section in `.claude/skills/systematic-debugging/SKILL.md` |
| `pr` | the pointer in `.claude/rules-ondemand/pr-and-commit-style.md` |
| `code-review` | the cross-family review brief only. It has no wrapper. |

## Never-lines

These win over vendored text.

- N1: Never commit, push, open a PR or merge. The main session does this after Dave says yes.
- N2: Never write to an issue tracker: no issue, label or comment. Never run `/setup-matt-pocock-skills`.
- N3: Use the vendored Pocock code-review, interrogate, blast-radius and show-me-your-work only inside the cross-family review brief. Never use one as a Claude reviewer.
- N4: Never edit CLAUDE.md, AGENTS.md, CONTEXT.md, GLOSSARY.md, a rule file or settings.json. Propose the diff to Dave.
- N5: These files are pinned. Never update them in place. An update is a pull PR at a new pin.
- N6: When vendored text conflicts with a CCv3 rule, the CCv3 rule wins.
- N7: Never call the Skill tool for a name that only the vendored text uses (grilling, domain-modeling, codebase-design, how, why, arena, poteto-mode, unslop, principle-*). Read the file the wrapper names.

## Rules for this folder

- Never edit a vendored file. Bytes stay identical to upstream: `.gitattributes` sets
  `.claude/skills/_vendor/** -text`. The skills gate (vendor profile rule X02, also in pre-commit) fails
  when any file in this folder, except the three CCv3-owned files below, differs from `vendor.lock.json`,
  is missing, is not listed in it, or is a link. A missing `vendor.lock.json` fails too.
- CCv3 owns three files here: `PROVENANCE.md`, `vendor.lock.json`, `overlay.json`.
- `overlay.json` records each line that conflicts with a CCv3 "never" rule and how it is resolved.
  `node scripts/skills/vendor-conflict-scan.mjs --source .claude/skills/_vendor/pocock-skills` must
  report 0 uncovered.
- `name_shadows` in `vendor.lock.json` lists the names a vendored skill may share with a CCv3 skill.
  A listed collision passes G06 or G07. Any unlisted collision fails hard. A stale entry fails as X02.
- Claude Code does not list a skill under a `_` folder. The wrappers in "Ways in" are the only way in.
  A wrapper is user-only (`disable-model-invocation: true`), so it adds nothing to the skill listing.
- Upgrade (N5): a pull PR. Fetch the new tag at its commit SHA with `gh api`, never from HEAD. Write the bytes with
  Node `fs.writeFileSync`, not PowerShell. Update this file and `vendor.lock.json`. Re-run
  `vendor-conflict-scan.mjs` and `audit-skills.mjs --profile vendor`. Re-read each wrapper against the new text.
- Retire: move the folder to `.claude/skills/_archive/<date>/` with a note. Never delete. Remove the
  `name_shadows` entries and the wrappers that point here in the same PR.
