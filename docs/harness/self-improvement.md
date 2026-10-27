# Self-improvement

[Back to the README](../../README.md) · [All harness pages](README.md)

*Moved from the README on 2026-10-26. The text moved word for word. Edits made while PR 168 was reviewed fix facts that were stale or wrong, and lines that start with "Status on 2026-10-26" are dated notes.*

The harness reviews itself on a schedule and turns findings into pull requests.

- `scripts/self-improvement/run-research.ps1` runs each day. It picks the next of 11 components
  from `scripts/self-improvement/components-manifest.json`. A headless session researches it and never edits code. It
  writes a cited proposal to `docs/self-improvement/proposals/` with an ADOPT, WATCH or SKIP
  verdict. The loop started in
  commit `ccbc67e` (2026-06-30).
- Each correction from the operator becomes a stored learning (`USER_PREFERENCE` or
  `FAILED_APPROACH`), so the next session recalls it.
- A weekly audit checks rule-router precision (PR #60). Rules that fire on the wrong command go
  to a capture log for a weekly review (PR #62).
- A deep evaluation on 2026-09-23 produced 7 merged pull requests, #45 to #51.

Measured result: PR #53 set the rule that a test must fail when its behaviour breaks. PR #54
then audited all 109 hook test files. It deleted 11 files and 290 tests that could not catch a
bug, which left 98 files. For each deletion, the audit broke the target code and saw the test
stay green, or it confirmed the target was dead code.
