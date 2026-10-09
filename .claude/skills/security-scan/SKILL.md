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

Run every scan through the gate. Never call a scanner directly.

```
node scripts/security/scoped-scan.mjs <deps|secrets|fs|web|allowlist> [arg]
```

The `scan-scope-guard` hook blocks a direct `nuclei`, `sqlmap`, `nikto`,
`masscan`, `wpscan` or `dalfox`. Use the wrapper. The `web` command denies any
host you do not own (deny by default, fails closed). Owned means loopback or a
host in `.claude/project-registry.json`.

## Commands

| Command | What it runs | Target | Network? |
|---|---|---|---|
| `deps [dir]` | `npm audit` + `osv-scanner` | the local repo | no |
| `secrets [dir]` | `gitleaks` | the local repo | no |
| `fs [dir]` | `trivy fs` (vuln, misconfig, secret) | the local repo | no |
| `web <url>` | `nuclei` baseline | an **owned** URL only | yes, gated |
| `allowlist` | prints the owned hosts | - | no |

A missing tool is reported and skipped. The runner never installs one. Install
a scanner yourself if you want it (`nuclei`, `trivy`, `gitleaks`, `osv-scanner`
are single binaries).

## Workflow

1. **Confirm the target.** For a `web` scan, name the URL and confirm you own it.
   Run `node scripts/security/scoped-scan.mjs allowlist` to see owned hosts.
2. **Local scans first** (safe, no network): `deps`, then `secrets`, then `fs`.
3. **Dynamic scan** (confirm first): `web <owned-url>` against a running dev or
   preview instance.
4. **Report.** Summarize findings by severity. Propose fixes. Do not auto-fix a
   dependency bump or config change without the user's yes.
5. **Verify a fix** with `arbiter`, same as the `security` skill.

## How every repo benefits

Any project with a `url` in `.claude/project-registry.json` gets the dynamic
scan for free, bounded to its own declared target. No per-repo setup.

## Guardrails

- Never scan a host you do not own. It may be illegal.
- Defensive tools only. No exploitation, password attacks or third-party recon.
- `web` is outward-facing network activity. Confirm before each run.
