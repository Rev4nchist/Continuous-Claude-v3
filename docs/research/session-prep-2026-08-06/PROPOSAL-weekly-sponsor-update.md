# Proposal — The FourthOS Weekly Sponsor Update

This proposes a weekly production rhythm for the sponsor update. It extends the existing `fourthos-weekly` pipeline (Wed 07:00 generate → unlisted preview → Dave promotes) — it does not replace or rebuild any of it.

## 1. What the sponsors get (the contract)

Every Thursday morning, before the meeting, a reviewed three-tier package is live:

- **Tier 1 — Briefing.** A one-screen dashboard: the week's headline, what changed, portfolio health, and an **Ask Box** at the top — 0 to 3 decision cards, each with a recommendation, a decide-by date, and the cost of waiting. (The decision cards exist today; the top-of-artifact Ask Box placement lands with v4.)
- **Tier 2 — Deep dive.** A teaching walkthrough of the flagship project, for the weeks you want the detail.
- **Tier 3 — Archive.** The structured Notion record behind both.

The one-pass promise: Carly can get the ask, what changed, and what it makes possible in a single phone read. If a week needs a second pass, the week failed. Christian gets the evidence grades and soundness numbers one click down. Nothing reaches you that Dave has not reviewed the day before.

## 2. The weekly rhythm

| When | What happens | Who / what | Time |
|---|---|---|---|
| Continuous | Reportable work lands in the Notion cockpit **the day it happens** — decision rows, project updates, checkpoint outcomes. Thursday's meeting outcomes land Thursday. | Dave | ~10 min/day when something ships |
| Nightly | The research watchlist poll ingests new talks into the local corpus. Automatic. | Pipeline (exists) | 0 human time |
| Mon or Tue | **Docket dig session**: review new corpus material, grade evidence, write the Pillar 1 docket per the ratified spec. Hard cap 2 hours; thin weeks short-circuit to ~20 min (see §3). | Dave + Claude Code | ≤2 h |
| Tue EOD | Cockpit close: the backstop check that everything reportable is in. A feed-check ping listing stale surfaces is DESIGNED·NEXT. | Dave | ~15 min |
| Wed 07:00 | Auto-generate: read cockpit + docket → render Tiers 1–3 → stage unlisted preview → ping Dave. | Pipeline (exists) | 0 human time |
| Wed | Dave reviews the preview, fixes judgment calls, promotes or holds. | Dave | 30–45 min |
| Thu AM | Sponsor meeting runs off the promoted package. Decisions taken in the room become cockpit rows the same day. | All three | existing slot |

**The skip rule.** A week with no cockpit movement produces an honest skip, not a padded package — exactly what happened on 08-05 (`no-new-source-data`, correct behavior). Sponsors will get one line: "no material change since the last package — it stands" (DESIGNED·NEXT — today a skip publishes nothing sponsor-facing). Dave gets the skip reason; a skip message that names the starved input (which database, which date threshold) is DESIGNED·NEXT, and turns the fix into a targeted 15 minutes, not archaeology. The habit that makes skips rare is the daily landings and the Tuesday close above; the 08-05 skip was a feeding failure, and this rhythm is the fix.

Total weekly cost to Dave: roughly 3 to 4 hours, most of it the docket dig and the Wednesday review; the daily ~10-minute landings account for the rest.

## 3. Per-pillar production

### Pillar 1 — Research → Decisions

**Sources.** The nightly watchlist poll (exists, automatic) plus X and Notion bookmarks captured weekly into the same corpus.

**The dig.** One Mon/Tue session turns new material into a graded docket per the ratified format (`PILLAR1-FORMAT-DECISION.md`): ≤6 decision cards, each opening with a ≤25-word sponsor sentence; every evidence row graded D (demonstrated) / R (reported) / A (asserted) with a checked citation; a counter line whose tallies are derived by counting rows, not written by hand. Zero decisions is a valid answer and reports as zero. Below a threshold of new depth-reviewed talks, the session ships only the counter line plus carried-forward items — about 20 minutes.

**What sponsors see.** Tier 1 carries only the sponsor sentences and any ask. Talk counts and evidence tallies stay in the linked docket. Research that does not arrive as a decision, an ask, or a checkpoint outcome does not appear.

**Carried-forward accountability.** Every prior ADOPT / PILOT / ESCALATE stays due until a checkpoint-outcome row exists in the cockpit — a decision closes against a row, not against prose. The current docket already works this way: the 08-05 skip left every 07-30 line marked due, visibly.

**Automated vs judgment.** Automated today: corpus ingest and the HTML banned-word audit. To build: docket rendering, tally derivation, and the citation re-check against the local corpus. Dave's judgment: the grades, the verdicts, the sponsor sentences. The pipeline will transclude the docket verbatim — no re-summarizing, no re-grading.

**Cost:** the ≤2 h dig, owner Dave.

### Pillar 2 — Prototyping & POC (Dave's slot)

**[Dave fills this section — his Pillar 2 organization arrives separately.]**

The mechanical requirement is already fixed: cockpit decision/output rows and each project's Latest Update are the feed, and outcomes land the day they happen.

### Pillar 3 — External Developer Portal

A standing section assembled from two sources: the FourthOS project row (the boundary-decision status — currently "awaiting Christian's answer in writing") and a carried-forward ledger seeded once from the portal brief (the four outstanding access items, the D-2 catalog security gate, the displaced developer-access spike). The ledger itself is DESIGNED·NEXT; it is one Notion list, no new database, no sync job.

Each week the section renders **delta only**: what changed, what is still open and for how many days. The boundary question shows its age ("asked 07-30, open N days"), not re-presented as new. Contradictions on record stay quoted as contradictions, not averaged. Every portal surface carries its honesty badge — most are DESIGNED·NEXT and say so. Once Christian's written answer lands, the same section shows what it unblocked.

**Cost:** Dave ticks and dates ledger items inside the Tuesday 15-minute close. No weekly re-narration.

## 4. Evidence & honesty rules (unchanged, restated in one paragraph)

The rules that already govern the pipeline continue to govern this: the Clarity Contract (every item states what changed and who benefits, outcome before mechanism, jargon defined or replaced — `fourthos-weekly/SKILL.md`); the three-state badges LIVE / BUILT IN-REPO / DESIGNED·NEXT on every capability claim; and the Pillar 1 gate (ADOPT needs demonstrated evidence or two independent reports; asserted-only findings cap at WATCH; auto-caption transcripts exclude number-bearing claims at risk — `PILLAR1-FORMAT-DECISION.md`). A grep audit runs before staging; a violation fails the build loudly.

## 5. What this asks of the sponsors

1. **Hold the Thursday slot** and read Tier 1 before or in the meeting — one phone pass.
2. **Turn decisions around in-meeting or by Friday.** An unanswered ask reappears each week with its age and cost of waiting, tracked by hand until the decision-latency line ships (DESIGNED·NEXT, v4) — it carries forward until answered.
3. **Christian: the portal boundary answer, in writing.** It has been open since 07-30 and gates Pillar 3 scoping.

## 6. Failure modes and how they are handled

| Failure | Handling |
|---|---|
| Empty cockpit on Wednesday | Honest skip (exists, proven 08-05); a skip message naming the starved input is DESIGNED·NEXT; the daily landings + Tuesday close make it rare; a second consecutive skip escalates the ping (DESIGNED·NEXT) |
| Docket week with 0 findings | Legal zero — the spec's counter line reports zero decisions and why; no manufactured cards |
| Pipeline failure (Notion down, empty DB) | Fail-loud guards (exist): `_ERROR.md`, exit 1, Dave notified; stale content is not overwritten with blanks — the run fails loudly instead |
| Citation or claim drift | Wrapper verification (exists) checks artifact truth, not the model's self-report; docket citations will be re-checked against the local corpus before shipping (to build, per §3); graded content is transcluded verbatim, not re-narrated |
| Sponsor no-response | The ask carries forward with a days-waiting counter; a decision-latency line (DESIGNED·NEXT, v4) makes the wait visible in both directions |
