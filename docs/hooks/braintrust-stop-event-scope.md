# Scope: move `braintrust_hooks.py stop` to the `Stop` event

Status: **SHIPPED** in `ccdd14b` (2026-08-11). Both prerequisite facts (§3) were established first
and both came back favourable: `Stop` and `UserPromptSubmit` are serialized (§3.1), and Braintrust
tolerates a parent span arriving after its children (§3.2) — so what shipped was the small version,
a deletion plus a registration, with no locking and no spool reordering.
Companion to the shipped shutdown fix (`5abcb64`).

Read §1 and §2 as the historical problem statement. §3 is the evidence, §4-§7 record what was
decided and what was deliberately left out.

## 1. The defect (as it stood before `ccdd14b`)

`braintrust_hooks.py stop` was registered under **SessionEnd** only. There was no `Stop` key in
`settings.json` at all. But the function is written for per-turn incremental work — its docstring
says "creates LLM spans for model calls within the turn", and it tracks `turn_last_line` so each
call resumes where the last one stopped.

Running it once per session instead of once per turn meant every turn span except the last was
opened and never closed.

Measured across the full hook log (1,637 sessions with a recorded end):

| | |
|---|---|
| Turns those sessions report | 8,726 |
| `Turn finalized` log lines | 1,116 |
| **Turn spans never finalized** | **7,610 (87%)** |

Those spans are open-ended in the Braintrust UI, which computes an unbounded duration for each.

Do not confuse this with the 11% figure from the shutdown fix. That measured `stop` *invocations*
that failed. This 87% is structural: the hook is not invoked often enough in the first place.

A second consequence: an entire session's LLM spans are built in one pass at shutdown. That is
what produced the real 94-span / 19.4 MB batch that hit Braintrust's 10 MiB cap.

## 2. Why it is blocked

`load_session_state` / `save_session_state` read and rewrite the **whole** per-session JSON
(`braintrust_hooks.py:142-146`). `set_session_value` is therefore a read-modify-write of the
entire dict, and `save_session_state`'s `os.replace` makes the *write* atomic but not the
read-modify-write pair. Two processes racing produce last-writer-wins across **every key**, not
just the one being set.

Current writer map (generated from source):

| Key | Writers |
|---|---|
| `current_turn_span_id` | `stop`, `user_prompt_submit` |
| `turn_count` | `session_start`, `user_prompt_submit` |
| `turn_last_line` | `stop` |
| `root_span_id`, `project_id`, `sampled_out`, `started` | `session_start` |

`post_tool_use` only ever **reads**, so subagent tool calls — which do run concurrently — are not
writers. That is what keeps the blast radius small.

Today `stop` runs once, at shutdown, after the last `user_prompt_submit`. No overlap is possible,
so no race exists. The concern was that registering it on `Stop` creates one: `stop`'s own duration
(transcript parse plus a network POST — measured at up to 8s) overlapping the next
`user_prompt_submit` if the user types immediately. A slow `stop` for turn N would rewrite the whole
state dict from a snapshot taken before turn N+1 began, discarding the `current_turn_span_id` and
`turn_count` that `user_prompt_submit` had already written.

**§3.1 falsified this.** The CLI serializes the two events — `UserPromptSubmit` does not fire until
every `Stop` hook has returned, measured against a 90s hold. The read-modify-write hazard above is
real in the code but unreachable in practice for this pair, which is why the move is small. Treat
the serialization as an **undocumented CLI behaviour that could change on upgrade**, not as a
guarantee: the mitigation in §4 is a deletion, so it costs nothing to keep.

## 3. Two facts, both now established

Both were cheap and neither required touching production behaviour. The original plan **assumed**
both; that assumption is what moved this change out of the shipped work. Neither assumption turned
out to be wrong, but that was not knowable in advance — and 3.2 in particular was guarding against a
change several times this one's size.

**3.1 — Can `Stop` overlap the next `UserPromptSubmit`? — NO, they are serialized.**
Verified 2026-08-10, interactive session `127aa175`. Claude Code's ordering guarantee between these
events is documented nowhere in this repo, so it was established empirically rather than assumed.

Harness: `~/.claude/state/order-probe.mjs`, a throwaway hook registered on both events in the
**active** `~/.claude/settings.json` only — never the repo copy — appending
`{event, pid, session_id, ts_start, ts_end, hold_ms}` to a JSONL. The `Stop` arm slept for a fixed
hold, gated on a sentinel file so an unarmed session paid nothing. It created the first `Stop`
entry this machine has ever had, which incidentally confirmed that **`Stop` does fire once per
turn**. Torn down after the run: no registration remains and no `Stop` key exists. Raw rows are not
in the repo; the table below is the record.

Method. Asking a human to "type fast" does not work — reply latency swamped the window twice (29.8s
and 130s against 6s and 15s holds). The fix was to make the hold longer than any plausible reply and
then **vary it**, so the verdict reads off which variable the prompt timestamp tracks: the hook, or
the human.

| Hold | `stop` actual | Next `user_prompt_submit` fired | Inside window? |
|---|---|---|---|
| 6,000ms | 6,004ms | +29,792ms | no — user away, uninformative |
| 15,000ms | 15,006ms | +130,017ms | no — user away, uninformative |
| **90,000ms** | 90,011ms | **+90,444ms** (433ms after end) | **no** |
| 40,000ms | 40,014ms | +1,045,457ms | no — user away, uninformative |
| **40,000ms** | 40,011ms | **+40,327ms** (316ms after end) | **no** |

The two informative rows are the ones where the user typed within seconds. In both, the prompt hook
fired a few hundred ms after the hold ended, at two different hold values. The timestamp tracks the
hook's duration, not the keystroke — the CLI does not fire `UserPromptSubmit` until every `Stop`
hook has returned. Zero overlaps in five held runs.

Scope of the claim: same session, one machine, one Claude Code build, single hook on `Stop`. It
measures when the *hook process* starts, which is exactly the quantity the §2 race is about — two
hook processes writing one state file. **Concurrent sessions still overlap** (11 sessions were
observed interleaving in the same JSONL), but they write different per-session state files, so
they do not contend.

**3.2 — Does Braintrust tolerate a parent span arriving after its children? — YES.**
Verified 2026-08-09 against scratch project `ccv3-scratch-probe`
(`46578eb1-bfdf-4c09-8f66-6182428c6c1b`), never `claude-code`/`e33fbd8b`. Posted root, then a
child carrying `span_parents: [parent]` for a span that did not exist yet, then 3s later the
parent. All three POSTs returned HTTP 200; the child was accepted with a dangling parent
reference rather than rejected. On read-back all three rows were visible on the first fetch with
`span_parents` and `root_span_id` stored verbatim, so the hierarchy resolves from the fields
themselves rather than from arrival order.

Scope of the claim: this proves the ingest and storage layer preserves the linkage. Braintrust
builds the tree from `span_parents`/`root_span_id` at read time, so the UI follows — but the UI
rendering itself was not separately inspected.

Consequence: **the spool does not need parent-before-child ordering.** The materially larger
change §3.2 was guarding against is not required. Repro script kept out of the repo (it needs the
live API key); it is 90 lines and reconstructible from this paragraph.

## 4. Design options

**Option A — remove the contention instead of locking it (recommended, and now reduced).**
Stop having `stop` write `current_turn_span_id`. It only ever sets it to `""`; let
`user_prompt_submit` own that key exclusively, since it is the one that assigns a real value. This
deletes the only two-writer key outright. `turn_last_line` then has a single writer (`stop`).
Cost: between turns, a `post_tool_use` span could attach to the previous turn rather than none.
That is a minor and arguably more correct attribution.

**The locked merge originally bundled into Option A is no longer required.** It existed to close the
whole-dict clobber, and §3.1 shows the only two processes that could collide never overlap. Ship the
deletion without it — the deletion is what makes the design safe rather than the lock. If a future
CLI upgrade breaks serialization, the lock is the ready-made answer and is written up in Option B.

**Option B — lock everything.** *(deferred, not rejected)*
Put every `set_session_value` behind a per-session lock reusing the spool's helpers
(`_acquire_spool_lock` / `_release_spool_lock`). Correct, but adds a lock acquisition to
`post_tool_use`, the hottest hook in the system (5000ms budget, fires on every tool call) — for a
race §3.1 shows cannot currently occur. Revisit only if the §3.1 probe stops reproducing.

**Option C — per-key state files.**
Eliminates whole-dict clobber structurally. Rejected: it multiplies file count in a directory that
already needed a pruning fix, for a problem Option A solves with a deletion.

## 5. Cost and risk of the move itself

- `Stop` fires after **every** assistant turn, so this adds one Python process spawn per turn.
  Measured spawn latency on this machine is p50 814-2167ms when degraded, and it lands at the end
  of a response where the user is waiting. Mitigation: the work is incremental (`turn_last_line`),
  and the POST already spools rather than blocking.
- **Do not register on `SubagentStop`.** Subagents dominate hook firings here; adding it would
  multiply invocations for little trace value. Deliberate exclusion.
- Trace shape in Braintrust changes going forward: turn spans become real per-turn spans instead of
  one session-long open span. Historical traces are unaffected but will not match new ones.

## 6. Work breakdown — all five steps done in `ccdd14b` (2026-08-11)

1. ~~Probe hook for 3.1; scratch-project probe for 3.2.~~ **Done 2026-08-09/10, recorded in §3.**
   Both answers came back favourable, which is what reduced steps 2-5 to the small version.
2. ~~Option A: drop `current_turn_span_id` from `stop`'s writes. No lock — see §4.~~ **Done.**
   One consequence surfaced only on execution: clearing that key was *also* the re-entry guard, so
   `stop` gained an explicit early return ("already finalized") when the transcript has no new
   lines. A deletion can remove a second, undocumented behaviour riding on the same line.
3. ~~Register `Stop` in **both** `settings.json` copies (atomic Node read-modify-write, not the
   Edit tool), timeout 15000.~~ **Done.** Nothing was removed from SessionEnd — `stop` stays there
   too as a safety net for an abrupt exit mid-turn, which the step-2 idempotence makes free. The
   throwaway §3.1 probe was unregistered first; no probe remains in either copy.
4. ~~Tests in `braintrust-hooks-shutdown.test.ts`.~~ **Done — 3 guards, 12 tests in that file**,
   each demonstrated failing against the pre-change hook via `BT_HOOK_PATH`. The concurrent-writers
   test was dropped as planned: §3.1 shows that concurrency does not occur, so it would assert
   against a fiction.
5. ~~Verify live.~~ **Done.** `=== STOP HOOK CALLED ===` incremented on a turn boundary,
   `turn_last_line` appeared in session state, and `current_turn_span_id` held the NEW turn's id
   rather than `""`. The first such run finalized with status `split`, because a session's
   accumulated backlog exceeded the 10 MiB cap in one pass — expected once, and precisely what
   per-turn finalization prevents from recurring.

## 7. Rollback

Remove the `Stop` block from both `settings.json` copies. The hook code stays backward compatible:
it runs correctly when invoked once at SessionEnd, which was the production behaviour before
`ccdd14b` and remains the SessionEnd safety-net path today.
