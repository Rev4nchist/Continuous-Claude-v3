# Git hooks

This directory is the repo-local Git `core.hooksPath`. It is separate from Claude Code hooks under `.claude/hooks/`.

The `pre-commit` hook scans staged changes with gitleaks, then chains the build-forget guard. If the `gitleaks` binary is missing from `PATH`, the hook exits 1 before the guard runs. That fail-closed behavior is deliberate: install gitleaks, or bypass with a stated reason (humans only; see below).

## Enable (one time per clone)

From the repo root:

```bash
git config core.hooksPath .githooks
```

This writes a repo-local setting in `.git/config`. Never pass `--global`.

## Local / Claude Code (rog-strix, Git Bash)

Run the command above in the repo root. Claude Code uses the same clone config, so there is nothing extra to set.

Install gitleaks from the official release binary, `winget install gitleaks`, or `scoop install gitleaks`, at the same major version as CI (v8). The patch pin and checksum live in `.github/workflows/gitleaks.yml`.

## Cloud Agent

The Cloud Agent environment/setup step runs `git config core.hooksPath .githooks` after checkout and installs the same pinned binary. Cloud Agent prompts for this repo should include that line.

## Verify

```bash
git config --get core.hooksPath
```

Expected output: `.githooks`.

## What runs when `core.hooksPath` is `.githooks`

Git reads hooks from `.githooks` instead of `.git/hooks`. The same checks still run from this directory:

- **pre-commit:** gitleaks on staged changes, then `scripts/precommit-build-guard.sh` (build-forget) when that file is present. Gitleaks stays fail-closed. A guard failure exits with the guard's status.
- **post-commit:** `.githooks/post-commit` calls `scripts/post-commit-hook.sh` when that file is present (sync to `~/.claude`).

`scripts/install-hooks.sh` still installs copies under `.git/hooks` for clones that have not set `hooksPath`. After `core.hooksPath` is `.githooks`, use the hooks in this directory; do not expect the `.git/hooks` copies to run alongside them.

## Bypass policy

- A human may skip the local hook with `git commit --no-verify` only for a stated reason: a false positive pending allowlist, or gitleaks unavailable on that machine. They must put `hook-bypass: <reason>` in the commit message body.
- Agents (Claude Code, Cloud Agents) never use `--no-verify`. On a hit, an agent stops and reports.
- The CI `gitleaks` job is the backstop. It never skips silently: no `continue-on-error`, no conditional skip. A red gitleaks check is P0: rotate/revoke the credential, never rewrite history, then wake PM + David.
- A false positive is fixed by adding an exact fingerprint to `.gitleaksignore` with a triage comment, in its own reviewed commit. Never blanket-allow a path or rule. Add a `.gitleaks.toml` only if a fingerprint cannot express the fix, and record why in the PR body.
