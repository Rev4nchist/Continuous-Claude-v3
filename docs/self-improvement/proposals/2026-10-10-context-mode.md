# context-mode in CCv3: skip the install, steal the habit (2026-10-10)

Verdict: **SKIP** context-mode v1.0.169 as a whole. That covers all three parts: the MCP server (11 `ctx_*`
tools), the plugin hooks, and the session-continuity store. **WATCH** one tool, `ctx_fetch_and_index`, for large web
docs. Revisit it only if probe D shows repeated large doc fetches. Even then, running it means booting the same MCP
server, with the same writes to `~/.claude` (§5, §7). **Steal** four things and rebuild them in CCv3's own words: (A) a routed "derive, don't dump" rule, (B) verify,
then delete, the 100K Bash output override, (C) make the PreCompact handoff fire on manual `/compact`, (D) a
net-savings probe. Status: **awaiting Dave**. Nothing is built.

Why now: context-mode claims "98% context savings" and ships as a Claude Code plugin. CCv3's always-loaded text has no
headroom left: 9 chars under the ratchet [ran]. So the next context win has to come from tool output, and context-mode
is the obvious candidate. The open question was whether it helps or hurts the prompt cache.

How it was built: 5 agents read the clone as untrusted data (server/exec, store/search, hooks, session, trust). 2 mapped
CCv3's hook surfaces and context levers. 3 probes drove the real code in a throwaway HOME: hooks (140 runs), the MCP
server over stdio (25 fresh servers), and the upstream test suite. 4 phase-3 agents attacked the phase-1 claims (cache
model, reduction re-run, risk refutation, what to steal); where they corrected phase 1, this file says so. A final
critic pass checked this file against every note and corrected it (`notes/w4-critic.md`). Tags: [read]
code read, [ran] executed, [docs] Claude Code docs, [inferred] reasoning.

## 1. Answer

- **The savings come from a habit, not the machinery.** On 5 real CCv3 questions, plain Bash with a summarising
  one-liner answered **5/5 in 1,334 B** (0.31% of 429 KB raw); context-mode's search recipe answered **1/5 in 66 KB** [ran].
  The 429 KB is raw stdout, not what Claude Code shows. At its default ~30K ceiling, 4 of the 5 outputs would come
  back as ~2 KB file previews, so the realistic plain-Bash baseline is ~38 KB, and the model would still need follow-up
  calls to answer [inferred, w3-cache]. Running the same one-liner through `ctx_execute` also scored 5/5 (2,644 B).
- **It does not break the prompt cache; it adds tokens that are cached, then re-read.** Every injection is appended in the
  conversation layer [docs]. Cost: ~+0.6M tokens processed per session with hooks only, ~+2.4M with the tools in use,
  mostly from subagents [inferred, §3].
- **HIGH-severity guard bypass.** Shell run through `ctx_execute`/`ctx_batch_execute` skips every CCv3 Bash/PowerShell
  guard and Bash tracker; its own firewall reads `permissions.deny`, which CCv3 does not set. The plugin's own denies
  push the model onto exactly these tools [read, §5].
- **Unasked writes to the active harness.** MCP boot appends a SessionStart hook to `~/.claude/settings.json`, plants
  `~/.claude/hooks/context-mode-cache-heal.mjs` and enables itself [ran]. `ctx_upgrade` returns a command the model
  "MUST run". That upgrade clones unpinned HEAD, runs `npm install` with lifecycle scripts and kills the context-mode
  servers in every other lane. CCv3's Bash guards see only `node …/cli.bundle.mjs upgrade` [read].
- **The headline numbers do not hold up.** Counting the script input turns "98%" into 95%, or 84% on the 10 smaller
  fixtures [ran]. `ctx_stats` reported "99.5% reduction" for two calls that answered nothing [ran].
- **It keeps what it captures.** Raw prompts, CLAUDE.md, error output, MCP responses and subagent replies are kept for
  7 days. Command output and fetched pages are kept for 14 days. The only redaction is of `export X=` values and of the
  ≤2 KB MCP call summary. Full MCP responses and error output are stored as they are [read, ran; §6].
- **Real wins, all narrow:** floods over 100 KB (Claude Code already does this natively), ranked lookups over
  heading-structured prose (modest), and large web docs with an unknown keyword (WATCH). See §4.

## 2. How context-mode works

**MCP server.** 11 tools, no MCP `instructions` string (0 chars) [ran]. `tools/list` is 28,008 chars in the API
shape, about 7.8K tokens if loaded eagerly. It was byte-identical across 50 calls. The server advertises
`listChanged: true` but never sends the notification [ran]. (Phase-1 code reading said `false`; the probe corrects it.)

| Tool | Chars (desc+schema) | What it does |
|---|---:|---|
| `ctx_execute` | 5,031 | Writes code to a temp file, spawns one of 12 runtimes, returns stdout (routing below) |
| `ctx_search` | 4,503 | BM25 over the FTS5 store. At most 2 results per query, 1 from call 4, **blocked from call 9** in 60 s |
| `ctx_batch_execute` | 4,420 | Runs N commands, indexes all output, returns top chunks per query (`queries` required) |
| `ctx_fetch_and_index` | 3,779 | Fetches a URL in a child process, HTML to markdown, indexes it, returns a 3 KB preview |
| `ctx_index` / `ctx_execute_file` / `ctx_purge` | 3,183 / 3,114 / 2,378 | Index a path; run code over a file; delete store rows |
| `ctx_insight` / `ctx_upgrade` / `ctx_doctor` / `ctx_stats` | 530 / 413 / 335 / 322 | Open hosted dashboard; return an upgrade command the model "MUST run"; diagnostics; savings counter |

**The "sandbox" is not a sandbox.** It is `child_process.spawn` as the same user, with cwd set to the project root. The
child gets the full parent environment minus a list of ~80 code-injection variables, so API keys and tokens pass
through. It has full filesystem and full network access. There is no default timeout. A `background:true` process
outlives the call (`src/executor.ts:282-319, 440-504, 573-745`) [read]. `ctx_index` takes absolute paths with no
project confinement (`src/server.ts:663-665, 2290`) [read].

**Size routing** for `ctx_execute` and `ctx_execute_file` (`src/server.ts:1855-1950, 1979-1980`) [read, ran]:

| stdout | Returned to the model | Stored? |
|---|---|---|
| ≤ 5,000 B | Verbatim, plus an echo of the code (≤ 2,000 chars) | no |
| > 5,000 B **with `intent`** | 5 matched section titles plus "Searchable terms" (1.2-2.0 KB). Content needs a follow-up `ctx_search` | yes |
| 5,000 B - 100 KB, **no `intent`** | **Verbatim. 0% reduction** (37,409 B in, 37,494 B out) | no |
| > 102,400 B, no `intent` | A 224 B pointer: "Indexed N sections ... use ctx_search" | yes |

**Store.** SQLite FTS5, two tables (porter and trigram, so every chunk is stored twice). Plain text is split on blank
lines when that gives 3-200 sections of under 5,000 B. Otherwise it is cut into 20-line groups with a 2-line overlap.
Chunks are at most 4,096 B. Search is lexical BM25 fused with RRF; there are no embeddings. The
store lives at `~/.claude/context-mode/content/<hash>.db` and is deleted after 14 days. There is no size cap and no
VACUUM (`src/store.ts:153, 465-546, 1239-1345`) [read].

**Hooks** (plugin `hooks/hooks.json`; each call is a fresh `node` process at 65-100 ms, median ~70 ms) [ran]:

| Event / matcher | Model-visible output | Bytes [ran] |
|---|---|---|
| SessionStart (every source) | Routing block as `additionalContext`. Static and byte-identical across sessions | 4,631 |
| SessionStart compact | Routing block plus a directive built from captured events. Grows with each compaction | 5,638 → 5,662 |
| SessionStart resume, id with no events | Routing block plus the latest unconsumed snapshot of **any** session in the project DB, including the full CLAUDE.md text | 7,397 |
| PreToolUse Bash / Read / Grep | Nudge, once per session each. Read nudges on **every** Read of a file over 50 KB | 681 / 405 / 505 |
| PreToolUse Bash: curl, wget, inline HTTP, gradle/mvn/sbt | `deny` with a redirect to the ctx tools. Only when the MCP server is up and the call is not in a subagent | 370-551 |
| PreToolUse WebFetch | `deny`, with the same gates (MCP up, main thread) | 650 |
| PreToolUse Agent | `updatedInput`: appends a routing block to **every** spawn, nested spawns included. MCP down does not stop it, and no env var turns it off. The only off switches are disabling the plugin, `disableAllHooks`, or a standalone MCP install without the plugin hooks | +4,637 |
| UserPromptSubmit, PostToolUse, PreCompact, Stop | Nothing. SQLite capture only: raw prompts, CLAUDE.md, error output, MCP responses. Stop reads the whole transcript every turn | 0 |

**Session continuity.** Hooks capture events into a per-project SQLite DB (7-day retention, 1,000-event cap). PreCompact
builds an XML snapshot, but the compact path injects a different, regex-built directive instead. "Decisions" means any
prompt of 15-500 chars that contains a comma (`src/session/extract.ts:2222-2240`) [read, ran]. It is a flight recorder
plus an index. CCv3's ledger is a curated logbook. They are different tools for different jobs.

## 3. Cache impact on CCv3

Placement [docs: code.claude.com/docs/en/prompt-caching, /hooks]. The cache matches an exact prefix in the order tools →
system → messages. Hook `additionalContext` becomes a system-reminder in the conversation layer: SessionStart text before
the first prompt, PreToolUse text next to the tool result. Loading a deferred tool appends a `tool_reference` and leaves
the prefix untouched. CCv3 sets `ENABLE_TOOL_SEARCH=auto:5` (`.claude/settings.json:4`), an aggregate threshold, and
`/context` already shows its 291 MCP tools deferred (harness-strategy phase-2 plan), so context-mode's 11 would join
that pool. That answers Q7/B6 of the 2026-09-30 proposal for the main thread [docs, read]; whether a subagent's
filtered tool set is judged against its own pool is unverified.

| Surface | Bytes / tokens | Where it lands | Cache effect | Evidence |
|---|---|---|---|---|
| Tool names (deferred) | ~0.2K tok | Tool list | Stable; no list_changed ever sent | probe-mcp §2 [ran]; size [inferred] |
| Tool schemas if loaded upfront | 28,008 chars ≈ 7.8K tok | Tools prefix | Stable, but re-read every request | probe-mcp §2 [ran] |
| SessionStart block | 4,631 B ≈ 1.29K tok | First turn | Append; byte-identical. CCv3's own dynamic SessionStart hooks already prevent cross-session sharing | probe-hooks L01/L02 [ran] |
| Nudges | ~3 × 405-681 B (Bash, Read, Grep), plus every >50 KB Read | Tail, after the tool result | Append only | probe-hooks §4 [ran] |
| External-MCP nudge | 628 B every 10th call **in the probe**; **0 in real CC 2.1.296**, because a bare `mcp__` matcher never matches (§8) | n/a | none | w3-refute-risks §1 [read: CC binary, not live-fired] |
| Outdated-version banner | Prepended to tool results, up to 3 times an hour, when npm has a newer version | Tail | Append only; varies with time | cm-trust §2.4 [read] |
| Agent append | 4,637 B ≈ 1.29K tok per spawn | Subagent's first user message, **after** the unique task text | Never shared across spawns; written at the 5-minute tier | `hooks/core/routing.mjs:894-916` [read]; probe-hooks X3 [ran] |
| Subagent bootstrap, if followed | 5 schemas = 20,847 chars ≈ 5.8K tok, plus a round trip | Subagent conversation | Append | `hooks/routing-block.mjs:24-28` [read] |
| Compact / resume directive | +1.0 KB (compact), +2.8 KB (`/resume`) | Rebuilt prefix | Compaction already resets the cache; output differs on each compaction | probe-hooks L19/L20, §3b [ran] |
| Denied call | 370-650 B, plus one wasted round trip | Tail | Append | probe-hooks §4 [ran] |

**Per main session** [inferred: 324 sessions and 904 subagent runs in 30 days, so 2.8 spawns per session; ~115 main
requests and ~86 per subagent; 3.6 chars/token; Opus-tier list price, $0.20/M cache read]:

| Usage | Extra tokens processed | Notional cost | Share of input-side cost |
|---|---|---|---|
| Hooks only, ctx tools never loaded | ~+0.59M | ~+$0.16 | +1.7% |
| Full use (main and subagents load the tools) | ~+2.4M | ~+$0.68, plus ~$0.26 per 5 large outputs on the search path | +7-10% |

Dave is on a subscription, so the dollars are notional usage, not billed money. Halving the average context doubles
every read-side figure. Cache hit ratios (97.5% main, 96.6% subagents) should not drop, because nothing invalidates.

**Break-even.** The hooks-only setup must remove ~8K tokens of inline output per session (about 30 KB answered in 1 KB).
Full use must remove ~35K tokens (~125 KB). The probe question shapes that failed are the common ones: count, list, max
and git-log attribution.

**Where the verdict flips.** Sessions with few subagent spawns, mostly single-fact lookups over 5-30 KB outputs that the
intent path answers in one call. Above ~30 KB, Claude Code already saves the output to a file and returns a ≤2 KB
preview [docs: tools-reference "Output limits"; ran: 30.5K, 43.7K and 57.9K outputs persisted in this session].
**Caveat:** that native baseline holds only if CCv3's `BASH_MAX_OUTPUT_LENGTH=100K` override is not live.
`ROADMAP.archive.md:8` records it being set on 2026-03-27. It is not in the repo, so it may still be set on Dave's machine.
If it is live, 30-100 KB outputs come back inline today. context-mode does not fix that band either: without `intent` it
returns 5-100 KB verbatim. Steal B fixes it natively.

## 4. Measured reduction on CCv3's real workload

Five questions over real CCv3 outputs, saved once and re-used by every run [ran]: (a) a timeout const in
`daemon-client.ts`, 37 KB; (b) which commit touched a file, `git log -60 --stat`, 90 KB; (c) which hook files emit
`additionalContext`, 39 files in a 30 KB grep; (d) count SKILL.md files (198) plus one path, 39 KB `find`; (e) the
largest file, 233 KB `ls -laR`.

Phase 1 framed the result as "context-mode 1/5 vs a one-liner 5/5". That compared context-mode with itself: the
one-liner also ran through `ctx_execute`. The steelman re-run follows both of context-mode's documented recipes and adds a
no-MCP baseline (`probe/w3/step3*.json`).

| Approach (5 questions) | Bytes returned | Calls | Correct |
|---|---:|---:|---|
| Plain Bash, raw command (raw stdout) | 429,052 | 5 | 2, plus 3 the model must count or compare by eye |
| Plain Bash, raw command, as Claude Code returns it at the default ~30K ceiling | ~38,000 | 5, plus follow-ups | a, b, d and e come back as ~2 KB previews, so 4/5 need a grep or Read of the saved file [inferred, w3-cache; only if the 100K override is not live, §3] |
| **Plain Bash, summarising one-liner** | **1,334** | 5 | **5/5** |
| `ctx_execute` running the same one-liner (with or without `intent`) | 2,644-2,686 | 5 | 5/5 |
| `ctx_batch_execute` with only the processing command and 1 query | 7,176 | 5 | 5/5 |
| `ctx_batch_execute` with a processing command and 5-8 queries | 141,579 | 5 | 5/5 (the answer comes from the processing command) |
| `ctx_batch_execute`, 5-8 queries, no processing command | 145,622 | 5 | 2/5 reliably |
| Specific `intent`, then one batched `ctx_search` | 66,410 | 10 | **1/5** (c 28/39 files; d path only) |

What the re-run shows [read, ran]. The two documented recipes contradict each other: `references/anti-patterns.md:247-269`
says never narrow inside `ctx_execute` and filter with search; `skills/context-mode/SKILL.md:148` and the tool
descriptions say compute in code. Top-k search cannot answer counts, maxima or "list all", whatever the queries, and
20-line chunks split records (a `git log --stat` header sits 65 lines above its file line). The 5-8 queries the schema
asks for inflate output (c: 38.8 KB against 29.9 KB raw). A batch processing command comes back only if a query
matches it (null test: dropped). `ctx_execute` adds ~150-360 B per call over plain Bash (the code echo).

Where context-mode genuinely wins [ran]:
- **Unplanned floods over 100 KB:** 232 KB became a 224 B pointer. That protects the context, but it loses the
  answer: the pointer answered nothing, and "largest file" cannot be found by search (probe-mcp e-exec_nointent).
  Claude Code's native ~30K file-plus-preview already does this, and better: a plain file can answer aggregates with grep.
- **Repeated lookups over a 110 KB heading-structured rules corpus:** one batched search returned 13.5 KB and answered
  6/8. One grep per question returned 72.7 KB and answered 8/8. That is about 5x fewer bytes for 25% fewer answers.
  The greps were broad, so narrower ones would close some of the gap [inferred]. Separate searches were blocked from call 9.
- **Large web docs:** a 987 KB changelog came back as 3.5 KB on indexing plus 9.5 KB of relevant search results. `curl -o`
  plus grep matched 2 of 3 topics. The win needs an unknown keyword.

## 5. Fit and collisions with CCv3

| CCv3 surface | context-mode on the same surface | Collision | Severity |
|---|---|---|---|
| PreToolUse `Bash` and `PowerShell`: destructive-command-guard, package-install-guard, commit-preflight, scan-scope-guard, rule-router | `ctx_execute` / `ctx_batch_execute` run shell under the names `mcp__plugin_context-mode_context-mode__ctx_*` | **Bypass.** No CCv3 matcher matches those names. The guards' runtime checks accept only `Bash`/`PowerShell` and read `command`, not `code` or `commands[]`. There is no `permissions` block. Dave runs with `skipDangerousModePermissionPrompt`, and sessions are recorded in `bypassPermissions` [read]. Under bypass, Claude Code's MCP permission prompt does not fire [inferred]; outside bypass it is the only backstop. The plugin's curl/WebFetch/build-tool denies steer the model onto these tools [read] | **HIGH** |
| PreToolUse `Agent` (CCv3's `Task` matcher is an alias for it) | +4,637 B appended to every spawn. A request for `subagent_type:"Bash"` becomes `general-purpose` | Tokens on every spawn. The rewrite is nearly unreachable: CC has no `Bash` agent type and CCv3 has none either. CCv3 emits no `updatedInput`, so there is no conflicting rewrite | MED |
| PreToolUse WebFetch: rule-router opencli inject; PostToolUse web-lookup-advisor | Always denies WebFetch in the main thread | Contradicts the opencli guidance. A denied call has no PostToolUse, so web-lookup-advisor goes silent | MED-HIGH |
| PreToolUse `Bash` curl: rule-router `cma` deny-first; `kusto`/`fabric` injects | curl/wget deny | Two denies on one call. Once-per-session router markers can burn on a call that is then denied [inferred] | MED |
| PreToolUse `Read`: tldr-read-enforcer (deny with an AST summary ≥ 8 KB) | Read nudge toward `ctx_execute_file` | Contradictory advice. `ctx_execute_file` bypasses tldr | LOW-MED |
| UserPromptSubmit (6 hooks, already 22-32 s worst case); PostToolUse (~24 hooks) | One more node process plus SQLite per prompt and per tool call; Stop reads the transcript every turn | Latency stacking: ~70 ms × 2 per Bash/Read call. **3-4 s per hook, indefinitely,** if the native dependency is missing [ran] | MED |
| SessionStart / PreCompact continuity (ledger, handoff YAML) | A second, independent resume system | Redundant. With `autoCompact: false`, its compaction recovery runs on manual `/compact` only | LOW-MED |
| PowerShell (Dave's Windows host) | Not registered | Inert. Routing and savings do not apply to PowerShell calls | LOW (lost value) |

**Settings rewrite vs forward sync** (w3-refute-risks §2). **Confirmed [ran]** in an isolated HOME: MCP boot
(`start.mjs:227-426`) appends a SessionStart entry to `settings.json`, plants `context-mode-cache-heal.mjs`, sets
`enabledPlugins["context-mode@context-mode"]=true` even when the plugin is not installed, and adds a bogus
`enabledPlugins` key to `installed_plugins.json`. The writes are non-atomic, against CCv3's settings.json race rule. A
second boot changed nothing. **Refuted, correcting phase 1:** boot does not write `~/.claude.json` (only the upgrade
path does), and there is no sync loop: `sync-to-active.sh` never syncs `settings.json` (:165), only merges
`.mcpServers` (:851-864), and copies only hook files that exist in the repo (:925-932). **Left over:**
registration-reconcile, `/hook-audit` and `/sync-drift` would flag `context-mode-cache-heal` as a foreign hook.
The boot writes have no plugin-install gate. They also ran in the npm / `claude mcp add` layout, so installing the MCP
server alone (for example for the WATCH tool) writes them too [ran: w3-refute-risks §2 layout A/C].
**Other writes under `~/.claude`** [read]: the SessionStart hook rewrites `~/.claude/shell-snapshots/*.sh` PATH
segments and deletes plugin-cache version dirs older than an hour (`hooks/sessionstart.mjs:131-164, 390-442`).
`pretooluse.mjs:105-148` rewrites `settings.json` matchers, adding an `Agent|` prefix to any matcher that contains
`Task`. It would turn CCv3's `TaskUpdate` into `Agent|TaskUpdate`. That path runs only when the plugin's `hooks.json` is absent, so
it is dead on a plugin install.

**Task vs Agent, settled** (correcting phase 1, which called it a version fork). The Claude Code 2.1.296 binary names
the tool `Agent` and maps a `Task` matcher to it as an alias [read: CC binary, not live-fired]. So context-mode's
injection fires on every spawn, and CCv3's 8 `Task` hooks should fire too (not yet checked against hook telemetry). `docs/system-update/CURRENT-STATE.md:11, :27` ("the live Claude Code tool
emits 'Task'") is stale and contradicts `.claude/rules-src/hook-dev-lifecycle.md:34`. That is a CCv3 doc fix, separate
from this proposal.

**Lanes and `/resume`.** All lanes in one tree share one DB. When a resumed session id has no events, the hook claims the
latest unconsumed snapshot from **any** session: S4 received S3's prompts [ran]. Two things must both hold. First, an
unconsumed snapshot exists, meaning PreCompact fired but the compact SessionStart did not (a crash, a kill or a failed
compaction). Second, the resumed id has no events in the DB: `--fork-session`, a session older than the 7-day cleanup,
one from before the install, or one started in another directory. The CLI's default resume keeps the session id
[docs: `claude --help`]. Whether the in-session `/resume` picker does too is not verified; the code comment assumes it
hands a new id (`sessionstart.mjs:279-284`). A per-lane `CONTEXT_MODE_SESSION_SUFFIX` would isolate lanes. A
fresh-starting lane also deletes the shared `<hash>-events.md` (`hooks/sessionstart.mjs:300`) [read].
Two more shared-state hazards [inferred, not tested]. The `ctx_search` throttle is keyed on the most recent session id
in the project DB, because `CLAUDE_SESSION_ID` is not passed to MCP servers (`src/server.ts:448-502`). Concurrent lanes
and subagents can therefore share one 8-calls-a-minute bucket and be blocked together. Also, the store-open cleanup
deletes any content DB with a non-empty WAL and an mtime over an hour old. That could remove another idle lane's live DB.

**Fix cost if adopted anyway:** deny `ctx_upgrade` and its skill; register the 4 guards on `mcp__plugin_context-mode_.*`
**and** widen their runtime checks to read `code` (shell) and `commands[].command` (a matcher edit alone changes
nothing); add a `permissions.deny` baseline; set `CONTEXT_MODE_SESSION_SUFFIX` per lane; allowlist the cache-heal hook
in the drift checks; accept +4.6 KB per spawn. Also pin by commit SHA and never auto-update; pre-install
`better-sqlite3` so no hook calls npm; set `MCP_TOOL_TIMEOUT` (there is no default exec timeout) and
`CTX_FETCH_STRICT=1`; add a check that `~/.context-mode/platform.json` does not exist (cm-trust §2.3, §5.5; cm-server-exec §6).

## 6. Trust and ops

| Area | Finding | Evidence |
|---|---|---|
| "98%" benchmark | Counts only the stdout of 14 summariser scripts, written by an author who had seen each fixture. No model in the loop, no task-success measure. In 11 of 14 rows the script is larger than its output; counting it gives **95.0%**, and **84.0%** on the 10 smaller fixtures. `BENCHMARK.md` says 96%, the README 98%. "986 KB → 62 KB" and "30 min → 3 h" have no backing in the repo | `tests/ecosystem-benchmark.ts:440-470` [read]; `work/codesize.mjs` [ran] |
| `ctx_stats` | Counts bytes not returned as savings. ADR-0004 chose a formula showing 95.4% over one showing 56% on the same session. Never use it as a gate | `src/server.ts:1030-1040` [read]; `probe/mcp/stats-output.txt` [ran] |
| Telemetry | Off by default. But: an always-on, no-opt-out GET to `registry.npmjs.org` at boot and hourly; a dormant forwarder that POSTs every captured event if `~/.context-mode/platform.json` exists (nothing creates it; the README never mentions it); a version banner prepended to tool results. README :1524 "nothing leaves your machine" omits both channels | `src/server.ts:780-803, 4956-4959`; `hooks/platform-bridge.mjs` [read] |
| Install and runtime | Every hook imports `ensure-deps.mjs`: an unpinned `npm install better-sqlite3` (up to 120 s) when the module is missing, else a copy of the native `.node` file over the live one. Boot spawns a background `npm install` of turndown/domino. npm crashed (arborist `edgesOut`) on the `bun.lock`-only layout. stderr is closed and every hook exits 0, so failures are silent | `hooks/ensure-deps.mjs:75-81, 175-177`; `start.mjs:485-540` [read]; probe-hooks §1 [ran] |
| Data at rest | The session DB (`~/.claude/context-mode/sessions/`, 7 days) holds raw prompts, the full CLAUDE.md, full error output, full MCP responses (3.5 KB in the probe) and uncapped subagent replies. The content store (14 days) holds indexed command output and fetched pages with no secret scrubbing [inferred]. The child env drops ~80 injection variables but no secrets. `ctx_index` takes any absolute file path, or any directory for allowlisted extensions, with no project confinement. With CCv3's empty `permissions.deny`, a file such as `~/.aws/credentials` can be indexed and replayed by `ctx_search` | probe-hooks §3, §7 [ran]; `src/session/extract.ts` (cm-session §3.1), `src/executor.ts:579-689`, `src/server.ts:663-665, 2290` [read] |
| Licence | ELv2. Private use and patching are fine. Copying source, bundles, regex lists or prose into CCv3's public MIT repo would make those files non-MIT. Every steal in §7 is an idea-level re-implementation | `LICENSE:9-64` [read] |
| Bundles | 4/4 hook bundles with a recipe rebuild byte-identical. `server`/`cli` bundles differ 0.1-0.5%, all third-party strings (MCP SDK, URI lib). The likely cause is that CI runs an unlocked `npm install` [inferred]. `session-attribution.bundle.mjs` has no recipe and is stale (2,799 B vs 3,250 B). Nothing is signed; no workflow publishes to npm | `work/astcmp.cjs`, `work/rebuilt-*` [ran] |
| Test suite | 210 files: **4,708 pass, 3 fail, 31 skipped** (176 s). All 3 failures look environment-related [inferred]. Two are clearly probe artifacts (no `.git` in the copy; running as root). The third, a process-group kill inside the container, is unverified. `pretest` overwrites the committed bundles | `probe/vitest.log` [ran] |
| Cadence | v1.0.169, one maintainer, ~20 patches in 10 days in May 2026 then ~21 in 4.5 months, no CHANGELOG, minor never moved. The large "self-heal" layers exist because upgrades kept breaking Claude Code's plugin registry; CCv3 would absorb that churn | ADR dates; `scripts/heal-installed-plugins.mjs:2-10` [read] |

## 7. What to steal (native, no context-mode code)

| # | Idea | Surface and size | Gate (AGENTS.md) |
|---|---|---|---|
| A | **"Derive, don't dump."** For a count, filter, max or one fact in a big output, write the command so it prints only the answer. A plain view or a state change runs as is. For a large page, `curl -o` to a scratch file, then grep or jq it | On-demand rule `.claude/rules-ondemand/output-discipline.md` (~600 chars), rule-router `inject` on dump-prone heads (`cat`/`Get-Content`, `git log/show/diff`, `find`, `ls -R`, `grep -r`/`rg`, `gh api`, `curl`/`iwr`, test runners). Fires once per agent_id (`rule-router.ts:166-168`), so subagents are covered, and PowerShell too. The index row needs ~90 chars and **headroom is 9**: either a reviewed `maxChars` raise or a cut in the same PR | `claude -p` on the 5 probe questions, rule on vs off, N≥3, comparing `usage` tokens and correctness, plus a subagent arm. Then the 4 ratchets. Artifact `.claude/cache/e2e/<date>-output-discipline.json` |
| B | **The native flood net.** Find where `BASH_MAX_OUTPUT_LENGTH=100000` lives on Dave's machine. If it controls inline vs saved-to-file, remove it | A settings env change, which is a deletion | A threshold probe with 40K and 120K outputs, before and after. Pass = the 40K output comes back as a saved-file preview. Artifact `.claude/cache/e2e/<date>-bash-output-ceiling.json`. **Run first:** it decides the size of A |
| C | **A PreCompact handoff on manual `/compact`.** `pre-compact-continuity.ts:41` writes the transcript handoff only when `trigger === 'auto'`, and there were 0 auto compactions in 30 days. C1: also run it on `manual`, with a byte cap on the compact injection. C2: delete the dead branch if 2-4 weeks show no re-asks after compaction. Check first that auto-handoffs do not crowd the 5 unmarked-handoff slots (`session-start-continuity.ts:447-472`) | A one-line hook change plus a cap | `npm run build`, then pipe real `trigger:"manual"` PreCompact and `source:"compact"` SessionStart payloads into the built hooks. Artifacts are both stdout JSONs |
| D | **A net-savings probe.** It replaces any `ctx_stats`-style metric. Net = baseline result bytes − (new result + tool input + follow-up bytes), always paired with correctness | `scripts/context/bash-output-bands-probe.mjs`: a recursive scan of transcripts. It reports Bash/PowerShell result sizes in bands <5K, 5-30K, 30-100K and persisted, split main vs subagent, plus re-reads of saved output files | Probe output with a positive control. It is the baseline for A and B |

Rejected: the curl/wget deny (it only redirects to ctx tools and collides with the cma/kusto/fabric router rules);
the FTS5 pointer (weaker than the native net, 1/5 on aggregates); the Agent prompt append (+4,637 B per spawn, never
cache-shared); per-tool event capture (~150 ms per call, plus the defects in §8); `ctx_stats` (a counterfactual metric).

WATCH, not adopt: `ctx_fetch_and_index` [read, ran]. It wins only on a very large prose doc where the keyword is
unknown (§4). The costs:
- Running it boots the whole MCP server, with the §5 writes.
- Its SSRF guard allows localhost and RFC1918 unless `CTX_FETCH_STRICT=1`, and misses 100.64.0.0/10 (§8).
- Fetched pages stay indexed for 14 days, which is a stored prompt-injection surface.
- CCv3's WebFetch already returns a model-summarised page [inferred].

Revisit only if probe D shows repeated large doc fetches. The "curl to a file, then grep" clause in A covers the
common case.

Honest prior for A: advisory text has had 0/16 uptake before (search-router). Injection also arrives after the command is
chosen, so the measurement decides, not the design.

| # | Decision for Dave | Recommendation |
|---|---|---|
| D1 | Install context-mode at all? | **No.** If you want to try it, use a throwaway profile, never `~/.claude`. |
| D2 | Order of work | **B, then D, then A.** B may make A smaller. D gives both a baseline. |
| D3 | Budget for A's index row | **Raise `maxChars` by ~100 with review**, or name a cut. |
| D4 | C1 (flip) or C2 (delete) | **Wait for D's evidence** on re-asks after `/compact`. |
| D5 | Report upstream bugs (§8)? | Your call. These are outward-facing actions. |

## 8. Bugs found upstream (v1.0.169)

1. `hooks/userpromptsubmit.mjs:62-68` writes `category:"user-prompt"`; `hooks/session-directive.mjs:59` reads `"prompt"`.
   "Last Request" and `<continue_from>` never render after a compaction [ran].
2. `session-directive.mjs:271` vs `:276`: `legBoundary` is never returned, so the #780 fix is inert [read].
3. The catch-all `mcp__` PreToolUse/PostToolUse matcher is a "simple" matcher, which CC 2.1.296 compares exactly. It never
   matches an MCP tool, so external-MCP nudges and MCP event capture never fire [read: CC binary, not live-fired].
4. The 1,000-event cap evicts the lowest numeric priority first, but extract.ts marks 1 as critical. File, rule, task
   and prompt rows go first (`src/session/db.ts:639`) [read].
5. `hooks/core/routing.mjs:854-855`: the Read nudge repeats on every Read over 50 KB and records `bytes_avoided` = file
   size, though Read is never blocked [ran].
6. `hooks/formatters/claude-code.mjs` (headless passthrough) is imported nowhere, so `claude -p` gets full denies [read].
7. `hooks/session-attribution.bundle.mjs` is stale against `src/` and has no build recipe [ran].
8. Docs drift: `ctx_search` says `limit` default 3 but clamps to 2 (`src/server.ts:2668-2670`); batch says "top 5",
   code uses 3; `references/anti-patterns.md` teaches a nonexistent `summary_prompt`; `:1742` `cwd` text is stale.
9. `hooks/ensure-deps.mjs:75-81`: unpinned `npm install better-sqlite3`, failure swallowed and retried on every hook
   (3-4 s each); the "~0.1 ms fast path" header is false, it copies a binary every run [read, ran].
10. `scripts/heal-installed-plugins.mjs`: `healSettingsEnabledPlugins` (:146-180) enables a plugin that is not installed;
    `healInstalledPlugins` (:40-128) adds a bogus top-level `enabledPlugins` key to `installed_plugins.json` [ran].
11. `ctx_upgrade` declares `destructiveHint:false`, yet the upgrade clones unpinned HEAD, runs lifecycle scripts and kills
    sibling servers machine-wide (`src/sibling-mcp.ts:72-139`) [read].
12. `precompact.mjs:7` says "<2KB"; `snapshot.ts:470` has no byte budget. `snapshot-consumed` claims bytes "injected"
    that the compact path never injects [ran].
13. SSRF classifier misses 100.64.0.0/10 and hex IPv4-mapped IPv6 (`::ffff:7f00:1`) (`src/server.ts:3151-3277`) [read].

## 9. Evidence

All artifacts are under the session scratchpad
`/tmp/claude-0/-home-user-Continuous-Claude-v3/fa760726-cdc3-51c8-9ce9-3aa69afb933c/scratchpad/`. **That directory is
ephemeral; copy what you want to keep into `.claude/cache/e2e/`.**

| What | Path |
|---|---|
| Notes per agent | `notes/cm-{server-exec,store-search,hooks,session,trust}.md`, `notes/ccv3-{surfaces,levers}.md`, `notes/probe-{hooks,mcp,tests}.md`, `notes/w3-{cache,refute-reduction,refute-risks,steal}.md`, `notes/w4-critic.md` (w3-cache's agent had read-only tools; the synthesizer saved its inline findings to `notes/w3-cache.md`) |
| Hook probe | `probe/hooks/` (`run-probe.mjs`, `run-resume.mjs`, `results.json`, `raw/`, `raw-resume/`) |
| MCP probe | `probe/mcp/` (`step1.mjs`, `step2.mjs`, `tools-list-bun.json`, `transcripts/`, `responses/`, `workloads/`, `stats-output.txt`) |
| Steelman re-run | `probe/w3/` (`step3.mjs`, `step4.mjs`, `step5.mjs`, `step3*-results.json`, `responses/`) |
| Risk refutation | `probe/w3r/` (isolated-HOME boot runs, `c6.mjs`, `cc-strings.txt`) |
| Upstream tests and build | `probe/vitest.log`, `probe/build.log`; bundle comparison in `work/` |

Method: shallow clone of `mksglu/context-mode` v1.0.169 (HEAD `8de5f73`, 2026-10-10). Probes ran on Linux, Node 22.22,
with Bun for the server; Dave's Windows/node path was emulated only for the boot test. Claude Code behaviour was read
from the installed 2.1.296 binary, not live-fired. Five of seven readers and the test-suite probe ran on the Sonnet tier. The hooks and CCv3-surface readers, the hook and MCP
probes, all four verifiers, the synthesizer and the critic ran on the Opus tier. CCv3 `git status` was unchanged after every probe. One side effect: a phase-1 probe wrote
outside its throwaway HOME, into `/root/.claude/context-mode/` and planted `/root/.claude/hooks/context-mode-cache-heal.mjs` (container only, not Dave's machine; nothing registered it). That is the §5 boot write reproducing itself. Dollar figures use
Opus-tier list prices [docs: platform prompt-caching]; token figures use 3.6 chars/token, and CCv3's bytes/4 has run 37%
low against `/context`.
