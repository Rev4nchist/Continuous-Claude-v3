# machine-config — an INERT capture of user-scope config

**Nothing in this directory is loaded by anything.** It is a snapshot, kept in
git so that the live `~/.claude` tree is reproducible from committed state.

## Why it exists

The repair-vs-rebuild verification (Q1, 2026-07-28) asked one decisive question:
*if `~/.claude` were deleted today, could it be rebuilt from the repo?* The
answer was yes for all 85 hook registrations and 18/18 live-only hooks — but
**~0.2 MB was genuinely uncommitted**, and it is captured here.

| capture | source | what it is |
|---|---|---|
| `commands/` (inert snapshot) | was `~/.claude/commands/` | old capture. Live commands now sync from `.claude/commands-src/` |
| `mcp.json` | `~/.mcp.json` | 7 MCP servers |
| `settings.local.json` | `~/.claude/settings.local.json` | user-scope permissions, incl. the `rm`/`neonctl` deny rules |

## Why an inert path and not the "natural" one

Each of the three would have caused a live behaviour change if committed where
it appears to belong. That is the whole reason for this directory.

- **`.claude/commands-src/`** — the live slash-command source. Forward sync
  copies it to `~/.claude/commands/`. The source name is not `commands/`
  because a project's `.claude/commands/` loads at project scope on top of
  the user-scope copies. Commands do sync. This directory's `commands/`
  folder is only the old inert snapshot.
- **`.mcp.json`** — the repo already tracks a 23-byte stub at the root.
  Overwriting it with the 7-server user config would add 7 **project-scoped**
  MCP servers duplicating user scope.
- **`.claude/settings.local.json`** — the repo already tracks a different,
  2,388-byte **project-scoped** file at that path. The live one is user-scope,
  315 bytes, and serves a different purpose. Same basename, different file.

## `compact.md.bak` is force-added, on purpose

`.gitignore:162` excludes `*.bak`, so the first capture committed **58 of 59**
files and looked complete. The missing one was `compact.md.bak` — and there is
**no `compact.md`**. The `.bak` is the ONLY copy of that command's 1,451 bytes,
so the ignore rule would have silently dropped the entire file from a capture
whose whole purpose is recoverability.

It is therefore tracked with `git add -f`, under its exact original name so a
restore is a straight copy back. Checked at the same time: it is the only
`.bak`-without-a-base in the tree.

This is the house defect in miniature — a count that looked right (58 files
committed, no error, exit 0) while the one thing that could not be regenerated
was being dropped by a rule nobody was thinking about. **If you refresh this
capture, re-check the file count against the source directory**, and do not
assume a clean `git add` means everything arrived.

## Secret hygiene — checked, not assumed

`mcp.json` was scanned before it was committed. All three secret-shaped values
are **`${VAR}` placeholders**, not literals:

```
github        GITHUB_PERSONAL_ACCESS_TOKEN   ${GITHUB_TOKEN}
nia           NIA_API_KEY                    ${NIA_API_KEY}
ai-reporting  NOTION_TOKEN                   ${NOTION_TOKEN}
```

The only literal values are `NODE_TLS_REJECT_UNAUTHORIZED=0`,
`MCP_TRANSPORT=stdio`, and a public `NIA_API_URL`. `commands/` scanned clean
(0 hits for `sk-*`, `ghp_`, `xox*-`, private-key headers, inline api keys).

Worth recording *how* that was established: the first scan reported
`LITERAL VALUE -> looks like a real secret` for all three. That was **wrong** —
the placeholder regex had been mangled by shell escaping, so `${GITHUB_TOKEN}`
was misread as a literal. Re-run from a file rather than an inline `-e` string,
it classified correctly. A broken pattern yields a confident wrong verdict; that
cuts both ways, and here it would have blocked a safe commit rather than allowed
an unsafe one.

## Refreshing it

This is a snapshot with no expiry and nothing that ages it out. Re-run after any
deliberate change to user-scope commands, MCP servers, or local permissions:

```
Copy-Item C:\Users\david.hayes\.claude\commands\* .claude\machine-config\commands\ -Recurse -Force
Copy-Item C:\Users\david.hayes\.mcp.json .claude\machine-config\mcp.json -Force
Copy-Item C:\Users\david.hayes\.claude\settings.local.json .claude\machine-config\settings.local.json -Force
```

**Restoring is the reverse copy, and it is deliberate, never automatic** — an
automatic restore in this direction is exactly the clobbering reverse-sync that
was root-caused and disabled on 2026-06-01 (`git-sync-workflow.md`).
