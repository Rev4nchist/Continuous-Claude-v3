---
video_id: Kz4QJmNrVXU
title: "Velocity Sickness: What Happens When Your Whole Team Gets 10x Faster — Matt Dailey, Ref."
channel: "AI Engineer"
channel_id: UCLKPca3kwwd-B59HNr-_lvA
channel_slug: ai-engineer
url: "https://www.youtube.com/watch?v=Kz4QJmNrVXU"
upload_date: 2026-08-09
duration_s: 1237
duration: 20:37
view_count: 2163
like_count: 55
subtitle_lang: en-orig
transcript_source: auto
transcript_words: 3867
ingested_at: 2026-08-10T12:16:22.565Z
ingest_version: 1
---

# Velocity Sickness: What Happens When Your Whole Team Gets 10x Faster — Matt Dailey, Ref.
**Channel:** AI Engineer · **Uploaded:** 2026-08-09 · **Duration:** 20:37 · **Views:** 2,163  
**Watch:** https://www.youtube.com/watch?v=Kz4QJmNrVXU

## Description

A newsletter writer walked Matt Dailey through an agentic pipeline good enough to amplify their own voice instead of flattening it, then mentioned they were now effectively writing a book every week. Dailey asked whether the audience was reading a book every week. They were not. Those pages go unread, and that gap is what he calls velocity sickness: the stress of a sudden output increase that delivers output without impact. On engineering teams it arrives as too many pull requests to merge, work sprinting in too many directions at once, and the ritual of declaring agent bankruptcy, walking back to twelve terminals the next morning, recognizing none of it, throwing all of it out and paying for the same work twice.

The failure that actually worries him is critical decisions getting made by agents, because an engineer who lets that happen has stopped owning the code, and a team doing it at scale no longer owns the product. His fix is to separate the decision layer from the implementation layer and give the decision layer its own primitive: a document rather than a chat. Chats are isolated, ephemeral and built for implementation, so the decisions made inside one evaporate while only the code survives. A durable shared doc holds the state and the agent supplies the action, which keeps agents effectively stateless, lets several start from identical context, and turns rebuilding your own understanding into rereading a file. The tell that it is working, he says, is people writing plans they never implement, which is what prioritizing looks like once idea velocity replaces code velocity. Three things to try immediately: notice which gear you are in, treat the plan as a portal into the system rather than a prompt, and hand a plan to a teammate before you hand it to an agent.

Speaker info:
- https://www.linkedin.com/in/matthewjdailey
- https://ref.tools/

## Transcript

[0:12] Thank you so much for coming later in the week here. Uh I'm Matt. I'm the CEO and founder of Ref. The problem we work on at Ref is one you might be familiar with where individual engineers are going really fast with AI,

[0:27] but the team as a whole is not. And we're working to help close that gap. What I'm going to be talking about today is that is what happens when your whole team gets 10 times faster. All the things that don't go well. And my goal is to give you a blueprint

[0:43] for how to get get through those issues. Uh and have the whole team move faster together. The way I want to accomplish that is first talk about those issues, define some terms. Then we'll talk about how did we get here?

[1:00] Where are we at now? Um and we'll use that to triangulate on some solutions. We'll start high level and we'll work down to get more and more practical until we leave with a couple of things you can leave here and do immediately.

[1:12] Um how's that sound? I need thumbs up. All right, awesome. Great, that was great. Uh All right, so let's get into it. These are some of the problems you might be experiencing right now. Uh these are these are problems that

[1:26] affect individuals and are actually magnified at the team level once the entire team starts experiencing them. The first one, too many PRs to merge. This is the like classic first problem you hit when you start adopting AI as an engineer. You're

[1:41] like, "Great, I'm shipping stuff." And you push up those PRs and you're like, "There's no way I can merge all these." Uh and this is obviously magnified when the whole team does this. Merge conflicts, merge queue breaks

[1:52] down, things get bad. The second problem is that you're moving in many directions at once. This is also both individual and a team problem. Individually, this is where you have a bunch of agents doing different things. You're trying to remember who's

[2:06] doing what and your brain gets fried. At the organizational level, this is your engineers picking up things and running in a certain direction. Another engineer is running over here. Maybe some are bumping into each other

[2:18] and you're you're not moving cohesively with focus because you're just sprinting in all sorts of directions. The third problem you might be experiencing is declaring agent bankruptcy. This is a a common pattern I see engineers get into where

[2:33] you know, you're cranking. You have like your 12 terminals open. You're like at the end of the day you're like, "Yeah, I did a lot of work." You step away from your laptop. Uh spend time with your friends and family. Next morning you come back and it's like

[2:44] walking into just a room of strangers. Like, who are these people? What are they doing here? But like no problem. They're agents so you just like get rid of them and start over again. The problem though is you know, it feels

[2:58] like you're doing a lot of work but you're doing the same work and you're spending tokens twice. You're doing the same problems over over again. And if you think about that organizationally, that's your team not being efficient with both their time and

[3:11] their their token resources. Problem four though is actually the most important one. It's critical decisions being made by agents. Once you have agents doing a lot of your work, if if you as an engineer are letting an agent make a critical decision, you are

[3:30] seeding control of your code. You are no longer the owner of that code. The agent is. And if you imagine that at scale at your company, if the engineers across your team are you know, giving up ownership of the code, you no longer own the

[3:42] product. These are a bunch of problems you might be experiencing at different degrees at different days. Uh The way I like bundle it up is into this term velocity sickness. This is uh the stress caused by sudden output increases thanks to AI. Um it affects

[4:02] individuals or teams. Um and the result is output without impact. So, this is that feeling of like we're moving really fast. This should feel great. This should feel awesome, but for some reason it doesn't feel awesome. We're not having the like the

[4:18] things you expect to be happening are not happening. Um despite this feeling of being so productive. So, that's to define that term, but I want to tell uh a little story. Uh my talk is happening now. Uh I want to tell a little story

[4:38] about somebody like to make this very real. Um This is a story about somebody uh who's actually not an engineer, but I think it parallels our engineering workflows a lot. I Part of my job is I get to go, find, and talk to people who are really

[4:53] pushing the forefront and try and learn from them. And I love that part of it. And so, this is somebody and I'm I'm talking through their identical workflows. Um and this is somebody who writes a newsletter, and their workflow is around how do I I have

[5:05] my ideas and then they're doing research and exploration and then uh like cohesion between those ideas and editorial to make sure it's in their voice. And they're they're walking me through their system for how they they

[5:17] manage this whole pipeline um and really scale out their their efficacy. And this is like very very much not slop. This is somebody who has is using agents to amplify their own voice uh in a way that's like very impressive. I'm like, "Wow, that's that

[5:30] is so cool. I'm I'm like I'm soaking it in." Uh And then they're like, "Yeah, I'm basically writing a book every week." And I'm like, "Oh, okay. Is like is your audience reading a book every week?" And they're like, "No, they're probably

[5:45] not." Right? They're not. They're they're This is a person who's writing a lot, but those pages that they're writing are going unread. Um I think that's part of this experience of velocity sickness is we're we're building things that are not

[6:00] mattering for the people we want them to matter for, the people we're trying to reach. Uh So, what we Instead of unread pages, um what we want is we want to write words that matter. We want to write words that connect with people.

[6:12] Um and the parallel to us as like software builders and product builders is is that we want to write we want to build products that connect with people. We want We want to build products that change the way people live and work and

[6:24] make their lives better. And we have more ability to do that than ever with AI. But we have this like feeling of velocity sickness where we're It feels like we should be doing that, but it's not quite landing. So, let's talk about how we got here.

[6:38] Um This is what the software engineering process used to look like before AI. We'd do some planning up front. We'd sit down and build. We'd implement. It'd be It'd be iterative. We'd be exploring. But largely we're sitting

[6:49] down building in isolation, implementing something. And at the end we sort of polish it up and ship it out the door. And this was great. We all knew how to do this. We had a lot of systems for this. Uh And it was good. And then AI came along.

[7:01] Um But at this time our our tools were built for this. Like all all our history of coding tools were built for this style of work. Um our IDE, our workhorse, um it was built for implementation and polish to be done by an individual, to be heads

[7:18] down building as a software engineer writing code. Um That's what That's a tool built for how we used to work. Um so, let's look at how how we work now. Our work looks a lot more like this. Where you do some planning up front. You

[7:34] start thinking about what am I trying to do here? You take this idea in your head and start to flesh it out. Um At some point an agent takes that idea and like implements it. This is like arguably should not even be on this

[7:46] slide cuz it's not our human work anymore. It's done by the agent. Um and then in the end we do some polishing where we take back that thing the agent has made for us and we like hold it in our hands and we say, is this is this

[7:58] what I wanted? Um This is a very different shape of work. Right? We're no longer doing this like heads down building. These are the two uh creative and collaborative parts of our work as engineers. This is where we like

[8:13] express our craft as an engineer. And the one that's most different is the the planning stage. So, I want to zoom in on that just a little bit. Uh that's the like exploratory, creative, collaborative part where we're we're thinking about like I have this

[8:27] vague idea. I have this complex system. I need to understand the contours of this system, apply this idea, and like really understand it. And I need to pull out what's relevant and express my taste as an engineer. As to like, where do I

[8:41] want this system to go? Um This is the kind of work that uh that's creative and and needs to be done together. I think the the shape of engineering teams and product teams is changing with AI. But we're always going to have this

[8:54] thing where we have a group of people responsible for managing a complex system and it's sort of deciding the future of that system. And that's this planning work. And so, we're we're starting to see some of the hints of like, okay, we had tools built for a

[9:07] certain type of work. Our work looks different now. Um Let's start to see think about that a little bit more. So, uh we used to have the IDE as our main tool. It was used for implementation. But now we're doing this different kind

[9:21] of work. So, at the very high level, we can start to think about solutions like, okay, we have a tool built for this type of work. We have a new type of work. Let's think about you know, what this new layer of our work is. This This is the decision

[9:32] layer. This is where we're thinking through what are the key decisions, doing that like craft of engineering, um and expressing our taste as engineers, ultimately a different thing than implementation. And it it's a different gear as an engineer.

[9:46] The skill now is what gear am I in? Am I using the appropriate tools for the gear that I'm what I'm trying to accomplish right now. So let's think about what a tool built for the decision layer would look like. It'd be a tool built for docs

[10:03] and not chat. And there's that's like a short sentence. There's a lot to unpack here though. So I'm going to spend a lot of time on this slide. The problem with chats is that they are the relic of building for implementation. So they're

[10:18] they're default isolated and ephemeral and and brain off. They're they're made to build things and get stuff done. And that's not really the same type of work we're doing at the decision layer. We're doing this creative exploratory work. So being in

[10:33] this isolated environment where I'm working with an agent, maybe I start with my vague idea and I'm exploring it and asking questions, but decisions are being made in that like that chat that are are not shared with my team

[10:45] that are going to disappear as as long I'm going to result in some code being output where those important decisions are not being made clear and shared with the team. And you're also in this mode where the agent saying

[10:58] Okay, this is what I want to do. Is is that okay? Let's go. Or or sometimes it'll say it'll ask you a question and it'll be like you know, this is the recommended option and then you're like, great. I don't even think about this. I'll just hit

[11:08] that one and we keep going. Docs start to solve this problem. So when you're if you center your work around working in docs they're meant to be bring forward the key decisions. This is this is what our work is now. Our work now is

[11:27] figure out what decisions matter and then make those decisions and then get out of the way while the agents fill in the rest. Working in Docs is the the classic way we would create alignment. If you were If you think back to being a

[11:41] manager or a lead on a team before AI, if your team was having struggling with alignment, you would not tell them like, "Let's go all work in Slack DMs. Let's like go direct message each other." You'd say, "Let's like bring forward key decisions, align

[11:54] on them, spend time on these, like find a way that we can really spend time getting our decisions right." So, there are two things you might be thinking looking at this that are not what I'm talking about here. The first

[12:09] one is plan mode. That's a great tool. The other one is like full-on factory spectrum and development. That's a great tool, too. I'm talking about something in the middle. Plan mode is great, but it's largely a a rich chat message where the agent is

[12:26] saying, "Hey, here's a like better visualization of what I'm trying to express to you." Yeah, that's great. But it's still in this isolated ephemeral environment. And what I'm suggesting is something more more durable, more shared, more long-lived that you

[12:39] and your team are spending time on. Similarly, the spectrum and development where we just define the behaviors, we operate at the like product level, is a little far away from the engineering reality. The engineering reality is that I need

[12:53] to understand my system and have a tool that like helps me understand that system and lay out those key decisions in a in a technical sense. The way I like to conceptualize this is as the portal to the software system, where you are like

[13:07] Tony Stark and you're like, "Show me what matters." And you're like, "I'm working on this. Pull out the bits that are relevant." And AI is amazing at finding things that are related to other things, helping you find what's what's

[13:16] relevant and lay them out on the table in front of you. Organize the pieces in the way you want to represent how you want the system to grow. But the big conceptual flip here is actually that we're pulling out the state. So, when you're living and

[13:32] working in a a long-lived session with an agent, there's this implicit context being built up like over that work, and that's great. Um But there's you're also doing actions and it's it's not shared. What you want is to separate the

[13:47] the agent as the action and the doc as the state. And so, you can spawn new agents that have the same context or starting from the same place that are able to collaborate and work on the same same piece of context and state. You're

[14:01] ultimately doing context engineering in this doc, so that every agent is largely stateless and starts from this place um the same place. And what that gives you is your team and yourself can look into this and understand

[14:14] what actually is in here. What are the decisions that are being made um and have a a clear understanding of what the key decisions are. So, this is a a different way of working where your your core atom of your work is a doc rather than a chat. Um

[14:30] What happens when you actually start to implement this? Well, the first thing we see happen actually is that people start to plan and then not implement their plan. Uh and this is actually like a really good sign. Because what that means is they're

[14:44] thinking through ideas. They're saying, "I have this idea. Let me explore it. Let me start to flesh it out. Like I have this vague thought. Don't just give me some code. Don't go off and like build it for me, but let me help help me

[14:53] understand the idea that I'm talking about. Um And then they have a bunch of these and then some of them are getting built and some of them aren't. So, that means they're prioritizing the ideas that after they've explored them

[15:06] are the ones that are worth building and and going in this to the next step with. Um One way I like to frame this is that you're you're shifting from code velocity to idea velocity. So, going back to our our problem statement like how are we

[15:21] dealing with velocity sickness? The velocity sickness is we're shipping too much code that's not going anywhere. The solution is to shift that velocity to ideas so that rather than you know, getting stuck in prototype gravity where we we build something and

[15:37] we're so excited to just ship that thing and we're going down like one path of the idea maze, we can now like more more effectively explore that whole maze and find that gold that's around the corner. Um and and really impact the people we're trying to help.

[15:54] Um So, let's go back. Here are those problems, those velocity sickness problems I talked about the beginning. Let's see how this starts to address those. First, too many PRs. We've moved the the review point earlier into the process. So, we're aligning on

[16:11] the key decisions up front. That means the code review is easier because the hardest part of any code review is, you know, what actually matters here. That's the first step is like, "Hmm, what do I care about here?" If you move that earlier, we've aligned

[16:23] on that, the code review becomes much simpler. Number two, moving in too many directions. Again, we're aligning early as a team and individually, I'm like understanding what I'm working on across many agents. If I'm working on a large

[16:37] thing, I've I've understood it initially. So, as a team, we're sharing these plans and we're aligning. This is what we're trying to build and it's easy before someone has spent even a day in AI going deep on some idea building a prototype, we can talk about

[16:50] it early and make sure we're aligned on where we actually taking the system. Um declaring agent bankruptcy is just not a thing because you've made your agent stateless. So, the result of their work is in the stock. If you need to rebuild your human

[17:02] context, you just read the doc. Now, you understand the state of this project and you can pick up from there. And the most important one, humans own the decisions. Like, that's what we're solving for. Humans need to own the decisions.

[17:18] That's how we retain ownership of our software and our products and make it like a true expression of what we're trying to create in the world. There are also some other benefits. So, when you have this state extracted and

[17:34] you're working from a shared context, you get more parallel agents. It's easier to work with parallel agents. Uh you get this durable decision log. So, something uh that's really powerful. I think a lot of people are thinking

[17:44] about how do we capture all the decisions going into these sessions? A really great solution to that is let's pull out all the decisions up front and agree to them and put them in a place that's durable so that we don't have to

[17:56] have like some LLM summarizing it and maybe picking the wrong things later on. We want to bring that forward so we can save it and refer to it later. Um and then my favorite one um is actually more collaboration. Like this process, we want we're doing more

[18:13] work that is creative, which means we should be collaborating more as engineers. I think the future of engineering is multiplayer. It's going to be multi multiplayer by default sooner than we think. Um and it's more important than ever

[18:27] because we're in this moment with AI where everything's moving faster than ever. There's a pressure like everyone's company feels existential, small or big. You need to deliver. And the way we get through that as humans is by working

[18:38] together. And we need tools that help us do that. So, here are three concrete things you can leave this room and do right now. The first one is to think of your work in terms of planning and polish. So, recognizing that there are two gears

[18:54] I'm working in. There's no longer this one focus of implementation. There's uh plan and then polish. Um and notice when you're in a single session and you're doing both of these in one session. Notice when you drift from the

[19:08] planning phase into the polish phase and is your tool serving you for what you're trying to do at that moment? Uh number two is to start to treat your plan as a portal to the software system. So, really treating it as this powerful,

[19:22] malleable tool to say like, what matters to to me for what I'm working on right now? Um and asking it to show that to you so that you can make the best decisions possible. And number three is share a plan. Like, don't just

[19:37] you know, write the plan, give it to your agent, and have them implement it. Give it to someone on your team. This is like, I feel like very unnatural for a lot of people. We always we we think we know what's going on. But, it's always valuable. You have

[19:50] smart teammates. They have great context in their heads. You should tap into that. They will give you good feedback. Uh it's a really valuable thing to do. That's my talk. I'm Matt. Um I'm the CEO of Ref. If you want to talk about any of

[20:02] this stuff, this has all my like connection information. Ref is a tool built for the decision layer. Uh we work with all of your existing implementation tools. Um if you want to see a demo, come you can come by our booth or just see me out

[20:15] there. Uh and I'd love to talk about this stuff, so come say hi. Thanks.
