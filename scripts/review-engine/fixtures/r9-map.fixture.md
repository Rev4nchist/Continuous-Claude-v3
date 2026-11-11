# R9 dummy map

A small map for the database verb tests and the scratch-database probe (program-probe.mjs). It has the six dummy lanes
`re-dummy-1` to `re-dummy-6` and one external lane. Nothing here is a real lane. It must pass `check --table`.

## Waves

| Wave | Lane | Phase | Depends on | Needs Dave | Change | Held until |
|---|---|---|---|---|---|---|
| 0 | `re-dummy-1` | P1 | none |  | new |  |
| 0 | `re-dummy-4` | P2 | none |  | new |  |
| 0 | `re-dummy-5` | P2 | none |  | new |  |
| 1 | `re-dummy-2` | P3 | re-dummy-1 |  | new |  |
| 1 | `re-dummy-3` | P3 | re-dummy-1 |  | new |  |
| 1 | `re-dummy-6` | P3 | re-dummy-1 |  | new | seat-hold |

Program facts, read by the script from this file:

- Cursor eval slot: one token. Spenders: `re-dummy-4`, `re-dummy-5`.
- Long lanes (T14): `re-dummy-5` runs for weeks. Set the lane to state `review` between sessions.
- Pack: re-dummy-2, re-dummy-3 (branch re/re-dummy-2)
- Program state: HOLD

## Shared contracts (one owner each)

- **Shared file.** Owner `re-dummy-1` (dummy/shared.mjs). `re-dummy-6` edits it after `re-dummy-1`.
- **Owner chains.** Each chain is serialized by dependency.
  - shared.mjs: `re-dummy-1`, `re-dummy-6`.

## Lanes

### re-dummy-1

**Dummy 1: the first dummy lane** (wave 0, phase P1, new)

- Depends on: none
- Unblocks: re-dummy-2, re-dummy-3, re-dummy-6
- Related: none
- Owns: `dummy/one.mjs`, `dummy/shared.mjs`
- Do not touch: `dummy/untouched.mjs`
- Cost: 0 runs
- Needs Dave: no

Scope: Nothing. A test lane.

Done when: The dummy test passes.

Why: A lane to test the board rules.

### re-dummy-4

**Dummy 4: a spender** (wave 0, phase P2, new)

- Depends on: none
- Unblocks: none
- Related: none
- Owns: `dummy/four.mjs`
- Do not touch: `dummy/untouched.mjs`
- Cost: 2 runs
- Needs Dave: no

Scope: Nothing. A test lane that spends the Cursor eval slot.

Done when: The dummy test passes.

Why: A lane to test the slot rule.

### re-dummy-5

**Dummy 5: a second spender, and a long lane** (wave 0, phase P2, new)

- Depends on: none
- Unblocks: none
- Related: none
- Owns: `dummy/five.mjs`
- Do not touch: `dummy/untouched.mjs`
- Cost: 2 runs
- Needs Dave: no

Scope: Nothing. A test lane that spends the Cursor eval slot and runs for weeks.

Done when: The dummy test passes.

Why: A lane to test the slot rule and the parked rule.

### re-dummy-2

**Dummy 2: first lane of the pack** (wave 1, phase P3, new)

- Depends on: re-dummy-1
- Unblocks: none
- Related: none
- Owns: `dummy/two.mjs`
- Do not touch: `dummy/untouched.mjs`
- Cost: 0 runs
- Needs Dave: no

Scope: Nothing. A test lane.

Done when: The dummy test passes.

Why: A lane to test the pack rule.

### re-dummy-3

**Dummy 3: second lane of the pack** (wave 1, phase P3, new)

- Depends on: re-dummy-1
- Unblocks: none
- Related: none
- Owns: `dummy/three.mjs`
- Do not touch: `dummy/untouched.mjs`
- Cost: 0 runs
- Needs Dave: no

Scope: Nothing. A test lane.

Done when: The dummy test passes.

Why: A lane to test the pack rule.

### re-dummy-6

**Dummy 6: held by the seat, shares a file** (wave 1, phase P3, new)

- Depends on: re-dummy-1
- Unblocks: none
- Related: none
- Owns: `dummy/six.mjs`, `dummy/shared.mjs`
- Do not touch: `dummy/untouched.mjs`
- Cost: 0 runs
- Needs Dave: no

Scope: Nothing. A test lane with a hold.

Done when: The dummy test passes.

Why: A lane to test the hold rule and the Owns rule.

## External lanes

### ext-dummy

**External dummy: a lane with no Waves row** (counts as wave 0, external; card state `blocked`)

- Depends on: none
- Unblocks: none
- Related: none
- Owns: `dummy/ext.mjs`
- Do not touch: `dummy/untouched.mjs`
- Cost: 0 runs
- Needs Dave: no

Scope (from the card): Nothing. A test card.

Done when: The dummy test passes.

Why it is on the path: It shows how an external card is judged.
