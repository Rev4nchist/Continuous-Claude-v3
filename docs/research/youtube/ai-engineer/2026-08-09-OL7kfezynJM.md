---
video_id: OL7kfezynJM
title: "Multiplayer agentic engineering — Arjun Singh, Superconductor"
channel: "AI Engineer"
channel_id: UCLKPca3kwwd-B59HNr-_lvA
channel_slug: ai-engineer
url: "https://www.youtube.com/watch?v=OL7kfezynJM"
upload_date: 2026-08-09
duration_s: 1124
duration: 18:44
view_count: 1832
like_count: 36
subtitle_lang: en-orig
transcript_source: auto
transcript_words: 3905
ingested_at: 2026-08-10T12:16:22.527Z
ingest_version: 1
---

# Multiplayer agentic engineering — Arjun Singh, Superconductor
**Channel:** AI Engineer · **Uploaded:** 2026-08-09 · **Duration:** 18:44 · **Views:** 1,832  
**Watch:** https://www.youtube.com/watch?v=OL7kfezynJM

## Description

Superconductor left a meeting bot sitting in a Google Meet at their expo booth for four hours, just listening. Someone passing through said they wanted coding agents to have clear acceptance criteria before declaring work finished. Nobody filed a ticket. The bot picked the idea out of the conversation, opened one itself, started working, and added two acceptance criteria fields to the product's own ticket form, then produced a screenshot when asked. Arjun Singh is not pretending that change ships as written. The claim is narrower and more useful: every customer call, onboarding session and team meeting now yields dozens of prototyped ideas and usually a few genuinely shippable pull requests, with nobody hand carrying a request from one system into another.

Most of the talk is what has to be true underneath. One agent session has to be reachable from Slack, the desktop app and GitHub at once, so reviewing a teammate's work means asking the agent inside the thread instead of waiting for the author to wake up. The work runs in an isolated cloud environment, and Singh argues the real reason is not closing your laptop, it is least privilege. An agent told to wipe the staging database, resourceful and eager to comply, can find a token on a developer's machine that happens to point at production. A configurable network sandbox blocks exfiltration and asks before reaching anywhere new, and that same isolation is what lets support and growth people trigger real work without a development environment. Rather than trusting public benchmarks, they replay pull requests that represent good work from their own repository and plot quality against cost and time, because SWE bench is Python and they are Ruby on Rails. Their numbers for one month: 10.5 billion tokens, 3,300 Claude Code runs worth about $10,000 in token value, and Codex running four times as many sessions for less money.

Speaker info:
- https://x.com/singharjun51293
- https://www.linkedin.com/in/arjun-singh-629216105

## Transcript

[0:01] [music] >> All right. Hey everyone, I'm Arjun Singh. Today I'm going to talk to you about multiplayer agentic engineering or how to enable your whole team and your best agents to work together. If you go to the talks or go around the

[0:23] expo, you're going to see that a lot of people are talking about putting the agents at the center of everything. Makes sense, they're really powerful, they're really cool. But you don't see a lot of people talking about the people. Like this is

[0:32] all for us to make us our lives better, our more our more productive, whatever. And so we're going to really focus on how the people fit into these agentic workflows. Just a little bit about us first. So our team has worked together building

[0:46] software for over a decade. Um my co-founder Sergey and I, we met in the PhD program at Berkeley. I worked on robotics, he worked on computer vision. And during that we co-founded a company called GradeScope. Some of you may have

[0:57] used it. It's used by millions of students worldwide at thousands of universities, helping instructors grade their students' work. And um pretty much the entire team working on Superconductor used to work together on GradeScope. And so we've had

[1:10] a team that's worked together productively from first user to acquisition, working on something new together again. And I think it's kind of an interesting experiment because you know, over the past year we've very aggressively integrated agents in our

[1:21] workflows and we've kind of surfaced all the different bottlenecks and friction points that come up and how to do that productively and keep collaborating the way we used to but with the new power of agents. So today I'm going to talk to you about

[1:32] how, you know, we we the lessons we learned from kind of solving those friction points and solving those bottlenecks. And in the talk description I mentioned five lessons and I'm going to be an engineer and start from zero and add a

[1:42] sixth one in there. Um the first one I'm going to start with is just to be model and harness agnostic. So there's a few reasons for that. The best model and harness can change weekly. It could change cuz a new one comes out.

[1:55] It could change cuz the best one got taken away. Um things happen and you don't want that to disrupt your entire team's flow. The other thing is that open weight models are actually pretty good now. We've been really happy with GLM 5.2.

[2:09] They're much cheaper. Um and you want to be able to kind of explore with them and integrate them without again having to change your entire workflow. The last thing I'll mention on this is that the incentives of the people

[2:19] selling you tokens aren't really aligned with yours. You're here for a reason. You're you're you're So you're doing things for a reason. You're trying to make your customers' lives better, make your product better, delight your

[2:28] customers. They want to sell you more tokens. And you might be happy to pay for as many tokens as it takes, but you don't want to pay for more than that. And so again, kind of being able to switch between things lets you stay in

[2:40] control of all of that. And so, um you know, as I go through the talk, I'll mention a couple of places where our product makes it easy for us, but whether you use us or not, I'm just going to leave things with you that I

[2:51] think are really important um for you to be able to work collaboratively effectively. So, the next one is to turn every human interface into an agent and human interface. So, you know, typically when people are working with coding agents, they're on

[3:06] their laptop, kind of stuck on that laptop. Nobody else can talk to that agent. So, the first place people go to kind of expose more interfaces for them is Slack. Cloud has a Slack bot. Coda has a Slack bot. We have a Slack bot. It's

[3:20] really cool. You can say, "Hey, Coda bot, do XYZ." It does it. Somebody else can talk to it. But it's not enough. Cuz now we've taken it from trapped on somebody's laptop to kind of trapped in Slack. And a lot of work happened in Slack, so

[3:31] that's better than than than nothing, but certainly not all work happens in Slack. So, what we really wanted was to be able to work with the same session from every relevant interface. Could be Slack, could be our app, could be GitHub, could

[3:44] be elsewhere. And so, one possible flow is you start and collaborate on a session in Slack. And then maybe you continue in a kind of more engineer-focused environment in the desktop app or the mobile app. And then, you can finish it up in

[3:57] GitHub. And the important thing here is the exact same agent session. So, it's like the agent didn't forget what you did in one place in Slack when you go and talk to it from GitHub, it's the same session. It's got the same context.

[4:10] And the second lesson builds on top of that, which is to make the agent work visible and collaborative across the team. And so, obviously Slack makes it more collaborative. Um But here, we've got that kind of app view. And you know, Sergey made this

[4:24] ticket. I've been talking to the same ticket. Our growth person hopped in as well. So, you can kind of see at the top here all the different people that interacted with this. So, I can see who's getting notified about this

[4:33] session, who's seen it. Um that's especially important when you have work triggered by non-technical people. Right? So, it's like, you know, our customer support person created a ticket. It's working really well. I want

[4:43] to understand like has this been vetted by an engineer or not? You can kind of see who's involved really easily. And then, if I'm reviewing something, I can just pop in and say like, "Hey, why did you do it this way?" And again,

[4:53] because it's the same agent session, I don't need to wait for Sergey to kind of get my notification on GitHub and respond to me. The answer to the question is almost certainly in this thread. I don't also don't want to read the

[5:04] entire thread. So, I can just ask ask the agent. Or how we most often kind of make the work visible is with artifacts. So, it doesn't matter where the work started or where it's finishing, the agent can show you the work it's doing

[5:19] as screenshot or video or other. And you can see it from everywhere. So, again, you don't have to worry about like, "Oh, where is that thing? I got to go to GitHub to see the image or got to go to Slack to see the image." It's just

[5:28] everywhere. Work is visible everywhere. Collaborate from anywhere. The third lesson >> [clears throat] >> um I'm going to talk about here is to turn every external signal into code that your team can quickly evaluate. And I I to show this live, but the Wi-Fi

[5:47] is not quite there. So, I'm going to show you something from yesterday. But, what do I mean by external signal? So, it could be Slack conversation, could be a meeting you have with a customer, an onboarding call, a sales

[5:58] call. Could be an internal team meeting, could be something from Sentry or bug tracker, a bug report from a customer, an email, feature request. And right now what's happening is like all that stuff is already exists. It's

[6:09] in all those different systems. People hook them together with MCPs. So, now your coding agent can check the email or check Notion or whatever it might be. But, like how do you how how does it know what to work on, right? It's like it's still

[6:20] kind of stuck everywhere. And so, like some humans are involved in like kind of taking stuff from one place and telling it solve email number 48 or ticket number 6,000. But, that's still a lot of coordination. And so, what we do is we we have several

[6:35] different ways to automatically ingest these signals, prioritize what to what to do with it and and kind of act on them. And my favorite one, the most fun one, is what we call our meeting bot. And so, I'm going to switch switch over

[6:47] to my browser here for a second. And uh Okay. So, we've got a booth at the expo and we had the meeting bot running all day yesterday. So, this is a 4-hour meeting of a Google Meet. You just kind of invite the bot to Meet or Zoom or Teams

[7:02] or whatever it might be. And it listens all day. And it created all sorts of stuff as it was listening. If it finds existing work, it'll link to it. All right? So, it's not going to just like create new work if it's something already working on. Some of

[7:16] this is, you know, people testing the meeting bot out and telling it to do some weird things, um or interesting things, or just creative ideas. But, a lot of it's actually just like really good ideas that come out of people

[7:26] looking at what we're doing, asking questions, having new ideas of what to do with it. And so, it's kind of nice cuz the last idea that was here was someone saying, "Hey, like when I work with coding agents, I want to make sure that

[7:36] the agent has clear criteria to evaluate whether it did a good job on the work before it tells me that it's done. And um so they had that idea, the bot just picked up on it. None of us did anything manually. It created this ticket

[7:51] and started working on it. And then I was able to just say, "Hey, take a screenshot of what what you did." And here's that screenshot. And it kind of modified our ticket form to add these two new fields of acceptance criteria.

[8:03] Now, I'm going to Am I going to ship this one exactly how it is? Like, no, probably not. But it's a new idea, it's concrete, I can play with it, I can go and actually like use the live preview and like see if this improves

[8:12] performance. And so it takes like this you know, you know, your hundreds or thousands of ideas that are everywhere and it helps you kind of move with the speed of what your customers are asking you for and what they're thinking.

[8:22] And um it's really fun because every time we have an onboarding your customer call or or team meeting, we almost always have dozens of new ideas that are prototyped, but more importantly, at least a few shippable PRs with a very minimal

[8:36] intervention. So we talk, stuff comes out, we look at it, we ship it. It's so much fun. Put this back. So the next thing I'm going to mention is that, you know, the these three things that I've talked to you about really rely

[8:55] on having your workflow, your code base, your project set up to work in an isolated cloud environment. So that way the agents aren't trapped on an individual's machine. So there's several reasons why this is important. So

[9:13] the first one is to eliminate what some people are calling lid anxiety. You want to be able to close your laptop. You've probably seen people running around the office with their laptops open while stuff is working or at the airport or

[9:22] you know, there's some posts on Twitter or whatever about um you know, like people having their laptop tethered to their phone in their cars as they're driving home. This was actually probably the impetus for for me and for a few people on our

[9:33] team to even start working on this. You You last year I started working on Cloud code with cloud code a lot. I had a I think at the time like 6-month-old. I like didn't want to like be tied to my laptop or have that stress. I was like, I I don't I I don't

[9:46] ever want to think about whether I can like step away from a laptop or not. And so, we moved everything to the cloud. Things are working always. It eliminated that problem for us that people have been talking about for the

[9:57] past year. It's really helpful. It's important to me. But I don't think that's the most important reason to do this. I think the most important reason to do this actually was was touched on in the previous talk, if you were here for it.

[10:12] I think you should only give your access give your agents access to only what they need. Right? So, if you think about what's happening, you have a bunch of developers with these agents running on their laptop. Their laptops, unless you have like

[10:25] impeccable hygiene, probably have a bunch of stuff on it that you don't want the LLMs or agents to have access to. And yeah, like everybody's working on these sandboxes and approval flows. And so, you but but but really you're in one

[10:36] of two camps. You're either approving a bunch of stuff or you're hoping that your auto approval flow or your YOLO mode or whatever is configured properly and your sandbox is configured properly and doesn't read a bunch of stuff on your laptop that it

[10:47] shouldn't have. And, you know, as as the previous talk mentioned, like these agents are getting more autonomous. They're getting really resourceful. They They're trying to please you and do what you said. And so, when you say, "Hey, you know, wipe this

[10:59] agent database." and it finds a token on your laptop that it can use and it thinks it's working with staging, but actually it's production and now it just deleted everything. I'm not trying to say this is happening constantly, but it

[11:09] still happens. And for us, the peace of mind of just like letting anybody run with these experiments and ideas and prototypes and and and real code without having to worry about this is is is is really worthwhile. To go one step further on that, um it's

[11:26] not just, "Hey, make sure they don't have the credentials that they shouldn't have." It's also make sure they can't exfiltrate your code or your projects or your secrets or your content to somewhere they shouldn't be able to.

[11:38] And so you have a configurable network sandbox and you say, "Look, these are the places you're allowed to access, these are the ones you can't access." And anytime it tries to access something that it shouldn't, it just pops up and

[11:47] says, "Hey, tried to access something. Do you want to give it access? Maybe you're trying to integrate a new vendor and you need documentation." And you can do it on a per ticket basis or for the whole project. And so again,

[11:57] that peace of mind of like people can do things. If they need new access, it's easy to grant it. And um we're not going to leak a bunch of important data uh by uh running agents in yellow mode. And the last thing I'll mention about

[12:14] that is that this is the key for allowing your non-technical team members to trigger real work. Right? Your non-technical people don't have development environments set up on their computers. But we've gotten our support people or

[12:28] growth people to actually be meaningfully impacting the product by just talking to the users, seeing bugs, experiencing themselves, and just go to Slack or the rabbit cell and say, "Hey, fix this." They fix it. Screenshots are shown.

[12:42] Engineer gets it, gets merged. Without that, they'd have to put it in linear and linear would eventually pick it up and a PM would triage it or whatever. None of that here. You just ask for it and it's done. Now, the reason people didn't do this

[12:57] you know, up until somewhat recently, like this was really painful. Getting your full thing set up in this like kind of sandbox environment used to be really, really painful. But agents have gotten better. We have our own environment setup

[13:09] assistant that kind of takes your project and gets it to work in one of these sandboxes. But honestly, whether you use this or not, I highly recommend you get your project working this way and you can just get Cloud Coder or CodeX to do this

[13:19] for you. You don't have to use us, but you know, we think it's the best way. And the last lesson is to benchmark agents on your code base. So, um the way we do this, we select pull requests that represent great engineering work. It could be agent

[13:35] created, could be human created, could be a hybrid, doesn't matter. You pick the agents you want to use and benchmark. And then you get a quality versus cost and time breakdown on your code base. Now, why do you want to do this? There's

[13:47] There's many reasons, but one is that if you're kind of going off the public benchmarks, we bench or terminal bench or other stuff like those tasks may have absolutely nothing to do with your task. Like swe bench is all in Python, we're

[13:57] Ruby on Rails. It is not the case that the benchmarks are identical for them. There's trends that do compare, but the results can be very, very different. And I'm going to swap over to my browser one more time here. So, this is These are results on our

[14:14] code base of all these different harnesses. This one here is quality versus cost. This one here is quality versus time. I'll start with this one. You can see some trends here. Right, you can see that the Anthropic agents have just been consistently

[14:28] getting better, but not really any faster. The Codex agents and cursor are actually pretty fast and quite good. The open stuff has been getting better and better over time, but they're kind of slow. This is for our code base

[14:39] again. I'm not trying to make any general claims here. By cost, the Anthropic stuff is clearly just so much more expensive for us. And the Codex stuff has been cheaper for us. And so this causes us to change our behavior. We still use the different

[14:54] models. There's different use cases for them. We like the variety. We still use all these things. But when we saw these results, they kind of matched our vibe check. We wanted to kind of like have hard data, too. We switched our default

[15:04] to Codex at that time. And Fiable came out, and it was great. Kind of switched our default to that for like the few days we had it, and then it went away and switched back to Codex. But the most important thing is like because we're agnostic, like none of

[15:16] that had any meaningful disruption on our work. Like we're able to just kind of switch back and forth really easily. So, the next day something new comes out, see if it's good, and go. And the last thing I want to mention

[15:27] around that is like I don't know if this resonates with you all, but I have a lot of friends that like, "Okay, and I heard MiniMax is good. I heard, you know, GLM is good, and Kimmy K2 is good, but like haven't had the time to try it out, and everyone keeps

[15:38] telling me I need to cuz it's so much better and faster and cheaper." And you kind of have that anxiety for a little while, and then like finally you take the two hours to try it, and it's like, "Oh, actually like didn't really work for us. So, like

[15:48] what's, you know, I just wasted those two hours." It kind of eliminates that. It helps you kind of stay on the cutting edge really like seamlessly. Let me go back. So, what that kind of turned into us for us is, you know,

[16:02] essentially 100% like 99.9% of our pull requests are like heavily agent generated. We know that quality and reliability and security are really important, so we still have humans look at everything. We have agents help with it all, but

[16:14] everything's human reviewed. Um you know, for our our our our relatively small team, we had 1 and 1/2 billion tokens over the past month. And you can kind of see what we're saying about Claude here. It's a little small, so I apologize, but we had 3,300

[16:27] Claude code runs that cost $10,000 in tokens daily. We have plans, so we didn't spend $10,000 on it. And Codex had four times as many sessions, and it was cheaper overall. And so again, the vast majority of our work currently is merged through Codex.

[16:43] We still use the other models. More and more is happening through GLM 5.2. Going to invest in that. And the one thing that we're really excited to do going forward with this benchmarking is automatically like like you've probably heard about people, you

[16:57] know, routing tasks to the right models and all that, but how do how does like some third party know what to route for your code base? Like this is a way that you can know what's going to work best for which task for your for your

[17:07] project, and we're going to kind of automatically routing that for you. So, I'm going to leave you with a few recommendations. So, first, um get your code base and agents working in a sandbox. It unlocks a lot of different things, a lot of

[17:21] different workflows, everything I've talked about and more. Second, integrate agents into the relevant human interfaces so your team and your agents can work together and don't have to like context switch and copy context back and

[17:34] forth. Obviously, we think Superagent is the best way to do it, but plenty of people are home rolling things, hacking things together. Figure out how to make this happen because if not, the friction is just really high.

[17:46] And lastly, find a way to benchmark and become model agnostic so you're not tied to anybody and you can just constantly stay at that right part on the frontier of cost, speed, quality. So, thank you so much. Um, we've got a

[18:00] booth in the expo. Please feel free to come by. You can sign up at superagent.com or you can email me with any questions at arjun@superagent.com. Um, I will be out in the back as well for any questions. Thanks so much. >> [applause]

[18:16] >> One one one last thing, um, if, uh, you know, at the booth we're mentioning we're giving away a MacBook Neo. If you were here cuz you signed up through for that, just meet us outside and we will announce the winner. Thank

[18:26] you.
