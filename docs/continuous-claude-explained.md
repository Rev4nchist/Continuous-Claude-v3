# Continuous Claude — What It Is, In Plain English

*For business users, stakeholders, and anyone who wants to understand the setup without the engineering jargon.*

---

## The one-sentence version

**Continuous Claude turns a general-purpose AI coding assistant (Claude Code) into a workshop that remembers everything, has specialist helpers on call, follows your house rules automatically, and picks up right where it left off — across hours, days, and weeks of work.**

---

## The problem it solves

Out of the box, an AI assistant is a bit like hiring a talented contractor who shows up every morning with complete amnesia.

- They don't remember yesterday's decisions.
- They don't know which folders are important.
- They'll happily do something dangerous (delete a file, push broken code) because nobody told them not to.
- They re-learn the same things over and over.
- They get overwhelmed by big projects because they can only hold so much in their head at once.

Continuous Claude is the **scaffolding you build around that contractor** so they behave more like a senior team member who's worked with you for years.

---

## How the pieces fit together

Think of it as a workshop with six sections. Each one solves a specific problem.

### 1. A memory system — the "notebook that never forgets"

**What it is:** A searchable database of everything the AI has learned about your work.

**Analogy:** Imagine a notebook where every time you solve a tricky problem, make an architectural decision, or discover something weird about how your system works, the AI writes it down. Next time a similar question comes up — even months later, in a brand new session — the AI checks the notebook first.

**What gets remembered automatically:**
- "This bug was caused by X, and here's how we fixed it."
- "We chose Tool A over Tool B because of these specific tradeoffs."
- "On Windows, this particular thing breaks unless you do it this way."
- "The user prefers concise responses, no summaries at the end."

**Why it matters:** The AI stops repeating the same mistakes. It stops re-asking the same clarifying questions. Every session builds on the last one instead of starting from zero.

---

### 2. Specialist helpers — the "expert team on call"

**What it is:** A roster of pre-built AI specialists, each with a narrow job.

**Analogy:** Instead of asking one generalist "please do everything," you ask a coordinator who dispatches the right specialist for each piece of work. There are:

- A **researcher** who reads documentation and reports back.
- A **code explorer** who maps out how existing code works.
- An **implementer** who writes new code carefully (tests first, then code).
- A **quick-fix specialist** for small tweaks.
- A **debugger** who investigates bugs without jumping to conclusions.
- A **reviewer** who critiques work for quality.
- A **test runner** who exercises the code.
- A **browser driver** who clicks through your actual website to verify it works.
- Several others — roughly 30 specialists in total.

**Why it matters:** Each specialist stays focused on what they're good at. The main conversation stays clean because the specialists work in the background and report summaries back. It's the difference between one tired generalist and a well-rested team.

---

### 3. Behavior guards — the "autopilot and safety rails"

**What it is:** Small automated rules that fire at specific moments to keep the AI on track.

**Analogy:** Think of the lane-assist and automatic emergency braking in a modern car. You're still driving, but the car prevents a class of mistakes automatically.

**Examples of what the guards do:**

- **Before installing a software package**, a guard checks a list of known-malicious packages and recent supply-chain attacks. Blocks the install if something's wrong.
- **Before making a dangerous change** (deleting files, rewriting history), the AI is forced to ask you first.
- **After editing certain kinds of files**, the guards automatically run quality checks (formatting, type-checking) so errors are caught immediately.
- **When you start a new session**, the guards automatically load in the memory notebook, your project map, and the current goals — so the AI comes back warmed up.
- **When you approach the end of a work session**, the guards remind the AI to save progress in a "handoff note" so nothing gets lost.

There are about 90 of these tiny automated routines running quietly in the background. Most of them you'll never see unless one blocks something dangerous.

**Why it matters:** You get the speed of an AI assistant without the usual risk of "it did something irreversible while I wasn't looking."

---

### 4. Skills — the "pre-written playbooks"

**What it is:** Named recipes for common tasks. Invoked either by a command (like `/commit` or `/rlm-analyze`) or automatically when the AI notices the task fits.

**Analogy:** Think of a chef's mise en place — pre-measured, pre-organized ingredients and instructions for common dishes. Instead of improvising every time, the chef reaches for the labeled container.

**Examples of skills that exist today:**

- `/commit` — stages changes and writes a clean git commit message.
- `/recall` — searches the memory notebook for anything relevant to your current question.
- `/rlm-analyze` — deep-analyzes a huge document, folder, or codebase (the newest one, just built).
- `/ralph` — autonomous mode that takes a spec and builds the feature using the specialist team.
- `/fix`, `/build`, `/refactor`, `/review`, `/release` — workflows for common development phases.

There are 150+ skills in total. Most of them trigger automatically when the AI notices the right context.

**Why it matters:** You don't have to remember how to do things. The AI has a muscle memory for the common moves.

---

### 5. Knowledge tree — the "project map"

**What it is:** An auto-generated map of your project — what folders do what, where the important files are, what depends on what.

**Analogy:** A real estate floor plan. Before you send a contractor into a house, you hand them the floor plan so they know where the load-bearing walls are.

**Why it matters:** When you ask "add a new API endpoint," the AI instantly knows which folder, which patterns your project already uses, and where the tests go. It stops having to re-discover the layout every session.

---

### 6. Roadmap + session continuity — the "where were we?"

**What it is:** A running document of current goals, recent decisions, and session handoff notes.

**Analogy:** The whiteboard in a war room. Today's objectives, what's done, what's blocked, who's working on what. When the team shifts, the next person reads the whiteboard and gets up to speed in 30 seconds.

**Why it matters:** When a long task spans multiple sessions (days, weeks), you don't lose context. Start a new session, and within a few seconds the AI has reconstructed "we were building X, we just finished Y, next step is Z."

---

## What a day working with this looks like

**Morning — start a new session.** Within the first few seconds, the AI has:
- Loaded your project map.
- Checked for any leftover work from yesterday.
- Pulled up the 3-5 most relevant lessons from past sessions.
- Greeted you with a quick status.

**You ask for something.** Let's say: "Find all the places in our codebase where we talk to the payment provider, and summarize the error handling."

Behind the scenes:
- The AI notices this is a "research over a big codebase" task and delegates to the code-exploration specialist.
- The specialist uses a dedicated code-analysis tool (faster and more accurate than brute-force searching) to find the relevant files.
- Results come back as a summary, not a dump of raw code.
- If the answer needs to span many files, the new "Recursive Language Models" capability kicks in — loading the entire relevant corpus into a sandboxed Python environment where the AI can write code to filter, count, and aggregate.

**You ask for a change.** The AI proposes a plan first. You approve. Now it switches to a more careful mode:
- Any risky actions require your confirmation.
- After writing code, quality checks run automatically.
- A testing specialist runs the tests.
- A reviewing specialist critiques the output.
- Only when everything's green does the AI say "done."

**End of session.** The AI writes a handoff note with what was done, what's next, any blockers. Tomorrow (or next week), whoever starts the next session picks up in less than a minute.

---

## The business-level benefits

| Without Continuous Claude | With Continuous Claude |
|---|---|
| Every session starts from zero | Sessions build on each other |
| The AI forgets past decisions and repeats mistakes | Past decisions are remembered and cited |
| The AI might take dangerous actions | Safety guards catch risky moves before they happen |
| Big projects overwhelm the AI's memory | Specialists handle sub-tasks; the main thread stays coherent |
| You become the bottleneck in re-explaining context | The system re-loads context automatically |
| Quality is inconsistent | Every change runs through quality checks |
| Work can disappear when a session ends | Handoff notes ensure nothing is lost |
| One AI setup per machine, no sharing | Rules, skills, and memory are versioned and shared across machines |

---

## The Recursive Language Models addition (what we just built)

Traditional AI assistants choke on very large inputs — a 500-page PDF, an entire codebase, a corpus of hundreds of files. You either have to:
- **Feed it in chunks** (and lose the big picture), or
- **Use search to find relevant bits** (and miss connections the search didn't anticipate).

The new capability uses a technique from MIT researchers: instead of stuffing the big document into the AI's memory, it loads the document into a sandboxed Python environment. The AI then writes code (in a safe, isolated container) to filter, count, aggregate, and cross-reference across the whole thing — **without the document ever touching the AI's short-term memory.**

**The payoff:** questions like "find every safety check across our entire rulebook and group them by severity" — which would have been impossible without extensive pre-indexing — now run in a single command.

Usage: `/rlm-analyze <path> "<your question>"`

This works in any project directory, not just this one.

---

## A glossary, for when you hear these terms

| Term | Plain English |
|---|---|
| **Session** | One continuous conversation with the AI. A single back-and-forth thread. |
| **Memory** / **archival memory** | The notebook of past learnings, searchable across sessions. |
| **Skill** | A named recipe / playbook, either invoked by command or auto-triggered. |
| **Agent** / **subagent** | A specialist AI helper with a focused job. |
| **Hook** | A small automated rule that fires at a specific moment (before a tool use, after a file edit, etc.). |
| **MCP** | The protocol that lets the AI talk to outside services (GitHub, databases, browsers, etc.). Stands for Model Context Protocol. You don't need to care about the details. |
| **Handoff** | A document summarizing where a work session left off, so the next session can resume. |
| **Docker sandbox** | An isolated container — like a disposable virtual computer — where the AI can safely run code without affecting your real machine. |
| **Roadmap** | The living goals/status document for the current project. |
| **Knowledge tree** | The auto-generated map of a project's structure. |
| **Claude Code** | The underlying Anthropic product we're extending. It's an AI coding assistant that runs in your terminal. |
| **Continuous Claude** | This whole system of memory, skills, agents, guards, and processes that extends Claude Code into something more reliable and long-term. |

---

## How it stays in sync across machines

The whole setup lives in a single Git repository. Every change you make is tracked. When you set up a new laptop, you clone the repository and run a single setup script — within a few minutes the new machine has everything: the rules, the skills, the memory pipeline, the specialists, the safety guards. You can switch between home and work laptops and pick up exactly where you left off.

---

## The honest caveats

- **It's built for a software-development audience.** The AI is still primarily writing, reading, and reasoning about code. It's not a replacement for business software like Salesforce or Excel.
- **It needs Docker installed and a Claude API key with credit.** The safety sandbox and the AI calls both cost money — modest amounts, but not free.
- **Some of the behind-the-scenes machinery is intricate.** If something breaks, a developer usually has to diagnose it. The system is designed to fail safely (block a bad action, fall back to a simpler path) rather than silently produce bad output.
- **It works best when you describe problems in natural language** — ask for what you want to accomplish, not how. The system picks the right tools.

---

## If you want to see it in action

Open a terminal, `cd` into any project, type `claude`, and start talking. Within the first few seconds you'll see:
- A banner showing memory hits, roadmap status, and loaded context.
- A list of available skills and agents.
- An invitation to state what you're trying to accomplish.

From there, the system does its work quietly in the background while you collaborate.
