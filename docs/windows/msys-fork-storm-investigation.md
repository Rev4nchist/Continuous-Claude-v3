# MSYS fork storm: full investigation record

Moved verbatim from `.claude/rules-src/windows-platform.md` on 2026-09-23 (Opus 5.5 eval, P19).
That rule is loaded into every session; this history was 17% of all always-loaded rule bytes.
The rule keeps the operational summary. Everything below is the evidence trail it rests on.

## The MSYS "fork storm" — use `git-safe.ps1` for commits and pushes [H:9]

Git for Windows runs every hook through its bundled MSYS shell. MSYS builds its
mount table in shared memory exactly once per cohort of processes, guarded by a
spinlock in `shared.cc` that **gives up after 15 seconds**. If two MSYS processes
cold-start at roughly the same time and the first is slow inside that critical
section, the second enters anyway, `mountinfo.init()` runs twice, and every
process in that cohort dies:

```
*** fatal error - add_item ("\??\C:\...\Git", "/", ...) failed, errno 1
```

exiting `0xC0000005` (3221225477). The crash is in DLL init, **before** bash reads
the hook script — so a hook cannot retry itself, and git treats the dead
pre-commit hook as a veto and aborts the commit. Measured 2026-07-26: five commits
and one push failed this way in one session, each succeeding later unchanged.

**Rule: run commits and pushes through the wrapper.**

```
pwsh -File scripts/git-safe.ps1 -C <repo> commit -F <msgfile>
```

It retries ONLY on the MSYS signature (verified: a genuine git failure returns in
~1s with its real exit code, never retried), backs off ~6s, bounds at 4 attempts,
and logs every occurrence to `~/.claude/logs/msys-crash.jsonl` with the live
bash/node process counts. Read-only git (`status`, `log`, `rev-parse`) does not
need it — those rarely fire hooks.

**Ruled out as causes, so don't re-chase them:** forced ASLR (all mitigations
`NOTSET`), competing MSYS runtimes (one `msys-2.0.dll` 3.5.7, one git install), and
Claude Code's own hooks (**0 of 146 invoke bash** — they are all node/python). The
username contains a period, which some upstream reports blame, but that cannot be
the cause here: bash succeeds the overwhelming majority of the time and a
fundamental incompatibility would not be intermittent.

**CORRECTION (2026-07-29): "running AV filter drivers (none)" was WRONG — put it
back on the list.** Two Microsoft security minifilters are running and intercepting
file I/O on every volume: `MsSecFlt` (Defender for Endpoint sensor, altitude 385600)
and `WdFilter`. Verified unelevated via `Get-CimInstance Win32_SystemDriver` — both
`State=Running`. What *is* true is the narrower claim: the third-party filters
(`rtp1`/`rtp2`/`BdSentry`, iolo) are gone from the registry, driver list and disk
after the uninstall. Those are different statements, and the file asserted the
stronger one. `fltmc filters` needs elevation, so from an ordinary shell **record
this as unchecked rather than empty** — an access-denied read is not a zero.

**Claude Code's hooks don't invoke bash, but this repo's GIT hooks do — nested.**
Read the ruled-out line above carefully: it is about `.claude/hooks/`, and it
invites the wrong conclusion that "hooks aren't involved". A single `git commit`
here spawns `pre-commit` (bash) → a **nested** `bash scripts/precommit-build-guard.sh`
→ a `grep`×3 / `sed` MSYS pipeline, then `post-commit` (bash) → a **detached,
long-lived** `nohup bash sync-to-active.sh --changed &`. Measured: 3 concurrent
bash from the pre-commit chain alone. That is precisely the shape recorded below as
reproducing the crash — a long-lived MSYS process holding a cohort open while
short-lived nested cold-starts arrive into it — and this repo manufactures it on
every commit, for free, without anyone running `repro.ps1`.

**CORRECTION (2026-07-26): it IS reproducible — the earlier burst shape was wrong.**
A burst of N identical bash processes is not the failing shape and stayed stubbornly
bimodal (48/48 failed, then 64/64 passed, then 16 clean bursts). The shape that
reproduces is the one real hooks actually create: **a long-lived MSYS process holding
a cohort open while short-lived NESTED bash cold-starts arrive into it.** Reproduced
twice on the first attempt, from a plain `bash -c "bash scripts/sync-to-active.sh --changed"`
launched alongside a sampler. Harness: `scripts/msys/repro.ps1`.

**The crash is not the worst outcome — the hang is.** The documented `add_item` fatal
error is loud, exits immediately, and `git-safe.ps1` already retries it. What the repro
surfaced is different and unlogged: affected bash processes **block instead of dying**,
at ~0 CPU, and never exit. One trial that should have created ~9 processes left **51
live**, 46 of them descendants nothing had a handle on, still present ten minutes later.
`Stop-Process` on the tracked pids sails straight past the descendants — the same
spawn-tree leak already recorded for `spawnSync`.

**CORRECTION (2026-08-17): the recovery guidance below was wrong twice, and both
errors could destroy a peer session's work. Do NOT reach for it reflexively.**

- **`taskkill /T /F` is NOT the safe primitive.** `/T` resolves the tree by PPID **at
  kill time**, and PIDs are reused on this box, so `/T` can kill a process that merely
  inherited a recycled parent id. The safe form is: kill **leaves first, by explicit
  PID**, revalidating `CreationDate` immediately before each kill.
- **`reap.ps1`'s selection is both blind and non-discriminating.** It enumerates with
  `Get-Process bash` (`reap.ps1:36`, `:76`), so it never sees `sh.exe`, `grep.exe` or
  any other MSYS binary — it printed "no bash processes running" while two `sh.exe`
  drove a 31-minute `docker compose build`. And its premise, "a bash doing real work
  accumulates CPU", is false here: the dominant shape is a shell **waiting** on a child
  that does the work (measured: 0.03s CPU over 463s while its child worked). CPU cannot
  separate stuck from working, so "a bash doing real work is never touched" does not
  hold. A read-only simulation on 2026-08-17 found `-Force` would have tree-killed two
  live peer-session shells.
- **Retired 2026-11-05.** `reap.ps1` is now list-only. The `-Force` switch, the kill loop and
  the `Stop-ProcessTree` dot-source are removed, and passing `-Force` is an unknown-parameter
  error. The `repro.ps1` circuit breaker no longer calls it. It stops only the process trees that
  `repro.ps1` started. Rule: `reap.ps1` only lists. Kill by hand only after you prove the PID
  owner by its parent chain.

> **Superseded example (note added 2026-09-23).** The census command below is kept as recorded.
> Do not copy it: it hard-codes one profile path and has no trailing separator, so a sibling such
> as `...\GitHubDesktop\` would match. Use the current version in
> `.claude/rules-src/windows-platform.md`, which resolves the active Git root with a trailing `\`.

**Recovery, revised.** `pwsh -File scripts/msys/reap.ps1` is safe to execute. It only lists
and never kills (since 2026-11-05 it has no `-Force`). Read its output as incomplete, never as
an inventory. Census by path instead, which sees every MSYS binary:

```powershell
$g='C:\Users\david.hayes\AppData\Local\Programs\Git'
Get-CimInstance Win32_Process | ? { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($g,'OrdinalIgnoreCase') } |
  Select ProcessId,ParentProcessId,Name,CreationDate,CommandLine | Format-List
```

Reclaim ONLY a leaf orphan: no children of any kind, no `CreationDate`-validated
ancestor reaching a live `claude`/`pwsh`/`node`, age over 600s, and two samples 60s
apart agreeing. If any candidate has a live child, that is an absolute veto.

**Not yet established, do not assume:** that this hang is what broke the Bash *tool* in
the 2026-07-26 session. The Bash tool was probed three times during the storm, including
with 48 stuck processes alive, and worked every time. The stuck-process pile-up and the
Bash-tool failure are so far two separate observations, not one causal chain. The
warm-keeper mitigation is still untested — but now there is a repro to test it against,
which is what the earlier zero-failures-in-both-arms A/B lacked.

**Crashes come in WINDOWS, and the load hypothesis is still open (2026-07-29).** Across
18 commits in one day: every `git-safe` commit crashed between 08:28 and 11:29, then
**five consecutive commits 11:33–12:21 crashed zero times**, then crashing resumed from
14:30. Concurrency was not visibly different across those windows, so "two processes
happened to collide" does not explain the clustering on its own. The live candidate is
that the 15-second `shared.cc` spinlock is only *reachable* when the machine is slow
inside the critical section, i.e. **degraded process-spawn latency manufactures the
race** — consistent with the separately-measured spawn pathology on this box (p50 814ms
and later 2,167ms against a healthy 30–80ms).

**CORRECTION (2026-08-17): the load hypothesis is UNSUPPORTED, and the instrument that
was supposed to test it was measuring the wrong binary.**

- **All 38 crash rows carrying `node_spawn_ms` sit at 42–81 ms — inside the healthy
  30–80 ms band.** Every crash for which spawn latency was recorded happened while
  spawn latency was normal. The "degraded latency manufactures the race" story above is
  not supported by the only data that can speak to it.
- **`spawn-latency.ps1` was probing WSL, not MSYS.** Its `bash -c true` probe resolved
  `bash` from PATH, and on this machine `(Get-Command bash).Source` is
  `C:\WINDOWS\system32\bash.exe` — the WSL launcher, which is not MSYS, never touches
  the `shared.cc` mount table, and cannot exhibit the fork storm. So **every HEALTHY
  verdict this script printed before 2026-08-17 was meaningless**, including the ones
  that made the load hypothesis look testable. Fixed the same day: it now resolves Git
  bash by full path, prints the path it chose, and hard-fails if Git bash is absent.

Measure it, don't assume it: `pwsh -File scripts/msys/spawn-latency.ps1`. Strictly
serial, no bursts, **safe to run at any time including inside a crash window** — unlike
`repro.ps1`, which deliberately storms the machine. It samples `node`, `git-bash` and
`git rev-parse` cold starts and prints a HEALTHY/ELEVATED/DEGRADED verdict against the
30–80ms reference. **Confirm the `git bash:` line names a path under `Git\bin` before
believing any verdict.** Note also that a "cold" sample is only cold when NO MSYS
process is alive — the cohort caches `user_info` in shared memory, so a reading taken
while any bash/sh/grep is running measures the warm path and answers nothing.

Two measurement traps this lane already fell into, both worth avoiding:

- **`msys-crash.jsonl` only sees `git-safe`-wrapped git.** Every Bash-*tool* crash is
  invisible to it — on 2026-07-29 that included two `claude -p` launches fired in
  parallel which both died instantly, the single most concurrency-shaped evidence of
  the day, recorded nowhere. A concurrency hypothesis tested only against a log that
  cannot see the concurrent cases is unfalsifiable. Weigh the log accordingly.
- **`bash_alive` in that log is sampled AFTER the failing command returns**, so a
  crashed cohort has already died and it reads 0. It is not a count at crash time, and
  the many `bash_alive=0` failure rows are not evidence against a concurrency cause.

**FIXED 2026-08-19 — the blindness above is closed GOING FORWARD.** Both traps were
the reason every MSYS hypothesis stayed unfalsifiable, so they were fixed rather than
documented again:

- **`~/.claude/logs/msys-events.jsonl` is the unified log.** Every lane writes to it
  with a `lane` field: the new `msys-crash-capture` PostToolUse hook covers the
  Bash *tool* lane (verified 2026-08-19: that lane runs real MSYS — `uname -a` returns
  `MINGW64_NT-10.0-26200 ... 3.5.7 ... Msys`, not WSL), and `git-safe.ps1` mirrors its
  crash rows there too. `msys-crash.jsonl` still exists for backward compatibility and
  is still git-only; prefer the unified log for any analysis.
  The live file is capped at 5 MiB (`MSYS_EVENT_LOG_MAX_BYTES`) and rotates to
  `.1`, keeping one previous generation — the denominator makes it a row per
  Bash/PowerShell call, and an uncapped telemetry file already cost five days
  here once as a single 516 MiB Braintrust spool record.
- **It carries a DENOMINATOR.** Both lanes write `ok:1` rows on success. Without a call
  count you cannot tell a cluster of crashes from a cluster of activity, which is
  precisely how "crashes come in windows" survived unchallenged. Compute a RATE, never
  a count.
- Timestamps are UTC ISO in both lanes, deliberately — a naive sort over mixed
  local-with-offset and UTC interleaves them wrongly, and time-clustering is the whole
  question this log exists to answer.

**The `msys_alive_after` caveat still stands and is not fixable from a PostToolUse
seam:** it is sampled after the cohort has already died, so it is a LOWER BOUND, never
a count at crash time. Do not read a low value as evidence against a concurrency cause.

**Nothing here is retrospective.** These rows begin 2026-08-19. Any conclusion about
crash frequency or clustering BEFORE that date still rests on the blind git-only log.

`git-safe.ps1` now also records `node_spawn_ms` (one sample, crash path only) and
`hooks_expected` per crash, so the next occurrence can settle both questions from its
own row instead of from a probe run after the window has closed.

⚠️ `repro.ps1` deliberately storms the machine. It has a circuit breaker (`-MaxBashAlive`,
default 25) that aborts and reaps; the first two versions did not, and both left the
machine with dozens of blocked processes.
