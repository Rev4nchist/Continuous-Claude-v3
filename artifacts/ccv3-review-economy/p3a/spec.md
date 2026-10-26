# Spec: CCV3-P3A-CI

## Acceptance
- **AC1 Ratchets in CI.** On every PR to `main` and every push to `main`, an Actions job runs `context-budget-guard.mjs --repo`, `audit-skills.mjs`, `check-agent-model-drift.mjs .`, `check-agent-body.mjs`, `hook-manifest-check.mjs --repo` and `node --test scripts/ratchets/scan-ratchet.test.mjs`. Any non-zero exit fails the job.
- **AC2 Trivy.** `trivy fs --scanners vuln,misconfig,secret --severity HIGH,CRITICAL` runs from the official release binary, pinned by version and sha256. Its JSON goes through `scan-ratchet.mjs --tool trivy`.
- **AC3 Semgrep.** `semgrep scan --config p/default --metrics=off` runs from the `semgrep/semgrep` image pinned by digest. Its JSON goes through `scan-ratchet.mjs --tool semgrep`. ERROR (and CRITICAL/HIGH) results count; WARNING and INFO do not.
- **AC4 Ratchet rule.** A finding key (Trivy: kind|target|id|package; Semgrep: rule|path) that is new or more frequent than the baseline fails if its file is in the change's changed-file list, and prints as DRIFT otherwise. Fixed findings pass and are listed. A malformed report or baseline exits 2 (never read as clean). `--update` needs `--reason`.
- **AC5 No vacuous gate.** A seeded commit turns the workflow red and its revert turns it green. Run URLs are on the PR.
- **AC6 Supply chain.** No third-party action tags. `actions/checkout` and `actions/setup-node` are pinned by commit SHA. Dependabot is monthly, grouped, at most 1 open PR per ecosystem, rebase off, 7-day cooldown.
- **AC7 Template.** `settings.json.template` registers no `coderabbit-guard`; the file equals `718012f0` (pre-#155). `coderabbit-cli.md` and `hook-catalog.md` say the guard is not registered.

## Failure modes the tests cover (scan-ratchet.test.mjs)
New key missed; old key flagged; count increase missed; MEDIUM/LOW or WARNING counted; failed-only misconfig filter; report without SchemaVersion or results read as clean; missing or wrong-tool baseline read as clean; drift in an untouched file blocking; update without a reason.
