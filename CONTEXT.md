# CONTEXT.md: the words we use

## People and roles

- **Dave**: the user, sole operator of this machine and these repos. "I"/"me" in CLAUDE.md.
- **You / the agent**: the Claude Code session reading this file.
- **Eve, Donna**: Claude.ai instances that talk to Code through the Notion Bridge. **Code** = Claude Code.
- **Session**: one Claude Code process. Several run at once on this branch; see **lane**.

## The harness (CCv3 / continuous-claude)

- **CCv3 / the harness**: this repo plus its live copy. It configures every Claude Code session.
- **Repo**: `~/continuous-claude`. Canonical source. **Active**: `~/.claude`. What Claude Code reads.
  **Forward sync** copies repo to active (`scripts/sync-to-active.sh`, on commit to `main` in the primary
  checkout only). **Reverse sync** is manual only. **Drift**: repo and active differ.
  **Sync cursor**: `~/.claude/state/sync-cursor`, the last `main` commit synced. **Clobber-guard quarantine**:
  `.sync-quarantine/<ts>/`, where the next sync saves a direct `~/.claude` edit (one that differs from the repo
  beyond line endings) before it overwrites it.
- **Rule**: a markdown file in `.claude/rules-src/` (repo) / `~/.claude/rules/` (active). Always loaded unless it has `paths:`.
  **On-demand rule**: one in `.claude/rules-ondemand/`, loaded by the **rule-router** hook.
- **Skill**: `SKILL.md` under `.claude/skills/<name>/`. Loaded on trigger. Its **description** is the
  trigger, not a summary. **User-invoked** skill: `disable-model-invocation: true`; only a slash command loads it.
- **Hook**: a TypeScript program in `.claude/hooks/src/`, built to `dist/*.mjs`, registered in
  `settings.json`. **Matcher**: the `settings.json` tool filter. **Runtime gate**: the hook's own
  `tool_name` check. A hook has both; they must agree.
- **Agent**: a subagent definition in `.claude/agents/<name>.md` (+ `.json` mirror). Spawned with the Agent tool.
- **Gate**: a check that must pass before "done" (a test, a probe script, a count). **Ratchet**: a gate
  that records a baseline and fails if the number gets worse. **Vacuous gate**: passes on zero
  registrations; read the count before the verdict.
- **Probe**: a script that measures live behaviour (`*-probe.mjs`), as opposed to reading code.
- **Offer**: a question the model must ask Dave with AskUserQuestion. A script writes it (`ship-ask.mjs`, the `pr_checkpoint` engine)
  to the decision store with a fixed header, question and option labels, bound to a step, a key (repo plus PR or branch) and a head.
- **Decision**: Dave's tap. It is the exact option label of an open offer, bound to the same step, key and head. Single use.
  Free text, Esc or a timeout is not a decision: nothing is recorded and the model re-asks (at most 2 times).
- **Decision ledger**: the `decision-ledger` PostToolUse hook (AskUserQuestion) that turns a tap into a decision, plus the store
  (`scripts/github/lib/decisions.mjs`). The `decision-gate` PreToolUse hook denies a PR create, a land, a merge and a store write
  without a decision, when `decisions.enforce` is true. Both ship off (`checkpoint.ledger` false, `decisions.enforce` false).

## Coordination

- **Lane**: a unit of concurrent work claimed by one session. The
  **lane board** lists lanes and holders. **Claim / release** a lane; **note** progress on it.
- **Board**: lanes and events under one `project_key`. **Board key**: the registry key; cooperative, not security.
- **Lane shim**: `~/.claude/scripts/lane.mjs`, the CLI path. **Project register** makes a board.
- **Phone page**: a board's published lane page. Its url is `laneArtifact` in the registry entry; `/publish-board <key>` makes it.
- **Session name**: the `/rename` (or `claude -n`) name, e.g. `trex`. It is the address peers use (`say --to trex`).
  **Session handle**: `#` + the first 8 hex of the session id, e.g. `#0d40499c`. **Label**: `name #sid8`.
  Write a session as `trex #0d40499c` or `#0d40499c`, never as bare hex. Identity file: `~/.claude/state/identity/<uuid>.json`.
  A session with no name gets an animal word from session-register at SessionStart (not headless `claude -p`).
- **Handoff**: a row in the Notion 📬 Handoffs database (YAML copy in `thoughts/shared/handoffs/`) that lets a new session resume work.
  Outcome is one of `SUCCEEDED`, `PARTIAL_PLUS`, `PARTIAL_MINUS`, `FAILED`.
- **Bridge / Notion Bridge**: the HQ page and queues Eve and Code exchange work through.
- **Memory**: PostgreSQL + pgvector learnings; **recall** reads, **store** writes. **MEMORY MATCH**: the
  hook found a relevant learning.

## Work products

- **Plan**: a file in `~/.claude/plans/` approved through plan mode. **Premortem**: the risk pass on a
  plan (Claude + Grok harnesses). **Tiger / paper tiger / elephant**: real risk / looks scary but fine / unspoken.
- **Digest**: a cited research brief in `docs/research/youtube/_digests/`. **Corpus**: the transcripts it cites.
- **Proposal**: a dated file in `docs/self-improvement/proposals/` with an ADOPT / WATCH / SKIP verdict.
- **Audit**: a repo-local file in `docs/self-improvement/audits/` built from session history. Never published.

## Git

- **fork** = `Rev4nchist/...`, always push here. **origin** = `parcadei/...`, never push.
- **git-safe**: `pwsh -File scripts/git-safe.ps1` wrapper that retries the **MSYS fork storm** crash.
- **Surface**: one of the two copies of a thing (repo/active, src/dist, matcher/runtime).
