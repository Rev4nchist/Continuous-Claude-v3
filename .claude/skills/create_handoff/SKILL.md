---
name: create-handoff
description: Write a session handoff as a row in the Claude Bridge Handoffs database (canonical) plus a local YAML copy, to resume work in a new session. Use when user says "/create_handoff", "create a handoff", "give me a handoff", "put the handoff in notion", "hand this off", "wrap up the session".
---

# Create Handoff

You are tasked with writing a handoff document to hand off your work to another agent in a new session. You will create a handoff document that is thorough, but also **concise**. The goal is to compact and summarize your context without losing any of the key details of what you're working on.

## Where a handoff lives (decided 2026-09-24, P36)

- **The Notion row is the handoff.** It is a row in the 📬 Handoffs database on Claude Bridge HQ
  (data source `13b919c8-b7af-4609-b4c6-87e5504809f0`) with **To = Next session**. It shows in the
  🔁 Next session view. Dave reads it, other tools read it, and `/resume_handoff` reads it. Never put
  handoffs in Dave's Scratchpad: that page is for research he has not introduced to his AI surfaces yet.
- **The local YAML is a generated copy**, written in the same step from the same content. It exists
  only because the statusline (`goal:` / `now:`), recall indexing and session-start continuity read
  YAML. It carries `notion_url:` and is never edited by hand.
- **Notion wins.** If the two differ, regenerate the YAML from the Notion page. Never copy YAML
  edits back into Notion.
- **Notion unreachable** (headless run, connector down): write the YAML with `notion: pending` plus
  the row's exact metadata, `notion_title:`, `project:`, `repo:` (absolute path), `branch:` and `priority:`, so a
  later push records the original provenance, not the pushing session's. Tell Dave in one line.
  Step "Push pending first" below (run by every `/create_handoff` and `/resume_handoff`) creates the
  row from it.

## Process
### Push pending first (every run)

Before anything else, find local YAML with `notion: pending`:
`grep -l "^notion: pending" thoughts/shared/handoffs/*/*.yaml`. For each, create its Notion row (step
0) from the YAML itself: title from `notion_title:`, `Project` from `project:`, `Repo` from `repo:`, branch from `branch:`,
`Priority` from `priority:`, the date from `date:`, and the body from its fields. Never substitute the
current session's repo or branch. Then replace `notion: pending` with `notion_url: <row URL>`. If
Notion is still unreachable, leave the files as they are and say how many are pending.

### 0. Create the Notion row

Use the claude.ai Notion MCP `notion-create-pages` with parent
`{"type": "data_source_id", "data_source_id": "13b919c8-b7af-4609-b4c6-87e5504809f0"}` and these
properties:

| Property | Value |
|---|---|
| `Handoff` (title) | `[Code→Next session] <topic> (<repo>) — YYYY-MM-DD` |
| `From` / `To` | `Code` / `Next session` |
| `Status` | `Pending` |
| `Priority` | `High`, `Mid` or `Low` |
| `date:Date:start` | today, `YYYY-MM-DD` |
| `Project` | short project name, e.g. `CCv3`, `FourthBot`, `Minions` (required) |
| `Repo` | absolute repo path |
| `Outcome` | `SUCCEEDED`, `PARTIAL_PLUS`, `PARTIAL_MINUS` or `FAILED` |
| `Summary` | one sentence: what the next session does first |
| `Resume phrase` | `Resume the handoff in Notion: "<exact title>"` |

Page body, in this order (plain Markdown, no tables):

```markdown
**Project:** <name> | **Repo:** <absolute path> | **Branch:** <branch> | **Outcome:** <SUCCEEDED|PARTIAL_PLUS|PARTIAL_MINUS|FAILED>
**Goal:** <what this session accomplished>
**Now:** <what the next session does first>
**Test:** <command that verifies this work>

## Done this session
- <task> (<files>)
## Decisions
- <decision>: <why>
## Findings
- <finding>
## Worked / Failed
- Worked: <approach> | Failed: <approach and why>
## Blockers and open questions
- <item>
## Next
1. <first step>
2. <second step>
## Start the next session with
Resume the handoff in Notion: "<exact title>"
```

Keep the row URL; the YAML copy and the completion message need it. Put it in `notion_url:` of the
YAML below. Do not create a separate Tracker or HQ one-liner: the 🔁 Next session view is the queue.

### 0b. Triage the project's lessons log (when the repo has one)

If the repo has a lessons log with an incident command (FourthCompanyBrain: `python docs/playground/deploy.py incidents`,
log `docs/playground/FABRIC-LESSONS.md`), run it before you write the handoff. Mark each untriaged incident with the
lesson it matches, or add a new lesson row and mark it. Promote a lesson to its on-demand rule when it cost money,
cost more than 30 minutes, or happened twice. Name the new lessons under Findings in the handoff.

### 1. Filepath & Metadata (local YAML copy)
Use the following information to understand how to create your document:

**Get this session's id:** run `echo "$CLAUDE_CODE_SESSION_ID"`. That full uuid is `session_id`; its first 8
characters are `sid8`. The id survives `/compact`, so the compacted session finds this file by it. If the
variable is empty, leave `session_id:` empty and tell Dave the file will not auto-load.

**Folder:** `{session-name}` is the workstream name Dave gave for this session, else `general`. Never
pick it from other handoffs: another session's folder is not yours.

**Create your file under:** `thoughts/shared/handoffs/{session-name}/YYYY-MM-DD_HH-MM_{sid8}_description.yaml`, where:
- `YYYY-MM-DD` is today's date
- `HH-MM` is the current time in 24-hour format (no seconds needed)
- `{sid8}` is the first 8 characters of the session id
- `description` is a brief kebab-case description

**Example:** `thoughts/shared/handoffs/general/2026-01-08_16-30_0d40499c_bug-investigation.yaml`

### 2. Write YAML handoff (~400 tokens vs ~2000 for markdown)

**CRITICAL: Use EXACTLY this YAML format. Do NOT deviate or use alternative field names.**

The `goal:` and `now:` fields are shown in the statusline - they MUST be named exactly this.

```yaml
---
session: {session-name}
session_id: {full uuid of this session, from CLAUDE_CODE_SESSION_ID}
date: YYYY-MM-DD
status: complete|partial|blocked
outcome: SUCCEEDED|PARTIAL_PLUS|PARTIAL_MINUS|FAILED
notion_url: {URL of the Notion row from step 0}
# If Notion was unreachable, replace notion_url with ALL of these (used by "Push pending first"):
# notion: pending
# notion_title: "[Code→Next session] <topic> (<repo>) — YYYY-MM-DD"
# project: <short project name>
# repo: <absolute repo path>
# branch: <branch>
# priority: High|Mid|Low
# Generated copy of the Notion page. Edit the Notion page, not this file.
---

goal: {What this session accomplished - shown in statusline}
now: {What next session should do first - shown in statusline}
test: {Command to verify this work, e.g., pytest tests/test_foo.py}

done_this_session:
  - task: {First completed task}
    files: [{file1.py}, {file2.py}]
  - task: {Second completed task}
    files: [{file3.py}]

blockers: [{any blocking issues}]

questions: [{unresolved questions for next session}]

decisions:
  - {decision_name}: {rationale}

findings:
  - {key_finding}: {details}

worked: [{approaches that worked}]
failed: [{approaches that failed and why}]

next:
  - {First next step}
  - {Second next step}

files:
  created: [{new files}]
  modified: [{changed files}]
```

**Field guide:**
- `goal:` + `now:` - REQUIRED, shown in statusline
- `done_this_session:` - What was accomplished with file references
- `decisions:` - Important choices and rationale
- `findings:` - Key learnings
- `worked:` / `failed:` - What to repeat vs avoid
- `next:` - Action items for next session

**DO NOT use alternative field names like `session_goal`, `objective`, `focus`, `current`, etc.**
**The statusline parser looks for EXACTLY `goal:` and `now:` - nothing else works.**
---

### 3. Refresh registered artifacts (REQUIRED if any match)

Some sessions maintain a **living published artifact** — a page on claude.ai that is meant to stay
current as work progresses, not a one-shot deliverable. Those are registered in
`.claude/artifacts.json` at the repo root.

Read that file. An entry is in scope for this handoff when **either**:

- its `session` equals this handoff's `{session-name}`, **or**
- its `session` is `"*"`, which means *cross-track*: the page reports on work from every track, so
  any handoff can stale it and every handoff must consider it.

> Why `"*"` exists. Match-on-session-name is right for a page scoped to one workstream, and wrong
> for a page whose whole job is to show status ACROSS workstreams — that entry would only ever
> refresh when its own track happened to write a handoff. The lane board sat 3 days stale exactly
> this way: it is `session: agentic-os`, and the harness work that changed it wrote handoffs under
> `suite-green` / `ccv3-stabilise` / `context-lever`, so the match correctly never fired and no
> handoff ever considered the page. Scope the key to what the page REPORTS ON, not to who happens
> to maintain it.

For every entry in scope:

1. **Decide whether the page is now stale.** It is stale if this session changed anything the page
   asserts — a finding it states, a lane's status, a count, a "next" item, a decision it records.
   A session that only read code does not make it stale. Say so and skip rather than churning.
   For a `"*"` entry, ask this about *your* work regardless of which track you are on.
2. **Read the artifact's `url` first with the Artifact tool, action `read` (not WebFetch).** This is REQUIRED, not optional. Your held copy is old. The Artifact tool
   refuses to redeploy from a session that has not seen the currently-published version — it
   errors with *"This session hasn't viewed the latest version"* — because another session may
   have republished since. Fetching is also how you find out: compare what is live against the
   repo `source`. If they differ, another session edited the artifact without committing its
   source; reconcile before publishing rather than silently reverting their work.
3. **Bring the page up to date — how depends on `content_model`.**
   - `narrative-snapshot` — the `source` file IS the page. Edit it so it reflects reality.
     Corrections matter more than additions: if this session *refuted* something the page claims,
     fix the claim, do not leave it standing next to its correction.
   - `generated` — the `source` is a GENERATOR, not the page, and is usually not even HTML. Do
     **not** pass it to the Artifact tool. Run the entry's `render` command to produce
     `publish_from`, and fix wrong output by fixing the generator or the DATA it reads — never by
     editing the rendered HTML, which the next render silently discards. If the page shows a stale
     status line that lives in the database, correct it at the source of truth (for the lane board:
     `node C:/Users/dkhay/.claude/scripts/lane.mjs note <id> "..."`, only on a lane you hold; for another session's lane send the correction with `say "..." --to <label>`).
   - `dashboard-store` — a Claude Dashboard artifact. Its page and data live in the artifact store.
     Skip steps 2, 4, 5 and 6 for it: never read it as a page, never publish a page file to it and
     never record a `last_published` from a publish. Data uploads are not page publishes: the skill
     the entry names in `refresh_skill` makes them (`asset: true`). A page change follows the
     Dashboard type's own `SKILL.md` on that artifact.
4. **Republish to the same URL** (not for `dashboard-store`):

```
Artifact tool:
  file_path:  narrative-snapshot -> the entry's `source`, absolute path
              generated          -> the entry's `publish_from`, absolute path (after running `render`)
  url:        <the entry's `url`>          <- REQUIRED. Omitting it mints a NEW url and orphans the old link.
  favicon:    <the entry's `favicon`>      <- reuse verbatim; a changed favicon reads as a different page
  description: <one sentence, may update>
```

5. **VERIFY BEFORE YOU RECORD. REQUIRED.** Do not treat the publish call returning as proof it
   published. Read the result back two ways: **WebFetch the returned URL** (it works on artifacts
   you own, verified 2026-08-05), **and** confirm the id appears in `Artifact action:"list"`. Only
   after both pass do you write anything to `.claude/artifacts.json`.

   *Why this step exists:* on 2026-08-05 every other step here was followed, and the registry
   still recorded `last_published: 2026-08-05` against a URL that did not exist — commit `8bba4df`
   claimed the republish succeeded and the page was never there. Five commits (`42ed422`,
   `11a6e26`, `821296d`, `eaeb7b1`, `8bba4df`) are the same "republished/stale" churn with no root
   cause claimed. Nothing in the procedure ever read the result back, so a failed publish entered
   the registry as a fact and the next session believed it on sight. **The recurring defect was
   the recording, not the publishing.**

   *If the recorded URL is dead* — absent from `Artifact action:"list"`, not merely unreachable —
   there is nothing to redeploy in place, so step 4's "url is REQUIRED" does not apply. Publish
   **without** `url` to mint a fresh one, verify as above, then record the new `url` plus a dated
   block saying what happened. `force: true` overwrites another session's version; it does not
   resurrect a deleted one.

6. **Update `last_published`** in `.claude/artifacts.json` and include it in the same commit as the
   source edit. If you changed what the page fundamentally IS — generated vs hand-authored — record
   that as a dated decision in `notes` that explicitly supersedes the prior one rather than deleting
   it, and make `source` / `content_model` match what you actually published. A registry that
   describes a page which no longer exists is worse than no registry: the next session reads it,
   believes it, and reverts someone's work on the strength of it.

Never pass `force: true` to skip the read-first check unless the user explicitly asks to discard
another session's version — it overwrites their work.

**Do not** create a new artifact here. This step only refreshes ones already registered. If a
session produced a genuinely new page worth keeping alive, publish it, then add an entry to
`.claude/artifacts.json` recording `url`, `source`, `favicon`, `session` (`"*"` if it reports across
tracks), `content_model`, and — for a `generated` entry — `render` and `publish_from`.

---

### 4. Confirm Outcome & Index into Recall (REQUIRED)

**IMPORTANT:** Before responding to the user, you MUST confirm the session outcome.

Use the AskUserQuestion tool with these exact options:

```
Question: "How did this session go?"
Options:
  - SUCCEEDED: Task completed successfully
  - PARTIAL_PLUS: Mostly done, minor issues remain
  - PARTIAL_MINUS: Some progress, major issues remain
  - FAILED: Task abandoned or blocked
```

**The outcome lives in the Notion row's `Outcome` property (and its page header) and the YAML frontmatter** (`outcome:`, REQUIRED in both). After the user responds, update the Notion row first, then the YAML copy, if either differs from their choice.

Then index the handoff you just created into `archival_memory` so recall can surface it — with its outcome — in future sessions:

```bash
# Index THE handoff you created in step 1 (not "whatever is newest in a stale table").
# index_handoffs.py is idempotent — re-runs on the same path insert nothing new.
PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || echo "${CLAUDE_PROJECT_DIR:-.}")
HANDOFF_PATH="thoughts/shared/handoffs/{session-name}/YYYY-MM-DD_HH-MM_{sid8}_description.yaml"  # the file from step 1
cd "$PROJECT_ROOT/opc" && uv run python scripts/core/index_handoffs.py --apply --only-path "$HANDOFF_PATH"
```

This parses the handoff's fields (goal, done, decisions, findings, next, blockers) into per-field
recall entries tagged with `source=handoff` and `outcome=<your outcome>`, so a future session's
`/recall` surfaces this work with the correct outcome.

> Do NOT use `artifact_mark.py --latest` — the `handoffs` SQL table it writes is deprecated/unpopulated,
> and `--latest` silently marks a stale January row. See that script's docstring.

### 5. Confirm completion

After marking the outcome, respond to the user:

```
Handoff created in Notion: <page URL>. Outcome marked as [OUTCOME].

Start the next session with:
Resume the handoff in Notion: "<exact page title>"
```

If Notion was unreachable, say so instead and give the YAML path; it is pushed to Notion on the
next create or resume.

If step 3 refreshed an artifact, name it and give the URL — the user's bookmark is unchanged, so
say what moved on the page rather than re-pasting the link as if it were new.

---
##.  Additional Notes & Instructions
- **more information, not less**. This is a guideline that defines the minimum of what a handoff should be. Always feel free to include more information if necessary.
- **be thorough and precise**. include both top-level objectives, and lower-level details as necessary.
- **avoid excessive code snippets**. While a brief snippet to describe some key change is important, avoid large code blocks or diffs; do not include one unless it's necessary (e.g. pertains to an error you're debugging). Prefer using `/path/to/file.ext:line` references that an agent can follow later when it's ready, e.g. `packages/dashboard/src/app/dashboard/page.tsx:12-24`
