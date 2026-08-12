# TLDR: make the saving real, or stop paying for it

## Context

Yesterday's investigation (`32b6b88`) concluded TLDR was "a real ratio and a
mostly-illusory saving". **That conclusion was based on an undercount and is now
revised.** My transcript scan used a non-recursive `readdirSync`, so it read 512
top-level transcripts and missed **548 subagent transcripts**. The enforcer
fires **138 times, not 27 — and 77% of those are in subagents**, where I never
looked.

With the full corpus, TLDR is **already net-positive even in its broken state**:
~+174k tokens est across 3 months. So the answer to "is it worth it" is yes —
but almost none of that comes from the parts that are broken, and the machinery
around it is expensive enough to erase the gain on a bad day.

Three things are true at once, and the plan follows from them:

1. **The saving is real but concentrated.** Net token effect is monotonic in
   file size. Files under 5KB *lose* ~10k tokens; files over 50KB win 5-for-5.
   Nearly half the total saving comes from five files.
2. **The cost is a Windows transport accident, not an inherent price.**
   `queryDaemonSync` has no sync socket API in Node, so on Windows it **spawns
   PowerShell per daemon query** (`daemon-client.ts:559`). That is the ~1s
   floor. `tldr-context-inject` makes up to 3 entry-point queries × layers →
   **63s per Task call**.
3. **Liveness is measured by the wrong proxy — again.** `_is_daemon_alive`
   (site-packages `tldr/daemon/startup.py:130`) is PID-file-lock + process
   existence, and its docstring says outright *"No socket connectivity check
   needed."* `_is_socket_connectable` is `AF_UNIX` and dead code on Windows. So
   a daemon whose listener has died reports alive forever, blocks its own
   replacement from starting, and the client burns 31s failing to reach it.

That third one is the same defect this lineage keeps finding: `last_heartbeat`
measuring the human, `.tldr/status` stamped at startup, `/health-check` reading
only `command`. Liveness must be a probe, never an artifact.

**Intended outcome:** TLDR intercepts only where it measurably wins, costs
milliseconds instead of seconds, and can never make things worse when the daemon
is down. Plus a ledger so the savings claim is continuously measured rather than
asserted — the `95%` in `.claude/rules/tldr-cli.md` had no measurement behind it
for its entire life.

**Decisions taken:** hook-side only (no edits outside this repo — they'd be lost
on pip reinstall); router stops denying but keeps routing; threshold 8KB.

---

## Changes

### 1. Fail open — the single most important change
`.claude/hooks/src/tldr-read-enforcer.ts`

Today, when the daemon is unreachable the hook **still denies**, after 31.6s,
returning one function name for a 12.7KB file. That is strictly worse than not
existing. It must be impossible for this hook to deny on a degraded result.

- Probe reachability with a **direct TCP connect** (short timeout, ~250ms) —
  **NOT `pingDaemon`**. `pingDaemon` → `queryDaemon` → `isDaemonReachable` →
  `tryStartDaemon`, which is the exact slow path the fail-open exists to avoid.
  **A PreToolUse hook must never start a daemon.** Unreachable →
  `console.log('{}')` immediately, no TLDR work attempted.
- **Negative cache** the unreachable verdict briefly (file in `os.tmpdir()`,
  ~10s TTL) so that N parallel subagents don't each pay the probe, and so a
  zombie daemon can't be stampeded by concurrent remediation attempts.
- Add a **content-sufficiency floor**. Symbol count alone is a weak proxy
  (Codex): a small dense file passes, a large file of irrelevant symbols fails.
  Require **both** a minimum injected size **and** — when a `searchContext`
  target exists — that the summary actually *contains* that target. Otherwise
  allow the read. The existing `results.length > 3` check (line 358) passes a
  header-only payload; that is how the one-function-name response got emitted.
- Wrap the whole body so any throw allows the read. The existing `main().catch`
  does this; the internal `try/catch` in `getTldrContext` returning `null` is
  already correct — the gap is the *degraded-but-non-null* path.

### 2. Kill the PowerShell-spawn-per-query tax
`.claude/hooks/src/tldr-read-enforcer.ts` (7 call sites)

`main()` is **already async** and the async equivalents already exist. Replace
each `queryDaemonSync` with its existing wrapper — no new code:

| replace | with |
|---|---|
| `queryDaemonSync({cmd:'extract'…})` | `extractDaemon()` (`:687`) |
| `queryDaemonSync({cmd:'context'…})` | `contextDaemon()` (`:910`) |
| `queryDaemonSync({cmd:'cfg'/'dfg'/'slice'…})` | `cfgDaemon()` / `dfgDaemon()` / `sliceDaemon()` (`:743/:765/:789`) |

`queryDaemon` (`:443`) uses a direct `net.Socket`. Leave `queryDaemonSync` in
place for any genuinely sync caller.

**Corrected estimate:** ~1s → **~50ms**, not ~5ms. `queryDaemon` still calls
`isDaemonReachable`, which `spawnSync`s a whole Node process (~45ms). Real but
smaller than first claimed.

**Async exit discipline is mandatory, not optional** (Codex, high). An async
PreToolUse hook that exits before its promise settles emits no JSON — and a
missing/partial payload is handled unpredictably by the runner. Required:
`main().then(...).catch(...)` covering every path, **exactly one** final
`console.log` of the assembled JSON, explicit `process.exitCode`, and no
un-awaited work. Add a test that simulates a delayed daemon response.

Socket framing is **already sound** and does not need redesign: the protocol is
newline-delimited and `JSON.stringify` escapes newlines, so `data.includes('\n')`
implies a complete frame. The residual case is two frames arriving in one chunk
— parse the first frame only rather than `JSON.parse(data.trim())` on the whole
buffer. (Codex rated this high; verified down to low.)

### 3. Retarget to where it wins
`.claude/hooks/src/tldr-read-enforcer.ts:399`

`stats.size < 3000` → `< 8000`. Measured: +183.7k tok across 82 cases vs
+173.8k across 133 — **more saving, 51 fewer interceptions**. Strictly better on
both axes. Put the measured table in a comment so the number is defensible and
re-derivable, not folklore.

**Labelling correction:** the "0–5KB" bucket is really **3–5KB** — files under
3000B were never intercepted under the current policy, so they contribute no
observations. Fix the label wherever the table is reproduced.

Codex rated the threshold change medium-risk for selection bias, arguing 3–8KB
files "were not consistently intercepted". **That is factually wrong** — the
current floor is 3000B, so every 3–8KB read *was* eligible and the 44 cases in
those buckets are direct observations, not inference. The genuine caveat is the
one already in *Known-uncertain*: it is an empirical fit to this repo's size
distribution.

Also fix the deny message (`:487`): *"To read full file anyway, use: `Read
sessions.ts`"* cannot be followed — Read requires an absolute path. Lead with
`offset`/`limit`, which is the bypass that actually works and is what the model
already does in 70% of cases.

### 4. Deregister `tldr-context-inject`
`.claude/settings.json` (and the `~/.claude` mirror via `sync-to-active.sh`)

63s per Task call, returns `{}` every time, and **zero real injections in one
month across every project** — all 6 marker hits were its own source being read.
Remove the registration; leave the source in tree. Also drop the dead
`edit-context-inject.ts`, registered in no settings file at all.

### 5. Router stops denying, keeps routing — and the handshake gets fixed
`.claude/hooks/src/smart-search-router.ts:560` and `:645`

Both deny branches → `console.log('{}')`. The handshake write
(`storeSearchContext`, `:517`) precedes both deny returns, so it survives the
change — **verified**: a probe run that returned `{}` still wrote its context
file. Measured justification for dropping the denies: 0/16 adoption; 481 of 509
queries were already pass-through.

**The handshake itself is a live bug and must be fixed in the same change**
(Codex, high — confirmed, and worse than Codex knew). It is a *single file keyed
by `session_id`* with a 30s TTL:
`${CONTEXT_DIR}/${sessionId}.json`. **Subagents share the parent's
`session_id`** — documented in `RULES.md` as the reason
`ralph-delegation-enforcer` was softened ("cannot distinguish orchestrator from
sub-agents on a shared session_id"). Since **77% of enforcer firings are in
subagents**, parallel subagents are contending for one file right now: agent A's
Grep context is consumed by agent B's unrelated Read, producing a
symbol-targeted summary for the wrong file.

Required, minimum:
- **Exact-path match.** The enforcer must ignore a context whose `target`/
  `definitionLocation` doesn't correspond to the file being read. This alone
  neutralises the cross-talk without redesigning the transport.
- **Consume-once.** Delete the context file after a successful read so a stale
  entry can't be replayed by a second agent inside the TTL.
- Keep the 30s TTL as a backstop, not as the primary defence.

If exact-path match proves awkward, **drop the handshake entirely** and accept
`structure` mode — a wrong targeted summary is worse than a generic correct one.

### 6. Zombie detection, client-side
`.claude/hooks/src/daemon-client.ts` — `tryStartDaemon` (`:358`)

The upstream bug is out of scope by decision, so defend against it here: if the
daemon is unreachable **and** `.tldr/daemon.pid` names a live process, the pid is
stale-but-locked — the replacement will refuse to start. Detect that specific
state, and surface it rather than retrying into a 31s timeout. Given step 1,
the read proceeds normally either way; this only decides whether we attempt a
restart or give up fast.

Do **not** add an automatic `taskkill` of the stale pid in this change. Killing a
process the harness doesn't own needs its own decision, and step 1 already
removes the harm.

**No stampede** (Codex, medium). Parallel subagents will all detect the zombie
at once. Detection must be **single-flight and side-effect-free**: read-only,
shares the §1 negative cache, mutates no status/pid file, and never attempts
remediation from inside a PreToolUse hook. Report the state; let the read
through.

### 8. Fix the timeout units — this is now load-bearing
`.claude/settings.json` (+ `~/.claude` mirror)

Omitted from the first draft; it cannot be. `timeout` is **seconds**
(`docs/hooks/README.md:211`), and these hooks carry `30000` / `5000` — 8.3 hours
and 83 minutes. Today a hook stall is capped only by its own internal logic. If
§2 lands without this, a socket that never settles becomes an **unbounded** hang
on every Read — strictly worse than today's bounded 31s.

Set the three TLDR entries to a real bound (**30**), and treat the wider
"80 of 85 registrations" defect as a separate follow-up rather than expanding
this change.

### 7. Replace the unmeasured claim with a ledger
`.claude/rules/tldr-cli.md`, and extend `scripts/hooks/tldr-savings-probe.mjs`

Delete `95% token savings` as a standing claim. Replace with the measured
break-even table and a pointer to the probes. TLDR already writes
`.tldr/stats/hook_activity.jsonl` (471 records, 3 months, `reads_intercepted`) —
that is a real telemetry sink nobody was reading. Add `bytes_raw` /
`bytes_injected` to the `trackHookActivitySync` call at `:471` so net savings
become directly queryable instead of reconstructed from transcripts.

---

## Verification

Nothing here is believable without the daemon in **both** states. The whole
finding set came from testing the down state, which no prior work had done.

1. **Daemon UP** — restart it, confirm `pingDaemon` true, then:
   ```
   node scripts/hooks/tldr-savings-probe.mjs --from-transcripts
   ```
   Expect: interception only on ≥8KB files; per-call latency **~60ms, not ~1.2s**
   (this is the async-transport win, and it is the headline number to check).

2. **Daemon DOWN** — the case that must not regress. Stop the daemon, then run
   the enforcer against a 12.7KB file:
   ```
   apps/agentic-os/src/server/queries/sessions.ts
   ```
   Expect **`{}` in well under 1s**. Today: denies after 31.6s with one function
   name. This is the single acceptance criterion I care most about.

3. **Zombie state specifically** — the state found in the wild: process alive,
   port refusing. Simulate by starting the daemon and killing its listener while
   leaving the pid file. Expect fail-open, no 31s stall.

4. **Task calls** — confirm `tldr-context-inject` no longer runs:
   `node scripts/hooks/registration-reconcile.mjs` should show it deregistered,
   and a real Task spawn should not pay 63s.

5. **Re-measure the outcome, don't assume it.** After a few days of real use:
   ```
   node scripts/hooks/tldr-deny-followup.mjs
   ```
   **Fix its non-recursive `readdirSync` first** — that is the bug that produced
   the wrong conclusion yesterday. Expect substitution rate to *rise* (small
   lossy files no longer intercepted). If it doesn't rise, the threshold is
   wrong and should be moved to 20KB, where the measured win rate is 19/21.

6. Guards must stay green: `hook-contract-guard.mjs`,
   `registration-reconcile.mjs`, `braintrust-emit-guard.mjs`.

---

---

## Risk Mitigations (Pre-Mortem, 2026-07-29)

Cross-model pass: **Codex** (`gpt-5.5 @ xhigh`, `codex-cli 0.144.1`). The
`codex-adversary` agent could not run — its Bash tool hit the MSYS fork storm on
6 consecutive attempts and it **correctly refused to fabricate a review** rather
than pass Claude-family reasoning off as cross-model. Re-run inline via the
PowerShell tool per the skill's documented fallback; 53s, exit 0.

### Tigers addressed

| # | risk | source | where mitigated |
|---|---|---|---|
| 1 | Handshake race: one `session_id`-keyed file, 30s TTL, **subagents share the parent session_id**, 77% of firings are subagents | Codex (confirmed + escalated) | §5 — exact-path match + consume-once, or drop |
| 2 | Fail-open probe routes through `tryStartDaemon` — the slow path it exists to avoid | Claude + Codex (agreed) | §1 — direct connect, never start a daemon from PreToolUse |
| 3 | Async hook exits before promise settles → no/partial JSON | Codex | §2 — `then/catch`, one stdout write, `exitCode`, delayed-daemon test |
| 4 | Timeout units omitted; async could turn a 31s stall into an unbounded hang | Claude | §8 (new) |
| 5 | Zombie detection stampede across parallel subagents | Codex | §6 — single-flight, side-effect-free, shared negative cache |
| 6 | Content floor by symbol count is a weak proxy | Codex | §1 — min size **and** target-present |
| 7 | Router deny→allow weakens handshake ordering | Codex | §5 — consume-once makes ordering explicit |
| 8 | Telemetry counts per firing, not per chain | Codex | §7 — correlate by session + file across the whole chain |

### Findings judged wrong or overstated

- **Socket framing (Codex, high → low).** Newline-delimited protocol and
  `JSON.stringify` escapes newlines, so `includes('\n')` implies a complete
  frame. Only the two-frames-in-one-chunk case is real. No redesign.
- **Threshold selection bias (Codex, medium → refuted).** The floor is 3000B, so
  3–8KB reads *were* eligible; those 44 cases are direct observations. Surfaced
  a real labelling error though (§3).
- **Deregistering `tldr-context-inject` changes subagent behaviour (Codex,
  medium → low).** It returns `{}` on every path, so the Task proceeds
  unmodified; removing it changes latency only.

### Accepted, not mitigated

- **The elephant stands.** ~174k tokens / 3 months is small. Codex: *"does not
  prove removal is required, but it does raise the bar for any complex hook-side
  fix."* Agreed — that is the argument for this being the **last** investment in
  TLDR, and for preferring deletions over new machinery throughout.

### Pre-Mortem run
- Date: 2026-07-29 · Mode: deep · Cross-model: Codex
- Tigers: 8 (claude-only 2, codex-only 5, agreed 1) · Refuted/downgraded: 3

---

## Explicitly out of scope

- **Fixing `_is_daemon_alive` upstream.** It is the true root cause, and it is
  in site-packages — any edit is lost on reinstall. Worth filing upstream or
  vendoring later; not this change.
- **Auto-killing stale daemon processes** (see §6).
- **`/context`.** Every token figure here is `bytes/4`, labelled as such in the
  tooling. Still never run.

## Known-uncertain

- The 8KB threshold is derived from 138 interceptions on **this** repo's file-size
  distribution. It is an empirical fit, not a law, and a repo of mostly-small
  modules would want a different number. Re-derive rather than inherit.
- I have net-token totals for main vs subagent **combined**, not split. Subagents
  are 77% of firings and have a *worse* substitution rate (11.3% vs 17.9%), so
  it's possible the two populations want different thresholds. Not enough
  evidence to act on; worth splitting if a later pass has reason to.
- The `hook_activity.jsonl` count (173 since 2026-05-15) and the transcript count
  (138 since 2026-06-29) have not been reconciled to each other. Same order of
  magnitude, different windows, so neither is obviously wrong — but I did not
  chase the gap and it should not be quoted as agreement.
