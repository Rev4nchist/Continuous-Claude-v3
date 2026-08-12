---
video_id: zXZkuFxpwL0
title: "GPT 5.6 Sol + Grok 4.5 + Fable 5 = Unstoppable"
channel: "Kacper Rutkiewicz | AI Made Simple"
channel_id: UC2eDm1RP5DAs0nadj4sr-0w
channel_slug: kacper-rutkiewicz-ai-made-simple
url: "https://www.youtube.com/watch?v=zXZkuFxpwL0"
upload_date: 2026-07-10
duration_s: 1622
duration: 27:02
view_count: 2260
like_count: 57
subtitle_lang: en-orig
transcript_source: auto
transcript_words: 6942
ingested_at: 2026-08-06T03:15:00.317Z
ingest_version: 1
---

# GPT 5.6 Sol + Grok 4.5 + Fable 5 = Unstoppable
**Channel:** Kacper Rutkiewicz | AI Made Simple · **Uploaded:** 2026-07-10 · **Duration:** 27:02 · **Views:** 2,260  
**Watch:** https://www.youtube.com/watch?v=zXZkuFxpwL0

## Description

Join AI Made Simple (free): https://www.skool.com/ai-automation-network-2970/about
Work with DeepRooted AI: https://deeprooted.io

OpenAI just dropped GPT-5.6 Sol, and everyone is asking the same thing: is it better than Fable 5? I think that is the wrong question. In this video I show you the skill I built that makes three frontier models, GPT-5.6 Sol, Grok 4.5, and Claude Fable 5, build a real app together, each doing the one job it is actually best at.

Claude plans it, Grok builds it, Sol reviews it and fixes the bugs. I ran the whole pipeline live and built Bark Bark AI, an app that tracks my dog's health, from an empty folder to a working app in about an hour, for roughly a dollar in Grok costs. You will see the two phases, the two human gates, and the two rules that stop any model from grading its own work. First I catch you up on what Sol, Terra, and Luna are and what they actually cost, then we build.

🛠 My Tools:

Glaido🎙 :
https://get.glaido.com/kacper-rutkiewicz

🔗 Resources

Get Grok Build (CLI install):
https://x.ai/cli

Get Codex CLI (runs GPT-5.6 Sol):
https://developers.openai.com/codex/cli

Claude Code:
https://claude.com/claude-code

grill-with-docs (Matt Pocock):
https://github.com/mattpocock/skills

## Chapters

- [0:00](https://youtu.be/zXZkuFxpwL0?t=0) Intro
- [0:35](https://youtu.be/zXZkuFxpwL0?t=35) Meet GPT-5.6 Sol, Terra, and Luna
- [1:05](https://youtu.be/zXZkuFxpwL0?t=65) Pricing and Benchmarks
- [3:00](https://youtu.be/zXZkuFxpwL0?t=180) Stop Forcing One Model to Do Everything
- [3:50](https://youtu.be/zXZkuFxpwL0?t=230) The Roster: Hub, Builder, Fixer
- [4:50](https://youtu.be/zXZkuFxpwL0?t=290) Two Phases and Two Gates
- [6:30](https://youtu.be/zXZkuFxpwL0?t=390) Making It Trustworthy
- [7:15](https://youtu.be/zXZkuFxpwL0?t=435) Why A Roster Of Models Is Better
- [8:45](https://youtu.be/zXZkuFxpwL0?t=525) gameplan Wireframe
- [9:20](https://youtu.be/zXZkuFxpwL0?t=560) Live Demo: Full App From Scratch
- [20:00](https://youtu.be/zXZkuFxpwL0?t=1200) Final App Reveal
- [21:30](https://youtu.be/zXZkuFxpwL0?t=1290) The Cost + Time Breakdown
- [23:05](https://youtu.be/zXZkuFxpwL0?t=1385) Final Thoughts: Build Your Roster
- [24:15](https://youtu.be/zXZkuFxpwL0?t=1455) Outro
- [25:00](https://youtu.be/zXZkuFxpwL0?t=1500) Blessing

## Transcript

[0:00] Introducing GPT 5.6, OpenAI's newest model. The first thing that everyone will be asking is GPT 5.6 Saul better than Fable 5? And I don't think that's the right question to be asking. The smart move here isn't picking Saul or

[0:13] Fable. It's combining the powers of both of them. And this skill that I created makes three different AI models work together to allow you to build essentially anything that you want. My goal for this video is simple. I'm going

[0:23] to get you caught up on everything you need to know about GPT 5.6, six, walk you through the exact framework to make the most out of these new Frontier models, and we're even going to build an app together. So, get comfortable, grab

[0:33] some coffee, and let's hop straight into the video. Okay, GPT 5.6. What are we actually looking at here? We have three different models, all with new names, completely new generation of GPT models. We have Saul, which is their flagship

[0:44] model, purely built for agentic coding and long agentic tasks. It's their strongest model. It has an ultra mode that can spin up sub agents that talk to each other. We have their balanced Terra version, which is your everyday tier

[0:55] type of model. OpenAI says it roughly matches the last model at half the cost, so 5.5 Pro. And then we have Luna, which is the fast and cheap version if you're on a budget. Still gets a lot of things done. Probably could be used for most of

[1:05] the work that we do. This new generation of models took a massive leap in cost and speed as well. So we can see here that Saul costs about $5 per million input tokens and $30 per million output tokens. Very similar to Opus 4.8, about

[1:17] $5 more expensive on the output. We have Terra, which is $2.50 50 per million input tokens and $15 per million output tokens. And then Luna, which is actually pretty cool, is $1 per million input tokens and only $6 per million output

[1:29] tokens. This new soul model is claimed to be on par or better than Fable 5 and Fable 5 is about $10 per million input tokens and $50 per million output tokens. So significantly cheaper and claimed to be way more powerful. Taking

[1:40] a look at some of the benchmarks, Soul Ultra, which is the best version of this model, scored a 91.9% on Terminal Bench 2.1. The base version of Soul, scored an 88.8% 8% on the terminal bench 2.1. Open AAI claims that this model is 54% more

[1:54] token efficient than the Anthropic models. It ran at a crazy speed of 750 tokens per second on Cerebrus, but always take benchmarks as a grain of salt. These are Enthropic's own reported numbers against all these other models.

[2:04] So, I'm excited to see what kind of reports come out when they do actual head-to-head tests. I also wanted to scroll through their introduction post a little bit and go through some of these benchmarks here because you can see on

[2:13] pretty much every single one of them, TPT 5.6 six soul is just better than all the Fable models, all the Opus models, which is very interesting to see on literally every single benchmark that they've posted. Here's Terminal Bench

[2:25] 2.1. Here's the Deep S. SWE. This is the Browse Comp one, SEC Bench Pro, Terminal Bench 2.1 multi- aent. It apparently got a massive upgrade in the front-end capabilities, which is very interesting because GPT 5.5 was absolutely garbage

[2:37] at frontends. And just scrolling down through the rest of this introduction post and looking at all the benchmarks, GPT 5.6 Sol is on top of all of them. and even the other GBD 5.6 models are doing very very well. Those are all the

[2:48] graphs. Down here is all the official benchmarks and everything like that. I'm going to link this down below in the description for you guys to take a look at it. It's a pretty long introduction post. I don't want to bore you with

[2:55] that, but I do want you guys to know where I got all the information from. That should pretty much catch you up to speed of everything you need to know about GPT 5.6. This isn't necessarily a model review video. The whole idea of

[3:04] this video is to stop forcing one model to do everything. Yes, GBT 5.6 six soul ultra and all the other models are excellent models, but when you combine them with the intelligence that we already have like Fable 5 and even Grock

[3:16] 4.5, then you guys are just going to unlock new levels of capabilities that you didn't know you had before. So the old way of doing thing is having one model plan, build and check itself. One person is the architect, builder, and

[3:26] inspector. And then the new way now is each model does one job that it's best at. And they check each other, verify everything, and then you go to actually shipping a product. Whether that's an app, whether that's an automation,

[3:37] whether that's a website, anything that you can think of actually building. This is the new way that I want you guys to start doing that. Hopefully, you guys have been using Fable 5 and playing around with different models to

[3:46] understand the fact that you don't need the best model all the time. You need the right model for each job and then you need other models verifying its work and improving its work. And I actually created a skill that does exactly that

[3:56] for you guys. And I'm extremely excited to share with you guys. So, how we're going to do this is we're going to have three different models for three different jobs all inside of one skill. We have Claude Fable 5 which is going to

[4:05] be our hub. We're going to be inside of Claude Code pretty much orchestrating everything. We're going to plan our app, hand out the work, review the results. We're going to use Gro 4.5 because it is a cheap model. It's almost on par with

[4:16] Opus 4.8. It's more Opus 4.7 level, but if you steer it in the right direction and give it a great plan, it'll execute it very quickly and for a very low cost. So, we're going to be using Gro 4.5 as our builder. We're going to have it do

[4:27] live research because it has access to X and all the most recent information that we need. Then it's going to build it milestone by milestone, and we're going to have the new GPT 5.6 Soul Ultra model as our fixer. It's going to review our

[4:40] builds, catch all the bugs, fix those bugs, and then it's all going to consolidate into one part before we ship anything. And as I've mentioned, this entire thing is wrapped into one skill I now call game plan. Game plan

[4:51] essentially works in two phases. So here's the architecture. We have phase one where we lock the plan, where we get grilled on what we're actually building. So, in today's example, we're going to be building an app that I call Bark Bark

[5:00] AI that essentially allows me to track my dog's health and well-being. So, what we're going to do in phase one is lock the plan. We're going to use Matt PCO's grilled me with Doc's skill on what we're actually building. We're going to

[5:10] have Fable 5 actually draft the architecture and create what I call a contract, which will carry on through the entire skill. We're going to have Grock research all the unknowns. We're going to have it research design. We're

[5:19] going to have it research APIs, databases, everything like that. And then we're going to have Grock and Saul actually stress test his entire plan. There's two human in the loop gates. And after we finish these four steps, gate

[5:29] one is I'm going to sign off on that. And then we're going to get to actually building. Phase two is the build, grade, and ship phase. We're going to have Grock actually build it milestone by milestone. Every milestone is going to

[5:39] be checked, verified, and made sure that we can actually move on to the next one, and then it's all good. You guys have probably heard of a similar system to this, like GSD and the actual Ralph Wiggum loops. Then we're actually going

[5:48] to have our hub smoke phase where we check between each piece. Then once the initial build is complete, we're actually going to send it to the review booth where Claude and Saul actually grade the build, compile their findings

[5:58] together, and come up with a synopsis, and then we're going to have Saul fix those confirmed bugs before we actually ship the app. And yes, by the end, you're going to see a fully working app shipped from zero to all the way to

[6:07] completion and shipped on Versel. The way that we're able to do all of this is by having an actual handoff process where every single handoff is a file on a disk and it's not inside of a chat memory. So that contract that we have is

[6:18] always going to get constantly updated phase after phase so we know what to hand over to the next model. I've talked about it before, but that's the difference between a stateless session and a stateful session. And whenever

[6:27] you're doing any type of agentic coding and agentic building, the reason I like to switch up models is because I don't like the idea of a model that built something grading its own work because of course there's going to be some sort

[6:36] of bias toward its own code because it worked hard on that code and it thinks it's perfect. So two rules that I implemented that make this entire thing work is the model that builds is never the model that reviews it. So Grock is

[6:46] going to do most of the building based on Fable 5's architecture, but it's never going to actually grade its own work. We're going to have Claude, Fable 5, and Saul actually review it and make any changes. And since GBT 5.6, Saul

[6:57] Ultra will be making fixes, we're not going to have that model grade its own fixes. So when they make the fixes, and we're going to have Fable 5 and Gro 4.5 check those results. So we have a constant sort of verification loop,

[7:07] making sure that all the code is solid, and we can actually ship this app. And like I said before, there's only two human gates in this. So, there's only two times where I'm ever going to actually hop in and make a decision.

[7:16] Everything else runs on its own. Why I think this is such an important skill and not just the one that I created, just an overall skill of understanding when to use each model is because the models have just at this point

[7:25] converged. Every single frontier model is just getting better and better. And at this point, the model is no longer really the moat. It's how you use each model specifically and the actual harness around that model. Like I said,

[7:35] the gap between these frontier models has gotten so much smaller even with some of these open source models like GLM 5.2. Although the gap is still pretty large there, the Edge moved from owning the best model to running a

[7:45] roster of models very well. Every single model, whether it's GPT 5.6, Fable 5, Grock 4.5, whatever these new Frontier models, they all have blind spots, and they're all biased towards their own build. So, they're going to miss certain

[7:56] things that other models just won't miss. And before anyone hops into the comments screaming at me for using Grock 4.5 as the builder, this skill is fully in testing phase. I'm in a leg just kind of figuring out which model is the best

[8:07] for building. I'm very confident in Fable 5's architecture. I'm even very confident in Opus 4.8's architecture and then Solve 5.6 Ultra from what I've used so far is really solid at code, finding bugs in code at fixing those bugs and

[8:20] actually really good at implementation. That's why I put it at the reviewer stage. Rock 4.5 since it came out the other day has actually proved to me to be a very reliable builder and it's very cheap. So that's kind of why I put it in

[8:29] this position because I thought if I can guide it the right way that it's just going to get the job done for me. I'm really interested to see how you guys would orient this skill or what model you guys would substitute. I've heard

[8:38] some people put GLM 5.2 right here, some other open source models, which I think is very interesting. So, let me know in the comments. Because I'm a very visual person, I wanted to show you guys also a wireframe of this entire skill and how

[8:49] it works. So, you guys can see that phase one is lock the plan. We're going to skeleton the plan, have Claude draft it, do live research with Grock on X plus the web, architect the actual contract that carries on through

[8:58] everything. Step five is where we actually challenge the plan with Grock and Saul. Then we sign off at gate one and then we send it to phase two which we build, grade and ship ultimately to where we get to the point where we ship

[9:08] this app. One part of this process that I really like is that patches get rechecked by Claude and Grock and there's a max of two rounds of iterations. You guys can bump this up to however many iterations you want. I just

[9:17] stuck with two for timing purposes to see where we can get on a version one of a one-shot prompt on this. Now for my favorite part of this video, we're going to run this skill in its entirety from beginning to shipped app on Verscell.

[9:28] I'm going to be making a ton of cuts here. I want to show you guys the highlights of this app. There's a lot of kind of just building and things happening behind the scenes. Anytime I need to pop in, I will pop in. How we're

[9:38] going to start this off first is we're going to run /game plan and we're going to run it on Barkbark AI, which is a web app that helps me track my dog's health. So, let's go ahead and kick this off. The first thing that this skill does is

[9:48] actually checks the entire pipeline. So, we're running pre-flight first, seeing if we can spawn headless Grock sessions and headless codec sessions, which is where we're going to be running these other models. You will need to install

[9:58] the Grock build CLI as well as the codec cli. I realized quickly that I was on Opus 4.8 when I kicked this off. You do need to be using Fable 5 when you kick off this skill. Eventually when Fable 5 goes to API, I'm going to be delegating

[10:10] this part of the skill to Opus 4.8, but I did not want to make that mistake in this video. So now we're on Fable 5 with high effort only. And we're going to start this off again. Same thing here. We're running pre-flight. We're doing a

[10:20] GitHub off a soul probe Grock authentication and then we're writing the actual probe making sure that all these CLIs are available. The first thing that it's going to do is begin with the round of questioning. We're going to use Grill Me with Docs and

[10:31] we're going to actually start answering a ton of questions. I'm not going to sit here and keep you guys through all of these questions, but I did want you to see the initial part of it where it begins to ask me them and then I will

[10:40] get back to you guys when we're on to the next phase of this. Okay, so after answering about 15 total questions, which is I know is a lot, but trust me, it's worth it at the end to spend a lot of time planning with this grill me with

[10:50] doc skill. I like it way over plan mode because I believe plan mode kind of gets stuck in the session and after you leave another session you're kind of screwed unless you write the plan down obviously. But that's what Grill Me with

[11:01] Docs does natively and also the questions that it asks you are way more thorough. So shout out Matt PCO for that one. But what Fable 5 did after we answered all the questions properly. We covered design APIs connections all

[11:12] things like that. It created a game plan folder on my desktop not inside of this project and also created a GitHub repo for that. As you can see here, the repo is live at github.com, deep rooted AI, BarkPark AI. So, we created our entire

[11:24] own GitHub repo so that we could always push code to it when we're doing PRs or anything like that. Now, what it's doing is hopping into stage two, which is dispatching all six research questions to Grock, where Grock's going to use X

[11:34] along with web search, get information from vetted and trusted sources that we can apply over to our app. And so, my apologies if this white markdown file hurts your eyes, but you guys can see here all the decisions that we made.

[11:44] This is the actual game plan markdown file that it created, the skeleton of the plan. So the shape, it's going to be a single next.js app. We're going to have a ton of different data models and these are all the six research questions

[11:54] that we're going to be using Grock for. And of course, at the end, I'll show you the entire kind of VS code setup and how it scaffolded the entire project once the app is actually complete. Okay, so this is one of the gates that comes up

[12:03] after we do research on design. We actually need to check the visual layer and see if the UI is something that we like. Right now, I'm kind of struggling with the fact that it's not on the full page, which I don't like at all, and I

[12:14] can't really click through yet, obviously, because the app is not complete. But, I like this kind of front end UI. I like the colors. I like how I added the little paw up here, the actual dog on the top right with my dog's name.

[12:23] Uh, I'm going to actually make one change to it. I'm going to make it full screen, but other than that, I'm not going to worry about the design for this video. That's something you guys can tune in your own skill when you download

[12:31] it cuz I'm going to be giving it to you guys for free. Uh, but I'm going to make one small change and then we're going to get on with the rest of it. After checking out the UI, this is the first gate of question. So, it's going to say

[12:39] approve the game plan plus the mockup and pick the build path. So, I'm just going to go ahead and say Grock builds milestone dispatch. The failover authorization if Grock dies mid build, which is a silent off expiration. You

[12:50] never know with these headless sessions sometimes, we'll have Saul actually take over the build so we don't get stuck. So, we're going to yes, authorize the failover. And then for the mockup, this is where we're going to actually make a

[12:59] change. And so, all I'm going to do is I took a screenshot of the actual UI on my desktop. I'm going to have Fable 5 go ahead and look at that. And then I said the UI seems to be talked on the top left corner with a lot of empty space. I

[13:08] want minimal white space and this needs to feel more polished. So I'm just going to go ahead and send that off. Fable 5 is so good that it kind of already knows what I mean. So let's go ahead and send that off and then submit these answers

[13:17] and I'll get back to you guys with what the new UI looks like. And then we're going to just go on with the build. And so after the rendition, I'm much happier with this UI. It takes over the entire screen. We can see the weight, do items,

[13:27] anomaly flags, weekly digest, and then we can actually log things as well. So, this feels way better to me on a second rendition than the other one did. So, I'm very happy with this. And so, now this is where we actually stand.

[13:38] Milestone one is building. We have five different milestones to cover throughout the entire build. And that's all happening inside of Grock and then being tested by Saul. So, that gives me a ton of confidence. But, as far as where this

[13:48] run stands, we did pre-flight, grill, research, architecture. We planned the challenge. Now, we're in gate one and we approved the mockup. Now, the M1 is getting scaffolded. So, next 16, drizzle, sq, light, skeleton with a full

[13:59] schema, seed data, all the data stuff in the backend stuff is going and then we're going to do the core tracking documents, AI layer, and then the polish. And then after that, we get to the booth review. Then we ship. So, a

[14:09] lot of stuff is going on here. It's all happening from cloud code as the orchestrator and Fable 5. And then now we're just doing builds inside of Grock headless versions of Grock build. And then we're going to do the same thing

[14:20] with codeex and GPT 5.6 salt. I've mentioned this a few times now. There are only two human gates. We've already passed the first one. So, the second one after that is just approving everything and then getting it shipped. I'm going

[14:29] to check in with you guys after every single milestone. This might get repetitive, but I want you guys to see the full process of everything that's going on. M1 just shipped and it was verified. So, the smoke check pass on

[14:38] all counts. All nine tablets exist with correct constraints. The seed data is in all the six weights, four regimens, all the actual data is in and we're running this on a local host. Now, we're moving on to milestone 2, which is the core

[14:49] tracking and making sure that all the health, well-being, and costs, charts, all that stuff is synchronized properly. and then we'll move on to M3. It gives you little checkups as well saying the roster is still fully healthy. There's

[14:59] been no Rios and no failover. So, that's always a good feeling. So, we just finished milestone 2. Everything was verified and closed. Now, we're building milestone 3, which is all the documents. All four pages in milestone 2 returned a

[15:09] 200 success message. And here, we were just running a bunch of different tests to see if the actual functionality of the website was working. We ended up dealing with an issue about a zombie server that we kind of just had to

[15:18] figure out on the go. That was probably my fault because I had something locally hosted on the wrong one. Now, we're going through M3, which is the upload pipeline. and actually being able to upload documents into our app. And then

[15:27] once we're done with that, I'll get back to you guys. Keep in mind that every single milestone that we verify gets pushed to GitHub. So, we can go back to the history and see what's actually getting pushed. So, we can always

[15:35] reflect back or go back to a certain spot if we needed to. Milestone 3 just finished up and there was a bug that we found regarding some of the testing. So, it said I verified via node instead and we'll propose a pattern fix at stage 8,

[15:46] which is bookkeeping. So, that's good to know that it marked down this bug and that's going to fix it in the review stage, which is great. Now, we're working on milestone 4. We have milestone 5 shortly after that. Then we

[15:56] do our booth review and all of our fixes. And then hopefully we can launch this app shortly. Milestone 4 completely finished up. Everything was verified working. There was a funny deviation that occurred because I actually put in

[16:06] an open AI API key while this thing was running and it assumed that Grock fabricated a realistic looking open API key, but I quickly prompted it saying that I added it. So then it immediately kind of changed that entire narrative

[16:18] and pushed that to GitHub. And now we're all good. You guys can see here that the key was restored, the record was corrected, and the lesson was actually logged. The last milestone that we're heading to right now is the polish

[16:27] milestone where we're going to do a mockup fidelity pass. After Fable's smoke check comes back, we send it off to the booth review for Fable and Soul Ultra to do a verification pass, check for any bugs, and then we're going to

[16:38] probably fix a few bugs with Soul Ultra. So, we're cooking along here. I think in total time, we're about 45 minutes right now. Milestone 5 finished up. All five milestones are hubverified which means Fable 5 itself verified all of these

[16:50] before passing them on to the booth review. So now you can see that chair 1 is the hub sub aent and chair 2 is GPT 5.6 ultra and you guys can see it's doing a deep review with the database lens. So it's looking at schema

[17:02] migrations transactions upsert semantics and injection surfaces and it's going to write all of that into a markdown file. Right here we can see we've encountered some sort of hiccup. We need to actually authenticate once again. So I'm going to

[17:13] go ahead and do that really quick. I just logged in. So all I need to do is prompt it back, say I logged in and now I'm good. I love that the skill does this though. It confirms it is dead and actually tells me that I need to do this

[17:21] in order for it to run. It doesn't just go to the next model. It always tries to actually use GBT 5.6 Saul first because that's the entire point. Then just to confirm, we can see Saul's back retrying the chair 2 review. Chair 2 redispatched

[17:33] at ultraeffort. So now we're all good. We have two reviewers going and then I'll get back to you guys when they're both complete. Okay, so we're done with the review from chair one which was Fable 5. And I ran a couple of status

[17:43] checks to see where soul was at because it was taking a long time. And it's very interesting because it at the first one it said it was mid-review. And keep in mind soul ultra spawns sub agents to actually do the work alongside with it

[17:54] and communicates with it. So I ran that and uh you can see here that it says soul is still in deep review. The file grew to a pretty large file size. And you can see right here that ultra effort spawns internal sub aents. So the weight

[18:06] markers are normal because it's responding back to claude saying wait. Right now, I believe Saul just finished up and it's pulling back that markdown file. But I want you guys to be aware that this review just from Soul Ultra

[18:15] took about 15 minutes to complete. It did go through the entire app and all of its code to find the bugs, which is great, but it did take a long time. Okay, so I've been waiting for about 20 minutes, so I decided to run another

[18:25] status check. And Saul is only gone through three of 11 fix groups in total. So, we've been waiting a long time. I think I made a mistake by using the ultra model because of the delegation to sub agents. I think that's causing

[18:36] everything to take a little bit longer. So, if I were to change up the skill, which I'm going to after recording this video, I'm probably going to delegate this to just GPT 5.6 Soul on some high thinking or something like that.

[18:49] Definitely not ultra mode. For a task like code review and debugging, I feel like GPT 5.6 Saul, just the regular version, will do a great job as well. I'm definitely glad that I'm going through this for you guys so you guys

[18:59] don't have to. Trust me, the skill that I provide you guys in the school community will have GPT 5.6 six saw as the default and not the ultra mode. All right, so after about 25 more minutes, we finished the entire booth review and

[19:09] debugging. So we have all 11 groups landed in 11 clean commits. We have 75 out of 75 tests passed. The build is completely clean. There was one odd thing with the next due date. I don't understand what was going on there. Fix

[19:21] round one verified on Fable side. We got all the commits ready to go. Round two was dispatched over to Grock and we were able to verify that we couldn't actually run Luna for some reason. The sole model claimed that Luna is unlimited preview,

[19:33] which is pretty interesting because the API is available. So, I'm not really too sure why we weren't able to hit that endpoint, but nonetheless, we connected with a different model. We can see here that the run is closed. Bark Bark AI is

[19:43] shipped. We have our bookkeeping in line. Our repo is private on GitHub. We have the app fully locally hosted and it's live on GPT 5.5. So, we can see that's the model that it went to. Right now, I'm going to open the app so we can

[19:54] go ahead and go through it, click around and do that. And then, because I promise, I'm going to host it live on Versell so you guys can see how that works. And there we go. I like the UI. I like how it's turning out. We can do a

[20:03] quick log today and see that Botchi's health is great. We did a 30 minute walk. Let's say he's weighing about 51 lbs. We'll log that in and we can see that it got logged immediately. We can also go ahead and add a regimen. So, we

[20:15] can update the weight. Uh what's another regimen that we can add? There's some health events in here that we can add. A lot of these are kind of just already thrown in there if I wanted to. I can clear the slate. I can also go ahead and

[20:24] upload documents, which is really cool. I'm not going to go ahead and do that, but the app seems to be working very, very well. We also have some blank documents in here, I believe. So, we can go ahead and click on preview. Those

[20:33] will open up actually and send us somewhere where the document is. That last one seemed to be a black screen. So, let's go ahead and click this one. And it does show a paper. Obviously, there's nothing updated in there, but it

[20:42] does bring us to that. So, we know that function works. We have our cost section. You know, we can log the food that we buy, the things that we buy for my dog, the actual vet visits. We can log all of that in here. And then, most

[20:51] importantly, I want to see if this chat window works. And I'm just going to ask GBT 5.5 which is powering this. Tell me about Botchi. Let's go ahead send this off. Let's see what it comes back with. We can see that it's thinking. We have a nice chat

[21:05] window in here. I'm loving this. I love the little thing at the bottom that says not a vet. And here we go. Here's what I have. Logbachi recent weights. Obviously, I don't like the format. I would touch that up, but the app seems

[21:13] to be working very well. And okay, this is a good lesson. So, I'm not actually going to launch it on Versell because we decided to go with an SQ Lite database since we were going to host this fully locally. But if I were to run this on

[21:24] Versell, it would be as easy as just saying push it over to Verscell. I don't want to get detourred here and kind of go down a rabbit hole. So, I'm just going to leave it at that. However, what I'm going to pivot to now is the actual

[21:32] cost of everything that we just did. So, inside of the Fable 5 session, we did this all in one session. We used 337,000 tokens and 66% of our context window is left. I don't like the fact that we got all the way to 337,000 because I believe

[21:46] at around 250,000 tokens, the model starts to get dumber. So, I need to find a way to tune this skill. carry on after checkpoints. A lot like the Ralph Wiggum loops where if we finish a milestone, we start a new session and then execute on

[21:57] that milestone. Now, regarding the usage limits of Grock, I was at $18.50 when I started this. So, that entire thing cost me $1. Today's July 9th, and for some reason, it's just not showing up in my usage breakdown, but I'm pretty

[22:09] confident I used just about a dollar to create that entire app, which is mind-blowing. For the Fable usage, I only used about 4% of my Fable usage, which is great. These are my GPT usage limits. You guys can see that I used 5%

[22:19] of my entire weekly usage with that. We did do a lot of work using GPT 5.6 Soul and then I used about 30% of my current five hour context window. That's on top of burning through the entire $20 subscription. Just so I'm transparent on

[22:31] time and everything like that. This entire session with Fable 5 orchestrating all these models took about an hour and 6 minutes in total to start from zero to a full-fledged app. Also, because I promised you guys this is the entire scaffolding of the project

[22:43] that's on my desktop. You guys can see all these scripts, all the next.js JS stuff up here, the database and everything like that and everything that we did to build this entire app. And I never went through any of it. This all

[22:54] happened inside of Cloud Code. If I wanted to go back and verify everything, I could. But you guys can see that we built this entire app on my desktop and had it served locally. The most beautiful thing is that this was all

[23:03] combined with Fable 5, Gro 4.5, and GPT 5.6 salt. So, let's tie everything together nicely and wrap up this video. If you use one model for everything, not only is that expensive, but it's also pretty lazy. Being able to maintain a

[23:16] roster of models in this era of AI will really set you apart from the 99%. Start exploring with models. Find what models fit best for your workstack and then rely on them. Start creating a roster of models. After using GPT 5.6 and all the

[23:30] models all day, I really don't think that this is as close to Fable 5 as people think it is. Like I said before on this channel, Fable 5 really felt like a step ahead in Intelligence. And I think GPT 5.6 is just slightly behind

[23:42] that. I'll still be using the models like Luna and Terra. I actually like those a lot. I tested them with all my skills inside of my operating system and they worked flawlessly. So, I get to kind of leverage that GPT subscription

[23:53] and those API costs a little bit better than the Opus ones. In my opinion, Fable 5 is still the top model on the planet. That's why I never really believe in benchmarks because although GPT 5.6 seemed to be topping every single thing

[24:05] on the benchmarks, it just didn't feel that way. I'm still going to be using it a ton. The model is brand new, so hopefully a lot of more experiments and stuff to come on this channel. But yeah, that's going to do it for today. I know

[24:14] I threw a ton at you guys today and if you got lost at any point in this video, don't worry at all. I got you guys. I'm going to drop the full free resource guide and the skill that went along with today's video inside of my school

[24:24] community, AI Automation Nexus. All you guys need to do is click the link down below, enter in your email, join the community. You'll get access to all the resources that I've ever created, including the one from today's video.

[24:33] So, I hope to see some of you guys in there soon. As always, if you've got any value from this video, drop a like, hit that subscribe button. It definitely helps me out a ton. Leave a comment down below on how pumped you are to be trying

[24:43] out this new GBT 5.6 series of models. I know I'm going to be playing around with it a ton. I drop videos every Tuesday and Friday, but I'm going to be dropping a video every single day until July 11th. Having so much fun making content

[24:54] for you guys. Thank you so much for the support. And if you've made it this far in the video, thank you so much and I'll see you guys in next one. God bless, guys. Hey there. If you're still here, that means you've made it to the end of

[25:04] the video. So, first of all, thank you so much. If you're new here, something I like to do at the end of all my videos is pray for you guys, my audience. I do this because I genuinely care about you guys. I love you guys and appreciate the

[25:14] fact that you take time out of your days to watch my videos and I really want to see you guys live fulfilled lives. I want to see you guys chase your dreams and be lights of this world. And I believe that the only way that I can

[25:24] help you guys do that is by praying over you guys. Now, I know this is a very weird thing to do. I'm very well aware of that. The first time I got prayed over was uh very interesting. Um so, if you're uncomfortable at any point,

[25:33] please feel free to click off the video. I'm not here to force anything upon you, but if you do leave, just know that Jesus loves you. I'm going to go ahead and pray for you guys. Heavenly Father, thank you so much for this day. Thank you so much for all the

[25:45] opportunities that you've blessed us with. Thank you so much for our health and our happiness. Lord, thank you for waking us up this morning and just breathing into us the breath of breath of life just so we could live another

[25:56] day and honor and glorify you. Lord, I just want to play a blessing over my audience, a blessing of just peace and wisdom and strength. Lord, give us the peace to know that anything that's going on in our lives today, you can handle

[26:07] and you will guide us in the right path and everything will happen in your perfect timing. Lord, just give us wisdom to steward these AI tools properly and everything that we have at the grasp of our hands. Let us use it

[26:19] for good. And Lord, just give us the strength to stand firm in our faith. Continue spreading the good word of our Lord and Savior Jesus Christ. And Lord, just continue to give my audience a serving heart, a serving attitude.

[26:31] continue to help them serve their families, serve their children, serve their business, serve their clients, and anyone who comes across their path. Lord, let us just continue to spread your word and honor and glorify you in

[26:41] everything that we do. Lord, we thank you for your sovereignty. We thank you for your grace, and we thank you for your love. And ultimately, we thank you for your son's sacrifice on the cross. And because of that, we now can have a

[26:51] relationship with you and one day meet you in heaven. And I pray all this in the name of Jesus Christ. Amen. Now, go have a blessed day, guys. and I'll see you in the next one.
