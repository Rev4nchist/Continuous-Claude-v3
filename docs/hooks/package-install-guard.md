# package-install-guard — operator reference

Reference for the `package-install-guard` PreToolUse:Bash and PreToolUse:PowerShell hook: what it intercepts, the
checks it runs, what each block class means, and how the malicious-package blocklist is kept
current. This is procedural detail you read *deliberately* — when a block needs interpreting,
or when the blocklist needs updating — not something an agent needs loaded on every turn.

**The enforcement is the hook, not this document.** The core `~/.claude/CLAUDE.md` ("A hook block
is a finding"; the separate rule was folded in on 2026-09-24) keeps only what must be true unprompted: that
installs are intercepted, that `SKIP_PACKAGE_GUARD=1` exists, and that routing around a block
is not an option. Everything below is the detail behind that.

Related: `.claude/hooks/src/package-install-guard.ts` (the hook), `.claude/hooks/src/shared/
malicious-packages.json` (the blocklist), `scripts/update-blocklist.mjs` (the updater).

## Changes since the snapshot (2026-10-04, review item H2)

- The hook runs on the Bash and PowerShell tools. Both `settings.json` copies and the template
  register it on both matchers, and the hook's own gate is a `COMMAND_TOOLS` set.
- It checks every executed segment, so `cd x && pip install y` and `Set-Location x; pip install y`
  are seen. It also looks inside `$(...)` and `bash -c` / `powershell -Command` payloads.
- More pip forms: `python -m pip`, `py -3.12 -m pip`, `pip3.12`, and a launcher under a path
  (`.venv\Scripts\pip.exe`).
- Pin check (deny): `pip install`, `uv pip install` and `python -m pip install` need an exact `==`
  (or `===`) pin on every package. A range, a wildcard or a bare name is denied. A PEP 508 marker
  (`"x==1.0; python_version>='3.8'"`) is allowed. Not checked: lockfile tools (`uv add`,
  `poetry add`), `-r` files, local paths (`.`, `dist\x.whl`), and URL or VCS installs
  (`git+https://...`). A VCS ref without a commit hash is a known gap.
- pip global options before `install` (`-q`, `--proxy URL`), interpreter flags before `-m`
  (`-I`, `-X utf8`), any letter case (`Python`, `PIP`) and `sudo` / `time` leaders are matched.
  A literal heredoc or here-string that only writes text is not an install.
- Order: typosquat, blocklist, pin, then the network checks (OSV, age).

---

<!-- archived-rule:package-install-safety.md ref:014d2c6 -->
## Reference: pre-split text of `rules/package-install-safety.md` (archived 2026-07-29)

Verbatim snapshot of `rules/package-install-safety.md` as it stood before the split, so nothing
trimmed out of the always-on budget is lost. Everything the rule used to carry — the full
guarded/passthrough command lists, the four-layer check table, the per-block-class remediation
guide, the blocklist update paths (automatic, scheduled, manual) and the LiteLLM background —
is below, unchanged:

````markdown
# Package Install Safety

## Overview

A PreToolUse:Bash hook (`package-install-guard`) intercepts all package install commands and runs a 4-layer security check before allowing execution. This protects against supply-chain attacks like the LiteLLM/TeamPCP incident (March 2026).

## What's Guarded

All package manager install/add commands are intercepted:
- **Python:** `pip install`, `pip3 install`, `uv pip install`, `uv add`, `poetry add`
- **Node.js:** `npm install`, `npm i`, `yarn add`, `pnpm add`, `pnpm install`, `bun add`, `bun install`
- **Rust:** `cargo add`, `cargo install`
- **Go:** `go get`, `go install`
- **Ruby:** `gem install`, `bundle install`
- **PHP:** `composer require`

## What's NOT Guarded (passthrough)

These commands are never intercepted:
- `pip list`, `pip show`, `pip freeze`
- `npm ls`, `npm list`, `npm info`
- `pip uninstall`, `npm uninstall`
- All non-package-manager commands

## Security Checks (in order)

| Layer | Check | Source | Speed | Action on Fail |
|-------|-------|--------|-------|---------------|
| 1 | **Typosquat detection** — misspelling of a popular package? | Local curated list + Levenshtein | <1ms | BLOCK |
| 2 | **Known-malicious blocklist** — confirmed compromised package/version? | Local `malicious-packages.json` | <1ms | BLOCK |
| 3 | **OSV.dev real-time query** — malware advisory (MAL-) or CRITICAL CVE? | Google OSV API (no auth) | ~300ms | BLOCK (MAL-/CRITICAL), WARN (HIGH) |
| 4 | **Package age** — published <24h ago? <7d ago? | PyPI/npm registry API | ~500ms | BLOCK (<24h), WARN (<7d) |

## Override

If you need to bypass the guard for a known-good install:

```bash
SKIP_PACKAGE_GUARD=1 pip install <package>
```

This skips all checks. Use only when you've verified the package manually.

## What to Do If Blocked

1. **Typosquat block:** Check the package name spelling. The guard will suggest the correct name.
2. **Malicious version block:** Use a different version. Check the advisory link for details.
3. **OSV.dev block (MAL-):** This package has a confirmed malware advisory. Do NOT install. Check the advisory ID at `https://osv.dev/vulnerability/<ID>`.
4. **OSV.dev block (CRITICAL):** Critical vulnerability detected. Check the CVE details before proceeding.
5. **Age block (<24h):** Wait 24 hours, or use the override if you've verified the package.

## Updating the Blocklist

### Automatic (recommended)

```bash
node scripts/update-blocklist.mjs                    # Dry run — show what would change
node scripts/update-blocklist.mjs --apply            # Write changes
node scripts/update-blocklist.mjs --apply --rebuild   # Write + rebuild hooks + sync
```

This fetches from:
- GitHub Advisory API — npm malware advisories (`type=malware`)
- GitHub Advisory API — PyPI critical CVEs (`type=reviewed, severity=critical`)

Requires `gh` CLI authenticated (`gh auth status`).

### Scheduled (daily at 9am)

A Windows Task Scheduler job runs `C:\Users\david.hayes\.claude\scripts\scheduled\scheduled-blocklist-update.bat` daily at 9am.
The repo source is `.claude/scripts/scheduled/`; the forward sync (`scripts/sync-to-active.sh`, from `main` only)
installs it, so the job that runs is always main's version, not the primary checkout's branch. The .bat keeps
the durable log (`.claude/logs/blocklist-update.log`) and passes its arguments unchanged to `scheduled-blocklist-update.ps1`.
The job never touches the primary checkout's branch or working tree. It works in a temporary detached
worktree of `fork/main` and:
1. Fetches `fork main`
2. Fetches latest advisories from GitHub and updates `malicious-packages.json`
3. Rebuilds hooks
4. Commits to `main` and pushes `HEAD:refs/heads/main` to fork, if changes found
5. Fast-forwards local `main` (also when step 4 found nothing, so an earlier partial run catches up), then syncs to `~/.claude/` from the temp worktree and checks `~/.claude/state/sync-cursor` equals local `main`
6. Removes the temp worktree

Exit codes: 0 ok, 1 a step failed, 2 `[PUSHED-NOT-SYNCED]` (local `main` or `~/.claude` did not follow the remote).
`-NoSync` waives only the `~/.claude` sync; a failed local update still returns 2.

Point the task at the installed copy once, after the sync has installed it:
`pwsh -File .claude/scripts/scheduled/register-blocklist-task.ps1 -WhatIf`, then without `-WhatIf`.
It refuses if the installed .bat is missing and saves the old task XML under `~/.claude/state/`.

Task name: `CCv3-Blocklist-Update`. Check status: `schtasks /query /tn "CCv3-Blocklist-Update"`

If the machine is off at 9am, it runs when the machine next wakes up (`-StartWhenAvailable`).

### Manual

When a new supply-chain attack is disclosed:
1. Add the package to `.claude/hooks/src/shared/malicious-packages.json`
2. Rebuild: `cd .claude/hooks && npm run build`
3. Sync: `bash scripts/sync-to-active.sh`

## Background

On March 24, 2026, LiteLLM versions 1.82.7-1.82.8 were published to PyPI with a credential-stealing payload. The attack used a `.pth` file that auto-executed on every Python process startup, harvesting SSH keys, cloud credentials, K8s configs, and API keys. LiteLLM gets 3.4M downloads/day — anyone who installed during the window was compromised.

This hook would have caught it at Layer 2 (blocklist), Layer 3 (OSV.dev — the OSSF malicious-packages repo flagged it as MAL-), and Layer 4 (age check — the malicious versions were yanked within hours).
````
