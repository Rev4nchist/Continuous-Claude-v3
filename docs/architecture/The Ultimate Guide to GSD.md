## **The Ultimate Guide to GSD (Get Shit Done): The Experimental AI Coding Framework**

GSD is a lightweight yet powerful meta-prompting, context engineering, and spec-driven development system designed to bridge the gap between "vibe coding" (coding without a plan) and over-engineered, rigid frameworks. It is optimized for three harnesses: **Claude Code, OpenCode, and Gemini.**

---

### **1. Core Philosophy: Experiment & Iterate**

GSD is built for projects where you aren't 100% sure what to build yet and requirements are likely to change. 

| Feature | GSD Philosophy | Traditional "Rigid" Frameworks |
| :--- | :--- | :--- |
| **Approach** | Experiment & Iterate | Pre-plan & Rigid Roadmap |
| **Workflow** | Build quick MVP -> Test -> Pivot Fast | Define full spec -> Build Architecture -> Ship Final |
| **Planning** | Plans each step one at a time | Locked into every phase upfront |
| **Best For** | Experimental/Novel projects | Conventional systems (CRMs, Platforms) |

---

### **2. Key Technical Advantages**

*   **Context Rot Prevention:** GSD prevents "context rot" (quality degradation as an LLM's context window fills up) by spawning **subagents** for isolated tasks. This keeps the main orchestrator agent's context clean and focused.
*   **XML-Tagged Prompts:** Unlike standard Markdown prompts, GSD uses XML tags. Claude models parse complex, hierarchical instructions more accurately when they are structured in XML.
*   **Adversarial Planning:** It doesn't just create a plan; it uses a `gsd-plan-checker` agent to stress-test the plan across 8 dimensions before execution begins.
*   **Model Optimization:** GSD automatically maps specific sub-tasks to the most cost-effective model (e.g., using Sonnet for research synthesis instead of the more expensive Opus).

---

### **3. Installation & Setup**

Run the following command in your project directory:

```bash
npx get-shit-done-cc@latest
```

**Configuration Choices:**
1.  **Runtime:** Choose your AI agent from Claude Code, OpenCode, or Gemini.
2.  **Scope:** 
    *   **Global:** Available in all projects.
    *   **Local:** Specific to the current project (Recommended for varied project requirements).

Once installed, GSD files are stored in a `.claude` or `.agent` folder containing `agents`, `commands`, and `hooks`.

---

### **4. The GSD Workflow: From Idea to Implementation**

#### **Step 1: Initialization**
Run the command:
```bash
/gsd:new-project
```
The agent will explore your codebase. If you have an existing project, it can run `gsd-codebase-mapper` to understand your current architecture.

#### **Step 2: Questioning & Scoping**
GSD conducts a unique Q&A session. Unlike other frameworks that focus on "how it might break," GSD focuses on **"what to build."** 
*   **Target Audience:** Who is this for?
*   **Pain Points:** What problem are we solving?
*   **Core Features:** What are the non-negotiables?
*   **User Flow:** How does the user navigate the app?

#### **Step 3: The PROJECT.md File**
Based on your answers, GSD generates a `PROJECT.md` in the `.planning` folder. This file is kept **deliberately short and focused** to prevent agent deviation. It covers:
*   Project description and core values.
*   "Out of Scope" items to prevent feature creep.
*   Key architectural decisions.

#### **Step 4: Parallel Research**
GSD spawns four researcher agents in parallel to investigate:
1.  **Stack Research:** Best libraries and tools.
2.  **Features Research:** How to implement specific functionalities.
3.  **Architecture Research:** Structure and patterns.
4.  **Pitfalls Research:** Known issues and "things to watch out for."

The `gsd-research-synthesizer` then condenses these findings into a `RESEARCH.md` file.

#### **Step 5: Requirements & Roadmap**
GSD identifies the **MVP (v1) requirements.** It asks targeted questions to prune the feature list to only what is essential for a fast launch. It then generates a **Roadmap Structure** broken into phases (e.g., Phase 1: Foundation and Shell).

#### **Step 6: Phase Implementation (The "Discuss-Plan-Execute" Loop)**
For each phase, GSD follows a structured sub-workflow:
1.  **`/gsd:discuss-phase [X]`**: A questioning session to clarify specific implementation details for the current phase.
2.  **Context Generation**: Creates a `CONTEXT.md` for that specific phase.
3.  **Adversarial Planning**: `gsd-planner` creates the plan, and `gsd-plan-checker` verifies it.
4.  **Wave Execution**: The plan is broken into "waves"—sequential tasks for dependency handling and parallel tasks for speed.
5.  **`/gsd:execute-phase [X]`**: The `gsd-executor` carries out the coding tasks.

#### **Step 7: Verification**
After coding, GSD runs automated tests. It often uses **Playwright** for visual verification to ensure the UI matches the intended design. The `gsd-verifier` then cross-checks the implementation against the original goals.

---

### **5. When to Use GSD**

| Use GSD When... | Avoid GSD When... |
| :--- | :--- |
| Building a custom/novel solution from scratch. | Building a simple app with few features (Overkill). |
| Requirements are fluid and likely to change. | Requirements are 100% fixed and highly conventional. |
| You need a fast, functional MVP. | The cost of a missed edge case is catastrophic (Use TDD-focused frameworks like **Superpowers**). |
| Working on a large-scale, complex application. | You prefer "vibe coding" without any structured planning. |

**Pro Tip:** You can use GSD to build the **Core Functionality** (Phase 1-2) of an app for fast experimentation, then hand off the project to a more rigid, TDD-focused framework like **Superpowers** to harden and extend the application for production readiness.