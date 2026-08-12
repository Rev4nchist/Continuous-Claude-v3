---
video_id: e3RgzvuYTBY
title: "Alpha Launch 24 Hours in: AI multiplayer Problems and Wins!"
channel: "Jake Van Clief"
channel_id: UCPR4DV8qMQVs_YBa-CQZQBQ
channel_slug: jake-van-clief
url: "https://www.youtube.com/watch?v=e3RgzvuYTBY"
upload_date: 2026-08-08
duration_s: 628
duration: 10:28
view_count: 547
like_count: 24
subtitle_lang: en-orig
transcript_source: auto
transcript_words: 2187
ingested_at: 2026-08-08T12:16:12.362Z
ingest_version: 1
---

# Alpha Launch 24 Hours in: AI multiplayer Problems and Wins!
**Channel:** Jake Van Clief · **Uploaded:** 2026-08-08 · **Duration:** 10:28 · **Views:** 547  
**Watch:** https://www.youtube.com/watch?v=e3RgzvuYTBY

## Description

Join the community: https://www.skool.com/cliefnotes 

EdubaWare is live in alpha. It takes the folder structures and second brains I teach with the ICM method and puts them in the cloud, so your whole team can work inside the same workspace at the same time.

No new agents to build. No zip files to pass around. You upload your folders and markdown files, and one strong model with a good harness reads the file map, goes where it needs to go, and does the work. That becomes your company brain.

This is early alpha and we're covering the AI cost for our first testers.

## Transcript

[0:01] Hello everyone. It's been literally a day, not even, it hasn't even been 24 hours since I posted our software for our alpha testers and we already have 86 people in and another 98 pending the request. These are all there and we have

[0:15] another 370 people requesting to be in. So, the love to request the software has been absolutely appreciated. We can't let everyone in all at once. We still want to solve some problems and make it cleaner and more fun to use. But the

[0:28] people that have been in have been testing a lot. More importantly, I've been covering all of the AI cost for everyone using it. And I didn't want to let everyone in just in case my ICM process was using tokens inefficiently

[0:40] or things like that. But what's been amazing is everyone's been using a coding agent from anthropic cla right this is from me doing my own tests at huge scale and I was worried right in a single day being able to drop 200

[0:55] bucks. All of those users together have barely spent $30 in API fees. And that's going through hundreds of files and words and processes, different calls, different people in sides of different chats, asking different areas to

[1:10] different sets. It has been absolutely amazing to see how little tokens are being used. I really wasn't expecting it. And I mean that's with tool calls, that's with reading the workspaces, that's going through all the markdown

[1:25] files. It has been insane to see this is not breaking my bank account at all. Now, we set aside a lot of cash. And then, of course, not just Claude Console, but OpenAI, Gemini, all the other agents that you might want to use

[1:37] in here. We're focusing specifically with Anthropic just because I like their SDK and what we're doing there. Obviously, the platform's not limited to that. Uh, and I just wanted to verify on logs and things like that. We have

[1:48] amazing rate limits as well. Um, right, we have over 10 million tokens per minute that we can use. Uh, so that's pretty amazing as well. So, we're we've barely touched any percentage percentage there that we need to worry about. Um,

[2:01] but I will say I wanted to spend time in this video one describing what I'm noticing, explain what we're going to try to fix for the platform and what to expect in future releases, versions, uh, you know, what the road map to beta

[2:15] looks like and things like that. So, first of all, it's been really cool, right? This is multiplayer AI right off the bat. Um, we had someone create their own uh kind of choose your own adventure and it's these kind of like multiverse

[2:31] area and there's all sorts of different chats that I get to go in and vibe into. Um, right. I want to go into Let's see. Let's actually I think there was one. Was it over here? Um, Brandt was diving into it. No, I've got to find it here.

[2:45] uh because Dawn, I think it was Dawn that created this whole template. Um, and it was super cool to be able to uh go in and see uh what people were chatting about. We did have some failures because we realized that there's an issue with how large of a uh

[3:01] read each um request would be because we're containerizing all of these to keep them separate, right? Um, but once we got that fixed and working, it was really cool just to see people be able to dive in and chat back and forth. Uh,

[3:15] and this was kind of like a choose your own adventure. It has different memories and states. You have the different casts and people who are actually being in here that you can track and it's basically adding to it. Uh, and so this

[3:26] makes a folder, a zip file essentially track like if you wanted to do D and D or anything like that, uh, you could do this in here. Uh, and it would keep track of what's happened, when it's happened. And of course, it's just one

[3:37] single model. It's not multiple agent calls going through everything. It's just reading through the workspace, editing the files, and updating the process, right? Uh, and that's been really cool. That was a fun one I wasn't

[3:48] expecting. Um, that's been super cool. We've also have Ari. She started their own um, uh, kind of organization as well, separate from this one. Uh, but it's really cool to see her upload this. Essentially, it's a big corpus of

[4:01] knowledge around how to use certain processes, courses inside of ARI space. So, ARI is someone who's been super active in our community and they have a very large uh website that lets you understand loops and folders and ideas

[4:14] and concepts um around like writing and markdown files and all of these things. And so, she uploaded it in here and essentially it's a place where you can just ask where to go or the opposite direction, the knowledge can come to

[4:28] you. So because these indexes are here, the agent inside of this can actually go and find and research and look at different areas and actually recommend where to look, what to go pull through uh just by uploading a zip file. Mind

[4:42] you, this would be a chat based infrastructure with all sorts of absurd things. You'd have to build it custom for your website. But in this case, Ari just uploaded a markdown file with all of her examples. And now the AI can go

[4:53] through and recommend it to anyone. Anyone can start a chat in here and dive into it. So that's been super cool to see. Uh we did have some issues with this template that someone had uploaded. We think there's a problem in the

[5:04] naming, right? So what ends up happening is it gets stuck in this kind of thinking mode. And what we realize is that in we think it's an Azure blob storage issue. Um but certain file names I think are just not deploying well. So

[5:17] we should be pushing a fix to that here within the next day or so. Uh hopefully to you know in the next hour uh as as uh we're both working on it. Um, but we've noticed just some issues here with deployments of your your ICMs, your

[5:29] things like that. Um, and uh we've also seen people do some cool uh this is uh Craig, he does different explainer videos and things like that using animations and processes. Uh what's interesting is that in this case it

[5:45] didn't show the workspace files even though it had access to it. Uh and we think that was just a simple kind of glitch in the system that we saw um in terms of the deployment process again. So that's why we're in alpha of course

[5:56] as well. But it was able to chat and navigate them all which was really great. Um in this case it's loading the workspace which hopefully that works for me. Again this is multiplayer AI and and you know it's like using uh you know a

[6:09] coding agent locally with 100 people. Uh it's it's there's some problems that are going to come in but it seems to look well work well. It seems to navigate the workspace. Uh as you can see there was it almost showed up there for a second.

[6:21] Uh so we got to fix that too. in certain workspaces. We've noticed that being an issue. Um there it is. Amazing. And so now I can navigate um his entire workspace and see what's going on here, right? And be able to work on it with

[6:33] him. I can jump right into chat right now. Um or I can take over from where he was originally. Uh so that's a lot of fun. And then again, we'll get these issues um here where it can't return the turn uh the sandbox. Essentially, this

[6:47] is just a problem of it reading a file, failing the sandbox. We did create a nice fallback so it doesn't crash the whole system. Um but again there's there's small little issues here. Uh but I can always come in and you know um

[6:59] let's try that last process again please. Um and that's the best part is right we have a lot of continuity and backup in the back end. But these little things are what we were not little but these are the things we were expecting

[7:13] to happen. Um obviously too for the people who have started their own right you can actually come in and request organizations uh right if you were to come through and you wanted to have another organization when you join in

[7:27] and that's where you would be separate from our alpha testers and we are letting some of our alpha testers actually do that right like I have my own organization uh where I can actually control who has access to what and where

[7:38] if I go into that organization um I have different companies that we're working with right now. And so my team can come in and get caught up on what they're doing, right? Anyone can come in. This used to all be locally on my computer

[7:50] and it was super useful and it's been amazing. Uh but obviously uh you know just having my files and folders and everything there is annoying. Putting it on Google Drive and having to use an MCP that was kind of annoying. We wanted to

[8:02] have it direct and right there. And so uh that's been pretty great. And a lot of other people have been building their own orgs. Uh I think in the future what you're going to end up seeing is you know people roll through them. Uh I am

[8:13] changing this front end than the UI a lot. We're going to change the way this looks. Right now it's just boxes and folders very basic. Uh we're going to make file trees I think out of this so that you can see the or the

[8:24] conversations already going on. Um and just click right into them. Uh and there's certain deployments and processes that we we kind of want to work with with people there. Uh the other thing is too uh what I'm excited to see is people adding their own

[8:37] external API keys. Obviously, we have these in secret environments um to be separate from the workspaces so the agents can't, you know, leak them on accident, but someone had mentioned like they could put a folder structure that

[8:48] has API calls to other AI and this could just be deployed immediately on top of it. Uh and I thought that was kind of funny. It's like uh AI inception there. Um other people linking to their own local models as well, right? If you had

[9:01] to add your own agent API key, created your own API interface for your local model and deployed it, you could immediately link that in uh and have that run the whole workspace. You don't even need to use our AI or anything like

[9:12] that. It could all just be deployed separately and using your own AI there. So, there's a lot of cleanup we have to do there as well. Uh but I just wanted to give a kind of progress update on um kind of what I saw people doing, what

[9:25] they were building, uh how they're building it, and I'm sure there'll be a lot more over the next few weeks as well. But uh yeah, pretty cool stuff. Uh just in a single 24 hours, we had this many people interested in in building

[9:35] inside of it. Uh you know, for those of you who are in testing and things like that, please keep uh hammering it out and testing things. Um it looks like uh some of you are still working on through and kicking off different phases and

[9:47] processes. It's really cool to just again the whole goal of this is how do we get people to work together? Where are the spaces? What is the Google docs of AI, right? uh uh AI and agents and automating everything. That's cool, but

[10:01] those are always just going to be automations I can hand to someone. So, where do those automations sit? How can we have people work together and build together? That's where the real fun comes. And, you know, I think this is a

[10:11] good step in the right direction. We're seeing a lot of interesting work here, a lot of things being built out and uh I'm excited to see what this uh turns into in a few months or years, right? Um so, yeah, that's it. Quick video. Thank you

[10:23] so much everyone. Have a wonderful day and uh you know hope to see you in
