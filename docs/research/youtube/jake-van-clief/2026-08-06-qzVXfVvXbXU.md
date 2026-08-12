---
video_id: qzVXfVvXbXU
title: "Multiplayer AI"
channel: "Jake Van Clief"
channel_id: UCPR4DV8qMQVs_YBa-CQZQBQ
channel_slug: jake-van-clief
url: "https://www.youtube.com/watch?v=qzVXfVvXbXU"
upload_date: 2026-08-06
duration_s: 1248
duration: 20:48
view_count: 5600
like_count: 258
subtitle_lang: en-orig
transcript_source: auto
transcript_words: 4169
ingested_at: 2026-08-07T12:04:09.190Z
ingest_version: 1
---

# Multiplayer AI
**Channel:** Jake Van Clief · **Uploaded:** 2026-08-06 · **Duration:** 20:48 · **Views:** 5,600  
**Watch:** https://www.youtube.com/watch?v=qzVXfVvXbXU

## Description

EdubaWare is live in alpha. It takes the folder structures and second brains I teach with the ICM method and puts them in the cloud, so your whole team can work inside the same workspace at the same time.

No new agents to build. No zip files to pass around. You upload your folders and markdown files, and one strong model with a good harness reads the file map, goes where it needs to go, and does the work. That becomes your company brain.

In this walkthrough I cover how it works, why we built it, and the ways I think you'll use it: shared workbenches that each run in their own container, live multiplayer chats, client workspaces, permissions and API key management, and querying your own company data in seconds.

This is early alpha and we're covering the AI cost for our first testers. Here's how to get in.

⏱️ Chapters 
00:00 The ICM method and the scaling problem 
01:25 What we built, and why it's live today 
02:40 How the ICM folder method works 
04:30 Why this matters: a cloud for small software and multiplayer AI 06:40 Demo: the High Tea vault, templates, and workbenches 
09:00 Working together live in the cloud, from any device 
11:00 Building a company brain from your client work 
13:20 A teammate jumps in and onboards to a workspace
15:00 Managing it all: orgs, API keys, model providers, permissions 16:40 Querying fundraising data and anonymized readouts 
17:40 Where this goes, and why you stay in control 
18:40 Alpha access and why we cover the AI cost 
20:00 Wrap up and how to get involved

🔗 Links Try Eduba: https://chat.eduba.io/ 

Join the community: https://www.skool.com/cliefnotes 


## Chapters

- [0:00](https://youtu.be/qzVXfVvXbXU?t=0) The ICM method and the scaling problem
- [1:25](https://youtu.be/qzVXfVvXbXU?t=85) What we built, and why it's live today
- [2:40](https://youtu.be/qzVXfVvXbXU?t=160) How the ICM folder method works
- [4:30](https://youtu.be/qzVXfVvXbXU?t=270) Why this matters: a cloud for small software and multiplayer AI Demo: the High Tea vault, templates, and workbenches
- [9:00](https://youtu.be/qzVXfVvXbXU?t=540) Working together live in the cloud, from any device
- [11:00](https://youtu.be/qzVXfVvXbXU?t=660) Building a company brain from your client work
- [13:20](https://youtu.be/qzVXfVvXbXU?t=800) A teammate jumps in and onboards to a workspace
- [15:00](https://youtu.be/qzVXfVvXbXU?t=900) Managing it all: orgs, API keys, model providers, permissions Querying fundraising data and anonymized readouts
- [17:40](https://youtu.be/qzVXfVvXbXU?t=1060) Where this goes, and why you stay in control
- [18:40](https://youtu.be/qzVXfVvXbXU?t=1120) Alpha access and why we cover the AI cost
- [20:00](https://youtu.be/qzVXfVvXbXU?t=1200) Wrap up and how to get involved

## Transcript

[0:00] So, you're using folder structures and second brains and all of these things. You're using my ICM method if you've been following me for a while. And if you haven't, maybe you've been structuring prompts and data and ideas

[0:09] in a really good folder structure instead of making agents. Well, one problem that everyone's having is scaling and deploying it. And a lot of my members and a lot of people in my community have been wanting something where they can share, work together on

[0:21] documents, things like that. And that is exactly what we built and it is live today. Rather than give you the usual spiced-up perfect demo, this is alpha, but it works. It works the way I want it to and I'm super happy with our final

[0:35] version here for alpha 1.0 or I guess alpha 0.01. Uh and we're just going to dive into the ways I think you could use it, the ways it solves problems with deployment of folder structures, ignores a lot of the need for a whole bunch of crazy agentic

[0:49] work, and uh also is just a video for all of my members that are about to use it uh to kind of help them understand how, what, and why. So, let's go ahead and dive right in. Now, right off the bat, it's simple, right? Let's say

[1:03] you've built out some sort of folder structure that tracks things, right? It's using my ICM method or maybe you're using Kaparthy's LLM Wiki, right? You've got folders, you've got markdown files. When I ask the agent a question, as it

[1:18] travels through the folders, it follows through, it knows where to go, and becomes the agent I need at the time, right? So, if I'm using Claude Code or Claude Code Work or I'm using it in VS Code or I'm using Codex or Gemini CLI,

[1:34] when I say what workflows are still needing to be built for my data and finance teams, instead of some random agent that someone built that has all sorts of infrastructure, I'm using one model with a good harness, it reads the

[1:45] file map, decides what it needs to know and where it needs to go based on the question, reads all of that stuff, and immediately brings it to me, so I can quickly find and understand those files and do work inside of it, right? Way

[1:58] more efficient. This is why we've got 43,000 people, almost 44,000 in our community. But again, this is great and it needs a folder. It needs folder structure. Mouse to that runs locally and it's hard to deploy this in certain

[2:11] ways. People are using GitHub, there's different tools out there, but there's no place to really organize it all together. Well, we decided and have been building that for a while to make it simple, keep it strong, but get the

[2:23] value that you would without having to build brand new agents and all of these other things. The other side of it is Y Combinator has given requests for startups as of 2026 fall and they want a cloud for small software and multiplayer

[2:37] AI. Essentially, they want purpose-built tools that can just deploy quickly, right? Obviously, we have amazing deployment layers like Azure and AWS for big software that scales, but how can we have cloud or scalability for these

[2:49] small deployments internally or if you're a solo operator or smaller company, how can you deploy processes with authentication, permissions, things like that and actually move it forward? Well, sometimes you don't even need

[3:01] software. You just need some good folders with good prompts and the AI is the runtime and you'll get the outcome of that software. So, how do you deploy that? The other side of it is multiplayer AI. Well, you've deployed

[3:13] these things, we have these chats, but right now it's just me and Claude or me and Codex. I don't Unless someone has my login information, it's hard for us to work and be inside of the same chat uh to continue on. Like if I kick Claude

[3:26] off and walk away, can someone be able to jump back in from anywhere in the world? Well, we solved that as well. So, let me give an example what my community is about to be testing and a lot of our VIP members. So, every week we do

[3:38] something called high tea and inside of high tea, I record, we answer questions, we build out stuff. Uh people are building their own versions of ICMs on their own process here. And essentially, what I've done is locally, I've created

[3:53] a main workspace, a main ICM template that actually has to do with that, right? So, if I come in and I go, this is a local folder that's usually on my computer, right? And so, if I go look at it, right? It's got all my folder

[4:09] structure, it has workflows, it has each of our sessions where we're talking about second brains, where I talk about teams, all of these different things. And so, if I right now want to give this to people and have them use it with

[4:22] their own AI, I have to send them the zip file. They have to download it. They have to make sure it works. They make sure that they have Claude or Codex or all of these things installed. But now, what they can do is they can just come

[4:34] in and as long as they're part of my organization, and of course, I can manage users, which I'm about to invite a whole bunch of people to this, then they can just come in and they can look at it and go, oh, you have a template

[4:45] here, which is, you know, basically just an uploaded folder. There's workbenches inside of it. And essentially, what this means is it's copies of that workflow, of that ICM template that are being run inside of a Docker container. So,

[4:59] essentially, a lot of people are building or creating and buying, uh, you know, Mac minis or creating virtual operating systems. Well, we said, why don't we just run up containers that act as these operating systems for you so

[5:10] you can keep everything secure, it's separate from all of your stuff, but it still operates like it's running locally on your computer, uh, with a lot less compute, right? I mean, we're still paying a bit here or there, but nothing bad. And so, you can

[5:22] come in and we've created a workbench. I can create multiple chats inside of this, right? As if I would sitting inside of my VS Code or inside of my Claude, I'd have multiple chats, right? The problem is how people connect to it,

[5:36] when they connect to it, the editability. Currently, it's editing stuff on my computer, which is problematic if other people are going to work with me. So, instead, again, this is deployed as a container. So, I created a chat that comes in and I say,

[5:50] "What question should my VIP members ask about how to use this?" And as you can see, when you come inside of here, we've got it just like you could look at it anyway. It renders the markdown. If you want to look at the source of the

[6:01] markdown, it's there. If you want to download anything, there's options to download certain stuff. You can immediately have the entire beautiful process of my ICM method, my research paper, but all deployable in cloud. And

[6:15] so, not only can I access this chat, and not only is this not just Claude Sonnet, this is Claude Code running with Claude Sonnet as a model. We could use any harness. We could use Hermes with Kimi K2. We could use anything. At this

[6:28] point, we're offering a free version of it through Anthropic, through these areas of Claude Code inside of it, because well, we like it, we trust it. And honestly, I'm able to handle a lot more token consumption there for reasons

[6:42] I'll explain in a moment. But, it immediately is navigating, walking through it, diving into these processes. You can see it's reading as if it is locally, going and diving through it. And now, anyone else can come in and ask

[6:56] questions, work with me as if I would be working on it. Or if I'm currently working on this package, like I would be in VS Code or in Claude Code, we can now work on it the exact same way with no decrease in quality or ability, right?

[7:10] No decrease there. And on top of that, I can start a new chat, which now all three of us can be doing different tasks on the same folder structure. And as one person is editing it, I can also be editing it. But, we can protect certain

[7:25] parts of it. We can edit certain parts of it at certain times. So, now context is shared as we're working. So, we get to work together. It's not deploying it and pushing it and sharing it constantly and waiting until it updates. It's all

[7:39] in the cloud and live. And the best part is, maybe I finish working on this computer and want to log in on my laptop, it's right there. Maybe I want to share the link with another member, it's right there. Maybe I want to start

[7:49] a new one with a different company, it's right there. And it's all deployable, easy to use, easy to read, it renders HTML if we really want to do that as well, and it has it all built out inside. Now, the initial ones that I'm

[8:04] launching to my community are going to be a vault of all of our ever sessions and them able to essentially query it and ask it questions. We can go back to all of our previous talks and the packages that we built out together, and

[8:17] they can even upload and talk about it in their own way. We get to see what other questions people are asking and really just explore what it means to work together in augment, cuz I don't think this type of workflow's been

[8:27] available for anyone yet. So, there's still a lot of questions we have to ask, right? The other one is also a workbench or an ICM to be able to audit your own, right? If you're building these locally on your computer, I have a GitHub repo

[8:40] that dives into it and does it for you, but what if you would ask questions about how to do this? So, I built an ICM of corpus of processes of what it means to talk and work together and build out into this. What does it actually mean?

[8:54] What can I do? How can I ask questions? You could upload a markdown file of your ICM that describes it, and this will audit it and you can see, and then guess what? I can see what questions you're asking, so we can work together. But,

[9:08] where is this actually going? Where do I see the big long-term value? Well, that goes for how I'm using it internally with my company and what it means to have a company brain, to work together at a deployable level and still have

[9:21] control. And in order to do that, all I have to do is go to my other organization. So, here's all my workbenches and ICMs, but if I come over to my main company area, I can actually go and see I have multiple templates here. And here is some data and

[9:36] templates we're actually using internally. These are second brains or workflows that we built for clients that we are working with, right? And if we were to dive in and look, there's nothing in this one. So, if I started a

[9:48] new workbench and said, "Let's chat about our work with Field so far." Immediately, I now need to name this workbench. What we're doing is we're copying my ICM, my folder. Now, originally, this is locally on my computer in VS Code as a folder. But

[10:07] now, it's deployed and it is currently deploying this into a container. Um main. We're just going to make this the main one where most of our chats are. Immediately, I now have a perfect place to go ask, "What did we do in Chicago?"

[10:24] Chicago? Immediately, what's actually happening is it's looking at these questions. Right now, we have a version of Claude Codec going in, reading through all of these, looking through commands, and deciding how to ask. And the best part

[10:38] is, I don't have to sit here and think. I can immediately just bounce out. That's going to sit there and work. I can make a new chat in the same field, immediately start working on some project, and just come back to this when

[10:50] it's done actually chatting. The other thing that I can do is someone else can now ask questions and dive into it, right? If we come in here and we have a test workbench, I'm asking what we're doing for this company. I say, "Hey,

[11:03] what's in week two?" Someone else has already been building all of these files, talking about what our workshops are looking like for this client, who they are, intake forms with them, and it's only inside of my organization and

[11:16] the people I allow to see it that have access to it. It immediately tells what we're doing, what kind of work we're doing, what days, because it's just pulling from our folders and files on this work. But I don't know if you

[11:28] noticed this earlier, there was another chat here. I didn't start this chat. One of my team members did. And he wanted to know, "Hey, what's going on in this workspace?" He's onboarding to this client. Immediately tells everything

[11:39] about the workspace, what we're doing, who we're working with, how we're doing it. Hey, can you find information on the 14th August drop? Oh, yeah, okay. Boom, boom, boom. We've created a company brain with two buttons. We created a zip

[11:52] with a bunch of folders and information and markdown files, and we uploaded it here and deployed it. And then, I can jump in and say, "Oh, I'm in this chat now, by the way." Okay. Cool. Thanks for being here, Jake. Now, we both can work

[12:03] on a similar project. We both can send out a version of Claude code. Again, it could be any other one, but a really good model to build, add to this workspace, look, create, and work together without me having to email these back, upload it to GitHub, send it

[12:18] somewhere in Google Drive. No, it's all here. It's our company operating system. A true agentic OS. But, there's only one agent. We don't need hundreds of agents moving things everywhere. It's just folders and files. One key point of

[12:34] failure, that's separations of concerns that allow us to audit it and govern it so much better. And all I have to do to create another client, another place, is either organize, right? Create another organization, or I can manage API keys,

[12:50] I can manage external APIs, so things that aren't even AI. If I have connections to Google Drive or anything like that, it's as simple as throwing it in here. It never gets added to the workspace. It never gets added to the

[13:02] folders, so it can't ever get leaked. It's separate. It is a separate call. On top of that, I can add new model providers. If I want to add in something from Anthropic, or if I wanted to add in something from uh maybe we want to do

[13:16] Google Gemini or XGrock. Maybe I have local models. Being able to throw that in here is the main goal. Some of this is still being tested, full transparency. Uh but, that is the main area. And then, of course, if I want to

[13:28] manage all of my templates, the ICMs that are being uploaded, it's all right here. And I can log in, join in, and ask about my company, right? So, this is my management that I have for my entire Aduba, and it's never been used before.

[13:42] I just uploaded the zip file. I say, uh, "Where are we in our fundraising, right? Now." And again, I haven't made the workbench yet. It automatically makes the workbench. I'm just going to call this one main as well. Sh- opens up the

[13:59] container, opens up the actual processes, deploys it as a simple folder, and immediately makes a request to our Claud process. Now, while that's sitting there, immediately pulls it up, it's going to start working and answering my question for me. And you

[14:14] see, while that's finishing, I can go back to my other workbench that we had asked earlier, remember? And so, we can just go out, go back to our templates, come over to the main field team one. And look, it should be done here.

[14:27] Amazing, right? Let's chat about our work with field so far. What did we do in Chicago? And also, while it was thinking, I threw in just explain in bullet points. And that's the best part is while it's thinking, you can actually

[14:37] throw it in, right? It's this process of collaborative work together. Not just one output done, one output done. Claud, code, codex, all of these things, they have the ability to continue chatting while it's thinking. And we wanted to

[14:50] make sure that that was in here, too. Now, as we come through, here's the Chicago work, built in bullet points. Here's what we did, who we worked with, here's the main programs, all of that stuff. I now have a company brain that I

[15:01] can query quickly, easily, with very low deployment needs, but all of the good stuff of enterprise deployment. I can share this with multiple teams, we can chat together, and more importantly, this isn't just pulling from everything,

[15:13] it can edit and access this. It can change each of these processes and ideas. It can change the fonts or the skills or the ideas while we're working. It is not just a skill that it is editing of folders and files. It is a

[15:29] breathable workable workspace that multiple people can edit together and keeps everything up to par. And if I come back to the conversation where I asked about our fundraising goals, I noticed that in the chat above, it gave

[15:42] me very specific details cuz it has access to all of that. It's all in siloed data and we have it elsewhere, but I just needed it anonymized so share it on the screen here because some things we don't want to share. And so I

[15:53] simply said, "Oh, hey, give me a readout that's slightly anonymized." Immediately, that's exactly what it did. It knows my processes, who we've talked to, where we're talking about due diligence and processes, different

[16:04] pipelines and ideas, what we've closed, and it even gives me a quick little look of where it's been looking. If it was to add anything or edit anything, I can easily wander in and everything is human-readable. There's no crazy agentic infrastructure.

[16:19] There's not multiple agents doing crazy things. It's all right there, simple to build in, simple to iterate on. And that is the power of a lot of this. Now, it is early on. I want to make this very specific cuz right now we're having

[16:33] people come in and test inside of organizations we create. But in the future, many of you will be creating your own organizations. You might have multiple for different clients or maybe you have your own company's organizations, and inside of each one,

[16:47] you have workbenches for each client, right? It's a very dependent thing. But just by naturally uploading these folders, these files, these areas, putting it here, you're creating the company brain as you do your workflows,

[17:00] as you learn how to use this. You can easily delete and move and edit it. You don't have to go and talk to some vendor to change their agentic workflow and then decide where their LLM wiki second brain should design it in. You're in

[17:13] control. You know where the folders are and how they are. You can decide who has access to what and where who can and can't change certain things, what your users are doing, where their roles are, inviting them at scale and bulk, or

[17:27] inviting them back. In my idea of the future, this is a great platform to handle a lot of the problems we've been seeing when working with companies that were trying to get ROI in AI. Now, I could probably going to do a lot more

[17:40] videos to kind of exemplify this, but I just wanted to do a quick launch video, show what's out there, give that idea. Again, this is only launching to our uh main uh alpha testers first, people that are getting approved through VIP for two

[17:55] big reasons. One, I'm covering all the AI costs right now. You don't even need to have a Claude Code Max account to get the ability or capability that would have been with Claude Code or Codex. We are covering those costs. Because of

[18:07] that, uh it's going to cost us a little bit of cash more people that use this. Luckily, uh Anthropic as well as others, we're on the scaling tier, which is the highest tier that you can have with next to custom. So, we get over 10 million

[18:19] tokens per minute. Uh we get over $200,000 in max spend if we really wanted to do that. But, this is going to be a lot of money that I'm spending testing this for you all, solving these problems for you. So, I need people to

[18:31] pay, or else we're going to just not be able to scale with this. As we learn how much it costs as we go through it, we're going to allow people through. The other side of it is, when we see people working well with it and they have a

[18:43] good use case, we're going to allow them to put their own API key in, or even in the future, just put your subscription that you're already paying for with whatever service provider it would be inside of it. And that's a real big goal

[18:56] there. Uh but that's just super important. We have a lot of credential usage and dashboards of how many credits people have, people requesting more credits. So, if you want to use your own AI API key, a company doesn't have any

[19:08] AI accounts at all, you can just walk in, build their stuff, have them log in, and it's super low friction. Uh we also get to look at users' dashboards, and we're creating different versions of this, which of course will be updated

[19:20] with time. This is early alpha. Uh but that's it. Right now, I think over the next 2 weeks, it's just going to be a lot of testing, a lot of work, seeing how people work together. I'm really, really interested to see how we

[19:33] kind of do this multiplayer AI work in chats together, ask questions, build together. I'm excited to see where that's going to go. And it's finally at a point where it's actually working in high quality. It knows how to navigate

[19:45] folders, build things, create HTMLs, install packages, uh use Python, use Playwright and Chromium, all the good stuff that you would get out of these coding agents, but in a in a multiplayer environment, so to speak. Uh so I'm

[19:59] excited to see what we can do. Uh if there's anyone who wants to work heavier with this, I have the email uh info@aduba.ai um or .aio, sorry. And of course, in our VIP community and our Discord, we'll be sharing a lot more

[20:14] about that. We will be doing a larger public release uh little by little and getting people involved. You can sign up right now, even if you're not part of our community, you just won't have access to anything. Uh and so we can get

[20:26] you into the system and start getting you there. Uh but as always, uh you know, we're in alpha right now, and we need people to test it. So, hopefully this is interesting to all of you. Hopefully you see the crazy use cases

[20:36] that you could rip through on this and uh want to explore. And uh in the meantime, before all that, uh happy learning, and I can't wait to see what we build together. Thanks, everyone.
