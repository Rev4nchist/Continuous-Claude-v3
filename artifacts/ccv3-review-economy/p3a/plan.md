# Plan: CCV3-P3A-CI

Builder: Claude Code (claude-opus-5-5) on ROG. Worktree `C:\Users\dkhay\cc-wt\p3a`, branch `feat/ccv3-p3a-ci`, PR #157 (draft until the card is Ready).

## Steps (done)
1. Baseline the 5 ratchets on `main` 1db5a6c7: all exit 0, also with no `~/.claude/settings.json` (CI-like home).
2. Pin tools. Trivy 0.75.0 (immutable release, sha256 `c6e65abd...b3f3f`). Semgrep 1.179.0 by index digest `sha256:93963d92...e01b`. trivy-action is not used: its tags were hijacked in March 2026 (GHSA-69fq-xp46-6x23).
3. Baseline scans on `1db5a6c7`: Trivy 121 HIGH/CRITICAL (opc/uv.lock 90, apps/agentic-os 19, dashboard frontend 12); Semgrep 33 ERROR (child-process 15, shell-true spawns 7, raw SQL 5, test-fixture secret patterns 6).
4. Write `scan-ratchet.mjs` and its 12 tests; add DRIFT for files the change did not touch (vuln DB and rule packs change daily).
5. Remove the guard from the template; correct the two docs.
6. Local proof: seeded Semgrep finding fails (exit 1) when its file changed, DRIFT (exit 0) when not.
7. CI proof on #157: green `78a6ddbd` (run 40384792234), red seed `4cf82135` (run 40385900340), green revert `41c2adc4` (run 40386865527).

## Verification artifact
`.claude/cache/e2e/2026-10-26-p3a-ci-local.txt` (local) and the evidence comment on #157.

## After merge
Forward sync runs from `land-pr.ps1`. No live settings change is needed (the guard was never registered live). Watch the first monthly Dependabot PRs for Greptile cost.
