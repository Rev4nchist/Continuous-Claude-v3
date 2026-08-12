---
video_id: vSx5IULvBns
title: "Always-on agents run production without the on-call tax — Justin Smith, Resolve AI"
channel: "AI Engineer"
channel_id: UCLKPca3kwwd-B59HNr-_lvA
channel_slug: ai-engineer
url: "https://www.youtube.com/watch?v=vSx5IULvBns"
upload_date: 2026-08-09
duration_s: 1496
duration: 24:56
view_count: 1312
like_count: 41
subtitle_lang: en-orig
transcript_source: auto
transcript_words: 5207
ingested_at: 2026-08-10T12:16:22.575Z
ingest_version: 1
---

# Always-on agents run production without the on-call tax — Justin Smith, Resolve AI
**Channel:** AI Engineer · **Uploaded:** 2026-08-09 · **Duration:** 24:56 · **Views:** 1,312  
**Watch:** https://www.youtube.com/watch?v=vSx5IULvBns

## Description

Someone drops a GitHub release tag into Slack and the agent decides on its own that this is a deploy worth watching. It reads what actually changed, works out which telemetry would expose trouble for that particular change, and writes a check plan for this release alone: checkout is replacing the currency service, so watch checkout latency and error rates, then follow the causal chain into the Kafka pipeline. None of the timing is hardcoded. It can decide to look again in an hour because this class of failure only surfaces intermittently, or come back in three days to ask whether the deploy is still healthy. Justin Smith is careful to say CI/CD already handles the baseline well. The gap is everything routed around it, the feature flags and infrastructure changes that ship with no monitoring at all and get caught only when an alert wakes somebody up.

The premise underneath is that around 70% of an engineer's time goes to running code rather than writing it, and coding agents made that worse by raising the volume of change flowing into production. Resolve's background agents are defined by three questions: when they run, on a schedule or an event stream or just a message; how they run, in the cloud inside a sandbox with its own file system, so closing your laptop changes nothing; and how they know what to do. The one Smith clearly enjoys most watches Slack channels and answers engineering questions without being addressed, staying quiet when it lacks confidence, and DMing him to confirm an answer before it replies in public. His sharpest point is that execution is the easy half. Loading a dashboard is execution. Deciding a metric smells wrong is production context, and building the knowledge system that keeps up with an environment changing faster every month is where the real work sits.

Speaker info:
- https://www.linkedin.com/in/justin-smith-7b1534a8/
- https://resolve.ai/events/behind-the-build/agents-for-engineering-workflows

## Transcript

[0:01] [music] >> Hello. Hello. Everybody, welcome to this talk always on agents run production without the on-call tax. My name is Justin Smith. One of the founding product engineers at Resolve AI. Been in the space for about 15 plus

[0:31] years in the sort of monitoring, observability, how do you kind of operate production systems space. Was at Splunk for a while. Was one of the architects on the observability suite there. Spent a good 10 year at VMware.

[0:45] Really really enjoy like product design and front-end architecture. How do you How do you How do people experience a product or use case or something like that? That's the stuff I like to dabble in. Um but I want to talk a little bit about

[1:02] the first wave of AI and it's it's been a fun one. I think the first big wave and I'm sure we've all experienced this is just how we build software. Um but there's some sort of net effects of that. It's a lot of bigger PRs that are

[1:17] coming through. We definitely see a lot of this a lot more frequently. So people are shipping code at a much, you know, faster rate from developers and we're beginning to see maybe from even non-developers that maybe don't actually know the code

[1:31] or what it's doing or sort of like operating principles behind it. But we're getting developer productivity. And that's good, right? That's that's a good thing that we're all able to sort of produce more and faster. Kind of sort of what we actually found

[1:47] out and this was a survey study done is that 70% of the time from an engineer is actually not just like is not focused just on writing code. It's actually spent on actually running the code that is actually shipped into production.

[2:00] Um maintaining all the the platforms, scaling the infrastructure, debugging all the incidents, and being on call, um shipping hot fixes, right? Dealing with alerts, um updating all the sort of run books and operating procedures, restoring

[2:13] services, dealing with escalations, dealing with sort of like um questions from other, you know, teams and things like that. So, really coding was never the the the big bottleneck, right? Um a lot of it was really around, uh thank

[2:27] you, granola. Um a lot of it was really around like how do we actually run these things sort of in production. And that's getting harder and harder and harder. Um AI is creating a lot more issues in production as, you know, AI code sort of

[2:41] goes through. Um it's not clear we have the right sort of um structures in place to deal with the amount of kind of changes that are coming through. Um unlimited tokens is is sort of coming to an end, the the token max, right?

[2:52] They're starting to clamp down. Prices are going up. Companies are getting a lot more stringent on, you know, what's being used um for AI. Um you know, we need full stack AI. It's not just about the models anymore, it's about the

[3:03] context around the models and what the models can do inside of a specific domain. These become the the problem areas that we need to sort of uh focus in and tackle on. And this is true today, right? So, it's it's creating more sort of uh complexity

[3:19] inside of our environment. But, I mean the the reality is that systems have always been complex. That's why we have, you know, these big tools that can, you know, try to give us insights into these systems. Um there are multiple teams, there's

[3:29] multiple systems that are all having to work together, and they all have their own, you know, goals that they're trying to deliver towards, but you have organizational goals. And how do you keep all of this sort of uh you know, um

[3:40] in Get rid of this. Um how do you keep all of this in balance, right? Um how do you, you know, pull all of this stuff together in a way that actually uh actually helps you and and facilitates your uh your organization. Um and the answer is,

[3:56] well, you got to use AI inside of production to deal with um sort of the the amount of increase of complexity that AI is kind of putting into your product or into your system. Um and so that's where Resolve, you know, this was kind of our sort of

[4:10] hypothesis from the beginning was um you know, we're going to see an influx in um you know, issues uh coming out of coding um just the increase in coding uh velocity. Um there's going to be more need for kind of AI to actually operate

[4:24] and run these run these systems. Um we're, you know, lucky to work with, you know, some uh world-class engineering teams that are solving like really difficult problems at, you know, crazy scale. Um and you know, that that gives

[4:37] us insight into a lot of how bigger organizations are having to deal with the influx of AI, etc. Um Resolve itself uh hosts a bunch of different sort of capabilities. Um we have a number of agents that sort of you know, you get to kind of experience. One

[4:54] of them is just an on-call agent. This is kind of where we started, right? Um so for every alert that comes in, um we can do a triage of that alert. We can do kind of a full root cause investigation of that alert. Um and you know, this is

[5:07] for anybody that's had to be on call before, um you know, on call is a it's a nightmare, right? Um you're often uh only going on call every few weeks. Uh you you maybe don't fully understand all the changes that have come in. You don't

[5:19] fully understand maybe all the different systems that you're having to interact with. Um and so, you know, the complexity is already there and having an AI agent that's able to come support you and pull that context together is

[5:28] incredibly incredibly valuable. Um and so, uh that can often grow from just sort of getting a single page into a much larger incident across many different teams um across an organization. Um and we have agents there to come support that much larger

[5:43] activity of, you know, all all kind of cross-collaboration, etc. Keeping everybody uh in sync and aligned on uh um where the where the incident is happening, what the impact of that is, um etc. And then we also focus a lot on

[5:56] background agents. And this is sort of covering the long tail of, you know, what happens when there's not a fire brewing um or or going on at any one, you know, point. Um there's still lots of operational work that you as an

[6:07] engineer or an engineering team have to do and a lot of ceremonies of, you know, passing contact context off or dealing with kind of one-off issues or kind of having to scratch that itch in the back of your head of like, is that part of

[6:19] the system okay or not okay? Um and you're constantly having to sort of balance across all the these different things. Um underneath all of that, you know, the we have an agent uh architecture um deals with models and context and reasoning and and actions.

[6:31] Um learning is a a I'll sort of like half pause on that one. I think, you know, some of the biggest issues that we've seen, it's it's not that a a model by itself is is not smart or whatever. I mean, models have gotten incredi-

[6:45] incredibly capable over the last um year, let's say, right? But especially over the last like 6 months or so. Um but the idea of understanding, like truly understanding your environment um and the way that your services interact

[6:56] and where the hotspots are, keeping track of all of that sort of understanding is incredibly difficult. But it's incredibly important for any model to be successful at, you know, the task that it needs to do. It has to have

[7:07] an underlying sort of learning system to be able to capture that knowledge um and that sort of understanding of how your system operates. Um so we spend a lot of time thinking about how do we have systems that not just can understand

[7:18] your environment at any one point, but grow as as your system evolves? Because again, your system is evolving faster and faster. We need to keep up with learning about what's the current state, um what's the current sort of causal

[7:29] chains that we need to be sort of keeping keeping an eye on. Um and then of course all the enterprise enterprise stuff sort of underneath. Um and so this is that same view kind of uh packed out. Um Come on. Okay. Um, but so today so we do

[7:45] a lot at Resolve um, the on-call and the incident stuff. I'm going to focus a lot uh, more just on the background agent um, stuff. So how do we deal with the things that maybe aren't sort of immediate fires. Um, if you have

[7:55] questions about the immediate fire stuff, um, we have a booth down in the expo. Please come check it out. Uh, our team would love to demo to you etc. Uh, but today we're going to focus on the background agent. So kind of a little pop quiz. Um, feel

[8:07] free to raise your hands. Is anybody using agents in part as part of your daily workflow? Maybe outside of the coding. I'm assuming everybody's doing coding agents these days. Is anybody doing like actually running sort of um,

[8:18] agents that are sort of helping in other ways? Okay. Uh, decent amount. Any good examples? Any fun stuff that anybody has? You can just yell it out. >> Meeting review. >> Meeting reviews? Yeah, meeting reviews. I just had my granola show up and

[8:30] >> Market research. >> Market research. I do a lot of. >> [laughter] >> So let's let's have a good conversation about. Yeah, yeah, yeah, I do that all the time. Any other ones? Maybe one more? >> Therapy. >> What's the one?

[8:40] >> Therapy. >> I can't hear it. >> Therapy. >> Therapy. That's a fantastic one actually. We're we we are humans here today. This is very important. Um, that's actually that's a very good one. Um, okay. So so people are having some

[8:53] stuff uh, going on. Um, So, you know, and this is kind of recaps a little bit uh, again. A lot of production work is not about is not there's not a sort of big ceremony that everyone is focused on for the the type of work that we have to do. Um, on-call

[9:07] you you've got a page that goes off. You know somebody's going to receive that. Incidents you create a bridge, you invite people in. That's great. Um, but there's just a long tail of other things that we are accountable for that doesn't

[9:19] have sort of a thing that's going to show up in your sort of job description of like this is what you're going to be, you know, responsible for. Um, watching deploys that go out and make sure that they're actually getting out um,

[9:28] healthy. Um, a morning report uh, incident digest of just like what's the state of my system today so that we're all on the same page. Um, hey that P99 drift kind of came back. Is somebody looking at that or not? And you know, this is pulling people in

[9:44] to to try to like figure out what's going on. This may not be paging, right? Because we don't we're not going to alert on everything. Produce the capacity report, right? Like are we tracking okay, right? This is maybe a company goal this this quarter.

[9:58] Are we tracking against that? Somebody's going to have to be responsible for doing that. The recurring health check and just kind of checking and making sure things are kind of running okay and not waiting for a customer to come

[10:07] complain first. So this work doesn't have like an obvious like, oh, this you know, this now needs to go be done. But it's work that we end up having to do. So what is a task? A task is just execution and the context to understand

[10:21] how to actually execute the task. Execution is very very important. It's understanding what to do and being able to execute that. Maybe having access to the tools, etc., right? Obviously very important to do. But we think the production context is

[10:39] just way more important because it's one thing to go check a dashboard. It's another thing to say that metric smells off. And the execution is can load the dashboard. It's the production context that's going to say, this feels wrong.

[10:53] And I don't know if I can even explain why it feels wrong. It just feels wrong and I want to dig into the next layer of sort of understanding of that. And so really if if we start talking about background agents and being able

[11:03] to kind of perform task, you need both of these. You need the execution engine, that's great, but you really need that production context that tells you is this important or not important. So every background agent, you know, there's a a few different

[11:19] principles that we like to think about with our background agents. When does it work? How does it work? How does it know what to go do? When does the agent work? It can work in a bunch of different ways. It can just do it on a schedule.

[11:29] Maybe this is the the report, etc. Just kind of do some summarization for me kind of on an ongoing basis. Maybe it's a weekly event, right? We do an on-call handover uh every Thursday, and so that a lot of um the work that our agent does

[11:41] is sort of prepare like what what are the kind of interesting trends from the last week that the next on-caller needs to sort of understand as they pick up the rotation. Um, event streams, so you know, there's lots of systems that will sort of push events

[11:53] as kind of key things happen. Um, so deployments go through a CI ICD pipeline. Um, there's other sort of uh Slack-based, right? We get a lot of uh Slack things messages coming through, um etc. Um, and these are things that we

[12:07] can sort of pick up and trigger and say, "Oh, if this event happens, um let me sort of understand what that event is and go do some work." Um, and then message-based, so I can just tell it, "Hey, go do some work." And it will go

[12:16] do some work. That's fantastic. Um, how does it run? Always runs. It's in the cloud. Um, so if you close your laptop, it's okay. Um, runs inside of a sandbox, so it has kind of a file system underneath it. Um, this allows it to

[12:28] sort of self-organize a lot of its work, etc. as it's doing uh doing things. Um, and then obviously back to the learning loop, right? So, that idea of knowledge and sort of a memory system underneath that um to really understand your

[12:41] systems and as it's doing a task, able to sort of reflect on that task and uh you know, do a better job next time. Or the things that it learned from one task, it can sort of apply into a different task. Um, because again, this

[12:53] this sort of shared uh sort of knowledge system um works across all the different tasks that we have. Um, so how does the agent know what to do? Um, it has a task system. It can pull in all the skills that you have in other

[13:06] systems, that's fine. You can connect those. Um, and it's got obviously the integrations that it's going to plug into. Um, so let's talk a little bit about what types of things you uh can hand over. Um, we've got four sort of

[13:17] workloads that we're going to talk about, but if you think about the previous couple slides, these are sort of very basic primitives that we've built into the system. You can get very creative. We've We have a number of

[13:29] people inside of Resolve that have gotten very creative with the type of sort of background activities that things that that they that they have. So, I want you to use these as kind of These are things we've seen be very

[13:39] successful inside of Resolve, but also with you know, a number of our customers. But, you know, sky's the limit and and you can get really creative. So, deployment monitoring. So, this is a big one, you know, any change inside of your

[13:51] environment is an opportunity for something to go wrong. Um and so, you know, having an agent that's able to watch as all these change events come in just to do a sanity check of is everything stable is incredibly incredibly important. And, you know, a

[14:08] lot of people have decent CICD system. I mean, this is like tried and true stuff that we've had as an industry for quite a while. But, we we noticed a couple gaps, you know, from in most of our customers. You know, typically the checks that it

[14:21] does are good. They're good baselines, but it's not exhaustive based on the type of changes that are going in etc. There's certain signals you'd want to watch or not want to watch. And so, every rollout is a bit unique.

[14:35] Often times you have change systems that you're not piping through a CICD system like a feature flag or maybe some infra changes that might happen which maybe don't get any monitoring at all. And you're sort of just trusting that an

[14:47] alert might fire and an on-caller will wake up and say, "Who changed what?" right? Deployment monitoring is is actually a really big use case that we suggest people sort of go through and I'll show some examples of that in a second.

[15:01] Schedule health and anomaly checks. So, this is just sort of the ongoing periodic checking of some of your systems. And, you know, this is maybe something where it's like go check, you know, sort of my general dashboards on a routine

[15:14] basis maybe every morning just kind of do a casual check just to make sure there's nothing kind of weird from last night that I might need to be be of. But, uh, this can also just be sort of a time-based thing. Like I made a change

[15:25] in part of our system. I'm worried about this, you know, uh, you know, third-party service that I'm kind of interacting with. Let me just kind of set an agent to kind of watch that maybe for the next week just to make sure

[15:35] everything is kind of stable and then that agent can sort of, um, you know, stop his job. Uh, operational reports and handoffs, I talked a little bit about this. Uh, these are the sort of ceremonial things that we might want to do just to, you

[15:46] know, spread information, summarize things, kind of bring things to the fore. Um, and then a first responder to engineering questions. And this one's kind of fun a little bit, um, because the trigger for this is actually just a

[15:56] Slack message and I will say, um, one of my biggest, like, let's call it responsibilities, uh, as an engineer is watching all my Slack channels and trying to make sure everyone's kind of happy. Um, and like that nobody has any

[16:10] burning questions or anything like that. Um, and so I can be sort of heads down trying to build something, um, and then, you know, the, you know, uh, eventual sort of Slack notification comes in that like this channel somebody asked this

[16:21] sort of kind of important question, um, and I just need to jump in there and and try to provide context, etc. It's not hard work. It's not hard for me to go answer questions, but it's disrupting me and if I don't go answer it, um, they

[16:34] won't get an answer for a while. And what we found is like our agent actually has access to a lot of information that people ask questions about. At least this is true internally. Um, so we actually have an agent that can watch

[16:44] all of these sort of critical channels, um, and determine whether it has enough sort of confidence to answer the question or not. Um, and one of the fun things is like it, uh, the our agents have access to like Slack DMs and things

[16:56] like that. Um, and so you can have an agent that basically will DM you to say, "I think I know the answer to this, but I'm not sure. Can you confirm this for me before I, you know, respond back?" Um, so this kind of emergent behaviors

[17:06] gets kind of fun and interesting as you just kind of build these things out. Okay, so I'm going to flip over and hope all of this works. Um, Cool. Um So, uh let's see if I can find the one that I wanted to show. So, this is our uh sort

[17:27] of demo application running in our sort of demo sort of Slack environment. Um and uh what I wanted to show off was some of our deployment stuff and talk a little bit more about um what's kind of going on under the hood. Um so, this is,

[17:39] you know, sort of fake environment um just to kind of showcase some things. Um so, here um anytime somebody posts a sort of GitHub tag, um our agent's going to sort of see that and say, "Oh, I I should That's a release. Is that a

[17:51] release? Yes, that is a release. Um let me go watch that." Um but, it's not just going to watch it. Um it's going to do something that's slightly more intelligent. Uh cuz like I said before, everybody kind of has a CI/CD system. It

[18:01] will do the sort of standard checks on on, you know, certain KPIs. Um but, what the agent is able to do is actually look at the changes that are going in, understand what telemetry might help us evaluate whether those changes are, you

[18:14] know, good or not good or like are putting the system in an abnormal state, um and build a sort of customized plan that it's going to check uh just for this specific release. And this is why I kind of go back to like, you know, our

[18:28] goal is not to sit here and say, "We're going to replace an entire CI/CD pipeline. You've spent time organizing that." But, this can sort of patch a lot of, you know, uh parts of your system that may not be as robust as they should

[18:40] be. And it would be great if you had a single engineer just focused on like watching all the things on every release, but that's really expensive. There's a lot of cognitive load. You'd rather have them doing other things. Um

[18:50] so, now the agent can come and actually do a lot of that sort of dynamic understanding of this is the change, um so, I'm going to sort of check for these things. And so, here, um the checkout replaces currency service, um

[19:00] you know, we're monitoring the checkout latency and the error rates. Well, let's take a look at the Kafka pipeline cuz that's sort of involved. This is the sort of causal chain I want to sort of say, I want to make sure is is healthy.

[19:10] And it'll check that, and it can check it not just once, um but sort of on an ongoing basis. And you know, none of this is hard-coded in. It's not like, oh, let's just wait for 15 minutes and then try this again, and then we'll be

[19:21] done. Again, the agent has a bit more autonomy, and and you get to guide it a bit on how you how much autonomy you want it to have, but it could decide, I want to wait for another hour cuz this type of issue might only hit every you

[19:33] know, every so often, so I really want to spend a little bit more time focused on this. Maybe I'll come back in 3 days and say, is this deploy still kind of healthy? Are we seeing the the change in the effect that I expected to see out of

[19:44] this? So this is a type of thing that we can bring, and and this again works for feature flags, infra changes, sort of any sort of eventing system that you can think of. The sort of on-call handoff reports, let's scroll up just a little bit.

[19:59] Um So this is just a summarization of all of the work that was done, you know, over the last day that the agent is kind of just summarizing up. And this one's a little bit verbose, but you can see a bunch of different sort of

[20:15] investigation summaries that we did, some notable changes, etc. Work work completed. Um So there's a critical open. You know, I guess that's the on-call handoff. But one of the nice things I don't know if I'll be able to watch it

[20:30] go all the way. But you can always just come back in this thread and, you know, this is too verbose. Verbose. Make it shorter. Um and I'm not going to be able to unfortunately no time to watch this actually go, but this works. The the

[20:44] agent is able to update its task underneath, and able to sort of give you the answer like update so that the next time it fires, it's not going to uh be as verbose. And I can tell it explicitly what I want, etc. I was just

[20:58] kind of giving an example. This is kind of the more fun one. So, you know, here I'm just like posting different problems. Um, I'm not having to know that resolve exists. Um, I don't have to like at mention resolve, whatever. Um, I've set up this agent to

[21:12] sort of passively watch this channel. Um, if you see something that you think you have an answer for that somebody's kind of, you know, digging into, um, go ahead and respond. Um, otherwise don't. So, you know, here's a message that I posted um,

[21:24] that it's decided I don't need to respond to this. Um, so again, very kind of flexible system um, that can kind of adapt to a bunch of different things. Oh, where are my slides? Oh. We have uh, in the UI there's a bunch of

[21:42] stuff that you can do. You know, you can always go down and inspect all the different tasks that you have and and view their reports, view previous runs. You can see all the work that the that the agent has done underneath um, to

[21:53] sort of accomplish that task. So, you get a lot of visibility into what the agent is doing, but we think the surface area being where you live, right? So, Slack is this like kind of um, or or MS Teams if you're on MS Teams, as this

[22:04] kind of first party experience to sort of integrate the the agent into um, is incredibly important. Um, and so, you know, how would you get this stuff uh, sort of set up? Um, it's really just through talking with the agent. Um, and so, here this is me

[22:19] sort of saying, "Hey, I want to do a new recurring health summary for my team." Um, so the agent's going to uh, take a look at my environment, it's going to explore my environment a little bit um, and eventually likely come back and ask

[22:30] me a couple questions about um, what I want to see, what kind of reports do I want, how how verbose do I want it, um, etc. Uh, the agent's going to go ahead and do all that and it's going to set up that sort of initial thing for me so

[22:41] that I can test it out, make sure it's working, um, and then share it with the rest of uh, with the rest of my team. In the interest of time, I don't think we'll get to this, but come by the booth and you can see more. Um,

[22:56] cool. Um, so that that's background agents. And again, I I sort of lean back on be creative, right? Like everyone has unique work, I mean as as a company we believe that every, you know, every company is a unique place. That's why we

[23:14] spend so much time on our knowledge system, etc. Um, truly understanding your, you know, what your environment looks like, what your needs are, etc. Um, that begins to kind of tell you where the where the biggest benefit from

[23:24] having these agents begin to pick up work um, would be. Um, also just to call out, if you have an agent harness, if you, you know, internally if you're building your own, um, everything that I showed is accessible uh, through kind of

[23:36] MCP servers, etc. Um, so you can really graft resolve into kind of any um, system that you have um, as just kind of an extension of learning to kind of do deeper work or to sort of pull production context uh, a bit more

[23:48] efficiently or you know, even augmented with all that learning stuff that we've done. Um, and then obviously bring your own skills um, along for the ride. Um, don't go duplicate a bunch of stuff. Um, so really the biggest things to take

[23:59] away, um, cost of operational work, it's not navigating uh, you know, it's it's it's not just in the task execution, it's in the environment complexity, right? Um, that's where the biggest issue is going to happen. Um, background agents, they run on

[24:12] schedules, they run on triggers, they're very composable, you can sort of graft them into lots of different use cases. Um, it's fun to see people explore that. Um, and uh, yeah. Um, you open resolve just to kind of see what the top findings are, etc.

[24:26] Um, but you know, ideally a lot of your interaction is kind of in the places that you're already kind of doing work. Um, so um, if you have any questions, uh, you can find me down at the booth or you know, just meet me out in the hall.

[24:36] Um, but thanks for coming. Appreciate it. >> [applause] [music]
