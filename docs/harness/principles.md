# Engineering principles

[Back to the README](../../README.md) · [All harness pages](README.md)

*Moved from the README on 2026-10-26. The text moved word for word. Edits made while PR 168 was reviewed fix facts that were stale or wrong, and lines that start with "Status on 2026-10-26" are dated notes.*

| Principle | What it means here |
|---|---|
| Done means proven | A change is done only when an end-to-end check passes and its output is saved. A unit test alone is not proof (`AGENTS.md`). |
| No vacuous gates | A gate asserts a non-zero count of things it checked. A scan that finds nothing fails. See the header of `scripts/hooks/hook-contract-guard.mjs`. |
| Ratchets | A gate records a baseline and fails if the number gets worse. Examples: `scripts/rules/context-budget.json`, `scripts/hooks/suite-count-ratchet.mjs`. |
| Fail closed on risk | Destructive and unattended actions get `ask` or `deny`. A guard's own internal error fails open, so one guard bug cannot stop all work. |
| A hook block is a finding | A block names a real problem. Sessions do not route around it with another tool or a wrapper. |
| Confirm first | Deletes, history rewrites, schema changes, deploys, sends and paid runs need the operator's approval. |
| One canonical source | The repo is the source. `scripts/sync-to-active.sh` copies it to `~/.claude` after each commit to `main` in the primary checkout. |
| Review every change | Each pull request passes CI. Greptile reviews on request only (`.greptile/config.json`, `autoReview: []`). A review label adds CodeRabbit. `scripts/github/review-status.mjs` gates READY. Fixes cite the review, for example `(Greptile #113)`. |
| Portable by profile | Machine paths and the skill skip list live in `machine/personal.json`. A ratchet and a CI job fail if a work-machine path returns. |

The forward sync has a clobber guard. It keeps a sha256 manifest of each file it wrote. If the
active copy changed since the last sync, the script moves that copy to a quarantine folder
before it overwrites it.
