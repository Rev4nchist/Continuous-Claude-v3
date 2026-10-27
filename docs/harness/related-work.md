# Related work

[Back to the README](../../README.md) · [All harness pages](README.md)

*Moved from the README on 2026-10-26. The text moved word for word. Edits made while PR 168 was reviewed fix facts that were stale or wrong, and lines that start with "Status on 2026-10-26" are dated notes.*

FourthBot is a separate repository. It applies the same harness shape to agents for Fourth's
business teams. It has a policy gateway that fails closed with allow, ask and deny. It has an
append-only event log of what the model sees, and human approval steps with a database guard
against double decisions. Its bots hand work to each other on a bot-to-bot (A2A) bus, with a
receipt for each handoff. It targets Fourth's Azure tenant with Entra sign-in. Today it runs on a
local Docker Compose stack.
