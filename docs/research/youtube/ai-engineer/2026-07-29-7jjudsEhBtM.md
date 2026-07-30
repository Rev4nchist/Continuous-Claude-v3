---
video_id: 7jjudsEhBtM
title: "Skills are new features: Building Skill-Centric Harness — Yogendra Miraje, FactSet"
channel: "AI Engineer"
channel_id: UCLKPca3kwwd-B59HNr-_lvA
channel_slug: ai-engineer
url: "https://www.youtube.com/watch?v=7jjudsEhBtM"
upload_date: 2026-07-29
duration_s: 1043
duration: 17:23
view_count: 1090
like_count: 39
subtitle_lang: en-orig
transcript_source: auto
transcript_words: 2177
ingested_at: 2026-07-30T04:41:15.726Z
ingest_version: 1
---

# Skills are new features: Building Skill-Centric Harness — Yogendra Miraje, FactSet
**Channel:** AI Engineer · **Uploaded:** 2026-07-29 · **Duration:** 17:23 · **Views:** 1,090  
**Watch:** https://www.youtube.com/watch?v=7jjudsEhBtM

## Description

Since skills were open sourced, Yogendra Miraje's team at FactSet stopped thinking about shipping features and started thinking about shipping skills. A skill is a capability you hand the agent, and its heart is a short skill.md whose name and description are really routing signals: get them distinct and the agent triggers the right one, blur them and it fires the wrong skill or none at all. He walks through a minimal skill registry, progressive disclosure so the agent only loads what it needs, and trigger words, like asking for a PDF versus an HTML report, that decide which skill runs.

The harder lessons show up at scale. Skills without evals drift, because a new model quietly stops obeying them, so he treats skills as contracts you test. Past ten skills you need search and embeddings to keep the library coherent; past a hundred you need real governance, admission, ownership, periodic audits, change management, and a human deciding whether a skill should exist at all. His close is that skills are the interface to your agentic products, and at enterprise scale governing them matters as much as writing them.

Speaker info:
- https://x.com/YogiNotTheBear
- https://www.linkedin.com/in/mirajey/
- https://yogimiraje.com

Timestamps:
0:00 - From blueprints to skills
1:46 - Building skill centric agents
2:52 - Skills in context at enterprise scale
3:46 - Skills as the new features
5:04 - Inside a skill: the skill.md
6:37 - A minimal skill registry
7:42 - Progressive disclosure
9:13 - Trigger words and routing
12:17 - Skills without evals drift
12:56 - Search and embeddings past ten skills
13:46 - Governance past a hundred skills
16:36 - Skills as the product interface

## Chapters

- [0:00](https://youtu.be/7jjudsEhBtM?t=0) From blueprints to skills
- [1:46](https://youtu.be/7jjudsEhBtM?t=106) Building skill centric agents
- [2:52](https://youtu.be/7jjudsEhBtM?t=172) Skills in context at enterprise scale
- [3:46](https://youtu.be/7jjudsEhBtM?t=226) Skills as the new features
- [5:04](https://youtu.be/7jjudsEhBtM?t=304) Inside a skill: the skill.md
- [6:37](https://youtu.be/7jjudsEhBtM?t=397) A minimal skill registry
- [7:42](https://youtu.be/7jjudsEhBtM?t=462) Progressive disclosure
- [9:13](https://youtu.be/7jjudsEhBtM?t=553) Trigger words and routing
- [12:17](https://youtu.be/7jjudsEhBtM?t=737) Skills without evals drift
- [12:56](https://youtu.be/7jjudsEhBtM?t=776) Search and embeddings past ten skills
- [13:46](https://youtu.be/7jjudsEhBtM?t=826) Governance past a hundred skills
- [16:36](https://youtu.be/7jjudsEhBtM?t=996) Skills as the product interface

## Transcript

[0:01] [music] Hi everyone, I am Yogi. I work at Faxet as principal AI engineer. We are a financial data and research company. I'm going to talk about how to build skill centric agentic products and I'm going to post slides so you don't have to keep

[0:33] uh taking photos. So that's my exandle yogi not the bear. Um so let's connect there and uh let's begin. So in the last year's talk in this very conference I talked about blueprints and what blueprints were really a simple set

[0:58] of steps or recipe that you can hand over to agents so that agent doesn't have to discover its path every time and when I look back it was simply a skill in a very naive form and a lot has changed since Then Antropic has shipped skills in last year

[1:23] October and even warned us not to build agents. But on serious note since Antropic had already open source the skills there was no point in trying to maintain our own standards. So we moved away from blueprints and just adopted skills

[1:43] fully. And this talk really inspired me to build skill centric agent and I'm going to share some of my learnings from that journey. So a quick raise of hands. How many of you really build skills here? So almost all of you. Now lower your

[2:06] hands if you have built that only in context of cloud code and codeex. and raise your hand if you have like built your own harness and added you know skills to that. So okay so I see a few hands. So reason I'm asking is when I see most of the

[2:24] online discourse it's about you know coding harnesses and skills in context of the coding agents and how to write great skills like so we need that but today I'm not going to talk about that what I'm going to focus on is skills in

[2:42] the context of agentic products and how do you really add support for skills in in your own harness and how to scale it at enterprise scale. So traditionally product used to look like this. A surface made of screens, buttons, forms and dashboards. The user

[3:05] navigated this UI. But nowadays we are seeing more and more these kind of interfaces where agent is at the forefront. The user either talks to the agent or agent behind the scene is the main decision maker helping users navigate

[3:24] your product. Now if the agent becomes the main interface for your product then where do features live? This framing of who, what, and how really helps to answer that question. Prompts define who the agent is. Tools define what it can connect to. And

[3:49] skills really tell you how a task gets done. And this is the great place to keep your business logic that shapes your agents behavior. So skills are the new features. And you can see this with this example. So equity research and

[4:07] wealth management are two very important workflows in uh finance and these all used to be the buttons, dropdowns and screens and now they are merely skills. One of the most uh underrated thing about skills especially when talking

[4:27] about agentric products is how it has enabled to build skills for anyone who has good understanding of the products. So if skills are new features and this new features can be shipped by anyone in the company. The question is what's the

[4:45] role of engineer? Then the role of engineer is shifting from shipping features to shipping harnesses. Harnesses that are smooth vehicles for your skills to run. But before diving into that, let's just get to the basics and try to understand what skill is. The

[5:04] dictionary meaning of skill is the ability to do something well. And what it means is that your model can live with it without it. But it obviously going to do better in presence of skill. A better definition for agent skill is a

[5:23] standardized way to teach AI agents how to do a specific task well. And a simple skill could contain just like a markdown but a very complex can have multiple references to the files and executable scripts. The skill.md is the heart of your skill.

[5:46] Name and description in the front matter are the key uh things that will help you to discover the skill and the business logic and instruction goes into the body of the skill and which will also contain references to the files and scripts.

[6:04] So let's see how to add a skill support in your harness. So what do you need to do like a bare minimum skill in your harness? You only need these three things like skill registry, a system prompt, and a basic file read tool. If you're running

[6:22] scripts, then obviously you're going to need either bash or maybe a code uh running sandbox environment. But this is the bare minimum requirement for adding support of skills like in your harness. A simple skill registry looks like this.

[6:40] So what is a skill registry? It just like collection of skills with their name, description and path. And we are going to see this with three example skills. Company research skill which is supposed to do a very basic web

[6:58] search for a company and produce a markdown. a report HTML skill that will turn the markdown into an HTML. A report PDF skill that will take that markdown and turn into PDF. Now how does really the agent discover the skill? So you have your registry

[7:21] then you form a skill concat concatenating the name description path and put it in your system prompt. So if you notice like we are only using the name and description path in in this system prompt and not the skill body and

[7:40] that's what what they call about is progressive disclosure. Agent is going to read the skills and only pick the skills that it is going to read and follow the instructions from there. And then you need your agentic loop

[7:55] that will run this system prompt. Here we're keeping track of all the messages in uh in that messages array and we're going to call the model with messages and agent tools and for every turn it's either looking for like making a tool

[8:13] call and all the tool calls get appended to the messages and if there is like no tool call we are just going to output the end of the uh program and going to show the output. So in this case what does like agent see in our example.

[8:33] So it sees that the skills that are available and then the activation part is when it looks for the company research skill for take this example of if you're asking to publish a report of NVDI it is going to call company research do the web

[8:54] searches and then use the build report skill to produce the report HTML And the output looks like something like this. Now what are the learnings from some of this is the descriptions are really the routing signals. And what I

[9:16] mean by that if you noticed I had like two different skills report HTML and report PDF. But when I showed the example, you saw only HTML. And the reason is I have this description saying that use the skill only when user ask

[9:35] for a PDF report. Focus on this word PDF. Right? So that is the trigger word that helps agent to know which skill to pick and that's why descriptions are called routing signals. And it's very important to keep your descriptions

[9:55] aligned to the user request and not about the skill itself. It's also important to keep your descriptions distinct enough so that agent doesn't get confused and make sure don't let your skills get stale because these are the reasons why your skills

[10:18] don't get triggered. One more like very important difference between like skills when we talk in agentic product context is most of the skills are only model driven because for nontechnical users we're not adding that cognitive load to remember them

[10:37] uh to keep the track of all the skills. Another learning that had was cut by user intent and not by data model. So when I started building the skill library, I had very narrow use cases. So add skill for estimation analysis or add

[10:57] for fundamentals. But I got real use cases and those use cases were not reflecting the data model. Those were really about the real use cases and I had to refactor this multiple times and that is okay, right? you start simply

[11:15] with narrower use cases and as you discover more use cases you start refactoring your skill library. So in practice it means that you know instead of having an estimate analysis skill you should have earning preparation skill instead of having a

[11:32] skill for news and analysis analyst rating skill you should have a pre-market briefing skill. So we updated our uh stack to a new model and our agent start uh failing because it was not obeying the skills. Nothing was changed. Not a single line

[11:55] in the skill was changed but still it failed. And when when we dig under the hood what was happening it was that this like new model was very focusing on beginning of the skill and we had very critical instruction at the end of the

[12:13] skill. So that's why it's very important to run evals and skills without evals are really just wishful thinking. Skills are not the documentation and a lot of people treat them like that and skills are really the contracts

[12:33] versioned to a model. So whenever you're upgrading a model, make sure to rerun uh your eval. So when you have like a few skills, shoving them in the system prompt really works. But as soon as you start growing your skill stack, this falls apart. When you

[12:56] have like more than 10 skill, maybe that's like a good point to think start thinking about, you know, how can you shortlist the skills that you're going to add to the system prompt. And this could mean just like having embeddings

[13:11] and have similarity search and short lists or a smaller model that can shortlist the skills and add to the system prompt. The real trouble really starts when you have hundreds of skills. At that point, you really need hierarchy

[13:27] of skills and metadata filters and the governance in the place to keep your uh library searchable and coherent. So there are like five aspect of skill library governance and these are admission, ownership, boundaries, life cycle and coherence.

[13:52] Sounds very enterprisey right but each of this really answer like a very core question and we will get to that in a second. But when you hear governance, it really doesn't need to be a red tape bottleneck. It really depends on how

[14:12] you're implementing it. How much automation is in place with proper human in the loop. And the good news is that we can borrow a lot of good practices from code and apply them to the skills. And these coding practices like has worked for

[14:31] decades. So what does admission even mean? What it means that should this skill even exist or it should go to an already existing skill. And in practice we build automated get for the registries with human in the loop. And this is very

[14:51] analog log to how we do the PR review process. Who maintains your skill? Just like how features are maintained by application teams, we need skills to be maintained by application teams. And like code owners, we need to have a

[15:09] dedicated skill owners like named maintainers for your skills. What happens to the skill over time? You need to have semantic version of the skills and also whenever you're getting rid of skills you need to have deprecation warnings and make sure that

[15:30] your changes are reflected in the change logs. So when you have large number of skills, the library should still make sense. And just like features are cohesive in a good product, we need to make sure that we are conducting periodic audits and

[15:57] skill validation checks so that your skills would really make sense. Whenever you have a lot of skills, it's important to have the allow list tools in in the skills and your tools are supposed to be access control and this

[16:22] is very important to keep the correct boundaries around skills. So what are the main takeaways? The main takeaways are skills are the features in your agentic products. Our role is shifting from features that is shipping

[16:43] features to shipping harnesses and routing mechanism doesn't get tuned as you scale. It changes the mechanism itself and at enterprise scale the skill library governance is really non-negotiable. That was my talk. Thank you very much

[17:03] for listening. [applause] >> [music]
