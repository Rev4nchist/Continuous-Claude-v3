# Opting a ROADMAP.md out of the sync hooks

Added 2026-09-02.

## The marker

Put this anywhere in a project's `ROADMAP.md`:

```markdown
<!-- roadmap-sync: manual -->
```

From then on, every ROADMAP-writing hook leaves that file alone.

## What still happens

The opt-out stops **writes**, not **observability**. With the marker in place:

- The audit row is still appended to `.claude/logs/roadmap-sync.jsonl`, with
  `outcome: "skipped"` and `reason: "opt_out_manual"`. An opt-out you cannot
  see is indistinguishable from a hook that quietly broke.
- The session still gets its advisory context, and planning decisions are still
  stored to archival memory.
- Only the file on disk is untouched.

## Which hooks honour it

All of them, by construction. The check lives in `writeRoadmapGuarded`
(`.claude/hooks/src/shared/roadmap-audit.ts`), which is the single function
every ROADMAP writer routes through:

| Hook | Writes ROADMAP.md | Honours the marker |
|---|---|---|
| `post-plan-roadmap` | via `writeRoadmapGuarded` | yes |
| `git-commit-roadmap` | via `writeRoadmapGuarded` | yes |
| `prd-roadmap-sync` | via `writeRoadmapGuarded` | yes |
| `roadmap-completion` | never — advisory only | n/a |
| `roadmap-reconcile` | never — advisory only | n/a |

A future writer inherits the opt-out by using the guard, rather than by
remembering to re-implement the check.

## Matching rules

The pattern is `/<!--\s*roadmap-sync\s*:\s*manual\s*-->/i`, so all of these work:

```markdown
<!-- roadmap-sync: manual -->
<!--roadmap-sync:manual-->
<!--   ROADMAP-SYNC:   MANUAL   -->
```

Prose that merely mentions the phrase does **not** trigger it — the real
`<!-- ... -->` delimiters are required, so a ROADMAP discussing
"a roadmap-sync manual mode" keeps syncing normally.

## When you probably want it

When the ROADMAP is a hand-maintained document with its own structure and
voice, and the appended entries are something you delete every week.

If you only object to the *volume* of what was appended, note that as of
2026-09-02 the appended block is already just a header line plus a
`**Plan:**` pointer — the generated Summary / Key Decisions / Implementation /
Files / Verification stanzas are gone. Try the default before opting out.

## Turning it back on

Delete the marker line. Nothing else is cached.

## Where the pre-image goes

Unrelated to the opt-out, but often asked at the same time: the guarded write
saves the pre-change ROADMAP to
`~/.claude/state/roadmap-bak/<project>-<hash8>/<timestamp>.md`, keeping the
newest 10 per project. It used to be written to `<roadmapPath>.bak` inside the
project, which put an untracked file in `git status` after every plan approval.
The real path is recorded in each audit row's `bak_path`.
