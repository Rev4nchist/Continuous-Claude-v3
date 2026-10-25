# Security review briefs (R4 axis and R5 add-on)

Checked-in source for the R4 Security axis (L2) and the R5 high-tier security add-on. These templates replace DevBot's manual box brief.

DevBot reads or pastes a template at the reviewed SHA. Nothing in this directory is auto-loaded by an agent runtime.

- R4 Security axis: [r4-security-axis.md](r4-security-axis.md)
- R5 high-tier add-on: [r5-high-tier.md](r5-high-tier.md)
- Upstream licenses: [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)

## Who runs them

Reviews run only as Cursor Cloud Agents launched by DevBot: one fresh CA per review, read-only. No local Claude Code, no GitHub Action, no API-key path.

## Model rule

§7B.3 / Gate 19. Never the builder's family or session. No silent fallback: if the pool model is unavailable, stop and escalate.

| Builder family | Reviewer model |
| --- | --- |
| Claude-built (`builder:claude`) | `grok-4.7` High, fallback `composer-2.5` |
| Grok-built (`builder:grok`) | `composer-2.5` |
| Composer-built | `grok-4.7` |

Never OpenAI/GPT/Codex, never Auto/Cursor Router, never built-in helper subagents (Explore, Browser, or any Task/sub-task).

## Applicability

- **R4 Security axis.** Every non-docs PR, in the same R4 xreview CA and on the same model as the two-axis plus blast-radius review. One fresh CA per head, at most 3 heads per PR.
- **R5 add-on.** Only when R5 runs: high tier, steering files, infra or migration, or a hotfix within 24 h. It runs in a separate fresh CA after R4 is SHIP or Minor-only, at most 2 rounds.

## L2 shadow, then gate

Decision D1 (2026-10-24). The Security axis runs in shadow for the first 5 non-docs PRs that carry it. Findings go in `findings.json` and Gate 17, and they do not change the R4 verdict. After those 5 PRs, it gates: an open security P0 or Major means HOLD. DevBot writes `L2 mode: shadow (n/5)` or `L2 mode: gate` in each launch brief. This PR does not flip the gate. Flipping it is a later card.

## Output mapping

Map into the existing `findings.json` contract v1.1. The schema does not change.

- Severity: HIGH becomes `P0` when the impact is RCE, data breach, or auth bypass; otherwise HIGH becomes `Major`. MEDIUM becomes `Major`. LOW becomes `Minor`.
- `category` is `security:<class>` (for example `security:command_injection`, `security:data-isolation`, `security:obvious-secrets`).
- `confidence` equals the source score divided by 10. Report a finding only when confidence is at least 0.8.
- `source` is `self`.
- Cloudflare `needs_validation` items do not go in `findings.json`. They go in the summary's "Needs validation" list, each with the exact missing fact.

## Provenance

Each ported block is verbatim between `port-begin` and `port-end` markers. Those markers name the repo, full commit, path, line range, and blob. CCv3 text sits outside the markers. Both LICENSE files are copied in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

| Source | Commit | Blob | What was ported |
| --- | --- | --- | --- |
| `anthropics/claude-code-security-review` `.claude/commands/security-review.md` | `0c6a49f1fa56a1d472575da86a94dbc1edb78eda` | `93651ea8b92194a1f739eaf5115ea493746df300` | Lines 35–181 into the R4 brief |
| same repo, `LICENSE` | `0c6a49f1fa56a1d472575da86a94dbc1edb78eda` | `aadec62f5cf87aae35a0423382bca6f2849abdb5` | Whole file, notices only |
| `cloudflare/security-audit-skill` `skills/security-audit/ATTACK-CLASSES.md` | `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8` | `18a2beb4dbb554fb52b0a0293b8bd9108207f8fa` | Lines 111–130 into R4; lines 1–130 into R5 |
| same repo, `skills/security-audit/DATA-ISOLATION-AND-LIFECYCLE.md` | `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8` | `0cba1fa463b62c9b0caba710a201e29c1eecd0ec` | Lines 1–84 into R4 |
| same repo, `skills/security-audit/AI-AND-LLM.md` | `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8` | `02ba9039eca4cec811fefc77bce0d7349b379aae` | Lines 1–83 into R5 |
| same repo, `LICENSE` | `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8` | `6dbc9ecb3a5b9080e95b962869e8c7ab16cfdc20` | Whole file, notices only |

Deliberately not ported from `.claude/commands/security-review.md` at `0c6a49f1fa56a1d472575da86a94dbc1edb78eda`: lines 1–33 (frontmatter and shell interpolation) and lines 183–191 (a closing section that orchestrates sub-tasks). The GitHub Action API prompt from that repo is not ported.

## Follow-on

When PR6 is carded, its CLI should read these files at the reviewed SHA. It should point here and not copy them.
