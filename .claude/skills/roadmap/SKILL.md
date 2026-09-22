---
name: roadmap
description: Manages ROADMAP.md sections manually. Use when user says "/roadmap show", "/roadmap add", "update the roadmap", "set current focus".
---

# /roadmap - ROADMAP Management

<roadmap-command>

## Purpose
Manual management of ROADMAP.md sections. Use when automation hasn't captured planned items or to manually set current focus.

## Commands

### `/roadmap show`
Display current ROADMAP state with section summaries.

### `/roadmap add <item>`
Add an item to the Planned section.

**Example:**
```
/roadmap add Implement user authentication
/roadmap add "Dark mode support" --priority high
```

### `/roadmap focus <item>`
Set the Current Focus to the specified item. If item is in Planned, it gets promoted.

**Example:**
```
/roadmap focus ROADMAP Source of Truth Implementation
```

### `/roadmap complete <item>`
Move an item from Current Focus to Completed. If no item specified, completes the current goal.

**Example:**
```
/roadmap complete
/roadmap complete "User authentication"
```

## Implementation

### For `/roadmap show`:
```bash
cat ROADMAP.md
```

### For `/roadmap add <item>`:
1. Read ROADMAP.md
2. Find `## Planned` section
3. Add `- [ ] <item>` after the header
4. Write updated content

### For `/roadmap focus <item>`:

`## Current Focus` is **human-owned**. As of 2026-08-05 the `post-plan-roadmap` hook no longer
writes it when it is occupied (it only seeds a vacant section, and only with a title that passes
a quality gate), which makes this command the primary way the focus changes. Two rules follow
from that, both learned the hard way:

- **Switching focus is not finishing the goal.** Demote the outgoing goal to **Planned**, never
  to Completed. The hook had this exact bug and it was removed in `091f19f` — a `/roadmap focus`
  that mis-files the old goal as done reintroduces it by hand.
- **The detail bullets under the title are hand-written and load-bearing.** Do not regenerate the
  block. Replace the title line and the `- Started:` line; leave every other bullet alone, and
  tell the user which bullets now describe the previous goal so they can prune them deliberately.
  Regenerating this block from a template is the clobber this whole subsystem was just fixed for.

Steps:
1. Read ROADMAP.md.
2. If a current goal exists, add it to `## Planned` as `- [ ] <old title>` (skip if already
   present — do not duplicate). **Not** Completed.
3. Replace only the `**<old title>**` line with `**<item>**`, and the `- Started:` line with
   today's date. Leave all other bullets in the section untouched.
4. If `<item>` was in Planned, remove that entry.
5. Write updated content, then report which pre-existing bullets may now be stale.

### For `/roadmap complete [item]`:
1. Read ROADMAP.md
2. Find current goal (or match provided item)
3. Add to Completed section with date: `- [x] <item> (YYYY-MM-DD)`
4. Clear Current Focus to the placeholder `No current focus set.` — but **show the user the detail
   bullets you are about to remove first.** Finishing a goal does not make its notes worthless, and
   they are frequently the only record of an open follow-up (a "rotate the API key" action item,
   a deferred sub-task). Offer to carry anything still live into `## Planned` or `## Notes` before
   clearing. `No current focus set.` is the one string the hook's deletion guard permits removing.
5. Write updated content

## Section Format

```markdown
# Project Roadmap

## Current Focus

**<Goal Title>**
- <Description or key info>          <- any number of these; hand-written, never regenerated
- Started: YYYY-MM-DD

## Completed
- [x] <item> (YYYY-MM-DD)

## Planned
- [ ] <item> (free-form parenthetical)
```

Format notes (2026-08-05) — these describe what the tooling now guarantees:

- **Current Focus takes any number of detail bullets.** The parser flattens them into one joined
  string internally, which is why the hook must never render that field back to the file. Treat
  multi-bullet as the normal case, not an edge case.
- **The Planned parenthetical is free-form.** It used to be rewritten to `(<bucket> priority)`,
  which silently destroyed notes like `(H1 from handoff, see §4)`. Nothing rewrites it now — do not
  "normalize" it by hand either.
- **Prose and nested sub-bullets are legal inside `## Completed` and `## Planned`** and are
  preserved. They used to be dropped because they did not match the checkbox regex.

## ROADMAP Location
Search order:
1. `$CLAUDE_PROJECT_DIR/ROADMAP.md`
2. Recursive upward from current directory
3. `~/.claude/ROADMAP.md` (fallback)

</roadmap-command>
