# Grok Worker Safety Rules

**Grok is PARKED on this machine** (since 2026-07-13: corporate egress stalls completions; fix is an
IT allowlist for `*.x.ai`). Do not run `/grok`, `grok-worker` or `grok-adversary` here unless Dave
says the block is lifted. The full contract (confirm-first matrix, worktree recipe, GC rules, research
role, headless flags, cost) is in `.claude/skills/grok/SKILL.md`, section "Safety". Read it before any run.

Must-know, even when parked:
- **`--tools "read_file,list_dir,grep"` is the ONLY read-only boundary.** `--sandbox` is decorative on
  this build (it accepts any string and blocks nothing) and `--permission-mode plan` does NOT protect
  headless runs; both were live-probed and let writes through. Every ask and review run passes that
  `--tools` list.
- Implement mode writes only in a hand-rolled sibling worktree (`-w/--worktree` is ignored headless),
  is confirm-first every run, and its patch is reviewed before it touches the live tree. A worktree
  does not contain terminal commands, so no implement/resume with `--always-approve` until an
  OS-level sandbox exists.
- Subscription auth only: `grok models` must say "logged in", and the identity pin
  `~/.grok/auth.json` email must be `dkhayes44@gmail.com`. Run with `env -u XAI_API_KEY`. Never print
  auth file contents or tokens.
- Every run ships `~/.claude` context to xAI: confirm the first run per session (even a bare question),
  secret-scan the prompt file, never include `.env*`.
- Model allowlist `{grok-4.5, grok-composer-2.5-fast}`; any CLI version change goes through
  `/harness-update grok` before implement/resume.
