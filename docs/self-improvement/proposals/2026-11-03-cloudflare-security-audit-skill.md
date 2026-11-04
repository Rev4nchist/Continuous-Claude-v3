# Cloudflare security-audit skill (2026-11-03)

Verdict: **ADOPT the method, narrow. SKIP vendoring the skill as-is. WATCH full six-phase mode.**
Adopt three parts: the findings contract (schema + validator), the fresh-refuter step, and the hunt method in `/security` + aegis.
Vendor-as-is fails vet-skill, collides with the `/security` trigger, and its validators exit 1 on Windows.
The eval also found 14 real bypasses in CCv3's own guard hooks. That is the most urgent result.

Status: Dave approved the recommendation on 2026-11-03 (D1-D6 as recommended). Guard-fix lanes seeded: `guard-tool-matcher-f07`, `package-guard-bypasses`, `destructive-guard-bypasses`. P0 and P1 done: PR #274 landed (main 4c6cca6c). F07 fixed in PR #276. P2 ships in `feat/security-refuter`. P3 (headless E2E) needs its own yes.
Source: `cloudflare/security-audit-skill` at `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8`, MIT, 22 files.
Evidence: `.claudedocs/2026-11-03-cloudflare-skill-eval.md` (untracked, holds the bypass details). Workflow `wf_1c92e973-a29`: 4 readers, 2-arm paper eval, opus judge, opus architect, opus refuter.

## 1. What the skill is

- One skill, `security-audit`. Guidance mode by default. Full mode needs an explicit audit request (`SKILL.md:10-17`).
- Full mode has 6 phases: recon (4 agents), coverage-ledger hunting waves with a critic, fresh-refuter validation, `findings.json`, a second verifier per record, and a report.
- No agent verifies its own candidate. Severity never exceeds demonstrated impact (`SKILL.md:152`).
- Two zero-dependency Node validators check `findings.json` and the coverage ledger against `report-schema.json`.
- Target code runs only in an OS sandbox (`SKILL.md:33-40`). CCv3 has none, so full mode is source-only here.

## 2. What CCv3 already has

- `/security` skill and the aegis agent (opus): one reviewer, markdown report, no independent refuter.
- `security-scan` skill, built-in `/security-review`, and Semgrep, Trivy and gitleaks in CI.
- `docs/security/review-briefs/r4-security-axis.md` and `r5-high-tier.md` already port parts of `ATTACK-CLASSES.md`, `DATA-ISOLATION-AND-LIFECYCLE.md` and `AI-AND-LLM.md`. `review-briefs/README.md:54-57` records their blobs. Those 4 blobs match the pinned copy.
- Gaps: no machine-readable security findings, no refuter, no `needs_validation` state, no "ran / not ran" coverage record.

## 3. Eval result

Same target for both arms: `destructive-command-guard.ts`, `shared/destructive-classifier.ts`, `package-install-guard.ts`.

| Arm | Findings | Judge (opus re-ran 58 payloads through the real functions) |
|---|---|---|
| A: Cloudflare method | 17 | 14 real defects, 1 by design, 1 refuted, 1 half plausible |
| B: CCv3 `/security` + aegis | 0 delivered | Not comparable: a safety classifier withheld B's report |

- The method comparison is **inconclusive**. Arm A shows that the method gives replayable findings. It does not show that it beats `/security`. P3 reruns both arms.
- Arm B's probes wrote 10 fake rows (`session_id sess-0000-aaaa`) to the shared `~/.claude/logs/guard-decisions.jsonl`. They need removal before the next SKIP audit.

### The 14 guard defects plus F15 (half confirmed). IDs only; details in the `.claudedocs` report

| Owner | IDs | Kind |
|---|---|---|
| New lane: destructive-guard bypasses | F01-F06, F14, F16 | Pattern and table gaps, quote desync, regex timeout |
| New PR: package-install-guard | F08, F10-F13, F15 | Override substring, anchoring, flag parsing, npx/dlx/uvx, URL installs, tag pins |
| `settings.json.template` matcher item | F07 | Both guards gate only Bash and PowerShell (`destructive-command-guard.ts:84`). desktop-commander `start_process` skips both |

Fix rule (memory "guard shell-lexer arms race"): no hand-lexer growth. Fail closed on raw text. That raises quoted-text false positives, so the fix lane runs the `guard-prompt-text-fp` repro as a regression. Keep each payload as a failing test first, so the fixtures survive the fix.

## 4. Options

| Option | What changes | Cost per run | Main risk |
|---|---|---|---|
| 1. Vendor as-is via vet-skill | `.claude/skills/_vendor/cloudflare/security-audit/`, skill-rules entry, validator shim | Guidance 0 agents. Full: dozens to hundreds of agent calls [Speculation] | vet-skill step 5 needs an API key; step 7 rewrites the pinned description; trigger collides with `/security` (G15); no sandbox |
| 2. Fold the method into `/security` + aegis | `security/SKILL.md`, `aegis.md/.json`, new `security-refuter.md/.json` (opus, high) | About 3-5 opus calls on a target this size | Steering files, so checkpoint band; Claude refuter checking Claude hunter is correlated |
| 3. Contract only | `.claude/scripts/security/cf-contract/` (schema, `validate-findings.cjs`, LICENSE, PROVENANCE, lock) + `cf-validate.mjs` wrapper | $0, under 1 s | A contract with no producer is a vacuous gate |
| **4. Hybrid: 3, then a narrow 2** | Both, in that order. No ledger, no 4-way recon | Same as 2 | Depends on the S4 and engine P2 lanes for later phases |

Recommendation: **Option 4.** Option 3 sits outside every `matrix` key, so it is not a CRITICAL-band edit (the refuter checked all 10 keys).

## 5. Plan with stop points

1. **P0, Dave yes.** Pin the source: `git init`, `git fetch --depth 1 https://github.com/cloudflare/security-audit-skill c1c8a8c1471069fb0e188eeaff69b8e8db6564a8`, `git checkout FETCH_HEAD`. git 2.47.1 has no `clone --revision`. Record `git ls-tree` blob IDs for `report-schema.json` and `validate-findings.cjs` in PROVENANCE.md.
2. **P1 contract.** Branch `feat/cf-security-contract`. Add `cf-contract/` and `cf-validate.mjs`. The wrapper:
   - reads the file itself (regular file, lstat no-symlink, 5 MiB cap, fatal UTF-8 decode), then calls the exported `validateDocument` (`validate-findings.cjs:585`, `:759-771`);
   - re-implements the depth and array pre-scan, which is not exported;
   - **rejects** non-POSIX paths and does not normalize them, so the validator's path rule still applies;
   - names its output `security-findings.json`, apart from the R4 `findings.json` v1.1 contract.
   Proof: a PASS fixture (F17 and F09 as `rejected`, F15 blocklist half as `needs_validation`) and a FAIL fixture with 3 named errors. Run upstream tests with an explicit expected-failure list: the CLI tests call the CLI with no skip and fail on win32 by design. Stop before commit.
3. **P2, Dave yes, steering files.** Fold the hunt method and refuter into `/security` and aegis. Keep the markdown report and severity labels: the `release` skill, `resume_handoff`, critic, liaison, plan-reviewer, principal-reviewer and the RF text at `pr-checkpoint.mjs:300-307` read them. Fix the output-path drift between `docs/agents/README.md:439` and `aegis.md:107`. No new rule text. Output to `.claude/cache/agents/aegis/`.
4. **P3, Dave yes, about 2-4 headless `claude -p` runs.** After sync, run both arms again on the guard hooks. Report recall against the 14 known defects, the refuter verdict on F17, agent calls and wall time. Then run the four ratchets: `audit-skills.mjs`, `context-budget-guard.mjs --repo`, `check-agent-model-drift.mjs .`, `check-agent-body.mjs`.
5. **P4 hand-offs, messages only.** The refuter contract goes to whoever builds S4 in `2026-11-03-review-testing-system.md` (S4 row; "Refute-or-Promote" WATCH row). For S4 the refuter downgrades or marks `needs_validation` and never deletes. The research lane only writes docs, so it is not the builder.
6. **P5 guard fixes** per the owner table in section 3. Each is its own lane or PR, test first. Package-guard and settings matcher PRs are CRITICAL band.
7. **P6, after engine P2 lands R5.** `security-findings.json` feeds a P4-class finder and `securityEscapes4w` (`scripts/eval/review-eval/shadow.mjs:158`). Not built in this lane.

P2 as built (deviations from the plan above):
- Replay probes live in `.claude/cache/security/<run-id>/probes/`, not `.claude/cache/e2e/`. Run id defaults to `<date>-adhoc`.
- Probes run as `timeout 15 env -i PATH SYSTEMROOT node --permission --allow-fs-read=<repo>`, with no write access; a shell redirect saves the output. Tested on Node 22.13.1: no API keys in env, child processes blocked, reads outside the repo blocked.
- Residual: Node 22 cannot block the network, and the probe can read any repo file. The Bash and Write limits for aegis and security-refuter are prompt rules. The agent `.json` field `blocked_patterns` is loaded by `opc/scripts/claude_spawn.py:321` and read nowhere else, so a pattern there would enforce nothing.

WATCH trigger for full mode: a Windows sandbox exists (Job Object or AppContainer wrapper, or WSL with no network) and Dave sets an agent-call budget per audit.

## 6. Decisions for Dave

| # | Question | Recommendation |
|---|---|---|
| D1 | Hand-vetted port (port markers + `THIRD-PARTY-NOTICES.md`, the R4/R5 precedent) in place of vet-skill? | Yes |
| D2 | What does `confirmed` mean with no sandbox? (a) a replay-probe artifact in `.claude/cache/e2e/`, and the refuter gets Bash for `node` on that probe only; (b) source-only `confirmed` as a documented deviation | (a): the eval's confirmations came from exactly this probe |
| D3 | Does an open security Major block READY before engine P2 lands R5? | No, advisory until R5 |
| D4 | Validators through the wrapper only, or also WSL node? | Wrapper only |
| D5 | Agent-call cap per `/security` run with the refuter? | 6 opus calls |
| D6 | Seed the guard-fix lanes and PRs from section 3 now? | Yes, F07 first |

## 7. Not checked

- aegis.json content parity, the vet-skill X01 conflict scan, and the exact G15 collision count.
- Whether Claude Code runs the tool when a PreToolUse hook times out (F16 impact).
