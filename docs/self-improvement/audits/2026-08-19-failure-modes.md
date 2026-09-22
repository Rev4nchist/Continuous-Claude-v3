# Failure-mode audit, last 30 days

Generated 2026-08-19T20:50:25.085Z by `scripts/self-improvement/failure-audit.mjs`. Read-only over `~/.claude/projects/**/*.jsonl`.
Files 1194. Sessions with human turns 553. Human messages 1359. Corrections 14.

**Method.** A "correction" is a human message that matches one of 9 regex classes (first match wins). This is a heuristic, not ground truth. Expect false positives (a "no" that answers a question) and misses (polite corrections). A class with **2 or more independent sessions** is a rule candidate. A singleton is provisional.

## Corrections per 100 human messages, by model

| Model | Human msgs | Corrections | per 100 |
|---|---|---|---|
| unknown | 566 | 4 | 0.7 |
| claude-opus-5 | 458 | 8 | 1.7 |
| claude-fable-5 | 208 | 2 | 1.0 |
| claude-opus-4-8 | 107 | 0 | 0.0 |
| <synthetic> | 10 | 0 | 0.0 |
| claude-sonnet-5 | 10 | 0 | 0.0 |

## By class

| Class | Meaning | Total | Sessions | Rule candidate? |
|---|---|---|---|---|
| scope | overbuild / did more than asked / unasked edits | 2 | 2 | yes |
| wrong_target | wrong file / branch / process / project | 1 | 1 | provisional |
| no_verify | claimed done without evidence / did not check | 3 | 2 | yes |
| misread | misread the request / answered a different question | 1 | 1 | provisional |
| stopped_early | stopped early / incomplete / asked instead of doing | 3 | 3 | yes |
| regression | broke something that worked | 2 | 2 | yes |
| format | output format / verbosity / style | 1 | 1 | provisional |
| tool_misuse | wrong tool / command / platform mistake | 0 | 0 | - |
| generic_no | bare negation: "no," / "wrong" / "stop" | 1 | 1 | provisional |

## Class x model

| Class | unknown | claude-opus-5 | claude-fable-5 | claude-opus-4-8 | <synthetic> | claude-sonnet-5 |
|---|---|---|---|---|---|---|
| scope | 1 | 0 | 1 | 0 | 0 | 0 |
| wrong_target | 1 | 0 | 0 | 0 | 0 | 0 |
| no_verify | 1 | 2 | 0 | 0 | 0 | 0 |
| misread | 0 | 1 | 0 | 0 | 0 | 0 |
| stopped_early | 0 | 3 | 0 | 0 | 0 | 0 |
| regression | 1 | 1 | 0 | 0 | 0 | 0 |
| format | 0 | 1 | 0 | 0 | 0 | 0 |
| tool_misuse | 0 | 0 | 0 | 0 | 0 | 0 |
| generic_no | 0 | 0 | 1 | 0 | 0 | 0 |

## Incidents (most recent 80; text truncated; ref = project/session)

- **generic_no** | claude-fable-5 | 2026-08-14 | `C--Users-david-hayes-Projects-fourth-os/6e129d38`
  - user: no edits - send it and update the notion page I am also meeting with with the FourthOS team to get a better understand of what they are building and how that should instruct or adjust our plans. I need you to create an artifact that Mark
  - before: Proposal updated to v4 and live at the **same URL**: https://claude.ai/code/artifact/0e71def9-efa8-411c-ba37-15ab7850d862 What changed, driven by your spec doc:
- **misread** | claude-opus-5 | 2026-08-07 | `C--Users-david-hayes-continuous-claude/75823f04`
  - user: Yep. The CTO lives outside the platform as part of this harness or a future harness we build dedicated to this, but definitely outside of the platform itself. And I'm a solo founder for this, and I don't have a technical cofounder. So that'
  - before: On `feature/greymatter-cto`, branched from `agentic-os` HEAD. Zero divergence, so the branch point is clean. Two things to know: - **64 uncommitted files came w
- **scope** | claude-fable-5 | 2026-08-06 | `C--agent-arch/df8b0225`
  - user: I want you to reformat the topic page: https://fourthlimited.atlassian.net/wiki/x/P4DVhgE the table is probably not the format here - too many columns for agenda items and ANY amount of text use too much vertical space - eval how you would
  - before: The Confluence page is updated to **version 6**. What changed, per the diff rule: - **Amended:** info panel note, session focus, hour-at-a-glance rows 2–3, segm
- **format** | claude-opus-5 | 2026-08-05 | `C--agent-arch/a56b1617`
  - user: Paste what responses? Be clearer an more succinct in your asks - STOP having HAVE to read through your entire response to find out next steps... make them CRYSTAL CLEAR and put them at the end ALWAYS and while we are here - you are getting
  - before: Revision 2 is out, and the fix was better than deferring — **all ten now run today** (T10 Friday), because each broken test supplies its own input instead of as
- **regression** | claude-opus-5 | 2026-08-05 | `C--Users-david-hayes-Projects-fourth-playwright-mcp/576fdcda`
  - user: we have the full report here: C:\Users\david.hayes\Downloads\fourth-playwright-regression-report-2026-08-05.md
  - before: Here's a re-test prompt built specifically around what changed. It covers all nine original defects plus the three bugs found in code review that the original Q
- **no_verify** | unknown | 2026-08-03 | `C--Users-david-hayes-Projects-fourth-salesforce-mcp/c4ac8d8e`
  - user: we are picking up from a previous session with this handoff: Handoff written: docs/HANDOFF-2026-08-03-dictionary-v6-tier-brand.md, plus a memory entry and a pointer at the top of MEMORY.md so a fresh session lands on it without reading the 
  - before: (none)
- **stopped_early** | claude-opus-5 | 2026-08-03 | `C--Users-david-hayes-continuous-claude/2bf4763d`
  - user: keep going with Phase 1
  - before: **Phase 0 shipped** — `1da21d9`. The FourthOS wrapper now emits a pessimistic `Failed` row before the long `claude -p` call, stamped so the final emit updates i
- **regression** | unknown | 2026-07-30 | `C--Users-david-hayes-Projects-fourth-netsuite-mcp/0841d324`
  - user: we are picking up from a previous session with the following handoff: Resume with /resume_handoff thoughts/shared/handoffs/netsuite-connector/2026-07-15_18-45_ccv3-init-research-corrections.yaml Or just open the folder — START-HERE now r
  - before: (none)
- **stopped_early** | claude-opus-5 | 2026-07-29 | `C--Users-david-hayes-continuous-claude/131683fe`
  - user: Yeah keep going I want to ultimately get to a good stopping point with this latest round of updates. Finish your last plans and wrap this session up
  - before: Worked the MSYS lane. Pushed as `9ea865d`, branch `0 0`, lane released with a full note. **I did not establish root cause, and I'm not claiming one.** What I ch
- **wrong_target** | unknown | 2026-07-29 | `C--Users-david-hayes-continuous-claude/131683fe`
  - user: we are picking up work from a previous session with the handoff here: Resume in the new session with: /resume_handoff thoughts/shared/handoffs/context-lever/2026-07-29_14-18_phase2-applied-and-sync-bug.yaml The wrong directory cost nothin
  - before: (none)
- **stopped_early** | claude-opus-5 | 2026-07-27 | `C--Users-david-hayes-continuous-claude/0e1e2e2b`
  - user: you know what we are trying to accomplish - I want you to make this work - stop asking me some many interim questions there is a comm link between you and the other session - and a complete guide handoff to the remaining work - which we s
  - before: That's all 41 — the `--since` window supersedes the earlier list, so this one proposal covers everything from 07-12 to now. Proposal id: **`2026-07-12-90c`**. T
- **no_verify** | claude-opus-5 | 2026-07-27 | `C--Users-david-hayes-continuous-claude/4775d659`
  - user: I want you to look, review and eval our current still broken items and how we should approach fixing them It is CRITICAL that reporting accurately reflects our project work and updates I am working in another claude session on this branch
  - before: Read-only review complete. No changes made. ## Verdict: the fixes hold; the underlying fault does not **The always-emit contract is now fully proven — including
- **no_verify** | claude-opus-5 | 2026-07-27 | `C--Users-david-hayes-continuous-claude/4775d659`
  - user: I don't want you to write or change anything - I want you to review all recent report firings - are they correct, anything still broken
  - before: It's a goal-based dispatcher: figure out what kind of work this is, pick the matching specialist agent, confirm, then spawn. Five steps. | Step | What it does |
- **scope** | unknown | 2026-07-26 | `C--Users-david-hayes-continuous-claude/c23038de`
  - user: we have been working across too many sessions lately developing plans, implementing features, overall just to many separate threads with too much overlap - and we need to spend a session wrangling, understanding, planning, verify etc... how
  - before: (none)

## Next

Read the incidents for each "yes" class. Confirm they are real corrections. Propose ONE rule edit per class with a bad/good pair. Keep this file repo-local: it contains session text.


---

# LLM pass (the real audit)

The regex pass above is the cheap first filter and it under-counts badly (14 hits, most false). This pass is Theo's actual method [vid:e1snsuY4lTI @19:51]: every human turn was read by a classifier agent (3 agents in parallel, one per 460-line slice of `--dump`) and labelled with one class or `none`. Classifier outputs: `$TEMP/classified-part0{0,1,2}.jsonl` (session-local scratch; merged rows reproduced below).

**Result: 38 corrections in 1,359 human turns (2.8 per 100).** Caveat: roughly 85% of "human turns" in this window are automated prompts (scheduled Notion card refreshes, headless self-improvement runs, task notifications); the real interactive denominator is closer to ~600, so the interactive rate is nearer 6 per 100.

## Corrections per 100 human turns, by model (LLM pass)

| Model | Human turns | Corrections | per 100 |
|---|---|---|---|
| claude-opus-5 | 458 | 27 | 5.9 |
| claude-fable-5 | 208 | 7 | 3.4 |
| claude-opus-4-8 | 107 | 3 | 2.8 |
| unknown | 566 | 1 | 0.2 |

`unknown` = turns before any assistant reply (session openers, automated jobs). Opus 5 carries the most sessions and the highest rate; this matches Theo's own finding that Opus 5 was his top offender, but the sample is small.

## By class (LLM pass)

| Class | Count | Sessions | Rule candidate? |
|---|---|---|---|
| no_verify | 12 | 11 | **yes** |
| format | 6 | 6 | **yes** |
| wrong_target | 5 | 5 | **yes** |
| other_correction | 3 | 3 | **yes** |
| misread | 3 | 3 | **yes** |
| stopped_early | 2 | 2 | **yes** |
| regression | 2 | 2 | **yes** |
| scope | 2 | 2 | **yes** |
| process | 2 | 2 | **yes** |
| tool_misuse | 1 | 1 | provisional |

## Class x model (LLM pass)

| Class | claude-opus-5 | claude-fable-5 | claude-opus-4-8 | unknown |
|---|---|---|---|---|
| format | 5 | 1 | 0 | 0 |
| no_verify | 8 | 1 | 3 | 0 |
| stopped_early | 1 | 1 | 0 | 0 |
| wrong_target | 3 | 2 | 0 | 0 |
| regression | 1 | 0 | 0 | 1 |
| scope | 2 | 0 | 0 | 0 |
| other_correction | 3 | 0 | 0 | 0 |
| misread | 1 | 2 | 0 | 0 |
| process | 2 | 0 | 0 | 0 |
| tool_misuse | 1 | 0 | 0 | 0 |

## All 38 corrections (Dave's words, truncated; ref = project/session)

- **format** | claude-opus-5 | 2026-08-07 | `C--Users-david-hayes-continuous-claude/9d208d7e`
  - "[Image #1] and fix formatting here ... review, ask questions if needed, then make the update"
  - slide/deck formatting issues need fixing
- **format** | claude-opus-5 | 2026-08-06 | `C--agent-arch/309e2db1`
  - "stop using weird terms like "pressure test" BE CLEAR - STATE EXACTLY what you mean!! Always talk in ASD-STE100"
  - communication style violation, agent used jargon
- **format** | claude-opus-5 | 2026-08-06 | `C--Windows-System32/8d88d0c1`
  - "BE MORE CLEAR -- and STOP TYPING NOVELS - I don't have time to read all this - BE MORE SUCCINCT"
  - response too long/unclear, buried instructions
- **format** | claude-opus-5 | 2026-08-05 | `C--agent-arch/a56b1617`
  - "Paste what responses? Be clearer an more succinct in your asks - STOP...you are getting WAY TOO VERBOSE"
  - response too verbose, next steps not clear/last
- **format** | claude-opus-5 | 2026-07-30 | `C--Users-david-hayes-Projects-buzz/e0121aea`
  - "these aren't great instructions - when instructing me be clear and explicit"
  - agent's manual-step instructions to Dave were vague/ambiguous
- **format** | claude-fable-5 | 2026-07-24 | `C--Users-david-hayes-continuous-claude/4c4fb99c`
  - "[Image #2] look at the formatting of these section types across the page and fix"
  - artifact section formatting broken, needs fix
- **misread** | claude-fable-5 | 2026-08-13 | `C--Users-david-hayes-Projects-fourth-os/c60fb382`
  - "I am NOT asking for you to hook up msft workiq for live answers right now?!! We need to create WHAT CHRISTIAN ASKED FOR - wtf... go back to square one"
  - agent built wrong deliverable, misunderstood the actual ask
- **misread** | claude-fable-5 | 2026-08-06 | `C--Users-david-hayes-continuous-claude/683bfb27`
  - "confirm for Christian that the portal IS NOT JUST a documentation and onboarding experience. IT IS - the customer-facing operational control centre"
  - agent's characterization of portal scope was too narrow
- **misread** | claude-opus-5 | 2026-07-28 | `C--Users-david-hayes-continuous-claude/903600b6`
  - "I don't have any other sessions running in this directory for the nine files - take your recommended actions"
  - corrects agent's assumption about other active sessions
- **no_verify** | claude-opus-5 | 2026-08-06 | `C--agent-arch/309e2db1`
  - "I am not seeing the version 0.1.1 bump"
  - agent claimed bump shipped, user can't see it
- **no_verify** | claude-opus-5 | 2026-08-06 | `C--Windows-System32/8d88d0c1`
  - "I do want reference/confluence-map.md:111 corrected to record that data-local-id is server-reassigned"
  - doc maintained by agent contained an incorrect/unverified claim
- **no_verify** | claude-opus-5 | 2026-08-05 | `C--Users-david-hayes-continuous-claude/e948bbee`
  - "4 of the 7 transferred repos have no project-registry.json entry i don't know what this means"
  - migration claimed complete but registry entries missing
- **no_verify** | claude-opus-5 | 2026-08-02 | `C--Users-david-hayes-continuous-claude/2bf4763d`
  - "We have been working on reporting for a while but are still encountering bugs - this needs to be deeply reviewed"
  - prior fixes claimed but bugs persist
- **no_verify** | claude-opus-5 | 2026-07-30 | `C--Users-david-hayes-continuous-claude/55d5e9ee`
  - "Where is the output of the research?"
  - claimed done but research artifact not delivered/located
- **no_verify** | claude-opus-5 | 2026-07-29 | `C--Users-david-hayes-continuous-claude/5d7e7343`
  - "first get the article's actual fifteen techniques"
  - agent analyzed/summarized without the real source content
- **no_verify** | claude-opus-5 | 2026-07-26 | `C--Users-david-hayes-continuous-claude/4775d659`
  - "Here is a new terminal process and details: pre-emit registry step threw (non-fatal)"
  - recurrence of same unaddressed error
- **no_verify** | claude-opus-5 | 2026-07-25 | `C--Users-david-hayes-continuous-claude/4775d659`
  - "just saw this terminal report: pre-emit registry step threw (non-fatal)"
  - real run showed error contradicting fix claim
- **no_verify** | claude-fable-5 | 2026-07-24 | `C--Users-david-hayes-continuous-claude/4c4fb99c`
  - "Fix the mobile sticky menu"
  - claimed live but mobile menu still broken
- **no_verify** | claude-opus-4-8 | 2026-07-23 | `C--Users-david-hayes-continuous-claude/66a8204a`
  - "Updated Salesforce connector card ... not sure where you were seeing out of date info"
  - agent's stale-data claim unverified/incorrect
- **no_verify** | claude-opus-4-8 | 2026-07-21 | `C--Users-david-hayes-Projects-fourth-salesforce-mcp/72153164`
  - "I thought I had given you these docs: salesforce-data-dictionary-clean-v2 (1).md ..."
  - agent claimed dictionary content not updated; Dave says docs were already provided
- **no_verify** | claude-opus-4-8 | 2026-07-20 | `C--Users-david-hayes-continuous-claude/0d81f91f`
  - "I don't see anything with this command: Get-MpPreference | Select-Object -ExpandProperty ExclusionPath"
  - agent said Defender exclusion added OK, not showing
- **other_correction** | claude-opus-5 | 2026-08-07 | `C--Users-david-hayes-continuous-claude/9d208d7e`
  - "I am seeing the last agent as idle - check this"
  - flags a stalled/idle background subagent
- **other_correction** | claude-opus-5 | 2026-08-03 | `C--Users-david-hayes-Projects-fourth-salesforce-mcp/26d1cd66`
  - "why is the suggested prompt: "merge and deploy it" is this not already merged and deployed"
  - agent's own next-step suggestion contradicted its stated completed state
- **other_correction** | claude-opus-5 | 2026-07-30 | `C--Users-david-hayes-continuous-claude/555b02bd`
  - "fix your flag - README §5.4 currently says arscontexta is "the whole remaining ballgame""
  - stale/inaccurate claim in agent-authored doc
- **process** | claude-opus-5 | 2026-07-29 | `C--Users-david-hayes-continuous-claude/b9978324`
  - "Fix the system - I'd prefer to get this up and working rather than cut braintrust"
  - rejects proposed workaround, demands root-cause fix
- **process** | claude-opus-5 | 2026-07-25 | `C--Users-david-hayes-continuous-claude/d29bea3f`
  - "Yes redo the notion page And commit - review how to commit - lots of uncommitted work"
  - agent left work uncommitted across the session
- **regression** | claude-opus-5 | 2026-08-17 | `C--Users-david-hayes-continuous-claude/4083db83`
  - "I thought we already fixed this: the MSYS fork storm"
  - previously fixed bug recurred
- **regression** | unknown | 2026-08-05 | `C--Users-david-hayes-continuous-claude/35c80051`
  - "The ROADMAP-sync hook clobbered ROADMAP.md again (known hazard). I thought we fixed this a while ago"
  - previously fixed bug recurred
- **scope** | claude-opus-5 | 2026-08-12 | `C--Users-david-hayes-continuous-claude/75bf62ab`
  - "commit it - and review all the work on this branch and commit only your work - leave the rest"
  - avoid committing other sessions' changes
- **scope** | claude-opus-5 | 2026-08-09 | `C--Users-david-hayes-continuous-claude/54491ed2`
  - "we don't need to rotate the BT key push to fork - make sure we are committing only the BT work on Agentic-OS and yes scope that out"
  - narrowing commit scope, avoid extra unrelated work
- **stopped_early** | claude-opus-5 | 2026-08-06 | `C--agent-arch/309e2db1`
  - "you can do this - don't make me play the middle man between you and cowork when you can directly go and fix"
  - agent relayed fixes through user instead of doing directly
- **stopped_early** | claude-fable-5 | 2026-08-03 | `C--Users-david-hayes-continuous-claude--claude-worktrees-interactive-html-artifact-243670/18fb9131`
  - "continue - and end with submitting the plan"
  - agent asked clarifying questions instead of proceeding to plan
- **tool_misuse** | claude-opus-5 | 2026-07-27 | `C--Users-david-hayes-continuous-claude/c22279d5`
  - "-Path: The term '-Path' is not recognized as a name of a cmdlet, function, script file..."
  - agent's PowerShell command syntax broke when pasted
- **wrong_target** | claude-opus-5 | 2026-08-08 | `C--Users-david-hayes-continuous-claude/54491ed2`
  - "fix the 413 split-and-retry gap now and commit - but you are on the incorrect branch right now - go back on the previous branch (agentic-os)?"
  - agent was working on wrong git branch
- **wrong_target** | claude-fable-5 | 2026-08-06 | `C--agent-arch/df8b0225`
  - "that's not the correct agenda - it contains these topics:"
  - email drafted from wrong/outdated agenda source
- **wrong_target** | claude-opus-5 | 2026-08-06 | `C--Users-david-hayes-continuous-claude/abe71b32`
  - "it should be in the plugin: C:\Users\david.hayes\Projects\ai-research-governance-v0.1.0.zip"
  - agent checked wrong location before concluding hook absent
- **wrong_target** | claude-fable-5 | 2026-08-04 | `C--Users-david-hayes-continuous-claude/4c54aa1b`
  - "I put the plugin in my company claude cowork - not this account (my personal account) how can we get the yt-dlp into the plugin correctly"
  - agent had probed the wrong account/environment
- **wrong_target** | claude-opus-5 | 2026-07-29 | `C--agent-arch/9b863a11`
  - "I didn't realize this session was in the agent-arch directory when I asked that work be done"
  - work done in wrong project directory

## Findings that become rule edits (>=2 independent sessions)

1. **no_verify (12 / 11 sessions, every model).** The single largest class: "done"/"fixed"/"live" claimed, then Dave finds the thing absent, stale, or still broken. The existing RULES.md "Never claim done without evidence" is not landing. Edit: add a bad/good example pair to CLAUDE.md and require the evidence line to name the artifact or command output.
2. **format (6 / 6 sessions).** Verbosity, unclear asks, jargon ("pressure test"), next steps buried. The STE + Next-steps rules were BORN from one of these (a56b1617) and the class still recurs after. Edit: bad/good pair for the Next steps block; add "plain words, no invented jargon" example.
3. **wrong_target (5 / 5 sessions).** Wrong branch, wrong directory, wrong account, wrong location checked before concluding "absent". Edit: preflight must state branch + cwd + account in one line before acting; "absent" claims name every location checked.
4. **misread (3 / 3 sessions).** Built the wrong deliverable / framed scope too narrowly. Edit: "questions are read-only" + restate the ask in one line before non-trivial work.
5. **scope (2) / stopped_early (2) / regression (2) / process (2)** qualify but are thin; fold into the "how we work together" block (ceremony, stop points, commit only your own work) rather than separate rules.
6. **Provisional (1 session):** tool_misuse.

No transcript content from this file goes to Notion or any digest. Repo-local only.
