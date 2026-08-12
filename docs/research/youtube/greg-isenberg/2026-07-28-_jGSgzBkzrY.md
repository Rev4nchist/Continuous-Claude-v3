---
video_id: _jGSgzBkzrY
title: "Jack Dorsey's Buzz: Clearly Explained (and how to use it)"
channel: "Greg Isenberg"
channel_id: UCPjNBjflYl0-HQtUvOx0Ibw
channel_slug: greg-isenberg
url: "https://www.youtube.com/watch?v=_jGSgzBkzrY"
upload_date: 2026-07-28
duration_s: 2324
duration: 38:44
view_count: 44969
like_count: 1125
subtitle_lang: en-orig
transcript_source: auto
transcript_words: 7136
ingested_at: 2026-07-30T13:05:25.557Z
ingest_version: 1
---

# Jack Dorsey's Buzz: Clearly Explained (and how to use it)
**Channel:** Greg Isenberg · **Uploaded:** 2026-07-28 · **Duration:** 38:44 · **Views:** 44,969  
**Watch:** https://www.youtube.com/watch?v=_jGSgzBkzrY

## Description

I sit down with Vinny for a live tour of Buzz, an open source, agent-native chat app from Block built on an open protocol. Vinny makes the case that openness is the real story here: agents arrive as first-class teammates, the harness underneath each agent swaps freely between Claude Code, Codex, Goose, and open code, and your entire chat context travels with you through every swap. He demos real output, including a CRM app built with the Wasp full stack framework and deployed to Railway, plus a tweet leaderboard that pipes daily stats back into a channel through a public API. I press him for the honest state of the software and for the setup advice he actually uses day to day. By the end I share where I land on Buzz versus Slack, and why I think anyone building right now gains from putting their hands on tools like this.

Try Buzz for yourself: https://startup-ideas-pod.link/buzz

Timestamps

00:00 – Intro
02:57 – Agents as First-Class Team Members
03:49 – Swappable Harnesses Under Any Agent
06:55 – Audio Huddles With Agents
08:34 – Git, Feature Branches, and Parallel Worktrees
11:20 – Building a CRM App with Buzz and Agents
13:43 – Why This Matters
18:13 – Best way to engage with your Agents
23:53 – Shared Compute and Local Models
25:42 – Model Choice, Data Ownership, and Lock-In
27:36 – Context as the Foundation
29:39 – Setting Up Agents
31:21 – Skills and Speed
33:03 – Who Should Try Buzz Today
34:36 – My Take: Live in the Future
38:10– Closing Thoughts

Key Points


## Chapters

- [0:00](https://youtu.be/_jGSgzBkzrY?t=0) Intro
- [2:57](https://youtu.be/_jGSgzBkzrY?t=177) Agents as First-Class Team Members
- [3:49](https://youtu.be/_jGSgzBkzrY?t=229) Swappable Harnesses Under Any Agent
- [6:55](https://youtu.be/_jGSgzBkzrY?t=415) Audio Huddles With Agents
- [8:34](https://youtu.be/_jGSgzBkzrY?t=514) Git, Feature Branches, and Parallel Worktrees
- [11:20](https://youtu.be/_jGSgzBkzrY?t=680) Building a CRM App with Buzz and Agents
- [13:43](https://youtu.be/_jGSgzBkzrY?t=823) Why This Matters
- [18:13](https://youtu.be/_jGSgzBkzrY?t=1093) Best way to engage with your Agents
- [23:53](https://youtu.be/_jGSgzBkzrY?t=1433) Shared Compute and Local Models
- [25:42](https://youtu.be/_jGSgzBkzrY?t=1542) Model Choice, Data Ownership, and Lock-In
- [27:36](https://youtu.be/_jGSgzBkzrY?t=1656) Context as the Foundation
- [29:39](https://youtu.be/_jGSgzBkzrY?t=1779) Setting Up Agents
- [31:21](https://youtu.be/_jGSgzBkzrY?t=1881) Skills and Speed
- [33:03](https://youtu.be/_jGSgzBkzrY?t=1983) Who Should Try Buzz Today
- [34:36](https://youtu.be/_jGSgzBkzrY?t=2076) My Take: Live in the Future
- [38:10](https://youtu.be/_jGSgzBkzrY?t=2290) Closing Thoughts

## Transcript

[0:00] Jack Dorsey just launched Buzz and it's gone completely viral. Yes, it's the same Jack Dorsey who co-founded Twitter, who co-founded Block. This guy is building what people are calling a Slack killer. Now, why does this matter for

[0:14] you? Well, it's being called a Slack killer because it's almost like this agentic version of Slack. It's a way to have uh conversations with your teammates, except they're agents. It's a way for you to huddle agents. It's a way for you to have

[0:30] software being built on the fly via agents. So, in this episode, we're going to break down it so clearly for you so that you understand what it is, why you should use it, and what are the best tips and tricks to use Buzz. My take on

[0:44] this whole thing is it's a glimpse [music] into the future of work. I can't wait to see what you think about it. And the By the end of the episode, you'll understand if it's for you, why you should use it, how you should use it.

[0:56] Enjoy the episode. >> [music] >> The Startup Project It's sipping time, baby. >> [music] >> What's up, Binnie? I saw your tweet. Uh Jack Dorsey retweeted it. By the end of this episode, what are people going to learn? >> They're going to learn how to use um

[1:16] Buzz. Uh mostly, I think it's like the sweet spot for um Buzz right now is I think uh solopreneurs, uh small teams. Um they're going to learn how to use it to like kind of brainstorm, keep everything in context between their agents, and just

[1:34] uh you know, build products, build solutions, ideate, and and like um yeah, use it to to get stuff out there quicker and be more productive. >> Cool. Okay, so what I what I hope to get from this is basically understand what Buzz is,

[1:49] understand why it matters, understand some best practices on how I can use it to actually use agents to do things for me. Um and by the end of this episode, I want to understand if I should actually use this thing. Or should I just

[2:05] basically continue using Slack? Um and that's what I hope to get a out of this. Do you think you think you could commit to that? And also, while you're going through it, just share the best practices that haven't been shared

[2:17] anywhere so that, you know, we we've we've got a little edge on people. You think you can do that? >> Yeah, I think so. Um I just want to start off by saying like uh I think the Slack killer, you know, that's a good line that it's a Slack

[2:29] killer. Um but I think the real like the real um selling point for me for uh with Buzz like from the beginning is just the the openness of it. So, um do we want to start there? Just like what I mean by open and and what kind of

[2:46] like what that allows, like the power uh how powerful the openness feature of Buzz is. >> Yeah, I mean, sell me on Buzz. Like, why >> Okay. Okay. >> Yeah. >> Um so, first off, um it's Slack with agents inside and a lot of people like it's kind of like Slack.

[3:03] You got the agents inside, so Slack allows you to do that um but by adding an integration, but um in Buzz, they're like first-class citizens, right? So, they're members of your team. You don't think of them as like uh add-ons or just

[3:17] kind of uh um a side feature. They're an integral part of of the app. They're part of your team. Think about it that way. So, um I'm kind of uh I like to keep things simple and I just started using this not too long ago. I mean, it's only been out for a

[3:31] little while. Uh I just discovered it and um these are basically what you see here are the default agents you get when you start, but um under the surface, there's a really powerful thing, which is you can edit and add agents and um

[3:45] when you give agent instructions, uh that's just basically like a system prompt. Um the really cool thing underneath is the harness. So, we're all probably using Codex, Cloud Code, maybe something like Open Code to do our coding work, build products,

[4:03] um whatever, be more productive. The great thing here is that your agent harness is swappable under any agent. So, I can go under here and say, you know, I want to use Cloud Code, I want to use Codex, um I want to use Goose, and like for me

[4:21] already that point there was like, okay, this is very cool. Um and the reason why this is so cool is because, I mean, if any of you all your listeners probably follow this stuff at AI moves at like a breakneck pace, right? So, today it's

[4:38] this model, the next day it's the other model, and sometimes, I don't know about you, but personally, I'm like, I get model fatigue where I'm just like, gosh, you know, I I just switched over to this, I just got used to this model.

[4:50] Like, I don't even want to hear the good things about model X cuz I'm still over here using model Y. Um but the cool thing about this is that this is a layer on top of that, and you can just switch, and the best part is is

[5:03] that your agent you don't lose anything in that switching process. You can change the harness under your agent, and all the context that's in your chats, so everything you've been chatting about with this agent, like all the stuff

[5:15] you're trying out, the apps you're building, that all that all that context comes with to that new harness, to that new model. So, first off, that's something I think is really cool about uh Buzz. >> That's a that's such a huge deal because

[5:29] I feel like a lot of us are ping-ponging between different models and harnesses and stuff like that, and it's tiresome, you know, when you're when you're starting from scratch, um it does feel like and then I need to understand,

[5:43] okay, what is Saul good at, too, you know, like and what are the contexts for this particular model to get the most out of it. So, I think the fact that this is built natively into the product um that you can go and switch just

[5:58] like I like that because it's thinking about how people are working in today's day and age and they're acknowledging it and they're like, we understand that yes, there's going to be new models all the time and you might want to be

[6:12] switching, but you probably don't want to spend a lot of time adding context, figuring out things cuz you're busy trying to run a startup, trying to make money, trying to be productive. >> Yep. Yep. Exactly. And you can take all

[6:26] your stuff with you, you know, like um if you're if you've built all these skills and skill files and folders and stuff, you know, as long as they're in like the global directory, if they're accessible to uh globally and they're

[6:38] they're not project-specific, like Buzz can access them. So, you that can install agent skills like normal. Um you can change then you can change hardnesses, change models, and and your your agents in the chat have access to

[6:51] all of them. So, I think that's really cool. Um I'm really happy about that. >> Okay, what else do we what else do we need to know? >> We've got audio huddles with agent. So, that allows you to have like an audio chat with your agents and uh they'll be

[7:05] in the chat and they'll respond to you and so you can, you know, have a voice call with someone else, bring an agent in and communicate, and they also get the context of your of your whole chat in the uh audio huddle. So, that's

[7:17] pretty cool. Um I haven't tried that out yet though, so um I have seen there's some good videos on YouTube that run through it and show you how to do it. So, >> What's cool about huddling and, you know, agents or an agent, I I tweeted I

[7:31] tweeted about this. I feel like what I'm missing from building in the AI age is I feel like I'm asking my agents to do things. Maybe I'm using WhisperFlow or even just typing it. And it feels very much like back and forth, back and forth.

[7:48] What's cool about huddles is live. And I I the way my brain works when I'm when I'm being creative is stuff like that is I need like live interaction in order to really like extract what's going on in my brain. I think there's

[8:02] probably a lot of people like me like that. So it's cool that that that's a feature. Uh my dream and I tweeted this. My dream is eventually to have like the ability to FaceTime agents. Um and that to me is like the holy grail of

[8:19] the future of work. But you know, cool that you can see that um Buzz is scratching the surface here. Is it good or if it's not good, we'll have to test it. Uh people in the comment section, please let us know. Um but it's

[8:32] interesting it's interesting that that feature exists. What what's another feature that you're excited about? >> I mean, well, right under the surface you've got these agents and you probably want them to do work. So um

[8:43] they're like integrating um they have Git pretty tightly integrated um into it and your agents will actually um uh you know, what they're doing coding, they can create projects. They'll create uh feature branches and they work in

[8:58] parallel work trees. So they're not not actually messing with stuff that's locally on your computer. They'll make a uh work tree, a copy, and uh they can work there. So they can do things in parallel. So you could um for example,

[9:11] um you know, you're talking to your teammate about a UI, uh the design of your product or your webpage or something, and you can just, you know, tell the agent like spin up three different versions of landing pages based on the ideas that you guys had in

[9:26] the chat, right? And um they've just added this projects view. So if you go into um settings here, there are experiments. You can turn on workflows um and projects for example, and then you'll see that here. And this is

[9:41] basically like um you know, your your apps that you're coding on with your agents and working on with your agents. And another interesting thing is that you can integrate with GitHub, but under the surface they have their own um

[9:57] hosted Git hosting. So, you can push to remote repositories that are actually on your relay. So, um that's probably a more technical thing, but Buzz works on relays. So, these are like servers that you host and or that get hosted for you by by

[10:18] Buzz, by Block. And then they'll actually push that code to the remote repositories on your relay. So, the relay is where all your information, all your chats, everything, that's where all that stuff is is happening and where

[10:32] it's stored and where it's getting sent and and pushed to the other people you know, chatting with you and the agents chatting with you. So, I can see in the future that they're they're trying to take on more than just Slack here. They're trying to take on

[10:46] GitHub as well. So, that's pretty crazy. >> Cool. And I think, you know, for the non-technical audience, I feel like a lot of my non-technical friends are actually starting to use GitHub now in the AI age. I don't know if you've

[10:58] noticed this. >> No, I don't I'm kind of in the I'm mostly mostly in the yeah, the nerd bubble. >> Yeah, it's it's interesting. It's just I feel like you know, 5 years ago if you were non-technical, 10 years ago if you were

[11:12] non-technical, you barely knew what GitHub was. The word repo, you're like, you know, are you repossessing my car? You know, but I think now in an AI age where we're kind of all technical in some way um something like this makes makes a lot of

[11:30] sense to be built natively. >> Yeah. And the the interesting thing is you don't really have to know that much about it. Uh you don't really have to even consider it because your agents will just kind of take care of stuff for

[11:43] you. Like I was doing stuff here um where I was asking it, you know, pull up a simple CRM app and um uh you know, I I told it here's the chat right here. Spin up a simple CRM app using uh the Wasp full-stack framework and deploy it to Railway for me. So, you

[12:01] know, there's some technical knowledge there. You know, I'm asking for a specific framework, a specific hosting provider, but um it'll do that and uh even, you know, get stuff pushes it to these remote repositories um deploys it live on the web and even

[12:18] sends you screenshots. So, it's like, oh, here's your here's your CRM. Here's your uh that I just made. And um that's all before I even checked out what it was even doing. So, just it did it for me, uh gave me the links, gave me a

[12:30] little preview of it, and um yeah. Uh I thought that was pretty cool. >> That's ins- That's insane. >> Yeah, there's a lot of I feel like they they've baked in a lot of workflows and um a lot of just like uh prompts into these agents so that these

[12:48] agents kind of can work end to end and really get tasks done. I think that's the idea. >> Yeah, that's that's insane. Like if you think about it. Like we're kind of like glossing over it, but like look what we built. >> [laughter]

[12:59] >> Yeah. And it's like it's live on the internet, right? Already. So, the nice thing is, you know, I already had a Railway account. Um I um I you know, I know a little bit about working with uh full-stack apps, but I didn't really tell it much. I just said,

[13:14] you can see the chat put this online. So, now I have a fully functioning CRM dashboard that I can uh share with team members and then we can The cool thing is then what you would do is you'd add them to this chat here and

[13:28] you start talking about what features are missing, what things you don't like, like and then you guys you know you have a conversation with your teammates and you come to a a conclusion and you just tell your agents to go ahead and start

[13:42] working on it and they'll do it. >> So why this is a big deal is if you think about it, you know, you're able to create software on the fly essentially automated that's high quality that could be deployed that you can manage and a

[13:56] view that you know, it it is clear and I think you know, if you think about your business, let's say you work you have an agency business, proposals is you know, the lifeblood of your of your business in a lot of ways, right? And you know,

[14:12] imagine that you can create uh proposals based on people's data, maybe you're pitching um the NFL um and you're you know, you could put in the context of the pitch, meeting notes, let's say from granola or something else, it ingests it and then on the fly

[14:32] you have these agents based on that create proposals that are unique to those clients. And it's vibe coded or or it's using agents to actually you know, create them. You know, there's so many ways that you can use this interface to think about okay,

[14:50] I have you know, context over here, this is how it comes in and then here's how it's going to get spun up on the internet or through you know, an asset that is built within code and then here's how you're going to view it.

[15:05] Is that right? >> Yep, yeah, exactly. In one of the one of the videos I made that I posted on Twitter, that was what I was going through. So I was taking a more of like a a marketing angle and I built a tweet leaderboard for for Twitter. So like my

[15:22] team um like how much we're tweeting, how good what are what are our top tweets, all that stuff all that information was being um uh collected in this in this app, this full-stack app, and then I was like, "Oh, well, um instead of just building

[15:37] it with Buzz, why don't I get Buzz to also access the app, get that information, then we can get like, you know, daily reviews here, daily digests, and um we can also like kind of um brainstorm on what's working uh in our Twitter strategy for

[15:55] marketing, what's not working, get it to um find like links between the the popular uh tweets, and you know, brainstorm, come up with new stuff." So, that's exactly what I did. I had it I told it, "Let's build a um publicly

[16:07] facing API, and then let's build a workflow." So, I just tell it daily, you know, check that API, and um give me the uh numbers back. And then the awesome thing is that's what you're seeing right here in this tweets stats for app from

[16:21] app. Um it's getting the stuff from that dashboard through an externally facing uh API, and um putting it here into this channel, and then I can reply to it and be like, "Okay, uh Fizz," which is one of the agents, like Fizz, "Um let me

[16:38] know what's the the common thread between my successful tweets this um this uh uh last 7 days." Because it also sends those over the API. So, if I understood you correctly, I think you're talking about kind of these workflows where

[16:50] you're like this circular stuff where you're giving information in, getting it out through apps, and it's all going into the context of your your agents and stuff like that. >> Exactly. >> Yeah. >> Yeah, I mean, I'm interested in this

[17:01] because this is like the {quote} "boring stuff" that every business has that if you can figure out how to have some unfair advantage here, um it's it's what separates a good business from a bad business. >> Mhm. Yeah, and and that's the thing I really

[17:20] like is that this openness of Buzz like it allows this kind of these kind of integrations to to happen very easily. So, with Slack like you would have to you know to get all this kind of stuff up and running you'd have to get API

[17:34] tokens, create an app on their platform. Um all their stuff is uh proprietary. You have to like learn how the structure of things. I mean with agents it's easier but here because it's built on these open protocols you can get stuff

[17:46] like this running really easily and then you have this just like crazy context engine that just can help you do work. Like if I wanted to I could ask Fizz right now, you know, like um connect up the app uh or you know, connect yourself

[18:01] to the uh xAPI and um make it available so that we can start tweeting from Buzz. Like that wouldn't be that hard. We could probably do that in in 15 minutes, you know? >> Crazies. >> One thing that I really like about this

[18:15] kind of uh you know, this close we were talking about this closed circle of like context um that I'm getting back from my app so that tweet dashboard app is that like here it sends me the tweets every day and the the stats like the top

[18:29] tweets and my stats and impressions and I can just ask uh the agent like um let's make sure I'm I'm replying there and I'll just say like uh what can like what is the common thread between my top tweets? And um sometimes

[18:49] like I used to do this with in a session with um uh Claude Code or Chat GPT where I'd be like literally you know exporting tweet data or copying pasting tweet data and putting it into Chat GPT on the on the um desk or on the uh brow in the

[19:06] browser, you know, and getting information chatting about it and and pulling it back but like this is so cool because it's pulling the the it's getting the information from the X API. It's in the context window of the agents here. I can

[19:21] chat about it here, and then um you know, we're we can chat with colleagues about like what you know, what are some more tweets we want to push out, what's a a different marketing angle we could take, and um uh that's what I really like about this

[19:35] uh here. And And you're going to see there is the um agent working. So, what's actually going on in the background? That's nice if you're um if you're used to looking at this kind of stuff in a terminal. You actually see

[19:47] the tool calls that it that it's uh um the tools that it's calling and uh think or here it is down here. Like what is happening? So, um it's getting information from the channels, uh checking for newer stats and things like

[19:59] that. Gets the result. Um and so that's all like kind of under the curtain stuff, but um we should get a response back soon. >> And is there is there any like tips around how you is best to talk to them? Like I see here as you just wrote a short and

[20:21] concise question, but how do you how should how should people think about the best way to to talk to some of these agents? >> Um I mean, they're pretty good at pulling out the the intent behind your questions these days. So, just have a

[20:38] conversation with them like they would like a normal person. So, I don't think I don't at least don't have any special special approach there. Um I kind of just say, you know, some This is probably nicer than what I would

[20:50] normally type. Like usually I got typos in there and stuff. I'm like, "Give me the sauce, you know?" And uh they're usually pretty good at that is because they have all this context. So, um I'm usually pretty uh straightforward and

[21:02] and concise with like the the questions and the the stuff the prompts I give. Reported back. So, um it's showing like what I did. I tried Jack's Buzz. I deployed open SAS to OpenShift. My first time successfully self-hosting.

[21:16] Um so, it's like um it's showing that um you know, I'm doing these things as a beginner and I'm reporting back on what I learned and those are the the things that are doing well. So, it worked. Uh my top two top two tweets got over a million

[21:34] impressions. Uh but this sucked theme uh got a you know, they were the bottom uh half and they got a collective uh you know, 88,000. So, um novelty gets you reach, friction gets you engagement. So, there's some actually really good advice

[21:50] there and um like that's kind of the power of uh using it here and having all of it in in Buzz is that makes stuff like this um uh easy and illuminating. So, that's really cool. I like that. >> Um by the way, I saw uh one of the one

[22:06] of the pieces of feedback is nobody is mentioning that uh Buzz has a backdoor for Bitcoin native payments. What What does it What does that mean? >> Um so, Buzz we're talking about open protocol. So, I kind of glossed over

[22:20] this. It's built on Nostr and um Nostr is the name of the open protocol that Buzz is built on and I personally believe cuz you know, if you know Jack Dorsey, he's a big fan of Bitcoin. Um Nostr has tightly coupled with uh

[22:34] Bitcoin Lightning, which is a a very um fast and like almost uh fee-less way to um pay and transfer Bitcoin. And uh my guess here is that um because it's built on Nostr, Nostr's open, you'll be able to integrate uh Lightning Bitcoin

[22:51] Lightning payments into um uh Buzz and um you'll either be able to pay a agents will be able to pay for compute, this shared compute idea that we talked about, um or uh um that's in there in the settings. Um you'll be agents will be able to pay for

[23:09] work and compute, or people will be able to pay other people, tip other people for tasks they get done. So, like I can honestly imagine a big open community of let's say, I don't know why I keep gravitating towards graphic designers,

[23:22] but like I say designers and uh you know, you need a really cool logo and AI gen image gen isn't really doing it for you, and you ask some people to like, you know, spit out some ideas and and some random person in in some, you know,

[23:34] graphic design community uh on Buzz gives you like an awesome logo, and you just, you know, tip them. Thank you for that idea, and then you you you go ahead and and keep working. And um uh yeah. Um we'll see. It's not integrated at the moment, but I I think

[23:50] it will come. >> Very cool. Awesome. So, what else do people need to know about Buzz? >> Um so, let's see. Um you mentioned that shared compute um idea, and I think that's that goes back into like the openness of Buzz, and

[24:08] that's uh really cool. And that was something that really surprised me, too. So, um why don't we just uh talk about that for a minute? So, we've got this uh compute uh setting here, and you can turn it on, and it will automatically um suggest

[24:24] some local LLM, some local um model AI models that you can download on your laptop or your computer, and you can literally share them with the other members of your team. So, um let's say that you are just starting out, you're a

[24:41] college student, and you want to start building a business, you got this awesome idea, you don't have a lot of time, you don't have a lot of help, and you don't have, you know, like the money to buy one of these Max Pro

[24:52] plans, whatever they're called, um with the like unlimited token budget. So, um you could get together with some friends, you know, buy a decent size laptop or a Mac Studio or something or maybe even like a beefy Mac mini. You

[25:06] put this on, you share compute, and all of you can use this one model running from one machine even though you're chatting from different uh from different laptops, from different computers, whatever. So, um that's just like a very simple example,

[25:20] but um you can see how they're paving the road here for um real openness in model choice and um being able to like really harness the power of these open-source and and local models that are always getting stronger and you know, starting to compete with

[25:37] the frontier models from Anthropic and uh and OpenAI. So, I think that's really cool. >> And why do you think that even this is worth playing with, you know, or you know, why is this really important? Why is local important in the grand scheme

[25:53] of of the future of work? >> Um I mean, model choice is important depending on what you want to do. Um and um you know, it's the same idea where Slack is the controller of your data, and that data is very valuable. You're sitting here, you know, spending

[26:13] I mean, this stuff makes work a lot easier, but you you still have these really cool ideas, you're iterating on these ideas, um you're putting stuff out there that you work pretty hard on and that you think a lot about. And then to have like just one

[26:27] company control all that data basically, um like Slack for example, have the whole all your data in that sessions, and if you're tired of Slack and want to move to something else, it's really hard or it might not even be possible to take

[26:40] all that data with you to some other platform. So, you just stay there and you're stuck with them. Uh it's the same thing for models, you know, you see people talking about why, you know, there there are Who knows? Um today it

[26:51] costs $200 a month for an unlimited plan, tomorrow it might be two 2,000. We don't know. We don't know how how what's going to happen and the future, uh, you know, having choice in the future is very important for the integrity, for

[27:05] the sustainability of any business because that's your data. Um, that's you what you want to be able to do with it. I don't know, some of these models have restrictions on what you're even able to ask them. So, um, governments have top-down mandates on

[27:20] what they're allowed to do with the models or not. So, you know, we saw models get pulled back after people started using them for a couple days. So, like, um, you're building your businesses on top of these tools, you should be you should

[27:32] have flexibility and freedom and control of these tools, basically. >> Yeah, and I think the big insight of all of this is a lot of us haven't realized how much of a content uh, hub Slack and products like that have become to us. And that and we're

[27:52] we're learning that if you want to get the best out of any of these models, you need to have the most amount of context possible. So, what's really cool about Buzz is it's basically like, okay, we recognize that this is

[28:05] uh, your con- your context foundation. And we're going to go help you do a bunch like we're going to help you pivot into a bunch of directions. You want to, you know, have these projects that, you know, are integrated GitHub, we can go

[28:19] do that. If you want to do local stuff and do shared compute, we can help you do that. You know, etc. etc. You want to huddle an agent, we can help you do that. But it, you know, what's so cool about it is whatever you decide to do, the context

[28:36] is at the core of it. >> Yep. Yep, exactly. And that's what I like about it. That's what I think is really cool is that, um, I think they really hit on something here. so you know, I think um, we'll see. It could go like I saw people commenting

[28:52] open claw, you know, nobody's talking about open claw anymore. Open claw was a real wow moment and like okay, we can get these agents to do a lot of productive work for us. I have the feeling that it was missing something and this shared context

[29:08] because we're working in teams, we're working with other people. Teams might even just mean your other agents, right? Like you just you you're going to have conversations whether it's with one agent or another, but now you

[29:21] have the ability to expand that the the the like your team set expand your you know, your global context window so to speak and then make it globally available to everyone in your team including the agents. So yeah, I think it's super cool.

[29:39] >> All right, setting up and managing your agents or is there any sauce here? Is there anything people need to know besides what you've already shared? >> I would I wouldn't say so. I've seen it depends on how how deep in the weeds you

[29:52] like to go. My honest opinion would be you probably don't need to do that much. All I did the first thing I did was just I wanted one that's fable. I'm using specifically or exclusively I'm using Claude code as the harness under here,

[30:10] but they have adapters so you can adapt you know, you could even adapt open claw or Hermes or open claw I'm sorry open code or goose. So like any of these harnesses can be added under under the surface here under the hood. But the

[30:25] first thing I did was I just pinned them to models. So Fizz is a fable model and honey is sonnet because there is a certain tasks that I don't need to use the power of fable and burn through tokens so fast. So that would be like my

[30:38] main piece of advice. Besides that just start playing around. Um I made this chief agent officer. So, like if I do start to um create more agents with more specific um kind of uh um instructions and and system prompts, then I might delegate the

[30:57] delegate the delegation to Mr. Chief Agent Officer here and be like, "Okay, I have this task. Who's the best for it?" Because, you know, you might have a copywriter, um you might have a brainstormer, you might have a code

[31:08] reviewer, things like that. And um you might forget who they are or I don't know. You just get an agent to kind of delegate. So, um that would be pretty much my only advice on the on that on that side there. >> Cool. Anything else you want to show?

[31:23] >> People were asking in uh Twitter about um skills, and I think I mentioned it already, but like all the stuff under the surface that you're used to using, if you use Claude Code or something, that's all available as long as it's um

[31:33] to Buzz your Buzz Buzz agents, as long as it's uh globally installed. So, skills and things like that um yeah, they can use in the and they can uh take advantage of. So, you don't lose that stuff. So, that's also very nice. And um

[31:47] I would say that like this is beta software. It's like I it might even be alpha. I'm not sure. It's like early preview software. So, some things don't work that great. Um I was trying to create workflows, and um you know, like

[32:00] set up recurring tasks and things like that. And um they weren't really landing great. Um that was one thing I noticed. Another thing I noticed was uh things can be kind of slow if you're used to it being like uh working directly in Claude Code

[32:15] or in um a CodeX. It seems to be a bit faster there, and I think it's because it's uh communicating with your your server, your relay, and and communicating back. Um and um because of that, I I think it's at the point now where it's like um

[32:32] really good for, like I said, solopreneurs, small teams, iterating on on small software um or small ideas and um uh if you're really doing like um you know complex software engineering, this might not be the tool that you want to

[32:48] use. But um if you're just looking for something that can bring you value and uh like I said, bring all this stuff all your knowledge into one central uh one central tool, then this is definitely a great uh a great thing to

[33:02] use. >> So, if you're a founder, um small team, maybe you know, one to 10 under 10 million dollars in revenue, zero to 10 million dollars in revenue, like should should you use this thing? Maybe you're using Slack today, should you download

[33:19] Buzz and actually try it out? >> So, um I'm pretty convinced that like I'm trying to convince my team uh at Wasp that uh we use this internally and exactly for that reason. So, um we are a a small company, a small startup, and um

[33:40] uh we're we're a a a developer tool, so we're a software company. And like you have all this stuff that you talk about in Discord, we talk about in Discord, and um we have our community there, too. So, um that's one interest like one

[33:52] thing I should mention is that you can create channels that are private and public, right? So, you could invite people from your community using your product to come chat with you. And then you have private channels just for your

[34:03] team, and then that context is shared, which is also a huge thing because if someone comes into into your chat and says, "Hey, we want to get this fixed," then fixing it with an agent is just a you know, an at away, right? You would just

[34:18] tell Fizz, "Like let's tackle this bug." Like whoever just you know, uh did a bug report or said, you know, wanted a feature, you could just have them prototype it right there. So, um yeah, I I think for um small teams,

[34:33] um this is definitely worth checking out. >> So, my take on my take on this is this is so cool. It's clearly you know, scratching the surface around what the future of work would look like in an age in a in a world where

[34:51] you have more agent employees than teammates. Um it does feel early. It does feel like they're they're just, you know, like I said, scratching the surface. But, you know, my passion is I I don't know if you know this about me, Vinnie,

[35:07] but I'm a co-founder of a in a company called LCA, Late Checkout Agency. And that business designs like the world's biggest AI native software. Not Buzz, but like you know, companies like that. Um and when I see something

[35:22] like this, I'm I'm just like it's close. It's not there yet, um but it's close and I do believe that uh it's probably worth and I have no affiliation with Buzz or Block or or Jack Dorsey, but I do think it's like worth trying these tools just so you can

[35:40] you might learn a thing or two and then even if you don't end up using Buzz, like you might just end up you know, configuring Slack in a way that you know, is best for you and you learn something here. So, I think or you might realize like you love Buzz

[35:56] and forget about Slack and this is what the world you want to live in. Regardless, you you're going to learn. There is no losing in this situation. So, I think um the most important thing we can one of the most important things that we can do

[36:12] in the AI age and the agentic era is just getting our hands dirty, learning how these tools work, playing with them, and seeing how we could live in the future cuz the people that live in the future, Vinnie, those as you know, those

[36:24] are the people that uh could you know, look around the corner Um and who can create products that people really want and you know I think that's really important. >> Yeah and um Yeah you bring up a really good point and and I think that's why

[36:42] they're they're kind of looking around the corner with this already and what I think could allow them to really be a strong player in this arena is um the fact that it's open source. Um so anybody you know that has an idea of how to so it's an

[36:59] open source app built on an open protocol um and so anyone who has an idea of how to improve this can and um you know that that might take it in the direction because the the you know the the hive's mind so to speak is like

[37:16] going to be using this thing and working on it at the same time so they'll be like okay this isn't working for me. Uh I like this about like you said trying out some from some other tool or I like this about the tool I usually use I'm

[37:27] going to add that in here or what not so um that might work to their advantage very well and it might become the tool that people just kind of default to um but things change so fast so who the hell knows. >> Amen brother. Vinny thank you so much

[37:43] for coming on giving us a tour sharing some sauce. I'll include links in the show notes in the description where you can follow uh Vinny for more of this sort of stuff. Um I would love to have you back on the podcast Vinny the comment section on

[38:00] YouTube please let let me know if you enjoyed Vinny I certainly did uh if you enjoyed this topic what you want me to cover next. Um thank you so much Vinny uh any last words for the people? >> Well if if they want me to come back I

[38:14] can show them some sweet stuff about how you can like uh use the open protocol that it's Buzz is built on so you can go pretty deep um and I think there's some pretty powerful stuff there that um we both alluded to in our tweets. So,

[38:27] um yeah, it's worth worth checking out. >> Cool. Yeah, let us know. And uh we we live to serve. So, uh if if that's what people want, we can go deeper. Thank you, Vinnie. Have a creative day, everyone, and I'll see you next time.
