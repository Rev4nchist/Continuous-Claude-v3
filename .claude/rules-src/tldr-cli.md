# TLDR CLI - Code Analysis Tool

`tldr` is on PATH for token-efficient, AST-level code analysis (Python, TypeScript, Go, Rust). All commands emit JSON; `tldr context` emits LLM-ready text.

**Reach for it before bulk-reading files.** A structural question — "what's in here", "who calls this", "what breaks if I change this", "what does this import", "which tests does this change touch" — is a `tldr` query, not a series of Read calls.

| Need | Command |
|------|---------|
| What exists here | `tldr structure .` / `tldr tree src/` |
| Who calls X (before refactoring) | `tldr impact X .` |
| Who imports X | `tldr importers X .` |
| Type + lint errors before running tests | `tldr diagnostics .` |
| Which tests a change affects | `tldr change-impact --git` |

Use grep for literal strings, config values, and non-code text. `tldr` is for structure, not substrings.

**TLDR navigates; you still read.** Do not fix a bug from a summary alone — use TLDR to find the 2-4 files that matter, then Read them.

Full command surface, flags, the 5-layer stack, the TLDR-vs-grep table, the bug-fixing workflow, and the command decision tree: load the `tldr-code` skill (`.claude/skills/tldr-code/SKILL.md`). Routine analysis (context injection, AST-summarized reads, post-edit diagnostics) is already automated by hooks — do not duplicate their work.
