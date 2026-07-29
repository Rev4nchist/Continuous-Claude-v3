# TLDR and the token-saving systems — measured

Session `5d7e7343`, 2026-07-29. Lane `tldr-token-savings`.
Answers Dave's question: *"is the token saving real, and is it larger than what
the machinery costs?"*

**VERIFIED = I ran it and read the output. REPORTED = inferred, not confirmed.**

---

## Verdict

**The compression is real. The saving is not. Right now the machinery is a
large net negative.**

The `95% token savings` claim is *accurate as a compression ratio* — measured
95.7%. It is not a token saving, because in 23 of 27 real interceptions the
model came back and read the content anyway. And the cost side is far worse
than the plan assumed: with the daemon down — which is its state right now —
these three hooks cost **26–63 seconds per tool call** and have **no timeout
protection**.

| | measured |
|---|---|
| compression when it fires | **95.7%** (claim: 95%) — VERIFIED |
| how often it fires | **27 times in 1,257 reads** = 2.1% — VERIFIED |
| denies where the saving held | **4 of 27** (14.8%) — VERIFIED |
| `tldr-context-inject` injections observed | **0**, one month, all projects — VERIFIED |
| router denies where its suggestion was taken | **0 of 16** — VERIFIED |
| cost per Task call (daemon down) | **63s**, returns `{}` — VERIFIED |
| cost per Grep call (daemon down) | **26s**, returns `{}` — VERIFIED |
| cost per Read (daemon down) | **31.6s**, still blocks, returns 1 function name — VERIFIED |
| timeout protection | **none** — `timeout` is seconds, so `30000` = 8.3h — VERIFIED |

---

## Corpus — why the obvious measurement is wrong

My first probe walked every code file on disk and reported **99.7% savings**.
That number is garbage. The walk excluded `node_modules` but not `.venv`, so it
was dominated by 5MB minified `plotly.min.js` bundles in site-packages.
"Blocking" a file nobody would ever read is a saving of zero real tokens that
reports as ~100%.

The corpus that answers the question is what sessions *actually* Read.
`scripts/hooks/tldr-read-corpus.mjs` extracts it from the transcripts:

```
transcripts        512          (2026-06-29 → 2026-07-29, one month)
total_read_calls  1257
distinct_paths     596
```

**My second probe was also wrong, and its own ground truth caught it.** It
replayed those real paths as *full* reads, stripping the `offset`/`limit` the
real calls carried — which bypasses the enforcer by design. That inflated
interception to 34.4%. The transcripts say 2.1%. The correction is written into
`tldr-savings-probe.mjs` so it cannot mislead the next session. Same shape as
the four failures in the previous handoff: a query wider than the question,
returning a number that looked like an answer.

---

## Finding 1 — the enforcer blocks rarely, and mostly doesn't stick

27 real denials in one month. VERIFIED two independent ways: a transcript
parser counting `tool_result` blocks carrying the deny marker, and a raw grep
classified by block type. Both give exactly 27. The 48 raw line-matches and the
546 hits for `95% token savings` are contaminated — they are mostly the hook's
*own source file* being read into transcripts.

Denials are spread evenly across the whole month (1–3/day), so this is a steady
rate, not a recently-enabled hook.

What happened after each deny (`scripts/hooks/tldr-deny-followup.mjs`):

```
SUBSTITUTED   4   file never read again — saving is real
PARTIAL      16   re-read with offset/limit — partial saving
DEFERRED      7   re-read in full later — tokens came back
```

**85% of the time the model came back for the content.** So the 95.7%
compression is mostly re-spent, plus the summary, plus the extra turns. I have
deliberately *not* multiplied 95.7% × 27 into a headline token number — that
product would be exactly the kind of figure this investigation exists to refute.

## Finding 2 — the daemon fails silently, expensively, and is failing now

The TLDR daemon (`python -m tldr.daemon`, started 07:30 today) is a **zombie**:
the process is alive, but port 58740 refuses connections. Meanwhile
`.tldr/status` still reads `ready` and `.tldr/daemon.pid` still holds its pid.
**Any health check reading that status file reports a healthy daemon that is
dead** — the vacuous-gate class again.

The difference is not subtle. Same file, same hook:

| daemon | latency | result |
|---|---|---|
| up (earlier today) | ~1.2s | full structure summary |
| down (now) | **31.6s** | **still blocks**, returns *one* function name |

Blocked, 31 seconds, one function name, for a 12.7KB file. That is strictly
worse than having no hook at all — the failure mode is not "fall back to a
normal read", it is "deny anyway, slowly, with almost nothing".

## Finding 3 — `tldr-context-inject` has never injected anything

Registered on `Task`. Across **one month of transcripts in every project**, the
marker `## TLDR Context` appears 6 times — and all 6 are the hook's own source
code being read as file content (one of them is my own Read this session). Zero
real injections.

Run directly with a realistic Task payload it returns `{}` after **33s cold,
63s warm, three runs consistent**. Every subagent spawn pays that.

## Finding 4 — no timeout protection (settles a REPORTED item)

The previous handoff flagged this as REPORTED. It is now **VERIFIED** from the
repo's own `docs/hooks/README.md:211` — *"**timeout**: Max execution time in
seconds"*, with documented examples of 10/20/30/60.

Live registrations:

| hook | registered | actual meaning |
|---|---|---|
| `tldr-context-inject` | `5000` | 83 minutes |
| `smart-search-router` | `30000` | 8.3 hours |
| `tldr-read-enforcer` | `30000` | 8.3 hours |

So nothing kills these runs. The 26–63s costs are paid in full. This
generalises: the handoff's "80 of 85 registrations" item is a real, live defect.

## Finding 5 — the router blocks Grep, and its suggestion is never taken

`smart-search-router` denied a real Grep **15–16 times** in the month (15 by
`tool_result` block count, 16 by in-sequence deny events — I did not reconcile
the one-event gap, so treat it as ~15). Its deny tells the model to use
`ast-grep` or `/tldr-search` instead.

What the model actually did next:

```
Read           6
Grep again     4
PowerShell     2
Bash           2
Edit           1
(nothing)      1
followed the suggestion:  0
```

**Zero adoption.** In 16 blocks the suggested route was taken exactly never —
the model most often just Read the file instead, or retried the same Grep. So
the router's cost is a blocked turn plus its latency, and its benefit is
unobserved. This is the "blocked-then-retried is a negative saving no token
count will show" case the previous handoff predicted, now measured.

## Finding 6 — two smaller ones

- **The escape hatch doesn't work.** The deny message says *"To read full file
  anyway, use: `Read sessions.ts`"*. A bare relative path does pass the hook
  (VERIFIED — returns `{}`, because `statSync` fails and it falls through), but
  Claude Code's Read tool requires an **absolute** path. So the only advice the
  hook gives for getting the file is advice the model cannot follow. The real
  bypasses are `offset`/`limit`, which the message mentions second.
- **`edit-context-inject.ts` is dead.** Registered in no settings file
  (VERIFIED across all four). It survives only in health-check caches.

## Finding 7 — the exclusion list is inverted for this repo

`ALLOWED_PATTERNS` bypasses `.claude/hooks/` and `.claude/skills/` entirely. In
*this* repo that is most of the code we actually work on. Measured consequence:
a **457KB** file in `.claude/skills/` passed straight through, while third-party
`.venv` code got intercepted. The hook is aimed away from the code that matters
here.

---

## Recommendation

Ordered by confidence, not by size.

1. **Deregister `tldr-context-inject` now.** Zero observed value in a month,
   ~63s per Task call, no timeout. This one is not a judgement call.
2. **Fix the timeout units** across all registrations (the wider 80-of-85
   item). Until then no hook has any bound.
3. **Make the enforcer fail open.** If the daemon is unreachable it must
   `{}`-through to a normal read, not deny with a stub after 31 seconds. This is
   the single change that converts the worst failure mode into a no-op.
4. **Fix `.tldr/status`** so it reflects a probe, not a startup stamp — or stop
   trusting it. It currently reports `ready` for a dead daemon.
5. **Then decide on the enforcer on merit.** With 1–3 done it costs ~1.2s and
   fires ~27×/month, and 4-in-27 of those are genuine wins. That is a much
   smaller question than it looked, and it should be decided on the *repaired*
   numbers, not these.

Not recommended: deleting the enforcer outright. The compression is real and the
daemon-up path works; the defects are in failure handling and targeting.

---

## Tools added

| script | what |
|---|---|
| `scripts/hooks/tldr-read-corpus.mjs` | extracts the real Read distribution from transcripts |
| `scripts/hooks/tldr-savings-probe.mjs` | replays a corpus through the real hook; savings vs latency |
| `scripts/hooks/tldr-deny-followup.mjs` | classifies what happened after each real deny |

All three read live state. None of them assert a pass/fail, so none is a guard —
they are measurements, and they should be re-run rather than quoted.

## Still open

- **Whether the daemon dies routinely or died once today.** I caught one death.
  One observation is not a rate. `.tldr/` holds no daemon log to reconstruct it.
- **I did not restart the daemon.** State left as found, deliberately — the
  zombie is evidence, and restarting it would have destroyed the only live
  instance of the failure mode.
- **The 15-vs-16 router deny gap** is unreconciled (two counting methods, one
  event apart). It does not change the finding — zero adoption either way — but
  I did not chase it.
- **The `/context` measurement still has never been run.** Every token figure
  here is `bytes/4`, labelled as such in the tooling.
