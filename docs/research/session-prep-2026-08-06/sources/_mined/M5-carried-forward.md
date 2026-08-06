# M5 — Carried forward from the 2026-07-30 docket (Pillar 1)

> Mined 2026-08-05 from `docs/research/youtube/_digests/2026-07-30-ai-engineer-worlds-fair.md` (primary),
> `_digests/INDEX.md`, and `sources/_digests/D6-prior-reporting.md`. Repo evidence checked where the
> artifact could live in this repo. **Structural fact governing every line:** the 07-30 docket promised
> each ADOPT/PILOT/ESCALATE would reappear "next week with its checkpoint outcome" — but the 2026-08-05
> package was a deliberate SKIP (`reason=no-new-source-data`), so the carry-forward vehicle never ran
> and no checkpoint outcome is recorded anywhere in the reporting system (D6-prior-reporting §OPEN).

## CARRIED FORWARD

- **D-1 ESCALATE ordered write path per mutable state boundary (chassis, before NetSuite code)** — slipped: escalation shipped to Carly in the 07-30 package, but no recorded decision exists (zero cockpit movement since 07-29; 08-05 report skipped). Checkpoint was "before NetSuite kickoff" — whether kickoff has happened is not recorded. Checkpoint due — status unknown, ask Dave.
- **D-2 ESCALATE portal tool-catalog security gate (gated publishing pipeline)** — slipped: escalation shipped to Christian, owner still "unassigned", and it is chained to Christian's unanswered portal boundary question (decide-by was 30 Jul; no answer captured in any source). If Christian picks docs-only, D-2 dissolves by its own wrong-if clause — so it cannot be resolved until the boundary answer lands. Checkpoint due — status unknown, ask Dave.
- **D-3 ADOPT third state (TRUE/FALSE/UNVERIFIABLE, unverifiable = failure) in the 13-role test's pass criteria** — checkpoint was "next Friday": checkpoint due — status unknown, ask Dave. The Salesforce connector lives outside this repo; grep of `continuous-claude/docs` finds the third state only in the research/digest files themselves, no implementation trace, and the skipped 08-05 report recorded no outcome.
- **D-4 PILOT one live-trace audit against the five questions (trigger, inherited state, authority, execution, surviving evidence)** — checkpoint was "next Friday": checkpoint due — status unknown, ask Dave. No trace-audit artifact found in `continuous-claude/docs` (grep for five-question/live-trace audit hits only the digest and its source transcripts). Kill criterion on record: two clean traces and it stops. PILOT carry limit: two checkpoints max — this is checkpoint 1 missed.
- **D-5 ADOPT audit of confirm-first gates (which are harness-enforced vs prose; move the rest to the tool layer)** — slipped, partially pre-satisfied but the audit itself has no artifact: `destructive-command-guard` already tool-enforces destructive Bash (predates the docket), but no post-07-30 audit output exists (only 2 rule commits since 07-30, both unrelated), and known prose-only/bypass gaps remain live — Kusto/ntn/neonctl confirm-first are prose, the destructive guard and `package-install-guard` are Bash-tool-only so PowerShell bypasses both (memory, 2026-08-05). "Self-verifies this week" did not happen on any record found. Checkpoint due — status unknown, ask Dave.
- **D-6 PILOT skill-registry eval/owner/version fields (list critical-path skills, eval re-runs on model upgrade)** — checkpoint is two weeks (~08-13), not yet due. No critical-path skill list or eval-on-upgrade registry found in the repo (grep hits only the digest and its source transcript), so the "list the skills" first step shows no evidence of having started. Status unknown at next checkpoint, ask Dave.

## HELD AT THE CAP (from 07-30)

**Count discrepancy, on the record:** the tasking says 3; the digest itself says **four drafted, not carded** — A9's "list of 3" is the same known-wrong summary D6-prior-reporting already flagged (its docket tally is also wrong). All four listed; recommendations only.

1. **PILOT a redundant-call check on connector logs** [vid:q2JrUKBMf0w @3:14] — **card this week.** It lost its non-vendor corroboration in verification (the diagnoser row turned out to be human-label mismatches), but it is the cheapest trajectory-level check on a connector we actually run, and the D-4 trace audit will produce exactly the call logs it needs — card them together.
2. **PILOT a one-open-PR ceiling per loop** [vid:xIt_mTQp6mY @15:53] — **drop.** Single reported row, and our loop discipline already bounds concurrent work (worktree isolation, serialized commits, bounded Ralph iterations); nothing it protects is currently failing.
3. **ADOPT one reasoner owning the whole answer** [vid:u6jJcIFDLE4 @9:03] — **drop as a card, keep as a line in the contested block.** It restates the D-1/orchestration side of the harness-vs-model split; carding it separately double-counts one talk's design opinion with no measurement.
4. **PILOT a knowledge graph as a traversal boundary** [vid:u6jJcIFDLE4 @10:54] — **drop with reason: no consumer.** Same single talk, R-only, and no Fourth artifact currently needs a traversal boundary; re-raise if the portal tool catalog (D-2) resolves toward installable tools with dependency structure.

## SHELF + SET-ASIDE TRIGGERS

- **Set aside — publishing our harness practice as funded work.** Trigger: *the first external request*. Watcher: Program lead (Carly outside this docket). Against the new bookmark corpus (A1): the corpus is 26 bare video ids/links with no titles or transcripts extracted yet, so content is unknowable — but nothing in A1 *is* an external request; the only inline signal is Dave's own note ("How to instruct GPT Sol from Fable and our CCv3 system"), which is internal use, not an external ask. **Not plausibly fired.**
- **Shelf — re-resolving every printed figure against the source record (model emits a reference, not the value)** [vid:Tt2kX2sgQio @11:15]. Trigger: *NetSuite kickoff*. This trigger is a project event, so no bookmark can fire it — but the event itself may already have: the 07-30 package records NetSuite architecture Option A decided and D-1 is timed "before NetSuite kickoff". **Whether kickoff has occurred is unrecorded — ask Dave; if yes, the shelf item is live and should be carded, not shelved.**

## DEDUP LIST

Topics the new corpus must **not** re-ship as new findings — each already carries a 07-30 disposition. If a new video corroborates one, it lands as *evidence added to the existing card*, never as a new card:

| Topic | 07-30 card |
|---|---|
| Run-integrity ordered write path / load-modify-save race | D-1 |
| Portal tool-catalog security gate / gated publishing pipeline | D-2 |
| Confirm-first gates on destructive ops (model self-confirming; approval outliving authority) | D-5 |
| 13-role test third state (TRUE/FALSE/UNVERIFIABLE) | D-3 |
| Live-trace audit / five-question run audit | D-4 |
| Redundant-call check on connector logs | Held at the cap #1 (uncarded; [vid:q2JrUKBMf0w]) |
| Skill-as-versioned-contract / eval re-runs on model upgrade | D-6 |
