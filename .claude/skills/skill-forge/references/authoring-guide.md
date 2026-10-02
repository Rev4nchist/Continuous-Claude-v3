# Skill Authoring Guide

Reference for Claude Code skills. Read the section you need. `SKILL.md` has the workflow.

## Contents

- [Minimal template](#minimal-template)
- [Frontmatter for Claude Code](#frontmatter-for-claude-code)
- [Arguments and substitutions](#arguments-and-substitutions)
- [Context lifecycle and the listing budget](#context-lifecycle-and-the-listing-budget)
- [Writing the description](#writing-the-description)
- [Structure and progressive disclosure](#structure-and-progressive-disclosure)
- [Workflows and feedback loops](#workflows-and-feedback-loops)
- [Scripts](#scripts)
- [Worked example: a skill with a script](#worked-example-a-skill-with-a-script)
- [Worked example: a skill with no script](#worked-example-a-skill-with-no-script)
- [Distribution outside Claude Code](#distribution-outside-claude-code)
- [Troubleshooting](#troubleshooting)

## Minimal template

`init_skill.py` writes this. Replace every placeholder.

```markdown
---
name: your-skill-name
description: Does X. Use when Y.
---

# Your Skill Name

One sentence on what Claude must do that it does not already know.

## Workflow

1. First step, in the imperative.
2. Second step.
```

Add a reference file only when `SKILL.md` needs detail sometimes. Add a script only for a step that must be exact. The trigger belongs in the description. The body loads after the skill fired, so a "When to Use" section there only costs tokens.

## Frontmatter for Claude Code

Claude Code reads about 20 keys. Unknown keys are ignored, and the gate (G03) rejects them. Frontmatter is read only when `---` is on line 1. A YAML parse error loads the body with no fields, so the skill has no description and never triggers.

| Key | Use |
|-----|-----|
| `name` | Optional. Defaults to the folder name and sets the `/command`. Lowercase letters, digits, hyphens. Max 64. No "claude" or "anthropic". Keep it equal to the folder name. |
| `description` | Listed every turn. See [Writing the description](#writing-the-description). |
| `when_to_use` | Extra trigger text, added to the description. Counts toward the same cap. Not needed when the description carries the trigger. |
| `argument-hint` | Autocomplete hint, for example `[issue-number]`. |
| `arguments` | Named positional arguments for name substitution. |
| `disable-model-invocation` | `true`: only the user can invoke the skill. Its description leaves the listing and costs no budget. It also blocks subagent preload and scheduled firing. |
| `user-invocable` | `false`: Claude only. The skill stays in the listing and leaves the `/` menu. |
| `allowed-tools` | Pre-approves tools while the skill is active. See below. |
| `disallowed-tools` | Removes tools from the pool until the next user message. This one restricts. |
| `paths` | Glob patterns. The skill loads only when Claude touches matching files. |
| `context: fork` | Runs the body as a fresh subagent prompt with no conversation history. See below. |
| `agent` | The subagent type for `context: fork`. A built-in (`Plan`, `general-purpose`) or a name in `.claude/agents`. |
| `hooks` | Hooks that Claude Code registers when the skill is invoked. They keep running for the rest of the session. Use them for rules that must always hold. |
| `model`, `effort` | Override for the skill's turn. `effort` is `low`, `medium`, `high`, `xhigh` or `max`. Sonnet runs at `high`. Never Haiku. |
| `shell` | Shell for `!` command injection: `bash` (default) or `powershell`. |
| `license`, `compatibility` | Used by upload targets. |
| `metadata` | Ignored by Claude Code. Never reuse a real key name inside it (gate G04). |

Booleans accept `true`, `false`, `yes`, `no`, `on`, `off`, `1` and `0`.

### Who can invoke the skill

| Setting | User `/name` | Claude | Description in listing |
|---------|--------------|--------|------------------------|
| default | yes | yes | yes |
| `disable-model-invocation: true` | yes | no | no |
| `user-invocable: false` | no | yes | yes |
| both set | no | no | no (the skill is unreachable; the gate fails it) |

### allowed-tools pre-approves and never restricts

`allowed-tools` lets the listed tools run without a permission prompt for the turn. The grant ends at the next user message. It does not remove any other tool. To restrict, use `disallowed-tools` or a permission deny rule.

Scope shell grants with a pattern, for example `Bash(git status *)` or `Bash(node ${CLAUDE_SKILL_DIR}/scripts/*)`. A bare `Bash`, `PowerShell`, `Write` or `Edit` grant is too wide. A project skill's grant applies in untrusted folders and in `-p` runs.

### context: fork

`context: fork` runs the body as the prompt of a fresh subagent. The subagent starts without conversation history and runs in the background by default. A skill that holds only guidelines returns nothing useful when forked: it needs a task to do.

### Invocation and name resolution

An enterprise skill beats a personal one, and a personal one beats a project one. A local skill replaces a bundled skill of the same name but not its aliases. The names `synced` and `anthropic-skills*` are reserved. Gate rule G06 flags names that Claude Code bundles.

## Arguments and substitutions

Claude Code rewrites these before Claude sees the body:

| Text | Becomes |
|------|---------|
| `$ARGUMENTS` | All arguments as typed |
| `$ARGUMENTS[N]`, `$N` | The Nth argument, counted from 0 |
| `$name` | A named argument from `arguments` |
| `${CLAUDE_SESSION_ID}`, `${CLAUDE_EFFORT}` | Session id, effort level |
| `${CLAUDE_SKILL_DIR}` | The skill folder. Use it for script paths. |
| `${CLAUDE_PROJECT_DIR}` | The project root |

When the body has no argument placeholder, Claude Code appends `ARGUMENTS: <value>` to the body.

Indexed arguments use shell-style quoting: `"hello world" second` gives `hello world` and `second`. A literal dollar sign before a digit, `ARGUMENTS` or a declared argument name is a placeholder. Escape it with one backslash, as `\$`. A backslash before any other dollar sign changes nothing. Without the escape, `awk '{print $1}'` or a price such as `$10` changes when the user passes arguments. Gate rule G21 flags the unescaped form in a body that declares no arguments.

Dynamic injection: a line with `!` and a backticked command, or a fenced block that starts with three backticks and `!`, runs before Claude sees the body. A non-zero exit aborts the whole invocation. Commands are permission-checked. The setting `disableSkillShellExecution` turns them off.

## Context lifecycle and the listing budget

### The body stays for the session

Claude Code loads the rendered body once when the skill fires. It does not read the file again. After compaction, it re-attaches only the first 5,000 tokens of each recent skill, up to 25,000 tokens in total. Therefore:

- Put the rules that must hold at the top.
- Put long, optional detail in references.
- Put a rule that must always hold in a hook, not in a skill.

### The listing budget

Every turn, Claude sees the name and description of every model-visible skill.

- A name is always listed.
- Description plus `when_to_use` is cut at `skillListingMaxDescChars`.
- The whole listing is capped at `skillListingBudgetFraction` of the context window.
- When the listing is over budget, Claude Code drops the descriptions of the least-invoked skills first. Those skills stay invocable by name but are less likely to be chosen.
- `disable-model-invocation: true` costs 0. `skillOverrides` set to `name-only` costs only the name. `off` costs nothing.

The cap is not a reservation: a turn pays the real listing size. Therefore a longer description costs context on every turn, and a rarely-used skill loses its description first. Put the key use case first. Measure with `/doctor` (biggest contributors), the Skills row of `/context`, and `--debug` (over-budget warning). The gate ratchets the listing size (G31).

### Skill overrides

`skillOverrides` in settings sets a skill to `on`, `name-only`, `user-invocable-only` or `off`. The eval runner uses `off` for the baseline.

## Writing the description

The convention: **"Does X. Use when Y."** One line. Third person. At most 400 characters (the gate ratchet). The hard limit is 1,024 (the platform). No XML tags.

Good:

```
Formats raw meeting notes into decisions, action items and open questions. Use when the user pastes a transcript or asks to clean up meeting notes.
```

Bad:

```
Use this skill whenever the user mentions meetings, notes, summaries, documents or anything similar.   (pushy, vague, no "what")
I can help you format notes.                                                                         (first person)
```

Rules:

- Say what the skill does, then when to use it. A description that only says "Use when" fails gate rule G13.
- Use the terms users type: file types, tool names, verbs.
- Be specific, not pushy. Claude picks from 100 or more skills by description alone. A broad description steals triggers from other skills and causes false fires.
- Name near misses: "Not for X, use Y."
- Do not repeat a quoted trigger phrase that another skill uses (gate rule G15).
- Avoid `: ` and ` #` in plain YAML text. Quote the value or rephrase.
- Test the description with trigger evals (step 8 in `SKILL.md`).

## Structure and progressive disclosure

```
skill-name/
  SKILL.md          required: overview and links
  references/       docs Claude reads when needed
  scripts/          code Claude runs
  assets/           files used in output
  evals/            evals.json (not packaged)
```

Three levels load in order:

1. Name and description: always in context.
2. `SKILL.md` body: when the skill fires. Keep it under 500 lines (gate G20).
3. Reference files and scripts: only when read or run. A script that runs costs no body tokens.

Rules:

- `SKILL.md` is an overview that points to files. Say when to read each one.
- Reference files are one level deep from `SKILL.md`. A reference that sends Claude to a second file gets read in part (gate G23).
- A reference over 100 lines starts with a contents list (gate G24).
- Name files by content: `form-fields.md`, not `doc2.md`. Use forward slashes (gate G25).
- Split by domain when one skill covers variants. Claude reads only the file it needs.

```
cloud-deploy/
  SKILL.md          workflow and how to choose a provider
  references/
    aws.md
    gcp.md
```

- Write no time-sensitive text: no dates, no "before month year use X". Put legacy under an "Old patterns" heading (gate G26 skips it).
- Use one term for one concept.
- Skills are named for what they do. A gerund (`processing-pdfs`) is preferred. Avoid `helper`, `utils`, `tools`.

## Workflows and feedback loops

- Write a complex task as numbered steps. For a long one, give a checklist that Claude copies and ticks.
- Add a decision point when the path forks: "If X, follow A. Otherwise follow B."
- Add a feedback loop for quality-critical work: run a validator, fix, repeat.
- For batch or destructive work, use plan, validate, execute. Claude writes a plan file, a script validates it, then Claude applies it.
- Match freedom to risk. Heuristics suit open tasks. An exact script suits a fragile operation. A mismatch in either direction is a defect.
- Give a default, not a menu. Add one escape hatch.
- Use strict templates when the format is required. Use flexible ones otherwise. Show an input and output pair when style matters.

## Scripts

- Solve the problem in the script. Handle errors there. Do not leave them to Claude.
- Explain each constant in a comment. No magic numbers.
- List required packages in `SKILL.md`. Do not assume they are installed.
- Say whether Claude runs the script or reads it.
- Print verbose errors that say what to fix.
- Call scripts as `python "${CLAUDE_SKILL_DIR}/scripts/name.py"` so the path works from any directory.

## Worked example: a skill with a script

```markdown
---
name: fourth-excel-templates
description: Builds Fourth-branded Excel reports with company colours, fonts, formulas and logo. Use when the user asks for a P&L, budget template or sales dashboard spreadsheet.
---

# Fourth Excel Templates

1. Read [brand_guidelines.md](references/brand_guidelines.md) for colours, fonts and logo rules.
2. Run `scripts/excel_builder.py` with the title and the data as JSON. It writes the workbook.
3. Open the result and check the totals. If a formula shows an error, fix the data and rerun.
4. Return the file to the user.

Example input: "Create a Q4 budget template with Fourth branding."
Example output: `Q4_Budget_Template.xlsx` with header styling, a logo in the top right and total formulas.
```

## Worked example: a skill with no script

```markdown
---
name: meeting-notes-formatter
description: Formats raw meeting notes into decisions, action items and open questions. Use when the user pastes a transcript or asks to clean up meeting notes.
---

# Meeting Notes Formatter

Sort the notes into these sections. Give every action item an owner and a due date.

# Meeting Summary: [topic]
**Date**: [date]  **Attendees**: [names]

## Decisions
- [decision]

## Action items
- [ ] [task] - @[owner] - due [date]

## Open questions
- [question]
```

## Distribution outside Claude Code

Claude Code reads the skill from the repo and needs no packaging. Two other targets exist:

- claude.ai upload and the Skills API accept only `name`, `description`, `license`, `allowed-tools`, `metadata` and `compatibility`. Any other key is a hard error. `package_skill.py` checks this with `--target upload`.
- A plugin ships skills under the plugin's own folder. Plugin skills are not touched by `skillOverrides`.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Skill never triggers | Vague description, or a YAML error dropped the frontmatter | Run `claude plugin validate .claude/skills`. Rewrite the description with the terms users type. Run trigger evals. |
| Skill triggers for the wrong prompts | Description too broad, or it shares a phrase with another skill | Narrow it. Add "Not for X, use Y." Check gate rule G15. |
| Description missing from the listing | Listing over budget, and this skill is rarely invoked | Check `/doctor` and `/context`. Shorten descriptions. Use `name-only` for skills that nobody uses. |
| Script does not run | Missing package, or a wrong path | Use `${CLAUDE_SKILL_DIR}`. Add a dependency check that prints what to install. |
| Rule ignored after compaction | The rule sits beyond the first 5,000 tokens | Move it to the top, or enforce it in a hook. |
| Edit has no effect | A personal skill of the same name wins over the project copy | Sync the repo to the active folder. Edits to `SKILL.md` reload live. No restart is needed. |
| Awk or price text changed | An unescaped dollar-digit became an argument | Escape it as `\$`. |
| High token use | Body too long, or duplicated detail | Move detail to references. Replace code blocks with scripts. |
