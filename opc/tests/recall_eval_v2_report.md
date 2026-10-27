# Recall eval v2 report

## Run metadata

- ran_at: 2026-10-27T10:31:48-05:00
- eval_set: tests/recall_eval_set_v2.jsonl
- eval_set_sha256: 3f84d599edd82283651c38755756d688fc3bf9657ed1276bfd131f7da54f0d17
- scope: hook
- project_id: b09dfcecfaf609fb
- embed_daemon: ready
- arms: ['hybrid', 'text']
- live_rows: 130
- n_pairs: 48
- hit_definition: a query is a hit when any relevant id is in the kept top 3 after the floor
- token_note: tokens = ceil(chars/4) of the MEMORY MATCH text; the constant wrapMemoryContext wrapper and sanitising are left out; the '(stored DATE; may be stale)' suffix is left out because the hook does not emit it today (mergeResults drops storedDate)
- query_source: real hook functions via .claude/hooks/scripts/hook-query-terms.mjs (deriveRecallIntent + cleanSearchTerm); session-focus terms are not added
- latency_note: uv subprocess, hook fallback path

## Reachability

- Answerable queries: 38
- Reachable in this scope: 28
- Unreachable (no relevant row reachable): 10
- Partly reachable: 8
- Live rows unreachable in this scope: 57

Unreachable queries:
- Direct Lake refresh says tables do not exist or access was denied right after the Spark notebook ran
- new tenant says no Fabric trial for our account, what do we run instead and what does it cost
- someone with only Viewer on the workspace can still read the restricted tiers through the SQL endpoint
- is there a tenant switch that lets Fabric reports be opened by anyone with the link
- SOQL lookup on an account name with an apostrophe returns a parse error, is the proxy broken
- MCP clients cannot follow the login redirect from our container app, what should Easy Auth return
- Minions Postgres 40P01 deadlock when locking several rooms
- a real-model web spec keeps failing, one LLM host answers with the wrong intent, how do I stabilise it
- what tier leaks can happen in the Fabric Company Brain and how do I close them
- I need to change how Minions bots claim work across rooms: how should I design it and what must never leak

Partly reachable queries:
- Fabric capacity throttled what now
- the builder agent kept hammering the F2 for hours after rejections, how long should we wait before giving up
- scheduled Fabric notebook fails with AADSTS50076, how do I run it unattended
- why is salesforce-mcp a FastMCP proxy and not direct REST calls to Salesforce
- our E2B dev sandbox reached github.com even though we never allowed it
- I am starting a new Fourth MCP connector on Azure: how do I handle auth, user identity and secrets
- plan a Fabric pilot: how big a capacity, and what must stay off the critical path
- set up an isolated dev sandbox for bots: container flags, egress rules and provider choice

## Arm: hybrid

Summary at floor 0.03275:

- ndcg_at_5: 0.579
- recall_at_3: 0.548
- hit_rate_at_floor: 0.553
- hit_rate_reachable: 0.750
- none_precision: 0.900
- p50_ms: 903.439
- p95_ms: 1024.611
- mean_tokens_all: 35.750
- mean_tokens_injected: 68.640
- n_answerable: 38
- n_reachable: 28
- n_partial: 8
- n_none: 10
- n_errors: 0
- latency: uv subprocess, hook fallback path

### Sweep: hybrid

Errored calls in this arm: 0 (errored queries are left out).

| floor | hit_rate_reachable | false_injection_rate | mean_tokens | chosen |
|---|---|---|---|---|
| 0.01 | 0.964 | 1.000 | 148.90 |  |
| 0.0105 | 0.964 | 1.000 | 148.90 |  |
| 0.011 | 0.964 | 1.000 | 148.90 |  |
| 0.0115 | 0.964 | 1.000 | 148.90 |  |
| 0.012 | 0.964 | 1.000 | 148.90 |  |
| 0.0125 | 0.964 | 1.000 | 148.90 |  |
| 0.013 | 0.964 | 1.000 | 148.90 |  |
| 0.0135 | 0.964 | 1.000 | 148.90 |  |
| 0.014 | 0.964 | 1.000 | 148.90 |  |
| 0.0145 | 0.964 | 1.000 | 148.90 |  |
| 0.015 | 0.964 | 1.000 | 148.90 |  |
| 0.0155 | 0.964 | 1.000 | 148.90 |  |
| 0.016 | 0.964 | 1.000 | 144.69 |  |
| 0.01639 | 0.964 | 1.000 | 139.69 |  |
| 0.0164 | 0.929 | 0.600 | 128.65 |  |
| 0.0165 | 0.929 | 0.600 | 128.65 |  |
| 0.017 | 0.929 | 0.600 | 128.65 |  |
| 0.0175 | 0.929 | 0.600 | 128.65 |  |
| 0.018 | 0.929 | 0.600 | 128.65 |  |
| 0.0185 | 0.929 | 0.600 | 128.65 |  |
| 0.019 | 0.929 | 0.600 | 128.65 |  |
| 0.0195 | 0.929 | 0.600 | 128.65 |  |
| 0.02 | 0.929 | 0.600 | 128.65 |  |
| 0.0205 | 0.929 | 0.600 | 128.65 |  |
| 0.021 | 0.929 | 0.600 | 128.65 |  |
| 0.0215 | 0.929 | 0.600 | 128.65 |  |
| 0.022 | 0.929 | 0.600 | 128.65 |  |
| 0.0225 | 0.929 | 0.600 | 128.65 |  |
| 0.023 | 0.929 | 0.600 | 128.65 |  |
| 0.0235 | 0.929 | 0.600 | 128.65 |  |
| 0.024 | 0.929 | 0.600 | 128.65 |  |
| 0.0245 | 0.929 | 0.600 | 128.65 |  |
| 0.025 | 0.929 | 0.600 | 128.65 |  |
| 0.0255 | 0.929 | 0.600 | 128.65 |  |
| 0.026 | 0.929 | 0.600 | 128.65 |  |
| 0.0265 | 0.929 | 0.600 | 128.65 |  |
| 0.027 | 0.929 | 0.600 | 128.65 |  |
| 0.0275 | 0.929 | 0.600 | 127.79 |  |
| 0.028 | 0.929 | 0.600 | 126.94 |  |
| 0.0285 | 0.929 | 0.600 | 123.73 |  |
| 0.029 | 0.929 | 0.600 | 121.31 |  |
| 0.0295 | 0.929 | 0.600 | 119.65 |  |
| 0.03 | 0.929 | 0.600 | 112.98 |  |
| 0.0305 | 0.929 | 0.600 | 106.40 |  |
| 0.031 | 0.893 | 0.600 | 97.52 |  |
| 0.0315 | 0.821 | 0.500 | 77.81 |  |
| 0.032 | 0.786 | 0.500 | 65.40 |  |
| 0.0325 | 0.786 | 0.300 | 47.31 |  |
| 0.03275 | 0.750 | 0.100 | 35.75 | **<- chosen** |
| 0.033 | 0.000 | 0.000 | 0.00 |  |

## Arm: text

Summary at floor 0.0225:

- ndcg_at_5: 0.570
- recall_at_3: 0.522
- hit_rate_at_floor: 0.553
- hit_rate_reachable: 0.750
- none_precision: 0.900
- p50_ms: 590.649
- p95_ms: 719.591
- mean_tokens_all: 54.625
- mean_tokens_injected: 97.111
- n_answerable: 38
- n_reachable: 28
- n_partial: 8
- n_none: 10
- n_errors: 0
- latency: uv subprocess, hook fallback path

### Sweep: text

Errored calls in this arm: 0 (errored queries are left out).

| floor | hit_rate_reachable | false_injection_rate | mean_tokens | chosen |
|---|---|---|---|---|
| 0.0 | 0.964 | 0.900 | 145.83 |  |
| 0.0025 | 0.964 | 0.900 | 145.83 |  |
| 0.005 | 0.964 | 0.900 | 145.83 |  |
| 0.0075 | 0.964 | 0.900 | 143.31 |  |
| 0.01 | 0.964 | 0.900 | 138.27 |  |
| 0.0125 | 0.964 | 0.600 | 112.42 |  |
| 0.015 | 0.929 | 0.600 | 99.19 |  |
| 0.0175 | 0.893 | 0.400 | 80.75 |  |
| 0.02 | 0.857 | 0.300 | 71.19 |  |
| 0.0225 | 0.750 | 0.100 | 54.62 | **<- chosen** |
| 0.025 | 0.643 | 0.100 | 42.94 |  |
| 0.0275 | 0.607 | 0.000 | 34.40 |  |
| 0.03 | 0.607 | 0.000 | 34.40 |  |
| 0.0325 | 0.607 | 0.000 | 32.73 |  |
| 0.035 | 0.536 | 0.000 | 25.08 |  |
| 0.0375 | 0.536 | 0.000 | 24.23 |  |
| 0.04 | 0.393 | 0.000 | 17.42 |  |
| 0.0425 | 0.357 | 0.000 | 14.96 |  |
| 0.045 | 0.321 | 0.000 | 13.42 |  |
| 0.0475 | 0.286 | 0.000 | 11.12 |  |
| 0.05 | 0.214 | 0.000 | 8.21 |  |
| 0.0525 | 0.179 | 0.000 | 6.83 |  |
| 0.055 | 0.071 | 0.000 | 2.83 |  |
| 0.0575 | 0.036 | 0.000 | 1.42 |  |
| 0.06 | 0.036 | 0.000 | 1.42 |  |
| 0.0625 | 0.000 | 0.000 | 0.00 |  |
| 0.065 | 0.000 | 0.000 | 0.00 |  |
| 0.0675 | 0.000 | 0.000 | 0.00 |  |
| 0.07 | 0.000 | 0.000 | 0.00 |  |
| 0.0725 | 0.000 | 0.000 | 0.00 |  |
| 0.075 | 0.000 | 0.000 | 0.00 |  |
| 0.0775 | 0.000 | 0.000 | 0.00 |  |
| 0.08 | 0.000 | 0.000 | 0.00 |  |
| 0.0825 | 0.000 | 0.000 | 0.00 |  |
| 0.085 | 0.000 | 0.000 | 0.00 |  |
| 0.0875 | 0.000 | 0.000 | 0.00 |  |
| 0.09 | 0.000 | 0.000 | 0.00 |  |
| 0.0925 | 0.000 | 0.000 | 0.00 |  |
| 0.095 | 0.000 | 0.000 | 0.00 |  |
| 0.0975 | 0.000 | 0.000 | 0.00 |  |
| 0.1 | 0.000 | 0.000 | 0.00 |  |

## Constraint status

- hybrid: false-injection limit 0.20 met; chosen floor 0.03275
- text: false-injection limit 0.20 met; chosen floor 0.0225

## Errors

- none
