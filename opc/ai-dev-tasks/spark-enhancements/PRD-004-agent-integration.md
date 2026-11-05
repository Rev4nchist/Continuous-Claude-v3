# PRD-004: AI Agent Integration

**Version:** 1.0
**Created:** 2026-01-21
**Status:** Draft
**Priority:** Critical

---

## Executive Summary

Integrate an AI agent system into SPARK Platform using the Claude Agent SDK, providing executives and EAs with an intelligent assistant for meeting preparation, action extraction, decision analysis, and proactive follow-up. The agent operates through a persistent sidebar panel with multiple specialized modes, full platform context access, and an approval-based workflow for all agent-initiated changes.

---

## Vision Statement

Transform executive leadership workflows by embedding AI intelligence throughout the meeting lifecycle. The agent becomes a tireless assistant that prepares briefings before meetings, captures commitments during meetings, tracks accountability after meetings, and surfaces patterns across the organizational decision-making history. Every interaction respects human authority through a "draft and approve" model.

---

## Problem Statement

Executive Assistants and leaders currently face significant manual overhead:

- **Meeting preparation takes hours** - Gathering context, reviewing past decisions, checking open actions
- **Action extraction is error-prone** - Important commitments get missed or misattributed
- **Follow-up tracking is manual** - No proactive nudging when items go stale
- **Pattern recognition is impossible** - Cannot see decision trends across months of meetings
- **Institutional knowledge is siloed** - Hard to surface "we discussed this before" moments

---

## User Personas and Jobs-to-be-Done

### Shannon (Executive Assistant)

**Role:** EA supporting CEO and ELT
**Goals:**
- Prepare comprehensive briefings before each meeting
- Ensure all action items are captured and assigned
- Track follow-ups without micromanaging
- Maintain organizational memory across meetings

**Jobs-to-be-Done:**
1. "Prepare Alex for the 2pm Board meeting with relevant context"
2. "Extract all commitments from todays ELT meeting"
3. "Remind Jordan about the overdue budget review action"
4. "Find when we last discussed the Q3 hiring plan"

### Alex (CEO)

**Role:** Chief Executive, chairs ELT meetings
**Goals:**
- Enter meetings fully briefed
- Make informed decisions with historical context
- Ensure decisions translate to actions
- See strategic patterns across meetings

**Jobs-to-be-Done:**
1. "Brief me on what happened in meetings I missed this week"
2. "What decisions have we made about international expansion?"
3. "Who owns the customer retention initiative and whats the status?"
4. "Show me decision velocity trends for the leadership team"

### Jordan (CFO)

**Role:** Chief Financial Officer, owns budget decisions
**Goals:**
- Track financial commitments across meetings
- Ensure budget decisions have clear rationale
- Audit trail for governance and compliance
- Pattern analysis on spending decisions

**Jobs-to-be-Done:**
1. "Summarize all budget-related decisions from Q4"
2. "What financial commitments did we make in the last board meeting?"
3. "Draft a follow-up message to department heads about budget submissions"
4. "Analyze patterns in our capital allocation decisions"

---

## User Stories

| ID | Role | Story | Priority |
|----|------|-------|----------|
| US-1 | EA | I want to open the agent sidebar and ask "prepare a briefing for the 2pm meeting" | Must Have |
| US-2 | EA | I want to select "Meeting Prep" mode so the agent knows what type of help I need | Must Have |
| US-3 | EA | I want to select which meeting to focus on as context for my query | Must Have |
| US-4 | CEO | I want the agent to stream responses so I see output immediately | Must Have |
| US-5 | EA | I want the agent to propose action items for my approval before creating them | Must Have |
| US-6 | EA | I want to review, edit, and approve agent-proposed changes in-line | Must Have |
| US-7 | CFO | I want all agent-created items tagged so I know what the AI generated | Must Have |
| US-8 | EA | I want the agent to auto-extract actions when a meeting ends | Should Have |
| US-9 | EA | I want automatic reminders when action items are approaching due dates | Should Have |
| US-10 | CEO | I want weekly digest emails summarizing open items and upcoming meetings | Should Have |
| US-11 | EA | I want the agent to suggest due dates based on meeting patterns | Could Have |
| US-12 | CFO | I want the agent to identify related past decisions when I ask about a topic | Should Have |
| US-13 | EA | I want my chat history preserved so I can reference previous conversations | Should Have |
| US-14 | CEO | I want to ask questions about trends across all my meetings | Could Have |
| US-15 | EA | I want quick action buttons for common requests like "summarize this meeting" | Should Have |

---

## System Architecture

### High-Level Architecture

```
+-------------------+     +-------------------+     +-------------------+
|   Agent Sidebar   |---->|   Agent API       |---->|   Claude SDK      |
|   (React)         |     |   (Next.js)       |     |   (Anthropic)     |
+-------------------+     +-------------------+     +-------------------+
         |                        |                        |
         v                        v                        v
+-------------------+     +-------------------+     +-------------------+
|   Chat State      |     |   Platform MCP    |     |   Claude Models   |
|   (React Query)   |     |   (Tools Server)  |     |   (claude-sonnet) |
+-------------------+     +-------------------+     +-------------------+
                                  |
                                  v
                          +-------------------+
                          |   SPARK Database  |
                          |   (PostgreSQL)    |
                          +-------------------+
```

### Component Breakdown

**Frontend:**
- Agent Sidebar - Collapsible panel component
- Mode Selector - Dropdown for agent skills/modes
- Context Selector - Scope picker (meeting, date range, etc.)
- Chat Interface - Message list with streaming support
- Approval Cards - Inline approve/edit/reject UI
- Quick Actions - Common task buttons

**Backend:**
- Agent API Route - Streaming endpoint for chat
- Platform MCP Server - Tools for agent to access SPARK data
- Event Hooks System - Triggers for automated agent actions
- Approval Queue - Pending agent-proposed changes

**Integration:**
- Claude Agent SDK - Core AI interaction layer
- Anthropic API - Model access (claude-sonnet-5-5)

---

## Functional Requirements

### FR-1: Interactive Agent Sidebar

| Req ID | Requirement | Acceptance Criteria |
|--------|-------------|---------------------|
| FR-1.1 | Persistent sidebar panel (collapsible) | Toggle button in header, remembers state |
| FR-1.2 | Sidebar width: 400px, resizable | Drag handle for width adjustment |
| FR-1.3 | Collapse to icon-only state | Minimized indicator when collapsed |
| FR-1.4 | Keyboard shortcut to toggle (Cmd/Ctrl + J) | Standard IDE-like shortcut |
| FR-1.5 | Sidebar available on all authenticated pages | Consistent experience across platform |

### FR-2: Mode Selector

| Req ID | Requirement | Acceptance Criteria |
|--------|-------------|---------------------|
| FR-2.1 | Dropdown menu for mode selection | Visual indicator of current mode |
| FR-2.2 | Mode: General Assistant | Flexible Q&A about platform data |
| FR-2.3 | Mode: Meeting Prep | Generates briefings with context |
| FR-2.4 | Mode: Action Extractor | Parses text for commitments |
| FR-2.5 | Mode: Decision Analyzer | Finds related decisions, patterns |
| FR-2.6 | Mode: Follow-up Nudger | Drafts reminder messages |
| FR-2.7 | Mode affects system prompt and available tools | Different behavior per mode |

### FR-3: Context Selector

| Req ID | Requirement | Acceptance Criteria |
|--------|-------------|---------------------|
| FR-3.1 | Context dropdown with scope options | Clear indication of current scope |
| FR-3.2 | Option: Current page context | Auto-detect meeting/action/decision page |
| FR-3.3 | Option: Specific meeting | Meeting selector dropdown |
| FR-3.4 | Option: Meeting series | Filter to recurring meeting pattern |
| FR-3.5 | Option: Date range | Start/end date picker |
| FR-3.6 | Option: All data | Full platform access (with warning) |
| FR-3.7 | Context affects what data agent can access | Scoped tool responses |

### FR-4: Chat Interface

| Req ID | Requirement | Acceptance Criteria |
|--------|-------------|---------------------|
| FR-4.1 | Message input with send button | Enter to send, Shift+Enter for newline |
| FR-4.2 | Streaming response display | Tokens appear as generated |
| FR-4.3 | Message history scrollable | Auto-scroll to latest, manual scroll up |
| FR-4.4 | Copy message content | Copy button on each message |
| FR-4.5 | Markdown rendering in responses | Support lists, bold, code, tables |
| FR-4.6 | Loading/thinking indicator | Spinner or dots while processing |
| FR-4.7 | Error state handling | Clear error messages, retry option |
| FR-4.8 | Clear conversation button | Reset chat with confirmation |

### FR-5: Quick Action Buttons

| Req ID | Requirement | Acceptance Criteria |
|--------|-------------|---------------------|
| FR-5.1 | Quick actions shown above input | Contextual to current page |
| FR-5.2 | On Meeting page: "Summarize", "Extract Actions", "Draft Follow-up" | Pre-filled prompts |
| FR-5.3 | On Actions page: "Find Overdue", "Suggest Priorities" | Action-specific helpers |
| FR-5.4 | On Decisions page: "Find Related", "Analyze Patterns" | Decision-specific helpers |
| FR-5.5 | Quick actions adapt to selected mode | Different actions per mode |

### FR-6: Approval Cards (Create with Approval)

| Req ID | Requirement | Acceptance Criteria |
|--------|-------------|---------------------|
| FR-6.1 | Agent-proposed items render as approval cards | Distinct visual treatment |
| FR-6.2 | Card shows: type, title, key fields preview | Enough info to evaluate |
| FR-6.3 | Approve button - creates item as proposed | Single click confirmation |
| FR-6.4 | Edit and Approve button - opens edit modal | Modify before creating |
| FR-6.5 | Reject button - dismisses proposal | With optional feedback |
| FR-6.6 | Bulk approve for multiple proposals | "Approve All" option |
| FR-6.7 | All approved items tagged "AI-assisted" | Visual badge on created items |

### FR-7: Chat History Persistence

| Req ID | Requirement | Acceptance Criteria |
|--------|-------------|---------------------|
| FR-7.1 | Chat history saved per user | Stored in database |
| FR-7.2 | History persists across sessions | Available on return visit |
| FR-7.3 | Conversation list in sidebar | Switch between past chats |
| FR-7.4 | New conversation button | Start fresh context |
| FR-7.5 | Delete conversation option | Remove from history |
| FR-7.6 | Auto-title conversations | Generated from first message |

### FR-8: Event-Driven Hooks

| Req ID | Requirement | Acceptance Criteria |
|--------|-------------|---------------------|
| FR-8.1 | Hook: Meeting Completed | Trigger when meeting marked complete |
| FR-8.2 | Meeting Complete Action: Auto-extract actions/decisions | Proposals queued for approval |
| FR-8.3 | Hook: Action Item Created | Trigger on new action item |
| FR-8.4 | Action Created Action: Suggest due date and priority | Based on meeting patterns |
| FR-8.5 | Hook: Due Date Approaching | Trigger N days before due |
| FR-8.6 | Due Date Action: Notify owner via in-app + email | Configurable timing |
| FR-8.7 | Hook: Weekly Digest (scheduled) | Trigger Sunday evening |
| FR-8.8 | Digest Action: Summary email of open items, upcoming meetings | Per-user digest |
| FR-8.9 | Hook: Stale Item Detection | Trigger when action not updated in X days |
| FR-8.10 | Stale Action: Alert assignee and stakeholders | Configurable threshold |
| FR-8.11 | Hooks are user-configurable (on/off) | Settings page controls |

### FR-9: Agent Skills/Modes Detail

**Meeting Prep Mode:**
- Input: Target meeting
- Output: Briefing document with:
  - Meeting series history (last 3 meetings summary)
  - Open action items for attendees
  - Relevant recent decisions
  - Attendee context (role, recent contributions)
  - Suggested agenda topics based on open items

**Action Extractor Mode:**
- Input: Meeting notes (from Tiptap editor or transcript)
- Output: List of proposed action items with:
  - Extracted title/description
  - Suggested owner (from mentions or context)
  - Suggested due date (relative to meeting patterns)
  - Suggested priority
  - Source quote from notes

**Decision Analyzer Mode:**
- Input: Topic or question
- Output: Analysis including:
  - Related past decisions (semantic search)
  - Decision timeline
  - Key participants in related decisions
  - Patterns or contradictions identified
  - Suggested considerations for new decision

**Follow-up Nudger Mode:**
- Input: Action item or person
- Output: Draft message including:
  - Context summary
  - Specific ask
  - Due date reminder
  - Stakeholder impact note
  - Suggested tone (gentle/firm based on overdue status)

**Strategic Insights Mode:**
- Input: Timeframe or topic area
- Output: Analysis including:
  - Decision velocity (decisions per week/month)
  - Action completion rates
  - Topic clustering
  - Participant engagement patterns
  - Recommendations for process improvement

---

## Non-Functional Requirements

| Category | Requirement | Target |
|----------|-------------|--------|
| Performance | First token latency | < 1 second |
| Performance | Token generation rate | > 30 tokens/second perceived |
| Performance | Context window management | Truncate/summarize for long contexts |
| Reliability | Error handling | Graceful degradation, retry logic |
| Reliability | Offline behavior | Clear messaging, queue actions |
| Scalability | Concurrent users | Support 100+ simultaneous agent sessions |
| Cost | Token usage optimization | Efficient prompts, caching where possible |
| Security | Data access scoping | User can only access their authorized data |
| Security | Audit logging | All agent actions logged |
| Security | Rate limiting | Prevent abuse, token budget per user |

---

## Security and Privacy Considerations

### Role-Based Context Scoping

- Agent can only access data user has permission to view
- Context selector limited by user role
- Organization boundaries enforced
- Meeting access respects invite lists

### Audit Trail

- All agent conversations logged with:
  - User ID, timestamp, messages
  - Context scope
  - Tools invoked
  - Items proposed
  - Approval/rejection decisions
- Audit log accessible to org admins
- Retention policy: 2 years minimum

### Prompt Security

- No sensitive data in system prompts
- User input sanitized before API calls
- PII handling per privacy policy
- No credentials or secrets in context

### API Security

- API key stored in environment, never exposed to client
- Request signing/validation
- Rate limiting per user (e.g., 100 requests/hour)
- Token budget per user per day

---

## UI/UX Specifications

### Sidebar Layout

```
+------------------------------------------+
| SPARK Agent                        [_][X]|
| Mode: [Meeting Prep v]                   |
| Context: [ELT Weekly - Jan 15 v]         |
+------------------------------------------+
| [Conversations v]  [+ New]               |
+------------------------------------------+
|                                          |
| User: Prepare a briefing for the         |
|       2pm board meeting                  |
|                                          |
| Agent: Preparing briefing for Board      |
|        Meeting (Jan 21, 2pm)...          |
|                                          |
|   ## Meeting Context                     |
|   - Last board meeting: Dec 15           |
|   - 3 open actions from last meeting     |
|   - Key decisions pending review         |
|                                          |
|   ## Attendee Prep                       |
|   - Jordan: Budget presentation ready    |
|   - Sarah: Product roadmap update        |
|   ...                                    |
|                                          |
| +--------------------------------------+ |
| | PROPOSED ACTION                      | |
| | Review Q4 financials before meeting  | |
| | Owner: Alex | Due: Today 1pm        | |
| | [Approve] [Edit] [Reject]            | |
| +--------------------------------------+ |
|                                          |
+------------------------------------------+
| Quick: [Summarize] [Extract] [Follow-up] |
+------------------------------------------+
| [Type your message...              ] [>] |
+------------------------------------------+
```

### Visual Design Elements

- **Sidebar background:** Subtle contrast from main content
- **User messages:** Right-aligned, primary color bubble
- **Agent messages:** Left-aligned, neutral background
- **Approval cards:** Border highlight, action buttons prominent
- **Mode indicator:** Colored badge matching mode
- **Streaming cursor:** Blinking cursor during generation

### Responsive Behavior

- **Desktop (>1024px):** Side-by-side with main content
- **Tablet (768-1024px):** Overlay panel, slide from right
- **Mobile (<768px):** Full-screen takeover when open

---

## Technical Approach

### Claude Agent SDK Integration

```typescript
// lib/agent/client.ts
import { Agent } from '@anthropic-ai/agent-sdk';

const agent = new Agent({
  model: "claude-sonnet-5-5",
  tools: platformTools,
  systemPrompt: buildSystemPrompt(mode, context),
});

export async function* streamAgentResponse(messages, context) {
  const stream = await agent.stream({
    messages,
    context: buildContext(context),
  });
  
  for await (const event of stream) {
    yield event;
  }
}
```

### Streaming API Route

```typescript
// app/api/agent/chat/route.ts
export async function POST(request: Request) {
  const { messages, mode, context } = await request.json();
  
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();
  
  streamAgentResponse(messages, { mode, ...context })
    .then(async (generator) => {
      for await (const chunk of generator) {
        await writer.write(encode(chunk));
      }
      await writer.close();
    });
  
  return new Response(stream.readable, {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}
```

### Platform MCP Server Tools

```typescript
const platformTools = [
  {
    name: "getMeetings",
    description: "Retrieve meetings within scope",
    parameters: { dateRange, series, attendees }
  },
  {
    name: "getMeetingDetails",
    description: "Get full meeting content including notes",
    parameters: { meetingId }
  },
  {
    name: "getActionItems",
    description: "Retrieve action items with filters",
    parameters: { status, owner, meetingId, dueDateRange }
  },
  {
    name: "getDecisions",
    description: "Retrieve decisions with filters",
    parameters: { search, meetingId, decidedBy, dateRange }
  },
  {
    name: "proposeActionItem",
    description: "Propose a new action item for user approval",
    parameters: { title, description, owner, dueDate, priority, meetingId }
  },
  {
    name: "proposeDecision",
    description: "Propose a new decision for user approval",
    parameters: { title, description, rationale, decidedBy, meetingId }
  },
  {
    name: "searchContent",
    description: "Semantic search across all platform content",
    parameters: { query, contentTypes, dateRange }
  },
  {
    name: "getPersonContext",
    description: "Get context about a person (role, recent activity)",
    parameters: { personId }
  }
];
```

### State Management

```typescript
// hooks/useAgentChat.ts
export function useAgentChat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [pendingApprovals, setPendingApprovals] = useState<Proposal[]>([]);
  
  const sendMessage = async (content: string, mode: AgentMode, context: Context) => {
    setMessages(prev => [...prev, { role: "user", content }]);
    setIsStreaming(true);
    
    const response = await fetch("/api/agent/chat", {
      method: "POST",
      body: JSON.stringify({ messages: [...messages, { role: "user", content }], mode, context })
    });
    
    const reader = response.body.getReader();
    let agentMessage = "";
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      const chunk = decode(value);
      agentMessage += chunk.text;
      setMessages(prev => updateLastMessage(prev, agentMessage));
      
      if (chunk.proposals) {
        setPendingApprovals(prev => [...prev, ...chunk.proposals]);
      }
    }
    
    setIsStreaming(false);
  };
  
  return { messages, sendMessage, isStreaming, pendingApprovals };
}
```

### Component Structure

```
apps/web/
├── components/
│   └── agent/
│       ├── AgentSidebar.tsx         # Main sidebar container
│       ├── AgentHeader.tsx          # Mode + context selectors
│       ├── ModeSelector.tsx         # Dropdown for modes
│       ├── ContextSelector.tsx      # Scope picker
│       ├── ChatMessages.tsx         # Message list
│       ├── ChatMessage.tsx          # Single message
│       ├── ChatInput.tsx            # Input with send
│       ├── QuickActions.tsx         # Context-aware buttons
│       ├── ApprovalCard.tsx         # Proposal approve/reject UI
│       ├── ConversationList.tsx     # History sidebar
│       └── hooks/
│           ├── useAgentChat.ts      # Chat state
│           ├── useAgentMode.ts      # Mode management
│           ├── useAgentContext.ts   # Context management
│           └── useApprovals.ts      # Approval workflow
├── lib/
│   └── agent/
│       ├── client.ts               # SDK wrapper
│       ├── tools.ts                # MCP tool definitions
│       ├── prompts.ts              # System prompts per mode
│       └── types.ts                # TypeScript types
└── app/
    └── api/
        └── agent/
            ├── chat/
            │   └── route.ts         # Streaming chat endpoint
            ├── conversations/
            │   └── route.ts         # History CRUD
            └── hooks/
                └── route.ts         # Event hook handlers
```

---

## Frontend Design Stack

### Required Tools
- **shadcn MCP:** Component discovery (Sheet, Dropdown, Avatar, Button, Card, Textarea)
- **shadcn-create Skill:** Load `~/.claude/skills/shadcn-create/SKILL.md` for theme consistency

### Component Requirements
- `Sheet` - Sidebar container
- `DropdownMenu` - Mode and context selectors
- `Avatar` - User/agent message indicators
- `Button` - Actions, send, approve/reject
- `Card` - Approval proposal cards
- `Textarea` - Message input
- `ScrollArea` - Message history scroll
- `Badge` - Mode indicator, AI-assisted tag
- `Skeleton` - Loading states
- Icons: MessageSquare, Send, Settings, Check, X, Edit

---

## Acceptance Criteria

- [ ] Agent sidebar opens/closes with button click and Cmd+J shortcut
- [ ] Mode selector switches between 5 modes (General, Meeting Prep, Action Extractor, Decision Analyzer, Follow-up Nudger)
- [ ] Context selector offers: current page, specific meeting, meeting series, date range, all data
- [ ] User can type a message and receive streaming response
- [ ] Response renders markdown correctly (lists, bold, code)
- [ ] Agent can propose action items that appear as approval cards
- [ ] Approve button creates the item and marks it AI-assisted
- [ ] Edit button allows modification before creation
- [ ] Reject button dismisses the proposal
- [ ] Chat history persists across page navigation
- [ ] New conversation button starts fresh chat
- [ ] Conversation list shows past conversations
- [ ] Quick action buttons send pre-filled prompts
- [ ] First token appears in under 1 second
- [ ] Loading indicator shows during generation
- [ ] Error states display clearly with retry option
- [ ] Sidebar works on mobile (full-screen mode)
- [ ] All agent actions logged in audit trail
- [ ] Agent respects user data access permissions

---

## Success Metrics

| Metric | Current | Target | Measurement |
|--------|---------|--------|-------------|
| Meeting prep time | 45+ minutes | < 10 minutes | User surveys |
| Action item capture rate | ~70% | > 95% | Comparison testing |
| Follow-up response rate | ~60% | > 85% | Action completion metrics |
| Agent adoption | 0% | 70% weekly active users | Analytics |
| User satisfaction | N/A | 4.2+ / 5 rating | In-app feedback |
| Support tickets for finding info | Baseline TBD | -40% | Support metrics |

---

## Risks and Mitigations

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| AI hallucinations | High | Medium | Approval workflow, source citations |
| API costs exceed budget | Medium | Medium | Rate limiting, token budgets, caching |
| Latency frustrates users | Medium | Low | Streaming, optimized prompts |
| User over-reliance on AI | Medium | Low | Clear AI-assisted labels, training |
| Data privacy concerns | High | Low | Strict scoping, audit trails, policy |
| SDK breaking changes | Medium | Low | Version pinning, abstraction layer |

---

## Future Enhancements (v2+)

**Voice Interface:**
- Voice input for hands-free queries
- Voice output for meeting briefing playback

**Advanced Analytics:**
- Decision impact scoring
- Meeting effectiveness metrics
- Predictive action completion

**Integrations:**
- Calendar integration for automatic context
- Email drafting for follow-ups
- Slack/Teams notifications

**Multi-Agent Collaboration:**
- Specialized agents for different domains (finance, HR, product)
- Agent handoff for complex queries

**Learning and Personalization:**
- Learn user preferences for formatting
- Adapt suggestions based on acceptance/rejection patterns
- Organization-specific terminology learning

---

## Implementation Phases

### Phase 1: Foundation (Weeks 1-2)
- [ ] Set up Claude Agent SDK
- [ ] Create basic sidebar shell component
- [ ] Implement streaming API route
- [ ] Build chat message display

### Phase 2: Core Interaction (Weeks 3-4)
- [ ] Mode selector with General mode
- [ ] Context selector (basic)
- [ ] Platform MCP tools (read-only)
- [ ] Chat history persistence

### Phase 3: Approval Workflow (Week 5)
- [ ] Proposal tools (proposeActionItem, proposeDecision)
- [ ] Approval card UI
- [ ] Create with AI-assisted tag
- [ ] Audit logging

### Phase 4: Specialized Modes (Weeks 6-7)
- [ ] Meeting Prep mode + prompt
- [ ] Action Extractor mode + prompt
- [ ] Decision Analyzer mode + prompt
- [ ] Follow-up Nudger mode + prompt

### Phase 5: Event Hooks (Week 8)
- [ ] Hook system architecture
- [ ] Meeting completed hook
- [ ] Due date approaching hook
- [ ] User settings for hooks

### Phase 6: Polish (Weeks 9-10)
- [ ] Quick actions by page context
- [ ] Conversation management UI
- [ ] Mobile responsive design
- [ ] Performance optimization
- [ ] Documentation

---

## Open Questions

- [ ] Should agent have access to meeting transcripts (if available) or just notes?
- [ ] Token budget per user per day - what limit is sustainable?
- [ ] Should Strategic Insights mode be admin-only due to broad data access?
- [ ] Integration priority: email notifications vs. Slack vs. in-app only?
- [ ] Should approval cards expire if not acted on within X hours?
- [ ] Multi-language support requirements?
