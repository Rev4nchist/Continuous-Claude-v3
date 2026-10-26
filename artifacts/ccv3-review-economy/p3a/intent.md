# Intent: CCV3-P3A-CI (DW-80 split 1/3, Phase 3)

Slug: `ccv3-review-economy/p3a` · Repo: `Rev4nchist/Continuous-Claude-v3` · Base: `main` @ `1db5a6c7` (#155 merge)
Card: https://app.notion.com/p/40576fd7ac828115a8acc86495e35e53 · Parent: DW-80 https://app.notion.com/p/40276fd7ac8281d2b9eff402095880c3 · Order 60.451
Status: **Ready**, set by Claude Code for Dev PM with Dave's yes (2026-10-26, decisions A1–A3). Grok audits after 2026-10-29.
Source: Wiring Plan 2026-10-25 §3 step 3–4, §5 Phase 3; DW-80 Acceptance (4) and the 10-24 scanner-CI note (PLAN-SECURITY §4/§6.2/§10).

## Why
Only gitleaks ran in CI. A PR could break a repo ratchet (context budget, skill audit, agent model drift, agent body, hook manifest) or add a vulnerable dependency, and nothing on GitHub went red. Phase 3 needs real CI before the router and READY v2 depend on "CI green".

## What (one PR, #157)
1. `.github/workflows/ccv3-checks.yml`: the 5 node ratchets plus the scan-ratchet unit tests; Trivy `fs` HIGH/CRITICAL; Semgrep `p/default`.
2. `scripts/ratchets/scan-ratchet.mjs` (+ tests): new HIGH/CRITICAL (Trivy) or ERROR (Semgrep) findings in files the change touched fail; existing findings are baselined; new findings in untouched files print as DRIFT.
3. Baselines on `1db5a6c7`: `trivy-baseline.json`, `semgrep-baseline.json`, each with a reason.
4. `.github/dependabot.yml`: monthly, grouped, 1 open PR per ecosystem, rebase off, 7-day cooldown.
5. `settings.json.template`: remove the 4 `coderabbit-guard` blocks until the guard is registered live (Dave, 2026-10-26).

## Done when
- Spec AC1–AC7 pass (`spec.md`).
- CI red on a seeded failure, green on its revert, with run URLs on the PR.
- Human merge only. Push to `fork` (Rev4nchist) only; never parcadei; no force-push.

## Out of scope
Hook vitest in CI (after the Windows failure triage). Greptile trigger change (P3b, held for the Apex RCA). Router and ledger (P3c). Fixing baselined findings (Dependabot PRs shrink the Trivy baseline).

## Waiver
Cross-family xreview (Gate 17) waived for this CI-only PR by Dave on 2026-10-26. Builder: Claude Code (claude-opus-5-5). P3b and P3c wait for the 10-29 xreview.
