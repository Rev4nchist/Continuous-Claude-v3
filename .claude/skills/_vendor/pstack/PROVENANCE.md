# Provenance: pstack (vendored)

- Source: https://github.com/cursor/plugins, folder `pstack/` (MIT, see `LICENSE`, "Copyright (c) 2026 Lauren Tan")
- Pin: commit `519d36aa98955bf680db01bcde5fdfba686dc901` (2026-10-27). The repo has no tag for it.
- Vendored: 2026-10-27, DevWork card CCV3-P4-VENDOR (https://app.notion.com/p/40676fd7ac82819aafc7e8b7e6ee0216)
- Allowlist: `architect`, `interrogate`, `blast-radius`, `show-me-your-work`, `principle-prove-it-works`
- Closure: `arena`. `architect/references/rationale-template.md:19` links `../../arena/SKILL.md`.
  Without it G22 fails on an unresolved reference.
- Not vendored: `how`, `why`, `poteto-mode`, `unslop`, the other 9 `principle-*` skills and `pstack-models.mdc`.
  The vendored text names them as skills, not as file links. The `sketch-first` wrapper maps `how` and `why` to CCv3 steps.
  A principle name is prose: apply the plain rule in the sentence.
- Layout: upstream `pstack/skills/<name>/` becomes `skills/<name>/`, so `../../arena/SKILL.md` still resolves.
  Upstream paths are in `vendor.lock.json` (`upstream_path`).
- Per-file sha256: `vendor.lock.json`

## Why each skill

- `architect` (+ `arena`): plan front door. Sketches types and signatures before code, then writes a plan file. User-only wrapper `sketch-first`.
  The wrapper has its own name to avoid confusion with the `architect` agent.
- `interrogate`, `blast-radius`, `show-me-your-work`: bytes only, hidden. Used only inside the cross-family review brief (D4).
- `principle-prove-it-works`: bytes only, hidden. No wrapper in P4. P4b consumes it.

## Ways in

| Vendored skill | Way in |
|---|---|
| `architect` (+ `arena`) | `.claude/skills/sketch-first/SKILL.md` (user-only wrapper). Output: `thoughts/shared/plans/<name>-plan.md` |
| `interrogate`, `blast-radius`, `show-me-your-work` | the cross-family review brief only. They have no wrapper. |
| `principle-prove-it-works` | none in P4 |

## Never-lines

These win over vendored text.

- N1: Never commit, push, open a PR or merge. The main session does this after Dave says yes.
- N2: Never write to an issue tracker: no issue, label or comment. Never run `/setup-matt-pocock-skills`.
- N3: Use the vendored Pocock code-review, interrogate, blast-radius and show-me-your-work only inside the cross-family review brief. Never use one as a Claude reviewer.
- N4: Never edit CLAUDE.md, AGENTS.md, CONTEXT.md, GLOSSARY.md, a rule file or settings.json. Propose the diff to Dave.
- N5: These files are pinned. Never update them in place. An update is a pull PR at a new pin.
- N6: When vendored text conflicts with a CCv3 rule, the CCv3 rule wins.
- N7: Never call the Skill tool for a name that only the vendored text uses (grilling, domain-modeling, codebase-design, how, why, arena, poteto-mode, unslop, principle-*). Read the file the wrapper names.
- N8: Never use Grok. Runners and judges are Claude subagents at the CLAUDE.md model tiers.
- N9: Stop after the plan file. Implementation starts only after Dave approves the plan.

Grok: `architect/SKILL.md:31`, `arena/SKILL.md:17,28` and `interrogate/SKILL.md:32` default a runner to `grok-4.7-xhigh-fast`.
Grok is parked on this machine. No gate covers it, so N8 does. Ignore every model name in the vendored text.
`blast-radius` has no overlay entry: it has no conflict-scan hit. N3 covers it here.

## Rules for this folder

- Never edit a vendored file. Bytes stay identical to upstream: `.gitattributes` sets
  `.claude/skills/_vendor/** -text`. The skills gate (vendor profile rule X02, also in pre-commit) fails
  when any file in this folder, except the three CCv3-owned files below, differs from `vendor.lock.json`,
  is missing, is not listed in it, or is a link. A missing `vendor.lock.json` fails too.
- CCv3 owns three files here: `PROVENANCE.md`, `vendor.lock.json`, `overlay.json`.
- `overlay.json` records each line that conflicts with a CCv3 "never" rule and how it is resolved.
  `node scripts/skills/vendor-conflict-scan.mjs --source .claude/skills/_vendor/pstack` must
  report 0 uncovered.
- `name_shadows` in `vendor.lock.json` is empty. A vendored name that collides with a CCv3 skill, or with a
  skill of another vendored source, fails G07. Another source's entry never covers this one.
- Claude Code does not list a skill under a `_` folder. The wrapper in "Ways in" is the only way in.
  It is user-only (`disable-model-invocation: true`), so it adds nothing to the skill listing.
- Upgrade (N5): a pull PR. Fetch the new commit with `gh api` at its SHA, never from HEAD. Write the bytes with
  Node `fs.writeFileSync`, not PowerShell. Update this file and `vendor.lock.json`. Re-run
  `vendor-conflict-scan.mjs` and `audit-skills.mjs --profile vendor`. Re-read the wrapper against the new text.
- Retire: move the folder to `.claude/skills/_archive/<date>/` with a note. Never delete. Remove the wrapper in the same PR.
