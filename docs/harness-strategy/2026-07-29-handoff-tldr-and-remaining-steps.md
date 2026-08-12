# Handoff → next session: TLDR/token-savings, then plan Steps 8–10

Written 2026-07-29 by session `b9978324`. Tracked in git deliberately —
`thoughts/` is gitignored and this must survive the machine.

Continues `docs/harness-strategy/2026-07-28-plan-repair-with-ratchet.md`
(the plan, commit `d2a1c79`, amended through `5d061d5`).

**Everything marked VERIFIED was verified by running it.** REPORTED means
inferred and not yet confirmed. Treat the distinction as load-bearing — in this
session's lineage, four confidently-stated claims turned out wrong, including
two of my own. They are listed at the end so you can see the shape of the
mistake rather than just be told to be careful.

---

## START HERE

```
node scripts/coordination/lane.mjs board
```

`fork/agentic-os` is at **`305e391`**, divergence `0 0`. Ten commits shipped
this session. The `harness-repair` lane is held by `b9978324` and will lapse —
claim it or open a new one.

**Use the PowerShell tool for shell work.** The MSYS fork storm killed several
Bash calls this session (`add_item ... errno 1`). Commits go through
`pwsh -File scripts/git-safe.ps1 -C <repo> commit -F <msgfile>`; it recovered a
real MSYS crash on attempt 2 twice today.

**Measuring exit codes:** `node script.mjs 2>&1 | Select-Object -First 4` gives
you `$LASTEXITCODE` from `Select-Object`, **not** from node. It misreported a
guard as passing this session. Use `node script.mjs *> $null; $LASTEXITCODE`.

---

## THE JOB — TLDR and the token-saving systems

Dave's request, verbatim: *"We need to investigate tldr and the token saving
systems."* Lane `tldr-token-savings` is seeded.

**The question that matters:** is the token saving real, and is it larger than
what the machinery costs? Step 6 measured the hook layer at **~1s per tool
call**; the TLDR path adds hooks to that, and `smart-search-router` is a live
*denier* that blocks Grep and forces a retry. A saving that costs a second per
call and a blocked-then-retried search may be negative.

**Do NOT accept a savings figure that is not measured on real turns.** The
entire Q3 refutation this session was exactly that mistake: per-hook latency
measured with `tool_name:"__probe__"` payloads that trip each hook's first
guard, reported as per-turn cost, and wrong by a factor of ~4.

### What is already known, VERIFIED unless marked

| fact | status |
|---|---|
| `tldr-context-inject.ts` and `tldr-read-enforcer.ts` both import `daemon-client` | VERIFIED |
| `daemon-client` is one of **4 library modules in the dead set** — registered by nothing, alive only because esbuild inlines it (11 importers) | VERIFIED |
| `smart-search-router` is a live PreToolUse denier; it has suggested a banned `Explore` spawn and a Windows-broken `rg` fallback | REPORTED (`hook-auto-execute.md`) |
| codegraph + Serena were CUT 2026-07-24 for near-zero adoption, with TLDR named as the surviving path | VERIFIED (rule text) |
| the `95% token savings` claim in `.claude/rules/tldr-cli.md` has **no measurement behind it anywhere in the repo** | VERIFIED (searched) |
| TLDR hooks fire on Read/Edit/Grep — 6, 13 and 6 hooks per call respectively | VERIFIED (Step 6 census) |

### Suggested approach

1. **Find the consumer.** Does anything read TLDR's output, or does it inject
   context nobody uses? `intel-bus.jsonl` is the file that settled the
   equivalent question for `agent-recall-injector` — it was measured as fresh
   and never queried, and querying it overturned the finding.
2. **Measure both sides.** Tokens saved vs. tokens injected vs. seconds added.
   `scripts/hooks/measure-fanout.mjs` and `hook-latency-sampler.ps1` exist and
   are documented; reuse rather than rebuild.
3. **Check the denier's cost.** How often does `smart-search-router` block, and
   what does the retry path cost? A block that leads to a worse search is a
   negative saving that no token count will show.
4. **`/context` still has never been run.** Every token number in the plan is
   modelled, not measured. This is the cheapest way to get one real number.

---

## THEN — plan Steps 8, 9, 10

Full acceptance criteria are in the plan doc; summary:

- **Step 8 — context lever.** `claudeMdExcludes` in `settings.local.json`.
  Accept on a `/context` memory-file count delta (~95 → ~49) **and** an
  unchanged count in a project with no rules dir. The originally proposed guard
  was vacuous — it ran in `agent-arch`, which has no `.claude/rules` at all, so
  it could never fail.
- **Step 9 — `paths:` frontmatter on the 13 tool rules, in USER scope.** Keep
  user scope; gate the *project* copy. The proposal's step 3 was **inverted** —
  18 of 19 projects have the user copy as their only copy of the 5 safety rules.
- **Step 10 — prune. LAST.** Step 6 changed what this is *for*: it is **not**
  worth doing for latency (the quiet hooks are 64–87ms against ~1s dominated by
  two processes). If it is worth doing, it is for correctness surface and
  comprehensibility — scope it that way. `agent-recall-injector` is **off** the
  delete list (163/276 injecting, not 0/339).

**Step 7 is decided-pending-Dave, not done.** Braintrust tracing costs
**~640–690ms per tool call**, with a ~264ms floor that remains even when
disabled. Deregistering the hook entirely saves the full ~955ms. Dave chose to
**fix rather than cut**, so nothing was disabled — but the number is on the
table if latency becomes the priority.

---

## What shipped this session

| commit | what |
|---|---|
| `c77f85c` | the file-claim lock that called a working session dead — 13 sites, not the 7 the handoff listed |
| `189fb46` | the blocklist updater that failed 28 times and reported success |
| `fd906dd` | 16 hooks that exited 0 and said nothing; 8 dangling stdin timers (1060ms → 52ms) |
| `632b9fd` | Step 0 config capture + Step 2 registration ratchet |
| `96e63d0` | Step 6 — hook layer costs ~1s/tool call, and it is 2 processes |
| `5d061d5` | Step 7 — tracing costs ~690ms; blocklist bounded (first success in 28+ runs) |
| `2542561` | Braintrust scoring: 4 stacked defects; live score names 1 → 5 |
| `305e391` | a guard that asserts the scoring layer CAN emit, and did |

### Guards now in place — run these

```
node scripts/coordination/liveness-predicate-guard.mjs
node scripts/hooks/hook-contract-guard.mjs
node scripts/hooks/registration-reconcile.mjs
node scripts/hooks/braintrust-emit-guard.mjs [--live]
node scripts/coordination/claim-sql-probe.mjs
bash scripts/audit-braintrust-emits.sh
```

All green at `305e391`. **Every one has been made to fail on purpose and
recover** — that is the only reason to believe a green run.

---

## Open, and honestly unfinished

- **`agent_task_success` is wired but NOT verified end-to-end.** It fires only
  on a real Ralph task transition, which this session had no occasion to
  produce. Everything around it is verified; this one is inference.
- **`session-end-cleanup.ts` reads `BRAINTRUST_API_KEY` from `process.env`
  directly**, loads no `.env`, and does not import the shared helper. Same
  defect-1 shape, not fixed, not verified as broken. Cheap to settle.
- **The 3 SessionEnd hooks still emit the discarded envelope** by design, named
  in `hook-contract-guard`'s allowlist with reasons. Revisit only if SessionEnd
  output turns out to be read after all.
- **`CCv3-Blocklist-Update` commits on whatever branch is checked out**, then
  pushes `fork main`. On this branch it would commit to `agentic-os` and push a
  stale main. VERIFIED by reading the wrapper; deliberately not changed — it
  needs a decision, not a patch.
- **80 of 85 registrations put `timeout` in milliseconds in a field Claude Code
  reads as seconds** (`5000` = 83 minutes). REPORTED, not re-verified. If true,
  no hook has effective timeout protection.
- **`/context` has never been run.** Every token figure is `bytes/4` or a
  modelled reconstruction.

---

## Four claims that were confidently wrong — the shape to watch for

Not a warning to be careful. A pattern: **every one was a query narrower than
the question, returning a number that looked like an answer.**

1. **The handoff's "7 sites, VERIFIED by Select-String".** There were 13. The
   pattern was `make_interval`, so it missed every site spelled
   `INTERVAL '5 minutes'` — including `cleanup_sessions.py`, which **DELETEs**.
2. **My own Codex-mirror date count.** Reported "0 files ≤ 2026-05-04" because I
   compared against files stamped `2026-05-04 19:32`. Re-measured before
   reporting; the real split is 99/1/3.
3. **Q3 and Q4, refuted by their own adversaries.** Q3 read
   `TRACE_TO_BRAINTRUST` from the process env when the script loads `.env` into
   `os.environ` first. Q4 read the field for one of two injection paths and
   concluded 0-for-339 when the real number was 163/276 — and that hook was the
   #1 delete candidate.
4. **My own new guard, caught by its own negative control.** It tested for the
   presence of the string `loadClaudeDotEnv`, which its own function definition
   satisfies. It passed after the loader was gutted. It would have shipped as a
   second silent guard if I had trusted the green run.

**The operational rule:** before believing a count, ask what would make it read
zero — or read short — other than the truth. Then make the guard fail on
purpose. Number 4 is the argument: I wrote that guard *specifically* to catch
this defect class and still reproduced it inside the guard, and only the
negative control caught it.
