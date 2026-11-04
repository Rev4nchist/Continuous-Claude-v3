# Provenance: Cloudflare security findings contract

- Source: https://github.com/cloudflare/security-audit-skill
- Commit: `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8` (fetched 2026-11-03 with `git init`, `git fetch --depth 1 <url> <sha>`, `git checkout FETCH_HEAD`).
- License: MIT, Copyright (c) 2025-2026 Cloudflare, Inc. See `LICENSE`.
- Proposal: `docs/self-improvement/proposals/2026-11-03-cloudflare-security-audit-skill.md` (Option 4, phase P1).

## Files

`vendor.lock.json` records the git blob ID and the sha256 of each file. The files are verbatim. Do not edit them.
`.gitattributes` sets `-text`, so git never changes their line endings.

| File | Upstream path |
|---|---|
| `report-schema.json` | `skills/security-audit/report-schema.json` |
| `validate-findings.cjs` | `skills/security-audit/validate-findings.cjs` |
| `LICENSE` | `LICENSE` |

Not vendored: `SKILL.md` and the other docs, `validate-coverage-ledger.cjs` (no coverage ledger in CCv3 yet), and the upstream `.test.cjs` files.

## Why a wrapper

The upstream CLI exits 1 for every input on Windows.
It needs `fs.constants.O_NOFOLLOW` and `O_NONBLOCK`, which are `undefined` on win32 Node 22 (`validate-findings.cjs:605-609`).
`../cf-validate.mjs` reads the file itself and calls the exported `validateDocument`.

Differences from the upstream CLI:

- **Symlink check.** The wrapper uses `lstat` and then a read. Upstream opens with `O_NOFOLLOW`. A file swapped between the two calls is not caught. This is acceptable for a local report file.
- **No pre-parse scan.** Upstream scans the raw text for nesting over 64 and arrays over 1,000 items before `JSON.parse`. The wrapper relies on the 5 MiB cap, catches any `JSON.parse` error, and then uses the iterative `collectDataLimitErrors` inside `validateDocument` (`validate-findings.cjs:207-226`). That function enforces the same limits.
- **Integrity.** The wrapper checks the sha256 of each vendored file against `vendor.lock.json` before it runs.
- **Paths are not changed.** A Windows path in a finding fails, as upstream intends (`isSafeRelativeSourcePath`, `validate-findings.cjs:473-483`).

## Output file name

Name the output `security-findings.json`. The R4 review `findings.json` (contract v1.1) is a different shape.
