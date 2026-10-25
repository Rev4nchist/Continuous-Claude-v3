# Git hooks

This directory is the repo-local Git `core.hooksPath`. It is separate from Claude Code hooks under `.claude/hooks/`.

The `pre-commit` hook scans staged changes with gitleaks. If the `gitleaks` binary is missing from `PATH`, the hook exits 1. That fail-closed behavior is deliberate: install gitleaks, or bypass with a stated reason (humans only; see below).

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

## `core.hooksPath` replaces `.git/hooks`

While `core.hooksPath` is `.githooks`, Git does not run hooks installed under `.git/hooks`. That includes the build-forget pre-commit guard and the post-commit sync installed by `scripts/install-hooks.sh`. Those installers still target `.git/hooks` for clones that have not set `hooksPath`.

## Bypass policy

- A human may skip the local hook with `git commit --no-verify` only for a stated reason: a false positive pending allowlist, or gitleaks unavailable on that machine. They must put `hook-bypass: <reason>` in the commit message body.
- Agents (Claude Code, Cloud Agents) never use `--no-verify`. On a hit, an agent stops and reports.
- The CI `gitleaks` job is the backstop. It never skips silently: no `continue-on-error`, no conditional skip. A red gitleaks check is P0: rotate/revoke the credential, never rewrite history, then wake PM + David.
- A false positive is fixed by adding an exact fingerprint to `.gitleaksignore` with a triage comment, in its own reviewed commit. Never blanket-allow a path or rule. Add a `.gitleaks.toml` only if a fingerprint cannot express the fix, and record why in the PR body.
