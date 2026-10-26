# Intent: CCV3-CR-INSTALL (DW-91 / Phase 2)

Slug: `ccv3-cr-install` · Repo: `Rev4nchist/Continuous-Claude-v3` · Base: `main` @ `718012f0` (Phase 1 #154 merge; tip as of 2026-10-25 ~8:11 PM CT)
Card: https://app.notion.com/p/40376fd7ac8281aab41cee81ce5dcff9 · Order 60.4125 · Status: **Ready** (Dave B via PM 2026-10-25 ~8:28 PM CT — composer-2.5)
Source: Wiring Plan Phase 2 / PLAN-SECURITY v3 §3–§4 / David 1A–7A + 8–9 (2026-10-24)

## Why
CodeRabbit must return as the normal-tier ready-PR bot (label-gated), with CLI advisory only (≤2 runs) and PR-bot reviews counting toward READY alongside Greptile. App/seat gate cleared (READY-FOR-DW-91=YES); still needs Dave `cr auth login` + usage Off before build.

## What (one PR)
1. Root `.coderabbit.yaml`: label-gated (`review:coderabbit` / `review:deep`), `auto_incremental_review: false`, MCP usage disabled.
2. Rule `.claude/rules-ondemand/coderabbit-cli.md` (+ manifest): advisory CLI/plugin; ≤2 runs; no installs; ban autofix skill; never counts toward READY.
3. PreToolUse guard `coderabbit-guard.ts` (+ dist + vitest): block --use-credits / --api-key / code new|push / autofix skill; allow read-only autofix subagent and plain `cr review --agent`; 3rd-run block per PR.
4. `review-status.mjs`: count CodeRabbit **PR-bot** review on head toward READY; ignore CLI/plugin; Greptile-only unchanged.
5. Docs + hook text: after Phase 1, hook is `pr-opened-review-loop` (not the old coderabbit-loop name). Describe both PR bots by label; CLI/plugin advisory only.

## Done when
- AC1–AC13 on the card pass (App/billing, keys, cr doctor, yaml, rule content tests, guard tests, run cap, READY gate, docs/hook, Linux + Windows verify, Gate 17 + cross-family xreview).
- Builder pin (this build): `composer-2.5` (Dave waive ~8:28 PM CT; fable/opus unavailable under on-demand OFF). Independent reviewer: `grok-4.7` High as Cursor CA.
- Human merge; push origin Rev4nchist only; never parcadei; no force-push.

## Out of scope
DW-80 / Phase 3 (router, Greptile-at-ready, scanner CI). MCP context. `--use-credits` / usage billing. Minions config. Agents reading or minting API keys. review-status.mjs false-negative (summary-in-comment) follow-up — don't invent unless asked.

## Hold
Ready only after Dave says go (post-land ROG settings one-liner for Phase 1, then Phase 2). DevBot CA held until Ready.

## Pin waive (2026-10-25 ~8:22 / ~8:28 PM CT)
- ~8:22: AC13 fable pin waived; tried `claude-opus-5-5` (1m medium fast false) — CA refused (Anthropic included pool empty / on-demand OFF).
- ~8:28 Dave via PM: keep on-demand OFF; **builder pin waived → `composer-2.5` this once**. Independent reviewer: `grok-4.7` High Cursor CA (must differ from builder family — not composer reviewing composer). Greptile ON.
