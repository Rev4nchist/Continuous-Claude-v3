# Code review and testing for CCv3: state of the art (2026-11-03)

Status: cited research digest. Read-only work. Nothing was installed, run or scanned.
Inputs: 5 research sweeps (gates, orchestration, benchmarks, testing, LLM security and practice) and 2 skeptic passes.
Repo facts come from files read on 2026-11-03. GitHub facts come from `gh api` on 2026-11-03.
Companion proposal: `docs/self-improvement/proposals/2026-11-03-review-testing-system.md`.

Prior work cited, not repeated:
- Seed list: `.claudedocs/2026-11-03-dave-review-suite-seed-research.md`.
- TREX memo sections 3 and 6: `.claudedocs/2026-11-03-trex-pivot-eval.md` (OpenHands, mini-swe-agent, SWE-agent, E2B, Daytona, container-use, PR-Agent v0.49.0, kodus-ai, Gito, shippie, claude-code-action, claude-code-security-review, cloudflare/security-audit-skill).
- Earlier proposal: `docs/self-improvement/proposals/2026-10-30-review-stack-hybrid-pr-agent.md` (A ADOPT, B WATCH, C SKIP, D1 and D2 WATCH, D3 ADOPT).
- Capacity: `.claudedocs/2026-11-03-review-capacity-strategy.md`. Eval design: `.claudedocs/2026-11-02-local-review-engine-plan.md` section 6.

## 1. Summary

- **No public tool reaches 80% recall on an independent gold set.** The Martian offline benchmark uses a strict profile and an Opus 4.5 judge. Its best recall is 66.9% (Copilot). CodeRabbit scores P31.0/R62.6 ([dashboard JSON](https://github.com/withmartian/code-review-benchmark/blob/main/offline/analysis/benchmark_dashboard.json), repo pushed 2026-09-15). Our 80% bar is therefore a parity bar against CodeRabbit on our own PRs. It is not an absolute standard.
- **Recall rises with independent passes plus a merge step.** SWR-Bench Self-Agg n=5 gave F1 +23% ([arXiv 2509.01494](https://arxiv.org/abs/2509.01494), FSE 2026, v2 2026-06). SWR-Bench reports no precision gain and names precision as the open bottleneck.
- **Votes and verifiers are reported to cut false alarms, but no source isolates the gain.** Cursor reports 8 shuffled passes, a majority vote and a validator ([Cursor blog](https://cursor.com/blog/building-bugbot), 2026-01-15). Cursor published no ablation. OpenAI's verifier claim is qualitative. No source shows a gain measured on Major-severity recall.
- **Raw scanner output in the LLM prompt hurts.** SWR-Bench Hybrid-Review fell to P2.79 and F1 4.87. The plain prompt gave F1 18.73 ([arXiv 2509.01494](https://arxiv.org/abs/2509.01494), 2026-06). Post scanner findings beside the review, not inside it.
- **A smaller context helps.** In SWE-PRBench, all 8 models degrade as context grows. A structured 2,000-token diff-with-summary prompt beat a 2,500-token full-context prompt ([arXiv 2603.26130](https://arxiv.org/abs/2603.26130), v1 2026-03-27, abstract read 2026-11-03).
- **Deterministic gates cover a security slice only.** They do not touch logic-Major recall. The cheap Windows-native gaps are GitHub Actions security (zizmor), PowerShell (PSScriptAnalyzer) and lockfile advisories (OSV-Scanner). CodeQL and GitHub code scanning need a paid GitHub plan for our private repo.
- **Tests need an oracle that is not the model's belief.** There are four usable oracles:
  - the parent revision (Meta JiTTest);
  - mutant kill (Meta ACH, StrykerJS);
  - documented properties (agentic property-based testing);
  - finding text with fail-to-pass checks (Otter).
- **TREX 0/15 does not prove the idea dead.** It is consistent with an 8% true yield (0.92^15 = 0.29). It also does not justify a gate.

## 2. Layer-by-layer findings

### 2.1 Deterministic gates (SAST, SCA, secrets, CI config, PowerShell)

Repo context (git ls-files, 2026-11-03): about 500 mjs, 473 ts, 468 py, 60 ps1, 61 sh and 41 yml files. It has 4 workflows and 2 Dockerfiles. It has no Terraform, Bicep or Kubernetes files.

**SAST**
- The `semgrep-ccv3` ratchet runs the pinned Semgrep image through Docker only (`scripts/ratchets/semgrep-ccv3.mjs` lines 26 and 80-82, read 2026-11-03). The [Docker Windows install docs](https://docs.docker.com/desktop/setup/install/windows-install/) (read 2026-11-03 by the critic) list only Enterprise, Pro and Education for the WSL 2 and Hyper-V backends. They say "Windows Home or Education editions only allow you to run Linux containers." [Speculation] On Windows 11 Home, Docker Desktop therefore needs WSL 2. The local ratchet is likely blocked while WSL is frozen.
- Opengrep is an LGPL-2.1 fork of Semgrep. v1.33.1 ships `opengrep_windows_x86.exe` with .sig and .cert files and a PowerShell `install.ps1` ([release](https://github.com/opengrep/opengrep/releases/tag/v1.33.1), 2026-10-29). It runs Semgrep-format rules and emits SARIF. It has no ruleset of its own; `opengrep/opengrep-rules` is archived ([repo](https://github.com/opengrep/opengrep), 2026-11-03). Compatibility with our wrapper flags and JSON schema is unverified.
- Semgrep rules are under the Semgrep Rules License v1.0. It allows internal business use only and no redistribution ([licence](https://semgrep.dev/legal/rules-license/), Dec 2024, unverified). Our own `ccv3-*.yml` rules are not affected.
- A Semgrep-funded Doyensec study found that Semgrep CE caught 44% of Juice Shop (Node) issues. The Pro engine caught 75% ([Semgrep blog](https://semgrep.dev/blog/2025/security-research-comparing-semgrep-community-edition-and-semgrep-code-for-static-analysis), 2025, vendor-funded, unverified). Semgrep docs give a 63% true-positive rate for p/default on JS before AI triage ([docs](https://docs.semgrep.dev/languages/javascript), table dated 2025-02-25).
- CodeQL CLI terms allow automated or CI analysis only on an OSI-licensed open-source codebase on GitHub.com ([LICENSE.md](https://github.com/github/codeql-cli-binaries/blob/main/LICENSE.md), read 2026-11-03). Our fork `Rev4nchist/Continuous-Claude-v3` is private (`gh api`, 2026-11-03). GitHub Code Security is sold only on Team or Enterprise plans ([docs](https://docs.github.com/en/get-started/learning-about-github/about-github-advanced-security), 2026-11-03).
- Bearer CLI is Elastic License 2.0, not OSI ([LICENSE.txt](https://github.com/bearer/bearer/blob/main/LICENSE.txt), read 2026-11-03, unverified). v2.1.3 has no Windows asset (release 2026-10-28, unverified). The seed list licence claim was wrong.
- An LLM triage pass over SAST alerts cut the false-positive rate on the OWASP Benchmark from over 92% to 6.3%. It found up to 93.3% of false positives in real CodeQL Java alerts. It also covers a post-cutoff C/C++ OSS-Fuzz set. Aggressive filtering sometimes dropped true findings ([arXiv 2601.22952](https://arxiv.org/abs/2601.22952), v1 2026-01-30, v3 2026-07-23, ISSTA 2026).

**SCA**
- OSV-Scanner v2.7.0 has a Windows exe and SARIF output ([release](https://github.com/google/osv-scanner/releases/tag/v2.7.0), 2026-10-12). Call analysis covers Go and Rust only ([scan-source.md](https://github.com/google/osv-scanner/blob/main/docs/scan-source.md), read 2026-11-03). For Node, TypeScript and Python it is plain lockfile matching.
- `.github/dependabot.yml` covers npm in 3 folders and uv in `/opc`. It does not cover the root `package-lock.json` or `opc/scripts/pageindex/requirements.txt` (read 2026-11-03). `.claude/scripts/security/scoped-scan.mjs` lines 125-126 already wrap osv-scanner and skip it when absent.
- Trivy v0.69.4 was malicious in March 2026. So were trivy-action tags 0.0.1 to 0.34.2 ([GHSA-69fq-xp46-6x23](https://github.com/aquasecurity/trivy/security/advisories/GHSA-69fq-xp46-6x23), 2026-03-21, CVE-2026-33634; advisory details unverified). v0.76.1 ships sigstore files ([release](https://github.com/aquasecurity/trivy/releases/tag/v0.76.1), 2026-10-21). Any scanner we add must be pinned by SHA or digest.
- Grype v0.121.1 ([release](https://github.com/anchore/grype/releases/tag/v0.121.1), 2026-11-02) overlaps OSV-Scanner and Trivy.
- Checkov 3.4.3 ([release](https://github.com/bridgecrewio/checkov/releases/tag/3.4.3), 2026-11-02) and KICS v2.2.0 ([release](https://github.com/Checkmarx/kics/releases/tag/v2.2.0), 2026-09-17) have almost nothing to scan here.

**Secrets**
- Gitleaks v8.30.1 is the last release ([release](https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1), 2026-03-21). Commits since at least 2026-06-24 are Dependabot bumps ([commits](https://github.com/gitleaks/gitleaks/commits/master), read 2026-11-03).
- Betterleaks (MIT) is the successor project. The repo was created 2026-02-03. The launch article is dated 2026-03-15 ([BleepingComputer](https://bleepingcomputer.com/news/security/betterleaks-a-new-open-source-secrets-scanner-to-replace-gitleaks), 2026-03-15). v2 is release-candidate only (rc.6, 2026-10-30) and removes the SARIF reporter ([v2_migration.md](https://github.com/betterleaks/betterleaks/blob/main/docs/v2_migration.md), read 2026-11-03). Stable v1.9.0 still has SARIF (2026-09-29). Recall claims of 98.6% on CredData are author-reported.
- Kingfisher v2.16.0 is Apache-2.0 with a Windows zip ([release](https://github.com/mongodb/kingfisher/releases/tag/v2.16.0), 2026-10-30). Its speed and network-request benchmark is vendor-authored ([COMPARISON.md](https://github.com/mongodb/kingfisher/blob/main/docs/COMPARISON.md), read 2026-11-03).
- TruffleHog v3.99.8 is AGPL-3.0 and verifies candidates against live provider APIs ([release](https://github.com/trufflesecurity/trufflehog/releases/tag/v3.99.8), 2026-11-02). Verification sends candidate secrets off the machine.

**CI config and PowerShell**
- zizmor v1.32.0 (MIT) audits GitHub Actions for template injection, unpinned uses, impostor commits and more. It has SARIF output and a Windows msvc zip ([release](https://github.com/zizmorcore/zizmor/releases/tag/v1.32.0), 2026-11-02; [audits.md](https://github.com/zizmorcore/zizmor/blob/main/docs/audits.md), read 2026-11-03).
- PSScriptAnalyzer 1.25.0 (MIT) is Microsoft's PowerShell linter ([release](https://github.com/PowerShell/PSScriptAnalyzer/releases/tag/1.25.0), 2026-03-20). No other tool here covers our 60 `.ps1` files. SARIF output is unverified.
- `.coderabbit.yaml` lines 72-73 are a comment. It lists gitleaks, trufflehog, actionlint, zizmor, shellcheck, PSScriptAnalyzer, skillspector and yamllint as tools that "stay on" because they are not disabled. It does not prove they ran on our PRs (read 2026-11-03).

### 2.2 Orchestration and SARIF reporting

- reviewdog v0.21.2 (MIT) reads SARIF with `-f=sarif` and posts inline PR review comments. It runs outside CI when `CI_PULL_REQUEST`, `CI_COMMIT`, `CI_REPO_OWNER`, `CI_REPO_NAME` and `REVIEWDOG_GITHUB_API_TOKEN` are set ([README](https://github.com/reviewdog/reviewdog/blob/master/README.md), read 2026-11-03; [release](https://github.com/reviewdog/reviewdog/releases/tag/v0.21.2), 2026-09-18, Windows assets present).
- The Windows drive-letter SARIF path fix is merged but not released ([PR #2944](https://github.com/reviewdog/reviewdog/pull/2944), merged 2026-11-02, under `[Unreleased]`).
- In local mode, reviewdog drops findings outside diff files. It logs them only inside GitHub Actions ([github.go](https://github.com/reviewdog/reviewdog/blob/master/service/github/github.go), read 2026-11-03). It skips comments whose fingerprint already exists.
- Issue #1911 reports that one runner's comments can be deleted by another in a multi-runner run ([issue](https://github.com/reviewdog/reviewdog/issues/1911), opened 2024-08-30, open 2026-11-03).
- GitHub code scanning SARIF upload needs Code Security on private repos ([about code scanning](https://docs.github.com/en/code-security/code-scanning/introduction-to-code-scanning/about-code-scanning), read 2026-11-03). Not available to us without a paid plan.
- sarif-tools (MIT) gives `sarif diff` and `sarif summary`. Its last release is v3.0.5 ([release](https://github.com/microsoft/sarif-tools/releases/tag/v3.0.5), 2025-07-17), 15 months old.
- danger-js 14.1.0 needs a Dangerfile that parses SARIF itself ([release](https://github.com/danger/danger-js/releases/tag/14.1.0), 2026-10-26).
- lefthook v2.2.2 and pre-commit v4.7.0 ([lefthook](https://github.com/evilmartians/lefthook/releases/tag/v2.2.2), [pre-commit](https://github.com/pre-commit/pre-commit/releases/tag/v4.7.0), both 2026-10-13) add a runner, not coverage. `pre-pr.mjs` already wraps our checks.
- PR-Agent lives at [The-PR-Agent/pr-agent](https://github.com/The-PR-Agent/pr-agent). On 2026-11-03, `gh api repos/qodo-ai/pr-agent` resolves to `The-PR-Agent/pr-agent`, so old `qodo-ai` links redirect.
- PR-Agent v0.49.0 is still the latest release. Main is 188 commits ahead and adds Sonnet 5.5 support ([compare](https://github.com/The-PR-Agent/pr-agent/compare/v0.49.0...main), 2026-11-03). Code search returns 0 hits for `sarif` and `semgrep`.
- The sweep reports a plain-diff stdin mode ([plain_diff_mode.md](https://github.com/The-PR-Agent/pr-agent/blob/main/docs/docs/usage-guide/plain_diff_mode.md), 2026-11-03). The skeptic did not check it.
- PR Cockpit (MIT, 485 stars, rolling unsigned nightly) posts in-diff findings inline. It puts the rest in a summary and cleans up pending reviews ([repo](https://github.com/taovc/pr-cockpit), pushed 2026-10-27, unverified). Borrow the posting design, not the app.
- PR-AF claims 0.706 golden recall on Martian with GLM-5.2. The claim is self-reported. The repo has no LICENSE file detected, and it needs Docker ([repo](https://github.com/Agent-Field/pr-af), pushed 2026-11-02, unverified).
- READY trust in CCv3: `scripts/github/review-status.mjs` names `greptile-apps` and `coderabbitai[bot]` at lines 89, 95 and 378. It blocks READY on unresolved threads at lines 1459 and 1477 (header line 24). Comments posted with Dave's token appear as `Rev4nchist`.

### 2.3 LLM review methods

- **Multi-pass aggregation.** SWR-Bench: run the reviewer n times, then merge with one extra LLM call. Gemini-2.5-Flash n=10 gave F1 21.91 (+43.67%) and recall 30.44 (+118.83% relative). The Flash single-pass base was weak (P16.88/R13.91/F1 15.25). Gemini-2.5-Pro n=5 gave F1 23.84 (+23.01%). Gains flatten after n=5. Precision did not improve ([arXiv 2509.01494](https://arxiv.org/html/2509.01494v2), v2 2026, FSE 2026).
- **Vote plus validator.** Cursor Bugbot ran 8 parallel passes with randomized diff order, dropped single-pass findings, then ran a validator model and dedup. A later agentic design gave the largest gain. Resolution rate went from 52% to over 70% ([Cursor blog](https://cursor.com/blog/building-bugbot), 2026-01-15) and 78% ([changelog](https://cursor.com/changelog/04-08-26), 2026-04-08). Resolution rate is an AI-judged precision proxy. No per-component ablation was published.
- **Reflexion pass.** CR-Bench GPT-5.2: recall 27.01 to 32.76, precision 3.56 to 5.10, signal-to-noise 5.11 to 1.95. GPT-5-mini SNR fell to 0.91 ([arXiv 2603.11078](https://arxiv.org/html/2603.11078), 2026-03-10). All agents recalled High-severity bugs better than Low or Medium.
- **Verifiers improve calibration, not recall.** OpenAI says extra verifier budget "mostly improves calibration and reduces false alarms". It says 52.7% of comments led to a code change ([OpenAI alignment](https://alignment.openai.com/scaling-code-verification), 2025-12-01).
- **Cross-provider severity.** Apollo scored agent trajectories for severity on a 1-10 scale ([Apollo Research](https://www.apolloresearch.ai/products/evaluating-llm-calibration-for-coding-agent-monitoring/), 2026-07-07). Single models with thinking off reached MAE 0.96 to 1.00. A 3-model ensemble reached 0.82. A 2-model ensemble (GPT-5.5 + Opus 4.8) reached 0.85; the skeptic did not check this pair (unverified). Gains come only from ensembles of 2 or 3 models. The task is not PR review, so transfer to PR severity is [Speculation].
- **Over-correction.** LLM reviewers flag correct code as defective, and detailed prompts make it worse ([arXiv 2603.00539](https://arxiv.org/abs/2603.00539), 2026-02-28). The task is requirement conformance, not PR review.
- **Adversarial kill gates.** Refute-or-Promote killed about 79% of 171 candidates and 83% of 30 prospective ones. Ten same-family reviewers endorsed one false finding that one test killed ([arXiv 2604.19049](https://arxiv.org/abs/2604.19049), 2026-04-21, single author, C/C++ security libraries).
- **Structured output.** `claude -p` supports `--json-schema` (local `claude --help`, 2026-11-03; [CLI reference](https://code.claude.com/docs/en/cli-reference), 2026-11-03). Strict format constraints can lower reasoning quality ([arXiv 2408.02442](https://arxiv.org/abs/2408.02442), EMNLP 2024). A two-step answer then format is the alternative.
- **cursor-agent has no schema flag.** Local `cursor-agent --help` (2026-11-03) lists only `--output-format text | json | stream-json`, and only with `--print`. The `json` format is a reply envelope. It does not check the findings against a schema.
- **Practitioner noise control (unverified blogs).** The skeptic did not re-check the three blogs below.
  - Ionix keeps only critical and high findings. It post-filters by severity because the prompt floor "leaks". It drops findings whose path is not in the repo. It fails the job on unparseable JSON ([Ionix blog](https://www.ionix.io/blog/we-built-an-ai-pr-reviewer/), 2026-08-13).
  - Entelligence reports precision 73% to 94% after a prompt cut from 38.5k to 3.4k characters. It says a cheap-model triage stage capped recall ([Entelligence blog](https://entelligence.ai/blogs/how-we-made-code-review-3.4x-faster-and-50-cheaper), 2026-08-11, vendor, sample size not stated).
  - Greptile found LLM self-judgment of nits "nearly random" ([Greptile blog](https://www.greptile.com/blog/make-llms-shut-up), 2024-12-18).
- **Managed Claude Code Review.** It runs parallel finders, a verification step and ranking, with 3 severities (Important, Nit, Pre-existing). It needs a Team or Enterprise plan ([docs](https://code.claude.com/docs/en/code-review), read 2026-11-03). It "has no flat per-review price" and is "billed on token usage through usage credits" ([costs page](https://code.claude.com/docs/en/code-review-costs), read 2026-11-03). The "under 1% marked incorrect" figure is an opt-in dismissal rate, not precision ([InfoWorld](https://www.infoworld.com/article/4143297/claude-code-adds-code-reviews.html), 2026-03-10).
- **Claude review on the subscription.** The same docs page lists two other options ([docs](https://code.claude.com/docs/en/code-review), read 2026-11-03):
  - `/code-review` runs "in your Claude Code session". Its "Who can use it" cell says "Anyone, on any plan".
  - Ultrareview runs in a cloud sandbox. It "Requires signing in with a claude.ai account".
  - Not checked: whether `/code-review` runs under headless `claude -p`, and its recall on any benchmark.

### 2.4 Benchmarks and how our numbers compare

Our numbers come from frozen prompt f53fa6b8 (`.claudedocs/2026-11-03-p0-pr-body.md`):
- holdout strict Major recall 3/9 by line, 1/9 same issue;
- precision 16/23 = 70% (range 70-78%);
- 4 of 11 claimed Majors confirmed;
- dev-set recall 0/12 strict.
 The replay path runs `grok-4.7-high` at band MID (`scripts/eval/review-eval/replay.mjs:127`).

Wilson 95% intervals (recomputed by the skeptic, 2026-11-03):

| Our metric | Point | 95% interval |
|---|---|---|
| Holdout line recall 3/9 | 33% | 12.1-64.6% |
| Holdout same-issue recall 1/9 | 11% | 2.0-43.5% |
| Precision 16/23 | 70% | 49.1-84.4% |
| Severity precision 4/11 | 36% | 15.2-64.6% |
| Dev recall 0/12 | 0% | 0-24.3% |

Martian offline, strict profile, Opus 4.5 judge, 50 PRs, 139 gold items, derived from the public [dashboard JSON](https://github.com/withmartian/code-review-benchmark/blob/main/offline/analysis/benchmark_dashboard.json) (repo pushed 2026-09-15; not the live leaderboard):

| Tool | Precision | Recall |
|---|---|---|
| Qodo Extended | 64.8 | 66.2 |
| Augment | 56.5 | 65.5 |
| Cubic | 58.3 | 65.5 |
| Bugbot | 54.8 | 48.9 |
| Greptile | 49.0 | 54.0 |
| claude-code | 44.3 | 50.4 |
| Copilot | 35.6 | 66.9 |
| CodeRabbit | 31.0 | 62.6 |
| Graphite | 100 | 7.9 |

- Martian's hit rule is "same underlying issue", with no line match ([methodology](https://github.com/withmartian/code-review-benchmark/blob/main/methodology/full.md), 2026-09-15). Its judge is not formally calibrated against humans. Our comparable number is same-issue recall (11%), not line recall.
- Our precision is "judged real". Martian precision counts real but unlisted findings as false. The two are not comparable.
- Our dataset is 100% CodeRabbit-sourced, so CodeRabbit scores 100% on it by construction (local plan section 6).
- Vendor ranks disagree. Qodo's blog says Extended F1 64.3 and standard 47.9 ([Qodo](https://www.qodo.ai/blog/qodo-ranked-1-ai-code-review-tool-in-martians-code-review-benchmark), 2026-03); the current JSON says 65.5 and 58.0. Greptile self-reports 82% on its own looser benchmark ([Greptile benchmarks](https://greptile.com/benchmarks), 2025).
- Other public anchors: SWR-Bench best single run P16.65/R23.18 ([arXiv 2509.01494](https://arxiv.org/abs/2509.01494)); SWE-PRBench detection 15-31% on diff-only prompts ([arXiv 2603.26130](https://arxiv.org/abs/2603.26130), 2026-03-27); GitHub ReviewBench gives relative Copilot gains only, recall +13.6% ([GitHub blog](https://github.blog/ai-and-ml/github-copilot/reviewbench-an-open-benchmark-for-ai-code-review/), 2026-10-05, unverified).
- [Speculation] Our holdout cannot tell 33% from 60%. The dev set does show recall under about 24%.

### 2.5 Testing and verification

- **StrykerJS** v10.1.1 (Apache-2.0) has a vitest runner, incremental mode and line-range `--mutate file:5-7` ([incremental docs](https://stryker-mutator.io/docs/stryker-js/incremental/), read 2026-11-03; [release](https://github.com/stryker-mutator/stryker-js/releases/tag/v10.1.1), 2026-10-23). CI tests `windows-latest` ([ci.yml](https://github.com/stryker-mutator/stryker-js/blob/master/.github/workflows/ci.yml), read 2026-11-03). Compatibility with our Vitest ^4.1.12 is unverified.
- **fast-check** v4.10.2 (MIT) has a vitest package ([release](https://github.com/dubzzz/fast-check/releases/tag/v4.10.2), 2026-09-19). It fits parsers, regexes and guards, the units AGENTS.md says isolated tests are for.
- **Agentic property-based testing.** Claude wrote Hypothesis properties over 100+ PyPI packages. Of 50 reviewed reports, 56% were valid and 32% report-worthy. Among the top-ranked 21, 86% were valid ([arXiv 2510.09907](https://arxiv.org/abs/2510.09907), 2025-10-10; [Anthropic](https://www.anthropic.com/research/property-based-testing), 2026-01-14). The skeptic did not check these figures or the Anthropic date (unverified). The `/hypothesis` command is in the Hypothesis repo ([hypothesis.md](https://github.com/HypothesisWorks/hypothesis/blob/master/.claude/commands/hypothesis.md), read 2026-11-03). Hypothesis is MPL-2.0.
- **Meta JiTTest.** Tests run on parent and child; keep those that pass on parent and fail on child. Weak-catch rate per diff was 4.0% (26/654, dodgy diff) and 7.9% (49/617, intent-aware). Of 41 reach-outs, the paper says both 7 and 8 were confirmed ([arXiv 2601.22832](https://arxiv.org/html/2601.22832), 2026-01-30). The Meta blog figures (60% true positive, 74 privacy bugs) were not opened by the skeptic ([Meta engineering](https://engineering.fb.com/2026/10/29/security/catching-bugs-before-they-land-jittestings-human-on-the-loop-approach-at-full-scale/), 2026-10-29). A TS/Vitest port exists with 0 stars ([catching-jit-tests-vitest](https://github.com/hbmartin/catching-jit-tests-vitest), v0.4.0 2026-06-19).
- **Meta ACH.** A generated test counts only if it kills a mutant. It reports 571 tests, 73% accepted. The equivalent-mutant detector scored P/R 0.79/0.47 raw and 0.95/0.96 with preprocessing ([arXiv 2501.12862](https://arxiv.org/abs/2501.12862), 2025-01-22). The 31,677 / 4,660 / 191 / Llama 3.1 70B figures are not in the abstract: medium confidence.
- **Coverage is the wrong gate.** In MutGen, one subject had 100% line and branch coverage. Its mutation score was 4% ([arXiv 2506.02954](https://arxiv.org/abs/2506.02954), v6 2026-02, unverified).
- **Finding reproduction.** e-Otter++ reaches 63% fail-to-pass on TDD-Bench Verified ([arXiv 2508.06365](https://arxiv.org/abs/2508.06365), v3 2026-01-22, ICSE 2026). The Otter++ precision figures (60.8% to 91.9%, recall 33%) come from a slide summary and are unverified.
- **mutmut** needs fork support and WSL on Windows ([README](https://github.com/boxed/mutmut), read 2026-11-03). `opc/pyproject.toml` lines 161 and 165 carry `mutmut>=3.0.0` and a `[tool.mutmut]` block. It cannot run on this host today.
- **Test selection.** Vitest v5.1.0 adds `--since-last-run` ([CLI docs](https://vitest.dev/guide/cli.html), read 2026-11-03; release 2026-11-02; flag unverified). Static-graph selection misses tests that reach code through child processes, which our hooks use.
- **Coverage generators.** Qodo Cover is end-of-life since 2025-06-15 ([commit](https://github.com/qodo-ai/qodo-cover/commit/HEAD), 2025-06-24, unverified). CoverUp needs API keys ([arXiv 2403.16218](https://arxiv.org/abs/2403.16218)). LLMorpheus is archived ([repo](https://github.com/githubnext/llmorpheus), 2025-02-03).

### 2.6 LLM and agent security

- Cisco skill-scanner publishes its own numbers on a held-out split of 839 malicious and 545 benign skills. Rules alone reach 7.7% recall at HIGH with a 4.0% false-positive rate. Rules plus an LLM judge reach 66.7% at MEDIUM+ with 15.4% FPR ([measured-results.md](https://github.com/cisco-ai-defense/skill-scanner/blob/main/docs/reference/measured-results.md), read 2026-11-03, vendor).
- A study of MCP scanners on 37,288 servers found under 50% of sampled alerts were true positives ([arXiv 2607.11086](https://arxiv.org/abs/2607.11086), 2026-07-13). An independent audit found 6 of 27 Cisco mcp-scanner detections genuine ([appsecsanta](https://appsecsanta.com/research/mcp-server-security-audit-2026), 2026-07-02, not re-checked).
- NVIDIA SkillSpector v2.13.3 (Apache-2.0) has a `--no-llm` mode and a `claude_cli` provider that uses local CLI auth ([repo](https://github.com/NVIDIA/SkillSpector), 2026-11-03). CI runs on `ubuntu-latest` only and the release has no binaries ([ci.yml](https://github.com/NVIDIA/SkillSpector/blob/main/.github/workflows/ci.yml), 2026-11-02). Windows is untested upstream. It does not parse hooks or `settings.json` as far as the sweep found.
- Snyk Agent Scan needs a `SNYK_TOKEN` and sends skill content and MCP configs to its API ([repo](https://github.com/snyk/agent-scan), 2026-11-03).
- Promptfoo is now part of OpenAI and stays MIT ([README](https://github.com/promptfoo/promptfoo), 2026-11-03). Its code scanning uses a hosted API ([docs](https://www.promptfoo.dev/docs/code-scanning/), 2026-11-03).
- garak v0.17.1 tests models, not harness code ([repo](https://github.com/NVIDIA/garak), 2026-11-02).
- aisecscan (formerly agentscanner) targets the Claude Code config surface but has 1 star and no release ([repo](https://github.com/jassics/agentscanner), pushed 2026-09-30).
- No mature local scanner covers TypeScript hooks and `settings.json` matchers. Our own Semgrep rules on hook files remain the honest option.

### 2.7 Practitioner evidence

- An MSR 2026 study covered 19,450 AIDev PRs. PRs reviewed only by code-review agents merged at 45.20%. Human-only PRs merged at 68.37%. 12 of 13 agents averaged under 60% signal ratio ([arXiv 2604.03196](https://arxiv.org/abs/2604.03196), 2026-04-03, unverified). The result is correlational.
- Hacker News, "There is an AI code review bubble" ([thread](https://news.ycombinator.com/item?id=46766961), 2026-01-26; vendor comments excluded; quotes unverified):
  - "they do find critical bugs ... but the signal to noise ratio is poor" ([zmmmmm](https://news.ycombinator.com/item?id=46771757), 2026-01-26).
  - On CodeRabbit: it finds subtle problems but "regularly complains about things that are possible in theory but impossible in practice" ([The_Fox](https://news.ycombinator.com/item?id=46771089), 2026-01-26).
  - Claude review is non-deterministic: each run noted different issues (vimda, same thread, comment id not recorded).
- Ask HN, AI code review tools ([thread](https://news.ycombinator.com/item?id=48595210), 2026-06-19): one team runs Claude Code headless in a GitLab job with a small MCP poster. It feeds existing comments back to avoid double posts. "Most complexity is in the SHA management." This is the same shape as our engine.
- Common metrics: resolution or address rate (Cursor, Greptile), dismissal rate per bot (blog heuristic: healthy under 20%, net cost over 30%; [Pyor](https://pyor.review/blog/ai-review-alert-fatigue), 2026-07-10, vendor, unverified), signal ratio (MSR 2026).
- Reddit was not sampled. The domain blocks the fetch tools.

## 3. Verification

Two skeptic passes checked claims against primary sources on 2026-11-03. Coverage is partial. A completeness critic then checked a few more facts. The "Not checked" list below names the claims nobody opened.

**Confirmed**
- Fork is private; CodeQL and code scanning need a paid plan for it.
- `semgrep-ccv3.mjs` runs through Docker (lines 26, 80-82).
- Opengrep v1.33.1 assets, licence and archived rules repo.
- Betterleaks v2 is RC only and drops SARIF; v1.x keeps `report/sarif.go`.
- OSV-Scanner call analysis is Go and Rust only; v2.7.0 assets; Dependabot gaps.
- zizmor v1.32.0 and PSScriptAnalyzer 1.25.0 facts.
- reviewdog local env vars, SARIF input, unreleased #2944, in-diff-only posting in local mode, v0.21.2 assets.
- GitHub code scanning on private repos needs Code Security.
- PR-Agent v0.49.0 latest, 188 commits behind main, no SARIF input.
- Cisco skill-scanner 7.7% rules-only recall; Promptfoo now part of OpenAI.
- SWR-Bench Self-Agg and Hybrid-Review numbers; Cursor Bugbot pipeline; Martian derived numbers; OpenAI verifier text; Refute-or-Promote kill rates; Apollo MAE values; over-correction direction; CR-Bench Table 4; SWE-PRBench abstract numbers.
- `claude -p --json-schema`; Wilson intervals; 0.92^15 = 0.286.
- mutmut needs WSL; StrykerJS Windows CI; fast-check, Vitest and pytest-testmon releases; Hypothesis is MPL-2.0.

**Corrected**
- `review-status.mjs` is at `scripts/github/`; identity lines are 89, 95, 378; unresolved-thread block lines are 1459 and 1477.
- `.coderabbit.yaml:72-73` is a comment, not proof of runs. It also lists skillspector and yamllint.
- `scoped-scan.mjs` is under `.claude/scripts/security/`, lines 125-126.
- Betterleaks repo created 2026-02-03, not 2026-03-15.
- Gitleaks Dependabot-only commits date from at least 2026-06-24.
- arXiv 2601.22952 covers Java and C/C++, not Java only.
- Qodo 64.3 and 47.9 are stale; the dashboard JSON gives 65.5 and 58.0.
- Martian strict profile has 139 gold items, not 173.
- SWR-Bench +119% is against a weak Flash baseline.
- CR-Bench: GPT-5.2 precision rose (3.56 to 5.10) while SNR fell.
- Anthropic "under 1%" is an opt-in dismissal rate.
- Meta JiTTest: the paper says both 7 and 8 confirmed of 41.
- Kingfisher: licence and Windows zip confirmed; SARIF not checked.
- SkillSpector: CI is Ubuntu only, no binaries; Windows unverified.
- sarif-tools: last release 15 months old.
- Apollo MAE 0.96 and 1.00 are thinking-off appendix values.

**Checked by the completeness critic (2026-11-03)**
- Semgrep v1.183.0 was published 2026-10-29 (`gh api`).
- cosmic-ray release/v8.7.0 was published 2026-08-09 (`gh api`).
- `qodo-ai/pr-agent` resolves to `The-PR-Agent/pr-agent` (`gh api`).
- Code Review costs page: no flat per-review price; token-billed through usage credits.
- Code Review docs page: `/code-review` on any plan; Ultrareview needs a claude.ai sign-in.
- SWE-PRBench abstract: 2,000-token diff-with-summary beats 2,500-token full context.
- `cursor-agent --help`: no JSON-schema flag.

**Unverifiable**
- Semgrep CE 44% Juice Shop figure (vendor-funded; no re-check).
- Ionix, Entelligence and Greptile 2024 blogs; appsecsanta 6 of 27; Meta blog 60%.
- Otter++ 60.8% / 91.9% / 33%; ACH body figures; SWE-PRBench 11 parse failures.
- Martian 66 of 173 High or Critical count; ReviewBench dataset access.
- PR-Agent plain-diff mode and Agent Skills claims.
- Validator claim in arXiv 2505.17928.

**Not checked.** The skeptic passes did not open these. Rows that rest on them carry "(unverified)" in the proposal.
- Hypothesis agentic PBT 56% valid, 32% report-worthy, 86% of the top 21. This drives an ADOPT row.
- The Anthropic property-based testing research date, 2026-01-14.
- MutGen "100% coverage, 4% mutation score". This drives a SKIP row.
- Trivy GHSA-69fq-xp46-6x23 and CVE-2026-33634 details.
- Bearer Elastic License 2.0 and the missing Windows asset.
- Semgrep Rules License v1.0 terms.
- Vitest v5.1.0 `--since-last-run`.
- Qodo Cover end of life.
- MSR 2026 study (arXiv 2604.03196): 45.20% against 68.37%.
- The Hacker News quotes.
- Pyor dismissal heuristic (20% and 30%).
- PR Cockpit and PR-AF repo facts.
- ReviewBench "recall +13.6%".
- The Apollo 2-model pair (GPT-5.5 + Opus 4.8, MAE 0.85). Only the 3-model set was checked.

**Refuted:** none.

**Dropped as unsupported:** the "68.2% vs 74.8% FP rate, CodeQL vs Semgrep" figures from a vendor comparison page. The cited arXiv 2601.22952 does not contain them.
