# ADR 0006 — Code-to-Code traffic moves local; Notion stays for cross-assistant traffic

**Status:** Proposed (Dave answered the scoping question 2026-10-27; this ADR needs his yes before P3) ·
**Supersedes:** the task system-of-record rule in `notion-operating-model.md`, **for Code-to-Code traffic only**

## Context

`notion-operating-model.md` makes Notion the system of record for tasks and handoffs.
Dave wants a locally hosted SDLC Operating System that can carry the traffic between Claude Code sessions:
handoffs, work assignment, notes, a work board.

Eve and Donna run on claude.ai and Grok runs on its own host. They reach Code only through Notion.
A localhost site (ADR-0005) is not reachable from them.

## Decision

- The OS becomes the system of record for **Code-to-Code** traffic: handoffs between Code sessions, lanes, notes.
- Notion stays the system of record for **cross-assistant** traffic (Eve, Donna, Grok) and the DevWork Board.
- A one-way export adapter copies Code-to-Code handoffs into the Notion Handoffs DB. Notion is never read back as input to the OS.
- Until P3, nothing changes: Notion stays canonical for handoffs, and the OS reads a cache.

## Consequences

- `/create_handoff` and `/resume_handoff` gain a local path in P3. The Notion path stays for cross-assistant handoffs.
- Two stores hold handoffs. The export is one-way and idempotent, keyed by session id and timestamp, so a retry cannot duplicate.
- If Dave later wants Eve or Donna to read OS data, the OS must leave localhost. That reverses ADR-0005 and needs its own review.
- The new local `handoff` table needs a migration (confirm-first, query-plan check).
