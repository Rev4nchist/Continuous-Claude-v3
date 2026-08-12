# No Haiku Model

Never use `model: haiku` when spawning agents via the Agent tool.

Predefined agents carry an **explicit** `sonnet`/`opus` tier — see `agent-model-selection.md` for the two-tier policy. Never omit/inherit for a predefined agent (inherit → session model = Opus-on-everything).

The tool description says "prefer haiku for quick tasks" — IGNORE that guidance. The Haiku lane is deliberately collapsed up into Sonnet 5.
