---
video_id: hALln9wrrQo
title: "How I Run Creative, Software, and Business Work as One System (Ai memory vs Human memory?)"
channel: "Jake Van Clief"
channel_id: UCPR4DV8qMQVs_YBa-CQZQBQ
channel_slug: jake-van-clief
url: "https://www.youtube.com/watch?v=hALln9wrrQo"
upload_date: 2026-04-28
duration_s: 844
duration: 14:04
view_count: 10933
like_count: 532
subtitle_lang: en-orig
transcript_source: auto
transcript_words: 2561
ingested_at: 2026-07-25T15:24:26.265Z
ingest_version: 1
project_id: agentic-os
---

# How I Run Creative, Software, and Business Work as One System (Ai memory vs Human memory?)
**Channel:** Jake Van Clief · **Uploaded:** 2026-04-28 · **Duration:** 14:04 · **Views:** 10,933  
**Watch:** https://www.youtube.com/watch?v=hALln9wrrQo

## Description

Join my Community to learn more! : https://www.skool.com/cliefnotes/about 

A walkthrough of one folder architecture running three businesses. I take a real client project (NLP Logix, four animated videos delivered in a day) and show how the same file structure handles the creative work, the software pipeline, and the business strategy without three separate systems sitting on top of each other.



What we cover:

The three current bets on AI memory: vector embeddings (Open Brain), Karpathy's LLM wiki, and the folder system most people already have
Why position-addressed memory is the cheapest and fastest option for client work shipped on Friday

How CLAUDE.md and context files cascade context into Claude, Codex, or a local model without any embeddings

Why creative, technical, and business work now sit on top of one shape, and what that means for solo operators and small teams
How one architecture lets a small company compete with 100 to 150 person agencies

Chapters:
00:00 Three lenses, one problem
00:35 The NLP Logix project
02:11 Three bets on AI memory
04:04 The folder system as memory
06:54 Outcomes over features
08:40 Creative work and AI
10:51 Three lenses, one architecture
12:47 Systems thinking in practice

## Chapters

- [0:00](https://youtu.be/hALln9wrrQo?t=0) Three lenses, one problem
- [0:35](https://youtu.be/hALln9wrrQo?t=35) The NLP Logix project
- [2:11](https://youtu.be/hALln9wrrQo?t=131) Three bets on AI memory
- [4:04](https://youtu.be/hALln9wrrQo?t=244) The folder system as memory
- [6:54](https://youtu.be/hALln9wrrQo?t=414) Outcomes over features
- [8:40](https://youtu.be/hALln9wrrQo?t=520) Creative work and AI
- [10:51](https://youtu.be/hALln9wrrQo?t=651) Three lenses, one architecture
- [12:47](https://youtu.be/hALln9wrrQo?t=767) Systems thinking in practice
- [13:13](https://youtu.be/hALln9wrrQo?t=793) This video was made with this system

## Transcript

[0:00] So, most people treat creative work, technical work, and business work like they're different problems, but they're the same problem wearing different clothes. All right. Now, a year or two ago, sure, maybe we had different

[0:11] consultancies and whatnot. You had creative consultancies. You had business consultancies. You had technical consultancies. I've wrote a lot of articles on this, but they're kind of all one thing now because of AI. If you

[0:23] use AI properly internally. I'm going to show you what I mean by looking at one project through three different lenses. And by the end, hopefully, you're going to see why each lens was telling the same story. So, here's an artifact, a

[0:35] thing that I'm actually using right now to make money. People are paying me to do this. NLP Logics is a AI company, machine learning company. They were founded in 2011. So, they've been in machine learning and data science way

[0:47] longer than most of these people. Essentially, they wanted to work with me for a lot of the things I was doing, but specifically, they wanted four video animation series. They also wanted brand deck, some voiceover scripts, custom

[0:57] animation patterns, right? The whole pipeline for a new movement they're doing. And I promise you, they're going to be a much bigger company here soon working with me, but that's beside the point. Most agencies would take three

[1:07] weeks for one video. I delivered four fully animated, fully voiced videos in a day. The clients are real, the work is real, my process is real, and it's all in a single folder. I I'm not joking. I'm using one folder as my app for all of this. On the

[1:24] surface, it looks like three different jobs. I have creative work, I have software work, I also have business work. I'm thinking of strategy, what should be said in the videos, where is it going to bring them clients, where is

[1:34] the money? And most people would tell you that's three different skill sets, three different teams, three different bills, but my folder shows you something entirely different. Think about this. Someone goes to give Claude memory,

[1:46] right? They read Karpathy's gist last week, or they saw OpenBrain tutorial on YouTube. They sit down, they open their laptop, and they start setting up a vector database, PG vector, embedding model, MCP server, Obsidian second

[2:00] brain. By Tuesday, they've got it indexing three years of notes, and it's still pulling the wrong things. It's almost completely useless. Here's what I think is happening. There are three different bets right now on what memory

[2:11] means for a large language model, or for AI in general. And most people pick the loudest one without realizing the other two exist. The first bet is OpenBrain, vector embeddings. You take everything you've ever written, you turn it into

[2:24] numbers, you ask the model to find what's similar. It works. It's also slow to set up, expensive to maintain, and sometimes it can be very brittle until you don't notice that you're searching for something specific, and then the

[2:35] model returns nine vaguely related notes. This doesn't always happen, and you can set up amazing OpenBrain and Second Obsidian systems. This is not a hate or a criticism of that. I'm just describing the problems here. The second

[2:48] bet is that Karpathy's LLM wiki, which is really fun. I've used this and built some of my own myself, and he posted it earlier this month. Basically, it's similar to my ICM architecture, but the idea is that markdown files that an

[3:00] agent or AI can actively maintain. There's entity pages, audited regularly, contradictions are flagged, orphan pages are founded. It's smart, and it's the closest thing we have to Vannevar's Bush Memex from 1945. If you don't know what that is, go give

[3:15] that a Google. The trade is that you need a maintenance LLM running constantly, and the wiki only stays useful if the LLM keeps tending it. And we see other versions of this, like Hermes and different open source. And again, very useful, but there are those

[3:31] downsides there. Then, there's a third bet, and I don't think a lot of people are talking about it because it's not new enough to feel like a product, and it's kind of informal. It's the folder system you already have and your own brain.

[3:46] Think about it like this. If you're using Codex or Claude or Gemini CLI or a local model on your computer, when it opens a file at video production projects NLP Logics scene three, it's a path already told it everything.

[4:02] The video work, the client, pattern A pipeline, scene file conventions. Claude.md at the root cascades down. Context.md inside the project layers on top. By the time Claude reads the scene, it's already inherited the brand voice,

[4:16] the production rules, the specific shot list. And if you haven't understood my folder architecture, a folder architecture similar to this, you should go check out my other YouTube videos where I dive really deep on why and how

[4:28] I built these, and it's much more hands-on than what you're seeing in this animated video, but nothing got embedded, nothing's getting retrieved. The location of the information and the the actual routing of it did the work.

[4:41] This isn't new. Unix has done this since 1969. Environment variables scope down. CSS specificity scopes down. Your accountant filing cabinet does it, too. The folder name is a namespace. The namespace carries meaning. We just

[4:55] didn't have a model that could read it before. OpenBrain is content addressed. Karpathy's wiki is link addressed. The folder system is position addressed. And all three work, and theoretically, you could use all three together. For the

[5:11] kind of work you ship to a client by Friday, in my opinion, position is the cheapest, the fastest, and the only one that's still legible to a human, and a human is in the loop because it's more efficient. I remember where things are.

[5:25] I have context. My brain is a powerful context machine. We are creating systems that allow me to offload context to Claude or to a different AI using folders while simultaneously using my context to amplify that process. I'm

[5:40] still directing the AI. My prompts that are directing Claude or Codex through my file structure is an added layer of context that can be on the fly and is extremely efficient, extremely quick, and can be updated on the fly because

[5:55] that's how the human brain works. It's also infinitely abstracting. I really do believe that humans can have infinite levels of creative abstraction, but at the end of the day, the person who's setting up a PG vector on Tuesday, they

[6:09] had a folder system the whole time. They just thought memory had to look like a brain rather than get an outcome out of it. And this is really the important part. A lot of people are talking about features and processes, and that's fine.

[6:22] There's amazing ones out there, but think about outcomes. When a new client comes in, I don't start from scratch. I copy or use a folder system that already exists. The folder already has routing rules at the root, the context files in

[6:35] each subfolder, the brand templates, the voice stocks, the scene primitives, the export settings. The folder is my agency, and it's just locally on my computer. I just put the client inside of it as if for me. Now, of course, I

[6:48] could productionize this and make a product out of it, but why when I can sell the outcome regardless? I can hand this folder to other people who work with me, and they immediately have my context. There's no need to productionize it. However, I am building

[7:03] a production version of this involving Git and various Azure DevOps frameworks. I might even make it simpler with just GitHub to go proof of concept, but the idea is there. The NLP Logics project sits inside project/nlplogics.

[7:17] Four video series, each video gets its own pipeline. The brand voice cascades down from the project root. The animation patterns cascade in from the studio framework. I'm not designing the system every time. I'm filling it in.

[7:30] I'm adding an extra folder and building off of what has already been built. And then, something interesting happens. Other companies start asking how I do it. They want the system, not the videos. The folder structure is the IP.

[7:43] I can license I can implement it inside their org. I can become their advisor in their internal system instead of an external vendor. It's the same artifact, but a completely different business model. I'm selling a system, and the

[7:56] videos are just one of the outputs of that system. Here's what people get wrong about creative work and AI. They assume the model is replacing taste. The model is doing the opposite. It's handling everything around the taste, so

[8:10] you have more of it left over for the work. This is not to say that people aren't being lazy or using it the wrong way. There's a whole bunch of AI slop out there, but at the end of the day, there's a lot of things you can do with

[8:22] it. Case in point, I cloned my voice with ElevenLabs months ago, and I do use it for client work. Sometimes, people ask if that means I'm not really making the content, but I'm actually making way more of it. The voice clone reads the

[8:36] script. I write the script. I edit the script for hours. I think about the strategic needs for it. Why would it be there? I record the parts that need real performance. I composite the sections. I rebuild the animation when it doesn't

[8:47] land. And the system gives me back the hours I used to spend on the parts that don't matter or required 10, 15, 20 employees choosing colors that match the brand guide, re- recording sections to match the previous take, renaming files,

[9:02] resizing exports for different platforms. None of that is creative work. It's logistics with a creative project attached. The folder handles the logistics for me. The AI is amplifying the speed in which I can get those logistics done and the ease in which I

[9:19] can do it, but I'm still in control of the creative work. When I deliver a brand deck for a client, or I'm using the brand deck internally just to help with my automated process, the deck has voice samples, type pairings, color

[9:32] logic, animation patterns, the actual video pipeline they'll use. I've had clients tell me, and hey, I don't like this video. The logo looks bad. Here's our own logo. We want to change this. And I've changed it. The folder allows

[9:43] me to organize the generations from AI so that I can easily come in, edit, and swap it versus just a bunch of random AI slop that has no organization, no editability. It's a deck, it's It's workshop, it's a starter folder, all in

[9:57] one. The agencies before me would have called that three different deliverables. I just call it my one deliverable, the project, the retainer fee that they're paying. And I really want to double down on this concept, the

[10:10] creative lens, the software lens, and the business lens are all looking at the same thing. They used to be multiple agencies, one doing each thing, multiple consultancies, multiple areas for value. But because AI comes in and changes

[10:27] where the commodities of software, of audit reports, of deliverables is, we now have to operate at a new abstraction. The brand voice that's cascading down, that's a creative system. The path being the memory, that's the software system. The agency

[10:43] template I clone for new clients, that's the business system. And the runtime is whichever AI or base sets of AI agents, one agent, multiple agents, I am using. Right? And this is where you start to see the idea of where do you want to be

[10:57] locked in? Do you want local models? Do you want to just use Anthropic's Claude? Do you want to use Codex? Well, the freedom of having your own local folder system allows you to do all of that. And more importantly, package that and give

[11:10] it to your employees. So, as long as I'm getting more output, I can now hand this to a designer, to a front-end developer, to a back-end developer, and they're getting the abilities that used to only be one single employee. Each person is

[11:25] being amplified by this architecture, not replaced. My company can now compete with 100, 150 person companies. And it's all the same folder. The work I do for the channel on my YouTube page or my Instagram page uses the same

[11:41] architecture as the work I do for clients, which uses the same architecture as the system I license to other companies or work with other companies. One structure, three businesses sitting on top of it, three apparent skill sets that are actually

[11:55] just one skill repeat. And this is what systems thinking actually means in practice. Three problems with three vocabularies sitting on top of one shape. Once you see the shape, you stop solving each problem from scratch. You

[12:10] build the shape once, and the problems just solve themselves on top of it. This video that you are seeing now lives in the same folder structure I just spent 6 minutes describing. The script you're hearing is in my script.md file. The

[12:27] animation primitives I'm using are sitting in my 01 framework folder. The one thing, the whole thing, was made by working inside of this system, inside of this folder that this video is about. It's the same shape all the way down,

[12:41] and I am making money with it with clients. I am creating attention with it with my social media. I am learning software fundamentals for the next decade by failing and building with it. It wasn't perfect, it still isn't

[12:54] perfect. There's so many things I need to change and update and fix and work through. I'm just living at a new abstraction of software, of deliverables, of business, of creative think. The thing that changes when you build a system like this is what you

[13:08] spend your time on. The creative work, the business work, the technical work, all shift, maybe even expand in some ways and shrink in others. No matter what though, the business work compounds. I haven't gotten less busy

[13:25] because of these systems, I've just moved where I am busy. You stop staffing problems and start switching lenses. That's the whole thing. That's it. This is a methodology that you can bring into your process. If you want to learn more

[13:39] or dive deeper into these, I highly recommend either checking out my other YouTube videos, or I have it structured for the way of thinking in my actual school community. It's free to join, all the courses are completely free. Please

[13:51] go check it out. It can help you with this thinking. You'll start to see, as you watch all of them, they're all just parts of a greater whole. And as always, stay curious and happy learning.
