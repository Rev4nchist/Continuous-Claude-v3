---
name: security-scan
description: Runs defensive, scope-gated dynamic security scans against an owned target. Use when the user says "/security-scan", "scan the app", "dynamic scan", "DAST", "dependency CVE scan", or "scan the running app for vulnerabilities". Not for static code review -- that is the security skill.
disable-model-invocation: true
---

# /security-scan - defensive dynamic scanning

The dynamic half of CCv3 security. The `security` skill reads code (static). This
skill runs scanners against your own running app and dependencies (dynamic).

Offensive tooling does not belong in a harness loaded into every repo. So this
skill is defensive only, scoped to targets you own, confirm-first, and never
ambient. Background: the HexStrike AI eval in `docs/self-improvement/proposals/`.

## The one rule

Run every scan through the runner. It is installed in `~/.claude`, so it works
from any project. Local commands scan the current directory.

```
node "$HOME/.claude/scripts/security/scoped-scan.mjs" <deps|secrets|fs|web|check|allowlist> [arg]
```

The runner's scope gate is the control. `web` denies any host you do not own:
deny by default, fails closed. Owned means loopback or a host in the project
registry. No environment variable can change that list.

The `scan-scope-guard` hook is a reminder, not a boundary. When a scanner such as
`nuclei` or `sqlmap` is typed as the command, it denies the call and points here.

## Commands

| Command | What it runs | Target | Sends data off the machine? |
|---|---|---|---|
| `deps [dir]` | `npm audit` + `osv-scanner` | the local repo | yes: package names and versions go to the npm registry and OSV advisory APIs |
| `secrets [dir]` | `gitleaks` | the local repo | no |
| `fs [dir]` | `trivy fs` (vuln, misconfig, secret) | the local repo | yes: downloads trivy's vulnerability database |
| `web <url>` | `nuclei` baseline | an **owned** URL only | yes: requests to that URL; nuclei may update its templates |
| `check <url>` | the gate decision only | - | no; never scans |
| `allowlist` | prints the owned hosts | - | no |

A missing tool is reported and skipped. The runner never installs one.

## Workflow

1. **Confirm the target.** For a `web` scan, name the URL and confirm you own it.
   `check <url>` shows the decision without scanning. `allowlist` lists owned hosts.
2. **Repo scans:** `secrets` (fully offline), then `deps` and `fs` (these contact
   advisory services, see the table).
3. **Dynamic scan** (confirm first): `web <owned-url>` against a running dev or
   preview instance.
4. **Report.** Summarize findings by severity. Propose fixes. Do not auto-fix a
   dependency bump or config change without the user's yes.
5. **Verify a fix** with `arbiter`, same as the `security` skill.

## How every repo benefits

Any project with a `url` in the project registry gets the dynamic scan, bounded
to its own declared target. No per-repo setup.

## Guardrails

- Never scan a host you do not own. It may be illegal.
- Defensive tools only. No exploitation, password attacks or third-party recon.
- `web` is outward-facing network activity. Confirm before each run.
