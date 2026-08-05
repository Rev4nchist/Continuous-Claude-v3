# roadmap-sync.jsonl — ROADMAP.md guarded-write audit trail

One row per `writeRoadmapGuarded` (and follow-up `appendRoadmapAuditRecord`) call from any of the three hooks that touch `ROADMAP.md`: `post-plan-roadmap.ts`, `git-commit-roadmap.ts`, `prd-roadmap-sync.ts`. The `.jsonl` is gitignored (`.claude/logs/*.jsonl`) — machine-local runtime data; this README is committed.

Plan: `i-was-working-in-composed-manatee` (approved, premortemed Claude+Codex, 2026-08-05), section 5. Built to close a real gap: no `.bak`, no audit log for any ROADMAP write existed before this, which is why the recurring clobber only ever surfaced as anecdote rather than evidence.

## If a commit you expected is missing from `## Completed`

Check these before assuming the writer is broken — all four are real, and three
are still live:

1. **The active mirror lags the repo.** The hook that actually runs is
   `~/.claude/hooks/dist/*.mjs`, not the repo copy. Forward sync fires on
   *post-commit*, so a rebuild only reaches the live hook on the NEXT commit —
   the commit that ships a hook fix runs the OLD hook. Verify with a file hash
   before concluding anything about hook logic.
2. **`isDuplicateEntry` matches on a 30-char description prefix** as a plain
   substring of any `- [x]` line, so short descriptions collide easily (a commit
   described as "probe" matches any completed entry containing "probe"). Fixed
   only in the sense of being understood — the check is unchanged.
3. **`chore`, `style` and `ci` are in `SKIP_TYPES`** and never recorded. The
   hook's own follow-on commit uses `chore(roadmap):` deliberately, as one of the
   three recursion barriers. Useful side effect: a `chore:` commit is the only
   way to land a ROADMAP.md edit without the hook appending another line to it.

### `CCV3_ROADMAP_AUTOCOMMIT=0` (set 2026-08-05, both settings.json copies)

The paired `chore(roadmap): record ...` commit is OFF. The hook still writes
ROADMAP.md and still appends an audit record — `outcome: written`,
`committed: false`, `reason: autocommit_disabled`.

**It took effect immediately, not at the next session start.** A commit message
in `97220ca` claims otherwise; that was wrong. The hook reads `process.env` per
invocation and the harness passes the settings `env` block through to hook
processes without a restart.

Consequence, and it is the real cost of the setting: **ROADMAP.md is now left
uncommitted after every conventional commit**, in a working tree three sessions
share. It rides along in whoever runs `git add` next. Tolerable only because
writes are append-only behind a deletion-free guard. To close a session with a
clean tree, land the pending ROADMAP line under a `chore:` type — `SKIP_TYPES`
means the hook adds nothing on top of it.
4. **Two path/parsing gaps, CLOSED 2026-08-05 (`ed9b825`)** — `cd /c/... && git
   commit` was rejected as foreign (`path.resolve` turned `/c/` into a directory
   named `c`), and `git -C <path> commit` was not recognised as a commit at all.
   If you see either symptom again, `normalizeShellPath` /
   `parseGitCommitInvocations` in `shared/roadmap-sync-guards.ts` are the code to
   look at, and `roadmap-sync-guards-invocation.test.ts` is the guard.
5. **The hook was registered on the `Bash` matcher only, CLOSED 2026-08-05** —
   so a commit made through the **PowerShell tool** never fired it. That is not a
   corner case: `.claude/rules/windows-platform.md` tells you to prefer the
   PowerShell tool for git precisely because the Bash tool hangs on git/network
   ops, so the recommended way to commit was the one way that went unrecorded.
   Caught in the wild by this very log — a concurrent session's `fix(github)`
   commit produced ZERO records while Bash-tool commits produced two each.
   Matcher is now `Bash|PowerShell` in **both** settings.json copies (repo and
   `~/.claude`; that file is deliberately NOT synced, so it must be edited in
   both). The tool name was confirmed as the literal string `PowerShell` from a
   session transcript before editing — guessing a matcher gives you one that
   silently matches nothing, which is the failure this whole list documents.
6. **A commit made through `scripts/git-safe.ps1` is invisible to the hook.**
   OPEN as of 2026-08-05. `isGitCommitCommand` parses the *command string* and
   `parseGitCommitInvocations` requires a literal `git` token, or a token whose
   path ends in `git`/`git.exe` (`roadmap-sync-guards.ts:180`). The command
   `pwsh -File scripts/git-safe.ps1 -C <repo> commit -F <msg>` contains neither:
   `scripts/git-safe.ps1` ends in `git-safe.ps1`, not `git`. So the hook returns
   before it ever reaches `writeRoadmapGuarded`, and writes no record at all —
   not even a `skipped` one.

   This is the same shape as item 5 and just as load-bearing.
   `.claude/rules/windows-platform.md` mandates `git-safe.ps1` for commits and
   pushes because of the MSYS fork storm, so once again **the recommended way to
   commit is a way that goes unrecorded**.

   **Status: verified by code reading, NOT isolated by a live test.** Every
   commit available to test it with was also blocked by item 7 below, so no
   experiment has yet shown this gap failing on its own. It is real — read
   `roadmap-sync-guards.ts:180` — but do not cite a live commit as proof of it.

7. **The matcher fix was INERT: the hook rejected PowerShell at runtime.
   CLOSED 2026-08-05.** This is the actual reason item 5's fix changed nothing.
   `git-commit-roadmap`'s `main()` opened with
   `if (data.tool_name !== 'Bash') return;`. Widening the settings.json matcher
   to `Bash|PowerShell` let the event reach the hook; that line then dropped it.
   Two gates, one widened, one forgotten, symptom unmoved — which read exactly
   like "the matcher string must be wrong" and cost a whole extra session.

   **Three siblings had the identical defect**, all registered on a matcher
   naming PowerShell and all rejecting it at runtime: `roadmap-completion`
   (`=== 'Bash'`), `ralph-monitor`, `test-run-tracker`. Every hook in the repo
   whose matcher mentions PowerShell was affected. All four now gate on a
   `COMMAND_TOOLS` set.

   Guard: `__tests__/hook-matcher-runtime-consistency.test.ts` reads
   settings.json, and for any hook registered on a PowerShell matcher asserts
   its source both names the tool AND carries no `tool_name === 'Bash'`-style
   narrow gate. Demonstrated failing on purpose against the pre-fix tree: 7
   violations across the 4 hooks, 0 after. The second rule exists because the
   first one alone MISSED the primary offender — `git-commit-roadmap.ts` already
   mentioned "PowerShell" in a prose comment while still rejecting it.

   **PROVEN LIVE 2026-08-05**, session 47e656a2, after two failed attempts that
   isolated the cause. Commit `5ba820d`, a bare `git commit` through the
   PowerShell tool against a freshly synced dist, produced two records both
   carrying `"tool":"PowerShell"` plus the paired `chore(roadmap)` commit
   `67f0f3f`. The `tool` field is what makes this self-evidencing: the log names
   the tool, so the proof does not rest on anyone remembering what they ran.

### The general lesson

Three of these seven items are the same mistake at different layers: a fix
applied at one gate while another gate, downstream and invisible, kept the old
behaviour. Item 4 was path parsing, item 5 was registration, item 7 was the
runtime check. **When a fix does not move the symptom, look for a second gate
before doubting the first fix.** Widen a registration and its runtime check in
the same change.

## Schema (one JSON object per line)

```json
{
  "ts": "2026-08-05T18:42:00Z",       // ISO 8601 UTC timestamp
  "hook": "post-plan-roadmap",         // which hook called writeRoadmapGuarded
  "tool": "PowerShell",                // triggering tool_name; "unknown" if a caller omits it
  "project_dir": "/path/to/project",
  "roadmap_path": "/path/to/project/ROADMAP.md",
  "outcome": "written" | "noop" | "skipped" | "failed",
  "reason": "deletion_guard" | "catastrophic_rewrite" | "lock_timeout" | "concurrent_modification" | "write_failed" | undefined,
  "before_sha256": "0123456789abcdef",  // 16-hex prefix of sha256(before)
  "after_sha256": "fedcba9876543210",   // 16-hex prefix of sha256(after)
  "before_lines": 335,
  "after_lines": 340,
  "line_delta": 5,
  "before_bytes": 12345,
  "after_bytes": 12489,
  "bytes_delta": 144,
  "ops": [{ "label": "session-insert", "lines_removed": 0, "lines_added": 5 }],
  "refused_deletions": ["- bullet that would have been dropped"],
  "bak_path": "/path/to/project/ROADMAP.md.bak",
  "bak_error": null,
  "session_id": "abc123-...",
  "committed": true,
  "commit_hash": "deadbeef7",
  "wait_ms": 12,
  "write_ms": 3
}
```

Every field beyond `ts`/`hook`/`project_dir`/`roadmap_path`/`outcome`/`before_*`/`after_*`/`line_delta`/`bytes_delta` is conditional on the outcome — see below.

## Outcome / reason reference

| outcome | reason | meaning |
|---|---|---|
| `noop` | — | `after === before`. No write, no `.bak`. Still logged so a hook firing with nothing to add is visible. |
| `skipped` | `deletion_guard` | **The real guard.** A line present in `before` and absent from `after` was not in the caller's `allowedDeletions` list. The write was refused outright; `refused_deletions` names the offending lines (capped at 20). This is what makes append-only *enforced* rather than merely intended — it is the guard that would have caught the 24-insertion/19-deletion live clobber this plan fixes (net +5 lines, so a shrink-floor check could never have caught it; a line-vanishing check catches it on gate one). |
| `skipped` | `catastrophic_rewrite` | Only reachable when the caller passed `allowFullRewrite: true` (the legitimate fresh-file path, which deliberately skips the deletion-guard above). Refused because `before` was non-empty and `after` was empty or under 25% of `before`'s line count. |
| `skipped` | `lock_timeout` | `mutateStateWithLock`'s `acquireLockSync` did not get the lock inside its timeout. `wait_ms` records how long it waited. No content was lost — the write simply didn't happen this turn. |
| `skipped` | `concurrent_modification` | The lock WAS acquired, but the file's content had changed since `before` was captured (another writer got there first). This is the one reason that should be **surfaced to the calling session**, not just logged — a silently dropped planning entry is exactly the defect class this plan exists to close. |
| `skipped` | `write_failed` | Lock acquired, pre-image matched, but the underlying read or atomic write still failed (e.g. the file became unreadable, or the write threw). |
| `written` | — | The write happened. `bak_path` holds where the pre-image was saved (best-effort — see `bak_error`); `wait_ms`/`write_ms` come from the lock/write timings when the real (non-test) write path was used. |
| `failed` | (caller-defined) | Reserved for follow-up records appended via `appendRoadmapAuditRecord` — e.g. `git-commit-roadmap` recording that the ROADMAP write succeeded but the follow-on `git commit` failed. `writeRoadmapGuarded` itself never returns this outcome. |

`lock_timeout`, `concurrent_modification`, and `write_failed` are kept as three distinct reasons rather than one generic "skipped" bucket precisely because they call for different next actions: a lock timeout is retry-later noise, a concurrent modification means a human's hand-edit just won a race and needs acknowledging, and a write failure needs investigating.

## `.bak`

Single generation (`ROADMAP.md.bak`, overwritten on every guarded write), holding the **before** content — not the after. A backup failure never blocks the write (`bak_error` records the message instead). Because it's single-generation and hand edits to `ROADMAP.md` are routinely uncommitted, `.bak` + git do **not** guarantee recovery two writes deep — it is the second line of defense, not the first; the deletion guard above is the first.

## No rotation

Deliberate. Three hooks append concurrently, and an unsynchronised rename at a rotation boundary can lose records — worse than a large file. A record is roughly 400 bytes; even 100 writes/day is on the order of 15 MB/year. Past 2 MB the intended behavior is to keep appending and let the caller emit a one-time advisory suggesting a manual sweep — this module does not delete or truncate the log itself.

## Query patterns

### Every refused write (the guard actually firing)
```bash
jq -c 'select(.outcome == "skipped" and .reason == "deletion_guard")' .claude/logs/roadmap-sync.jsonl
```

### Concurrent-modification drops (the case that needs surfacing to a session)
```bash
jq -c 'select(.reason == "concurrent_modification")' .claude/logs/roadmap-sync.jsonl
```

### Outcomes by hook
```bash
jq -s 'group_by(.hook) | map({hook: .[0].hook, outcomes: group_by(.outcome) | map({outcome: .[0].outcome, n: length})})' .claude/logs/roadmap-sync.jsonl
```

### Lock-wait distribution (fork-storm / spawn-latency correlation)
```bash
jq -s 'map(select(.wait_ms != null) | .wait_ms) | sort' .claude/logs/roadmap-sync.jsonl
```

## Related

- Module: `.claude/hooks/src/shared/roadmap-audit.ts` (`writeRoadmapGuarded`, `appendRoadmapAuditRecord`)
- Underlying primitive: `.claude/hooks/src/shared/atomic-write.ts` (`mutateStateWithLock`, `MutateLockOptions`)
- Tests: `.claude/hooks/src/__tests__/roadmap-audit.test.ts`
- Plan: `i-was-working-in-composed-manatee` (§5 "New `shared/roadmap-audit.ts`")
- Sibling READMEs: `.claude/logs/codex-lift.README.md`, `.claude/logs/grok-worker.README.md`
