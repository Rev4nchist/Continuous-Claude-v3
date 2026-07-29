# Package Install Safety

Every package install command — `pip`/`uv`/`poetry`, `npm`/`yarn`/`pnpm`/`bun`, `cargo`, `go`,
`gem`/`bundle`, `composer` — is intercepted by the `package-install-guard` PreToolUse:Bash hook
and checked against four layers before it runs: typosquat detection, a known-malicious
blocklist, a live OSV.dev advisory query, and package age. Read/list/uninstall commands
(`pip list`, `npm info`, `pip uninstall`, …) pass straight through.

## If an install is blocked, it is a finding, not an obstacle [C:10]

A block means the guard matched something real. **Do not route around it** — not with
`SKIP_PACKAGE_GUARD=1`, not by switching package manager, not by wrapping the install in a
script or a `bash -c`. The override exists for the case where *you have manually verified the
package*, and it skips all four checks; reaching for it because an install failed is exactly
the failure mode the guard is there to prevent.

Read the block reason first. A typosquat block names the package you probably meant. A `MAL-`
advisory means confirmed malware — that package is not installable, at any version. An age
block (<24h) is usually satisfied by waiting rather than overriding: malicious releases are
typically yanked within hours, which is precisely why the check exists.

## Detail

Per-block-class remediation, the four-layer table, the full guarded/passthrough command lists,
how to update the blocklist (automatic via `scripts/update-blocklist.mjs`, the daily
`CCv3-Blocklist-Update` scheduled task, or by hand), and the LiteLLM incident this was built
after: `docs/hooks/package-install-guard.md`. Read it when interpreting a block or updating the
blocklist — verbatim pre-split snapshot included.
