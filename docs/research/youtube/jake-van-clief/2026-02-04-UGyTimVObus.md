---
video_id: UGyTimVObus
title: "From Nazi Psychology to AI Auditing: Inside the System I Built"
channel: "Jake Van Clief"
channel_id: UCPR4DV8qMQVs_YBa-CQZQBQ
channel_slug: jake-van-clief
url: "https://www.youtube.com/watch?v=UGyTimVObus"
upload_date: 2026-02-04
duration_s: 821
duration: 13:41
view_count: 2852
like_count: 129
subtitle_lang: en-orig
transcript_source: auto
transcript_words: 2370
ingested_at: 2026-07-25T15:24:26.382Z
ingest_version: 1
---

# From Nazi Psychology to AI Auditing: Inside the System I Built
**Channel:** Jake Van Clief · **Uploaded:** 2026-02-04 · **Duration:** 13:41 · **Views:** 2,852  
**Watch:** https://www.youtube.com/watch?v=UGyTimVObus

## Description

Join my Community to learn more! : https://www.skool.com/cliefnotes/about Along the way we get into how software systems actually communicate (APIs and the Model Context Protocol), why the same engineering pattern that gave us USB and HTTP is now connecting AI to external tools, and why the word "agent" is doing more work than the technology behind it currently justifies.

This is the third video in a series. The first traced a line of Python down to electrons. The second connected Mad Libs to AI memory. This one starts at the top and takes an AI system apart to find traditional engineering at every layer.

TIMESTAMPS:
0:00 - A test designed to study authoritarians, now running on AI
1:15 - What "agent" actually means (and doesn't)
3:30 - The orchestration layer: async programming and concurrency
6:30 - How systems talk to each other: APIs explained
9:30 - MCP and the pattern: USB, HTTP, LSP, and now AI tooling
12:00 - The data and the math: parsing, scoring, statistics
15:00 - The reframe: what's actually inside these systems
16:00 - Close

THE ETHICS ENGINE:
Paper: https://arxiv.org/abs/2510.11742
Code: https://github.com/RinDig/AuditEngine
App: https://ethicsengine.eduba.io

PREVIOUS VIDEOS IN THIS SERIES:
How One Line of Python Triggers 12,000 Lines of Code
https://www.youtube.com/watch?v=5B6W2OGfxq0&t=69s

How a 1953 Word Game Explains AI Memory
https://www.youtube.com/watch?v=S3fXSc5z2n4&t=6s

## Chapters

- [0:00](https://youtu.be/UGyTimVObus?t=0) A test designed to study authoritarians, now running on AI
- [1:15](https://youtu.be/UGyTimVObus?t=75) What "agent" actually means (and doesn't)
- [3:30](https://youtu.be/UGyTimVObus?t=210) The orchestration layer: async programming and concurrency
- [6:30](https://youtu.be/UGyTimVObus?t=390) How systems talk to each other: APIs explained
- [9:30](https://youtu.be/UGyTimVObus?t=570) MCP and the pattern: USB, HTTP, LSP, and now AI tooling
- [12:00](https://youtu.be/UGyTimVObus?t=720) The data and the math: parsing, scoring, statistics

## Transcript

[0:00] I took psychometric tests used to capture Nazis in the 50s and aimed them at AI models. Well, I did a little bit more than that. I created a data pipeline that allowed to take a lot of personality tests and aim them all

[0:12] across AI models. It can tell you where a model lands on moral foundations, authoritarianism scales, personality dimensions, and it can do this across personas, model variations, various providers, and so on. And from the

[0:25] outside, it looks like one intelligence studying another, like something that would require a team of researchers or grants. But the point I'm bringing this up is not to even show you that. I actually want to take this apart because

[0:35] it's going to help me explain APIs, research, coding in the modern era, what it means to do the fundamentals. And I don't want to show you how to build this. Rather, I'd deconstruct it because something becomes visible when you

[0:47] deconstruct systems rather than showing you how to assemble systems. And let me show you exactly what I mean. But before I do that, let's go into a kind of world of definitions. There's a word that has taken on a lot of weight in the last

[1:01] couple of years, and that word is agent. We hear about AI agents that can browse the web, write code, manage calendars, analyze documents, da da da da, all this hype, agentic world. And the word agent does mean something to our imagination.

[1:16] And not just from an AI perspective. It used to mean autonomy or separate or attached, right? this idea that there's decision-making going on. It implies that this thing can act on its own behalf. Uh, and I want to be careful

[1:30] here because I think this is one of those places where language is running ahead of the engineering. What we call an AI agent in the vast majority of cases is not a single entity making autonomous decisions. It is a collection

[1:44] of prompts structured and sequenced by traditional code that causes a model to behave differently at different stages of a workflow. The model itself is not deciding to take a next step. The orchestration layer, which is regular

[1:58] software, evaluates the model's output and determines what prompt to send next based on conditions that a human engineer defined. This is an important distinction and it maps onto something we already understand in computer

[2:11] science. Think about the difference between a function call and a running process. A function takes an input and returns an output. It doesn't decide what to do next. The program that called the function makes that decision. In the

[2:25] same way, each call to a language model is a function call. Prompt in, text out. The agentic behavior, the appearance of autonomy emerges from the orchestration code that wraps those calls. There are systems beginning to emerge where models

[2:40] genuinely operate in autonomous loops, right? Everyone can think about my good old Clawbot video, but or I think they're called moldbot now. No, open claw. That's the word that they are now. Yeah. Where the model itself decides the

[2:53] next action. That is a real and meaningful evolution, but it's not what we were looking at in the vast majority of the deployed systems we have today. And conflating the two makes it harder to understand what is actually happening

[3:04] when these systems work. So let us look at what is actually happening. And again, let's go into my ethics engine pipeline. The first thing we find when we open the system is not a model. It's actually more of a traffic controller,

[3:16] so to speak. My ethics engine needs to administer dozens of psychometric items across multiple models simultaneously. Claude, GPT, Llama, blah blah blah, Gemini, all these things. Each provider has different rate limits, different

[3:30] responses, formats, different failure modes. So there is an orchestration layer that manages all of this and it is written in Python and it is doing something that would be immediately recognizable to anyone who has built a

[3:42] web screener or a trading system or even just a ticket reservation platform. It manages concurrency. That's it. It handles retries when requests fails. It queries prompts and dispatches them in order. It tracks which items have been

[3:55] completed and which are still pending. Yet none of this is AI, right? There's no AI doing any of this work, or at least not the modern AI. This is just async programming, asynchronous programming. It's concurrency management. These are patterns that

[4:10] existed long before language models, and they work the same way as they do anywhere else. The model at the other end of each request has no awareness that any of this is happening. It receives a prompt, returns text. That is

[4:23] the full extent of its involvement in this layer of the system. Which raises a question that I think is worth sitting on for a moment. How does the prompt even get to the model? What is the actual mechanism by which one piece of

[4:36] software talks to another? When we say that an AI agent called an API or we called an API, there's a concept buried in that sentence that tends to get skipped over when people are kind of teaching about this stuff. And I think

[4:49] it's worth unpacking because it connects to something larger. An API or an application programming interface is a contract. Two pieces of software agree in advance on the shape of their conversation. What the request will look

[5:02] like, what the response will look like, what is allowed and what is not. Neither side needs to understand the other's internals. They just need to honor the agreement that was made. When the ethics engine sends a prompt to claude, what

[5:15] actually happens is an HTTP request carrying JSON, which is a structured text format, and that goes to an endpoint at Anthropic Servers, company that runs Claude. That JSON contains the prompt, the model name, and some parameters. The server processes it and

[5:32] returns JSON containing the models response. A structured text message goes out. A structured text message comes back and everything the ethics engine does with that response, the scoring, the analysis, the reliability calculations, the synchronous muse and

[5:46] so on. All of that happens locally in traditional code. This is how software has communicated for decades. Web browsers talk to servers this way. Payment systems talk to banks this way. Your weather app talks to a data provider this way. This pattern is not

[6:01] new. But here is where I think it gets a little interesting and where a familiar problem resurfaces. What happens when your system needs to talk to not just one service but 20? A database, a file system, a web browser, a code

[6:14] interpreter, a calendar, a search engine. If every connection is customuilt, you have a scaling problem. Every new tool requires a new integration. Every new AI application requires its own connectors to every tool it wants to use. The number of

[6:31] integrations grows as the product of the number of application times the number of tools. And that math gets unworkable real quickly. But we have fortunately seen this problem before. Well before AI and honestly with every iteration, we

[6:48] found a solution. Before USB, every peripheral device had its own connector. Printers, keyboards, mice, cameras, all different cables, all different protocols. The solution was to standardize the interface. One connector, one protocol, and any device

[7:04] that speaks it can connect to any computer that speaks it. Before HTTP, applications each had their own way of communicating. The solution was to standardize the protocol, one set of rules for how to request and deliver

[7:17] documents, and the web became possible. Before the language server protocol, every code editor needed a custom integration for every programming language. syntax highlighting, error checking, autocomplete, all built separately for each editor and each

[7:32] language. The solution was again standardize the interface. This is where MCP comes in and this is the more modern version of this uh history for AI. It's called model context protocol and is a standardized way for AI systems to

[7:48] connect to external tools and data sources. It was introduced by Anthropic in late 2024 and explicitly inspired by this language server protocol. The people who built it recognized the pattern. We already solved this problem

[8:01] for programming languages talking to editors. So let us solve it in the same way for AI talking to tools. The architecture has three parts. A host which is the AI application, a client which handles the connection and a

[8:14] server which wraps the external tool or data source and speaks MCP. The model does not call APIs directly. The orchestration layer determines what tools to use. The MCP client manages the connection and the MCP server translates

[8:27] between the protocol and whatever the actual tool needs internally. Let's get back to the ethics engine. The model returned a text after having this API call or tool call sent out. Right? Let's look at what happens next to this text

[8:41] because this is where the ratio becomes clear. The model's response is sent as a string. natural language, probabilistic language. The system needs to extract a number from that string. And this is a small thing, but it is worth noticing.

[8:54] The model operates in language. The scoring system operates in numbers. Something has to bridge that gap. And what bridges it is something called parsing, pattern matching, regular expressions. The same text processing in

[9:06] tools that have existed for quite literally decades. The number enters the scoring logic. Psychometric instruments actually have a specific scoring key developed and validated over years and years of clinical research. Some items

[9:20] are reverse scored, meaning a response of five gets recorded as a one. And because the question was phrased in a kind of negative direction. Subscales are calculated by aggregating specific items and creating a new number. And

[9:32] this is just basic arithmetic. All of this is validated, peer-reviewed arithmetic, but arithmetic nonetheless. From there you have reliability testing. Chromebox alpha for internal consistency. Test retest correlation for

[9:45] temporal stability. These are all statistical methods implemented in libraries like scypi numpy. Um and that predates large language models by decades as well. The math has not changed since these instruments were validated on human populations. So

[10:00] here's what the ethics engine actually looks like when you lay it out. Honestly, the AI sends prompts, receives texts, and honestly the actual AI calling is maybe 10% of the system volume. The orchestration, right, async

[10:13] coordination, the rate limming, retry logics, Q management, things like that, that's maybe 30%. The actual data processing, sending and collecting prompts, personas, parsing, scoring, analysis, reliability, that's actually

[10:26] like 60% of the actual code that's going on in this. The ratio is not unique to my ethics engine. I'm bringing this up because it's something I see in every good working AI system I work with. All the bad ones seem to ignore this ratio.

[10:39] And this is where, if you've been following along through the series, the connection starts to surface. We traced a line of Python down through seven layers of abstraction to electrons that are fundamentally probabilistic. We

[10:51] traced memory from registers and cache through to context windows and system prompts. And we found that the template pattern blanks filled according to rules holds at every level. Now, we've taken an AI agent apart from the top and found

[11:04] that most of its layers are traditional engineering APIs that follow the same request response pattern software has used for decades. Protocols that standardize interfaces the same way USB and HTTP did before them. Data

[11:20] processing that runs on statistical libraries older than the models they evaluate. Kind of funny when you think about it. There's this narrative that says AI changes everything and then there's this counternarrative that AI is

[11:32] just hype. And while honestly I think both of those myths what is actually happening and what is interesting in my head which is that AI simply extends what we've always been doing. It adds a layer where natural language becomes the

[11:46] interface and context becomes the program. But that layer sits on top of the same exact engineering tradition that has been building since we first figured out how to route electricity through logic gates. The new thing is

[12:00] real. The semantic layer, the ability to operate meaning rather than syntax. That is genuinely novel, but it does not replace the layers beneath it. It depends on them in certain cases. I'll make another video on where I think

[12:13] there's a grain of salt there. Here is where the word agent becomes interesting again because I think we're approaching a moment where genuine agentic behavior models operating in autonomous loops making decisions that were not

[12:26] predetermined even by orchestrating code starts to become real. And when that happens the engineer's challenge will not be making the AI smarter. It will be building the infrastructure around it, the reliability patterns, the error

[12:39] handling, the protocols for safe autonomous operation. the same work, in other words, that has accompanied every new layer of the stack since Gracehopper had a compiler that no one believed would work. And I'm simply just trying

[12:52] to build software at the top of this layer. My ethics engine can tell you the psychological profile of an AI model with about 90% reliability. That is a real and useful capability. And the reason it works is not because the AI is

[13:04] brilliant. The AI does what AI is good at, which is processing natural language and generating responses shaped by context. The traditional code does what traditional code has always been good at, which is orchestration, computation,

[13:19] and reliability. And the protocols connecting them do what protocols have always done, which is letting different systems communicate without needing to understand each other's internals. That is not less impressive than magic. In my

[13:31] opinion, it's more impressive because you can actually understand it and it actually works. Till next time, friends. Goodbye.
