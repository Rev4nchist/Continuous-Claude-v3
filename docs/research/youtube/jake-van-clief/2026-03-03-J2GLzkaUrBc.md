---
video_id: J2GLzkaUrBc
title: "I'm Building a Custom Front End for Claude Code (Here's the Plan)"
channel: "Jake Van Clief"
channel_id: UCPR4DV8qMQVs_YBa-CQZQBQ
channel_slug: jake-van-clief
url: "https://www.youtube.com/watch?v=J2GLzkaUrBc"
upload_date: 2026-03-03
duration_s: 295
duration: 4:55
view_count: 4776
like_count: 79
subtitle_lang: en-orig
transcript_source: auto
transcript_words: 1008
ingested_at: 2026-07-25T15:24:26.365Z
ingest_version: 1
---

# I'm Building a Custom Front End for Claude Code (Here's the Plan)
**Channel:** Jake Van Clief · **Uploaded:** 2026-03-03 · **Duration:** 4:55 · **Views:** 4,776  
**Watch:** https://www.youtube.com/watch?v=J2GLzkaUrBc

## Description

Join my Community to learn more! : https://www.skool.com/cliefnotes/about I'm building a custom front end for Claude Code. In this video I walk through why VS Code works but has limits, the open source repos that already tackle this problem, and how I'm using a PRD (Product Requirements Document) to plan the whole build — phased out from early to late so Claude doesn't try to do everything at once.

This came from a great question by David in the community. He wanted a way to monitor and observe how agents work inside Claude Code, and that got me thinking about what a purpose-built UI could look like — mind maps, web-based folder navigation, the works.

📌 Join Clief Notes (free community):
https://www.skool.com/quantum-quill-lyceum-1116/about

HASHTAGS
#ClaudeCode #ClaudeAI #AIWorkflow #CodingWithAI #Anthropic #AITools #AIAutomation #BuildInPublic #OpenSource #AIDevelopment #VSCode #AIAgent #ClaudeCodeTutorial #FrontEndDev #AIForCreators

## Transcript

[0:00] So, David had a great question. We were kind of talking about, you know, making animations with Claude code and he you know, watched my initial video and then also kind of set up some really great animations himself, which I absolutely

[0:12] love. Obviously, there's always more tweaking that you can do and I'm I'm creating videos on how to do that. But, he had this idea of creating a front-end UI that allows him to control Claude, right? Right now, he's using VS code,

[0:25] which is what I tell, you know, tell people to install and it's a great place to kind of use it. But, he wanted something a little bit better that he could like monitor or observe [music] how the agents are kind of working. Now,

[0:36] the problem is is whenever you're using Claude code or Claude CLI is you can use your subscription. You can use your Anthropic subscription, so it doesn't cost as much. If you did API calls for all of this, it'd be really expensive.

[0:49] But, with the subscription, it's not as expensive. But, as soon as you're building a front-end, it's a lot easier quickly, or at least you would think, to use, you know, Anthropic calls because then it's kind of clunky to control

[1:00] Claude code through your own front-end. However, there are ways to get around this and so, I went and actually had Claude do a little bit of digging to see what some open-source files are out there for and there's actually some

[1:10] really great open-source repos that are already out there where you can control Claude through this like kind of downloadable front-end and it can even track usage if you are using the front-end, as well as this other one

[1:22] where you're able to do it through your mobile. Now, there are ways to actually control Claude code remotely and I've actually installed that where I use it through my phone. So, I'm going to make a video on all of that, but I wanted to

[1:32] make a quick video real quick on this idea of like me actually researching it and and processing like what it could look like because I'm actually going to go ahead and develop a front-end specifically for this where essentially

[1:45] you can access it, but on top of that, it might be able to make kind of like a web service for you or some sort of like like a web. You're able to navigate the folders not just like simple folders like this, which is how I currently do

[1:59] it, but maybe something like a mind map or a web map. Um and so I'm I actually told Claude how, you know, "Hey, this is my idea. Let's not reinvent the wheel. Let's use what they're doing in these open-source areas. Let's look at each of

[2:12] those repos." But also I used my own build that I have personally on my computer here, right? This is my animation workflow, how I go from scripts to animations, and there's a lot here. And don't worry, I have a course that's going to be breaking all

[2:25] of this down in detail. But at the end of the day, I wanted to share kind of my Claude and me, right? Cuz I give Claude the same markdown file before I'm ever using it, which shows the file structure. It shows all of this stuff.

[2:38] In this case though, I'm working backwards. I'm giving Claude my my structure, my files, saying, "Hey, what if we made a front end directly around this folder system and around what I'm trying to do here, around my script

[2:50] design, around my areas here?" And uh kind of working with it on this area. And so it's come up with some really good ideas for the architecture around it and understanding it. So what I'm actually going to do is I'm not going to

[3:02] have Claude build it in the desktop. Sometimes I use the desktop one just because it has, you know, a lot of memory and it's easier to use. I'm actually going to have it make a PRD document. Now, a PRD document is a product requirements document, right?

[3:15] PRD doc is really something useful. It's used in software programming, things like that. It describes what kind of stacks you need, right? What your integrations might be, what you're trying to do, targeting, right? Things

[3:27] like that. And Claude understands what PRDs are. But I specifically say a PRD make a PRD markdown of this for Claude code as in it will read it that describes what we are trying to do and breaks down steps and structure

[3:56] for early phase to late phase, right? So, just trying to get it to kind of break it into steps rather than build the whole thing at once. And what this is going to do is it's going to give me a document that then I can go in and read and edit.

[4:10] Now, I have a background in software, so it makes it easier for me to know, "Oh, I don't really want to use that software. Oh, it's being too complicated there." But, you can actually feed this into another version of Claude and have

[4:20] it act as that auditor and it can kind of redo it there, which is really cool. So, immediately it's going to do that. It's for this. It's I'm the owner, right? And it gives us all descriptions. When this is done, I can download it,

[4:32] drop it into my workspace, and actually have it build the front end inside of this workspace just by simply opening up my my next-thing Claude code and saying, "Hey, read the PRD for the front end." Once I drop it in here, it's immediately

[4:47] going to be able to see that and move that in there. So, pretty cool. Just wanted to make a quick update video on this. I'll make a course on both of these very soon.
