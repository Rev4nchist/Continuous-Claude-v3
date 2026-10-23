Agentic Software Engineering

Note: this post is about building your own agents (agentic software engineering), not about using coding agents.
By now you've probably used a few agents, or at least heard of Claude Code, or OpenClaw. Ever wondered what it takes to build your own?
Most people think of agents as prompts + tools in a loop. That's a reasonable assumption, but it's not production architecture. 
The moment your agent needs to know who it's talking to, maintain state, handle concurrent requests, take sensitive actions, and survive failing tool calls, it stops being an "LLM + tools" and becomes a distributed system.
Building agents is the easy part. There are 75 frameworks that help you do that. The hard part is the runtime: the harness around the agent that makes it work in the real world. That's what agentic software engineering is all about.
Build. Serve. Connect.
Here's how I think about shipping agentic software.
Build the agent. Define the model, tools, knowledge base, memory, storage, and guardrails. This is the layer that most frameworks give you.
Serve it as an API. User-scoped, session-scoped, horizontally scalable. Add persistent storage, streaming, background execution, retry semantics. This is where most agentic products stall. Not because the agent doesn't work, but because it doesn't have the infrastructure around it to work reliably at scale.
Connect it to where users live. Your product, Slack, Discord, MCP, wherever. An agent in a notebook is an experiment. An agent where your users are is a product.
The 6 Pillars of Agentic Software
Building an agent is AI engineering. Running it in production is software engineering. Together, they form agentic software engineering: the practice of building, running, and scaling agents as production services. 
Here are the six pillars that hold it up:
Durability. Agents reason across multiple steps, call tools that time out, and fail halfway through. If your agent crashes on step 12 of 15, restarting might duplicate a side effect or lose critical context. Agentic software needs to pause, resume, checkpoint, and recover gracefully. Durability turns failure into resumption, not a full restart.
Isolation. Agentic software serves thousands of users simultaneously. Each user needs their own session, their own memory, their own context. Passing a user_id with each request is easy. Isolating every resource the agent touches is where the engineering comes in. Your database, your vector store, your model provider, all need to respect user boundaries. One missing filter becomes a data breach.
Governance. Agents that can act can also cause damage. Looking up a record is harmless. Deleting a record or issuing a refund needs approval. Agentic software needs layered authority: what runs automatically, what needs human approval, and what needs admin sign-off. Today, most agents auto-execute with minimal oversight. As they get more capable, governance becomes the product.
Persistence. An agent without persistent storage can't learn, can't build context, can't improve. We need to store sessions, memory, knowledge in a database. Persistent state is what turns a chatbot into a product. Every conversation makes the next one better.
Scale. A thousand users hit your agent at the same time. Requests queue, you hit model rate limits, and tool calls compete for resources. Traditional services call your own backends. Agentic software calls external model APIs and third-party tools, which means you inherit their rate limits, latency, and downtime. Scaling agentic software means scaling around dependencies you don't control.
Composability. When an agent is a service, other agents can call it. Your frontend can call it. Your Slack bot can call it. MCP clients can discover it. It becomes a building block in your architecture, and every new integration becomes a standard API call. That's how single-agent tools become multi-agent systems.
None of this is new. We've been building reliable distributed systems for decades. The AI industry just hasn't brought those lessons along yet, and we're feeling it in every failed deployment.
From Theory to Practice
As always, I come bearing code. Here's how you can start building your own agentic service today. 
bash
# 1. Clone the repo
git clone \
    https://github.com/agno-agi/agentos-docker-template.git \
    agentos

cd agentos

# 2. Set your model provider key
cp example.env .env
# Edit .env and add OPENAI_API_KEY

# 3. Start the application
docker compose up -d --build

# 4. Load documents for the knowledge agent
docker exec -it agentos-api python -m agents.knowledge_agent
This gives you a containerized service with persistent storage (Postgres), two starter agents (a knowledge agent using Agentic RAG and an MCP agent for external tool use), and a REST API you can connect to from anywhere.
I'm using Docker for this template because Docker runs everywhere: your laptop, AWS, GCP, Azure, Railway. The same container you develop locally is the one you deploy to production. The README covers everything you need to get started. 
After running the service:
Open http://localhost:8000/docs to see your API. 
Connect to the web UI at os.agno.com where you can chat with your agents, trace runs, manage knowledge, create schedules and approve sensitive tool calls. One UI for your agentic software.

Adding your own agent is a few lines of Python and a restart. Swap models with a one-line change. Add tools from 100+ integrations. The template is a starting point. Read the Agno docs to learn more.
Governance & Elicitation
Most agents run tool calls with minimal oversight or auditability. In practice, we need layered authority:
Tools that run freely
Tools that need user approval
Tools that need admin approval
Agents also need to ask questions (often called elicitation). The Claude Code team shared a great article on the AskUserQuestion tool used by Claude. 
This is available in Agno as `UserFeedbackTools`. Here's a support agent that can look up orders freely, ask the customer structured questions when it needs more information, and waits for user approval before issuing a refund:
python
support = Agent(
    id="support",
    name="Support",
    model=OpenAIResponses(id="gpt-5.2"),
    db=agent_db,
    tools=[
        lookup_order,             # auto-execute
        search_help_docs,         # auto-execute
        issue_refund,             # requires user confirmation
        UserFeedbackTools(),      # structured questions
    ],
    instructions=instructions,
    enable_agentic_memory=True,
)
Watch what happens when a customer asks for a refund. 
The agent looks up the order on its own, no permission needed. 
Then it hits a decision point: why does the customer want the refund?
Instead of guessing, it presents a structured question with clear options: defective, wrong item, changed mind. 
The customer picks one. Now the agent calls the refund tool, but because refunds carry real consequences, it pauses for user approval. 
Once approved, the agent runs the refund tool.
Three levels of agency in one conversation. You can view the full code here.

The agent knows when to act, when to ask, and when to wait. That's what governance looks like in practice. The runtime has to support all three modes, and the transitions between them have to feel natural.
Note: the approvals flow on the UI is actively being developed. The refund should wait for admin approval, not user approval. This is implemented on the SDK but not the UI yet. This is being fixed this week.
Agents are distributed systems
The 5 Levels describe how agentic software grows in capability (and complexity). The 7 Sins describe how they fail in production. The 6 Pillars describe what it takes to build them right.
The consistent message across all three: agentic software engineering is a discipline. The teams that internalize this early will ship great products. The teams that keep treating agents as scripts will continue to miss the mark.
Clone the repo. Build your first agent. Ship it where your users are.

Links:
[Agno Docs](https://docs.agno.com/)
[Agno Github](https://github.com/agno-agi/agno)
[AgentOS Templates](https://docs.agno.com/deploy)
[AgentOS Docker Template](https://github.com/agno-agi/agentos-docker-template)