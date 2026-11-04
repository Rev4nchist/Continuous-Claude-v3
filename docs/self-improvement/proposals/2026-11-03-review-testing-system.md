# Review and testing system for CCv3 PRs (2026-11-03)

Status: proposal. Not approved. Read-only research; nothing installed or run.
Evidence: `docs/research/2026-11-03-review-testing-sota.md` (the digest). Every external claim there carries a source and a date.
Builds on: `docs/self-improvement/proposals/2026-10-30-review-stack-hybrid-pr-agent.md`, `.claudedocs/2026-11-02-local-review-engine-plan.md` section 6, `.claudedocs/2026-11-03-review-capacity-strategy.md`, `.claudedocs/2026-11-03-trex-pivot-eval.md`.

Verdict: keep CodeRabbit as the reference reviewer. Add three cheap Windows-native gates. Harden the local engine output. Then test two cheap recall levers before any spend on multi-pass review.

## 1. Problem

Measured on the P0 holdout with frozen prompt f53fa6b8 (`.claudedocs/2026-11-03-p0-pr-body.md`). The replay path runs `grok-4.7-high` at band MID (`scripts/eval/review-eval/replay.mjs:127`). The brief calls it xhigh; the replay code says high.

| Gap | Measured | Bar (local plan section 6) | 95% interval |
|---|---|---|---|
| Major recall, line match | 3 of 9 (33%) | 80%+ holdout | 12-65% |
| Major recall, same issue | 1 of 9 (11%) | 80%+ | 2-44% |
| Dev-set Major recall | 0 of 12 strict | info | 0-24% |
| Precision (judged real / posted) | 16 of 23 (70%), range 70-78% | 78%+ | 49-84% |
| Severity: claimed Majors confirmed | 4 of 11 | none set | 15-65% |
| Malformed output | 1 failed round (PR 211 r1: findings JSON closed with `"]`) | 0 | n/a |
| Real Majors in sample | 9 | 20+ | n/a |
| Security-tier escapes; waivers | not measured | 0; 0 | n/a |
| Oracle-less tests | TREX caught 0 of 15 | n/a | 0.92^15 = 0.29, so not proof of 0% |

Context that changes how to read the bar:
- The dataset is 100% CodeRabbit-sourced. CodeRabbit scores 100% on it by construction.
- On an independent gold set (Martian offline, strict), CodeRabbit scores P31.0/R62.6 and no tool exceeds 66.9% recall. So "80% Major recall" means parity with CodeRabbit on our PRs, not an absolute level.
- Gaps outside the LLM: no local gate covers GitHub Actions security, PowerShell or the root lockfile.
- The local Semgrep ratchet needs Docker. The [Docker Windows install docs](https://docs.docker.com/desktop/setup/install/windows-install/) (read 2026-11-03) list only Enterprise, Pro and Education for both backends. Correction (2026-11-03): Docker Desktop still runs with WSL frozen. The TREX P0 bench ran in Docker that day (`.claudedocs/2026-11-03-trex-p0-bench.md`). The frozen WSL blocks `bash` on PATH and tools that need WSL 2 directly (OpenHands sandboxes). Opengrep removes the need to start Docker Desktop for the local check.

## 2. Target architecture

One pipeline, ordered from commit to merge. Every local stage runs native on Windows or on a subscription CLI. Docker-only tools stay in CI.

```
commit ──► S0 commit hook ─────────── gitleaks (existing)
              │
pre-pr ──► S1 deterministic gates ── opengrep(ccv3 rules) · zizmor · PSScriptAnalyzer · osv-scanner
              │                       (only for changed file types; SARIF out)
           S2 test tier ──────────── vitest related/changed · StrykerJS on changed lines (advisory)
              │                       · fast-check properties on guards/parsers
           S3 LLM review ─────────── grok engine: free text out; tolerant parse; path filter
              │                       MID: 1 pass   HIGH/CRITICAL: 3 shuffled passes, vote >= 2
           S4 severity check ─────── 2 models: grok severity + claude -p --json-schema re-rate;
              │                       disagreement or no evidence downgrades the Major
           S4b CodeRabbit CLI ────── via pre-pr.mjs (existing; 2 runs per branch; $25 CLI credit)
              │
draft PR ─► S5 posting ───────────── 1 summary comment per push: engine findings + SARIF counts/locations
              │                       (inline reviewdog threads only if Dave picks them, Decision 3)
              │
CI ──────► S6 CI gates ───────────── semgrep image + gitleaks + trivy + full test suite (existing)
              │
review ──► S7 PR bots ────────────── CodeRabbit per band + 15% sample; Greptile optional
              │                       shadow eval scores engine vs CodeRabbit (P0 harness)
merge ───► S8 READY + Dave gate ──── review-status.mjs; Dave approves CRITICAL
```

| Stage | Tools and where | Cost | Gap it fixes |
|---|---|---|---|
| S0 commit hook | gitleaks, local (existing) | $0, under 1 s | Secrets (no measured gap) |
| S1 deterministic | opengrep exe runs our 3 `ccv3-*.yml` rules locally; zizmor on `.github/workflows/*`; PSScriptAnalyzer on `*.ps1`; osv-scanner on lockfiles. Each runs only when its file type changed. SARIF to `.claude/cache/`. | $0; native exes | Security coverage. Runs our Semgrep rules locally without starting Docker Desktop. It saves no CodeRabbit money, because CodeRabbit bills per file, not per tool. |
| S2 tests | `vitest related` for the fast tier; StrykerJS `--incremental --mutate <changed ranges>` on `.claude/hooks` as an advisory ratchet; fast-check differential properties for guards and lexers | $0; minutes per PR [Speculation] | Oracle-less tests (mutant kill and properties are the oracle) |
| S3 LLM review | Local engine via cursor-agent. MID: 1 pass. HIGH and CRITICAL: 3 passes with shuffled file order. Keep findings seen at least twice. Also keep any Major with cited evidence. Two findings are "the same" when `match.mjs` puts them on the same file within `lineSlack` 3 (`scripts/eval/review-eval/config.json:14`). [Speculation] The same-issue merge may need the S4 call instead. Grok output stays free text: `cursor-agent --help` (2026-11-03) has no JSON-schema flag. Its `--output-format json` is only a reply envelope. So the tolerant parser is the only defence. After it come one retry and a drop of any finding whose path is not in the repo. Option: run the format step on `claude -p --json-schema`, charged to the headless cap. | MID 1 Grok run; HIGH/CRITICAL 3 runs. Median run cost is about $0.96 at list rate, max $1.81 (`.claudedocs/2026-11-03-review-capacity-strategy.md` line 25, n=28). | Malformed output; recall on HIGH/CRITICAL (SWR-Bench). Precision gain from the vote is unmeasured. |
| S4 severity check | A 2-model check on each PR that has at least one Major. Model 1 is grok's original severity. Model 2 is one `claude -p --json-schema` re-rating. A disagreement downgrades the Major. A Major without a concrete failing input or path is also downgraded. It never deletes a finding. | 1 headless call per such PR; cap 30/day (`config.json:12`, `headlessDailyCap`) | Severity inflation (4 of 11) |
| S5 posting | Default: one summary comment per push with engine findings plus SARIF counts and locations. It opens no review threads, so `review-status.mjs` (lines 1459, 1477) does not block READY on it. Option: reviewdog inline threads on added lines, only if Dave picks it (Decision 3). | $0 | Reporting plumbing; reviewdog dedups by fingerprint if used |
| S6 CI | Existing `ccv3-checks.yml` and `gitleaks.yml`; pinned Semgrep image | GitHub Actions minutes | No change |
| S7 PR bots | CodeRabbit per band rules (option A of 10-30 stays). Shadow eval keeps scoring engine vs CodeRabbit. | See "Budget arithmetic" below. The $50/month cap does not cover every PR. | Reference signal for recall |
| S8 merge | `scripts/github/review-status.mjs` READY; Dave gate on CRITICAL | $0 | No change |

**Budget arithmetic.** All PR counts are estimates from read-only `git log` on 2026-11-03.
- CodeRabbit paid reviews: $50 cap / $0.25 per file = 200 files a month. Source: `.claudedocs/2026-11-03-review-capacity-strategy.md` line 26. That line also gives November spend so far as $18.25. So about 127 paid files remain this month.
- Files per PR: over the last 30 merged PRs, the median is 5 changed files and the mean is 9.9 (min 1, max 35). This is an estimate. CodeRabbit path filters may skip some files.
- PRs per month: 151 PR merges on `main` in October 2026.
- So a full month needs about 150 x 10 = 1,500 files. The cap pays for about 200, or about 13%. This is an estimate.
- Not checked: the size of the included allowance before billing starts. The capacity doc says only that billing starts "past the included limit".
- Band split: the band rules and the 15% sample must fit inside the 200 paid files plus the included allowance. The proposal does not yet set the split. Measure the real files per band for one month first.
- CodeRabbit CLI: `pre-pr.mjs` stops at 2 runs per branch (`.claude/rules-ondemand/coderabbit-cli.md:10`). It spends from the $25 CLI credit only (same file, line 56). This is the S4b stage in the diagram.

**Eval budget.** `scripts/eval/review-eval/config.json:10` sets `cursorEvalBudget` to 40. `budget.mjs:2-3` and `:34` refuse a new eval run when the all-time `review-eval` start rows reach 40. The ledger `~/.claude/state/cursor-review-ledger.jsonl` (`cursor-review.mjs:95`) held 33 such rows on 2026-11-03. So 7 eval runs remain. Every Grok test below needs 10 runs or more. So each one needs Dave to raise `cursorEvalBudget` first.

What is deliberately not in the pipeline:
- Scanner SARIF is not put into the LLM prompt. Raw static output gave P2.79 in SWR-Bench Hybrid-Review, and more context lowered detection in SWE-PRBench. This rejects the seed list's "inject into PR-Agent context" wiring.
- No cheap-model triage in front of the reviewer. Entelligence reports it capped recall (vendor blog, unverified).
- No multi-pass on MID. At 20 items a burst, 3x on MID would pass the 300-run weekly cap (capacity strategy section 2).
- No reflexion "find what you missed" pass. CR-Bench shows signal-to-noise falls by more than half.

## 3. Verdict table

Changes to the 10-30 proposal: option A (keep CodeRabbit, tighten) stays ADOPT. C (replace CodeRabbit) stays SKIP. B (PR-Agent) stays WATCH; its plain-diff stdin mode removes the "needs a branch" blocker but adds no SARIF input and no recall evidence. D3 stays ADOPT.

| Tool or method | Layer | Verdict | Why | Source + date |
|---|---|---|---|---|
| zizmor | CI workflow security | ADOPT | Windows exe, SARIF, MIT; covers template injection and unpinned actions; Trivy compromise is the live case | [v1.32.0](https://github.com/zizmorcore/zizmor/releases/tag/v1.32.0), 2026-11-02 |
| PSScriptAnalyzer | PowerShell lint | ADOPT | Only tool for our 60 `.ps1` files; Microsoft, MIT. SARIF unverified. | [1.25.0](https://github.com/PowerShell/PSScriptAnalyzer/releases/tag/1.25.0), 2026-03-20 |
| OSV-Scanner v2 | Lockfile SCA | ADOPT | Windows exe, SARIF; covers root lockfile and `requirements.txt` that Dependabot misses; `scoped-scan.mjs` already wraps it. No reachability for our languages. | [v2.7.0](https://github.com/google/osv-scanner/releases/tag/v2.7.0), 2026-10-12 |
| Opengrep | Local SAST runner | ADOPT (trial-gated) | Native exe runs our own rules without Docker. Adopt only if the 3 rules give the same findings as `semgrep-ccv3-baseline.json`. | [v1.33.1](https://github.com/opengrep/opengrep/releases/tag/v1.33.1), 2026-10-29 |
| reviewdog | SARIF to PR comments | ADOPT (trial-gated) | Works without CI; dedups by fingerprint. Drive-letter fix unreleased; posts as Rev4nchist (Decision 3). | [v0.21.2](https://github.com/reviewdog/reviewdog/releases/tag/v0.21.2), 2026-09-18; [#2944](https://github.com/reviewdog/reviewdog/pull/2944), 2026-11-02 |
| Output hardening (free-text answer, tolerant parse, one retry, path filter, fail on no output) | LLM review | ADOPT | Fixes the PR 211 failure class; deterministic. Grok has no schema flag, so the parser is the only defence. | [Ionix](https://www.ionix.io/blog/we-built-an-ai-pr-reviewer/), 2026-08-13 (unverified); [arXiv 2408.02442](https://arxiv.org/abs/2408.02442), 2024; local `cursor-agent --help`, 2026-11-03 |
| 2-model severity check (grok severity + `claude -p --json-schema` re-rate) | LLM review | ADOPT | Cross-provider second opinion; a disagreement downgrades; fits the headless cap. [Speculation] Apollo gains came only from 2-3 model ensembles on agent trajectories, not PR severity. | [CLI reference](https://code.claude.com/docs/en/cli-reference), 2026-11-03; [Apollo](https://www.apolloresearch.ai/products/evaluating-llm-calibration-for-coding-agent-monitoring/), 2026-07-07 [Speculation] |
| **Recall lever 1:** smaller context (diff of about 2,000 tokens plus a summary) | LLM review | ADOPT for test before multi-pass | All 8 models degrade as context grows; 2,000-token diff-with-summary beat full context. Needs new engine runs. | [arXiv 2603.26130](https://arxiv.org/abs/2603.26130), 2026-03-27 |
| **Recall lever 2:** shorter prompt | LLM review | ADOPT for test before multi-pass | Entelligence reports precision 73% to 94% after a prompt cut. Needs new engine runs and a new prompt freeze. | [Entelligence](https://entelligence.ai/blogs/how-we-made-code-review-3.4x-faster-and-50-cheaper), 2026-08-11 (unverified) |
| **Recall lever 3:** multi-pass vote (3 shuffled passes) | LLM review | ADOPT for HIGH/CRITICAL after levers 1-2 and a holdout test | Best published recall lever. A vote is reported to cut false alarms, but no source isolates the gain. Untested on grok-4.7. | [arXiv 2509.01494](https://arxiv.org/abs/2509.01494), 2026-06; [Cursor](https://cursor.com/blog/building-bugbot), 2026-01-15 |
| `/code-review` in a Claude Code session | LLM reviewer | WATCH (score on holdout) | Second LLM lane from another provider. The docs say "Anyone, on any plan", so no new money on Ultra. It spends the Ultra weekly limit, not Grok runs. Not checked: headless `claude -p` support. | [docs](https://code.claude.com/docs/en/code-review), read 2026-11-03 |
| Ultrareview | LLM reviewer | WATCH | Runs in a cloud sandbox; needs a claude.ai sign-in. Cost and limits not checked. | [docs](https://code.claude.com/docs/en/code-review), read 2026-11-03 |
| Martian benchmark (judge prompt and anchor) | Benchmark | ADOPT as reference | Independent gold set; same-issue judge prompt; MIT | [repo](https://github.com/withmartian/code-review-benchmark), pushed 2026-09-15 |
| StrykerJS | Mutation testing | ADOPT (trial-gated, advisory) | Windows CI, incremental line-range mode; mutant kill is a non-LLM oracle. Vitest 4.1 support unverified. | [v10.1.1](https://github.com/stryker-mutator/stryker-js/releases/tag/v10.1.1), 2026-10-23 |
| fast-check | Property tests (TS) | ADOPT | Fits parsers, regexes and guards per AGENTS.md; differential property against a vetted parser | [v4.10.2](https://github.com/dubzzz/fast-check/releases/tag/v4.10.2), 2026-09-19 |
| Vitest `related` / `--changed` | Test selection | ADOPT for fast tier only | Native; full suite stays the merge gate because hooks run as child processes | [Vitest CLI](https://vitest.dev/guide/cli.html), read 2026-11-03 |
| Hypothesis `/hypothesis` command | Property tests (Python) | ADOPT on demand (unverified) | Subscription-only; 56% raw valid, 86% top-ranked valid (not checked). Not a gate. | [arXiv 2510.09907](https://arxiv.org/abs/2510.09907), 2025-10-10 |
| Gitleaks | Secrets | WATCH (keep) | Works; releases stalled since 2026-03-21 | [v8.30.1](https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1), 2026-03-21 |
| Semgrep CE in CI | SAST | WATCH (keep) | Incumbent in CI; security slice only | [v1.183.0](https://github.com/semgrep/semgrep/releases/tag/v1.183.0), 2026-10-29 |
| Betterleaks | Secrets | WATCH | v2 is RC and drops SARIF; recall claims author-only | [v2_migration.md](https://github.com/betterleaks/betterleaks/blob/main/docs/v2_migration.md), 2026-10-30 |
| Kingfisher | Secrets | WATCH | Swap candidate; vendor benchmark only | [v2.16.0](https://github.com/mongodb/kingfisher/releases/tag/v2.16.0), 2026-10-30 |
| Trivy | SCA, image | WATCH (keep in CI) | Duplicates OSV-Scanner locally; March 2026 compromise (advisory details unverified); pin by SHA | [GHSA-69fq-xp46-6x23](https://github.com/aquasecurity/trivy/security/advisories/GHSA-69fq-xp46-6x23), 2026-03-21 |
| sarif-tools | SARIF diff | WATCH | Useful diff and summary; last release 15 months old | [v3.0.5](https://github.com/microsoft/sarif-tools/releases/tag/v3.0.5), 2025-07-17 |
| PR-Agent | LLM reviewer | WATCH (B stays) | Plain-diff mode; no SARIF input; no recall evidence on our Majors. `qodo-ai/pr-agent` now redirects to `The-PR-Agent/pr-agent` (`gh api`, 2026-11-03). | [repo](https://github.com/The-PR-Agent/pr-agent); [v0.49.0](https://github.com/The-PR-Agent/pr-agent/releases/tag/v0.49.0), 2026-10-25 |
| PR Cockpit | Posting pattern | WATCH (unverified) | Borrow inline-plus-summary posting; unsigned nightly app | [repo](https://github.com/taovc/pr-cockpit), 2026-10-27 |
| PR-AF | LLM reviewer | WATCH (unverified) | Self-reported Martian 0.706; needs Docker; no LICENSE file | [repo](https://github.com/Agent-Field/pr-af), 2026-11-02 |
| danger-js, lefthook, pre-commit | Glue | WATCH | `pre-pr.mjs` already wraps the gates | [danger-js 14.1.0](https://github.com/danger/danger-js/releases/tag/14.1.0), 2026-10-26 |
| Meta JiTTest method | Catching tests | WATCH | 4.0-7.9% catch rate per diff; about 80% of reach-outs not confirmed; pilot after option F | [arXiv 2601.22832](https://arxiv.org/html/2601.22832), 2026-01-30 |
| Finding reproduction (Otter style) | Verification | WATCH | Only execution path that touches severity; transfer from issues unproven | [arXiv 2508.06365](https://arxiv.org/abs/2508.06365), 2026-01-22 |
| Refute-or-Promote kill gate | Verification | WATCH | Design idea for S4; single author, C/C++ | [arXiv 2604.19049](https://arxiv.org/abs/2604.19049), 2026-04-21 |
| ReviewBench, SWE-PRBench, CR-Bench | Benchmark | WATCH | Metric ideas (augmented precision, P0-P2 rubric); no absolute scores or weak models. ReviewBench figures unverified. | [ReviewBench](https://github.blog/ai-and-ml/github-copilot/reviewbench-an-open-benchmark-for-ai-code-review/), 2026-10-05; [SWE-PRBench](https://arxiv.org/abs/2603.26130), 2026-03-27; [CR-Bench](https://arxiv.org/abs/2603.11078), 2026-03-10 |
| cosmic-ray | Python mutation | WATCH | Only Windows-native Python option; untested | [repo](https://github.com/sixty-north/cosmic-ray), v8.7.0 2026-08-09 |
| SkillSpector | Skill scanner | WATCH | `--no-llm` and `claude_cli` modes fit; CI is Ubuntu only, Windows unverified | [ci.yml](https://github.com/NVIDIA/SkillSpector/blob/main/.github/workflows/ci.yml), 2026-11-02 |
| Cisco skill-scanner, aisecscan, promptfoo | Agent security | WATCH | Rules-only recall 7.7%; aisecscan 1 star; promptfoo scan is hosted | [measured-results.md](https://github.com/cisco-ai-defense/skill-scanner/blob/main/docs/reference/measured-results.md), 2026-11-03 |
| CodeQL CLI | SAST | SKIP | Licence bars CI on private repos without paid Code Security | [LICENSE.md](https://github.com/github/codeql-cli-binaries/blob/main/LICENSE.md), 2026-11-03 |
| GitHub code scanning SARIF upload | Reporting | SKIP | Needs Code Security (Team or Enterprise) | [docs](https://docs.github.com/en/get-started/learning-about-github/about-github-advanced-security), 2026-11-03 |
| Managed Claude Code Review | LLM reviewer | SKIP (paid; Dave decision) | Token-billed, no flat price; Team or Enterprise only | [docs](https://code.claude.com/docs/en/code-review), read 2026-11-03; [costs](https://code.claude.com/docs/en/code-review-costs), read 2026-11-03 |
| Bearer CLI | SAST | SKIP (unverified) | Elastic License 2.0; no Windows binary | [LICENSE.txt](https://github.com/bearer/bearer/blob/main/LICENSE.txt), 2026-11-03 |
| Grype + Syft | SCA | SKIP | Third overlapping SCA tool | [v0.121.1](https://github.com/anchore/grype/releases/tag/v0.121.1), 2026-11-02 |
| Checkov, KICS | IaC | SKIP | Nothing to scan (2 Dockerfiles, no IaC) | [checkov 3.4.3](https://github.com/bridgecrewio/checkov/releases/tag/3.4.3), 2026-11-02 |
| TruffleHog | Secrets | SKIP | Verification sends secrets off-machine; AGPL; little gain over gitleaks | [v3.99.8](https://github.com/trufflesecurity/trufflehog/releases/tag/v3.99.8), 2026-11-02 |
| Renovate | Updates | SKIP | Dependabot already configured | [44.210.0](https://github.com/renovatebot/renovate/releases/tag/44.210.0), published 2026-11-03 (`gh api`) |
| mutmut (on this host) | Python mutation | SKIP until WSL returns | Needs fork and WSL; the `opc/pyproject.toml` block cannot run | [README](https://github.com/boxed/mutmut), read 2026-11-03 |
| Coverage as a gate | Method | SKIP (unverified) | One subject had 100% coverage and a 4% mutation score | [MutGen arXiv 2506.02954](https://arxiv.org/abs/2506.02954), v6 2026-02 |
| Qodo Cover | Test generation | SKIP (unverified) | End of life since 2025-06-15 | [commit](https://github.com/qodo-ai/qodo-cover/commit/HEAD), 2025-06-24 |
| CoverUp | Test generation | SKIP | Needs API keys | [arXiv 2403.16218](https://arxiv.org/abs/2403.16218), 2024-03 |
| LLMorpheus | Mutation generation | SKIP | Repo archived | [repo](https://github.com/githubnext/llmorpheus), 2025-02-03 |
| Snyk Agent Scan | Agent security | SKIP | Needs `SNYK_TOKEN`; uploads skill content and MCP configs | [repo](https://github.com/snyk/agent-scan), 2026-11-03 |
| Cisco mcp-scanner | Agent security | SKIP | Under 50% of sampled MCP scanner alerts were true positives | [arXiv 2607.11086](https://arxiv.org/abs/2607.11086), 2026-07-13 |
| garak | Agent security | SKIP | Tests models, not harness code | [v0.17.1](https://github.com/NVIDIA/garak), 2026-11-02 |
| SARIF into the LLM prompt | Method | SKIP | Hybrid-Review P2.79; more context lowered detection | [arXiv 2509.01494](https://arxiv.org/abs/2509.01494), 2026-06; [arXiv 2603.26130](https://arxiv.org/abs/2603.26130), 2026-03-27 |
| Reflexion "find missed bugs" pass | Method | SKIP | SNR 5.11 to 1.95 on GPT-5.2 | [arXiv 2603.11078](https://arxiv.org/abs/2603.11078), 2026-03-10 |

## 4. Recommended first build step

**One PR: engine output hardening plus an archive rescore. Zero Grok runs, zero headless calls.**

Facts that make this possible:
- The P0 run artifacts are archived in `.claudedocs/e2e-pr270/review-eval/`. It holds `runs.jsonl` (32 rows; 10 holdout and 9 dev rounds) and 20 labels. It also holds each run's `.raw.json` and `.findings.json`.
- PR 211 round 1 has three attempts. Two timed out. The third (`...-111502.raw.json`, 3127 bytes) failed with "no findings block and no recognisable headings". Its raw answer holds a fenced JSON block with 2 findings (1 Major on `scripts/settings/remove-maestro-registrations.mjs:14`, 1 Minor on line 2). The defect: the last finding object is not closed, so the block ends `..."]}` instead of `..."}]}`.
- Findings carry `file`, `line`, `lineEnd`, `severity`, `title`, `body`. There is no "failing input" field yet.

Scope (about 150-250 lines with tests [Speculation]):
1. A pure post-processor module in `scripts/github/` used by `cursor-review.mjs`. Grok output stays free text, because `cursor-agent --help` (2026-11-03) has no JSON-schema flag. The parser is therefore the only defence.
   - tolerant findings parse (repairs a bad closing bracket and similar), one retry slot for a format call later;
   - option: the later format call can run on `claude -p --json-schema` and charge the headless cap;
   - drop any finding whose `file` is not in the reviewed tree, and log the drop;
   - a run with no parseable output stays `failed`, never an empty pass.
2. A `rescore --archive <dir>` command in `scripts/eval/review-eval/cli.mjs`. It re-applies the post-processor to archived `.raw.json` files. It writes a new scorecard beside the old one. It calls no model. The prompt hash stays f53fa6b8, so the freeze is not broken.
3. Tests: one per failure mode (the PR 211 bracket case from its real raw output, a hallucinated path, a truly empty answer).

Expected effect:
- PR 211 r1 changes from a failed round to a scored round with 2 findings. Whether its Major matches a dataset Major is unknown until the rescore runs.
- Precision moves only if some posted findings name paths outside the tree.
- Recall does not change except through PR 211. Say so in the PR. This step does not fix recall.

How to measure:
- Before: `node scripts/eval/review-eval/cli.mjs score --dir .claudedocs/e2e-pr270/review-eval`.
- After: the same command on the rescored copy. Compare holdout line recall, same-issue recall, precision and failed-round count.
- Save both outputs to `.claude/cache/e2e/<YYYY-MM-DD>-review-rescore.txt`.

Step 2 (needs Dave's yes, headless only): run the 2-model S4 check on the 11 archived Majors. That is about 11 or fewer `claude -p` calls, inside the 30/day cap. Target: severity precision above 4 of 11. Risk: the P0 labels are Claude labels. A Claude re-rater may agree with them for the wrong reason. Report agreement on the 4 confirmed and 7 rejected Majors separately.

In the same window, score `/code-review` on the 10 holdout rounds next to grok. It runs in a Claude Code session on the Ultra plan. It spends the Ultra weekly limit, not Grok runs. Not checked: whether it runs headless.

**Recall levers, in test order.** The first PR does not fix recall. The bar is Major recall 80%+. These levers come next, before any multi-pass spend.
- `rescore --archive` calls no model. So it cannot test a context or a prompt change. Each change below needs new engine runs on the archived holdout rounds through `replay.mjs`.
- Lever 1, smaller context: a diff of about 2,000 tokens plus a summary ([arXiv 2603.26130](https://arxiv.org/abs/2603.26130)). Cost: 10 holdout runs, plus 9 for the dev set.
- Lever 2, shorter prompt ([Entelligence](https://entelligence.ai/blogs/how-we-made-code-review-3.4x-faster-and-50-cheaper), unverified). Cost: 10 holdout runs, plus 9 for the dev set. It changes the prompt hash, so it needs a new `freeze` entry in `config.json`. [Speculation] Lever 1 may also change the hash.
- Lever 3, multi-pass vote (Step 3 below). Run it only on the winner of levers 1 and 2.
- Eval budget: 7 of 40 runs remain (see "Eval budget" in section 2). Levers 1 and 2 on the holdout need 20 runs. Neither lever fits until Dave raises `cursorEvalBudget`.
- Money: at the $0.96 median, 10 runs cost about $9.60 if the Cursor pool is spent and list rates apply.

Step 3 (needs Dave's yes, Grok spend): 3 shuffled passes on the 10 holdout rounds. That is 20 extra Grok runs. Add the 9 dev rounds for 18 more (38 total). Only 7 eval runs remain of 40, so Step 3 needs a raised `cursorEvalBudget`. Score same-issue recall and precision against the 1-pass baseline.

Parallel, $0, no model: install trial of zizmor, PSScriptAnalyzer, osv-scanner and opengrep after Dave approves the installs. Record each tool's finding count on the current tree before any gate.

## 5. Risks

| Risk | Effect | Mitigation |
|---|---|---|
| Small sample (9 holdout Majors) | Cannot tell 33% from 60% recall | Report Wilson intervals; keep the 20+ Majors rule; grow the set through shadow |
| Path filter drops a real finding (renamed or new file) | Recall falls | Check against the reviewed tree at the head SHA, not the base; log every drop |
| Severity downgrade hides a real Major | A real Major is posted as Minor | S4 downgrades only, never deletes; HIGH/CRITICAL still get CodeRabbit |
| Claude labels and Claude re-rater are correlated | S4 looks better than it is | Measure on rejected Majors; Dave spot-checks disputes |
| Multi-pass cost | 3x Grok on HIGH/CRITICAL; pool may bind before the 300 cap | Only HIGH/CRITICAL; read the Cursor dashboard first (capacity decision 1) |
| Eval budget nearly spent | 33 of 40 eval runs used; recall tests cannot start | Dave raises `cursorEvalBudget` in `config.json:10` with a set number; test levers 1-2 before multi-pass |
| CodeRabbit file cap | 200 paid files a month against an estimated 1,500 changed files | Measure files per band for one month; set the band split and 15% sample to fit |
| Scanner noise on PRs | Unresolved threads block READY | Local SARIF first; post only after the noise count is known; in-diff lines only |
| reviewdog on Windows | Drive-letter URIs break mapping (fix unreleased) | Run scanners from repo root with relative paths; build from master only if needed |
| Supply chain of new exes | A compromised release (Trivy case) | Pin versions; verify checksums or signatures; no `@latest` |
| StrykerJS and Vitest 4.1 mismatch | Gate cannot run | Advisory only; a 10-minute scratch trial first |
| CodeRabbit-only ground truth | Engine can never beat its reference | Use Martian same-issue judge as a second signal; shadow scores on the union |

## 6. Open decisions for Dave

| # | Decision | Recommendation |
|---|---|---|
| 1 | Approve the first PR (output hardening plus archive rescore) | Yes. It costs $0 and fixes a measured failure. |
| 2 | Approve installs: zizmor, PSScriptAnalyzer, osv-scanner, opengrep (pinned, native exes) | Yes. Trial first, then add to pre-pr as advisory for one week before blocking. |
| 3 | READY trust for scanner and engine comments posted as Rev4nchist | Post local scanner and engine findings as one summary comment that does not open review threads. Keep READY on the two app identities. |
| 4 | Is the 80% bar parity with CodeRabbit or absolute? | Parity: use the "shadow recall at least CodeRabbit's on the union" row as the main target. Keep 80% on the CodeRabbit-sourced holdout as written. |
| 5 | Step 2: S4 severity check on archived Majors (about 11 headless calls) | Yes, after the first PR lands. |
| 6 | Step 3: 3-pass holdout test (20 Grok runs; 38 with dev) | Yes for holdout only (20 runs), after the Cursor dashboard read and after levers 1-2. It needs decision 10 first. |
| 7 | StrykerJS trial on one hook | Yes, as a scratch trial; advisory ratchet only if it runs on Vitest 4.1. |
| 8 | Dead `[tool.mutmut]` block in `opc/pyproject.toml` | Leave it until WSL returns; do not replace with cosmic-ray yet. |
| 9 | Paid options: GitHub Code Security (CodeQL), managed Claude Code Review | No. Neither has evidence of closing our logic-Major gap. |
| 10 | Raise `cursorEvalBudget` (40, with 33 used) | Yes, to 80. That covers levers 1-2 (20 runs) and Step 3 (20 runs) on the holdout. |
| 11 | Score `/code-review` on the 10 holdout rounds | Yes. It costs no new money on Ultra; it spends the weekly limit. |
