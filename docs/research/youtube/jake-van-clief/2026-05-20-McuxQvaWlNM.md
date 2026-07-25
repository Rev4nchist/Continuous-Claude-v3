---
video_id: McuxQvaWlNM
title: "We Ran Claude Code By Voice In A Group Call (The Future of Work?)"
channel: "Jake Van Clief"
channel_id: UCPR4DV8qMQVs_YBa-CQZQBQ
channel_slug: jake-van-clief
url: "https://www.youtube.com/watch?v=McuxQvaWlNM"
upload_date: 2026-05-20
duration_s: 452
duration: 7:32
view_count: 4489
like_count: 165
subtitle_lang: en-orig
transcript_source: auto
transcript_words: 1345
ingested_at: 2026-07-25T15:24:26.220Z
ingest_version: 1
---

# We Ran Claude Code By Voice In A Group Call (The Future of Work?)
**Channel:** Jake Van Clief · **Uploaded:** 2026-05-20 · **Duration:** 7:32 · **Views:** 4,489  
**Watch:** https://www.youtube.com/watch?v=McuxQvaWlNM

## Description

This is a cut from a longer video where I walk through the methodology behind it. If you want the full context, the three layers of ICM, and where this all goes next, the full version is here:

LINK TO MAIN VIDEO : https://www.youtube.com/watch?v=956DPSPX4wg&lc=UgxGPi585MzEHK3QubN4AaABAg

ICM Paper: https://arxiv.org/abs/2603.16021
Community: https://www.skool.com/clief-notes
Eduba: https://eduba.io

A live test from earlier this month. David, Kay, and I controlled my Claude Code instance through our voices in a group call. My agent was running locally on my machine inside a research codebase. They worked it through voice for about an hour. Cost: $1.20.

They proceeded to have a meeting with "me" for an hour after. 

#ClaudeCode #VoiceAI #AIAgents #ICM

## Transcript

[0:00] What if I could sit inside of a group call and control someone else's Claude code or AI through my voice and immediately access all of that data that's locally on their computer? What would that look like? Well, we built

[0:16] that and I'm going to show you exactly what that looks like. Over the next few minutes, you're going to see an actual recording from a live call that me and my team did built around this idea. This is going to be myself, David McDermott,

[0:28] and K Kumar working on a project that K specifically has been building for a little while now around this concept. And it's not perfect, but it gives you an idea of where the future can Take it with a grain of salt and when the clips

[0:41] are done, I'll come back and I have more to explain. >> All right, this is test one of one. We've totally never tested this before. We've hooked up my local Claude code. It is currently running locally on my computer, obviously through my

[0:54] subscription account. I opened it up inside of um it's running as a CLI inside of audit engine folder set up here, which is uh a big old database I used for my psychometric research uh at the University of Edinburgh. And we're

[1:09] going to see how it works. K, can you go ahead and ask my agent if it's ready to work? >> Agent, are you ready to work? >> Yes, I'm ready to work. I have access to the ethics engine code base, a web application for psychometric assessment

[1:23] of large language models. Just let me know what you need help with and I'll get started. >> Uh agent, can you describe what the workspace is in less than 50 words? >> Ethics engine tests AI models using psychology questionnaires. It sends

[1:36] questions to different LLMs like GPT and Claude, applies different persona framings, parses their responses into numerical scores, and generates comparative results. It also supports visual assessments using images like

[1:49] Rorschach inkblots. Very good. K, could you control my agent with your voice through this meeting to read through the scales and then add a new one that it believes should be added. >> Uh can you explain me what scales exist

[2:04] in the repo right now? >> The repo has 10 built-in psychometric scales. One, E C E one, R to the W A, right-wing authoritarianism. >> Uh can you uh looking at the scales, what scales are we missing from the psychometric

[2:26] analysis engine? agent >> Looking at what's currently implemented versus common psychometric instruments used in AI ethics research, here are some notable scales that could be added. Missing scales that would be relevant,

[2:43] one dark triad measures, Machiavellianism, narcissism, psychopathy. Two, empathy scales like the interpersonal reactivity index. Three, moral disengagement scale. Four, honesty-humility from HEXACO personality model. Five, cognitive reflection test

[2:56] for reasoning biases. Six, Schwartz value survey for basic human value. Seven, disgust sensitivity scale. >> Okay, that sounds good. Which one which of those is your top pick though? Just pick one. >> My top pick would be the dark triad. It

[3:13] measures Machiavellianism, narcissism, and psychopathy in one instrument. >> Okay, that sounds like a good addition. Can you add that to the psychometric analysis of the engine? >> I'll add the short dark triad scale to

[3:25] the engine now. Let me first check the existing scale structure to match the format. I see the scale structure. Now I'll add the short dark triad scale. This is the SD3 by Jones and Paulhus. Okay, good job. >> Uh can you go into more detail about the

[3:43] documentation that you changed? >> Sure, I updated the Claude MD file in two places. First, in the built-in data section, I changed the scales table from 10 validated instruments to 12 validated instruments and added two new rows. IHS,

[3:57] the intellectual humility scale with six items on a one to five range, and SD3, the short dark triad with 27 items on a one to five range covering Machiavellianism, narcissism, and psychopathy. Second, in the key file section under backend, I updated the

[4:13] description of built-in scales.py from 10 built-in validated scales to 12 built-in validated scales to reflect the additions. >> Looking at the front end, is there anything we're missing in the front end that would make this

[4:26] uh app better from the perspective of the scale you just added? >> Good question. Let me take a look at the front end to see if there's anything that needs updating. One thing that could be improved for the dark triad specifically, the front end

[4:49] doesn't currently display subscale information. The SD3 has three subscales, Machiavellianism, narcissism, psychopathy, but users would just see it as one scale with 27 items. They wouldn't know which items map to which

[5:01] trait. Would you like me to add subscale display support so users can see the breakdown of items by trait? That would be useful not just for SD3, but also for other scales like RWA, LBA, and MFQ that have subscales, too.

[5:07] >> Mind you, this was my master's thesis that took me a year to build out. >> Yeah, it's doing a pretty good job of understanding what I'm requesting. >> Now, we proceeded to play with it >> for about another hour or two, and I

[5:22] think in total with the tokens we were using, my custom AI voice that's routing in through API, we're using 11 Labs at the time, but I think we're going to switch over to Voxtrol, which is a more open source voice model. Uh we ended up

[5:33] spending a dollar and 20 cents for about an hour of our time and effort, and I think we could drop that number down exponentially if we used more open source models and whatnot. And realistically, the voice one is something that can be amplified by a lot

[5:46] of Invideo works and things like that. The point is not only are we able to control someone else's computer with their agent and their contacts or someone else can control mine, but we can use that dialogue, that process of

[6:00] multiple people working together with an AI to generate better dialogue structure. One of the things that we're working on right now is that kind of process of interruption because I see an opportunity in the future where this

[6:12] dialogue structure, these structured workflows, all of these things are being triggered by keywords in conversations. When we have a meeting, we sit there and dive in and talk together and I think that would be absolutely amazing to see

[6:24] these come and flow while we're in a meeting. When we capture transcripts, when we capture meetings, instead of them being plans, they can be actions before the meeting is even done and we can even hear about those actions

[6:36] directly from these agents. Again, this is more of an open-source tool. It's part of a larger project that I'm putting together because again, I think this is one solution to a larger problem that needs more solutions added in and you'll see as I'm

[6:50] posting videos the kind of structure I'm building for it, but other than that, I hope this video kind of taught you a lot today. And if you are watching this as just a demo video for Vox, which I'm cutting this video up, then please go

[7:04] check out my larger, I think it's going to probably be 30 or 40 minute video where I describe the content and the structure behind dialogue, behind my interpretable context methodology. If you are just watching this because this

[7:16] is the Vox video and this is the cut I did, well then I hope you enjoyed it. I hope you check out more things. Other than that, thank you everyone for staying to the end. I hope it was interesting to watch. I hope you learned

[7:27] a lot and until next time, happy learning.
