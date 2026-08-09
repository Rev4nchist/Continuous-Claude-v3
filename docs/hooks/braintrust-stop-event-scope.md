# Scope: move `braintrust_hooks.py stop` to the `Stop` event

Status: **scoped, not started.** Blocked on two facts that must be established first (§3).
Companion to the shipped shutdown fix (`5abcb64`).

## 1. The defect

`braintrust_hooks.py stop` is registered under **SessionEnd**. There is no `Stop` key in
`settings.json` at all. But the function is written for per-turn incremental work — its docstring
says "creates LLM spans for model calls within the turn", and it tracks `turn_last_line` so each
call resumes where the last one stopped.

Running it once per session instead of once per turn means every turn span except the last is
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
so no race exists. **Registering it on `Stop` creates one.** The window is `stop`'s own duration
(transcript parse plus a network POST — measured at up to 8s) overlapping the next
`user_prompt_submit` if the user types immediately. A slow `stop` for turn N can rewrite the whole
state dict from a snapshot taken before turn N+1 began, discarding the `current_turn_span_id` and
`turn_count` that `user_prompt_submit` had already written.

## 3. Two facts to establish first

Both are cheap and neither requires touching production behaviour. The original plan **assumed**
both; that assumption is what moved this change out of the shipped work.

**3.1 — Can `Stop` overlap the next `UserPromptSubmit`?**
Claude Code's ordering guarantee between these events is not documented in this repo and was not
verified. Establish it empirically: register a throwaway probe hook on both events that appends
`{event, pid, ts_start, ts_end}` to a JSONL, run a session with deliberately fast turns, and look
for overlapping intervals. If they are strictly serialized, most of §4 collapses to a no-op and
the change becomes small.

**3.2 — Does Braintrust tolerate a parent span arriving after its children?**
The durable spool can now delay a batch, so a turn-N parent can land after turn-N+1 children.
Establish it against a scratch project: POST a child referencing a parent id, then POST the parent,
then read the trace back and confirm the hierarchy resolved. If it does not tolerate this, the
spool needs parent-before-child ordering, which is a materially larger change.

## 4. Design options

**Option A — remove the contention instead of locking it (recommended).**
Stop having `stop` write `current_turn_span_id`. It only ever sets it to `""`; let
`user_prompt_submit` own that key exclusively, since it is the one that assigns a real value. This
deletes the only two-writer key outright. `turn_last_line` then has a single writer (`stop`), so
the remaining exposure is only the whole-dict clobber, which is fixed by making
`set_session_value` merge under the same lock helper the spool already uses
(`_acquire_spool_lock` / `_release_spool_lock`, per-session lock file).
Cost: between turns, a `post_tool_use` span could attach to the previous turn rather than none.
That is a minor and arguably more correct attribution.

**Option B — lock everything.**
Put every `set_session_value` behind a per-session lock. Correct, but adds a lock acquisition to
`post_tool_use`, the hottest hook in the system (5000ms budget, fires on every tool call). Rejected
unless 3.1 shows genuine overlap that Option A does not cover.

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

## 6. Work breakdown

1. Probe hook for 3.1; scratch-project probe for 3.2. Record both in this doc.
2. Option A: drop `current_turn_span_id` from `stop`'s writes; add a locked merge to
   `set_session_value` reusing the spool lock helpers.
3. Register `Stop` in **both** `settings.json` copies (atomic Node read-modify-write, not the Edit
   tool), timeout 15000. Remove nothing from SessionEnd — `session_end` still closes the root span.
4. Tests in `braintrust-hooks-shutdown.test.ts`: concurrent `stop` + `user_prompt_submit` against
   one session file loses no key; `turn_last_line` advances monotonically across N turns.
5. Verify live: `grep -c "=== STOP HOOK CALLED ==="` increments **more than once per session**, and
   the `Turn finalized` count matches the session's turn count instead of being 1.

## 7. Rollback

Remove the `Stop` block from both `settings.json` copies. The hook code is backward compatible —
it already runs correctly when invoked once at SessionEnd, which is the current production
behaviour.
