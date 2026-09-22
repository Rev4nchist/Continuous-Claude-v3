# Cross-Session Messaging — Review + Integration Plan

Date: 2026-08-10
Source: https://code.claude.com/docs/en/cross-session-messaging
Status: **BLOCKED on platform.** Native Windows is not supported.

## 1. Verified facts

| Check | Result | Evidence |
|---|---|---|
| CLI version requirement (>= 2.1.224) | **PASS** | `claude --version` -> `2.1.225` |
| OS support | **FAIL** | Doc: "Claude Code doesn't offer cross-session messaging on native Windows." Machine is Windows 11 native |
| Inbox socket bound | **No** | `CLAUDE_CODE_MESSAGING_SOCKET` is empty in a Bash-tool child process. The doc says it is exported to every hook and Bash command before `SessionStart` when the feature is on |
| WSL 2 present | Yes, stopped | `wsl -l -v` -> `Ubuntu (Stopped)`. WSL 2 **is** a supported platform |
| Provider | OK | Anthropic first-party, not Bedrock/Vertex/Foundry |

### Phase 0 result — confirmed absent, 2026-08-10

Four independent probes, all negative:

1. `/list-agents` was **not intercepted** by the harness. It arrived in the conversation
   as plain user text. That is the documented "isn't recognized" signature.
2. **No `ListAgents` tool exists.** `ToolSearch "select:ListAgents"` -> "No matching
   deferred tools found".
3. **`SendMessage` is the subagent-only flavor.** Its live schema says
   `to` = "Recipient: teammate name", accepting a teammate name or `"main"` (background
   subagent -> main conversation). There is no peer-session address, no reply address, no
   cross-machine notion. Subagent and agent-team messaging works; peer messaging does not
   exist here.
4. `CLAUDE_CODE_MESSAGING_SOCKET` unset; no peer/socket registration artifacts under
   `~/.claude`.

Conclusion: the feature cannot be turned on here today. Nothing to enable, nothing to
configure that would take effect. Re-run probes 1 and 2 after any CLI minor bump.

## 2. What the feature actually is

- Two tools: `ListAgents` (discover reachable sessions) and `SendMessage` (deliver text
  by name). Claude calls both itself; the human never does.
- Payload is **plain text only**. No history, no files, no structured protocol.
- Same machine: per-session Unix domain socket, never through Anthropic servers.
- Other machines / web: through Anthropic servers over Remote Control, and **reply-only**
  — a local session cannot open a conversation with a remote one.
- Delivery is mid-turn: the receiver reads the message between tool calls, or starts a
  new turn if idle.
- A delivered message **costs tokens like a typed prompt**.
- Inbound outcomes are `delivered` / `held` / `refused`, governed by `crossSessionInbound`.
- Caps: 100 held messages, 50 accepted-and-unread, per-sender rate limiting, duplicate
  suppression.

## 3. We already built this

`scripts/coordination/lane.mjs` + the `lane-context` hook are a working equivalent.

| | Anthropic cross-session messaging | Our lane bus |
|---|---|---|
| Transport | Per-session UDS socket | PostgreSQL `agentic_os.lane_event` |
| Addressing | Session name (`myapp-3f`) | Session-id prefix (`--to 75bf62ab`) |
| Broadcast | No — one named target | Yes (`say` with no `--to`) |
| Read model | Push, mid-turn | Pull, watermark (`lane_watermark`) |
| Delivery point | Between tool calls | `SessionStart` (full) + `UserPromptSubmit` (delta) |
| Cross-machine | Remote Control, reply-only | Any session on the shared DB, both directions |
| Windows | **Unsupported** | Works |
| Token cost | Charged as a prompt | Free (hook-injected context) |
| Durability | In-memory, dropped when capped | Durable rows, replayable |
| Work coordination | None | Lanes, leases, file claims |

Our version is better on durability, broadcast, cross-machine symmetry, and it is the
only one that runs here. Theirs is better on exactly one axis.

## 4. The one real gap: mid-turn delivery

Our bus delivers only when Dave submits a prompt. A session that is 20 minutes into an
agent wave never sees a warning until it stops. That is the failure the Anthropic feature
is built for, and it is the only part worth copying.

Evidence it bites: the `35c80051` lane note in this session's own board reads
"AVOID editing those files until I release" — a message whose entire value was
time-sensitive, delivered only at the next prompt.

## 5. Plan

### Phase 0 — Confirm and record (15 min, do first)

1. Run `/list-agents` (alias `/peers`) in a live session. Expected: not recognized.
   That is the definitive per-session check, better than the socket probe.
2. Run `/status`, confirm there is no `Peer address` row.
3. Record the negative result in this file. Re-check on any CLI minor bump.

Deliverable: one line appended to §1 with the `/list-agents` output.

### Phase 1 — Close the mid-turn gap in our own bus (the actual work)

Add mid-turn delivery to `lane-context` so a running session sees a direct message
without waiting for a prompt.

- Register `lane-context.mjs` on **PostToolUse** in addition to its current two events.
  `PostToolUse.hookSpecificOutput.additionalContext` is our proven inject path
  (`hook-output-contract-was-inert.md`).
- Deliver **direct messages only** (`to_session_id = me`) on this path. Broadcast notes
  stay on the prompt path. Without this filter every session floods every other.
- Rate-limit: at most one injection per N seconds per session, watermark-advanced as
  today. Cheap guard against a note-storm during an agent wave.
- Cost guard: the hook already opens a DB connection per firing. PostToolUse fires far
  more often than UserPromptSubmit. Gate the query behind a cheap file-mtime or
  in-process cache before touching Postgres, or this becomes a latency tax on every
  tool call. Measure before and after.

Risk: PostToolUse fires inside subagents too, and 77% of hook firings on this machine
are subagent firings (`tldr-token-savings-measured.md`). Filter on the orchestrator
session id or the injection lands in the wrong context.

Gate: a probe in `scripts/coordination/` proving a direct `say` reaches a mid-turn peer,
in the style of `lane-race-probe.mjs`.

#### Phase 1 result — BUILT and verified live, 2026-08-10

`lane-context` now also runs on `PostToolUse`, matcher `Edit|Write|Bash|PowerShell|Task`.

**The plan's subagent filter was not buildable, and the design changed because of it.**
The plan said to "filter on the orchestrator session id". There is no such filter:
`identity-probe.ts` (Q1, 2026-07-26) measured a scout subagent reporting its PARENT's
`session_id` with `CLAUDE_AGENT_ID` unset and an identical ppid, and a re-scan of 361
logged rows on 2026-08-10 found `CLAUDE_AGENT_ID` has never once been set. A consuming
mid-turn path would therefore let a subagent mark its parent's message read and leave the
orchestrator permanently unaware — silent loss.

So the path is **non-consuming**: it never advances the database watermark. It is a
best-effort early copy, and the prompt path still delivers durably. The worst a subagent
can do is absorb one early copy. The failure mode degrades to the old behaviour instead of
below it.

Also as planned: direct messages only (broadcasts would be a per-tool-call storm), and a
15s throttle read from a temp file **before** the pg client is constructed, so the common
case costs no socket.

Verification:

- `scripts/coordination/dm-delivery-probe.mjs` — 5/5 against the **active** dist:
  delivered, correctly labelled `PostToolUse`, watermark did not move, second call
  throttled, broadcast not leaked.
- **Live, in a real session**: a message inserted for this session arrived mid-turn as
  `PostToolUse:Bash hook additional context`, with the peer-not-user framing intact.
  Note the incidental finding — Claude Code re-reads `settings.json`, so a newly
  registered hook fires without restarting the session.
- Two ratchets, each demonstrated failing on a **compiling** mutation:
  `lane-context-dm.test.ts` non-consuming invariant, and
  `hook-matcher-runtime-consistency.test.ts`.
- Full hook suite: 117 files, 2281 passed, 0 failed.

One guard was corrected rather than worked around. `hook-matcher-runtime-consistency`
inferred "does not name the tool" implies "inert", which is true only for hooks that
dispatch on `tool_name`. `lane-context` branches purely on `hook_event_name`, so it cannot
be narrower than any matcher. The guard now exempts hooks that never read `tool_name` —
verified not to blind it: adding a narrow gate makes both rules fire again.

Off switch: remove the `lane-context` entry from the `PostToolUse` array in
`.claude/settings.json` **and** `~/.claude/settings.json` (settings.json does not sync).
The other two delivery paths are untouched by that.

Follow-up, deliberately not built: the mid-turn path does **not** renew lane leases. A
session working continuously without prompts can still lose its lane to a lapse — the same
class of bug as the `last_heartbeat` liveness defect. It belongs in its own change.

### Phase 2 — WSL 2 pilot: **recommend skipping**

WSL 2 is supported, so a messaging-capable session is technically reachable. It does not
help:

- A WSL session and a Windows session have different filesystems, so they cannot see each
  other's registration files or sockets. The doc is explicit about the container case and
  the same reasoning applies.
- Our toolchain is Windows-native end to end: hooks in `~/.claude`, `git-safe.ps1`,
  Task Scheduler wrappers, the Postgres container reached via `docker exec`.
- We would be running two isolated messaging islands and still need the lane bus to
  bridge them.

Decision: do not pilot. Revisit only if Anthropic ships native Windows support and it
turns out to be WSL-backed.

### Phase 3 — Pre-decide the policy so adoption is a one-line flip

Write the settings now, do not apply them (they are inert here). Park them in this file.

| Setting | Value | Why |
|---|---|---|
| `isolatePeerMachines` | `true` | Requires explicit approval before any message leaves the machine. Our sessions handle client and Fourth-internal content. A `true` from any scope wins and cannot be turned off downstream |
| `crossSessionInbound` (interactive) | leave unset | The permission-mode default is the right behaviour and it degrades safe |
| `crossSessionInbound` (headless `-p`) | `"accept"` via `--settings` | **Required.** A `-p` session cannot show the approval dialog, so a held message stays held forever. Our Ralph and scheduled-report workers would silently never receive |
| `permissions.deny: ["SendMessage"]` | **never** | It also kills subagent and agent-team messaging, which we use daily. The org-wide off switch is not usable for us |

Bypass-permissions interaction, worth flagging: `skipDangerousModePermissionPrompt` is
`true` in our settings. Under the default rules a bypassing receiver **holds** every
message from a non-bypassing sender. Expect held messages, not delivered ones, on day one.

### Phase 4 — Adopt when Windows lands

Trigger: `/list-agents` starts working.

1. Apply the Phase 3 settings.
2. Run both buses in parallel for two weeks. Do not migrate.
3. Compare on one question: does a peer message arrive that the lane bus missed, or
   arrive usefully earlier?
4. Split by strength, do not pick a winner:
   - Anthropic messaging: ephemeral, urgent, mid-turn interrupts ("stop, I broke your file").
   - Lane bus: durable claims, leases, board state, broadcast, cross-machine, the audit trail.

## 6. Quick win spotted

`CLAUDE_CODE_MESSAGING_SOCKET` is exported to hooks and Bash commands before any hook
runs. When the feature lands on Windows that is a supported push channel from a **hook or
script into a live session** — a scheduled job, a CI result, a watchdog could post into a
running session instead of writing a file nobody reads. That is a bigger lever for us
than session-to-session chat, because our pain is scheduled work reporting into silence.
Note it now; build nothing yet.

## 7. Non-goals

- Replacing lanes, leases, or `file_claims`. Messaging carries text, not ownership.
- Replacing `--resume` for context transfer. The doc is explicit: messages are not history.
- Agent teams / agent view. Different features, separate evaluation.
