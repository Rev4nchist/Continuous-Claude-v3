# Context Engineering & The Agent Harness  
**Hyper-Detailed Knowledge Base Guide**  

## TL;DR (Executive Summary)
The real differentiator in AI coding agents (Claude Code, Cursor, etc.) is **not** the model or IDE — it’s the **Agent Harness**: a deliberate system of context engineering that keeps the agent’s context window lean, relevant, and structured.

Key insight: Treat the agent like a brilliant new hire on day one. Onboard it with rules, tools, skills, and specs instead of raw prompts. MercadoLibre is rolling this out to ~20,000 developers with massive gains in consistency.  

Four levers to master:  
1. Custom Rules  
2. MCP Servers (tools)  
3. Skills (on-demand context + logic)  
4. Spec-Driven Development (the ultimate context compressor)  

Plus tight feedback loops (tests, hooks, review agents). The result: reliable, scalable AI coding at enterprise scale.

## Core Mental Model
**Your AI coding agent = brilliant new hire with zero context.**  
You would never say “fix this bug” and walk away. You onboard with:  
- Docs  
- Tech stack  
- Style guides  
- Workflows  
- Tools  
- Mentor/review process  

**Context Engineering** = building that onboarding system systematically.  
**Agent Harness** = the concrete implementation that turns context theory into repeatable outcomes.

## The Agent Loop & Its Bottleneck: Context Window
All modern coding agents follow the same loop:  
**Read → Plan → Code → Validate → Iterate**

Every iteration consumes the **context window** — the agent’s live workspace.  

### Context Window Token Allocation (Diagram Recreation)
```
Finite Context Window (e.g. 200k–1M tokens)
├── Fixed (always present)
│   ├── System Prompt + Custom Rules
│   └── Tool Definitions (MCP schemas)
├── Growing Linearly
│   ├── Conversation History
│   ├── Tool Results (file contents, terminal output, DB queries)
│   └── Agent’s Own Output (code it just wrote)
└── Danger Zone: >60% utilization → “context rot” (accuracy collapses)
```

**Key Insight from Post**  
- One large file read can eat thousands of tokens instantly.  
- Past ~60% utilization, more context actively harms performance (studies cited).  
- Even 1M-token windows don’t solve the problem — you must engineer **when** and **what** enters the window.  
- Linked deep-dive: [MorphLLM – Context Rot](https://www.morphllm.com/context-rot)

**Practical Rule**: Design every part of the harness to **inject the right context at the right moment** and **evict irrelevant data aggressively**.

## The Agent Harness: Four Levers You Must Master

### 1. Custom Rules (cursor/rules, AGENTS.md, CLAUDE.md, etc.)
Most accessible starting point. Injected at the start of **every** interaction.

#### What Belongs in Custom Rules
- Tech stack & architecture patterns  
- Naming conventions & code style  
- Testing philosophy (“always table-driven unit tests”)  
- Common codebase pitfalls  
- Anti-patterns (explicit “never do X”)  
- Security & compliance rules  

#### What Does NOT Belong
- Entire API docs (too verbose)  
- Obvious platitudes (“write clean code”)  
- Contradictory rules  
- Static reference material better suited for Skills  

**Pro Tips (Hyper-Detailed)**
- Keep total <500 lines.  
- Make modular: separate files (architecture.md, testing.md, security.md).  
- Use **few-shot examples** — models learn from examples 10× better than instructions.  
- Treat as living document: after every mistake, ask the agent “How should we improve the rules?”  
- Use conditional loading when possible (skills complement this).

### 2. MCP Servers (Model Context Protocol)
Plugins that extend the agent beyond filesystem + terminal.

**Capabilities Added**
- Query internal databases (schema + live data)  
- Search company wiki / Notion / Confluence  
- Look up internal API contracts  
- Interact with CI/CD pipelines  
- Pull Figma specs  
- Validate real business logic  

**Power**: Agent now has the same knowledge a senior engineer has — not just the repo.

### 3. Skills (The Most Powerful Lever)
A directory with `SKILL.md` entrypoint.  
Only a **short description** lives in context. Full content injected **on-demand** (user command `/skill-name` or agent auto-detects).

#### Two Flavors
- **Reference Skills**: pure knowledge (conventions, domain context, patterns)  
- **Task Skills**: step-by-step executable instructions + scripts  

**Superpowers**
- Can bundle & run scripts (infinite extensibility)  
- Run in isolated sub-agents (clean context window)  
- Composable and programmable  
- Keeps main context window tiny

### 4. Spec-Driven Development (SDD) – The Ultimate Harness
Biggest bottleneck isn’t the agent — it’s **vague human input**.

**Classic Failure Example**  
Prompt: “Make a new feature to add new items from the backoffice”  
→ Agent builds MVP, but forgets idempotency, role permissions, edge cases → duplicate inserts.

**Solution**: Write detailed specs **before** any code is generated.  
A great spec contains:
- Exact functional behavior  
- Integration points with existing code  
- Edge cases & invariants  
- Acceptance criteria  
- Test plan  

**Why SDD = Pure Context Engineering**  
The spec becomes a single artifact that compresses custom rules + architecture + validation into the agent’s context window in one shot.  
Bonus: You can have the agent **write the spec** first, then implement it.

(Note: Author promises a full follow-up post on SDD frameworks, upsides/downsides, and MercadoLibre scale implementation.)

## The Feedback Loop (Outside Context Engineering)
Tests, linters, type checkers, CI → structured pass/fail signals.  
Agent self-corrects without human intervention.

**Advanced Pattern**: **Agent Hooks**  
- User-defined commands that run at specific lifecycle points.  
- “Stop Hook” example: agent literally cannot finish until all checks pass.

## How MercadoLibre Does It at Scale (20k+ Devs)
- **Standardized Org-Level Rules** for 9+ tech stacks + internal libs. Teams inherit and layer repo-specific rules.  
- **Internal MCPs** for cloud platform, business context (RAG), SDKs.  
- **Custom Code Review Agents** in CI pipeline: every PR (human or AI) gets auto-analysis → prioritized findings → humans focus on architecture only.  
- **Spec-Driven Development** rollout (already 4,000 devs adopting).  

Result: faster reviews, consistent quality, safety net that scales with PR volume.

## Actionable Starter Checklist (Copy-Paste Ready)

```markdown
### Week 1 – Quick Wins
- [ ] Create repo-level AGENTS.md or cursor/rules with 5 core rules
- [ ] Add 3 few-shot examples
- [ ] Split into modular files if >200 lines
- [ ] Test with one small task and iterate rules

### Week 2 – Add Power
- [ ] Build first Skill (e.g., “DatabaseSchemaLookup”)
- [ ] Connect one internal MCP (wiki search or DB query)
- [ ] Write your first full Spec document for a real ticket

### Week 3 – Close the Loop
- [ ] Add linter/test hook in agent workflow
- [ ] Set up Stop Hook for validation
- [ ] Create Review Agent for PRs
```

**Recommended First Skill**: “Best Coding Practices” – bundle your company conventions + anti-patterns.

## Common Pitfalls & How to Avoid Them
- Overloading context window → use Skills + conditional rules  
- Vague prompts → enforce Spec-Driven Development  
- No feedback → implement hooks & review agents  
- Static rules that never improve → make rules living + agent-assisted  
- Ignoring legacy codebases → org-level base rules + repo overrides

## Bigger Picture & Mindset Shift
Context Engineering is an **emerging engineering discipline**.  
The winning teams won’t have the best model — they’ll have the **best-engineered harness**.  

Treat agents as brilliant team members that need proper onboarding, tools, supervision, and feedback — not magic black boxes.

## Related Concepts & Further Reading
- [MorphLLM Context Rot](https://www.morphllm.com/context-rot)  
- Reply mention: [Context Development Lifecycle – Tessl](https://tessl.io/blog/context-development-lifecycle-better-context-for-ai-coding-agents/)  
- Upcoming (author): Full SDD post + Feedback Loop deep-dive  

**Internal KB Cross-Links to Create**:
- [[Context-Rot-Deep-Dive]]
- [[Spec-Driven-Development-Template]]
- [[MCP-Implementation-Guide]]

## Personal Notes & Implementation Plan (Your Section)
*(Fill this in after reading)*  
- How will I apply this in my current project?  
- First rule I will add:  
- First Skill I will build:  
- Metrics I will track (consistency, PR acceptance rate, time saved):

## Version History
- **v1.0** – 2026-03-03 – Full extraction, diagram recreation, tables, checklist, actionable framework. Ready for daily use.

---

**Copy this entire Markdown into your knowledge base.**  
It is now self-contained, searchable, and ready to evolve as you implement the harness.  

Want me to generate:
- Ready-to-use AGENTS.md template  
- Sample Skill directory structure  
- Full Spec-Driven Development template  
- Or expand any section further?  

Just say the word and I’ll ship v1.1 instantly. Happy engineering! 🚀