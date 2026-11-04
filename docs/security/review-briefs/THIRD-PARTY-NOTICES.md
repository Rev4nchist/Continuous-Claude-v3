# Third-party notices

Review text under `docs/security/review-briefs/` includes verbatim portions of MIT-licensed files from two upstream repositories. The LICENSE bodies below are the upstream bytes. Attribution only. No other files from either repository are vendored.

## anthropics/claude-code-security-review

- Commit: `0c6a49f1fa56a1d472575da86a94dbc1edb78eda`
- `.claude/commands/security-review.md` — blob `93651ea8b92194a1f739eaf5115ea493746df300` — lines 35–181 ported into `r4-security-axis.md`. Lines 1–33 and 183–191 were not ported.
- `LICENSE` — blob `aadec62f5cf87aae35a0423382bca6f2849abdb5` — whole file below.

The LICENSE blob has no trailing newline. The end marker follows the last license byte so a byte slice of the block equals the blob.

<!-- port-begin src=anthropics/claude-code-security-review@0c6a49f1fa56a1d472575da86a94dbc1edb78eda path=LICENSE lines=1-21 blob=aadec62f5cf87aae35a0423382bca6f2849abdb5 -->
MIT License

Copyright (c) 2025 Anthropic

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.<!-- port-end -->

## cloudflare/security-audit-skill

- Commit: `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8`
- `skills/security-audit/ATTACK-CLASSES.md` — blob `18a2beb4dbb554fb52b0a0293b8bd9108207f8fa` — lines 111–130 ported into `r4-security-axis.md`; lines 1–130 ported into `r5-high-tier.md`.
- `skills/security-audit/DATA-ISOLATION-AND-LIFECYCLE.md` — blob `0cba1fa463b62c9b0caba710a201e29c1eecd0ec` — lines 1–84 ported into `r4-security-axis.md`.
- `skills/security-audit/AI-AND-LLM.md` — blob `02ba9039eca4cec811fefc77bce0d7349b379aae` — lines 1–83 ported into `r5-high-tier.md`.
- Method adapted, no verbatim text: the hunt facts from `HUNTING.md` (blob `377d4dcfbe88a049379448cd7892717185401597`) and the fresh-refuter verdicts from `VALIDATION-AND-REPORTING.md` (blob `5e200d7387e665e53e0e4190fa4a5814c334c507`), restated in `.claude/agents/aegis.md`, `.claude/agents/security-refuter.md` and `.claude/skills/security/SKILL.md`.
- Vendored verbatim with their own notice: `report-schema.json` and `validate-findings.cjs` in `.claude/scripts/security/cf-contract/` (see its `PROVENANCE.md`).
- `LICENSE` — blob `6dbc9ecb3a5b9080e95b962869e8c7ab16cfdc20` — whole file below.

<!-- port-begin src=cloudflare/security-audit-skill@c1c8a8c1471069fb0e188eeaff69b8e8db6564a8 path=LICENSE lines=1-21 blob=6dbc9ecb3a5b9080e95b962869e8c7ab16cfdc20 -->
MIT License

Copyright (c) 2025-2026 Cloudflare, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
<!-- port-end -->
