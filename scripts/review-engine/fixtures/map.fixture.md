# Fixture map

A small map for the review-engine script tests. Every id starts with `fx-`.

## Waves

| Wave | Lane | Phase | Depends on | Needs Dave | Change | Held until |
|---|---|---|---|---|---|---|
| 0 | `fx-base` | GATE | none |  | new |  |
| 0 | `fx-keys` | P3 | none |  | changed |  |
| 1 | `fx-mid` | P3 | fx-base, fx-ext |  | changed | dave-yes |
| 1 | `fx-gate-a` | GATE | fx-keys | yes | new | DP2.4 |
| 1 | `fx-gate-b` | GATE | fx-keys | yes | new | first-flip |
| 2 | `fx-top` | P4 | fx-mid, fx-gate-a |  | unchanged | fx-gate-b; fx-base if DP2.4 = yes |
| 2 | `fx-holder` | P7 | fx-mid |  | deferred | item-trigger |

## Dropped or merged lanes

| Lane | What happened | Where its work went |
|---|---|---|
| `fx-gone` | Dropped (X1) | Nowhere. |

Split or moved work (no lane is dropped by these rows):

| Lane | What happened | Where its work went |
|---|---|---|
| `fx-mid` PR B | Split out | New lane `fx-new`. |

## Shared contracts (one owner each)

- **Config contract.** Owner `fx-keys` (fixture/config.json). Later owners add their own key.
- **Owner chains.** Each chain is serialized by dependency.
  - tool.mjs: `fx-base`, `fx-mid`. fixture/config.json: `fx-keys`, `fx-gate-a`, `fx-gate-b`.

## Lanes

### fx-base

**Base tool: builds the fixture tool** (wave 0, phase GATE, new)

- Depends on: none
- Unblocks: fx-mid
- Related: none
- Owns: `fixture/tool.mjs`, `fixture/tool.test.mjs` (new)
- Do not touch: `fixture/config.json`
- Cost (T04): 0 runs
- Needs Dave: no

Scope:
- Build the tool.

Done when: The tool test passes.

Why: Every other lane needs the tool.

### fx-keys

**Keys: owns the config file first** (wave 0, phase P3, changed)

- Depends on: none
- Unblocks: fx-gate-a, fx-gate-b
- Related: none
- Owns: `fixture/config.json`
- Do not touch: `fixture/tool.mjs`
- Cost: 0 runs
- Needs Dave: no

Scope: Add the first keys to the config file.

Done when: The config test passes.

Why: The gates need the config file.

### fx-mid

**Mid: fixes the tool** (wave 1, phase P3, changed)

- Depends on: fx-base, fx-ext
- Unblocks: fx-top, fx-holder
- Related: fx-base
- Owns: `fixture/tool.mjs` (fixes only)
- Do not touch: `fixture/config.json`
- Cost: 0 runs
- Needs Dave: no
- The cut. Dave decided it: the cut stays.

Scope:
- Fix the tool.
- Owns: decoy
- Decoyfield: x

Done when: The fixed tool test passes.

Why: The tool has a known fault.

### fx-gate-a

**Gate A: flips the first gate key** (wave 1, phase GATE, new)

- Depends on: fx-keys
- Unblocks: fx-top
- Related: fx-gate-b
- Owns: `fixture/config.json` (the gate_a key only)
- Do not touch: `fixture/tool.mjs`
- Cost: 0 runs
- Needs Dave: yes, the flip tap

Scope: Flip the gate_a key.

Done when: The gate_a test passes.

Why: Gate A is the first flip.

### fx-gate-b

**Gate B: flips the second gate key** (wave 1, phase GATE, new)

- Depends on: fx-keys
- Unblocks: fx-top
- Related: fx-gate-a
- Owns: `fixture/config.json` (the gate_b key only)
- Do not touch: `fixture/tool.mjs`
- Cost: 0 runs
- Needs Dave: yes, the flip tap

Scope: Flip the gate_b key.

Done when: The gate_b test passes.

Why: Gate B is the second flip.

### fx-top

**Top lane: ties it together** (wave 2, phase P4)

- Depends on: fx-mid, fx-gate-a
- Unblocks: none
- Related: fx-mid
- Owns: `fixture/out/**` and `.claudedocs/fx-results.md` (new)
- Do not touch: `fixture/config.json`
- Cost: 0 runs
- Needs Dave: no

Scope: Write the results.

Done when: The results file exists.

Why: It shows the result.

### fx-holder

**Holder: waits for a trigger** (wave 2, phase P7, deferred)

- Depends on: fx-mid
- Unblocks: none
- Related: none
- Owns: none
- Do not touch: `fixture/tool.mjs`
- Cost: 0 runs
- Needs Dave: no

Scope: Nothing yet.

Done when: The trigger fires and the lane is rewritten.

Why: A deferred lane has a section too.

## External lanes

One lane is not a `fx-` row.

### fx-ext

**External: a lane with no Waves row** (counts as wave 0, external; card state `blocked`)

- Depends on: none
- Unblocks: fx-mid
- Related: none
- Owns: `fixture/ext*.mjs` and its test (card scope)
- Do not touch: `fixture/tool.mjs`
- Cost: 0 runs
- Needs Dave: no

Scope (from the card): Run the external check.

Done when: The external test passes.

Why it is on the path: It gates fx-mid.
## Not covered / risks

- Owns: leaked
Why: leaked-why
Scope (leaked): leaked-scope
