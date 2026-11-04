---
name: security
description: Security audit workflow -- vulnerability scan then verification. Use when the user says "security audit", "check for vulnerabilities", "is this secure", "/security" or asks to review auth or payment code.
---

# /security - Security Audit Workflow

Dedicated security analysis for sensitive code.

## When to Use

- "Security audit"
- "Check for vulnerabilities"
- "Is this secure?"
- "Review authentication code"
- "Check for injection attacks"
- Before handling auth, payments, user data
- After adding security-sensitive features

## Workflow Overview

```
┌─────────┐    ┌──────────────────┐    ┌──────────┐    ┌───────────┐
│  aegis  │───▶│ security-refuter │───▶│  record  │───▶│  arbiter  │
└─────────┘    └──────────────────┘    └──────────┘    └───────────┘
  Hunt           Try to refute           Validate        Verify
  candidates     each candidate          the record      fixes
```

## Agent Sequence

| # | Agent | Role | Output |
|---|-------|------|--------|
| 1 | **aegis** | Hunt: candidates with principal, control, trace, boundary result | Report + `## Candidates (JSON)` |
| 2 | **security-refuter** | Fresh agent that did not hunt: tries to refute each candidate | One verdict per candidate |
| 3 | you (main session) | Write and validate `security-findings.json` | PASS from `cf-validate.mjs` |
| 4 | **arbiter** | Verify fixes, run security tests | Verification report |

**Budget:** at most 6 Opus agent calls per run: 1 aegis + up to 5 security-refuter calls.
Send each refuter call a batch of up to 8 candidates. Over 40 candidates: stop and ask the user which to verify.
Results are advisory. An open finding does not block a PR's READY state.
Method adapted from cloudflare/security-audit-skill (MIT); see `docs/security/review-briefs/THIRD-PARTY-NOTICES.md`.

## Why Dedicated Security?

The `/review` workflow focuses on code quality. Security needs:
- Specialized vulnerability patterns
- Dependency scanning
- Secret detection
- OWASP Top 10 checks
- Authentication/authorization review

## Execution

### Phase 1: Security Audit

```
Task(
  subagent_type="aegis",
  prompt="""
  Security audit: [SCOPE]

  Scan for:

  **Injection Attacks:**
  - SQL injection
  - Command injection
  - XSS (Cross-Site Scripting)
  - LDAP injection

  **Authentication/Authorization:**
  - Broken authentication
  - Session management issues
  - Privilege escalation
  - Insecure direct object references

  **Data Protection:**
  - Sensitive data exposure
  - Hardcoded secrets/credentials
  - Insecure cryptography
  - Missing encryption

  **Configuration:**
  - Security misconfigurations
  - Default credentials
  - Verbose error messages
  - Missing security headers

  **Dependencies:**
  - Known vulnerable packages
  - Outdated dependencies
  - Supply chain risks

  Use the Hunt Method (principal, input, control, trace, boundary result).
  Run id: [RUN-ID: today's date plus a short scope word, or plus -adhoc]. Probes go under .claude/cache/security/[RUN-ID]/probes/.

  Output: Detailed report with:
  - Severity (CRITICAL/HIGH/MEDIUM/LOW)
  - Location (file:line)
  - Description
  - Remediation steps
  - The ## Candidates (JSON) block
  """
)
```

### Phase 1.5: Dynamic scan (optional, your own target)

Phase 1 reads code (static). To also scan a running app and its dependencies
(dynamic), run the `security-scan` skill. It is scope-gated to targets you own
and confirm-first:

```
/security-scan          # then: deps, secrets, fs, and web <owned-url>
```

Use it when the project has a running instance or a registry `url`. Skip it for
a pure static review.

### Phase 2: Refute

Read the `## Candidates (JSON)` block from the aegis report. Zero candidates: skip to Phase 3.
For each batch of up to 8 candidates, spawn a fresh refuter. From each candidate send only `fingerprint`, `title`, `description`, `principal`, `control`, `boundary_result`, `trace`, `evidence`, `severity` and `probe`, plus the probe's `.out.txt` path. Never send the other fields, aegis's report text or another batch's verdicts.

```
Task(
  subagent_type="security-refuter",
  prompt="""
  Candidates: [JSON array of candidate objects for this batch]
  Probe outputs: [probe path -> .out.txt path, for candidates that have one]
  Repo: $CLAUDE_PROJECT_DIR
  """
)
```

### Phase 3: Record and Validate

Write `$CLAUDE_PROJECT_DIR/.claude/cache/security/[RUN-ID]/security-findings.json`: one record per candidate.
Sort records by `fingerprint` in ordinal (code unit) order: uppercase before lowercase, no locale rules. PowerShell `Sort-Object` is not ordinal; sort in Node.
Build each record from the candidate plus the refuter verdict, in the shape of `~/.claude/scripts/security/cf-contract/report-schema.json`.
Every record has `verdict`, `fingerprint`, `title`, `description`, `trace` and `evidence`. Then:

| Verdict | Add | Rename | Drop |
|---|---|---|---|
| `confirmed` | `root_cause`, `intended_behavior`, `conditions`; `execution` = {`attacker_perspective`, `payloads`, `instructions`: [the probe command], `observed_result`: the probe output}; `remediation` = {`strategy`: `remediation_strategy`}; refuter `severity` and `confidence` | none | top-level `attacker_perspective`, `payloads`, `remediation_strategy` (now nested); `principal`, `control`, `boundary_result`, `probe`, `reason`, `probe_reproduced`, `checked` |
| `needs_validation` | refuter `blockers`; `validation_plan` = {`local`: refuter `validation_plan`} | `root_cause` to `claimed_root_cause` | everything else |
| `rejected` | refuter `reason` | `root_cause` to `claimed_root_cause` | everything else |

The schema allows no extra fields: drop every field the table does not name.

`confirmed` needs a probe that the refuter re-ran. With no probe, the best verdict is `needs_validation`.
Then validate:

```
node "$HOME/.claude/scripts/security/cf-validate.mjs" ".claude/cache/security/[RUN-ID]/security-findings.json"
```

On FAIL, fix the record and re-run. Never edit the validator or its schema. Report the PASS line with the counts per verdict.
Show `confirmed` findings in the report box below. List `needs_validation` with its blocker. Show `rejected` as a count only.

### Phase 4: Verification (After Fixes)

```
Task(
  subagent_type="arbiter",
  prompt="""
  Verify security fixes: [SCOPE]

  Run:
  - Security-focused tests
  - Dependency audit (npm audit, pip audit)
  - Re-check reported vulnerabilities
  - Verify fixes don't introduce regressions

  Output: Verification report
  """
)
```

## Security Scopes

### Full Codebase
```
User: /security
→ Scan entire codebase
```

### Specific Area
```
User: /security authentication
→ Focus on auth-related code
```

### Single File
```
User: /security src/api/auth.py
→ Deep dive on one file
```

### Dependencies Only
```
User: /security --deps
→ Only dependency vulnerabilities
```

## Example

```
User: /security the payment processing code

Claude: Starting /security audit for payment code...

Phase 1: Security audit...
[Spawns aegis]

┌─────────────────────────────────────────────────────────────┐
│ Security Audit Report                                       │
├─────────────────────────────────────────────────────────────┤
│ Scope: src/services/payment/                                │
│ Files scanned: 12                                           │
│ Lines analyzed: 2,847                                       │
├─────────────────────────────────────────────────────────────┤
│ CRITICAL (1)                                                │
│ ──────────                                                  │
│ [C1] SQL Injection in payment.py:89                         │
│      query = f"SELECT * FROM orders WHERE id = {order_id}"  │
│      Fix: Use parameterized queries                         │
│                                                             │
│ HIGH (2)                                                    │
│ ────────                                                    │
│ [H1] Hardcoded API key in stripe_client.py:12               │
│      STRIPE_KEY = "sk_live_..."                             │
│      Fix: Move to environment variable                      │
│                                                             │
│ [H2] Missing input validation in refund.py:45               │
│      amount = request.json['amount']  # No validation       │
│      Fix: Validate amount is positive number                │
│                                                             │
│ MEDIUM (1)                                                  │
│ ──────────                                                  │
│ [M1] Verbose error messages in error_handler.py:23          │
│      return {"error": str(e)}  # Leaks internal details     │
│      Fix: Return generic message, log details internally    │
│                                                             │
│ LOW (0)                                                     │
│ ───────                                                     │
│ None                                                        │
├─────────────────────────────────────────────────────────────┤
│ Summary: 1 critical, 2 high, 1 medium, 0 low                │
│ Status: ADVISORY - fix critical issues before release       │
└─────────────────────────────────────────────────────────────┘

Fix the critical and high issues, then run:
/security --verify
```

### After Fixes

```
User: /security --verify

Claude: Phase 4: Verifying fixes...
[Spawns arbiter]

✅ C1: SQL injection fixed - using parameterized queries
✅ H1: API key moved to environment variable
✅ H2: Input validation added
✅ M1: Error messages sanitized

All security tests passing.
Security audit: PASSED
```

## OWASP Top 10 Coverage

The report lists each risk as `ran` or `not ran` for this scope. Never mark a risk `ran` that the run did not check.

| Risk | Status |
|------|--------|
| A01 Broken Access Control | ran / not ran |
| A02 Cryptographic Failures | ran / not ran |
| A03 Injection | ran / not ran |
| A04 Insecure Design | ran / not ran |
| A05 Security Misconfiguration | ran / not ran |
| A06 Vulnerable Components | ran / not ran |
| A07 Auth Failures | ran / not ran |
| A08 Data Integrity Failures | ran / not ran |
| A09 Logging Failures | ran / not ran |
| A10 SSRF | ran / not ran |

## Flags

- `--deps`: Dependencies only
- `--verify`: Re-run after fixes
- `--owasp`: Explicit OWASP Top 10 report
- `--secrets`: Focus on secret detection
