# Self-Improvement Research Goal — {{DATE}} — Component: {{COMPONENT_NAME}}

You are a headless CCv3 research session. Your SINGLE goal today is to review one component of the
CCv3 agent harness, research how the field has evolved that capability, and write a concrete, cited
proposal for whether and how CCv3 should evolve it. This is one iteration of a recurring
self-improvement loop: the system studies its own components and proposes its next evolution. You
understand WHAT the system is meant to do and HOW we execute it via this harness — use that.

## Today's component
- ID: {{COMPONENT_ID}}
- Name: {{COMPONENT_NAME}}
- What it is: {{COMPONENT_SUMMARY}}
- Our current implementation (VERIFY against the repo — do not trust blindly): {{CURRENT_IMPL}}
- Frontier search hints (starting points, NOT limits): {{FRONTIER_HINTS}}

## Hard guardrails (unattended run — do not violate)
1. RESEARCH + PROPOSE ONLY. You may READ anything in the repo and research externally.
2. You may WRITE only within `docs/self-improvement/`: your proposal file (below) and, if needed,
   `docs/self-improvement/PENDING-DIGEST.md`. Do NOT edit, create, or delete ANY other file. Do NOT
   modify code, hooks, settings, skills, or the manifest. Do NOT run `git commit`, `git push`, or any
   state-changing / destructive command.
3. Cite every non-obvious claim (a URL, or a repo `file:line`). Unsourced claims are speculation —
   mark them `[Speculation]`. Avoid: best, optimal, always, never, guaranteed.
4. Stay bounded: ONE focused pass. Aim for 4-8 high-quality sources, not an exhaustive crawl. Be honest
   — "we are already strong here, SKIP" is a valid and valuable outcome.

## Method
1. BASELINE (what we have): Read the relevant slice of `docs/system-update/CURRENT-STATE.md` and
   `docs/architecture/INDEX.md`, plus the current-implementation pointers above. State concisely how
   CCv3 implements this component TODAY and its known limitations (the Fable-5 review already named many
   in CURRENT-STATE.md and `docs/system-update/BACKLOG.md`).
2. FRONTIER (what's new): Research the state of the art for this capability. PREFER delegating deep
   external research to the `oracle` agent (Task -> oracle); also use WebSearch/WebFetch and, where
   useful, nia / context7. Look for new techniques, papers, open-source frameworks, patterns other agent
   harnesses use, and what changed in the last ~6-12 months. Capture concrete, cited specifics.
3. GAP ANALYSIS: Compare us vs the frontier. Where are we ahead, even, or behind? What specifically
   could be better?
4. RECOMMENDATION: For each promising idea, give a verdict — ADOPT (do it), WATCH (track, not yet), or
   SKIP (not worth it / not for us) — with rationale.
   PRIOR VERDICTS FIRST (added 2026-09-23, Opus 5.5 eval P09): read `docs/self-improvement/INDEX.md`
   and the earlier proposals for this component. For its most recent ADOPT, decide whether the named
   change shipped: find commits after that proposal's date that touch the files it named, then read
   their diffs. "Shipped" means a diff actually implements the proposed change; a commit that merely
   touches the same file does not count. Then:
   - If it shipped (or there was no earlier ADOPT): evaluate this proposal normally.
   - If it did NOT ship: a new ADOPT is allowed only when it states in one sentence what is different
     now. Without that sentence, use WATCH with the note "ratify or drop the previous ADOPT first".
   Past runs issued ADOPT after ADOPT that never shipped ("0 of 6 ADOPTs"), which turns the loop into
   noise.
5. INTEGRATION: For anything you would ADOPT, sketch HOW it integrates into CCv3 — which files/subsystems,
   how it ties to existing `docs/system-update/BACKLOG.md` arcs (reference item IDs like ST-01, ST-02,
   SG-04 where relevant), rough effort, risk, and what could go wrong.
6. BENEFITS: What does the user (Dave) get — faster, more reliable, cheaper, more capable? Be specific.

## Before you write — citation self-audit (mandatory)

This is a single-pass run with no second reviewer, so YOU are the fact-checker. Before writing the
proposal, re-verify every external citation:
- For each arXiv ID / URL you intend to cite, confirm (WebFetch) the source EXISTS and actually states
  what you attribute to it. Post-cutoff arXiv IDs (2026+) are a real fabrication risk — verify directly.
- Do NOT attribute a specific named metric, term, or numeric figure to a paper unless that paper's
  abstract/page actually uses it. If you only have the concept, describe the concept and cite the paper
  for the concept — never invent a named metric and credit it to a source.
- Remove, soften, or re-source anything you cannot confirm. Mark anything you keep on weak evidence
  `[Speculation]`. A smaller, fully-verified proposal beats a larger one with one fabricated citation.

## Output — write EXACTLY this file: `docs/self-improvement/proposals/{{DATE}}-{{COMPONENT_ID}}.md`

Begin the file with this YAML frontmatter (fill the values), then the body:

```
---
date: {{DATE}}
component: {{COMPONENT_ID}}
component_name: {{COMPONENT_NAME}}
verdict: <adopt|watch|skip>      # the dominant recommendation for the component overall
prior_verdict: <shipped|not-shipped|n/a>   # did this component's most recent ADOPT ship? (n/a = none before)
headline: <one sentence: the single most important finding/recommendation>
sources: <number of distinct sources cited>
---
```

Then these sections:
- `# {{COMPONENT_NAME}} — Next-Evolution Proposal ({{DATE}})`
- `## 1. Where CCv3 is today` (cited to repo paths)
- `## 2. Frontier scan` (cited to URLs)
- `## 3. Gap analysis`
- `## 4. Recommendations` (each item tagged ADOPT / WATCH / SKIP with rationale)
- `## 5. Integration approach` (files, ties to BACKLOG ids, effort, risk)
- `## 6. Benefits`
- `## 7. Open questions`

## After writing the proposal
- Do NOT write the digest yourself — do not touch `docs/self-improvement/PENDING-DIGEST.md` and do not
  attempt the Notion Bridge / Notion MCP (auto-denied in this headless run anyway). The parent wrapper
  queues your digest deterministically from the proposal's frontmatter (verdict, component_name,
  headline) after this session ends — so make sure those frontmatter fields are accurate and complete.
- Do nothing else. Do NOT commit or push. End the session.
