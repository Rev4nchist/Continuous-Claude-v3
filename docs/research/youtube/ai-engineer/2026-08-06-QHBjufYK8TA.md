---
video_id: QHBjufYK8TA
title: "The State of Model Routing — NVIDIA, Cognition, OpenRouter"
channel: "AI Engineer"
channel_id: UCLKPca3kwwd-B59HNr-_lvA
channel_slug: ai-engineer
url: "https://www.youtube.com/watch?v=QHBjufYK8TA"
upload_date: 2026-08-06
duration_s: 2897
duration: 48:17
view_count: 1463
like_count: 44
subtitle_lang: en-orig
transcript_source: auto
transcript_words: 9448
ingested_at: 2026-08-07T12:04:46.073Z
ingest_version: 1
---

# The State of Model Routing — NVIDIA, Cognition, OpenRouter
**Channel:** AI Engineer · **Uploaded:** 2026-08-06 · **Duration:** 48:17 · **Views:** 1,463  
**Watch:** https://www.youtube.com/watch?v=QHBjufYK8TA

## Description

Run terminal bench on Opus and on Haiku and Opus scores about three times better at a tenth of the cost, even though Haiku is far cheaper per token. Alex Atallah's point is that a small model pushed outside its training distribution thrashes, calling tools in loops until it costs more than the expensive model ever would. That inverts the obvious version of model routing, where you send each task to whichever model benchmarks best on it. Walden Yan calls that approach fragile for exactly the reason agents make it worse: a session starts as a question about a codebase, becomes a feature request, then becomes live debugging, and the model you picked at the start is stranded.

Cognition's answer keeps a frontier model planning and delegates the implementation, which cut the cost of Fable level intelligence by 40% while going deeper, because a cheaper model can afford to spin off three sub agents to explore a codebase. They also avoid sub agents in favor of one sidekick with a continuous running context, so the KV cache stays warm and cached tokens cost roughly ten times less. Compaction, Yan argues, is worth doing for intelligence rather than cost, since compacting forces a cache miss and model quality falls off a cliff well before the advertised million token window. The most telling story is OpenRouter's: its auto router sat almost unused for two years until openclaw began sending heartbeats every ten minutes, creating one popular app with two completely different intelligence needs.

Speaker info:
Nader Khalil, moderator (NVIDIA):
- https://x.com/naderlikeladder
- https://nader.coffee

Walden Yan (Cognition):
- https://x.com/walden_yan
- https://www.linkedin.com/in/waldenyan

Alex Atallah (OpenRouter):
- https://x.com/alexatallah
- https://openrouter.ai

Tanay Varshney (NVIDIA):
- https://www.linkedin.com/in/tanayvarshney

Carter Abdallah (NVIDIA):
- https://x.com/Baxate
- https://www.linkedin.com/in/carter-abdallah

Timestamps:

## Chapters

- [0:00](https://youtu.be/QHBjufYK8TA?t=0) Welcome and the multimodel premise
- [1:16](https://youtu.be/QHBjufYK8TA?t=76) Panel introductions
- [3:24](https://youtu.be/QHBjufYK8TA?t=204) How Devin Fusion beats the frontier models
- [4:25](https://youtu.be/QHBjufYK8TA?t=265) Let the frontier model plan and delegate the work
- [6:31](https://youtu.be/QHBjufYK8TA?t=391) Jagged capabilities: no one model wins everything
- [9:42](https://youtu.be/QHBjufYK8TA?t=582) Why naive task based routing is fragile
- [11:48](https://youtu.be/QHBjufYK8TA?t=708) Sharing context without paying for it twice
- [13:56](https://youtu.be/QHBjufYK8TA?t=836) Should the orchestrator be the big or the small model
- [16:01](https://youtu.be/QHBjufYK8TA?t=961) In distribution versus out of distribution
- [19:12](https://youtu.be/QHBjufYK8TA?t=1152) Training models to collaborate
- [20:12](https://youtu.be/QHBjufYK8TA?t=1212) Flex Run and flexible model sizes
- [22:24](https://youtu.be/QHBjufYK8TA?t=1344) Lossy context and the systems you fall back to
- [26:41](https://youtu.be/QHBjufYK8TA?t=1601) How a heartbeat created the auto router
- [29:43](https://youtu.be/QHBjufYK8TA?t=1783) Routing between local and cloud
- [31:51](https://youtu.be/QHBjufYK8TA?t=1911) Compaction versus routing
- [32:55](https://youtu.be/QHBjufYK8TA?t=1975) How a small model signals it is out of its depth
- [35:00](https://youtu.be/QHBjufYK8TA?t=2100) Cache duration and self hosting economics
- [40:12](https://youtu.be/QHBjufYK8TA?t=2412) Are prompts portable across models
- [43:20](https://youtu.be/QHBjufYK8TA?t=2600) Is the router a product or plumbing

## Transcript

[0:01] [music] >> have been really exciting. We've tried to get a bunch of the industry leaders together to talk about some of the problems that are that we're facing as we try to run more on local. If you guys were here for the first

[0:22] panel, one of the things that we talked about was model routing. We firmly believe that we're in a multi-model world. I think you heard this from many of the panelists. Anyone who is deploying AI in production and who is doing so locally is seeing

[0:35] that multi-model world. That's why we released these NeMo Triton models at NVIDIA. Everything is released from the data sets to the weights with recipes so that you can customize them. We do that because we know that people customizing

[0:47] models is going to be huge. And so, this panel is really exciting cuz we're going to talk specifically about model routing. So, as you are picking which model to use, how does that how essentially how does that tooling itself look? Um, do you guys

[1:01] want to introduce yourselves? >> Yeah, sure. Um, I'm Walden. I'm the co-founder of Cognition. We build Devin, AI software engineer. Uh, in addition to the product, we spend a lot of time partnering with our customers to figure

[1:11] out how they should deploy these models uh and these agents. And one of the things they're constantly asking us nowadays is basically how do I know the ROI of our models and how do I know which tasks I can actually let our

[1:24] engineers spend the most expensive models on versus, you know, letting them use a more cost-efficient model. And so, that's why we're we're also thinking a lot more about multi-model model routing nowadays. >> Totally. >> Yeah. I'm Carter. You guys heard from me

[1:35] a little bit earlier, but if you weren't here, I'm a developer tech engineer at NVIDIA. And uh ultimately, I spend a lot of time thinking about how to get intelligence into as many developers' hands as possible. And uh something that

[1:47] is continually becoming a not an issue, but something that is top of mind for a lot of developers is uh as you use more intelligence and the frontier models get more expensive, uh it becomes somewhat cost prohibitive to to use the best uh

[2:00] tools, what feels like the best tools, as much as you would like to use them. And so, this has become a recent uh you know, focus is, how can we, you know, still get the same desired outputs, but actually uh both as an individual

[2:13] developer, but also imagine startups and small companies, how can you leverage this incredible tool without totally breaking the bank? >> Uh I'm Donne. I have worked on model evaluations uh both in terms of its accuracies and

[2:28] efficiency and cost understanding of the model. Uh and then I try and understand those implement those learnings and uh help build a router. So, it's basically my job is to understand the behavior of of the model on an intimate level and

[2:45] then use those learnings to both improve the model and try and design a system of model that can work together with each other. >> Totally. Um yeah, I love a lot of the research that you're doing at Nvidia as we kind of see the space through. I

[2:58] think what's really interesting is model routing itself is pretty new still. And so, what you'll notice is there isn't a very clear solution here. That was something that came up on the first panel is that there is a lot of space

[3:09] for startups and for companies in the ecosystem to fill in a solution here cuz we're still figuring out how to best do these patterns. And I think, Walden, I want to kind of ask you. So, um Cognition just released Fusion, your

[3:20] guys's model router. And when you guys released it, you in your blog said that you're actually getting better performance than Fable, um than these frontier models. And I feel like that was a very surprising statement to hear

[3:31] because we were thinking that you're getting as good or close enough usually when we're running on edge, when we're running local in these compute strained, smaller footprint models. But you guys are getting better. Can you explain how?

[3:43] >> Yeah, absolutely. Um so, I also want to be be clear about something here is like, you know, we're not saying that that we gap above Fable level performance in in the same way that maybe Fable level performance gaps above other models. I think actually

[3:55] there's this really unintuitive dynamic where smarter models actually get better and better at delegating work. And so one of the philosophies we had with building a model router is we don't want to route people to a dumber model and then

[4:10] suddenly you're stuck with a model that doesn't know how to do your task. Next thing you know you're you're switching yourself back to smarter model anyways and now taking that expensive cost. And in general we think a lot of the

[4:19] existing model routing systems out there are probably the same ones people have been using like a year ago. And so we really wanted to put out a new framework that actually lets people still feel like and and still have a

[4:30] frontier model in their system while getting all these like cost benefits. So yeah we we're reducing the cost of Fable level intelligence by 40%. The way we do that is we allow Fable to still do like the planning and the the hard decision

[4:43] making but delegate a lot of the work to an implementation model. And the implementation model can be you know one of these open source models be it a cheaper mini model. Um the unintuitive thing is even though it's cheaper

[4:54] because you're delegating the work to another model you can let that model go at the task with much more depth and intensity than you might otherwise. Like you can spin off like you know three sub agents to go and like explore the code

[5:05] base and maybe that's actually more comprehensive than if you had just let Fable explore the code base itself. So you're actually getting this like nice trade-off where it's both more cost efficient and it's also more comprehensive overall.

[5:15] >> Interesting. I see. So you're saying by using a bunch of smaller models you're essentially like for one example scouring the code base you can you you can explore it potentially better than if you were to just have one model

[5:26] I don't know figure out with what it's limited with its limited context with whatever path it's on. >> Yeah, totally. >> But also if you think about the budget of if you were to say the frontier model costs this amount per token and the

[5:38] smaller model is this amount per per token and it's significantly cheaper then you can use a lot more tokens from the smaller model with >> still within the budget that it would have been from the Frontier model. >> I would also like to encourage everyone

[5:50] to think there are jagged capabilities in most models, right? So, coding is not one domain. Within, let's say data visualization, there'll be scikit-learn, there'll be matplotlib, there'll be something else. It largely comes down comes down to the

[6:06] training corpora that went into each of the models, so right? So, one model, while you're trying to do X type of work, let's say data visualization, and the other type is Y, that means let's say model building. Let's say

[6:20] you're trying to have a data science work stream, where you're trying to optimize for some kind of prediction, and then visualizing your results. Within that task, different models will have different strengths. So, not it's not necessary

[6:35] that model A if scores higher on a coding benchmark, is just plain better at every task that is. So, routing is a task of intimately intimately understanding of behavior of and strengths and weaknesses of different models, and then applying them thusly,

[6:54] right? I would I would encourage everyone to think, "Hey, models are strong at different things, rather than like there's one model to rule them all." >> I see. And by the way, real quick, thank you Alex for joining. Yeah.

[7:05] >> Sorry I'm late. >> No. Oh, is that so? >> I might need yours in. Sorry I'm late. >> [laughter] >> I'm Alex from OpenRouter. Um thanks for having me now. >> Yeah, of course. Thank you so much. You came right from the airport, so this is

[7:16] perfect. I think um tonight that's that's super interesting. So, um the way that you're thinking through through model routing, it's not even just uh delegating to necessarily a smaller model, but like and maybe this is kind

[7:27] of what you're saying is can you can you put essentially a swarm of agents to accomplish the same task, and suddenly routing the task between them is is much is a is a problem to solve in and of itself. >> Yeah. So, if you look at like let's say

[7:38] let's take an easy example. Let's take a science or like scientific discovery as an example, right? Usually these are one-shot problems. It's incredibly hard. You have models think through this process, right? So, in that you have

[7:53] tons of sub-domains. Like tons and tons and tons. So, in that aspect, if you think about post-training like the post-training process of a model, they'd be tuned with different teachers. They'd be tuned on different sub-tasks.

[8:09] So, those those um those overlapping strengths will be readily apparent when you're trying to understand failures of each models on different different sub-tasks. Once you understand that, you can orchestrate your system to leverage that arbitrage

[8:25] essentially, and that essentially becomes free. So, I think this is on LM router bench. There was there are tons of benchmarks out there. But, if you use these techniques, you can get like up to 10% higher accuracy even, right? It depends

[8:39] on the model pool. Depends on the task at hand. But, I would encourage to think about the complementary nature of models. >> I see. Do you see so in kind of the way that you were describing the way that the task is broken up, do you see that the some of

[8:54] the smaller models because the token cost is cheaper, are they using more tokens? Like is it Are Are you specifically routing so that they do or that they so that they are chattier? >> Uh oh yeah, they absolutely do use more

[9:06] tokens. I I actually I want to kind of like riff on something that Tuhin was saying, which is like you know, a lot of times when you look at these different benchmarks, you'll see that the small models will perform better than like even the frontier

[9:17] models in certain cases. I think a lot of people they look at this and they immediately jump to, "Oh, how can we just route like, you know, the task where the small models do better just straight to the smaller models?" I I think that one of the

[9:29] things we really want to emphasize with our recent blog post and recent Devin Fusion was that this kind of like naive like initial routing to based on the task type is extremely fragile, especially the more agentic the task you

[9:42] you work on is. So, for example, like a real developer, you might ask your agent first, "Oh, how does this code base work?" And then you you go deeper and you're like, "Okay, actually, can you implement some features for me?" And

[9:51] then you go deeper and you're like, "Oh, can you like now go to like a live test of this feature and debug deep cases?" The complexity changes and the type of task changes over time, and you don't want to be left with some subpar model

[10:02] for the the task that you're now on. I think this is why people like frontier models so much is they're they're just like generally intelligent and they're capable of shifting between various different domains, even if you can eke

[10:13] out better performance in very specific tasks. Um, and and what So, the challenge is, how do you get a small model to know that it's out of its depth and you need to now like go switch to another model or go like, you know, go

[10:24] to a smart smarter model. And and our solution to this is you kind of just always have this like main frontier agent that's watching, even if it's not the one doing the work. It should at least be keeping tabs to figure out,

[10:34] "Okay, we like the the agent I delegated to now is like out of its depth. I need to kind of like move it to to something else." Um, and and overall, just the guarantee of always having frontier intelligence present, I think reduces

[10:45] the the fragility of of these systems quite a lot. >> How does the sharing of context between one of those smaller agents who has basically completed up to some level of a task and decides, "Actually, I don't think I'm the right person for this. I

[10:59] need to hand it back to the the foundational model." Um, of course, you don't want to have the entire trace of that >> Yeah. >> smaller agent be passed back to the larger model. But so, how do you get that level of specificity while

[11:11] basically providing the information it needs, but not more? >> Yeah, absolutely. So, I I I think like the the context here is it's actually very easy to actually create a system that's more expensive as soon as you're running like, you

[11:21] know, multiple models together cuz oh, no, like, you know, this one file reading. Now, every every one of these models is now reading this one file reading. So, now you're you're you're being charged like three times as much.

[11:30] Um, the the the the trick that we we spent a lot of our time on is um, most of the context by default will only be going to like one model. So, like most of the context let's say will be going to the small model. But, the thing

[11:40] you need to then tune very well is okay, like maybe you still show like what files it's reading, maybe you show like the high-level thinking of what it's doing back to the main model. Maybe you have the small model um, you tune its

[11:50] ability to present the context back to the main model. Um, and actually a lot of these problems already have been well studied in many domains already like context compaction is something you already have to solve if you want to do

[12:01] like really long-running agents. And so, this problem of taking long context compacting it in a way that is now understandable is the one that you can also apply to this domain and just kind of give the compacted context back to

[12:12] back to the main agent. >> Context compaction is something that you know, I'm familiar with but I hadn't really thought about as you're doing model routing and as you're trying to share context across now potentially many models, you're you're expanding the

[12:23] amount of what could be seen as wasteful tokens or redundant tokens just just because you have to process that across the many models. >> Yeah. Yeah. Um, I I I think there's the way I describe it is I think we are early in

[12:36] in the in the model routing domain. Um, I I I hope that a year from now that even the techniques we kind of use for Devin Fusion you people look back on that and are like, "Oh, these are some like really legacy ideas and and now we

[12:46] have like much better methods at routing between models." Um, and when people actually start co-designing their models with this in mind we're going to be be in a much better world. >> Yeah, I I echo what you said that um,

[12:59] I think routing will evolve as the task evolves when when you start task, right? So, um, it's more useful to see things in terms of subtasks and sessions uh, than individual problems that you're trying to solve because more than likely you're

[13:16] when you're working through a problem you're asking a lot of questions, you're you're exploring different things. Um, and it is imperative that you try like people who design routers is imperative that they try and understand these

[13:31] phases of different complexities and then try and apply some logic for essentially side kicking tasks or leveraging expertise from other models that's that's pretty on point. >> Yeah, I'd love to hear from the the router guy.

[13:51] >> [laughter] >> Yeah, um I think those are these are like important points and one of the biggest debates I think we have internally is whether that outer model that's doing the orchestration should be the big model or the small model.

[14:08] You get like very different results depending on your choice and in fact and it's not even clear what the pricing impact would be because if your outer model that's doing the orchestration is the big model it can leverage its caching to like make more

[14:21] of its decisions and it's caching is going to be like a dramatic price savings compared to the small models caching a lot of the time especially for like perform for you know issues that are on the bright line like zooming out a little bit I think the

[14:37] what you want from all the models out there when you do model fusion is to benefit from all the data that is being trained on across all the labs and and not just the data from one lab right or one source and a model is just like a

[14:54] combination of like the data and its understanding of the data both its compute and the quality of its RL so long term I think you want you want models where they know that oh this is like in distribution like this is in my data you

[15:14] can use small models pretty easily and get a cost savings but if it's out of distribution small models may actually increase your cost because of how often they'll like call tools and how crazy their loops will be. Like if

[15:26] you run terminal bench on Opus and Haiku, like Opus will do about three times better at 1/10 the cost of Haiku, even though Haiku's significantly cheaper per token. So it really becomes a huge problem if you use a too small of a model,

[15:45] particularly on tasks that are out of domain for the train data. When you're doing something like classifying text, like hey, is this like a person's name or is this an organization's name? That's super in domain. So you would you

[15:57] don't want that kind of task to go to a large model. You want it to go to a a small model. Everyone has that in their domain. Um so deep like being able to understand in domain, out of domain is a lot of work that we're doing for for um

[16:10] open router fusion. And uh and then also figuring out like what like how to orchestrate the outer and inner models um for different types of task. And like um yeah, it's it's an early industry. It's like an early field of research. Uh most

[16:25] research on model fusion has not been very detailed, not been very like, you know, optimistic sometimes. Um it's only like just, you know, recently getting uh more optimistic. And I think um I'm personally very optimistic about it. And

[16:40] uh you know, like we we're very like ecosystem-driven, collaborative company. And a lot of our like we work with a lot of partners to try like help improve their orchestration pipelines with good primitives, like the, you know,

[16:54] sub-agent and like the advisor tool, um which is kind of similar to what you were talking about. >> I'm curious. So uh help me understand when uh if a it makes total sense that um a small model, if it's in domain, would

[17:07] be cheaper. But if it's not, then it's going to thrash around uh as it tries to get an answer. When you're describing whether the uh con- like the main agent should be the the the local model or the cloud model? Does that is that a decision that's then

[17:24] dependent on whether the task is something that it that's in domain or not? Does my question kind of make sense? >> I don't know. Um, I basically I don't it's kind of early to >> um to say. I I think the I wait the results that we published,

[17:42] which are a couple weeks ago, which were focused on deep research, not coding. >> Mhm. >> Um we had the smart model be the wrapper model, be the outer model, and we got the best results from doing that. Um, but it for deep research it works the best. Um,

[18:02] for other tasks, it's like kind of unclear. Like we there it's fusion is not super well optimized for coding. And uh it might be that like a smaller model ends up being like a higher um efficiency per you know, fewer dollars

[18:18] um per like completed successfully completed task, but it's kind of early to say. >> Yeah. >> [clears throat] >> One thing you said earlier is like, oh, you get the caching benefit from like the main line agent. Um, you actually

[18:27] can get the caching benefit from the side agent. And um, this is actually one of the key things we talked about with our Devin fusion launch is that um, you kind of are leaving a lot on the table if you do a main agent and sub agents

[18:39] type system. Um, so we don't use sub agents. We use what we call a sidekick, which is um, one sub agent that continually has a running context. So the main agent doesn't need to re-provide uh, context from earlier. Um, it's all still in the KB cache, right?

[18:54] Like it's 10 times cheaper on on all those cache tokens. Um, and then if you want to like switch the smart model to be like the one on the side or the one in charge, um it's actually totally fine, and you can kind of like do do the

[19:06] swapping back and forth. We're also spending a lot of time right now thinking about how do you train models to actually work collaboratively with other models? I actually I think there's a lot of literature out there on how you RL one

[19:18] model to do a task end-to-end. How can you RL model to also be good at collaboration? And when we think about it, we actually try both of these setups where let's RL the model being the orchestrator and the one deciding what gets delegated to

[19:30] other models, see how well that performs. Um and we also orchestrate it in a way where the model we're training is actually the executor, the sidekick, and see how well is it at executing other models' instructions. Um and we expect that to to be a probably a

[19:45] big lift in this next step of like multi-model orchestration is don't just like take models as they are and orchestrate them, but like can you actually co-design your models with the orchestration system? >> Yeah, that makes sense. I mean, with

[19:54] Nemo Tron and you know, with all the foundational models where um we're essentially post-training them for the harnesses that they're getting used. If the harness is going to include a lot of routing, then that makes sense that

[20:03] makes its way in to the post-training. >> Yeah. Um are you guys thinking a lot about the kind of like the model training at at Nvidia for this kind of purposes? >> Yeah, so we have a technology called >> The mic's go? >> Right.

[20:18] >> Hello. >> Testing. Oh, this one works. >> [laughter] >> Okay. Uh so we have a technology called Flex Run. So you have uh we we have a setup where uh there's a the uh there's a main model, then we distill it into smaller uh footprints. And then based on

[20:37] the based on the task at hand, you can switch which model does the decoding. Right? So there's a lot of fancy stuff you can do uh within a model artifact, too. Uh to essentially only activate a class of model or a section of

[20:54] weights, depending on the task at hand or the complexity at hand. Most In most cases, you can essentially understand the novelty of a question to a model if you have access to the recipe with which it was trained. So, this works very well for

[21:12] open models, right? Like or any model you have access to its data for, right? Because you can literally decide if it's in like see if it's in distribution or not. Uh again, if you have studies from when it was trained, you can also see how much

[21:27] essentially how much was your distillation gap across teachers and the artifact that you trained, right? Because sure, you have domain data from all all the different domains you're tuning, but it's not guaranteed that it

[21:40] uh absorbed all the that data evenly across the models, right? So, um it becomes it becomes very interesting uh to start thinking about these flexible weights and flexible model sizes essentially. There's also I wanted to add with the

[21:58] context piece, right? So, how do you think about ASTs and and context compression representations? Uh compaction in its very nature is lossy, right? So, just like headroom is there, RTK is there, right? Uh these these spaces code bases are usually

[22:18] designed to have representations that we carry forward through life and you essentially give models the capability to further expand on them. It's it's more more like loss less-ish compression, which can retain states of

[22:33] a models or states of agents. What do you think about that? >> Yeah, I think this gets to like kind of like a fundamental philosophy of how agents and context should work. One exercise I like to do is like you know, as a human, like how many numbers can

[22:46] you like if I just start spitting out numbers now, right? Like how many can you remember before, you know, like you start losing track of them. I think it's actually very few, right? So, in some ways you could argue that your context

[22:55] window is actually shorter than these language models. And yet, you can actually be very effective at that, right? Your context is is very lossy. Um, I think one of the nice things that people are starting to realize with

[23:06] agents is like you have a lot of non-lossy systems that you can fall back to. So, you have a file system. Like uh if in your memory all your memory is that you read some file earlier, you don't need to remember the whole file.

[23:16] You maybe remember the important parts, but you can still have the full version of the file on your system. And that's kind of my goal when I'm thinking about how do we build a good context engineered harness is the harness should

[23:29] have everything in needs to find what it needs to have even if it doesn't have everything immediately available. >> In that case, uh do you think that the context sharing problem will become cheaper and less of a problem in future?

[23:45] >> Yeah, it's definitely possible as well. I've seen cases where um you know, the psychic agent does a bunch of work. It tells the main model, "Oh yeah, like here's here's all the things I found." Instead of dumping the full thing, it

[23:55] just references them by file. And then the main model is actually generally you find these larger, smarter models, they're actually more token efficient with how they use tools and how they read. And so, they actually read the

[24:06] files in a way where they only see the important parts, right? Or they decide that, "Oh, actually I only need to look at a subset of this." Or, "Oh, I can run a single command and just know if everything is done properly." Um, it's

[24:17] actually quite amazing um the fact that you know, these multi-model systems they actually seem to scale and get better with intelligence, which is um not something we should just take for granted, right? It's not obvious that actually more

[24:28] expensive models are actually creating an overall cheaper system. >> Yeah, like the scaling laws uh if you have a larger model, it's going to be more efficient with its tokens. Uh smaller models less efficient with its tokens.

[24:43] I guess I had a question for you, Alex. Uh do you guys uh like weigh more importance on uh the actual infrastructure side of routing? So, for instance, KV cache aware routing or uh like this where most of the businesses

[24:58] right now Uh or the are you seeing strong pull off like people actually deploying routers in production? >> So open router is a like a marketplace for language models. We we exist at like we can't see into the KV caches of

[25:19] models unless we're running them ourselves, which is pretty rare. Um we we we do spend a lot of time optimizing for cash hits and we we like pass through cash hits directly to users. Um but like in terms of KV cash optimizations we we we can't do any of

[25:36] like specific work there. What we do for um model routing is we we try to like find the best model or best combination of models for the prompt and then when we see a cash hit, we will will like use up the duration of the cash and send the

[25:56] downstream customer like the the full savings of the cash hit. Um there's more work that we can do here where we could say, okay, this looks like something where there's significant benefit to switching the model right now, but you haven't used up the full

[26:10] cash. You still have like 2 minutes left. Um and it we think it's probably worth switching the model and losing the rest of your cash um and letting people kind of like tweak their tolerance for that behavior. Um we've we've been doing

[26:26] a little bit of that, but we haven't like exposed it to customers yet. >> [clears throat] >> Awesome. >> What what is next for you guys in terms of your your your model routing? Cuz as you mentioned, you know, it is kind of like a different direction

[26:36] from like the the marketplace business that exists today. So I'd love to hear. >> So I mean we've been doing like we we've had a an auto router for like 2 years almost. Um but when we launched it, there was like no adoption of it. It was

[26:51] people really wanted to use specific models. Um and the the auto router just had like no real usage. It was it we mostly saw it as like a discovery play point. Like, hey, this is how you discover which model might be good for your prompt. And

[27:05] then um at around like January this year with open claw, it exploded. And the reason it exploded is because there's this fundamental um idiosyncrasy in open claw where it sends heartbeats every like 10 minutes to your model of choice just to see like

[27:29] if the you know, if the the the client was still active. >> [laughter] >> And that means that if you set Opus to be your default model, it would be like using a lot of tokens on this like heartbeat process. And so um this was the very beginning of like a

[27:42] very popular app with two completely different intelligence needs, completely different. And the models the open source models have improved to a point where like it makes sense to segment the market and at at least those two areas.

[27:57] And so that's that was how it got started. And then we saw a lot more segmentation blossom afterwards. And so um and now a whole bunch of agents and apps on open router use the the different routers that we have. We have

[28:10] a couple of them. We have Pareto code which gives you the Pareto Pareto optimal model for coding tasks given a certain like threshold that you can tune. Um we have fusion which orchestrates multiple models and gives you a fused

[28:24] result. And um and then we'll have other experiments in the future. What we want to do is basically like create good primitives that developers can use to like get really advanced with how they use model orchestration. Um

[28:40] kind of like sidecar sort of like that. Um but also give people like a really easy thing that they can just like set a slug to that works with all harnesses and just like gets the job done. >> I feel like it's super interesting how

[28:54] much of a perfect storm there is for model routing right now because on one hand, you know, ignore agents, ignore open claw for a second, like just to squeeze better performance, it seems like we should be smarter about how we

[29:05] tackle problems. That's obvious, right? If you make a plan, if you make a strategy, that's a that's a better way to to go about your day. So, I'm not surprised that you're going to see, you know, better code get written or more

[29:15] performing code get written and less buggy code get written if you break the problem down. And so, routing specifically for that uh use case makes a ton of sense. But then hearing this, yeah, like the profile of workloads

[29:26] changed with agents, right? They're very they it went from like I ask questions, I get a response, then it went to reasoning where I ask questions, it reasons, and then it comes back, and then it went to uh yeah, this heartbeat,

[29:37] right? Like if um if my agents are running optimally, uh there's a token being generated every second. Um and suddenly that is its own need for model routing, and it feels like um hearing the different solutions uh to kind of tackle

[29:50] each of those is very interesting. Even >> Well, I was just going to say I think that yeah, the the use cases for model routing are are there are many of them. And so, one could be getting a better answer, one could be, you know, saving

[30:03] money and trying to get the same answer. One that we haven't even talked about yet, which is probably the most relevant maybe even to this crowd, is uh when do you want to actually run a model locally versus when do you actually need

[30:15] something like a frontier model to to perform that task. And that might be something to the effect of like uh for privacy protecting information. You know, when I'm running some local, it can you detect that my prompt has

[30:27] sensitive information? And if so, do that on on device, um but then maybe even anonymize some of that information to go do the more advanced workloads up on top of that information in the cloud. Um another example would be again for

[30:40] the cost savings, but it's like, "Hey, I bought this DGX Spark and I'm not I know I'm not at 100% utilization. How can I make sure that as part of my workloads, whether it's the heartbeat and open claw or what have you, that I'm leveraging

[30:52] that compute um to the fullest of its ability because I'm only paying for the electrons that are coming in for my power bill, um but I'm paying full price for the tokens in the cloud?" And I think that's a whole other area of model

[31:03] routing that I know that we're doing some work with at NVIDIA um that I think will be will be really cool as it starts to uh the hybrid of local and cloud starts to to really emerge as its own sector. >> Yeah, I'd be curious to know what you

[31:15] guys take uh take is on. Like if you self-host a model, the cost dynamics change, right? You have a considerably higher cost at a higher context length because your throughput slows down as the context gets deeper. So, rather than

[31:29] switching to a cheaper model, even if you have self-hosted models in data center, you can use compaction uh to bring your throughput back up. Uh have you guys uh thought about this part of it? Like compaction versus uh just routing because one is you have

[31:46] fewer tokens to work with. One is we have cheaper tokens. >> Yeah, I I think in practice um compacting alone doesn't solve the the cost or or throughput problems because a lot of times it's just like the uh the differential in like model

[32:00] intelligence and cost is just so big where also by the way, when you compact, you're taking a cache miss. So, you're actually then now like paying 10 times as much for the for those input tokens if you didn't compact. Um the main

[32:10] reason we compact is actually intelligence. Um all all these like multipliers they advertise some like insane context window, like a million tokens. Uh I would like never recommend using like these models past like 200K tokens,

[32:20] under 100K if you can. Um the the the intelligence uh just kind of like falls off a cliff at some point. Um sorry, Anthropic if you're if you're watching. But I I think that uh you know, compaction is like a very useful tool if

[32:33] you are going to have to take a cache miss anyway um one way or another, like when you're routing to another model and you want to just like minimize the the window there. >> Do you find that, um, in the sidecar, >> Yeah.

[32:47] >> um, when small models are generating lots of tokens, um, is that like an is that like one of the best reasons to switch it to a larger model? Like, basically, when when small models generate lots of tokens, I wonder if that's like a

[33:03] box of root the root cause of of intelligence problems down the road. You want your big model to generate the big token chunks, the small models to generate smaller token chunks, right? >> that question, you mentioned like a

[33:15] small model essentially needing to flag that it needs help from the larger model. What is that mechanism? Cuz that seems like the what's the indicator and then what's the mechanism for it to do so? >> Yeah, totally. Uh, so there are a lot of

[33:26] mechanisms we we talk about in our blog post about how uh we just detect that we need to like change the model up. Um, to to uh I guess to answer your question first, how does the the small model detect? Um, actually, the the thing that

[33:38] we spend a lot of time on is, um, how do we make sure the small model is like good at detecting it. Unfortunately, there's a lot of cases where you do need the big model to detect it. Um, one thing that we could don't go into the

[33:48] blog post is, um, you have some kind of cadence on which you're refreshing the cache anyways, cuz by default there's some like 5-minute lifetime on these caches. If you're going to go refresh a cache anyways, you basically can get a

[33:59] free like big like frontier model call uh if you kind of like ask the right question. So, it's at that point where you might say, "Hey, just take a look at what the small model is doing. Does it feel like it's kind of like going into

[34:09] some rabbit hole and and need some help now?" Um, >> What's the need for the 5-minute refresh? >> Uh, it's just like a practical like you you you have to pay some kind of like cost to like keep these like KV cache caches warm. Um, and so most caches just

[34:23] get evicted on some kind of cadence. >> works is like at inference time you only have so many so many cache you can keep kept loaded in the GPU. So, once if a cache is not being used again and again, it's offloaded. >> I see.

[34:35] >> So, it's lost essentially. So, that's why the inference provider asks you for money. Uh but if you self-hosted, you can get around this problem. You can you can make it as long as you want based on your big business logic.

[34:48] >> But do do you see a world where we'll have like much more dynamic cache durations rather than just the 5-minute, 1-hour? >> It depends on who's do who's deploying the model where, right? So, if you have a GPU which has

[35:06] like a lot of memory uh which like the ratio of let's say SCMs to memory is memory more heavily skewed or if you're working with unified memory uh and you have systems like where I Rubin, uh you you have a lot of tricks to play

[35:21] here, right? Uh the 5-minute uh window is what a lot of providers right now put, but that's uh that's that's more an operational operational operational determination rather than a like a science-based or like a core physics law determination.

[35:40] So, you can technically see over time maybe some uh some APIs are priced differently, uh but uh if you do self-deploy again, you can you can get past a lot of this. The the cost economics really change when you move from self-hosted models to uh

[36:00] API providers uh because you have a lot more control and uh you don't have to guess the shape of your workload. So, let's say if your workload is 32K uh like on average 32K cache, 1K input, 1K output, uh and someone else's like let's say 64K uh

[36:20] 1K 1K, uh if you use some provider, they are amortizing everyone's use uh use case and then giving you a price, right? And they have optimized, quote and quote, for general use. If you self-host, you can optimize specifically

[36:35] for your use, and you'll likely pay much less. >> Yeah. This is like kind of like the level of like, you know, hardware-software frontier that we kind of like think about. When When we started Cognition, we were working on

[36:47] the first agents, I think one reason why no one else worked on agents is they were just extremely expensive. This was before cash tokens was a thing that API providers paid for. Like if you were sending 100,000 tokens and the same

[36:59] 100,000 tokens, you were paying full price for those tokens back in 2024 when we started. One of the key things that let us build Devin and build these first agents was we actually bought direct compute capacity from these providers, and

[37:13] instead of paying on a per-token basis, we just paid for the underlying compute, knowing that the economics of the compute was that we were actually paying far less for for the cash tokens that we'd send over. Um And And then nowadays, you know, that uh

[37:25] you know, there's there's like similar, you know, things I would like about like, you know, having a version of the cache that maybe like you can just back out to like storage in S3 or something and just like hold for much longer.

[37:34] >> Yeah. Now, this is not extremely relevant to a DGX organization like setup, but if anyone's looking to do what you guys have wanted to try out Dynamo. We have a lot of pre-fixed cache optimizations in there. >> Yeah.

[37:49] Um And then going back to your question, Alex, I think you said like, "Oh, like you When a small model is going off and generating a ton of tokens, is that like a interesting time to back off?" Um to be honest, we haven't explored that

[38:00] right yet. So, that that might actually be a very interesting thing to to take a look at. Um It It is weird. I think like some small models do tend to kind of be less like token efficient than others, but um they also seem to be trained on

[38:11] like their own traces, so maybe in a way it ends up like balancing out. A lot of these things I I feel like we have to be like very empirical about to actually know. >> So, uh just to add on that um um you have a lot of like these days there

[38:26] are a lot of hallucination probes. So, probes that work on either the internal state like internal state of the models directly. So, you can have some form of either magnitude analysis done or linear probes or just uh the end types of

[38:44] probes that you can see and you can essentially rate like how how much you think is is tending towards hallucination. Uh so, that kind of gives you a proxy for how lost it is. Uh like how lost a model is in its thinking. Uh so, you can use like

[39:01] different kinds of probes to understand like the perplexity within a model. >> Well, that's interesting. So, yeah, instead of using the quantity of tokens that are as indicative of a of a model being lost, it's the it's hallucinating

[39:12] more and you're >> Yeah, so uh so, essentially what is cache, right? It's It's the prefill It's the prefill stage, right? So, you What is a prefill stage? It's just a vector at the end of the day. So, you can do tune all kinds of classifiers to

[39:27] understand uh different aspects of those collections of vectors. So, with those kind of probes, you can guesstimate a lot of uh states of a model. >> I see. One One question I have is um you know, different models behave uh

[39:46] differently and um the kind of means that these prompts aren't portable. So, as you're doing model routing, how do you handle essentially if you're if you're going to a different model architecture, um what do you have to do to the prompts

[39:58] and how much is that a factor into either of you guys' model routing solution? >> Like what like how how is the prompt itself a factor in the in the routing? >> Yeah. >> Yeah, um well, I think with building agents, there are all

[40:14] kinds of paper cuts and edge cases that are domain-specific and like the value of an agent company like the value of Devin is all these like doom loops that you've discovered that are across all industries and the best ways to recover from them

[40:33] and like man here I mean it manifests big time in what the prompts are going to be both for like you know how the the advisor model gets called um uh you know the smart friend >> [laughter] >> the how the like subtask agents get

[40:50] called and and the best thing is that like anyone can like like any engineer or any like agent can inspect the traces and like adjust the prompt and then see the like live accuracy long time. So I mean basically I just think that that's part

[41:05] the prompt is part of the the startup building process and is also really easy to observe and like and have and have like multiple people and agents collaborating on them. >> Yeah. One thing I'd love to do with our fusion product and we don't have this

[41:20] yet and so this is kind of maybe a preview of some some things we work on is you know you can tune it against a data set but the the real thing you want when you're building a real agent someone uses is just like tune it

[41:30] against what actual people use it for and and what actual models they get routed to. And so there's a lot of signals for this like if if someone sends a prompt and then Devin is working and then you see that the user decides themselves like

[41:42] upgrade to a different model or they decide to downgrade or the system detects that we originally sent to the wrong one we now got to replace. Like that's actually a really useful stream of signals and we're actually getting

[41:51] into this world of like auto research where like maybe we can just have like a constant stream of prompts what it should have been what it was instead and build a system internally that's just capturing all of this and then

[42:03] reiterating on our routing system until it eventually kind of like fits the real production data. Um that's kind of like now that we it's it's it's public and and people are using it, this is now something that we're we're thinking

[42:13] about. >> Have you guys looked into prompt tuning and do you find it useful like say Japa? >> Yeah, so there are like these prompt tuning frameworks from like a few years ago that tried to do some kind of like gradient descent type thing.

[42:29] I'm like I'm actually personally less bullish on these kind of like low level mechanical prompt tuning harnesses versus just telling like a smart model like here is the decision that was made and the context figure out why it went wrong. Sometimes

[42:47] you can do something as dumb as asking the model why did you do this instead of this and cite the prompts and then just have your agent your dev and just go and update the prompts, rerun the the test as a regression, make

[42:57] sure make sure it changes. Like it's a lot heavier weight of a system, but I kind of trust the intelligence of a system like that a lot more. >> So we're we're running out of time, so we're going to wrap up real quick, but I

[43:07] think what's really interesting is just from talking to you guys, we can kind of see how new this space is, right? How much of this is actually just research. We're starting to see new products come in. I'm really excited about your guys'

[43:18] solutions as you guys enter the space. The the ways and the needs that you need routing for, you know, even on a DGX Spark when you're doing local inference, you have more compute and if the memory is filled, one or if it's if the memory utilization is

[43:32] high, one thing you need to do is increase the compute utilization. And so one way you can do that is by spawning multiple agents that are working collaboratively. So that collaborative piece is something that not only is

[43:41] optimal for all of these cloud workloads that you guys are doing, but but specifically that is how you extract more performance out of this edge hardware. And I think um you know, a question here is and maybe to to end on is a router going

[43:55] to be something that we see as a product or is that going to be seen as part of the plumbing here? Are models going to get good at routing to other models because they know they need to be collaborative or or harnesses going to

[44:06] know that they are working across multiple models. >> I think we already see this. Like you know, at Cognition we're training our models to be able to be good collaborators. I think it's very clear that new frontier models like the Fable

[44:20] models and GPT-5.5 and 5.6 models are like themselves like naturally collaborative and and better at delegation. So I think we're ready there at that point. >> Interesting. >> Yeah, I I think that the systems are are kind of becoming not muddied in some

[44:33] sense, but I think that ultimately we're understanding that as we step up the the abstraction ladder and build more more things to create this smarter blob, which obviously we should hopefully and we do understand how we're building it

[44:46] and why we're building it, that it's going to it's going to become a system that you look at kind of both the the different components of the system, but it's not just going to be just models. There's not going to There's not going

[44:57] to be a thing as like a really great harness that is in absence of a really great model and vice versa. >> Yeah. Makes sense. >> I think applications, especially as built on non-deterministic systems like models, operate in a very low-trust environment.

[45:15] So yes, most of the improvements will likely be distributed across both models and the harnesses, but I think overall it's it's it's mostly it's There There will There will have to be some form of controller trying to have some form of

[45:32] arbitration because even from the model perspective you aren't in a perfectly visible world. You don't know the behavior of every model, so it's it's going to be at the orchestration level where you have these kind of things. And this has traditionally been

[45:46] shown by other industries like when web when web launched, you know, you had traffic-based routing. So it's different. But all the sort of routing controls have been centralized over time. >> Makes sense. >> I I it's most likely going to be good

[46:03] news in the future. Um and and I I think like caching is a big reason for that. Even if you I think like a to take the flip side of of this argument, um the you know, it might be that in the future we have like one big model that's

[46:18] like, "I know I am the like most efficient at everything and I'm like way more efficient than Haiku. I'll solve every task better than Haiku can at like a lower price. Um why should I ever delegate to Haiku?" There's something like that actually

[46:33] could could be a model that we have in the future. Um but you're always going to have these like, you know, for example, caching. It could be that like you tell the model that this other model like does have the right context in cash and uh you know,

[46:49] the the orchestrator model just always has more context and the models have to be aligned. So, I I think like it's I I don't really see a world where like we wouldn't be able to get models to collaborate really well and and I think

[47:01] they're going to get better over time. Um in part because they're you know, they just have limited memory. So, I I think that's kind of one one deciding factor and another is that um there will be like uh there will continue to be

[47:19] like if you just look at like the the the rankings on OpenRouter, if you look at our our public data and you look at like the top model being used by dollar spent on classification tasks, well, guess what it is. It's Opus.

[47:35] >> [laughter] >> I think there are there are there are big opportunities for like using small models for in distribution easy tasks and the and like as time goes on, that's going to be a larger and larger percentage of tasks relative to like the

[47:49] most valuable tasks that um very smart models spend most of their time on. >> Totally. Well, I want to thank you guys so much. Can we all give everyone a round of applause? Thank you. >> [applause] [music]
