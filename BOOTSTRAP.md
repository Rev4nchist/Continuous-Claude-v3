# Bootstrap: Continuous Claude

> Point Claude Code at this file on a new machine. It contains everything needed to set up the full system.

## Prerequisites

| Tool | Verify | Install |
|------|--------|---------|
| Docker Desktop | `docker --version` | docker.com |
| Node.js 18+ | `node --version` | nodejs.org |
| Python 3.12+ | `python --version` | python.org |
| uv | `uv --version` | `pip install uv` or `curl -LsSf https://astral.sh/uv/install.sh \| sh` |
| Git | `git --version` | git-scm.com |

## Quick Start

The repo is **private**, so you need a GitHub credential before you can clone it.
Do [GitHub Identity](#github-identity) step 1 first, then:

```bash
git clone https://github.com/Rev4nchist/Continuous-Claude-v3.git continuous-claude
cd continuous-claude

# Reproduce the remote naming this repo's scripts hardcode
git remote rename origin fork
git remote add origin https://github.com/parcadei/Continuous-Claude-v3.git

cd opc
uv run python -m scripts.setup.wizard
```

> **Clone `Rev4nchist`, not `parcadei`.** `parcadei` is the upstream and it is
> **837 commits behind**, last moved 2026-01-26. Cloning it gives you a system
> most of a year old that looks correct.
>
> **Both remote names are load-bearing, so do not skip the rename.**
> `.claude/scripts/scheduled/scheduled-blocklist-update.ps1` runs `git fetch fork main` and `git push fork HEAD:refs/heads/main` and
> `scripts/check-upstream.sh:13-14` hardcodes `UPSTREAM_REMOTE="origin"` /
> `FORK_REMOTE="fork"`. A clone that leaves Rev4nchist as `origin` breaks both,
> and the daily blocklist job fails silently in the Task Scheduler where nobody
> reads it. Convention: **push to `fork`, never to `origin`.**

The wizard handles:
- Docker PostgreSQL + pgvector container (4 tables, idempotent schema)
- Hook installation + TypeScript build (about 75 source hooks compiled to dist/*.mjs)
- Skills (150+), agents (50), rules (28) installed to `~/.claude/`
- CLAUDE.md and RULES.md behavioral config from templates
- Environment variables (`CLAUDE_OPC_DIR`, `PYTHONUTF8=1` on Windows)
- Git post-commit hook for automatic repo-to-active sync
- `settings.json` generated with correct local paths from template

> **Windows users**: Open a **new terminal** after the wizard completes. `setx` sets permanent environment variables but they are not available in the current terminal session.

## Post-Setup Verification

```bash
# Docker running
docker ps | grep continuous-claude-postgres

# Hooks compiled
ls ~/.claude/hooks/dist/*.mjs | wc -l  # Expect 70+

# Behavioral config exists
ls ~/.claude/CLAUDE.md ~/.claude/RULES.md

# Environment set
echo $CLAUDE_OPC_DIR  # Should point to <repo>/opc

# Memory system works
cd $CLAUDE_OPC_DIR && PYTHONPATH=. uv run python scripts/core/recall_learnings.py --query "test" --k 1 --text-only
```

### Third-party skills (not in this repo, not installed by the wizard)

Three skills that rules route to live outside the repo. `~/.claude/skills/<name>` is a
directory junction to the install location. `bash scripts/verify-setup.sh` fails on a missing
archify and warns on the other two.

| Skill | Source | Install location | Why it matters |
|---|---|---|---|
| `archify` | github.com/tt-a1i/archify (MIT), installed with the `skills` CLI (`npx skills add tt-a1i/archify -g`; `-g` installs at user level, the location below) | `~/.agents/skills/archify` | `design-work.md` routes diagrams to it |
| `browser-automation` | seeded by the CodeGPT app | `~/.codegpt/skills/browser-automation` | `design-work.md` names it for console and network checks |
| `game-development` | seeded by the CodeGPT app | `~/.codegpt/skills/game-development` | game run-and-look loop |

Link each one after it is installed (PowerShell):
`New-Item -ItemType Junction -Path "$HOME\.claude\skills\archify" -Target "$HOME\.agents\skills\archify"`
`New-Item -ItemType Junction -Path "$HOME\.claude\skills\browser-automation" -Target "$HOME\.codegpt\skills\browser-automation"`
`New-Item -ItemType Junction -Path "$HOME\.claude\skills\game-development" -Target "$HOME\.codegpt\skills\game-development"`

GitHub identity is **not** covered by the wizard and is verified separately -- see
[GitHub Identity](#github-identity):

```
pwsh -File scripts/github/verify-github-accounts.ps1   # expect PASS, 24 checks
```

## GitHub Identity

**Manual. The wizard does NOT do this, and this is the largest hole in a machine
rebuild.** The wizard reproduces everything that lives in git. GitHub identity does
not: it is **machine state outside version control** --
`~/.gitconfig`, the gh OAuth credentials, a User-scope environment variable, two
PowerShell profiles, and Windows Credential Manager. None of it is in the repo, and
none of it is restored by cloning.

**Why it is worth the twenty minutes.** One GitHub account is in play --
`Rev4nchist` (personal, dkhay). The work account was removed from
`scripts/github/accounts.json` and must not be recreated. The layers below still
fail silently if the personal credential is wrong:

| Layer | Silent failure |
|---|---|
| gh CLI | the wrong account opens the PR |
| git push credential | the wrong account is authenticated for push |
| commit identity | the wrong email is baked into the commit, **permanently** |
| plain `git` routing | a bare github.com request answers as someone other than Rev4nchist and 404s |
| gh MCP server | wrong account for everything done via MCP |

Each produces a successful-looking operation attributed to the wrong person. You find
out days later, in someone else's repo history. This was live until 2026-08-11:
**25 of 64 remotes** were authenticating as the wrong account.

**What IS in git:** `scripts/github/accounts.json` is the single source of truth.
It names one account, `personal`, and `authByOwner._default` points at it.
`accounts-lib.ps1` holds the shared resolution logic. Do not re-derive any of
this by hand.

### Setup order

Order matters. Step 1 must precede the clone, because the repo is private.

**1. Install Git for Windows, then authenticate the personal account.**

Git for Windows registers Git Credential Manager at **system** scope. That is the
single credential helper the setup expects -- do not add another (see the trap below).

```
$env:GH_CONFIG_DIR = "$HOME\.config\gh-personal"
gh auth login --hostname github.com --git-protocol https --web
```

**2. Do not authenticate a second account.** `accounts.json` has no work
account. Skip any second config dir. The personal config dir from step 1 is the
only gh credential.

> **`--web` stores whichever account the BROWSER session holds, not the one you
> intended.** Sign the browser into Rev4nchist first. Never trust the login's own
> success message -- verify with ambient tokens cleared:
> `$env:GH_CONFIG_DIR="$HOME\.config\gh-personal"; gh api user --jq .login`

**3. Set the default account** at User scope. Without a default, bare `gh` has **no
credential at all** -- it falls back to `%APPDATA%\GitHub CLI\`, which does not exist.

```
[Environment]::SetEnvironmentVariable('GH_CONFIG_DIR', "$HOME\.config\gh-personal", 'User')
```

> Use this, **not** `setx GH_CONFIG_DIR "%USERPROFILE%\..."`. PowerShell does not
> expand `%USERPROFILE%`, so setx would store that literal string as a `REG_SZ` and
> gh would look for a directory that does not exist. The stored value must be an
> absolute path. Open a **new terminal** afterwards -- User-scope variables are not
> visible in the session that set them.

**4. Point plain `git` at the personal account.** Without the username, Git
Credential Manager cannot choose an account. There is no second account and no
`insteadOf` rewrite.

```
git config --global credential.https://github.com.username Rev4nchist
```

**5. Apply commit identity** from `accounts.json`. With no work account the script
prints that identity stays personal and writes nothing.

```
pwsh -File scripts/github/apply-commit-identity.ps1
```

**6. Route bare `gh` by directory.** Add this line to **both** profiles -- PowerShell 7
(`~\Documents\PowerShell\Microsoft.PowerShell_profile.ps1`) and Windows PowerShell 5.1
(`~\Documents\WindowsPowerShell\Microsoft.PowerShell_profile.ps1`). Scheduled tasks run
5.1; a shim in only one profile routes correctly in only half of your shells.

```
. "$HOME\continuous-claude\scripts\github\gh-shim.ps1"   # route bare `gh` by directory
```

**7. No second credential to prime.** Step 4 makes Git Credential Manager ask for
Rev4nchist. Do not add a rewrite that names another account.

### Verify -- both gates must pass

```
pwsh -File scripts/github/verify-github-accounts.ps1
pwsh -File scripts/github/sweep-remotes.ps1
```

The verifier checks each layer independently and asks *who are you*, rather than
*did it error*. The check count scales with the accounts and routes in
`accounts.json` (one personal account, one personal route). The sweep contacts
every remote read-only. On a correct machine it is **0 failures**.

### Traps that cost real sessions

| Trap | Reality |
|---|---|
| `gh auth refresh` to fix a bad token | **Dead end against an env-var token.** It refreshes gh's own OAuth credential. If a `GITHUB_TOKEN`/`GH_TOKEN` PAT is set, that outranks stored credentials (`GH_TOKEN` > `GITHUB_TOKEN` > stored) and a classic PAT's scopes live on github.com, not in gh. Remove the env var instead. |
| Adding `wincred` as a credential helper | **This was the actual defect.** With no username GCM could not choose, and wincred answered from a host-level entry mapping to the work account. Keep exactly **one** helper (`manager`, system scope) -- verifier layer 5b asserts this. |
| Deleting the ambiguous `git:https://github.com` credential | Hygiene, **not** the control. GCM recreates it on the next successful auth. Step 4's `credential.<url>.username` is what makes it never be consulted. |
| `git remote -v` showing a rewritten URL | Expected under `insteadOf`. The **stored** config is untouched -- check `git config --get remote.origin.url`. |
| A bare `git credential fill` returning a credential | **Correct**, not a leak. Once step 4 is applied it resolves to the default account deterministically. The invariant is *which* account answers, never *whether* one does. |
| Running the verifier and getting no output | Pre-2026-08-05 it hung on a GCM GUI prompt at 0% CPU. Fixed with `GIT_TERMINAL_PROMPT=0` + `GCM_INTERACTIVE=never`. If it hangs again, suspect a new interactive path -- a verifier that can hang is one nobody runs. |

**Revoking the GitHub CLI OAuth grant breaks `gh` and plain `git push` together** for
that account, and GitHub has no reissue button. Recovery is to re-run the login flow
for that account (step 1). Full detail:
`.claude/docs/windows/platform-notes.md`.

## What The System Provides

- **Persistent memory** -- PostgreSQL + pgvector semantic search across sessions
- **95+ hook source files** -- auto-inject context, enforce patterns, track state
- **40+ specialized agents** -- scout, kraken, architect, debug-agent, oracle, etc.
- **150+ skills** -- /build, /fix, /explore, /maestro workflows
- **Cross-session continuity** -- handoffs, knowledge trees, ROADMAP tracking
- **Auto-sync** -- git commits in the repo auto-deploy to ~/.claude/

## DevOps Integration (Step 4b)

The wizard does not prompt for Linear or Sentry. Step 4b does not collect `LINEAR_API_TOKEN`, `LINEAR_WORKSPACE`, `SENTRY_AUTH_TOKEN`, or `SENTRY_ORG`, and it does not write those names into `.env`.

Linear issue tracking stays available through `linearis`, `linear-cli`, and the remote server at `https://mcp.linear.app/mcp`. The wizard does not register that server and does not ask for a Linear token.

Sentry error monitoring stays available through `sentry-cli` and the remote server at `https://mcp.sentry.dev/sse`. The wizard does not register that server and does not ask for a Sentry token.

**Playwright CLI** (E2E testing):
- CLI: `@playwright/cli` for token-efficient browser automation
- Always installed — core to the QA workflow

## Supply Chain Security

A `package-install-guard` hook intercepts all package install commands and checks:
1. Typosquat detection (local curated list)
2. Known-malicious blocklist (auto-updated daily)
3. OSV.dev real-time query (malware advisories)
4. Package age check (blocks <24h old packages)

## Architecture

```
continuous-claude/              # Git repo (source of truth)
+-- .claude/
|   +-- hooks/src/*.ts          # 95 hook source files (TypeScript)
|   +-- hooks/dist/*.mjs        # Compiled hooks (esbuild output)
|   +-- skills/                 # 150+ skill definitions
|   +-- agents/                 # 50 agent configs (.md + .json)
|   +-- rules/                  # 28 operational rules
|   +-- settings.json.template  # Hook registrations (templated)
|   +-- templates/              # CLAUDE.md.template, RULES.md.template
+-- opc/                        # Operations & Python scripts
|   +-- scripts/setup/          # Wizard, docker setup, integration
|   +-- scripts/core/           # Memory, knowledge tree, learnings
|   +-- .env                    # Local config (generated by wizard)
+-- docker/
|   +-- docker-compose.yml      # PostgreSQL + pgvector
|   +-- init-schema.sql         # 4 tables: sessions, file_claims,
|                                 archival_memory, handoffs
+-- scripts/
    +-- sync-to-active.sh       # Forward sync: repo -> ~/.claude
    +-- post-commit-hook.sh     # Auto-sync on git commit

~/.claude/                      # Active directory (not in git)
+-- CLAUDE.md                   # Behavioral config
+-- RULES.md                    # Constraints & enforcement
+-- settings.json               # Hook registrations (local paths)
+-- hooks/dist/*.mjs            # Compiled hooks
+-- skills/, agents/, rules/    # Copied from repo
```

## Daily Workflow

After setup, sync is automatic:
1. Edit files in `continuous-claude/` repo
2. `git commit` triggers post-commit hook
3. Hook runs `sync-to-active.sh` -- copies to `~/.claude/`
4. Hooks are rebuilt automatically

Manual sync: `bash scripts/sync-to-active.sh`

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Hooks not firing | `cd ~/.claude/hooks && npm run build` |
| Memory recall fails | Check `echo $CLAUDE_OPC_DIR`; check Docker running |
| Knowledge tree missing | `cd $CLAUDE_OPC_DIR && PYTHONPATH=. uv run python scripts/core/knowledge_tree.py --project <dir>` |
| Python encoding crash (Windows) | Set env var: `PYTHONUTF8=1` |
| settings.json wrong paths | Re-run wizard or regenerate from `.claude/settings.json.template` |
| Hooks stale after source edit | `cd ~/.claude/hooks && npm run build` then restart session |
| "Repository not found" on a repo you own | Wrong-account auth. Run `verify-github-accounts.ps1`; usually a missing `credential.https://github.com.username` (step 4) or a second credential helper |
| `gh` acts as the wrong account | `Get-GhAccount` shows who `gh` would be in the current directory. If it says `ambient GH_CONFIG_DIR`, the shim is not loaded in this profile (step 6) |
| Commits authored with the wrong email | `pwsh -File scripts/github/apply-commit-identity.ps1` to plan, `-Apply` to fix. This does **not** rewrite existing commits |
| Push prompts for credentials, or hangs with no output | Git Credential Manager raising a GUI prompt in a non-interactive shell. Confirm step 4 set the personal username, then complete one interactive fetch |

## Windows-Specific Notes

- Use `python` not `python3` (triggers Microsoft Store on Windows)
- Set `PYTHONUTF8=1` as permanent user environment variable
- Git Bash paths need drive letter: `C:/Users/...` not `/Users/...`
- MCP server configs with `npx` require `cmd /c` wrapper
- Never use Edit tool on `~/.claude.json` (race condition with Claude Code writes)

## For Claude Code on a New Machine

If you are Claude Code reading this after a fresh clone:
1. Confirm the clone came from `Rev4nchist` and that remotes are named `fork` / `origin`:
   `git remote -v`. If not, fix it now -- scheduled scripts hardcode both names.
2. Run the wizard: `cd opc && uv run python -m scripts.setup.wizard`
3. Verify with the post-setup checks above
4. **Do the GitHub Identity steps** -- the wizard does not, and four of its five layers
   fail silently with the wrong identity rather than an error. Gate:
   `pwsh -File scripts/github/verify-github-accounts.ps1` must PASS.
5. Read `~/.claude/CLAUDE.md` for behavioral instructions
6. Read `~/.claude/RULES.md` for constraints and enforcement
7. Read `docs/ARCHITECTURE.md` for full system documentation
8. Run `/help` skill for interactive discovery of available commands
