---
video_id: vyN7ITKcGXU
title: "Claude Code + Remotion: Build Long-Form AI Animations from a Script"
channel: "Jake Van Clief"
channel_id: UCPR4DV8qMQVs_YBa-CQZQBQ
channel_slug: jake-van-clief
url: "https://www.youtube.com/watch?v=vyN7ITKcGXU"
upload_date: 2026-03-06
duration_s: 1351
duration: 22:31
view_count: 18178
like_count: 604
subtitle_lang: en-orig
transcript_source: auto
transcript_words: 4388
ingested_at: 2026-07-25T15:24:26.354Z
ingest_version: 1
---

# Claude Code + Remotion: Build Long-Form AI Animations from a Script
**Channel:** Jake Van Clief · **Uploaded:** 2026-03-06 · **Duration:** 22:31 · **Views:** 18,178  
**Watch:** https://www.youtube.com/watch?v=vyN7ITKcGXU

## Description

Join my Community to learn more! : https://www.skool.com/cliefnotes/about

 The Exact Workflow I Use to Build AI Animations from Any Script (Claude + Remotion)

How I go from a script to a finished animation using Claude Code and Remotion, without touching a single line of code. This is the full workflow, including the spec system, folder structure, and how to make it all editable in plain English.

Timestamps
00:00 What this video actually covers
01:20 What Remotion is and why it works with Claude
03:45 Installing Node.js and Remotion (or letting Claude do it)
06:10 How the agent skills/prompts system works
08:30 My two-workspace folder setup (Script Lab + Animation Studio)
10:15 The four stages: script, spec, build, render
12:40 What a spec file is and why it matters more than the code
15:00 Live walkthrough of Claude building an animation from a spec
17:20 What the code actually looks like (and why you don't need to touch it)
19:00 Rendering and dropping it into CapCut
20:30 How to start your first one today
21:45 Courses, community, and what's coming next



Remotion agent skills:
https://github.com/remotion-dev/remotion


## Chapters

- [0:00](https://youtu.be/vyN7ITKcGXU?t=0) What this video actually covers
- [1:20](https://youtu.be/vyN7ITKcGXU?t=80) What Remotion is and why it works with Claude
- [3:45](https://youtu.be/vyN7ITKcGXU?t=225) Installing Node.js and Remotion (or letting Claude do it)
- [6:10](https://youtu.be/vyN7ITKcGXU?t=370) How the agent skills/prompts system works
- [8:30](https://youtu.be/vyN7ITKcGXU?t=510) My two-workspace folder setup (Script Lab + Animation Studio)
- [10:15](https://youtu.be/vyN7ITKcGXU?t=615) The four stages: script, spec, build, render
- [12:40](https://youtu.be/vyN7ITKcGXU?t=760) What a spec file is and why it matters more than the code
- [15:00](https://youtu.be/vyN7ITKcGXU?t=900) Live walkthrough of Claude building an animation from a spec
- [17:20](https://youtu.be/vyN7ITKcGXU?t=1040) What the code actually looks like (and why you don't need to touch it)
- [19:00](https://youtu.be/vyN7ITKcGXU?t=1140) Rendering and dropping it into CapCut
- [20:30](https://youtu.be/vyN7ITKcGXU?t=1230) How to start your first one today
- [21:45](https://youtu.be/vyN7ITKcGXU?t=1305) Courses, community, and what's coming next

## Transcript

[0:00] The video you've all been waiting for, how to make animations with Claude or any other coding bot for that matter that really look great. And what for those of you who don't know what I'm talking about, I mean specifically

[0:11] animations that can be 20, 30 minutes long aligned from a script in a relatively automated process where I say, "Hey, look at this script, make me some animations on it." It's a little bit more complicated to set up, but once

[0:23] it's there, you're able to create automated scripts from all sorts of things and not just long-form full shorts, and they don't have to look like this. They can look completely different. It's all whatever you know, Claude can create within React

[0:37] framework, which I'll explain here shortly. But let's go ahead and actually understand that what this will look like. >> [snorts] >> So, essentially, how I make these animations is more of a workflow that I've developed over the last few months,

[0:51] and it's off this idea that you don't need to necessarily build apps for everything. All I do is build in English in a document in a folder file, and Claude codes follows a series of processes, uses libraries to create those

[1:08] animations that you just saw. I can use natural language to edit them. I can not even touch any of the files, or I can edit every single process along the way. Now, the main things that you're going to need to do this is Claude code,

[1:24] Remotion, Node.js, and some Remotion skills from GitHub, which you can also just download those last two things from Claude code. Actually, those three things, the Remotion, Node.js, and Remotion skills, you can all have Claude

[1:38] do for you. If you don't know how to install Claude or Claude code on your desktop, I have another free video that you can go check out that shows you how to get up to speed there. But this video is based under the understanding that

[1:49] you have already done that. Now, Remotion is essentially a library that allows you to take animations and build them with code. Now, what does that actually look like? So, there's a couple things here that I want to show you.

[2:07] Remotion itself is essentially this really great library and what they realized is that React, which is the same stuff you program websites, this webpage can be programmed in TypeScript, React, things like that, can actually be

[2:21] lined up and you can create frames from each little animation that actually creates videos or animations or things like that. They also realized that Claude was really good at doing it, so they went ahead and actually created

[2:35] skills for Claude to be able to use. So, if I go here and I go straight to their agent skills, they actually show you you can install them directly. Now, what they're doing is using an NPX command, which if you don't have something called

[2:49] Node.js installed and don't worry, I create other courses diving into computer literacy and what all this is. Essentially, it's a way to use commands that download stuff from the internet without you having to interact with

[3:01] browsers. You don't necessarily have to do this. Claude can do this for you or you can download the actual GitHub itself. They have all of the skills. For those of you who don't know what a skills is, what skills are, essentially

[3:16] think of them as large sets of prompts and instructions that someone else figured out how to do and realized, "Hey, let's just package this and let other people download it." So, Remotion has a skill that says, "Hey, this is how

[3:29] you do use it." and then they created a bunch of sub files so that Claude doesn't have to read it all at once that handle 3D content or check if a video can be decoded or DOM elements or Tailwind, all these concepts of design

[3:42] and visualization all packaged inside of a single, you know, section here, right? And you can actually come in and see and read all of these. They're all just natural language with some code, right? But the code doesn't run. The code is an

[3:56] explanation that Claude is reading, and we're going to dive into a little bit of that later. Again, you don't need to know what any of this is. You can just have Claude install this package, and it'll run it. It'll know how to do

[4:10] it, and I'm going to walk through that a little bit now. So, option A is just add it to an existing project. You can tell Claude to run this. You can give it the GitHub repo. You can literally come in, and you can say, you know, if you have Claude

[4:25] download, you can either do it through the app itself. Uh if you don't have co-work the pro edition, that's okay. It can walk you through it, but I highly recommend using Claude code. You're going to need to do that. You can say,

[4:36] "Hey, hey, help me install uh Remotion." Give it the GitHub link. Literally, you can just come here. You can just take this, or you can come here and take this website, which is also the same thing, and just basically say,

[4:54] "Help me install Remotion." Oops. "I also need Node.js." It can walk you through how to install that, but it's actually way simpler than you think. Just type in Node.js, and it looks something like this, and all you have to do is download this.

[5:14] What this is is essentially a framework for you to run JavaScript on your computer in a specific way. It gives you a couple of commands to be able to do things on your computer, and I actually recommend downloading this in general if

[5:28] you're getting into vibe coding or using AI in business, because this allows you to download packages from GitHub and other places with a simple command, rather than having to go there, download it, install it, and it just allows for a

[5:40] lot cleaner execution and installation. Um but that's, you know, side note. So, you can have to do it. you can install it manually. There's also bunch of installations on YouTube you can check out. And you can just comment and ask in

[5:53] the main hub if you're still having trouble building that. Once you have Node.js installed and you have Remotion just installed to a basic folder. I mean, literally, you can come in create a new folder, animations, wherever you want on your desktop,

[6:10] anything like that. You can open it up. And now, for me, I like to run all of this in VS Code. Again, watch my other video so you can see how I use Claude. But all VS Code is doing is it's type of coding IDE that lets you see your

[6:24] folders a lot better, right? This folder is literally just this one right here, right? Everything you're looking at here, right? Front end, front end, it's all just letting me see the folder as a file tree rather than having to, you

[6:39] know, click through, click here, then click here, and so on and so forth. But basically, you just have Claude installed it to a basic folder, Remotion will get installed. What it looks like for me, now I have a lot of extra skills

[6:51] and processes and things that I'm going to show you here shortly. Um but essentially, it's just going to actually install a couple of basic templates and like processes that Remotion will help you do and have a skill or it'll install

[7:05] the skill directly to Claude. Again, don't get overwhelmed by this if you're not a programmer, you don't need to use VS Code, but I have an intro video on how to install it and what that looks like. Again, you don't need to use these

[7:17] commands, you can have Claude help you install that. But it's good to learn because this is a skill that you will learn over time to actually help you do more things in the future with AI. Now, the main way I run with this is I

[7:30] have two main workspaces. And the workspaces are just folders. Again, this is just folders. No crazy apps or anything. I have a folder for my script lab, which hosts all my long-form scripts, as well as all of my short-form

[7:47] script. And then I also have a folder that has my animation studio. So, it's like, okay, this is going to host my workflow, right? So, I bring my scripts in here, which then is brought into creating a spec or specification file. Don't worry,

[8:02] I'm going to go detail what that is, but basically, think about it like a storyboard, right? Hey, you know, at 4 seconds in, this is what I'm saying. I want to make sure I have a visual philosophy here. There's key moments

[8:16] that I want. There's certain elements. The AI can build all of these, by the way. The reason you're doing this is because you can break it down into steps, right? This is super easy to edit. I can have the AI automate from

[8:28] script to animation, or I can get deeply involved in editing the script and messing with it. And now you're starting to see why it's so nice to have this here, because I can navigate the folders much simpler. I can go to my long-form,

[8:41] have it opened up here, and read it, instead of just having to like go through, open it separately, read it, then close it. VS Code lets you just have it all on one screen. So, that's another reason why you might want to do

[8:52] it. Again, not required. You can even do all of this through the main app by literally just selecting your uh folder that you're operating in, and it will work roughly the same. Mm. But, anyway, so, this is just a way for

[9:08] me to organize it. It also allows me to organize extra prompts, which I'm going to go into here shortly, but I want to think about the stages real quick. Essentially, what I do is I write a script, or I have AI write 100 scripts,

[9:20] and then pick a couple out of it. Then I have the AI or myself take that script and might write a specification. Again, all of this in just basic English, saying this is the kind of colors I want. This is what I want there. The AI

[9:34] can automate all four of these steps, or it can touch none of the steps except for one. That's the whole beauty about my workspace here. Now, the build is where it actually starts writing code, and the code is just React, which is the front-end

[9:49] language, or it could be JavaScript and a couple other things for animations. So, when you look at an animation that looks like whoopsie, that looks like this, let's go here, right? There's individual frames. Every single one of

[10:03] these frames require some sort of little bit of code to create those animations, those dots. There's different sequences and scenes. And so, AI, the Claude, is going to break those down. What that actually looks like when

[10:19] it starts building from a script, right? And again, all I have to say, literally, is let's build a animation from a spec. And it immediately, because of I how I have all these folders set up, because of how I'm doing this, you don't

[10:37] necessarily need to do it this way. You can do it much more manually, but I have automated processes where I have a folder map in a context file, which lets the Claude code be able to run through it. And this same exact thing, I can say

[10:51] inside of the normal app as well. Let me actually just show you that right here. Uh let's see. We're going to go dishta do do do do do do do do do do do do do. Oops. Content writing, select folder. If I ask the same thing, right, it's going to

[11:06] roughly give the same answer, right? It's this just a different UI. That's all this is. It's the same Claude code. And that's the beautiful part behind this is the software, the app, is the folders, and Claude code is the running

[11:18] time. It's the thing that's actually running the software. And it's able to go through and find all my specifications, my like my animation things that I made from scripts. That easy. This is how I'm able to control all of this. It's just natural language.

[11:32] Then from there I can say, "Hey, let's go ahead and build it." Now, I'm not going to do this in front of there for this one just because I don't want to build any of these right now. But, if you look at maybe this one that I have

[11:44] up here, right? I read my script for writing in tone, understand it. We I gave it a transcript from a video as well, and it was like, "Hey, I want to reread this transcript." I literally just copy and pasted it. Let's go ahead,

[11:58] think about this, and think about actually building it. We kind of talked back and forth. I did something similar here as well, um where I was like, "Hey, I want you to understand this and build this process." We can even go to other ones, right? Um

[12:12] is it going to show it? It's not going to show it right now. And all I'm doing is saying, "Hey, let's go for it. Go ahead and start building." And it's going to start thinking about the structure, what it's going to do,

[12:21] how it wants to work with it. Once in a while I'm saying something here, you know, "What's the value question?" I'm actually writing the script in this process. We finally came to a decision. Let's go ahead and write the spec for

[12:33] it, right? And then it just goes through. It knows what to do. You don't even need to see all of this. You could just do this in here in Claude code, and it's really going to dive into all of that. From there it actually builds the

[12:44] animations. And those animations are going to be stored in a separate file. It does this automatically, but just to give you an idea of what's going on behind the scenes, let's say I looked at my AI paradox kind of one. It's a very

[12:57] long YouTube video. I have a whole bunch of scenes that it's creating a bunch of React code for. Again, you don't know how to know how to do React. I'm just showing you this so you understand what's going on. Each of these are

[13:08] beats, animations that are going on that you're seeing right here, right? So, that was scene one, um and that's the velocity gauge. So, what that is essentially is right here, right? That's that animation we're looking at. So,

[13:23] when I go through, we hit frames 800-ish roughly, and next thing you know, boop, you're going to go ahead and get this velocity gauge that's made there and animated. And all that is is right here, right? It's just a gauge, how big it is,

[13:37] what it's doing. This is great because then I can say, "Oh, I want to make that gauge bigger." And instead of me having to code and edit it, the AI is going to do that for me. And again, you don't even need to touch any of that. You

[13:48] don't have to look at it. It's just again, understanding how I've created this automation to be editable at a professional level so you can start controlling it and maybe even making money from this process, right? So, that's kind of what happens in the

[14:02] build stage. Then finally, I just ask it to render it. And this is just like if you've used any video editor or you've just downloaded a video, it's kind of the same thing. It just renders it out and essentially creates a video that you

[14:15] can then just throw into CapCut or something like that, right? Um it takes that video, renders all the frames, and puts it into something. So, like you can come in, right? Um and this is a a uh one that I'm actually working on

[14:27] right now. And it you can just upload it in, right? I've got the animation here. And then boom, you can attach sound to it, you can do voice-overs, you can do captions, all that good jazz, and do all your normal video editing uh if you want

[14:41] as well, which is very strong in that aspect. Most people think the code is the hard part, but again, it's actually the spec, the specifications for what the agent is building, what is actually being built. The spec is specifically, I know I just

[14:57] described it a bit, a contract between the voice-over recording and the animation. It's the thing that's making sure that the timing of the script is carried over into when the animations are. And again, it's just written in

[15:11] plain English. You can You can edit anything you want about it. My specs uh for like let's look at this, you know, the one we were just talking about uh uh, it's a long form one uh which is the AI paradox. Again, it's talking about

[15:26] timestamps. It's looking at duration. I'm able to edit this. Like, oh, wait, hold on. I think we're off by 20 seconds here. Or I can have the AI read through it. I can write what I want my visual philosophy to be. And that's it. That's

[15:38] all it is. This is a timeline of what it looks like and the timestamps. And again, the AI can just build that. And I do have spec templates that already have this all set up and in a in a certain way. Make sure to hit me up if you want

[15:53] this. I will say I am charging for this. I'm sorry. I've put a lot of work into this. But again, it's comes with the $7 a month fee that I'm charging. So that's it. I'm not charging like hundreds of dollars. I'm just seven bucks, bro. That's all

[16:06] I'm asking for all I There's a lot of hard work. You know what I mean? But if you want any of these files, also, I'm going to have a much deeper video that is going to be behind the $7 a month paywall going into how you can

[16:17] build your own versions of these or take these and turn them into someone else. But again, I have access to all this. Just either message me or actually, yeah, just message me before you subscribe. Let me know that you're

[16:29] going to. I'll get them to you. And we'll actually create a more automated process for that in the future. But anyway, continuing, right? Let's say you don't want to do that. You just kind of build this all on your own. You take the

[16:40] transcript from this video. Pretty much the spec is just containing these four things. A beat map, so every moment, visual philosophy, what the viewer should understand, key moments, and audio sync points. Those are the key

[16:54] parts of all of it. What it doesn't contain is like specific frame numbers. There's no talks of pixel positions, no component props, and no code. I did that before, and I actually found that constricted the model and made it not do

[17:07] enough, right? It actually made the animations worse by controlling it. Giving cod code a little bit of creativism is a really great thing. So, from end to end, it's script, what needs to be said, spec, generate from the script, output. And I kind of gave a

[17:26] live demo. I made it in this slide point where I give you one, but I decided just to do live demos throughout the entire thing. Again, Claude is just building it. It's just pulling in, creating sequences, and you can actually watch it happening,

[17:39] right? We're here, it's sitting here, and it's reading all the files, and then it's writing something. It's like, "Oh, let me write a transition. Let me write some sort of frames and constants. Let me actually import React and actually

[17:51] write these in every single file." And then from there, you can actually see it building all of these. And again, the same thing in here if you wanted to watch it actually do that. I wonder if I have Hold on. Let me look and see. Here we

[18:06] go. Is this No. In this remote control session. Yeah. So, right here, it's the same exact thing. I'm just saying, "Um let's do this specific script, right? Agents 20 bucks. I like that hook. Cool. I don't like what you changed on it."

[18:22] We're just kind of talking back and forth on what the script is and what the spec could be. It finally came up with the script. Then I'm like, "Hey, I'm actually using this through my phone here." So, I set up remote access so I

[18:34] can pick up my phone and actually message my computer. Again, I'm making a whole course on that. That is something you should subscribe to as well to to build it. We're building it slowly. I'm setting it all up, but super good there.

[18:47] Then from there, I'm just kind of messing around with it and seeing it and actually having it build these and build out that animation. And that's how I'm able to build all of these animations that you just saw. Literally, every

[18:59] single one of these was built that way, edited that way. Some of them are good. Some of them are better than others. I'm learning new animations. Like this one, I really loved how it turned out. You can create all sorts of fun stuff. So,

[19:11] yeah, that's kind of how that all works. Now, there's also uh you know, I was just saying that I'm going to be creating a bunch more courses and classes all on this. One, I do have a GitHub repo called Model Workspace Protocol. This describes my reasoning

[19:25] behind this method and not only how it makes animations, but how it's actually able to create entire uh you know, the very thing that you're looking at right now, this PowerPoint, this same process allowed me to create PowerPoints from my

[19:39] thinking, my work. The point that you're watching was made by Claude code in let's see, one, two, three, four prompts. Four prompts made this whole beautiful thing from my method and it's all from my writing, my tones, the colors that I actually want,

[19:57] and the edits that I want. And I am writing a research paper on this that I will be sharing as well because there's a lot of effects and deepness behind this that goes back into the 70s about software, and I'm very happy to share

[20:09] that with all of you for free. That one's going to be free. Um and I'm creating a workspace protocol course on all of this. So, I'd love your feedback on that as well. So, again, for you, I think it would be a great way to start out with this is

[20:22] come up with a script and a topic, map out what you want that topic to be, what you want it to look like, and just ask Claude, "Hey, can you go ahead and write me out a markdown file?" Right? Literally come in and say, "Hey,

[20:38] Claude, and you're working inside a folder that you've actually installed Remotion in, can you write me a script or give Claude a script and then a spec?" And just describe what it is, or if you've gotten the specs for me, do that, but just like

[20:57] "video animation beat by beat." You can literally just start with that "for that script." Right? And make sure you're inside of a folder that helps you with that. And then literally just say, "Let's go." That's what you want to practice first.

[21:14] Oops, I forgot to mount my my file, but that's This isn't a problem you're going to encounter necessarily. This is my fault. I I messed it up. Uh I'll show you on here instead. Um and it's just just do that, right? Just send it in. Um

[21:27] and it should be able to help you out pretty well with that aspect. If you don't, again, I'm going to be doing a much more deep in-line course on all of this, and you can always reach out and we're going to be doing kind of virtual

[21:39] things, but that's something that I think you would should dive into. Some of our community members have already been doing this from what I've shown you all here. So, if we actually come in, we can see some amazing ones that David has

[21:50] already made from this kind of process. Um he did a really great one on N8N, um and I gave him some suggestions as well. So, please share them in here and any trouble you have, please dive into it. Uh this will probably be posted after

[22:04] this afternoon tea talk, but every 2 weeks we do a little afternoon tea where I invite some CEOs in. So, I please recommend all of you to dive into that. But other than that, that is the end of all of this. I very much appreciate you

[22:18] all being a part of this. I hope this is great. This is part of my free series. I'm going to be doing much more long-term courses to help you all out with this in the future. Um and I can't wait to talk and build with all of you.

[22:30] Thank you so much.
