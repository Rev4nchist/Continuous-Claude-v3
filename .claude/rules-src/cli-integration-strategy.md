# CLI Integration Strategy

## Priority order for giving Claude Code access to a new platform

Work down this list and stop at the first tier that fits. The order exists because the instinct
— reach for browser automation, or for whatever MCP server is already connected — routinely
skips two better options that are already installed.

1. **Native CLI** (`gh`, `vercel`, `railway`, `neonctl`, `docker`) — the gold standard. Vendor-
   maintained, structured output, battle-tested. Wire it as Direct Bash + skill + rule.
2. **OpenCLI adapter** for web platforms with a browser login (Twitter, Reddit, HN, LinkedIn).
   Zero API keys — reuses Chrome session cookies.
3. **MCP server**, when the vendor ships one. Note the trade: a CLI is typically far cheaper in
   tokens for scripted or batch work, so prefer MCP where it is the only transport, where auth
   is interactive, or where the operation has no CLI equivalent.
4. **Generated wrapper** for desktop software with source (CLI-Anything). Review generated code
   for security before deploying.
5. **Thin CLI wrapper script** when there is a REST API but no CLI — one file, JSON to stdout,
   subcommand interface (`scripts/cdp.mjs` is the model).
6. **Browser automation** — last resort only. Highest friction, lowest reliability.

## Everything else is deliberate, and lives in the skill

Load `.claude/skills/cli-integration/SKILL.md` when actually integrating or evaluating a tool.
It carries the current inventory and known-gaps tables, the ten-criterion agent-compatibility
checklist for scoring a candidate CLI, and the seven-step wiring checklist. Verbatim pre-split
snapshot at the foot of that file.

Two things worth knowing without loading it: those inventory tables are hand-maintained and
**rot** — verify a row against the tool itself before relying on it. And several integrated
tools carry load-bearing traps (Grok's `--tools` being the only real guard, Codex's
`--ignore-user-config` breaking Windows writes, `ntn`'s stdin hang) that live in their own
safety rules, not here.
