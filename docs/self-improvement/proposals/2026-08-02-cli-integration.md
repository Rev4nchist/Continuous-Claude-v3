---
date: 2026-08-02
component: cli-integration
component_name: CLI Integration Layer
verdict: adopt
headline: The frontier still validates our CLI-first decision tree, so the work is not strategy — it is that our second-largest integration pattern ("Python harness via uv run", 9 live skills) is dead at config load (proved by execution this session), and the "32x fewer tokens" law those decisions rest on has circular, unsourced provenance that even a dedicated frontier sweep could not trace to a primary benchmark.
sources: 11
---

# CLI Integration Layer — Next-Evolution Proposal (2026-08-02)

> **Continuity note.** A prior pass on this component exists: [`2026-07-08-cli-integration.md`](2026-07-08-cli-integration.md) (verdict ADOPT, 5 recommendations R1–R5). **None of them landed.** `git log` on `.claude/rules-src/cli-integration-strategy.md` and `.claude/skills/cli-integration/` shows only three commits since, all from the 2026-07-29 context-lever split (`9f9b9d4`, `6e6fdee`, `bdec8f7`) — mechanical file moves, no content change. A grep for `response_format`, `output ergonom`, `tool poison`, `lethal trifecta`, `defer_loading`, and `tool search` across both files returns zero hits. This proposal therefore does **not** re-argue that pass; it verifies what it could not, and leads with what it missed.

## 1. Where CCv3 is today

The layer is prose guidance plus per-tool skills/safety-rules — no runtime enforcement. Two artifacts, both verified this session:

- **The always-on rule**, `.claude/rules-src/cli-integration-strategy.md` — since the 2026-07-29 split it carries only the six-option priority order (native CLI > OpenCLI > MCP > generated wrapper > thin REST wrapper > browser automation) and a pointer to the skill.
- **The deliberate skill**, `.claude/skills/cli-integration/SKILL.md` — carries the full decision tree, the ~24-tool inventory table, the Known Gaps table, the 10-criterion **Agent Compatibility Checklist** (attributed to "Building CLIs for agents" by @ericzakariasson), and the 7-step integration checklist, all inside an archived verbatim snapshot (`SKILL.md:42-134`).
- **Reference wrapper**: `scripts/cdp.mjs` — 12 subcommands, `out()`/`ok()`/`fail()` JSON envelope (`cdp.mjs:73-83`), `--help` returning a command map.

### What I verified about the live substrate (this is the new material)

**(a) The inventory's second-largest pattern is dead at initialization. ✓ VERIFIED BY EXECUTION.**

The skill lists a "Python harness via uv run" pattern (`SKILL.md:85`). Nine live skills document it — `qlty-check`, `ast-grep-find`, `morph-apply`, `morph-search`, `firecrawl-scrape`, `perplexity-search`(via archive), `github-search`, `repoprompt`, `braintrust-analyze`/`braintrust-tracing`, plus call sites in `implement_task` and `research-external` — roughly 50 documented command lines of the form `uv run python -m runtime.harness scripts/<x>.py`.

I ran one, read-only:

```
cd opc && uv run python -m runtime.harness scripts/qlty_check.py --help
[ERROR] Failed to initialize MCP client: Failed to load config from
        C:\Users\david.hayes\continuous-claude\.mcp.json: 1 validation error for McpConfig
mcpServers
  Value error, At least one MCP server must be configured
```

Traced root cause, all four links confirmed:

1. `opc/src/runtime/mcp_client.py:356-359` resolves config from project `.mcp.json` (preferred), else project `mcp_config.json`, merged with global `~/.claude/mcp_config.json`.
2. Repo `.mcp.json` is the literal placeholder `{"mcpServers": {}}` — and `McpConfig`'s validator treats empty as a **hard error**, not a no-op. `mcp_client.py:395-398` re-raises project-config failures as `ConfigurationError` (while a *global* config failure is only a `logger.warning`, `mcp_client.py:373-374` — an asymmetry that makes the empty placeholder unrecoverable regardless of what else exists).
3. `~/.claude/mcp_config.json` does not exist.
4. The nine real server definitions (`git`, `fetch`, `firecrawl`, `morph`, `perplexity`, `nia`, `ast-grep`(disabled), `repoprompt`, `qlty`) live under the `mcpServers` key of `.claude/settings.json` — a file **nothing in `opc/src` reads** (grep for `settings.json` across `opc/src`: zero hits). They also never appeared in this session's connected / connecting / auth-required server lists, while all seven from `~/.mcp.json` did.

So nine skills point at a substrate with zero reachable servers, and nine server definitions sit in a file no consumer reads. The `.mcp.json` placeholder is dated 22 Feb.

**(b) `opc/` *is* Anthropic's code-execution-with-MCP pattern, already built.** `opc/pyproject.toml:2-4` names the package `mcp-execution` v3.0.0, described as "Python implementation of Anthropic's 'Code Execution with MCP' … multi-transport support (stdio/SSE/HTTP), and optional container sandboxing". `opc/src/runtime/generate_wrappers.py:4-5` states it "implements the progressive disclosure pattern by generating Pydantic models and wrapper functions for each MCP tool." The 2026-07-08 proposal marked this frontier pattern **WATCH — "needs a sandbox CCv3 lacks on Windows."** That was wrong: we shipped it, and it is the thing that is broken.

**(c) The "32x fewer tokens" law is circularly sourced and decision-driving.** It appears 6 times across 3 documents. `.claude/skills/cli-integration/SKILL.md:36,65` asserts it with no source. `.claude/docs/tool-tier-policy.md:67,93,120` repeats it, and `tool-tier-policy.md:157` cites it as "32x token savings **according to `cli-integration-strategy.md`**" — i.e. back to the unsourced assertion — while using it to justify a real decision (the `qlty` MCP server set `disabled: true` in favour of the CLI). The only place the number appears with a referent is `.claude/skills/browser-dev-cycle/SKILL.md:327`: "Replaces chrome-devtools-mcp (32x fewer tokens, 100% vs 72% reliability)" — **one specific tool comparison**, generalised into a universal CLI-vs-MCP law. This is exactly the class our own `claim-verification.md` rule exists to catch.

**(d) The MCP dependency map (open question #2 from the prior pass) — answered.** `mcp__<server>__` references across skills/agents/rules/hooks/scripts: `shadcn` 96, `claude_ai_Notion` 17, `Neon` 11, `claude_ai_Vercel` 11, `github` 10, `perplexity` 6, `nia` 6, `playwriter` 4, `memory` 3, `jira` 3, `sumologic` 1, `claude_ai_Slack` 1. Four of those name servers that do not exist in the live surface: `mcp__playwriter__` (a typo for `playwright`, in live hook source `browser-learning-extractor.ts`), `mcp__jira__` (live server is `claude_ai_Atlassian`), `mcp__memory__`, `mcp__sumologic__`. The rest are in archived/snapshot skills.

**(e) Inventory rot, as the skill itself predicts.** `qlty` and `ast-grep` are listed in the inventory but are not on PATH; `ast-grep`'s MCP entry is additionally `disabled: true`. The other 11 inventory CLIs (`gh`, `vercel`, `railway`, `neonctl`, `tldr`, `opencli`, `linearis`, `sentry-cli`, `codex`, `grok`, `ntn`) are all present and on PATH.

**(f) Tool search is ours for free, at scale.** This session's system-reminders deferred roughly 220 `mcp__*` tool schemas across 12 connected servers behind `ToolSearch`, with 5 more awaiting auth. Confirms the prior pass's source-11 observation and enlarges it.

## 2. Frontier scan

Sources marked ✓ were fetched and quote-verified by me this session. Sources marked ⚠ come from the `oracle` research agent and were **not** independently fetched — they are never the sole basis for a figure I rely on.

1. **✓ MCP specification versioning** — `https://modelcontextprotocol.io/specification/versioning`. "The **current** protocol version is **2026-07-28**." Version negotiation now happens per-request via the `io.modelcontextprotocol/protocolVersion` key in `_meta`; a mandatory `server/discover` RPC returns supported versions. Backward compat is framed against "the handshake-based protocol revisions (`2025-11-25` and earlier)."

2. **✓ MCP 2026-07-28 changelog** — `https://modelcontextprotocol.io/specification/2026-07-28/changelog`. **This is five days old and it is the largest MCP revision since launch.** Verbatim highlights: "Make MCP stateless: remove the `initialize`/`notifications/initialized` handshake" (SEP-2575); "Remove protocol-level sessions and the `Mcp-Session-Id` header"; "Deprecate the Roots, Sampling, and Logging features" with suggested migrations ("integrate directly with LLM provider APIs instead of Sampling"; "log to `stderr` … or use OpenTelemetry instead of Logging"); "Servers **SHOULD** return tools from `tools/list` in a deterministic order to enable client-side caching and improve LLM prompt cache hit rates"; new required `ttlMs`/`cacheScope` `CacheableResult` fields on list results. Governance: "Adopt a specification feature lifecycle and deprecation policy … a minimum twelve-month deprecation window."

3. **✓ Anthropic, "Code execution with MCP: building more efficient agents"** — `https://www.anthropic.com/engineering/code-execution-with-mcp`, "Published Nov 04, 2025". "This reduces the token usage from 150,000 tokens to 2,000 tokens—a time and cost saving of 98.7%" (one worked example, not a general benchmark). The pattern: "Presenting MCP servers as code APIs rather than direct tool calls." Cost stated by Anthropic itself: "Running agent-generated code requires a secure execution environment with appropriate sandboxing, resource limits, and monitoring. These infrastructure requirements add operational overhead and security considerations that direct tool calls avoid."

4. **✓ Anthropic, "Introducing advanced tool use"** — `https://www.anthropic.com/engineering/advanced-tool-use`, "Published Nov 24, 2025". Per-server definition costs: "GitHub: 35 tools (~26K tokens), Slack: 11 tools (~21K tokens), Sentry: 5 tools (~3K tokens), Grafana: 5 tools (~3K tokens), Splunk: 2 tools (~2K tokens)". Programmatic Tool Calling: "Average usage dropped from 43,588 to 27,297 tokens, a 37% reduction on complex research tasks." Tool Use Examples: "improved accuracy from 72% to 90% on complex parameter handling."

5. **✓ Anthropic docs, "Tool search tool"** — `https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool`. "A typical multiserver setup (GitHub, Slack, Sentry, Grafana, and Splunk) can consume ~55k tokens in definitions before Claude does any work. Tool search typically reduces this by over 85 percent, loading only the 3–5 tools Claude needs." "Claude's ability to pick the right tool degrades once you exceed 30–50 available tools." Mechanics: `defer_loading: true`, max 10,000 deferred per request, "At least one tool … must stay non-deferred", regex and BM25 variants, MCP defers at `mcp_toolset` level not per tool, plus a documented custom/embedding search path. Optimization tips worth importing verbatim: "Use consistent namespacing in tool names: prefix by service or resource (for example, `github_`, `slack_`) so one search matches the whole group"; "Add a system prompt section describing available tool categories."

6. **✓ Anthropic, "Writing effective tools for agents — with agents"** — `https://www.anthropic.com/engineering/writing-tools-for-agents`, "Published Sep 11, 2025". The output-design rubric: consolidate by intent — "Instead of implementing a `read_logs` tool, consider implementing a `search_logs` tool which only returns relevant log lines and some surrounding context"; verbosity control — "a detailed tool response (206 tokens)" vs "a concise tool response (72 tokens)"; errors — "you can prompt-engineer your error responses to clearly communicate specific and actionable improvements, rather than opaque error codes or tracebacks"; identifiers — tools "should prioritize contextual relevance over flexibility, and eschew low-level technical identifiers (for example: `uuid`, `256px_image_url`, `mime_type`)".

7. **✓ ComposioHQ/`awesome-agent-clis`** — `https://github.com/ComposioHQ/awesome-agent-clis`. "A curated list of CLIs built for humans and AI agents." Its agent-readiness traits: structured output (`--json`), non-interactive mode (`--no-interactive`/`--yes`), API-key auth, **idempotency keys**, **piped output detection**, **meaningful exit codes**. And — notably for us — "Every CLI in this list has a **`SKILL.md`** file in its own folder," with an explicit three-stage progressive-disclosure model: "Metadata loading (~100 tokens)" → "Full instructions (<5k tokens): Loaded only when the agent determines the skill applies" → "Execution". An external community independently converged on CCv3's exact CLI+SKILL.md pattern.

8. **⚠ relayed — Cloudflare, "Code Mode: the better way to use MCP"** — `https://blog.cloudflare.com/code-mode/`, 2025-09-26. Converts an MCP server's schema into a generated TypeScript API and gives the agent one tool ("execute this TypeScript"), run in a V8 isolate. Oracle explicitly flagged that the widely-repeated "2,500 endpoints in ~1,000 tokens / 244x" figure was **not present** in the Sept 26 post it read and likely belongs to a different post — so I do **not** carry that figure. (The 2026-07-08 proposal attributed it to a Feb 2026 Cloudflare post; treat the attribution as unsettled.)

9. **⚠ relayed — MCP donated to the Agentic AI Foundation** — `https://blog.modelcontextprotocol.io/posts/2025-12-09-mcp-joins-agentic-ai-foundation/`, 2025-12-09; a Linux Foundation directed fund co-founded with Block and OpenAI, founding projects MCP, Goose, AGENTS.md. Search-confirmed only.

10. **⚠ relayed — "Bringing MCP 2026-07-28 to Claude"** — `https://claude.com/blog/bringing-mcp-2026-07-28-to-claude`, 2026-07-28: MCP "surpassed 400M monthly SDK downloads"; 950+ servers in Claude's connectors directory.

11. **⚠ relayed — Anthropic Agent Skills** — `https://claude.com/blog/skills`, 2025-10-16, updated 2025-12-18 to publish Agent Skills as an open standard.

**Negative result worth recording.** Oracle ran a dedicated sweep for the primary source of "32x fewer tokens" and could not find one: *"I could not find a single canonical source using exactly that number… I did not find an Anthropic, Cloudflare, Block, or Vercel primary source using '32x' verbatim."* It traced the family of claims to a widely-aggregated third-party benchmark reporting a **4–32x range**, whose original write-up it could not fetch. Two independent investigations — mine inside the repo, oracle's outside it — converge: the number has no verifiable provenance.

## 3. Gap analysis

**Ahead / validated — do not change.** The native-CLI-first ordering keeps being the frontier's answer, and the evidence got stronger, not weaker: Anthropic's own numbers show resident tool definitions are where the tokens go (source 4: 58 tools ≈ 55K tokens before work begins), and an external community list has independently converged on **CLI + `SKILL.md` + progressive disclosure** as the pattern (source 7) — which is precisely what `.claude/skills/<tool>/SKILL.md` + `rules/<tool>-safety.md` already is. We are not behind on strategy.

**Even.** We benefit from harness-level tool search (~220 deferred schemas this session) without having built it, and we still have no measurement of what that surface costs us. Unchanged from the prior pass.

**Behind — and this is where the pass belongs:**

- **(a) A whole documented integration pattern is non-functional.** Nine live skills fail at MCP-client init. This is not a doc-rot finding; it is a capability we advertise, teach, and route to that returns an error on first call. It is also the single highest-value item in the layer because the fix is small and the evidence is execution-grade.
- **(b) Our headline economic claim is unsourced and load-bearing.** Six citations, one circular self-reference, one real decision resting on it, zero primary sources — while three *properly sourced* figures (source 3's 98.7% single-example, source 4's 37%, source 5's 85%) are sitting there unused. The direction of the claim is almost certainly right; the number is not defensible.
- **(c) The Agent Compatibility Checklist is input-only and now provably incomplete.** It scores 10 input-side criteria and nothing about output shape. Source 6 supplies the missing output half; source 7 supplies three input criteria we lack outright (idempotency keys, piped-output/TTY detection, meaningful exit codes) and source 5 supplies a naming convention (service-prefixed namespacing) that directly improves discoverability under the tool search we already get for free. Measured against it, `cdp.mjs` passes on structure (JSON envelope, `--help` map, a partial concise/detailed toggle in `snapshot -i`) and fails on error design — `fail(e.message)` (`cdp.mjs:509`) forwards the raw exception, the opposite of source 6's guidance — and has no response cap.
- **(d) New exposure the prior pass could not have seen: we maintain our own MCP client against a spec that just broke.** `opc/` pins `mcp` 1.25.0 (`opc/uv.lock:1744-1745`) and MCP 2026-07-28 removed the `initialize` handshake and protocol-level sessions outright (source 2). Reviving pattern (a) means owning a client on a moving protocol. Conversely, the governance answer arrived too: the ≥12-month deprecation window and feature-lifecycle registry (source 2) are a direct, dated rebuttal to the "MCP servers have no desire to maintain API stability" argument the 2026-07-08 pass leaned on.
- **(e) Process, not component: proposals are not being absorbed.** 26 proposals exist in `docs/self-improvement/proposals/`. Exactly one — `2026-06-30-memory.md` — is referenced anywhere in `docs/system-update/BACKLOG.md` (as **SI-01**). The 2026-07-08 cli-integration pass produced five recommendations and left no trace in the backlog or in the files it targeted. Any recommendation below inherits a ~1-in-26 base rate unless it lands in the backlog.

## 4. Recommendations

**R1 — ADOPT (highest priority). Resolve the dead `uv run` MCP-harness substrate: revive it or retire it, but stop shipping it broken.**
Nine skills currently fail at init. Two honest options, and the choice should be made deliberately rather than by default:
- *Revive*: give the harness a config it actually reads. The clean shape is repo-root `mcp_config.json` holding the nine definitions, with the empty `.mcp.json` placeholder removed — because `mcp_client.py:376-381` prefers `.mcp.json` and hard-fails on it, while Claude Code itself does **not** read `mcp_config.json`. That gives the code-execution harness its servers *without* adding nine more resident MCP servers to every session — which is the CLI-first principle applied correctly rather than abandoned. Gate on R4.
- *Retire*: several of these have working non-MCP substrates already or overlap with live capability (`nia`, `github`, `ast-grep` is disabled and off PATH, `qlty` is off PATH). If the pattern is not worth a maintained MCP client, delete the nine skills' harness commands and say so in the inventory.
Either way the inventory's "Python harness via uv run" row is wrong today and must change.
*Rationale:* the only finding here backed by an actual failing execution, and the cheapest real capability restored per unit of effort.

**R2 — ADOPT (XS). Retire the unsourced "32x fewer tokens" law; replace with sourced figures.**
Delete or qualify all six occurrences. Replace with: (i) source 4's per-server definition costs (58 tools ≈ 55K tokens resident) as the *reason* CLI-first is right; (ii) source 5's "over 85 percent" tool-search reduction and the 30–50-tool accuracy cliff; (iii) source 3's 98.7% explicitly labelled as one worked example. Keep the `cdp.mjs`-vs-`chrome-devtools-mcp` "32x" claim **only** where it belongs — as a claim about that one comparison, in `browser-dev-cycle/SKILL.md` — and stop generalising it. *Rationale:* a decision-driving claim (it justified disabling the `qlty` MCP server) that two independent searches could not source is exactly what `claim-verification.md` calls an S1.

**R3 — ADOPT (S). Extend the Agent Compatibility Checklist: output ergonomics + the three missing input criteria + naming.**
Add an output section from source 6 (configurable verbosity; errors that teach the correct invocation; high-signal identifiers over `uuid`/`mime_type`; response caps and pagination), the three input criteria from source 7 (idempotency keys, piped-output/TTY detection, meaningful exit codes), and source 5's namespacing tip (service-prefixed tool/subcommand names so one search matches the group). Make it the authoring convention for any new Pattern-5 wrapper and apply the error half to `cdp.mjs:509`. *Rationale:* doc-and-convention cost, closes a proven blind spot, and every criterion is quote-verified to a primary source.

**R4 — ADOPT as a gate, not a project. Version-pin discipline for our own MCP client.**
Before R1's *revive* branch, record which MCP protocol revision `mcp` 1.25.0 speaks and whether our servers still work under a spec that removed the `initialize` handshake. Fold this into the existing `harness-update` rule's registry (it already governs Codex/Grok CLI + model drift) rather than inventing a new mechanism — MCP is now just another external harness whose version can move under us. *Rationale:* reviving a client without knowing its protocol footing is how (a) happened.

**R5 — ADOPT (XS). Record the per-platform substrate decision, and fix four dead `mcp__` references.**
Add a one-line "substrate of record" column to the inventory (CLI / MCP / both-and-why), now answerable from the dependency map in §1(d). Separately, `mcp__playwriter__` in live hook source `browser-learning-extractor.ts` names a server that does not exist (`playwright` does) — a one-word fix; `mcp__jira__`, `mcp__memory__`, `mcp__sumologic__` are in archived skills and should be swept with them. *Rationale:* answers the recurring "we have both, which do I use?" and removes references that will silently no-op.

**R6 — SKIP. Rewriting the decision tree.** The six-option ordering is validated by every 2025-11→2026-07 primary source and by an external community list converging on our exact CLI+SKILL.md shape. No change. *We are genuinely strong here — the strategy was never the problem.*

**R7 — WATCH. MCP 2026-07-28 as an ecosystem signal, not a task.** Statelessness, cacheable list results, deterministic `tools/list` ordering for prompt-cache hits, and a formal 12-month deprecation policy all reduce the historical case against MCP. Nothing to build; revisit the tier ordering only if a platform we care about ships MCP-only capability.

**R8 — process, for whoever runs this loop.** Land R1/R2 as backlog items (they are concrete and small) rather than leaving them in a proposal. 25 of 26 prior proposals have no backlog trace; SI-01 is the one that does, and it is the one that got worked.

## 5. Integration approach

| Rec | Files touched | BACKLOG tie | Effort | Risk |
|-----|---------------|-------------|--------|------|
| **R1** | `.mcp.json` (remove placeholder), new repo-root `mcp_config.json` **or** deletion of harness commands in 9 `SKILL.md`s; `cli-integration/SKILL.md` inventory row | **SG-02** (3-way settings/template drift — nine server defs in a key no consumer reads is a textbook instance), **SG-03** (pruning, if the retire branch wins) | **S** (revive: one config file + one probe) / **M** (retire: 9 skill edits) | **Med.** Populating repo `.mcp.json` instead would make Claude Code load nine more servers into every session — the opposite of the CLI-first principle. Use `mcp_config.json`. Removing `.mcp.json` changes project-scope MCP resolution for Claude Code too; verify a session starts clean afterwards. Gate on R4. |
| **R2** | `cli-integration/SKILL.md:36,65`; `docs/tool-tier-policy.md:67,93,120,157` | claim-verification / **SG-03** | **XS** | **Low.** Watch for a decision that silently depended on the number — `tool-tier-policy.md:157` (qlty MCP disabled) is the known one; the CLI is off PATH anyway, so revisit that row with R5. |
| **R3** | `cli-integration/SKILL.md` (checklist section); `scripts/cdp.mjs:509` (error text) | — | **S** | **Low** (doc + one error string). |
| **R4** | `.claude/rules-src/harness-update.md` (add an MCP row to the version registry) | ties to the existing harness-update discipline | **XS** | **Low.** Risk is omission, not action. |
| **R5** | `cli-integration/SKILL.md` (inventory column); `.claude/hooks/src/browser-learning-extractor.ts` (one identifier) | **SG-03** | **XS–S** | **Low.** The hook edit is a TS file — rebuild `dist` and run the emit-invariant audit per `hook-dev-lifecycle`. |
| R6/R7 | none | — | — | — |
| **R8** | `docs/system-update/BACKLOG.md` (add R1/R2 as items) | mirrors how **SI-01** absorbed the 2026-06-30 memory proposal | **XS** | Low. |

**Sequencing.** R2, R3, R5 are independent doc/string edits — do them in any order, they need no gate. R4 before R1. R1's branch decision (revive vs retire) is the only judgment call and deserves its own short `/plan`; do not let it default to "leave it broken," which is the current state.

**What could go wrong.** The dominant failure mode is R1 fixing config in the *convenient* place rather than the correct one: dropping the nine servers into repo `.mcp.json` makes the harness work and quietly adds nine resident MCP servers to every Claude Code session in this repo — a token regression justified by a token-savings rule. The second is scope creep: R1's retire branch touches nine skills and will want to become a pruning project; keep it to the harness command lines. Third, R2 is a deletion of a number several documents lean on — check each occurrence for a decision hanging off it before removing, don't sweep with `sed`.

## 6. Benefits

- **A real capability comes back, or an honest one replaces it.** Today, nine advertised skills return `Failed to initialize MCP client` on first use. Whichever branch of R1 is taken, the harness stops lying about what it can do — which is the difference between "the tool is slow" and "the tool routes you into a dead end and you find out mid-task."
- **Decisions stop resting on a number nobody can source.** R2 swaps one unverifiable "32x" for three quote-verified figures. The CLI-first conclusion survives intact — it just becomes defensible, and the one decision made on the old number (`qlty` MCP disabled) gets re-examined on its merits.
- **Fewer retry loops on our own wrappers.** R3's error-design half means `cdp.mjs` and future Pattern-5 wrappers tell the model how to call them correctly instead of forwarding a raw exception, which is the difference between a self-correction and a loop.
- **A named answer to a recurring friction.** "We have both a CLI and an MCP for X — which?" becomes a recorded column (R5) instead of a per-session guess.
- **One fewer silent-drift class.** R4 puts MCP under the same version-pin discipline as Codex and Grok, so the next protocol break is a gate rather than a surprise.

## 7. Open questions

1. **Revive or retire?** Which of the nine harness-backed capabilities does Dave actually want (`morph` fast-apply and `firecrawl` look highest-value; `ast-grep` and `qlty` are off PATH and one is already `disabled: true`)? This is a preference call, not a technical one, and it decides R1's branch.
2. **How long has the harness been dead?** The `.mcp.json` placeholder is dated 22 Feb. I did not establish when the nine definitions moved into `settings.json`, or whether the pattern ever worked on this machine. `git log -- .mcp.json` would settle it (blocked by a permission gate in this headless run).
3. **Which MCP protocol revision does `mcp` 1.25.0 speak,** and do stdio servers still initialize under a spec that removed the handshake? Unverified — the R4 gate exists precisely because I could not answer this without running the harness.
4. **What does the connected-MCP surface actually cost at session start** under harness deferral? Still unmeasured — carried forward unchanged from the 2026-07-08 pass, and still the precondition for any pruning claim.
5. **Should the Agent Compatibility Checklist become machine-checkable?** With source 7's trait list and source 6's output rubric it is now concrete enough to lint. Also carried forward — but the honest answer may be that we add a CLI too rarely for a linter to pay for itself.
