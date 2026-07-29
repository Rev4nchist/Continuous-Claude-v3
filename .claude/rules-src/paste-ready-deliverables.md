# Paste-Ready Deliverables

When producing content the user will copy and paste somewhere else — Slack/Teams messages, emails, ticket descriptions, PR/issue comments, doc snippets, replies to a third party — output it as **plain text**, never wrapped in a Markdown blockquote (`>`).

## Why

Blockquote (`>`) prefixes and nested Markdown get copied literally or mangle line breaks when pasted into Slack, email, or a ticket field. The user then strips `>` characters by hand every time. Recurring correction — codified 2026-05-29.

## Rules

- **No blockquote (`>`) formatting** on any content meant to be copied elsewhere. This is the default for drafted messages, replies, ticket text, and email bodies.
- For a **multi-paragraph message / email / ticket**, present it as plain prose. A short lead-in label is fine ("Message to Danny:" on its own line, then the text), but the body carries no `>`.
- For a **single discrete value or command** (a ticket-field value, a CLI command, a config snippet), a fenced code block is fine — it gives a clean copy boundary and a one-click copy. See `terminal-command-format.md` for command formatting specifics.
- Don't bury copy-paste content inside other Markdown that produces stray characters on paste (nested lists, tables) unless the paste destination is itself Markdown.
- A horizontal divider (`---`) before and after the deliverable to mark its boundaries is fine — just keep the body itself plain.

## Quick test

Before sending drafted external content, ask: "If the user selects this and pastes it into Slack, does it arrive clean?" If a `>` or stray Markdown would come along, reformat as plain text.
