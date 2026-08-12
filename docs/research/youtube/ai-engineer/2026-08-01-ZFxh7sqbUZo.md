---
video_id: ZFxh7sqbUZo
title: "Teaching AI to Find Real Vulnerabilities — Prof. David Brumley, Bugcrowd"
channel: "AI Engineer"
channel_id: UCLKPca3kwwd-B59HNr-_lvA
channel_slug: ai-engineer
url: "https://www.youtube.com/watch?v=ZFxh7sqbUZo"
upload_date: 2026-08-01
duration_s: 1637
duration: 27:17
view_count: 2070
like_count: 58
subtitle_lang: en-orig
transcript_source: auto
transcript_words: 5001
ingested_at: 2026-08-06T11:00:33.687Z
ingest_version: 1
---

# Teaching AI to Find Real Vulnerabilities — Prof. David Brumley, Bugcrowd
**Channel:** AI Engineer · **Uploaded:** 2026-08-01 · **Duration:** 27:17 · **Views:** 2,070  
**Watch:** https://www.youtube.com/watch?v=ZFxh7sqbUZo

## Description

David Brumley has spent two decades turning people into hackers, from founding picoCTF to recruiting pwn2own winners at Carnegie Mellon, and his argument is that you teach a model to hack the same way: a ladder of tasks that climbs from triggering a crash to reading and writing arbitrary memory to a full working exploit. The catch is measurement. Hacking has no single answer, so the usual benchmark setup breaks down when a target has multiple vulnerabilities and a language model can always claim it found one, and grading oracles that just ask the model whether it succeeded are hopeless.

So Brumley's team builds real reinforcement learning environments instead: reproducible, sandboxed, and scored by deterministic graders that check whether an exploit actually triggers the specific bug, borrowing precision and recall from his DARPA Cyber Challenge work where he designed the scoring. He shows it on V8, the JavaScript engine in Chrome, running against 41 real vulnerabilities where the strongest models reached about 95% and, in the hard cases, produced genuine out of sandbox exploits including a real zero day. The point that lands is a warning against benchmaxxing security: build environments grounded in real bugs and honest graders, because that is what separates a model that looks like it can hack from one that actually can.

Speaker info:
- https://www.linkedin.com/in/thedavidbrumley

Timestamps:
0:00 - Two decades of teaching hacking
1:54 - From CTF scoreboards to CMU
3:34 - A ladder of exploitation tasks
6:44 - Why measuring hacking is hard
7:46 - Flawed grading oracles
10:30 - When a target has many bugs
13:22 - Deterministic graders and AIXCC scoring
14:49 - Precision and recall for vulnerabilities
17:35 - Attacking V8 in Chrome
21:10 - 41 vulnerabilities and a real zero day
25:24 - Don't benchmaxx security

## Chapters

- [0:00](https://youtu.be/ZFxh7sqbUZo?t=0) Two decades of teaching hacking
- [1:54](https://youtu.be/ZFxh7sqbUZo?t=114) From CTF scoreboards to CMU
- [3:34](https://youtu.be/ZFxh7sqbUZo?t=214) A ladder of exploitation tasks
- [6:44](https://youtu.be/ZFxh7sqbUZo?t=404) Why measuring hacking is hard
- [7:46](https://youtu.be/ZFxh7sqbUZo?t=466) Flawed grading oracles
- [10:30](https://youtu.be/ZFxh7sqbUZo?t=630) When a target has many bugs
- [13:22](https://youtu.be/ZFxh7sqbUZo?t=802) Deterministic graders and AIXCC scoring
- [14:49](https://youtu.be/ZFxh7sqbUZo?t=889) Precision and recall for vulnerabilities
- [17:35](https://youtu.be/ZFxh7sqbUZo?t=1055) Attacking V8 in Chrome
- [21:10](https://youtu.be/ZFxh7sqbUZo?t=1270) 41 vulnerabilities and a real zero day
- [25:24](https://youtu.be/ZFxh7sqbUZo?t=1524) Don't benchmaxx security

## Transcript

[0:12] All right, everybody. We're going to talk about hacking. I love hacking. We have a very small audience here, so I assume everyone here loves hacking as well. So, I want to talk about designing reinforcement learning environments for

[0:23] cybersecurity tasks. Essentially, we all want to teach computers to hack because well, we're pushing out programs faster than other ever and so we need to be able to check them at machine speeds in scale. And this has been my research

[0:36] project for well over two decades. My name is David Brumley. I am a full professor at Carnegie Mellon University where I work on AI and cybersecurity. And I'm also chief AI and science officer at Bugcrowd where I work on data

[0:50] partnerships. So, before I talk about what we do and how we do it and why it's important to design cybersecurity tasks correctly for reinforcement learning environment, I want to start off with how humans learn because I mean, I love teaching people

[1:03] to hack. And I remember in particular a case where we run a hacking contest called picoCTF. picoCTF has about a million high school kids every year play in this contest. Um and so it's a a really fun way for people to get an intro to cybersecurity.

[1:19] So, in 2016, a young uh person showed up on our scoreboard who was going by the hacker name fluorescence. And typically, we know who is doing well in the contest. It's kind of the typical suspects like a Palo Alto High School or

[1:34] uh some of the Washington D.C. high schools. We know who's going to win the contest. And so, this kind of independent starts showing up uh scoring on our scoreboard and we had no idea who it was. So, we reach out. It's actually

[1:46] a 17-year-old kid who found out about cybersecurity trying to get into it from math competitions. He got bored with the math competitions and started doing them. And very quickly, he ended up actually scoring second in picoCTF

[1:58] competing against all these high school kids. And we asked actually "How did you learn this?" And what he said really was uh germane to this task. What I did is I looked at the cybersecurity task, and then I started Googling

[2:12] "What is the information I needed?" I would read about it, I'd look at write-ups, and then I'd start emulating that. And this kid actually ended up coming in second. I recruited him to CMU, and he followed this methodology of

[2:24] studying write-ups and practicing cybersecurity on a graduated scale, easy problems first, and then slowly getting more difficult. And he actually turned into what's called a Pwn2Own winner. So, Pwn2Own, if you've never heard of it, is one of the

[2:37] more elite cybersecurity competitions. This kid, just 2 years after he first learned cybersecurity, enters. And uh if you read about it at the time, he was the first one to hack a Tesla. So, he walked out of this contest with

[2:50] $375,000 in cash and a brand new Tesla. The reason I tell this story is actually the way we teach AI uh frontier models to hack is the same way that we've been successful teaching high school students, such as Richard Zhu, to become Pwn2Own winners. My other

[3:08] students include people like George Hotz, who did the first iPhone jailbreak, and current Pwn2Own winners like Sang Heon Lee. And so, what I want to talk about is how we teach reinforcement learning, and do it the same way that we've been teaching

[3:22] hacking for a while. And it really breaks down into two different axes. The first thing when designing these sorts of tasks for people is to look at target difficulty. There's a spectrum of different challenges that you can look at from toy

[3:37] problems through CTF and synthetic problems, all the way up to hardened targets. The second axis for teaching machines to hack is really looking at exploitation difficulty. For example, when we look at a toy program, we may start looking at

[3:53] the sort of skills it needs to acquire to be able to hack that. For example, if you have a toy program and it has a bug, can the LLM figure out where the bug is? Can it then prove that it knows where it is by triggering a crash or some other

[4:07] fault in the program? But of course, hacking is not just crashing a program. We want to take control of that program. That's the beautiful thing about hacking. It's bending computers to our will. It's what makes it unique in the sciences.

[4:21] So you look at things like, "Hey, there's a flaw in that program. Can I use that to do arbitrary read writes in memory? Or even to do a full arbitrary code execution exploit?" And so if you remember nothing else from this talk,

[4:33] it's really the way that we teach LLMs, whether it be frontier models like Anthropic or private models that you're tuning in your house, you follow these two axes where you're trying to come up with a set of tasks that increase in target difficulty along

[4:48] one, and then you're teaching specific cybersecurity skills on the second. In other words, hacking is really a ladder. And this is what actually matches cybersecurity so well to reinforcement learning. We have a ladder of tasks and

[5:04] we typically end up with a good oracle for whether they can achieve that task. And so you can start to measure whether your model is learning the right set of capabilities. So this talk is really divided into three parts.

[5:22] The first one is to talk about vulnerability discovery. And when we talk about vulnerability discovery, what we're talking about is in the variety of different programs that you encounter in real life, how do you design oracles that are

[5:35] correct for determining whether or not a model has successfully been able to detect that vulnerability? And what's interesting is several of the cybersecurity benchmarks out there were amazing first-generation pieces of work,

[5:48] but they have a critical flaw where the model will actually stop learning after it finds the easiest vulnerability. And that can prevent them from getting smarter. The second is I want to talk about how we are designing benchmarks to measure

[6:01] this ability to do weaponization. And this is really where we get into where does security differentiate from bug finding. And we'll talk about how well LLMs do against what I would call hard targets. A hard target one easy way to to look at

[6:16] it is how much would you pay for an exploit that a model could produce. We know Richard Zhu fluorescence was paid $375,000 and got a brand new Tesla for one exploit. Can models achieve that capabilities today? And then I'm going to just summarize

[6:31] ways that if you're interested in this environment, we can connect and do more work together. So, very simple talk. So, let's talk about the first axis of discovery and where you really want to um learn what you're going to be measuring. This is a

[6:45] key part in reinforcement learning where if you set up the wrong task objective, the LLM will learn it, but it'll learn the wrong thing. So, some definitions to begin with. Let's start defining the problem. When we think about reinforcement

[6:59] learning or we talk about gyms, there's some key components in that. There's of course other things, but the key components are you need a vulnerable application. And we like to enclose these inside container environments so

[7:09] that they're reproducible. We make sure that they run and that you don't have variations between for example, if I run a program on this version of Linux versus a different version of Linux, it actually may behave differently.

[7:22] And so, you want to standardize that with a vulnerable program. You need a grading oracle. Now, one of the things I think the previous talk was talking about was LLM as a judge is a reasonable thing. What we found in cybersecurity is

[7:33] that is flawed. The LLMs will always say they were successful hacking. And so, what you want to come up with is a deterministic grading oracle for each of the different levels you're getting at. For example, if you're trying to teach

[7:45] it to just find a bugs, maybe this grading Oracle is was it able to trigger a crash. We'll talk about that more in a second. So, you have this reinforcement learning environment or this gym environment and of course you have your LLM and an

[7:57] orchestrator that's going to talk to it. The way we set up our task is very simply, we expose through MCP a few key functions, a setup function. So, the LLM will call setup, it returns the problem definition. We give it standard tool

[8:10] calls such as read and write inside the container inside a sandbox inside the container, and then a grading Oracle at the very end. And so, you end up with this vulnerable program in here, a grading Oracle, and I'm going to

[8:24] assume that you've already verified that there is at least one flaw in this program. Maybe you yourself have figured out that it can crash. Maybe you have downloaded it from a bug report and you've been able to reproduce that

[8:35] vulnerability. We won't get into that, that's part of our sauce that we do at Bugcrowd. But, once you do that, you have this package environment and then your task prompt is going to be something very simple like, "Dear LLM, can you find and

[8:46] exploit the vulnerability?" Now, you don't want to just ask, "Can you find the vulnerability?" because then you won't be able to distinguish between an LLM hallucination and a real vulnerability. So, you almost always ask

[8:59] it to actually exploit the vulnerability. And that exploit is going to be key to how we do reinforcement learning. So, the LLM does some thinking and it comes up with an exploit. For example, this very, very simple program, if you

[9:12] just give it enough A's, you'll trigger a crash. So, that's the LLM's witness, the proof of vulnerability that it was able to find something. You run that input through your grading Oracle. The Oracle that determines did the

[9:26] program misbehave or not. In this case, the program would simply crash and you farm out your rewards. This is a very elegant way and actually this is the way we teach people to hack. We set up a deterministic auto grader.

[9:42] For example, in CTFs, it's cuz you capture the flag. Within a cybersecurity environment like this, the level one maybe can it crash, all the way up to control flow hijack, where for example, you may ask the LLM, "Can you do

[9:54] something like launch a calculator, some external program you shouldn't be able to run, or do a reverse shell?" So, that's the basic setup. But, there's a problem with this. This is the way if you go look at the existing benchmarks like uh Cybex or uh

[10:09] CyberGym, they set up the task. But, there's actually a problem here. And that's because there's an assumption that the program only has one vulnerability. I don't know about you, but it's very rare to find a program for

[10:21] which you know there's only one vulnerability. So, what happens if you have two vulnerabilities here? This actually breaks a lot of assumptions in current evaluation environments. You ask the same question, "Dear LLM, can you find and exploit the

[10:37] vulnerability?" But, now the LLM has a lot of freedom to reward hack. For example, which vulnerability should it find? If you came in only knowing about the first vulnerability, but there's a second one you didn't know about, what do you do if

[10:52] the LLM thinks it found a second one? Or suppose you know two. What we found is on existing benchmarks with multiple pro- with a real OSS benchmarks, there are multiple vulnerabilities, the LLM will just continue to find the easiest

[11:07] vulnerability, and that really limits its trajectory as far as what it can learn. And then you have a question, if it does find a vulnerability you did not know about, well, how do you score it, right? You certainly don't want to give tasks that

[11:21] have no vulnerabilities because then you don't know if you're wasting your time. But, what if the LLM finds an unknown vulnerability? Here's where you can run into a catch-22. What existing benchmarks do is they tell the LLM which bug.

[11:36] For example, in many of the benchmarks out there like side bench, they will give a backtrace that says for example, I know the vulnerability is in this backtrace which identifies the vulnerable function. But at that point,

[11:51] you're teaching the LLM, but you're pointing at it exactly the problem. So the LLM no longer has to reason about the program and that will stunt its reasoning capability. Essentially, if you're nudging it and saying here's the vulnerability, it's in

[12:03] this function, it doesn't have to do a lot. In fact, it can often fit that entire function in its context window and it doesn't have to reason much. The second problem though is if you don't tell the LLM which one and there's

[12:16] multiple vulnerabilities, it can always just then reward hack the easiest problem. And we see this in every foundational LLM out there and we see it in as far as I can tell most of the benchmarks out there. There will be multiple

[12:30] vulnerabilities, it will be graded, but because the grading is just checking for for example, a crash, it's not exploring the full state space and the LLM will just keep returning the same one. This is also a problem in some of the

[12:42] public competitions. For example, we won something called the Cyber Grand Challenge from DARPA. It was the first challenge from DARPA to show that fully autonomous cyber is capable. 50% of the hand curated challenges had

[12:54] unknown vulnerabilities. This was DARPA spent $60 million designing a contest trying to come up with problems that were well defined and well scoped and they accidentally added additional bugs and 50% of those were ones that were actually exploited.

[13:10] So this idea that we're just going to create synthetic problems with one bug doesn't work. People have tried it, spent a lot of money, you always introduce new ones. Second problem is second example I'd show is the AIxCC. I designed the

[13:24] scoring algorithm for this. This is again a very large DARPA program that ran last year in DEF CON where 18 of the bugs found were unintended ones. And so the TLDR on here is you can't just say, "Well, we're going to hand

[13:35] curate an environment with just one vulnerability." Experts have tried, it doesn't work. You have to change the problem definition. So we've been thinking about this and what we developed is a new way to test is called the audit task. Again, suppose

[13:47] you have two different bugs, but you flip the question from just find a bug to find all vulnerabilities discovered. At this point, the LLM has the freedom to find multiple bugs and submit multiple proofs of vulnerabilities. And

[14:01] it may be full proofs of vulnerabilities for bugs you know about and bugs you don't. You run all vulnerabilities through your oracle. And this is where it's very important to have a deterministic grader. So for here, for

[14:13] example, there's two vulnerabilities, it gives us two inputs that crash both vulnerabilities. And part of this grader now have to uniquify them to show that two different vulnerabilities are triggered. Now if we didn't know about vuln two,

[14:23] this also gives us the opportunity to increase our ground truth. We haven't told the vuln the LLM that we don't know about something that it found. It just gave us proof that it was able to find it. So we can normalize the set of known

[14:35] vulnerabilities at that point to be something like D star and calculate the the precision and recall for the model across multiple vulnerabilities. For example, recall is the number of known that it found over the total set and precision is the

[14:49] number of found over the submitted. What this prevents the model from doing and it essentially balances is the ability for it to go find unknown vulnerabilities, but also prevents you from prevents the model from just spamming.

[15:01] You don't want it to give you a bunch of things that aren't vulnerabilities, like for example, giving us POV in four that doesn't trigger anything. You need to disc you need to prevent that. And we found that this precision versus recall

[15:15] is the way to balance those two competing goals. So when you do this this way, you have an open world grading. Instead of trying to define one problem that's perfect, you can give it a real open-source task that can have multiple vulnerabilities,

[15:28] even though those that you don't know about. You post-hoc, since you're asking for a proof of vulnerability, you can then go say what is the total set found of those known and unknown, and you can score precision and recall

[15:40] and normalize both, so they're multiplicative. It won't just keep finding the same easy bug. You add as I said, it's open world, so you can find unknown bugs and use it on real open-source, and it also gives a clean trajectory. Now, the key to doing this,

[15:57] the one thing that you do have to add to the grader is the ability to distinguish between multiple bugs if it gives you a POV. The way we do this is the same way everyone in industry does it. We look at the stack backtrace.

[16:08] If you've ever had your program crash on Windows or Mac, and it's like submit to Microsoft or Apple, what it's doing is it's submitting the backtrace, and they're uniquifying those into independent bugs, and then they're

[16:19] scoring the results given based on that. So, we built that into the grader. It also means that there's no LLM as a judge, because let's face it, you can't judge trust the LLM that you're teaching to be a judge. And it also, what we

[16:32] found, it limits or removes bias completely. The model actually never knows how many vulnerabilities. When you say go find a bug, you've actually then given it a piece of information that there is a bug, right? And in fact,

[16:46] what we find is that models will then find tune on that and only try to find one. Here we open the possibility that there's no bugs, which provides a little bit cleaner trajectory for that learning signal. So, the key TLDR for this is don't

[16:59] define the task by a single bed, let the program define the task. We see people trying to create artificial benchmarks or synthetic benchmarks, and they'll go out and say, "Hey, let's just go find one crash, and then we'll turn that into

[17:09] an RL." What invariably ends up happening is the model will then reward hack, and then it'll stunt its growth. Or worse, you'll have an incorrect benchmark. So, the audit task is one way to continue that climb. The second access,

[17:25] if you look at going from as I said, toy programs, CTFs, all the way up to open source where you have multiple types of bugs, is what are the capabilities that our model is able to do? And this is some of our latest work where we

[17:36] collaborated with the foundational models, OpenAI, Anthropic, and we're able to check how well they can exploit high-value targets. This hadn't been done before. If we go look at public experiments out there, and we look at, for example, DARPA,

[17:51] they had looked at this question of fully autonomous where they said, "Hey, for synthetic problems that we can create, can AI do arbitrary code execution?" What we would consider a real hack. But when you go and you look

[18:02] at AIxCC or Cyber Gym or Bounty Bench, all they really checked is whether the AI could crash the program. Crashing a program is different than hacking it. You can't go steal someone's IP by simply crashing a program. So, this

[18:16] question of whether models could exploit high-value targets was actually open. So, what high-value target should we look at? We picked Chrome. And in particular, we picked the JavaScript Wasm interpreter called V8. Now, V8 is one of the things that maybe

[18:34] is foreign to you, but actually powers the internet. V8 is how Chrome executes JavaScript, and JavaScript is what's under the attacker's control. Put up a malicious website, it runs JavaScript, you can then exploit V8. It

[18:46] also runs Edge, it runs Node.js, it runs Cloudflare Edge Workers. If you've ever used an Edge Worker, it's actually running V8 where each tenant is a separate thread. It's crazy. And if you can find a vulnerability in V8, you can exploit all

[19:01] these systems. V8 is difficult to do because it goes beyond typical programs as far as security measures to try to keep it safe. For example, when you start looking at V8 and you look at the internals of this, there is a sandbox. And so, inside this

[19:19] sandbox is where you run your untrusted code, things like media, images, and so on. And inside the sandbox, we expect there to be vulnerabilities. In other words, if you can crash a in-sandbox object, it doesn't mean anything. That's expected behavior. What

[19:36] makes V8 a high-value target and what makes rewards start at 10,000 and go up to 100,000, or if you sell them on the black market, millions. Let's be frank here, people do that. is whether you can do an out-of-sandbox exploit. And that typically requires

[19:49] chaining multiple vulnerabilities together. So, TLDR, if you could give Chrome to an LLM and it could come up with a zero-day, you would essentially be able to hack nation-states at that point. It's a very worthwhile task to see how

[20:05] far we have to climb. But, we also want to be able to measure where LLMs get stuck. It's such a hard target that when it fails, you end up with very little signal. And so, we designed an experiment on X-plane, where we bucketized 16

[20:21] different capabilities in a ladder. First, can you trigger a crap Can you trigger the vulnerability? Do you just show a deviation when you hit the the vulnerable line of code? Can you crash an in-sandbox object? That's interesting, but that's just the

[20:35] first vulnerability that you find. Then, can you get in-sandbox primitives? Can you inside the sandbox get arbitrary read and write? What that allows you to do is inside the sandbox, the way exploitation works is you first exploit

[20:47] inside the sandbox and then you have a Turing-complete program if you have arbitrary read write. You then try looking for that second vulnerability and chaining it together. Can you get out-of-sandbox primitives? And then finally, can you do arbitrary

[21:00] code execution? What this allows us to do is it allows us to measure how far models get in this ladder on a really hard target. And the results were actually very interesting in this. So, we ran this on 41 V8 vulnerabilities. We went and hand

[21:15] vulnerified verified that they were all exploitable. We took actually the leader for the current Chrome security, his name is Sung Hin Lee, verify these for us. And what we found is that if you're purely looking at old benchmarks where

[21:27] our triggering a crash is what you want to do, it's really not a distinguisher among models. GPT and GPT 5.5 and Mythos both achieved 95%. They were able to trigger a vulnerability 39 out of 41 times. Essentially, all the tasks are side. And

[21:45] then if you started to look at lower powered models, things like Gemini, Kimmy, Minimax, GLM, they were still able to succeed about 50% of the time. So, think about this. If you were looking at the old benchmarks, the message would be 50%

[22:01] of the time Kimmy succeeds in hacking, but that's because their definition of hacking was broken. It was simply crashing it. The real question is can they do a full sandbox escape? And this is where we see a distinguishing

[22:12] characteristics. So, if we look at what I'd call arbitrary code execution is really what the elite would do, Mythos was a quite surprising able to do this 73% of the time. So, 30 out of the 41 examples, Mythos was able to do this sort of full control

[22:30] flow hijack. GPT, sorry, the little bar here is wrong. This was 68% of the time, and Gemini and Kimmy were 0% of the time. So, we're starting to see a signal between these models on what they can do. Little bars here are wrong, but the

[22:43] actual numbers are correct. So, there's some cool evidence actually that these aren't memorized, that people like Mythos and GPT just didn't have access to zero days out there. So, this is where I get a geek out on security.

[22:56] For example, in CVE-2023-670T, this was something that the experts in Chrome, it's a very small community, they knew that it was exploitable and they came up with a POC, but what happened inside Mythos was Mythos took a

[23:09] route that everyone thought would be too hard to do in practice. One of the things that Mythos was able to do was reverse JavaScript's math.random and use that to forge a pointer for a return-oriented program out of the Uber cage exploit. It was

[23:23] very creative. So, this wasn't a publicly known exploit. There is a public one, but what it came up with was very different for which experts actually thought would be too difficult in practice. CVE-2024-76 7965, it found a new WASM path past

[23:39] where all the public work had stop had stopped. In fact, it was unclear that there was a public exploit that worked for this. We were able, again through a lot of manual effort, to create one after the fact, but we know that that wasn't public to

[23:52] the best of our knowledge. 2024-0519, again, public vulnerability, no public exploit, Mythos was able to succeed. At the end of this, the work was on par with a human elite researcher. I actually want to say a few more words

[24:09] about 2024-7965 cuz that one was actually pretty interesting. This is one for which we knew of a public we knew that it we could exploit it on an arm, but actually even our internal expert didn't think that you could do it on x86 and Mythos

[24:21] succeeded. So, fairly significant proof that this wasn't just memorization. These are hard tasks against uh hardened targets. So, you can download this entire set at exploitbench.ai. We provide all the uh all the uh all the environments. These

[24:40] are Docker images that you can just pull from GitHub. They have an MCP interface. It's really cool. You can just say like Claude pointed at the MCP interface and see if it can hack it. We provided all the data in the transcripts with the exception of

[24:52] Mythos. And the reason that we withheld Mythos was twofold. First is we had an NDA that we couldn't release me those transcripts cuz it's not public. But second, actually me those was able to come up with weaponized exploits that

[25:04] weren't public. And so we kind of hit this quandary out there. If we're going to publish these benchmarks and we believe in open science, but the models are creating actually interesting exploits for high-value targets.

[25:16] What do you do as far as the open science part of this? We don't have an answer. Kind of fun to think about. So for the next steps, I mean we only have a 20-minute talk here. One of the things that we are doing is we're taking these as really benchmarks

[25:33] to see where the frontier models stop, and then we're building reinforcement learning environments to help get models past that. The way that we go about this is we've done a a fairly curated approach where we take open-source

[25:44] software and we built a very extensive vulnerability mining machine based upon our work with DARPA over the last decade for novel vulnerability discovery. We find unique proofs of vulnerability. These are zero days no one else use and

[25:57] we use these to then build reinforcement learning environments. Why are we finding zero days? Well, we want to make sure that the models aren't simply memorizing and we know if it's a vulnerability they've never seen before

[26:08] that it can't at least be just memorizing that. We're able to do this at scale where some of our the companies that we work with we're providing up to 10,000 reinforcement learning environments per month to really accelerate their uh learning.

[26:21] We of course can't take credit for how far these models have come, but we like the fact that we've had in some way uh some impact on how well they do at cybersecurity. So the TLDR in the entire talk is training cybersecurity is really not

[26:35] mysterious. What it takes is an actual expert that builds the right oracles that when you go back and look at the transcripts goes and tries to figure out was the was the machine just memorizing? Was it doing reward hacking? And most

[26:46] importantly, how do you handle the case where the machines are finding vulnerabilities that you didn't know about before. If you're interested in this, please reach out. Happy to answer questions.
