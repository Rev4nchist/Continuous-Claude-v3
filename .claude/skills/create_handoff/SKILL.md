---
name: create-handoff
description: Write a YAML handoff doc to resume work in a new session. Use when user says "/create_handoff", "create a handoff", "hand this off", "wrap up the session".
---

# Create Handoff

You are tasked with writing a handoff document to hand off your work to another agent in a new session. You will create a handoff document that is thorough, but also **concise**. The goal is to compact and summarize your context without losing any of the key details of what you're working on.


## Process
### 1. Filepath & Metadata
Use the following information to understand how to create your document:

**First, determine the session name from existing handoffs:**
```bash
ls -td thoughts/shared/handoffs/*/ 2>/dev/null | head -1 | xargs basename
```

This returns the most recently modified handoff folder name (e.g., `open-source-release`). Use this as the handoff folder name.

If no handoffs exist, use `general` as the folder name.

**Create your file under:** `thoughts/shared/handoffs/{session-name}/YYYY-MM-DD_HH-MM_description.yaml`, where:
- `{session-name}` is from existing handoffs (e.g., `open-source-release`) or `general` if none exist
- `YYYY-MM-DD` is today's date
- `HH-MM` is the current time in 24-hour format (no seconds needed)
- `description` is a brief kebab-case description

**Examples:**
- `thoughts/shared/handoffs/open-source-release/2026-01-08_16-30_memory-system-fix.yaml`
- `thoughts/shared/handoffs/general/2026-01-08_16-30_bug-investigation.yaml`

### 2. Write YAML handoff (~400 tokens vs ~2000 for markdown)

**CRITICAL: Use EXACTLY this YAML format. Do NOT deviate or use alternative field names.**

The `goal:` and `now:` fields are shown in the statusline - they MUST be named exactly this.

```yaml
---
session: {session-name from ledger}
date: YYYY-MM-DD
status: complete|partial|blocked
outcome: SUCCEEDED|PARTIAL_PLUS|PARTIAL_MINUS|FAILED
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
2. **WebFetch the artifact's `url` first.** This is REQUIRED, not optional. The Artifact tool
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
     `node scripts/coordination/lane.mjs note <id> "..."`).
4. **Republish to the same URL:**

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

**The outcome lives in the YAML frontmatter** (`outcome:` field, written in step 2 — it is REQUIRED there). After the user responds, make sure that frontmatter value matches their choice (edit the handoff file if it differs).

Then index the handoff you just created into `archival_memory` so recall can surface it — with its outcome — in future sessions:

```bash
# Index THE handoff you created in step 1 (not "whatever is newest in a stale table").
# index_handoffs.py is idempotent — re-runs on the same path insert nothing new.
PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || echo "${CLAUDE_PROJECT_DIR:-.}")
HANDOFF_PATH="thoughts/shared/handoffs/{session-name}/YYYY-MM-DD_HH-MM_description.yaml"  # the file from step 1
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
Handoff created! Outcome marked as [OUTCOME].

Resume in a new session with:
/resume_handoff path/to/handoff.yaml
```

If step 3 refreshed an artifact, name it and give the URL — the user's bookmark is unchanged, so
say what moved on the page rather than re-pasting the link as if it were new.

---
##.  Additional Notes & Instructions
- **more information, not less**. This is a guideline that defines the minimum of what a handoff should be. Always feel free to include more information if necessary.
- **be thorough and precise**. include both top-level objectives, and lower-level details as necessary.
- **avoid excessive code snippets**. While a brief snippet to describe some key change is important, avoid large code blocks or diffs; do not include one unless it's necessary (e.g. pertains to an error you're debugging). Prefer using `/path/to/file.ext:line` references that an agent can follow later when it's ready, e.g. `packages/dashboard/src/app/dashboard/page.tsx:12-24`
