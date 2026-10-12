---
name: premortem
description: "Stress-test a plan or diff for failure modes before building. Use when the user says \"premortem\", \"/premortem\", \"what could go wrong\", or before a risky implementation."
allowed-tools: [Read, Grep, Glob, Task, AskUserQuestion, TodoWrite, Bash]
---

# Pre-Mortem

Identify failure modes before they occur by systematically questioning plans, designs, and implementations. Based on Gary Klein's technique, popularized by Shreyas Doshi (Stripe). Augmented with a cross-model adversarial pass via OpenAI Codex — same training family = same blind spots, so Codex (different family) finds the tigers Claude misses.

## Usage

```
/premortem                  # Auto-detect context, choose depth (includes Codex pass)
/premortem quick            # Force quick analysis (plans, PRs)
/premortem deep             # Force deep analysis (before implementation)
/premortem <file>           # Analyze specific plan or code
/premortem --no-codex       # Skip the cross-model pass entirely (Claude-only)
/premortem --grok           # Use Grok as the cross-model reviewer instead of Codex
/premortem --reviewers both # Run Codex AND Grok passes in parallel
```

## Core Concept

> "Imagine it's 3 months from now and this project has failed spectacularly. Why did it fail?"

## Risk Categories (Shreyas Framework)

| Category | Symbol | Meaning |
|----------|--------|---------|
| **Tiger** | `[TIGER]` | Clear threat that will hurt us if not addressed |
| **Paper Tiger** | `[PAPER]` | Looks threatening but probably fine |
| **Elephant** | `[ELEPHANT]` | Thing nobody wants to talk about |

## CRITICAL: Verify Before Flagging

**Do NOT flag risks based on pattern-matching alone.** Every potential tiger MUST go through verification.

### The False Positive Problem

Common mistakes that create false tigers:
- Seeing a hardcoded path without checking for `if exists():` fallback
- Finding missing feature X without asking "is X in scope?"
- Flagging code at line N without reading lines N±20 for context
- Assuming error case isn't handled without tracing the code

### Verification Checklist (REQUIRED)

Before flagging ANY tiger, verify:

```yaml
potential_finding:
  what: "Hardcoded path at line 42"

verification:
  context_read: true    # Did I read ±20 lines around the finding?
  fallback_check: true  # Is there try/except, if exists(), or else branch?
  scope_check: true     # Is this even in scope for this code?
  dev_only_check: true  # Is this in __main__, tests/, or dev-only code?

result: tiger | paper_tiger | false_alarm
```

**If ANY verification check is "no" or "unknown", DO NOT flag as tiger.**

### Required Evidence Format

Every tiger MUST include:

```yaml
tiger:
  risk: "<description>"
  location: "file.py:42"
  severity: high|medium
  # REQUIRED - what mitigation was checked and NOT found:
  mitigation_checked: "No exists() check, no try/except, no fallback branch"
```

If you cannot fill in `mitigation_checked` with specific evidence, it's not a verified tiger.

### Prove the Load-Bearing Fact (REQUIRED)

Each tiger and each paper tiger rests on one fact. For a tiger: the fact that makes the threat real.
For a paper tiger: the fact the change is safe because of. Name that one fact, then rate how sure you are:

| Level | Name | You did this |
|-------|------|--------------|
| 1 | said so | A person, a doc or a comment states it |
| 2 | line cited | You read the line that states it |
| 3 | walked it | You traced the code path by reading |
| 4 | ran it | A script that calls the real code showed it |
| 5 | ran it in the app | You saw it in the running product |

Prove the fact at level 4. Write a small script in the scratchpad that calls the real code, run it,
and save its output. Run only scripts that change no shared state. If you cannot reach level 4, mark
the fact `unproven` and say what stopped you. Never report a level you did not reach.

Also check where grep stops: database columns, API payloads, config flags, and callers in other repos.

```yaml
load_bearing_fact: "<the one fact>"
certainty: 1-5 | unproven
proof: "<script path and the output line, or what stopped you>"
```

Add these three fields to every tiger and paper tiger in the output formats below.

## Workflow

### Step 1: Detect Context & Depth

```python
# Auto-detect based on context
if in_plan_creation:
    depth = "quick"   # Localized scope
elif before_implementation:
    depth = "deep"    # Global scope
elif pr_review:
    depth = "quick"   # Localized scope
else:
    # Ask user
    AskUserQuestion(
        question="What depth of pre-mortem analysis?",
        header="Depth",
        options=[
            {"label": "Quick (2-3 min)", "description": "Plans, PRs, localized changes"},
            {"label": "Deep (5-10 min)", "description": "Before implementation, global scope"}
        ]
    )
```

### Step 2: Run Appropriate Checklist

#### Quick Checklist (Plans, PRs)

Run through these mentally, note any that apply:

**Core Questions:**
1. What's the single biggest thing that could go wrong?
2. Any external dependencies that could fail?
3. Is rollback possible if this breaks?
4. Edge cases not covered in tests?
5. Unclear requirements that could cause rework?

**Output Format:**
```yaml
premortem:
  mode: quick
  context: "<plan/PR being analyzed>"

  # Two-pass process: first gather potential risks, then verify each one
  potential_risks:  # Pass 1: Pattern-matching findings
    - "hardcoded path at line 42"
    - "missing error handling for X"

  # Pass 2: After verification
  tigers:
    - risk: "<description>"
      location: "file.py:42"
      severity: high|medium
      category: dependency|integration|requirements|testing
      mitigation_checked: "<what was NOT found>"  # REQUIRED

  elephants:
    - risk: "<unspoken concern>"
      severity: medium

  paper_tigers:
    - risk: "<looks scary but ok>"
      reason: "<why it's fine - what mitigation EXISTS>"
      location: "file.py:42-48"  # Show the mitigation location

  false_alarms:  # Findings that turned out to be nothing
    - finding: "<what was initially flagged>"
      reason: "<why it's not a risk>"
```

#### Deep Checklist (Before Implementation)

Work through each category systematically:

**Technical Risks:**
- [ ] Scalability: Works at 10x/100x current load?
- [ ] Dependencies: External services + fallbacks defined?
- [ ] Data: Availability, consistency, migrations clear?
- [ ] Latency: SLA requirements will be met?
- [ ] Security: Auth, injection, OWASP considered?
- [ ] Error handling: All failure modes covered?

**Integration Risks:**
- [ ] Breaking changes identified?
- [ ] Migration path defined?
- [ ] Rollback strategy exists?
- [ ] Feature flags needed?

**Process Risks:**
- [ ] Requirements clear and complete?
- [ ] All stakeholder input gathered?
- [ ] Tech debt being tracked?
- [ ] Maintenance burden understood?

**Testing Risks:**
- [ ] Coverage gaps identified?
- [ ] Integration test plan exists?
- [ ] Load testing needed?
- [ ] Manual testing plan defined?

**Output Format:**
```yaml
premortem:
  mode: deep
  context: "<implementation being analyzed>"

  # Two-pass process
  potential_risks:  # Pass 1: Initial scan findings
    - "no circuit breaker for external API"
    - "hardcoded timeout value"

  # Pass 2: After verification (read context, check for mitigations)
  tigers:
    - risk: "<description>"
      location: "file.py:42"
      severity: high|medium
      category: scalability|dependency|data|security|integration|testing
      mitigation_checked: "<what mitigations were looked for and NOT found>"
      suggested_fix: "<how to address>"

  elephants:
    - risk: "<unspoken concern>"
      severity: medium|high
      suggested_fix: "<suggested approach>"

  paper_tigers:
    - risk: "<looks scary>"
      reason: "<why it's actually ok - cite the mitigation code>"
      location: "file.py:45-52"

  false_alarms:
    - finding: "<initial concern>"
      reason: "<why verification showed it's not a risk>"

  checklist_gaps:
    - category: "<which checklist section>"
      items_failed: ["<item1>", "<item2>"]
```

### Step 2.5: Cross-Model Adversarial Pass (Codex / Grok / Both)

Same training family = same blind spots. After Claude's verified tigers/elephants/paper_tigers list is built, run an adversarial pass through one or more different-family reviewers to find risks Claude missed.

**Reviewer selection.** The post-ExitPlanMode hook (or the user directly) picks: **Codex** (default), **Grok**, **Both**, or **Skip**. `--no-codex` skips the Codex pass (back-compat); `--grok` uses Grok instead; `--reviewers both` runs both. When Both is selected, start the two passes **in parallel** (single message, two tool calls): the Codex runner in the background, and the Grok adversary Task.

**Plan mode:** do NOT run Codex. Report `Cross-model pass: deferred (plan mode)`. The ExitPlanMode hook offers `/premortem` afterwards, and the Codex pass runs then.

**Skip if** the user chose Skip OR the target is a trivial doc-only change OR the relevant subscription quota is exhausted this session. See `.claude/rules-ondemand/codex-adversarial.md` and `.claude/rules-ondemand/grok-worker-safety.md`.

**Reviewer unavailable?** Agents merged mid-session don't register until the next session start (hit 2026-07-11: `grok-adversary` absent from the Agent registry hours after merge). Do NOT silently downgrade to a Claude-family reviewer — that forfeits the cross-model value the user chose. Fallback for Grok: execute the adversary's own contract inline — read `.claude/agents/grok-adversary.md`, run the documented CLI invocation yourself (same read-only tool guard, same identity pin, same output paths), and parse findings from its clean-output file. Fallback for Codex: run the runner yourself (the Codex path below needs no agent registration).

**Codex path.** No subagent. The main session runs the runner in the background. A run takes up to 9 minutes. Wait for the completion notice and never poll in a loop.

```
Bash(
  command='node "$HOME/.claude/scripts/codex/adversary.mjs" run --project <ABSOLUTE project path> --mode plan --plan <ABSOLUTE path to the plan file> --focus-file <ABSOLUTE path to the focus file> --via skill:premortem',
  run_in_background=true
)
```

Before the call, write the focus text to the focus file (for example in the project's `.claude/cache/`): the claude_tigers one-line list, and a request for tigers, elephants, and wrongly dismissed paper_tigers. Never put free text in the command line.

The runner prints a `CODEX-RECEIPT v1 ...` line first. Keep it. When the run ends, read line 1. If it matches the gate regex below, take the run id from `run=` and run `node "$HOME/.claude/scripts/codex/adversary.mjs" verify <run-id>` (zero quota). Only when verify prints `VERIFY ok` (exit 0), show the receipt line and line 2, then the findings. If verify fails, report `Cross-model pass: NO CODEX REVIEW (verify failed: <reason>)`, show no findings as Codex's, and write no lift row. Tag findings `[Codex]` and use `sources: [.., codex]` ONLY when that line matches `^CODEX-RECEIPT v1 status=ok run=\S+ model=gpt-[\w.-]+ `. On any other status, report `Cross-model pass: NO CODEX REVIEW (<status>)` and the runner's fix. Do not write a Codex review yourself.

**Grok path** (unchanged):

```
# Spawn the Grok adversary agent in plan mode pointed at the plan file.
Task(
  subagent_type="grok-adversary",    # parallel with the Codex runner when Both
  prompt="""
  ## Mode
  plan

  ## Scope
  [absolute path to plan file being pre-mortemed]

  ## Focus
  Identify failure modes Claude missed. Claude already found:
  [list claude_tigers with one-line descriptions]

  Look for additional tigers (clear threats), elephants (unspoken concerns),
  or cases where Claude's paper_tigers were dismissed incorrectly.
  Different training family = different blind spots — that's the value.

  ## Codebase
  $CLAUDE_PROJECT_DIR
  """
)
```

**Merge convention:** findings get prefixed by source — `[Codex]` / `[Grok]` — and merged into the same tigers/elephants/paper_tigers lists. Findings flagged by TWO OR MORE models get `confidence: cross-model-agreed` — the high-confidence ones to act on first. Findings only one non-Claude model flags are that model's **cross-model lift** — track per model as the value signal of its pass.

```yaml
# Merged output (Claude + Codex + Grok tigers, deduplicated by file:line + risk)
tigers:
  - risk: "<description>"
    location: "file.py:42"
    severity: high|medium
    sources: [claude, codex, grok]   # which model(s) found it
    mitigation_checked: "<what was NOT found>"
```

### Step 3: Present Risks via AskUserQuestion

**BLOCKING:** Present findings and require user decision.

```python
AskUserQuestion(
    question=f"""Pre-Mortem identified {len(tigers)} tigers, {len(elephants)} elephants:

{risk_summary}

How would you like to proceed?""",
    header="Risks",
    options=[
        {"label": "Accept risks and proceed", "description": "Acknowledged but not blocking"},
        {"label": "Add mitigations to plan (Recommended)", "description": "Update plan with risk mitigations before proceeding"},
        {"label": "Research mitigation options", "description": "I don't know how to mitigate - help me find solutions"},
        {"label": "Discuss specific risks", "description": "Talk through particular concerns"}
    ]
)
```

### Step 4: Handle User Response

#### If "Accept risks and proceed"
Log acceptance and continue to next workflow step.

#### If "Add mitigations to plan"
Update plan file with mitigations section, then re-run quick premortem to verify mitigations address risks.

#### If "Research mitigation options"

Spawn parallel research for each HIGH severity tiger:

```python
for tiger in high_severity_tigers:
    # Internal: How has codebase handled this before?
    Task(subagent_type="scout", prompt=f"""
        Find how this codebase has previously handled: {tiger.category}
        Specifically looking for patterns related to: {tiger.risk}
        Return: file:line references, patterns used, libraries available
    """)

    # External: What are best practices?
    Task(subagent_type="oracle", prompt=f"""
        Research best practices for: {tiger.risk}
        Context: {tiger.category} in a {tech_stack} codebase
        Return: recommended approaches (ranked), library options, common pitfalls
    """)

# Synthesize, present 2-4 mitigation options via AskUserQuestion
```

#### If "Discuss specific risks"
Ask which risk to discuss, then have conversation about that specific risk.

### Step 5: Update Plan (if mitigations added)

Append to the plan file:

```markdown
## Risk Mitigations (Pre-Mortem)

### Tigers Addressed:
1. **{risk}** (severity: {severity})
   - Mitigation: {mitigation}
   - Added to phase: {phase_number}

### Accepted Risks:
1. **{risk}** - Accepted because: {reason}

### Pre-Mortem Run:
- Date: {timestamp}
- Mode: {quick|deep}
- Cross-model pass: {the Codex receipt line (verbatim) | grok | both | skipped | deferred (plan mode) | NO CODEX REVIEW (<status>)}
- Tigers: {total} (claude-only: {N}, codex-only: {N}, grok-only: {N}, agreed: {N}) | Elephants: {count}
```

### Step 6: Telemetry

After the user response is handled, append one row **per cross-model reviewer that ran**. Codex rows go through the runner's `lift` subcommand (only for an `ok` receipt). Grok rows go to `.claude/logs/grok-lift.jsonl`:

```bash
node "$HOME/.claude/scripts/codex/adversary.mjs" lift \
  --run <run-id from the receipt> \
  --skill premortem \
  --scope "[plan path or scope]" \
  --claude-only <N> --codex-only <N> --both <N> \
  --project <ABSOLUTE project path>
# Grok pass ran too? Append a row to .claude/logs/grok-lift.jsonl with jq: fields ts, skill, scope,
# model "grok", claude_only, codex_only (= grok_only; field name kept for schema back-compat), both, via "direct".
```

The reviewer-only count is that model's cross-model lift — the value it added beyond what Claude found. Track over time per model to validate each pass is worth its quota.

## Integration Points

| Context | Mode | Behavior |
|---------|------|----------|
| During plan creation | quick | Run after plan structure approved, before ExitPlanMode |
| Before implementation | deep | Run on full plan file; block on HIGH risks |
| PR review | quick | Run on diff scope; inform of risks found |

## Severity Thresholds

| Severity | Blocking? | Action Required |
|----------|-----------|-----------------|
| HIGH | Yes | Must address or explicitly accept |
| MEDIUM | No | Inform user, recommend addressing |
| LOW | No | Note for awareness |

## References

- `references/example-session.md` — Annotated walkthrough of a deep premortem session
- [Pre-Mortems by Shreyas Doshi](https://coda.io/@shreyas/pre-mortems)
- [Gary Klein's Original Research](https://hbr.org/2007/09/performing-a-project-premortem)
- [Mountain Goat Software Guide](https://www.mountaingoatsoftware.com/blog/use-a-pre-mortem-to-identify-project-risks-before-they-occur)
