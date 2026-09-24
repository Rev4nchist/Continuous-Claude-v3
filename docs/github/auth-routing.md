# GitHub auth and routing on this machine

Moved out of the always-loaded `windows-platform` rule on 2026-09-24 (context-loading proposal, phase 1).
The rule keeps the short version. This file keeps the history, the corrections and the re-auth procedure.

## `gh` CLI: interactive by default + `read:org` scope gaps → use the REST API [H:8]

- `gh pr merge` / `gh pr create` are **interactive by default** → they HANG in the non-interactive tool shells. For scripted use, prefer `gh api` (REST): `gh api repos/<O>/<R>/pulls/<N>/merge -X PUT -f merge_method=merge`.
- `gh pr edit` / `gh pr view` (and other porcelain) issue GraphQL that needs `read:org`. **RESOLVED 2026-08-05 — GraphQL porcelain works now** (`gh pr list` verified returning results). The REST fallback is still the right choice for *scripted* use because it is non-interactive, but it is no longer a workaround for a broken scope: `gh api repos/<O>/<R>/pulls/<N> -X PATCH -f title=… -f body="$B"`.
- **The old remediation in this file was impossible, and that is why it never worked.** It said "run `gh auth refresh -h github.com`" — which `gh auth status` also suggests. On this machine that was a dead end: `gh` had **no stored credential at all** (no `%APPDATA%\GitHub CLI\`, no `hosts.yml` anywhere), and a User-scope `GITHUB_TOKEN` classic PAT outranked stored credentials anyway (precedence: `GH_TOKEN` > `GITHUB_TOKEN` > stored). `gh auth refresh` refreshes gh's *own OAuth* credential; with none stored there was nothing to refresh, and a classic PAT's scopes live on github.com, not in gh. **Do not suggest `gh auth refresh` against an env-var token.**
- **The actual fix** was to bootstrap the per-account OAuth logins that `scripts/github/gh-for.ps1` was written for but which had never been created:
  - `~/.config/gh-personal` → `Rev4nchist`, `~/.config/gh-work` → `david-hayes44`, both keyring-stored, both with `read:org`.
  - User-scope `GITHUB_TOKEN` removed (the PAT is orphaned — revoke it at github.com/settings/tokens).
  - User-scope `GH_CONFIG_DIR` now defaults to `gh-personal`, because **without a default, bare `gh` has no credential at all** — gh falls back to `%APPDATA%\GitHub CLI\`, which does not exist. `gh-for.ps1` still overrides per-invocation for repos whose remote owner routes elsewhere.
  - Caveat when logging in: `--web` stores whichever account the **browser session** holds, not the one you intended. The work credential initially landed in `gh-personal` for exactly this reason. Always verify with `pwsh -File scripts/github/verify-github-accounts.ps1` (it clears `GH_TOKEN` and `GITHUB_TOKEN` before each probe) rather than trusting the login's own success message.
- **`verify-github-accounts.ps1` layer 2 could hang the whole verifier** (fixed 2026-08-05). `git credential fill` asks Git Credential Manager, whose default on a MISS is a **GUI prompt** — which blocks forever in a tool/scheduled shell, at 0% CPU, producing ZERO output on kill. It now passes `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never` and `-c credential.interactive=false` so a miss FAILS instead of asking. A verifier that can hang is a verifier nobody runs — which is how all four identity layers stayed unverified while the setup was misconfigured.
- **A timed-out `gh`/`git` command (exit 143) is NOT proof of failure** — the op often already succeeded server-side. VERIFY (`gh api …/pulls/<N>` → `merged`) before retrying.

### Plain `git` and bare `gh` now route themselves (2026-08-11)

The wrappers are no longer the only correct path. Three changes, all verified by a
64-remote sweep (`scripts/github/sweep-remotes.ps1`) that went from **25 failures to 1**:

- **`~/.gitconfig` picks the account.** `credential."https://github.com".username = Rev4nchist`
  gives GCM the tiebreak it lacked, and `url."https://david-hayes44@github.com/fourth/".insteadOf`
  rewrites work URLs at transport time. All 9 `fourth/*` remotes match that prefix — verified by
  `scripts/github/audit-remotes.ps1`, not assumed.
- **The global `wincred` helper and the ambiguous `git:https://github.com` credential are gone.**
  That pair was the real defect: with no username GCM could not choose, and wincred answered from a
  host-level entry mapping to **david-hayes44**, so every *personal* repo silently authenticated as
  the *work* account and 404'd. That is what "Repository not found" on a repo you own means here.
  Removing wincred was safe because **every** `git:` entry in Credential Manager was github.com —
  no other host depended on it.
- **Bare `gh` routes by directory** via `scripts/github/gh-shim.ps1`, dot-sourced from both
  PowerShell profiles. It shares `accounts-lib.ps1` with the wrappers rather than copying the
  mapping. A function only affects profile-loading shells, so scripts calling `gh` directly are
  unchanged — those should still use `gh-for.ps1`.

Corrections to what was believed before:

- **`gh-for.ps1` could not run any gh command in either of its documented forms** until 2026-08-11.
  `[CmdletBinding()]` with `$Path` first made `$Path` positional 0, so `gh-for.ps1 api …` bound
  `api` to `-Path` and failed with `cannot determine an account for 'api'` — an argument-binding
  bug wearing a routing-config error message. A `--` separator does not help: `pwsh -File` hands
  `--` to its own binder. Fixed with `PositionalBinding = $false`, which `git-for.ps1` had all along.
- **`git remote -v` does NOT stay clean** under an `insteadOf` rule — it prints the rewritten URL.
  The *stored* config is untouched (`git config --get remote.origin.url` shows the original), which
  is the property that actually matters.
- **A no-username `git credential fill` still returns a credential, and should.** Once
  `credential.<url>.username` is set it resolves to the default account deterministically. The
  invariant worth guarding is *which* account answers, not whether one does — `verify-github-accounts.ps1`
  layer 5 asserts exactly that, plus a single-helper chain and a firing URL rewrite.
- **`gh-for.ps1 api …` for ad-hoc queries works now**, so the "no remote, no matching route" refusal
  is no longer a reason to reach for plain `gh`.
- **Deleting the ambiguous `git:https://github.com` entry does NOT stay done.** GCM recreates it on
  the next successful auth — observed the same day. That is fine, and it is why the ordering matters:
  **`credential.<url>.username` is the load-bearing fix**, because git then never asks without a
  username and the host-level entry is never consulted. Treat the deletion as hygiene, not as the
  control. Layer 5 checks the property that actually matters (which account answers a bare probe).

### Re-authenticating an account after revoking its OAuth grant

Revoking **GitHub CLI** under Settings → Applications → Authorized OAuth Apps kills a `gho_` token
that BOTH `gh` and Git Credential Manager may be holding, so `gh` and *plain git push* break
together for that account. Verified 2026-08-11 on `david-hayes44`: `gh api user` returned
`Bad credentials` and plain git returned `Invalid username or token`, while the other account was
untouched.

There is **no "reissue" button in the GitHub UI** — a revoked OAuth grant is recreated by re-running
the client's own login flow, which re-prompts for authorization:

1. Sign the browser into github.com **as the account being restored**. `--web` stores whichever
   account the BROWSER session holds, not the one you intended — this trap has already put the work
   credential in the personal config dir once.
2. `$env:GH_CONFIG_DIR="$HOME\.config\gh-work"; gh auth login --hostname github.com --git-protocol https --web`
3. In an **interactive** terminal, run a fetch in any work repo (`git -C <fourth repo> fetch origin`)
   and complete GCM's browser prompt. Because the `insteadOf` rule puts `david-hayes44@` in the URL,
   GCM is asked for that account specifically — no picker, no ambiguity.
4. Confirm with `pwsh -File scripts/github/verify-github-accounts.ps1` and
   `pwsh -File scripts/github/sweep-remotes.ps1`. A dead work credential shows up as exactly 9
   failures, one per `fourth/*` remote.

Rollback, credentials untouched throughout:
`git config --global credential.helper wincred`,
`git config --global --unset credential.https://github.com.username`,
`git config --global --unset url.https://david-hayes44@github.com/fourth/.insteadOf`.
