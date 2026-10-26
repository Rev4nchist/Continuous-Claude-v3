# Review router v1: spec (DRAFT, Code, 2026-10-26)

Status: **Adopted by Dave 2026-10-26** (decision page items A1–A5, B1–B12, C1–C6, all agreed): the §8
answers are the recommended ones on that page (C1 R3 = database paths, R4 = steering + infra; C2
review:deep; C3 manual; C4 DW-85 owns the box mirror; C5 no non-path signal in v1; C6 skip-list in
P3b). Still **DRAFT for reconciliation** with the box spec. Claude Code wrote this on ROG from the sources below because the
Dev PM router spec on the box is not readable from ROG. Grok (Dev PM) compares it with the box spec
after 2026-10-29 and lists every difference. Where they differ, the box spec wins unless Dave decides
otherwise. Dave approved router v1 on 2026-10-26 with the label names `review:coderabbit` and
`review:deep`.

Sources:
- Wiring Plan 2026-10-25, §3 step 6, §5 Phase 3, §6.2, §6.3, §8 D3:
  https://app.notion.com/p/40476fd7ac8281a788dbd28b645b6446
- DW-80 card Acceptance (1)–(9) and Notes: https://app.notion.com/p/40276fd7ac8281d2b9eff402095880c3
- Live repo at `main` 1db5a6c7: `.coderabbit.yaml`, `.greptile/config.json`, `scripts/github/review-status.mjs`.
- Not readable from ROG (box): EVAL.md §4 and §6.3, PLAN-SECURITY v3 §3 (R-tier definitions), the PM router spec.

## 1. Job

When a PR becomes ready for review, the router decides which PR bots review it and adds their
labels. It spends no LLM credits. It never reviews code, never merges, and never removes a label
that a person added.

## 2. When it runs

| Event | Router action |
|---|---|
| PR opened as draft | Nothing. No bot label, no bot review (G-R1). |
| PR opened as ready, or `ready_for_review` | Classify, add `risk:*` and the review label(s). |
| Push to a ready PR (`synchronize`) | Re-classify. Add labels only if the risk class goes UP. Never remove. No new review starts (G-R3). |
| PR converted back to draft | Nothing. Labels stay. |
| A person adds or removes `review:*` or `risk:*` | The person wins. The router writes a ledger row and does not undo it. |

Runner: a GitHub Actions workflow on `pull_request` types `opened`, `ready_for_review`,
`synchronize`, with `permissions: pull-requests: write` and the same pinning rules as
`ccv3-checks.yml`. The router script is `scripts/github/review-router.mjs`, which uses Node builtins
and the GitHub REST API only. It must also run locally (`node scripts/github/review-router.mjs <PR> --dry-run`).

## 3. Risk classes

The classifier reads the PR's changed file paths. Each path gets a class. The PR class is the
highest class of any path. Order, highest first:

| Class | Label | CCv3 paths (globs, from `review-router.config.json`) | Why |
|---|---|---|---|
| R3 data | `risk:high` + `risk:r3` | `**/*.sql`, `**/drizzle/**`, `**/migrations/**`, any path with `rls`, `policy`, `tenant` in a SQL or schema file | RLS and tenant scoping (DW-80 Notes, PLAN-SECURITY §10). Few hits in CCv3 today; the list is shared with Minions. |
| infra | `risk:infra` | `.github/**`, `.githooks/**`, `.claude/settings.json.template`, `scripts/sync-to-active*`, `scripts/github/**`, `scripts/git-safe.ps1`, `.greptile/**`, `.coderabbit.yaml`, `**/Dockerfile*`, `.claude/docker/**` | CI, merge gate, sync and review config. A mistake here weakens every later gate. |
| steering | `risk:steering` | `.claude/hooks/src/**`, `.claude/rules-src/**`, `.claude/rules-ondemand/**`, `.claude/agents/**`, `.claude/skills/**` (not `_vendor` byte copies), `CLAUDE.md`, `AGENTS.md`, `CONTEXT.md`, `.claude/commands-src/**` | These files steer every Claude Code session. |
| high | `risk:high` | Not path-based in v1. A person adds it, or a later classifier does. | Wiring Plan §3 step 6. |
| normal | `risk:normal` | Any path not matched above or below. | Default. |
| docs | `risk:docs` | `docs/**`, `thoughts/**`, `artifacts/**`, `archive/**`, `*.md` not matched above | No runtime effect. |

A PR with only `docs` paths is `risk:docs`. Lock files and `dist/` alone do not raise the class above
`normal`.

## 4. Routing

| PR class | Review labels added | Bots that must review the head for READY |
|---|---|---|
| docs | none | none |
| normal | `review:coderabbit` | CodeRabbit |
| steering, infra, high | `review:deep` | CodeRabbit and Greptile (confidence ≥ 4/5) |
| R3 | `review:deep` | CodeRabbit and Greptile (Wiring Plan §6.3 item 3: both for R3 paths) |

`.coderabbit.yaml` already reviews on both labels (`auto_review.labels`), with drafts off. Greptile
needs a label trigger. That is the P3b config change (`autoReview` from `["open","push"]` to label
`review:deep`), held until the Apex billing cause is known (D3).

### 4.1 Gate while Apex is unresolved

`review-router.config.json` has `"deep_enabled": false` until Dave clears the Apex billing cause
(DW-83). While it is false:
- A steering, infra, high or R3 PR gets `review:coderabbit` plus `review:deep-held`. It does not get `review:deep`.
- The router posts one PR comment: "High-risk PR. Greptile deep review is held (Apex billing, D3).
  Dave decides: wait, or land on CodeRabbit + xreview." 
- READY treats `review:deep-held` as "CodeRabbit only" and prints that reason.

### 4.2 Credit thresholds (DW-80 Acceptance (8))

Config values, read from the ledger's Greptile credit count for the current period:

| Key | Value | Router behaviour |
|---|---|---|
| `greptile.period_start` | 2026-10-24 | Free plan, 50 credits a month, renews 2026-11-24. |
| `greptile.u1_used` | 35 | At ≥ 35 used: post a warning on each `review:deep` PR and ping Dave once. |
| `greptile.u2_used` | 45 | At ≥ 45 used: only R3 PRs get `review:deep`. Others get `review:coderabbit` + `review:deep-held`. |
| `greptile.u3_date` | 2026-11-03 | On or after this date: one credit-check alert to Dave. |
| `greptile.u4_trigger` | first Minions rebuild PR | Credit check before it. Manual in v1. |

`review:deep` bills Greptile **Plus (3 credits)**, never Apex (10) (G-R7). The tier rule lives in the
Greptile dashboard (Dave adds it). The router does not set the tier.

### 4.3 CodeRabbit unavailable (R7 spill-over)

If CodeRabbit posts a rate-limit or "review limit reached" notice on the head, READY reports LIMITED
(live since #155). v1 does not reroute to Greptile automatically. It posts one comment for Dave.
Rerouting is an open question (§8).

## 5. Final-head review

Bots review once at ready. Fix pushes do not start a new review (`auto_incremental_review: false`,
Greptile label trigger). After the fix rounds, the agent posts one explicit request per routed bot
for the final head: `@coderabbitai review`, then `@greptileai` on `review:deep` PRs. READY needs each
routed bot's review on that exact head (G-R4).

## 6. Builder family

`builder:claude` or `builder:grok` records who built the PR. The router copies it into the ledger
row. It does not affect PR-bot routing. It matters for the xreview CA (P5): a same-family reviewer
is blocked (T2). v1 only checks that exactly one `builder:*` label exists at ready, and comments if
none does.

## 7. Ledger

Every router decision writes one JSON line: `ts`, `pr`, `head`, `event`, `class`, `paths_matched`
(per class, counts), `labels_added`, `held_reason`, `builder`. Tool type `router` (DW-80
Acceptance (9)). v1 writes to `artifacts/review-ledger/<YYYY-MM>.jsonl` through the workflow's job
summary and an uploaded artifact. The box ledger mirror is P3c scope only if DW-85 does not own it
(open question §8).

## 8. Open questions for box reconciliation

1. R-tier mapping: which PLAN v3 R-tiers (R3, R4, R5, R6, R7) map to `steering` and `infra`?
   This draft maps R3 by path only and treats R4 as `high`.
2. Does the PM spec label Greptile with `review:greptile` (Wiring Plan G-R2) or `review:deep`?
   Dave chose `review:deep` on 2026-10-26; G-R2 needs an edit.
3. Base-tier Greptile "only on R5/R7 spill-over" (DW-80 (7)): is that a v1 router job or manual?
4. Who owns the box ledger mirror: DW-80 or DW-85?
5. Does the classifier add any non-path signal in v1, such as diff size or a secrets-adjacent file?
6. Shared skip-list (DW-80 (2)): `.greptile/files.json` → `REVIEW.md`. Is it P3b or P3c?

## 9. Tests (T2, before merge)

Fixture tests with recorded GitHub payloads. No live bot spend:

| ID | Input | Expected |
|---|---|---|
| R-1 | Draft PR, any paths | No labels (G-R1) |
| R-2 | Ready PR, `docs/x.md` only | `risk:docs`, no review label |
| R-3 | Ready PR, `scripts/foo.mjs` | `risk:normal`, `review:coderabbit` |
| R-4 | Ready PR, `.claude/rules-src/x.md` + `docs/y.md` | `risk:steering`, deep or deep-held per config |
| R-5 | Ready PR, `apps/agentic-os/drizzle/0004.sql` | `risk:r3`, `review:deep` even at u2 |
| R-6 | Push lowers the class | No label removed |
| R-7 | A person removed `review:deep` | Router does not re-add it; ledger row says `person_override` |
| R-8 | `deep_enabled: false` | `review:coderabbit` + `review:deep-held` + one comment, not two on re-run |
| R-9 | Ledger | One row per event, valid JSON |

Live T2 runs on `greymatter-sec-sandbox` spend credits. They need Dave's yes and stay blocked until
the Apex cause is known.
