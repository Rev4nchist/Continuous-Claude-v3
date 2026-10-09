# HexStrike AI in CCv3: skip the framework, build the one safe idea (2026-10-09)

Verdict: **SKIP** wholesale adoption. **Steal one idea:** a native, scope-gated, defensive
dynamic-scan capability for your own targets. Status: **steal-idea BUILT** on branch
`feat/security-scan`, waiting on Dave to review and land.

Do not vendor it. Do not add it as an MCP server. Do not depend on it.

Dave's decisions:
- 2026-10-09: "build it". Built the `security-scan` capability this session (see §5).
- 2026-10-09: "close the scan-guard follow-up". The `scan-scope-guard` hook stays a reminder; it
  will not be widened. Command-text matching can never be complete and adds false positives, the
  runner's scope gate is the control, and none of the blocked scanners is installed. If `nuclei` is
  installed later for a deployed target, add a control outside command text (for example a
  firewall egress rule that limits it to localhost) instead of widening the hook.

How it was built: one `oracle` research agent fetched the repo and public reporting. No workflow
fan-out. A single-repo adoption call needs one research pass, not a swarm. Raw facts came from the
GitHub REST API and the README on `master`. Abuse reporting came from Check Point and The Hacker News.

## 1. Answer

- **What HexStrike is.** An MIT-licensed Python MCP server (`hexstrike_server.py` + `hexstrike_mcp.py`
  bridge, FastMCP, port 8888). It exposes 150+ offensive security tools to AI agents. It claims a
  12-agent decision layer: `IntelligentDecisionEngine`, `CVEIntelligenceManager`,
  `VulnerabilityCorrelator` and "Attack Chain Discovery". Owner: OTT Cybersecurity LLC. Version 6.0.0.
- **Its design center is autonomous offense, not defense.** The categories are reconnaissance,
  exploitation, binary RE, password attacks and OSINT. Commit messages from 2025-09-19 say
  "cve exploit gen update" and "real world cve exploit gen fixed". So exploit-generation code exists.
  [Speculation] I did not read the code, so this is a strong signal, not a confirmed feature.
- **It has no harness-level guardrail.** The README asks the user to state their authorization in the
  prompt. That is prompt text, not an enforced control. The README names no target allowlist and no
  scope enforcement. Safety rests on "run it in an isolated VM".
- **It is near-unmaintained.** 2 contributors (one real), 63 commits, no tagged releases, and the last
  code-relevant commit was 2025-09-19. Everything since (2026-03 to 2026-08) touched the license or
  README. 12.6k stars signal attention, not upkeep.
- **It is linked to real-world abuse.** Check Point (2025-09-02) reported criminal-forum chatter about
  using HexStrike against Citrix NetScaler zero-days within hours of release. The time-to-exploit and
  sales claims are actor assertions. No one verified a HexStrike-caused intrusion. The point still
  stands: the tool lowers the barrier to weaponizing a fresh CVE. That is the exact property you do
  not want sitting in a dev harness.
- **Why it cannot go in CCv3.** CCv3 loads into every session in every repo. Its whole value is that
  the harness decides what runs (hooks, guards, the plan gate). HexStrike inverts that: the model
  drives 150 attack tools with no harness gate. An ordinary session, or a prompt-injected one, could
  point exploitation tooling at a live host. The Alias Robotics / Oracle study (arXiv 2508.21669)
  calls LLM security agents "fundamentally unsafe" in adversarial settings. To make HexStrike safe
  you would rebuild the guard layer anyway, so you gain nothing by importing the framework.
- **The real gap it exposes.** CCv3's security surface is static: the `aegis` agent and the
  `/security` skill read code and grep for patterns (`.claude/agents/aegis.md`,
  `.claude/skills/security/SKILL.md`). There is no dynamic check of your own running apps: no
  dependency-CVE scan, no DAST against your own preview URL, no secret or IaC scan. That gap is worth
  closing. Close it with defensive tools you already trust, scoped to targets you own.

## 2. Decision criteria and scores

Scores are 1-5 per criterion, weighted, out of 500.

| Criterion (weight) | A: Adopt as MCP | B: Vendor selective | C: Skip + steal idea |
|---|---|---|---|
| Safe in a harness loaded into every repo (25) | 1 | 2 | 5 |
| Fits lean intake and maintenance (15) | 1 | 2 | 4 |
| Fills a real CCv3 gap (15) | 3 | 3 | 4 |
| Windows + web-app stack fit (10) | 1 | 2 | 4 |
| Keeps the "harness decides" guardrail model (15) | 1 | 2 | 5 |
| Keeps existing enforcement intact (10) | 2 | 3 | 5 |
| Time to first safe lift (10) | 2 | 2 | 4 |
| **Total** | **150** | **225** | **450** |

- **A (Adopt as MCP) = 150.** An always-available autonomous exploitation server fails the one
  criterion that matters most. Rejected.
- **B (Vendor selective) = 225.** Pulling tool-wrappers still imports offensive, unmaintained code
  into your tree and still needs a guard layer you must write. Rejected.
- **C (Skip + steal idea) = 450.** Keep the useful pattern. Drop the framework. Chosen.

## 3. The one idea worth stealing

The good pattern in HexStrike: *AI picks and runs a curated scanner set against a target, then
summarizes the findings into a report.* Rebuild it narrowly and defensively.

- **A `security-scan` skill (user-invoked, confirm-first).** It is the dynamic phase that pairs with
  the existing static phase. It runs only on explicit invocation. It is never ambient.
- **Defensive, own-target tools only.** All cross-platform or Windows-friendly:
  - `npm audit` and `osv-scanner` for dependency CVEs.
  - `gitleaks` for secrets.
  - `trivy` for containers and IaC.
  - A `nuclei` HTTP baseline or OWASP ZAP baseline against a URL **from `project-registry.json`**.
- **A hard scope gate.** The runner reads the target and allows a scan in exactly two cases: an
  http(s) URL whose host is loopback (`localhost`, `*.localhost`, `127.0.0.1`, `::1`), or an exact
  host from a `project-registry.json` `url`. It denies every other host and scheme. This is the
  control HexStrike lacks. It is the harness deciding, not the model.
- **Wire it into the existing flow.** The `/security` skill becomes: `aegis` (static) → `security-scan`
  (dynamic, scoped) → `arbiter` (verify fixes). One report, two phases.
- **How all repos benefit.** Any repo with a registry entry gets the dynamic scan for free, bounded to
  its own declared targets. That is the "every repo benefits" goal, met safely.

## 4. Risks of the chosen path

- **Scope-gate bypass.** If the gate is weak, a scan could hit a host you do not own. Mitigation: the
  gate denies by default and allows only loopback or exact registry hosts, over http(s). A probe
  proves a non-registry host, a lookalike host and a non-http scheme are denied.
- **Tool install burden on Windows.** `nuclei`, `trivy`, `gitleaks` are single Go binaries, so this is
  small. `osv-scanner` is also a Go binary. ZAP is heavier; prefer `nuclei` first.
- **Scope creep toward offense.** Keep the tool list defensive. No exploitation, no password attacks,
  no recon of third parties. If a tool cannot run against your own target for your own defense, it
  does not belong here.

## 5. What was built (2026-10-09, `feat/security-scan`)

All defensive, scope-gated, confirm-first. Verified before hand-off.

- **`.claude/scripts/security/scoped-scan.mjs`** - the runner. It syncs to
  `~/.claude/scripts/security/`, so it works from any project. `deps` / `secrets` / `fs` scan the
  local repo (`deps` and `fs` contact advisory services). `web <url>` runs only after the gate
  allows the host. `check <url>` prints the decision and never scans. Never installs a tool.
- **`.claude/scripts/security/scope-gate.mjs`** - the gate: pure functions, deny by default, fails
  closed on an unreadable registry. Owned hosts come only from the project registry; no environment
  variable can change them.
- **`.claude/scripts/security/scoped-scan-probe.mjs`** - the probe. 18/18 pass: 13 pure-gate cases
  with fixture hosts (incl. scheme and canonical-URL checks), 5 runner cases through `check` and
  deny paths only, so no scanner starts.
- **`.claude/hooks/src/scan-scope-guard.ts`** - PreToolUse(Bash|PowerShell) hook. A reminder, not a
  security boundary: when an active scanner is typed as the command, it denies the call and points
  to the runner. The runner's gate is the control. Widening the hook's coverage was raised in the
  PR #111 review and closed on 2026-10-09 (see Dave's decisions). 20 unit tests + a 5-case stdin E2E. Registered in repo `settings.json` and
  the `settings.json.template` under both shells.
- **`.claude/skills/security-scan/SKILL.md`** - user-invoked skill. The dynamic phase. Mandates the
  wrapper, lists the defensive tools, states the one scope rule.
- **`.claude/skills/security/SKILL.md`** - added Phase 1.5 pointing static `/security` at the new
  dynamic phase.

Gates run: scope probe 18/18 (after the PR #111 review fixes); `audit-skills` 0 hard failures, 0 ratchet regressions; full hook suite
97 files / 2259 tests / 0 fail; context-budget 23508 chars (unchanged, the skill is not
always-loaded).

Not done (needs Dave): land the branch (forward sync makes the hook live), and install any scanner
binary he wants (`nuclei`, `trivy`, `gitleaks`, `osv-scanner`) - the runner never auto-installs.

## 6. Sources

- Repo: https://github.com/0x4m4/hexstrike-ai (README on `master`; REST API for metadata).
- Check Point, "Hexstrike-AI: When LLMs Meet Zero-Day Exploitation", 2025-09-02:
  https://blog.checkpoint.com/executive-insights/hexstrike-ai-when-llms-meet-zero-day-exploitation/
- The Hacker News, 2025-09-03:
  https://thehackernews.com/2025/09/threat-actors-weaponize-hexstrike-ai-to.html
- Alias Robotics / Oracle, LLM security-agent safety study: arXiv 2508.21669.
- CCv3 existing surface: `.claude/agents/aegis.md`, `.claude/skills/security/SKILL.md`.
