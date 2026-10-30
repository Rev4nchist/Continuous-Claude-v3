# Review stack: the "hybrid setup" with self-hosted PR-Agent (2026-10-30)

Verdict: **A (keep CodeRabbit and tighten) is ADOPT.** **B (add self-hosted PR-Agent between pushes) is WATCH.** A local replay pilot decides B.
**C (replace CodeRabbit PR reviews) is SKIP.** **D1 (claude-code-action) is WATCH; the pilot tests it. D2 (Greptile on risk PRs) is WATCH. D3 (fewer, larger PRs) is ADOPT.**
CCv3 already has 2 of the 3 hybrid parts. B costs about $20 to $80 a month and saves $0 to $50 of paid CodeRabbit rounds.
No evidence yet shows that PR-Agent catches CCv3's real Major defect classes.

Status: Dave approved D-1 to D-5 on 2026-10-30. Option A config and the D3 policy line ship in PR #225. The merge gate is a separate infra PR. Dave put D-2 (Phase 0) on hold the same day: B costs more than it saves, and the merge gate comes first. Revisit if paid CodeRabbit spend or missed Majors grow.

Source: `what are people using inside of Code Rabbit for C....md` checked by research, evaluation and critique agents on 2026-10-30.

## 1. What CCv3 already has

- **Auto PR review is off.** `.coderabbit.yaml:9` `enabled: false`, `:17` `auto_incremental_review: false`, `:20` `drafts: false`. Labels opt a PR in.
- **Local review before push.** `pre-pr.mjs` runs `cr review` at most 2 times per branch (`pre-pr.mjs:384`). `cr-fix.mjs` reviews each fix range.
- **Paid rounds are capped.** `cr-paid.mjs:38`: $5 per round, $15 per day, 2 paid rounds per PR. The account cap is $50 a month.
- **CI scanners run already.** Semgrep, Trivy and gitleaks run in `ccv3-checks.yml` and `gitleaks.yml`.
- **READY trusts app identities only.** `review-status.mjs:86,92` name `greptile-apps` and `coderabbitai[bot]`. Any unresolved thread blocks READY (`:1122`, `:1139`).
- **Every PR opens as a draft.** `checkpoint.enforce` denies a non-draft `gh pr create` (`review-router.config.json:16`). An intermediate reviewer must therefore run on drafts.
- **Missing:** an automatic reviewer on every push, and any non-CodeRabbit signal that READY accepts.

## 2. Claims checked

| Claim in the source doc | Status | Source |
|---|---|---|
| Turn off auto and incremental PR review | VERIFIED; CCv3 does it | https://docs.coderabbit.ai/configuration/auto-review |
| CLI and IDE have hourly pools apart from PR reviews | PARTLY VERIFIED; no page says "separate pool" | https://docs.coderabbit.ai/management/plans |
| Fair Usage throttles to 1 review/hour | VERIFIED (Team, 70+ in 7 days) | https://docs.coderabbit.ai/management/rate-limits |
| Over-limit reviews bill at $0.25/file | VERIFIED ($1 per 4 files) | https://docs.coderabbit.ai/management/usage-based-addon |
| 59+ bundled analyzers at no token cost | UNVERIFIED; docs say "50+" and say nothing on billing | https://docs.coderabbit.ai/tools/ |
| PR-Agent is free to self-host with your own key | VERIFIED; MIT, community-run | https://github.com/The-PR-Agent/pr-agent |
| Qodo has a free self-hosted BYOK plan | CONTRADICTED; BYOK is Enterprise only | https://www.qodo.ai/pricing/ |
| "Unlimited passes on every intermediate commit" | PARTLY VERIFIED; `synchronize` is off by default | https://docs.pr-agent.ai |
| "Pennies per PR" | PLAUSIBLE; about $0.03 to $0.08 per `/review` pass, times pushes | https://platform.claude.com/docs/en/about-claude/pricing |
| Greptile is $30/seat with $1 overage | OUTDATED; no seat fee, $1/3/$10 per review tier | https://www.greptile.com/pricing |
| Cubic is #1 on the Martian benchmark | VENDOR CLAIM; top 3 tools within about 1 F1 point | https://www.cubic.dev/best-ai-code-review-tools |
| Cursor Bugbot is included in Cursor | CONTRADICTED; usage-based, $1.00 to $1.50 per review | https://cursor.com/bugbot |

## 3. Options

Volume: 76 human PRs in 14 days, about 163 a month, mean 5 commits per PR (`gh api`, 2026-10-30).

| Option | Cost per month | Quality | Risk | Effort | Verdict |
|---|---|---|---|---|---|
| **A. Keep and tighten.** Add `docs/**`, `thoughts/**`, `.claude/skills/_vendor/**` to `path_filters`. Disable CodeRabbit's `trivy` (no key in `.coderabbit.yaml`; CI runs it). Run `cr-fix` on every risk-list fix. Gate merge on "every round read". | $0 extra; ceiling about $98 to $110 | Unchanged reviewer. Targets the leak: #178, #180, #191 and #193 merged 1 to 38 minutes after unread rounds. | Low for config. The merge gate changes `review-status.mjs` or `land-pr.ps1`, both on `checkpoint.critical`. | Config: hours. Gate: an infra-class PR. | ADOPT |
| **B. PR-Agent `/review` only, Sonnet, drafts included, advisory.** | $20 to $80 (650 to 1,000 passes at $0.03 to $0.08) [Speculation] plus Actions | Unknown. Diff only. 3 findings per pass. Same model family as the pre-PR Claude reviews. | No dollar cap in the tool. Key exposure. Comment noise. +9 to 21% Actions runs. | About 1 day plus the pilot | WATCH |
| **C. Replace CodeRabbit with PR-Agent or claude-code-action.** | Net saving about $0 to $90 | Loses CodeRabbit's knowledge base and bundled tools (gitleaks, actionlint, zizmor, shellcheck) | `github-actions[bot]` is a weak trust anchor; any workflow posts as it. | Days, plus a READY redesign | SKIP |
| **D1. claude-code-action on risk-list PRs, each push.** | About $25 to $150 [Speculation] | Agentic; reads whole files. May suit the SQL, regex and gate classes better [Speculation]. | Same key exposure as B. Skips drafts by default; CCv3 PRs open as drafts. | About 1 day | WATCH |
| **D2. Greptile on risk-list PRs.** | $0 to $180 | Different vendor with a code graph. READY already counts its check run. | Billing held; Apex root cause open | Config only | WATCH |
| **D3. Fewer, larger PRs.** | $0; saves rounds | 0 to 10 file PRs average 2.2 rounds; 26 to 60 file PRs average 1.75 | Larger diffs per review | Policy line | ADOPT |

B facts that shape any build:

- **B saves CodeRabbit money only up to the cap.** Over-limit reviews become paid usage. Each prevented later round saves about $1.75 (median 7 files). B saves $0 to $50 a month plus throttle wait.
- **25% of PRs exceed 2,000 changed lines.** They hit the 32k token clip, and the 3-finding cap spreads across up to 74 files.
- **Config:** override `model` and `fallback_models` (both default to GPT). Set `auto_describe=false`, both label flags false, `inline_key_issues=false`. Never set `PR_AGENT_CONFIG_BRANCH` from PR input.
- **Trigger:** `pull_request_target`, no checkout, as `review-router.yml` does. Under `pull_request`, a session's PR could edit the workflow and read the key.
- **Pinning:** pin the wrapper SHA and the image `docker://pragent/pr-agent@sha256:<digest>` apart. Bump on an advisory or a model change only.
- **Concurrency:** one group per PR with `cancel-in-progress: true`.

## 4. Recommended next step: Phase 0 local replay

A local replay with no GitHub writes. It needs Dave's yes before any key, spend or Docker pull.

**Setup**

- A dedicated Console workspace with a $50 monthly spend limit. The Default Workspace cannot take a limit (https://platform.claude.com/docs/en/manage-claude/workspaces).
- PR-Agent's local git provider (`pr_agent/git_providers/local_git_provider.py`). UNVERIFIED: whether it accepts a commit SHA as target, or needs a local branch.

**Cases**

- **Positives:** the 5 fix ranges behind the 6 fix-introduced Majors: #206 R1 to R2, #200 R1 to R2, #200 R2 to R3, #191 R1 to R2, #191 R3 to R4 (`2d8db742..6785b89f`). Take the other SHAs from review `commit_id`s.
- **Missed-earlier Majors:** #197 (3), #193, #191 R5, #178 (study §2).
- **Replay the whole PR diff at the post-fix head.** That is production; a 9-line fix range is not.
- **Controls:** 10 PRs whose later rounds found nothing real.

**Arms:** PR-Agent Sonnet (3 findings), PR-Agent Sonnet (8 findings), PR-Agent Opus 5.5, headless `claude -p` review (D1 stand-in), and `cr review --base-commit` (incumbent).

**Judging**

- Run each case 3 times per arm.
- A catch is the same defect at the same file within ±10 lines.
- Shuffle arm labels. Use Dave or a non-Claude judge; a Claude judge shares a family with arms 1 to 4.
- Judge each control finding as real or not real. Score novel true finds apart.

**Decision rules**

- **B passes** when an arm finds at least 2 real Majors that arm 5 misses, at no more noise, at $0.10 or less per pass.
- **Kill:** every arm 1 to 4 catches 1 of 6 fix-introduced Majors or fewer. Set B and C to SKIP.
- Otherwise B stays WATCH.

**Cost ceiling:** about $35 of API spend, hard stop $50. The 22 `cr` arm-5 runs draw on CLI allowance and maybe the $25 credit. Spread them over several hours.

**Phase 1, only after a pass and Dave's yes:** 2 weeks shadow mode on live PRs with a $40 limit. Adopt if later rounds on risk PRs drop at least 20%, or B finds 1 real Major CodeRabbit missed.

## 5. Decisions for Dave

| # | Decision | Recommendation |
|---|---|---|
| D-1 | Approve Option A config now; gate change as a separate infra PR | **Yes** |
| D-2 | Approve Phase 0: new workspace, key, $50 limit, Docker pull, 22 `cr` runs | **Yes**, about $35 |
| D-3 | Check the Greptile plan (Starter, 50 free credits?) before D2 | **Yes**; `review:deep` bills Plus, 3 credits (`pr-review-loop.md:564`) |
| D-4 | Policy: "fewer, larger PRs" | **Yes**; matches memory note "Package PRs, spare CodeRabbit" |
| D-5 | Can a non-app reviewer ever count toward READY? | **No**, not until a trust-anchor redesign |

## 6. Critique dispositions

- Applied: 1 ($0 to $50 savings), 2 (judging protocol), 3 (incumbent delta), 4 (3 runs each), 5 (whole-PR replay), 6 (#193 dropped), 7 (arm 5 budget), 8 (D2 cost), 9 (A mechanism), 10 (D3), 11 to 14, 16. Item 15 is noted as a risk, not estimated.
- Rejected, 4 (widen to 18 defects): Minor recall does not decide a Major gate.
- Rejected, 10 (Haiku arm): Dave's rule bans Haiku. Copilot review stays unchecked.

## 7. Sources

- CodeRabbit: https://docs.coderabbit.ai/management/plans, https://docs.coderabbit.ai/management/rate-limits, https://docs.coderabbit.ai/management/usage-based-addon, https://docs.coderabbit.ai/configuration/auto-review, https://docs.coderabbit.ai/tools/
- PR-Agent: https://github.com/The-PR-Agent/pr-agent, https://docs.pr-agent.ai, `pr_agent/settings/configuration.toml` on `main`
- Qodo: https://www.qodo.ai/pricing/
- Anthropic: https://platform.claude.com/docs/en/about-claude/pricing, https://platform.claude.com/docs/en/manage-claude/workspaces, https://code.claude.com/docs/en/github-actions
- Others: https://www.greptile.com/pricing, https://www.cubic.dev/best-ai-code-review-tools, https://cursor.com/bugbot, https://github.com/withmartian/code-review-benchmark
- Repo: line numbers are from worktree `prd-fu` at `86a08606`. The study is `.claudedocs/2026-10-30-coderabbit-rereview-study.md` §1 to §2. PR counts come from `gh api` on 2026-10-30.
