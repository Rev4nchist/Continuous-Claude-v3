---
video_id: RVxym6mmIns
title: "How Forward Deployed Engineering is done at Cognition — Jia Wu"
channel: "AI Engineer"
channel_id: UCLKPca3kwwd-B59HNr-_lvA
channel_slug: ai-engineer
url: "https://www.youtube.com/watch?v=RVxym6mmIns"
upload_date: 2026-07-28
duration_s: 1058
duration: 17:38
view_count: 19284
like_count: 57
subtitle_lang: en-orig
transcript_source: auto
transcript_words: 3534
ingested_at: 2026-08-06T11:00:33.913Z
ingest_version: 1
---

# How Forward Deployed Engineering is done at Cognition — Jia Wu
**Channel:** AI Engineer · **Uploaded:** 2026-07-28 · **Duration:** 17:38 · **Views:** 19,284  
**Watch:** https://www.youtube.com/watch?v=RVxym6mmIns

## Description

Most of the coding agent market quietly optimizes for token usage; Cognition's deployed engineering team measures the opposite, the outcomes a customer can actually see, and reports something like an 82% reduction on the work they targeted. Jia Wu's argument is that you measure before Devin ever lands, then again once it is fully activated inside the customer, so the value is a real delta and not a vanity number. The way that value shows up is not linear: one team using the agent is a step function, a whole enterprise using it is parabolic, because the products Cognition builds and the customer's backlog start to overlap.

That changes what a deployed engineer is. As the pure engineering part trends toward zero, the job leans on business and people skills: understand the customer's real problem space, find the highest leverage place to point the agent, and communicate it back into the roadmap, since customers are the lifeblood. Each deployment is meant to derisk and improve the next, because the challenges recur in similar shapes across companies. The value underneath it all is blunt: correctness and customer success at all costs, ship the hard thing and leave nothing on the table.

Speaker info:
- https://www.linkedin.com/in/jia-rong-wu/

Timestamps:
0:00 - Introduction: deployed engineering at Cognition
2:05 - Step function to parabolic productivity
3:35 - Where products meet the customer's problems
5:16 - Pointing agents at the highest leverage work
7:07 - How deployment challenges recur
8:34 - What a deployed engineer actually is
10:25 - Measuring outcomes, not token usage
12:56 - The 82% result, measured before and after
14:38 - Developers plus Devin, autonomously
15:53 - Core values: correctness and customer success

## Chapters

- [0:00](https://youtu.be/RVxym6mmIns?t=0) Introduction: deployed engineering at Cognition
- [2:05](https://youtu.be/RVxym6mmIns?t=125) Step function to parabolic productivity
- [3:35](https://youtu.be/RVxym6mmIns?t=215) Where products meet the customer's problems
- [5:16](https://youtu.be/RVxym6mmIns?t=316) Pointing agents at the highest leverage work
- [7:07](https://youtu.be/RVxym6mmIns?t=427) How deployment challenges recur
- [8:34](https://youtu.be/RVxym6mmIns?t=514) What a deployed engineer actually is
- [10:25](https://youtu.be/RVxym6mmIns?t=625) Measuring outcomes, not token usage
- [12:56](https://youtu.be/RVxym6mmIns?t=776) The 82% result, measured before and after
- [14:38](https://youtu.be/RVxym6mmIns?t=878) Developers plus Devin, autonomously
- [15:53](https://youtu.be/RVxym6mmIns?t=953) Core values: correctness and customer success

## Transcript

[0:01] [music] >> It's nice to be here. I appreciate you all. My name is Gia. I'm a deployed engineering lead at Cognition. And today, hopefully, what you'll take away from this is that how we deploy Devin in the field is very much a function of how we view

[0:25] deployed engineering at Cognition. So, how the four deployed motion makes AI engineering actually real. Before I start, how many people like have heard of Devin or like know of Devin? Oh, cool. And I'm not talking about like

[0:37] the Devin of today. Like, I'm talking about the Devin back in 2024 when we first released and it was like, "Oh, SweepBench 13%. We're so We're so back." And as engineers, we were like, "We're so cooked." But, I mean, after a week,

[0:47] everyone's like, "Oh, this is actually like not that useful." Um "I would only use this if I was desperate and out of ideas." That's 2024. Uh and let it be said that we have a sense of humor because we took this and we ran

[0:59] with it. I'm sure you've seen all these ads around SF. We're actually good now. So, the reason why we're good is I'll talk a little bit about the product surface area a little bit just to give you folks a little bit of context for

[1:13] who might not have used Devin before, uh who might not have exposure to something like Cognition. So, if you've used Flood Code, we also expose a CLI. If you've used something like, you know, Cursor, Windsurf, we also expose an interface

[1:25] such as an IDE. Uh actually, how many people know of Windsurf or have used Windsurf in the past? Sweet. So, I come over from the Windsurf side after the Windsurf acquisition. Um great times. And then, what we're actually known for,

[1:40] specifically, is for Devin Cloud or the Devin Cloud agent. And I'm not going to bore you to death talking about like all the components and features and everything that comprise of the actual product. I'm not here to sell you on

[1:50] that. What I am here to sell you on is we are one of the premier software engineering functions across the enterprise, and we're actually able to deliver impact on a global scale. What do I mean by that? We can take a pause and take a look at

[2:03] this figure. So, internally at Cognition, over the last 6 months, for better or worse, we might have been behind on hiring, but using our agent, we were able to ship almost an order of magnitude more good quality robust PRs across the

[2:17] organization. So, it's a step function increase in the amount of engineering leverage that we can have by deploying our own agent. You don't have to take our word for it. If we take a look If we can take a look at the specifics of how

[2:28] we're actually being consumed, how we're being utilized across the enterprise, it's a parabolic growth of how companies are adopting our agent, deploying our agent, and using it in multiple different use cases and multiple

[2:39] different scenarios. So, what does it mean, right? Like, how does this actually happen? Well, it can only happen with the forward-deployed engineers at Cognition. And I'm going to frame up the problem from like a couple of like buckets,

[2:50] right? So, there's two circles in front of you on the screen. One of them can represent the domain of a product, right? As a business, as a software engineering organization, obviously, you have a product. You obviously also, on the other side,

[3:04] on the left-hand side or right-hand side for you guys, you specifically have like a bucket of problems that you're looking to solve, right? You have a product, you have problems that you're trying to solve, and the intersection of these

[3:14] two, or whatever you would call it, is the product-market fit. Right? Hopefully, you have a pretty good overlap in the sense that whatever it is that your company does, you can actually bring value to customers. And hopefully,

[3:25] whatever problems the customer has, you can solve with your company's stuff. So, the forward-deployed motion at Cognition essentially aims to maximize the overlap between the products that we typically build and the problems that

[3:39] we're experiencing across the enterprise. So, what does that mean, right? The first fundamental concept that I would like to convey is that forward-deployed engineers at Cog deeply understand the problem space at hand. And specifically, right? Like if we

[3:53] think of the problem of software engineering, and I'm just going to like mask the features at the bottom, we don't really care about those, but if we think about when you go ahead to take some sort of codebase, some sort of

[4:03] implementation, and you need to like build features, you need to maintain that software, uh you need to like review, deploy, maintain that software. All of these steps, all of these functions have a lot of business value

[4:14] behind them, right? You can only do like it would be great if we could build from zero to one and just like prompt stuff and not worry about like legacy code, but that's not the reality of the situation. It would be great if our

[4:24] product engineers or our product managers could just take user stories and say like these are the things that we need to build in order to get value and revenue. And then we come to coding. Coding itself, at least from our

[4:35] perspective, is a mostly solved problem, right? These models are so good now that like with any type of context, with enough context engineering, you can get the code blocks that you really care about. But the problem isn't like

[4:48] writing code faster, that's usually only 20% of the problem. The problem really just becomes like how do you test this code? How do you review and deploy this code? And how do you maintain this code across the enterprise? So, that's the

[4:58] premise of the problem. Now, I will predicate that by saying that like we also have the solution, I'm not going to bore you to death about talking to you about the solution, but for deployed engineers at Cognition, we map Devin's

[5:09] capabilities specifically to the customer problem. So, if the software development life cycle is extremely complex, deploying the agents for with like no specific direction, you're straight up just token maxing. Right? Like you were wasting tokens, you were

[5:21] burning you were burning spend, you're not getting any tangible outcomes. So, we try to identify, when we partner with customers, when we take meetings, and for example, right? Like my day might look like four or five hours of

[5:32] customer calls, and then four or five hours of like actual hands-on keyboard work. Those four or five hours of calls actually allow us to understand very deeply what strategic initiatives are the highest leverage for the business.

[5:44] Right? Once Once identified that, right? How can we automate ourselves out of the job in the sense that we set up the agent in a way that it runs all of the automations for us, right? We don't have to be there manually triggering the

[5:54] agents. It can respond to like specific alerts, specific events. But most importantly, as forward deployed engineer, how do you measure the return on investment? And it's very ambiguous. And it's an unsolved problem because the

[6:07] company that will solve this will be um you know, $5 trillion market cap. So, specifically, our forward deployed engineers will embed in the customers ecosystems, right? We take a look at, you know, the backlog of stuff that

[6:19] needs to be built. We take a look at the remediations that need to be done. We take a look at all of like the delayed code that never ships or the test that nobody writes uh or the automatic triage of specific alerts. And we map our product capabilities into

[6:31] those problems. That being said, if we all do our job and we solve the customers problems 100% and the customer is very happy, that is only half of the equation, right? Not only do we have to solve the customer's problem,

[6:48] we also need to solve for our product. What do I mean by that, right? If we are taking it union of like the problems that the customers have and the products that we are building, right? Solving the problem only shifts like part of the

[6:58] Venn diagram. But in order to get that true feedback loop where we unify like the maximal overlap between what we're doing and what the customers need, that is forward deployed engineering at Cockroach Labs. So, the second part of

[7:09] this that I want to emphasize is that at our company, we map the customer problems back to the capabilities at hand. Now, how do we do that, right? A lot of engineering challenges come in similar shapes um from the field, right? We have the highest

[7:25] fidelity evaluation set that comes back from our customers, right? We are in the field every single day. We are hearing about the problems. We are hearing about whatever the customers are doing. And we have to take that context and

[7:36] bring it back to product in a sensible way. So, what are the ways in which these enterprise challenges, you know, manifest? are they common across the entire enterprise or are they unique to a specific user? Should like workarounds or like hacks or

[7:49] bugs in in in what we're building become features, right? Because ultimately what we want to do as a company is we want to de-risk our road map. At the end of the day, it would be great if like I as an engineer knew exactly what to build to

[8:05] get Y percentage of revenue from particular customer. And that's exactly what the problem is that we're trying to solve for because we are ultimately at the end of the day the heralds of the change, right? We are the bridge between

[8:15] products. We are the bridge between problems and the feedback is actually like half of the loop that makes the next deployment better than the previous deployment. So, if we think about the T-shape or personas of the folks that we hire,

[8:30] and for a deployed engineer, it's just so it's so flexible in terms of how you actually define it. Like, are you a sales engineer? Are you a solutions architect? What are you, right? So, if you think about all of the skills that FDEs

[8:42] typically are expected to have, right? You probably want to go wide. You probably want to have, you know, good people skill, like business skill, good process, customer skill, or even technology, right? In order to be deployed in the space, you need to know

[8:53] like what whatever the tech is. So, we also look for very deep spikes across people, right? Folks at Cognition deployed engineers at Cognition, we will hire them from like product management backgrounds if they have a really good sense of like how

[9:07] products are supposed to fit into each other, right? Because if the cost of software engineering is going to zero, you actually need to know how to like design a product that makes sense. Cuz you can just prompt it. But we also hire folks that are like

[9:19] founders, software engineers, but specifically like very spiky in the technology domains, right? It's fine if you don't have like the strongest business sense, that can be learned, but it's also very hard to teach like technicality and being the

[9:31] expert in the room while you're on the job. So, there's a couple of personas that we specifically hire for. Good customer engineers or deployed engineers do everything, right? Like they can map the product back to road map, like

[9:45] they can solve the customer's problems. Great customer engineers are able to actually have that relentless curiosity for why. So, at Cognition, we always ask ourselves, "Why are we solving this problem? Does this problem matter to the to the

[9:59] business as a whole? And can I communicate this back to the road map in a way that like improves the problem for everybody else?" But we also are The second mantra that we subscribe to is that you have to be relentlessly

[10:11] tied in to the customer, right? They are our lifeblood at the end of the day. Making them successful is the only way that you can survive as a business and become the obvious choice for an enterprise partnership. So, these are

[10:21] the two mantras that we specifically subscribe to as uh deployed engineers at Cognition. So, previously, um the first approach to deployed engineering was just, you know, token maxing, right? Uh the next era that I'll talk about is

[10:35] intelligent orchestration, but with like outcomes that you can actually measure, and I'll give you guys some examples. So, previously, like a year, maybe a year and a half, two years ago, uh the target or KPI for whatever deployed engineers

[10:50] were trying to do is maximize token usage, right? It was It was like the perfect time. Didn't have to worry about budgets. Everything was subsidized. You could just like run anything you wanted. But now, the problem has really shifted

[11:01] into the delivery space, right? A lot of organizations that we work with, some of the largest and most regulated enterprises in the world, they really care about, "Are we getting true value out of this solution, or are we

[11:14] just burning tokens for no reason, right?" And that is one core differentiator that I need to call out between us and some of the other platforms. You can make engineers like 10x faster. That's fine. That's still valuable. But can you make

[11:26] an organization 10x faster, including every single person that might be technical or non-technical uh across the company? That's when you unlock the true value of being the partnership. And that's why like single point tools that are just

[11:38] like CLIs or just IDEs, they fail to do that. So, let me just give you some proof points of how we've operated across the enterprise. So, at Cognition, um when we run the agent and the agent has like a specific trace or trajectory or

[11:56] like the agent does something, we call that a session. A session itself, right? We have metrics that allow you to derive how many engineering hours you can actually generate and how much how many engineering hours are actually

[12:08] productive that users are running. Right? So, one of these examples is a case study where we embedded ourselves within a customer for 3 months. We brought them on board. And functionally, over the course of those 3 months, we

[12:19] delivered about 150% like plus headcount. So, if you thought about like a project that you're trying to ship or something that you're trying to develop or a migration that you're trying to go through, imagine having 150 extra

[12:31] coworkers doing that with you by your side. You might just say, "Hey, this actually just kind of looks like token maxing, right? Like you're just giving me a metric that says it's just, you know, engineering hours. You're like running a bunch of different

[12:42] sessions. Like, how do we know that these sessions are true, meaningful, and valuable?" So, the second part of that is, okay, we can think about how we've reduced timelines for delivery projects on an order of magnitude. So, about like

[12:56] 82% reduction across like delivery. So, if you subscribe to the agile deliver agile development methodology, obviously like you have tickets, you have sprints, like you have things that need to be built. If you look at every single

[13:07] metric that you measure before you bring in Devin and after you bring in Devin, you can take a look at that. We can compress this timeline by a factor of like 82%. So, across the board, whenever we get developed, whenever we get deployed, and fully

[13:21] activated within the customer environment, not only do we deliver a massive scale in terms of like engineering capacity, but we also reduce the time to value in terms of bringing things to market. Now, the third part of that is, hey, but

[13:35] I actually really care about the numbers, right? I actually really want to see how many PRs are you actually shipping? Like, is this meaningful? Does this actually make sense? So, if you think about dissecting the numbers a little like one

[13:46] dimension further, and you want to just look at like the raw PRs that people are ripping across the enterprise, we deliver almost double the amount of PRs that engineers were able to do with single-point tools and before you

[13:57] brought in an agent harness like Devin. So, there's three proof points of anonymized case studies in which we are able to deliver value at scale and across like various different problem domains. What I'll say is these aren't like, you know, private

[14:14] case studies. We have a bunch of different public case studies as well. So, we partner with companies like Nubank, right? If you folks have ever gone to Latin America, you can understand that, you know, the there's a lot of developers there.

[14:25] There's a lot of projects that are tangentially related. So, specifically, like we can say that there was an ETL migration. They had 50 engineers staffing this migration. We were able to deliver this within, um, I think like

[14:35] 1/3 of the timeline. Just with Devin autonomously. We have another bank, right? We have another use case where we work with one of the largest banks in Latin America. They were trying to migrate like the tax identification system. I know, like

[14:49] rocket science, right? Um, but the idea is that we were able to deliver this with half of the amount of effort actually required. So, if you think about like legacy languages like COBOL, if you think about things like JCLs, you think about things

[15:01] that like people don't learn anymore just because it's like not fun and not interesting, we're able to operate across some of the most complicated codebases in the world and deliver results that actually matter. And last but not least, obviously like

[15:15] if we think about the built card, um, specifically, we're able to actually merge like an order of magnitude more, um, in terms of like PR acceptance rate. We deliver like 10x per sub like worth of engineering talent like every single

[15:27] week. And then we're actually able to, you know, generate the weekly output of like over 10 engineers at the organization. Built has great engineers, by the way, right? These guys are so cracked. So, if you take one of these engineers

[15:37] and multiply them by 10, you just imagine the amount of returns. So, what I'll say is I'll I'll probably like round off this talk by just saying that at Cognition, we don't just, you know, embed ourselves in the customers.

[15:49] We don't just, you know, propagate feedback back to everybody else. But, the core values of the company are things and principles that we subscribe to not internally to the company, but external to the company as well, right? It's really fun being on

[16:01] the winning team. It's really fun when you come into an organization and say, "We can actually deliver so much cool stuff and like make people our champions, right? Whoever deploys Devin within the organization, they can show results that

[16:13] are essentially unmatched across the board." And we go for it all, right? We leave nothing on the table. We've deployed somebody in Brazil for like 10 months. >> [laughter] [snorts] >> To to live next to one of the customers

[16:25] to just make them successful. So, we're down for the mission. And it's it's more about like correctness, right? Like if if there are engineering practices that we want to fix, if there are things that we want to flag and raise, like these are all

[16:36] things that we take back to product and there's no ego involved. At the end of the day, we are all in the same boat. We're on the same mission and we're just shipping. And everybody essentially is go-to-market. I know forward deployed

[16:47] engineering is kind of like this fuzzy thing where it's like, "Am I part of sales? Am I part of post-sales? Like what do I actually do as an FDE?" But, everybody is go-to-market because the target is to make the customer

[16:56] successful at all costs. And at the end of the day, we just do things because every second counts. So, if you're interested in, you know, forward deployed engineering at Cognition, being the intersection between some of the hardest problems in

[17:09] this world, being part of like all of the software disruption at scale, and then being on the other side of these problems, we should talk. Thank you.
