---
video_id: aeTb5BdmTTc
title: "Agents, codebases, and teams — Aditya Khandelwal, Amazon AGI Lab"
channel: "AI Engineer"
channel_id: UCLKPca3kwwd-B59HNr-_lvA
channel_slug: ai-engineer
url: "https://www.youtube.com/watch?v=aeTb5BdmTTc"
upload_date: 2026-08-11
duration_s: 1016
duration: 16:56
view_count: 1282
like_count: 31
subtitle_lang: en-orig
transcript_source: auto
transcript_words: 3445
ingested_at: 2026-08-11T12:27:41.070Z
ingest_version: 1
---

# Agents, codebases, and teams — Aditya Khandelwal, Amazon AGI Lab
**Channel:** AI Engineer · **Uploaded:** 2026-08-11 · **Duration:** 16:56 · **Views:** 1,282  
**Watch:** https://www.youtube.com/watch?v=aeTb5BdmTTc

## Description

Leave agent adoption to individuals and the engineer shipping two PRs a day ends up reviewing the ten that the early adopter ships. They fall further behind, the code they are reading is worse, and they conclude the agents are the problem. Aditya Khandelwal's argument, from leading a team of ten through this, is that adoption is therefore a leadership problem and not an IC one, because the changes that actually work, restructuring a codebase for progressive disclosure and converging on a shared setup, are not changes one engineer can make alone.

The symptoms of a bad setup are specific. Engineers babysit runs. A simple task burns through 500k of context and hits auto compaction. Someone says the model got dumb today, when the model did not change and the harness did. Their fix centered on one high value skill, called ship it, that carries a change from code done to PR ready, handling the description, the review comments, and CI failures, and often runs for over an hour. That duration scared people until they saw what it bought them. Around it they wired issues and boards into the repo, agentic reviews, and a code gardener that runs nightly. It was not clean: agents filing against each other took the repo to roughly 4,500 open issues in a couple of weeks. Stay for the Q&A, which lands a hard limit near 100 lines in a skill file and offers first prompt context burn as the test of whether progressive disclosure is actually working.

Speaker info:
- https://www.linkedin.com/in/aditya-khandelwal/
- https://github.com/adityak6798
- https://adityak6798.github.io/

Timestamps:
0:00 - Why solo agent advice breaks on a team
1:30 - The adoption journey, from mandates to slop
2:10 - Fear against confidence, the two axes
4:02 - Is a CLAUDE.md and some skills enough
4:38 - Symptoms that your setup is wrong
5:52 - Why this is leadership's job, not an IC's
6:31 - The review burden trap
7:09 - Harness engineering principles
7:45 - Smart prompt injection
8:25 - Close the loop and keep iterating
9:08 - The playbook: start with the basics
9:47 - Ship it, the one high value skill
11:02 - Winning over the skeptics
12:18 - What went wrong along the way
12:57 - Let prototypes opt out of the standards

## Chapters

- [0:00](https://youtu.be/aeTb5BdmTTc?t=0) Why solo agent advice breaks on a team
- [1:30](https://youtu.be/aeTb5BdmTTc?t=90) The adoption journey, from mandates to slop
- [2:10](https://youtu.be/aeTb5BdmTTc?t=130) Fear against confidence, the two axes
- [4:02](https://youtu.be/aeTb5BdmTTc?t=242) Is a CLAUDE.md and some skills enough
- [4:38](https://youtu.be/aeTb5BdmTTc?t=278) Symptoms that your setup is wrong
- [5:52](https://youtu.be/aeTb5BdmTTc?t=352) Why this is leadership's job, not an IC's
- [6:31](https://youtu.be/aeTb5BdmTTc?t=391) The review burden trap
- [7:09](https://youtu.be/aeTb5BdmTTc?t=429) Harness engineering principles
- [7:45](https://youtu.be/aeTb5BdmTTc?t=465) Smart prompt injection
- [8:25](https://youtu.be/aeTb5BdmTTc?t=505) Close the loop and keep iterating
- [9:08](https://youtu.be/aeTb5BdmTTc?t=548) The playbook: start with the basics
- [9:47](https://youtu.be/aeTb5BdmTTc?t=587) Ship it, the one high value skill
- [11:02](https://youtu.be/aeTb5BdmTTc?t=662) Winning over the skeptics
- [12:18](https://youtu.be/aeTb5BdmTTc?t=738) What went wrong along the way
- [12:57](https://youtu.be/aeTb5BdmTTc?t=777) Let prototypes opt out of the standards
- [13:34](https://youtu.be/aeTb5BdmTTc?t=814) Stop saying the model is dumb
- [14:10](https://youtu.be/aeTb5BdmTTc?t=850) Commit to the turn
- [14:47](https://youtu.be/aeTb5BdmTTc?t=887) Q&A: strategies for progressive disclosure
- [16:03](https://youtu.be/aeTb5BdmTTc?t=963) Measuring context burn on the first prompt

## Transcript

[0:01] [music] >> Today, I'm going to be talking about agents code bases and teams. Essentially, how do you get your team to actually ship together with agents? And like, I think for the longest time, like the one thing that's bugged me is like there's

[0:24] so much content about, you know, how do you set up your own code base to like work well with agents, you know, like what skills do you add? You know, this skill's better, that setup's better. But it all seems to break the moment you

[0:35] like actually try to use it with your team in your actual production setup. And like for individual repos, it kind of makes sense. But the moment you actually try to use it with your own like team setup, it tends to break.

[0:47] And like I think over the past few months, I've figured out how to make it work with a team of folks. So like I was leading a team of like 10 people over the last few months, and I think we found like a good solution, and I want

[0:58] to share that with you guys. But before we get into that, I just want to recap like, you know, what's been the journey that we've been on. Right? So we started, you know, code coding agents took off, and a few people got really, really good leverage, right?

[1:11] And I think all of us were kind of asking like, is this AGI? You know, like did we achieve it? Then, you know, companies took that and said, "Well, if one person can do so well, let's just get everyone and let's mandate it." And like token max, right?

[1:27] And that was clearly a a galaxy brain moment, right? And then the inevitable happened, you know, AI slop shipped, and there's a bunch of sev twos. I'm not going to name which companies, but you know, essentially you saw people kind of

[1:40] retracting. They said, "I don't think I don't think this is the best option here." And eventually model prices you know, climbed. We saw, you know, people figured out that tokens have to be paid for. Like you just can't token max your

[1:53] way through life. And budgets got bolted on. And you know, essentially money is being lit on fire, and the money has to come from somewhere. So, given this journey, I want to actually like this is the enterprise journey, right? And what

[2:07] does that do for a single developer? And I think this is an important framing cuz it really talks about people as a part of a team, right? And I want to look at it from like two axes. So, there is the fear axis where people

[2:21] lie on the spectrum, right? They're coming It's like Is it coming from my job? Like am I going to be out of a job? Or is it like a really handy tool? And they're really, you know, they're not that fearful. Versus like the confidence

[2:30] they have in how much they're executing it. So, they can either use it a lot or they can use it, you know, not that much because they don't really know how to use it that well. Now, when we started, like people said, "Oh, you know, what is this? Is this the

[2:44] end? Like am I needed?" And fear was pretty high. Utilization was pretty low cuz people didn't really know how to use it. And then when a few people got outsized leverage, you saw, you know, early adopters basically people saw them and people

[2:56] said, "Okay, well, it looks like I'm still kind of needed if I figure out how to use this thing. So, let me actually try using it, right?" And then we saw, you know, mandates and token maxing, and people kind of got a little skeptical. Like confidence stayed

[3:10] the same, but people tried to use it a lot more, right? And then we realized, uh you know, there's a bunch of slop shipping, there's self-tours, and I, you know, it's like I'm not really that scared cuz, you know, it just slip

[3:22] it just ships slop. Like I'm going to still be needed. And they don't even know how to use it that well cuz like now the confidence is greater, right? And so you got to figure out how to get people from all the way wherever they

[3:34] are on the spectrum to where they're not fearful and they're actually using it a whole lot more. And this is the framing that I want to like I want everyone to keep in mind as they're actually trying to get a team to adopt good like AI usage and good AI

[3:47] patterns, right? And so, the The is, you know, what does it take? Step one, create a Cloud MD. Step two, add some skills. Is that it? Do we like solve it? You know, I think we all know like you guys are here because like clearly

[4:04] life's not that simple and like stuff's messy, right? And I think a few people might ask, you know, why doesn't this work? Like isn't that what like everyone does? And I want to like just talk about a few things you might see that actually

[4:18] indicate that yeah, like this isn't working. So, the first thing is if you're babysitting your agents, it's not the right setup, right? And you got to realize that. If you're seeing people in your team babysitting their

[4:30] agents, something's wrong. Is, you know, one of the things that I heard a lot was is, you know, insert whatever latest model there is being really dumb today. The model didn't change, right? The hardness may have changed underneath.

[4:44] But if it's really like that's that's acceptable to like small changes in the hardness, clearly your own code base isn't set up well. It's silently burning context and money. Like you don't realize it, you know, you go you blow through like 500k context,

[4:59] you might go to like 750k million and hit auto compact even though you're not doing like a really complicated task. Clearly something's wrong. You know, if you have long ass sessions needing constant intervention, there's

[5:12] still something that's wrong. If you're getting a constant slot factory, obviously know like things are things are not good. And if you're asking if you find yourself asking, you know, how are these other companies shipping so fast? Like

[5:25] how are model companies releasing models at like a month and a half two-month cadence? Clearly they they have something which we don't, right? And so, I guess everyone's kind of thinking so, you know, how do we solve this correctly?

[5:40] And so, I think the first thing to realize is we need to frame it correctly, right? It isn't really an IC's job. It's a job for leadership. It's a job for the company, right? Making engineers work well with their agents is truly the

[5:55] most impactful thing you could do as an organization. Because that's going to enable your engineers to ship faster and with confidence and avoid, you know, a lot of incidents. If we live in this figure it out for yourself paradigm, like people are going

[6:09] to get outsized productivity, some people aren't, and like the people who are generating like 10 PRs a day are going to like look like, you know, gods compared to people who are shipping like one to two. And the one to two PR people

[6:22] are actually going to get left with the review burden. And that's actually a really, really bad thing. Cuz now not only can they not ship, they're going to actually see bad code and then curse the agents and hence not be able to get on

[6:33] to the let's ship 10 PRs, right? And so it's really important to do this. If it's a problem facing the team, there's a few things you can do, right? The most impactful things that you can do to set up your code base to like make

[6:47] it work well require team buy-in. You can't just like if you want to change the way your code base is organized, you can't do that as an IC, right? And if you're treated as a leadership problem, then you can do things like

[6:59] this. So, the other thing this needs is harness engineering, right? Per code base. And I think there's a lot of content on this, so I just want to talk about a few principles, but I don't want to like make this talk about that

[7:12] because there's a lot of smart people. You're at AI engineer, right? Like this this conference is all about people telling you how to you best set up, you know, your code base to make things function well. So, I don't want to talk

[7:22] too much about this, but there's a few key principles here. Smart prompt injection is one of them. You want to treat your entire code base as one way to that so that you're able to like smartly prompt inject the model with just the right context at just the

[7:35] right time. Without you needing to do it. And that's the framing. You want to be able to say, "Okay, I've set it off on this task. It has like a map of how to find the things it needs at the time it needs it." If it's looking at some code

[7:49] and that code has, let's say some documentation, it the documentation needs to live in the comments. So, if it ever grabbed into that code, it reads the comment, goes to that file, finds all the information about it. That's just one example. The second is

[8:03] close the loop, right? You got to make a self-healing system cuz slop is inevitable. There is going to be some slop that's going to seep in. But, you need to have a pipeline and a way to close the loop to remove the slop, to

[8:15] detect it, and to be able to like self-heal the system. And then you need to iterate continuously. And I can't emphasize this enough. Like, you can't assume that you do this for a month and you're done. Like, things are going to change

[8:27] constantly underneath. So, you need to keep this as one of the things that you have to do as an organization. And the third most important thing is treat it like a human problem, guys. Like, this isn't It's not, you know, oh,

[8:38] it's this tool. Like, people will figure it out. Let's just mandate our way through life. Like, that's just not going to work. So, treat it like a human problem. Fear is real. Human emotions are real. We should recognize it.

[8:50] So, you know, enough gyan or as like it's more like the Hindi way to say like, you know, I'm enough prof like I'm kind of giving you sermons. But, like, how do you really do this, right? Like, these are all principles. What's the real playbook? So, here's

[9:04] what we did and here's like I'm not going to over like emphasize on this is the exact way to do it, but this is like roughly how we did it and you can take from it what you choose. The first thing is do the basics, right?

[9:16] You got to do them right. Progressive disclosure, I can't emphasize this enough, is really, really powerful, right? Find your best ICs and find what how they are making the code base work for them. Take those practices and pass

[9:29] them or guide. People can't live in their own practices. And this is really hard for engineers to do it. It's basically accepting that my setup is imperfect. And like engineers don't like to hear that. But you got to figure out a way to

[9:41] find those best practices and ship them across. Make sure that that's kind of a shared setup. The second thing we did was there's one high value skill that we invested in. In our case it was this thing called ship it. What it did was the moment you're done

[9:55] with your code, it takes care of everything from code done to PR ready for review. Which means you got to open a PR, figure out your opinions, handle the handle all the comments, you know, handle all the PR descriptions, the merge comments,

[10:09] everything, right? It handles CI failures. It basically runs through these loops. And what this meant was often the skill was running for over an hour. And that scared people, but once you actually figure out once they saw the

[10:21] value, they get invested, right? Because it's one skill which tells them, "Okay, this AI thing can actually work for me. I don't need to constantly baby sit it. I can trust it." The third thing and really important is to close the loop, right? So we wired

[10:35] issues and boards into the repo. Like we added CICD. We added gigantic reviews. We have like a code gardener that actually goes back and looks through a whole bunch of like every night it'll run and look at the code and check if

[10:46] something like not organized correctly. What does correct organization mean will depend on your code base. Get people invested and I can't emphasize this enough. You have to win over the skeptics. It's really easy to say like the skeptic is just someone

[11:00] who's scared. It's really hard to get them to buy in, but if you can get them to buy in, you know you're doing something right. You have to get them to be able to edit and play with the shared setup cuz that's the true way you know that

[11:13] they're actually invested, right? And this is where you got to it ensure you're iterating constantly. If people are like and this is the hardest thing for engineers again cuz you're basically saying I'm never going to like get to

[11:25] perfection in my setup. But you got to be okay with that. You have to do it and you You to treat it like, you know, X% of your IC time is probably going to be spent on it trading on this thing, which is not going to lead to like meaningful PRs like up

[11:38] front, but it's useful and it's worth it. And, you know, I don't want to say this is perfect, right? Like we faced a ton of issues while doing this. And I'm just going to walk you through some of them. But it's an iteration

[11:50] loop, so you got to treat it like a piece of feedback. So, what are the problems we hit, right? There are too many issues. Like when we started like we blew up to like 4 or 500 issues uh without like, you know, just I think

[12:02] within like a couple of weeks, which is a crazy number for like a repo. And then, you know, there are so many like different agents all trying to create issues cuz they've not been wired correctly. There's a lack of agreement. People, you

[12:12] know, as soon as people saw like, "Oh, this isn't working perfectly or the way I expected it." There is super easy for them to say, "You know what? I'm just going to go back to babysitting my agent." You don't want that. You want to

[12:22] actually take their feedback and put it back into the skill and improve the skill. Agents are taking too long. This is actually one of those expectation setting things. It's good if agents take too long. That means you can actually go off and do

[12:35] other things and you have confidence that they're doing the right thing. At the end of the day like the moment we hit this reasoning paradigm, the longer the agent like thought, the better its output. You can treat like it's It's

[12:45] almost like a similar mindset for your entire code base and for your skills. There's going to be merge hell and like we just have to deal with it. We have to figure out a way to deal with this. There is going to be slop when you're

[12:59] going to write experiments. Treat it like it's own thing, right? What we said was okay, people are generating this code, but it's not relevant. It's not going to be shipped. It's just an It's a prototype. So, treat it like one. Get it

[13:10] to opt out of all the rigorous other standards you've got across your code base. And realize people vary on the spectrum, right? And depending on the day, depending on like what they're going through, they're going to vary on the

[13:21] spectrum. You have to be able to talk to them and figure out, "Hey, okay, why why are you facing this? Like is it if the model changed, the hardness changed, again you need to go revisit something. Figure that out. And I think the biggest like the easiest

[13:35] way to say this is instead of saying like the model is so dumb, like we have to ask how can I make it smarter or how can I edit like and not This is where I have like crossed out the my. It's not a personal setup. It's the shared setup

[13:48] that you have to invest in. And it's a mindset, right? You have to go full send. And like I want to end you with I want to end with this. Like, I learned skiing like a couple years back and the first like the hardest thing for me was you

[14:03] actually have to commit to it. If you're pizza braking, you're going to crash. Like, no matter what. You have to commit to the speed in order to actually get and feel like, okay, that's how I can turn and that's how I can truly ski. And so, I'm going to

[14:16] leave you with this. Like, just be okay with be okay with failing. You have to, you know, go full send and be okay with falling. It's fine. The point is to be able to recover from that and that will allow you to truly feel the AGI.

[14:32] Yeah, well, that's that's me and I'm happy to take any questions. Yep. Uh so, the I'm going to repeat the question for the recording. Uh strategies that you found best for progressive disclosure. So, I think a couple things, right? Uh

[14:53] the first thing is even in your skill.md files, don't overload it. Like, we've kind of set a hard limit for like 100 lines in your skill.md cuz your skill is really a folder. So, that's step one. Make sure and I think I spoke about this during the

[15:07] talk, but when you have like some code that requires like a runbook, make sure the runbook is reflected in the comments so that if a code if somehow the code like the agent figures its way into like grapping into the code

[15:21] base and find that file, it knows I need to go look at this for like all the description of how this is relevant. Right? You have to organize and I think this is why I talk about harness engineering because your entire code

[15:33] base can be set up to encourage progressive disclosure. Don't overload your cloud MD or your agent's MD file into like one big thing. You want to make sure that like it's a thin index that can point through the right files

[15:45] and that's what the agent gets in its like first prompt cuz that's what gets loaded when it starts to work. So these are like some really powerful strategies that and the way you know this is working is when you give it a

[15:56] prompt. When you give it the first prompt, see what it's doing. Is it grabbing or does it know where to go? But how much context is it burning when it like immediately? So is it like I think like 20, 25K tokens get taken

[16:07] anyway, but like how much more is getting added? If you're coming to like 40K, 50K, like something's wrong. That's not really progressive disclosure. So you have to figure out these boundaries and then like based on this

[16:18] it's an iteration cycle. All right. Well, if there there aren't any other questions, feel free to find me. Happy to talk about harness engineering in general or like anything else, but yeah, thank you for listening. >> [music]
