Here is a hyper-detailed outline based on the transcript provided.

# The New Stack of Prompting: Post-February 2026 Framework

## I. Introduction: The Paradigm Shift
*   **The Provocation:** If you are prompting like it is 2024/2025, you are already obsolete.
*   **The Context (Jan 2026):** Release of Opus 4.6, Gemini 3.1 Pro, the GPT-5.3 release.
*   **The Core Change:** Models have shifted from **Chat Partners** to **Autonomous Agents**.
    *   Agents work autonomously for hours, days, or weeks.
    *   Traditional "chat-based" prompting (synchronous iteration) is functionally obsolete for serious work.
*   **The Consequence:** A widening 10x gap between those practicing old prompting methods and those using the new "Full Stack."

## II. The "Tuesday Morning" Thought Experiment
*   **Scenario:** Two users, same model, same subscription, same task (create a PowerPoint deck).
*   **Person A (2025 Skills):**
    *   Method: Chat window, types request, reads output, iterates in real-time.
    *   Result: 80% correct, spends 40 mins cleaning up. Saves ~50% time.
    *   Bottleneck: Human presence required for course correction.
*   **Person B (2026 Skills):**
    *   Method: Writes a structured **specification** (takes 11 mins). Hands off to agent. Leaves to get coffee.
    *   Result: Completed deck hitting every quality bar.
    *   Scale: Can execute 5 other decks simultaneously before lunch.
    *   **Outcome:** A week's worth of work done in a morning.

## III. The Four Disciplines of Prompting
*   *Thesis:* Prompting has diverged into four distinct layers. You must master all four.

### Layer 1: Prompt Craft (The Foundation)
*   **Definition:** The broad skill of providing input to AI systems for synchronous, session-based tasks.
*   **Status:** **Table Stakes.** (Equivalent to touch-typing in the 90s; necessary but not a differentiator).
*   **Key Components:**
    1.  Clear instructions.
    2.  Relevant examples and counter-examples.
    3.  Appropriate guardrails.
    4.  Explicit output formatting.
    5.  Conflict/Ambiguity resolution instructions.
*   **Limitation:** Relies on the human being the "quality layer" in real-time. Fails for long-running autonomous tasks.

### Layer 2: Context Engineering (What to Know)
*   **Definition:** Strategies for curating and maintaining the optimal set of tokens during a task.
*   **Core Concept (Tobi Lütke/Shopify):** The ability to state a problem with enough context that it is solvable without further input.
*   **The Mechanism:**
    *   Managing System Prompts, Tool Definitions, RAG Pipelines, and Message History.
    *   *The Ratio:* The user prompt might be 0.02% of tokens; Context is the other 99.98%.
*   **The Challenge:** LLM performance degrades as context grows (retrieval quality drops).
*   **Goal:** Curating the *right* tokens, not just *more* tokens.

### Layer 3: Intent Engineering (What to Want)
*   **Definition:** Encoding organizational purpose, goals, values, and trade-off hierarchies into infrastructure.
*   **The Difference:** Context tells the agent *what to know*; Intent tells the agent *what to want*.
*   **Case Study: Klarna:**
    *   *Success:* Resolved 2.3M conversations, slashed resolution times.
    *   *Failure:* Optimized for speed over satisfaction (wrong intent), leading to trust issues and rehiring humans.
*   **Application:** Translating strategy into objectives and verifiable guardrails that an agent can value.

### Layer 4: Specification Engineering (The New Frontier)
*   **Definition:** Writing documents across an organization that autonomous agents can execute against over extended time horizons.
*   **The Shift:** Moving from fixing errors in real-time (Chat) to getting the spec right upfront (Engineering).
*   **Scope:** Viewing the entire corporate document corpus (Strategy, OKRs, Product Specs) as "Agent-Readable" specifications.
*   **Benefit:** Enables the "Planner-Worker" architecture where agents can run without human intervention.

## IV. The 5 Primitives of Specification Engineering
*   *How to actually learn and practice Layer 4.*

### Primitive 1: Self-Contained Problem Statements
*   **Concept:** Removing "implicit context" (assumptions humans make that machines miss).
*   **The Test:** Rewrite a request (e.g., "Update Q3 Dashboard") for a recipient who has never seen the dashboard, doesn't know the org chart, and has no database access.
*   **Goal:** Surface hidden assumptions and articulate constraints explicitly.

### Primitive 2: Acceptance Criteria
*   **Concept:** Defining exactly what "Done" looks like so the agent knows when to stop.
*   **The Problem:** Without criteria, agents stop based on statistical plausibility (guessing), not completion.
*   **The Technique:** Write 3 sentences that an independent observer could use to verify the output without asking the author any questions.

### Primitive 3: Constraint Architecture
*   **Concept:** Giving the agent a framework for decision-making.
*   **The Four Categories:**
    1.  **Musts:** Non-negotiables.
    2.  **Must Nots:** Forbidden actions.
    3.  **Preferences:** How to choose between multiple valid approaches.
    4.  **Escalation Triggers:** When to stop and ask a human (crucial for autonomy).
*   **Implementation:** The `.claud.md` pattern (concise, high-signal rule files).

### Primitive 4: Decomposition
*   **Concept:** Breaking large tasks into sub-2-hour execute/verify loops.
*   **Software Engineering Principle:** Modularity applied to AI tasks.
*   **The Workflow (The Anthropic Pattern):**
    1.  **Environment Setup:** Initializer Agent.
    2.  **Plan:** Progress log documentation.
    3.  **Execution:** Incremental coding session.
*   **Goal:** Create "break patterns" that Planner Agents can use to reliably split up work.

### Primitive 5: Eval (Evaluation) Design
*   **Concept:** Systematically measuring if the output is good (not just "looks reasonable").
*   **Necessity:** The only defense against bad output in long-running processes.
*   **The Technique:** For every recurring task, build 3-5 test cases with known good outputs. Run these after every model update to catch regressions.

## V. Conclusion & Implementation Strategy
*   **The Impact:** Better specification engineering leads to better human-to-human communication and reduced organizational politics (which is just "bad context engineering").
*   **How to Start (The Learning Path):**
    1.  **Close the Prompt Craft Gap:** Do tutorials, build a baseline library of prompts.
    2.  **Build Personal Context Layer:** Write down your personal goals, constraints, and quality standards (your own `.md` file).
    3.  **Practice Specification:** Take a *real* project (not a toy), write a full spec using the 5 Primitives, and hand it to an agent.
    4.  **Scale to Org:** Begin treating all business processes as specifiable, agent-readable workflows.
*   **The Opportunity:** One-person businesses have a massive advantage (easier to convert all context to agent-readable formats quickly).
*   **Final Warning:** Do not tolerate your natural ceiling. These are learnable skills required for the future of work.