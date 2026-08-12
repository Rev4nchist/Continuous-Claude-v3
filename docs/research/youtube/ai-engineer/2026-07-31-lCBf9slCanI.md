---
video_id: lCBf9slCanI
title: "Ending AI Slop — Thais Castello Branco, Taste Labs"
channel: "AI Engineer"
channel_id: UCLKPca3kwwd-B59HNr-_lvA
channel_slug: ai-engineer
url: "https://www.youtube.com/watch?v=lCBf9slCanI"
upload_date: 2026-07-31
duration_s: 990
duration: 16:30
view_count: 4979
like_count: 132
subtitle_lang: en-orig
transcript_source: auto
transcript_words: 3372
ingested_at: 2026-08-06T11:00:33.788Z
ingest_version: 1
---

# Ending AI Slop — Thais Castello Branco, Taste Labs
**Channel:** AI Engineer · **Uploaded:** 2026-07-31 · **Duration:** 16:30 · **Views:** 4,979  
**Watch:** https://www.youtube.com/watch?v=lCBf9slCanI

## Description

Thais Castello Branco's starting point is that AI is still badly behind on the subjective work, the writing and design where quality is real but hard to pin down, and that ending the slop means building data and reinforcement environments for taste. She sorts domains along a spectrum: at one end things that verify and execute cleanly, at the other pure preference with no ground truth, and most valuable work sits in between. The move that makes taste tractable is decomposition, breaking something like a brand or a page into elements that can each be graded against an original rather than judged whole.

The deeper problem she names is collapse to the mean. A model optimizing for the most likely output drifts toward the average and quietly kills the creativity that good design depends on, so the goal is data and rewards that reward breaking from the obvious when the situation calls for it. Taste Labs builds this by turning expert judgment into structured, high signal preference data, pairing it with human QA where reviewers tie their commentary to specific choices, and being careful that preference signal stays rich instead of noisy. Her argument is that as more subjective domains become measurable this way, taste becomes something you can actually train.

Speaker info:
- https://x.com/thaiscbranco_
- https://www.linkedin.com/in/thais-castello-branco/

Timestamps:
0:00 - What ending AI slop means
1:06 - Working with frontier labs on taste
2:33 - The verifiable to preference spectrum
3:38 - Decomposing design to grade it
5:30 - Verifying whether something is on brand
7:40 - Collapse to the mean
9:18 - Shifting preference toward verifiable
11:25 - Building a preference vector
13:05 - Human QA tied to specific choices
15:00 - Training taste in subjective domains

## Chapters

- [0:00](https://youtu.be/lCBf9slCanI?t=0) What ending AI slop means
- [1:06](https://youtu.be/lCBf9slCanI?t=66) Working with frontier labs on taste
- [2:33](https://youtu.be/lCBf9slCanI?t=153) The verifiable to preference spectrum
- [3:38](https://youtu.be/lCBf9slCanI?t=218) Decomposing design to grade it
- [5:30](https://youtu.be/lCBf9slCanI?t=330) Verifying whether something is on brand
- [7:40](https://youtu.be/lCBf9slCanI?t=460) Collapse to the mean
- [9:18](https://youtu.be/lCBf9slCanI?t=558) Shifting preference toward verifiable
- [11:25](https://youtu.be/lCBf9slCanI?t=685) Building a preference vector
- [13:05](https://youtu.be/lCBf9slCanI?t=785) Human QA tied to specific choices
- [15:00](https://youtu.be/lCBf9slCanI?t=900) Training taste in subjective domains

## Transcript

[0:13] Hello everyone. It's great to meet you all. I'm Tais. I'm the founder of Taste Labs. For those of you who don't know us, we came out of Stealth a few weeks ago. Uh, and our whole mission is basically how do we end AI slop? And we believe that to really

[0:29] solve this problem, we have to first decompose and understand subjective domains. Right? I think as probably all of you know, AI has gotten quite good at things like coding and math. Uh but it's still super behind on things like

[0:40] design, creative writing, personality, emotional intelligence. And to understand these domains, I think we have to take a little bit of a different approach than we do with um with objective ones. So our idea is like how

[0:52] do we become this data and infrastructure layer to really uh understand these problems and to become the solution for them across the stack. So from the foundation model layer all the way to how do we build solutions for

[1:02] agents as well. So we work primarily in two ways. We work with the top frontier labs on how do we evaluate benchmark their models understand where they're breaking uh understand how we can fix them and how do we determine also which

[1:16] problem is better fixed through each method. So what things should be turned into RL environments, which things should be turned into post- training data problems. Um, but then we also go and work with a lot of agent and

[1:26] application layer companies on what are things that we actually don't believe should be solved at the foundation model layer and that might be better solved through methods like context uh or understanding user intent. Right? We're

[1:37] basically betting on a world where suddenly you're going to have billions of people creating uh that are not necessarily experts. So this understanding of user intent and contest and context is equally as important as how do we get these models to improve.

[1:49] For today I'm going to focus on the model training part. For those that are here tomorrow I'll also be giving a chat on the design track where I'll cover more on what we're doing on the agent side of the house. But there we go.

[2:01] Okay. So most of the world is subjective as I was mentioning. Uh a lot of the world is subjective right? If we talk about these domains of writing even workflows within companies right of sales marketing uh a lot of the times

[2:12] there's this multitude of answers there's not one clear right answer and it's very hard to define what great even means I think at the end of the day like those are why these domains are so difficult um and we oftentimes I would

[2:25] say forget to mention like why uh we treat for example the fact that code is verifiable and measurable as something that is a property about models and models are great at at coding um because we've made them great at coding but

[2:42] realistically it's actually a fact about code. Code is something that decomposes, it verifies, it executes and so it makes it a lot easier for us to be able to train on these domains for something like design or writing like how do you

[2:53] decompose it? How do you verify it? How do you judge if it's actually good? So that's why they become so difficult. Um, so there's two characteristics that I want to touch on today on why fundamentally subjective domains are

[3:04] harder. One is that capability follows measurability. So if we can solve the measurability problem or at least part of it, then we can solve a big portion of these domains. Uh the second which I'll touch on later is basically this

[3:16] like collapse to the mean and why the mean is not necessarily optimal in subjective domains. Okay. So to really start solving this problem, we have to turn something that feels fuzzy like if I ask you what is great design into something that is more

[3:40] verifiable. So there's a few questions here, right? Because if I ask you this of what is great design um you could ask yourself, okay, um do you mean great for which type of person, for which type of taste, for which situation? The same

[3:53] slide could be amazing. for example, if you are a startup and completely inappropriate if you are a finance firm. So it's contextual first of all. Second of all, it has this property that it changes over time which is different

[4:05] from other domains. What is considered good today is different than five years ago and different than five years from now. In code that's not necessarily true or in math, right? That's something that is way more consistent over time. So our

[4:15] ability to again decompose it and understand how is this good for a specific audience, how is this good today, how is this good in context um is some of the things that we've been thinking about in terms of how to how to

[4:26] break this down. But I want to give you a very specific example because of course this can mean many things. So let's talk about brand. Um if you're at a company and you've used coding agents, you've probably shipped an internal

[4:36] dashboard. You've probably shipped an internal like landing page. And oftentimes you might wonder, okay, how do I determine if this is slop, if this is actually good? And you have kind of this secret weapon at your disposal,

[4:48] which is really all the work that probably designers at your companies, for example, put into defining your brand. A brand to define takes a lot of effort, takes a lot of care. You're defining all these components about it,

[4:57] when it's good, why you're choosing certain combinations of colors, of typography, of spacing, of texture. Um, but if I just ask you to be like, okay, create something great, that's very hard. But suddenly if I'm like okay make

[5:09] something that is on brand that is a much easier problem to define and a brand is something that can become decomposable. Uh so for example if we I'm using the reduct brand as an example here because I I I like their website.

[5:19] Um let's say that we decompose this brand into the colors, the typography, the motion, the animation, the textures. Suddenly you have these very codified things that you can verify against. Verifying in general if something's on

[5:32] brand and you can try this uh by prompting an LLM as a judge to do it is quite hard. But once you start picking apart the exact elements that represent what great is, then it suddenly becomes the shape of something that is

[5:44] codifiable and verifiable. So if you want to turn this into a shape of an RL environment, for example, right, how would you train a model for a capability like brand adurance? Uh LLM LLM as a judge might not necessarily

[5:58] always be the best method. We know that there's a lot of reward hacking. We know that there's uh interesting hallucination patterns there too. And so we oftentimes try to create methods of basically how do we turn a task that

[6:08] feels fuzzy into one where there's a clear ground truth so that it can become the shape of an environment. So in this case the task design itself is really kind of the hardest part of the problem of how do you turn something that

[6:20] appears very fuzzy into something that actually can be arled. Um and so in this case that decomposition that I mentioned becomes the ground truth. So let's say that you start by tasking an agent to create a new page that is going to

[6:31] adhere to the reductal brand but be completely net new and different. Um you would want that output to not only be graded versus the original but to be graded on this ground truth, right? Because it could come up with completely

[6:42] new ways of using these components that are still valid but are different from the original. So you don't necessarily want to just see if it's replicating the original. So this is one example of like how to turn this into a problem of

[6:53] environment shaped um so that we can make it more verifiable. But in a way all of these things are I would say like spectrums right you have uh in a problem like design you have these elements of things like vision uh alignment

[7:07] typography that are closer to objective once you start moving up that scale onto things like style fit creativity how do you judge and measure something like creativity right that's much harder and so you kind of need to think of this as

[7:20] like a routing problem of how do you understand this like vast fuzzy problem break it down into smaller components and what is the best solution for each of these components. So why does something feel like slop? For example, when we're talking about

[7:33] something like creativity, right? I think this is the second reason why um subductive domains are so much harder to solve because if we're talking about the properties of models, they're basically predicting what's the most likely

[7:44] outcome to show up next. And they assume that that outcome is the ideal outcome. And for something like math encoding, that is true, right? You want the answer that your model gives you to be the average answer. If you're asking what 2

[7:56] plus 2 is, uh, which also happens to be the right answer and the optimal answer. But for something like writing or design, you don't necessarily want the average answer, right? The average meaning the most likely does not

[8:07] necessarily coincide with like the optimal. Uh, a lot of like what I describe it is a lot of greatness and creativity happens actually at the ends of the distribution. It's not the most likely outcome. It's when you actually

[8:18] actively break from rules and actively break from patterns that you can create things that are subjective and and great. Um, and so the reason why this feels like slop and that we have this feeling that we're surrounded by by slop

[8:30] is exactly because of this collapse to the mean and this repetition. And so we have to find ways of okay, how do we break these patterns? How do we break from the mean uh but in a way that's also intentional. So then you kind of

[8:41] shift the problem onto things that are not so easily maybe verifiable. Uh but that are more questions of human preference and judgment and that might be better solved by data for example than by environments. And so again this

[8:53] kind of like mode collapse is is really the thing that we're trying to solve. And how do we force that distribution back? Uh, oftentimes, by the way, we we work, for example, with a community of designers, um, over like a thousand

[9:04] experts that are experts in different types of medium, different styles, and we purposely want to force that distribution when we're breaking down the problem. Exactly. So, we don't end up in this mode collapse, but there's of

[9:15] course a lot of other pieces of that puzzle. Uh, but I think this is an interesting framework is like the closer you are to something that it becomes verifiable, especially programmatically, the better for something like RL, right?

[9:26] And I think the challenge is how do we turn things that feel fuzzy into things that become more verifiable by establishing this ground truth and designing tasks in a way that allow for that. But then the more that it does

[9:37] shift to things that are contextual or that depend on that time element that we talked about or this like distinction in preference, the more this shifts towards something that requires human judgment. So uh I I I like this analogy of

[9:51] basically kind of pulling things toward verification. So brand adherance on its own would be something that's very hard and that is probably better judged by a human than for example by an LLM as a judge or something deterministic. But by

[10:03] codifying it by understanding which pieces matter and how do I turn that into something that is observable and measurable we can kind of pull it into this realm of verification. uh so this routing logic is I would say if you have

[10:15] one takeaway uh take this away it's like how do we break down this problem into something that you understand what's actually the best method to solve it and so when we are talking about these things that are more subjective uh we do

[10:28] require human judgment I think this is something that we um we believe human judgment is still at a much higher level than any LLM as a judge and this like human taste is really how do we encapsulate this in a way that uh can be turned into high

[10:43] quality data so that we can train these models better. And I think one of the tricky things here is often times in the past you had kind of this uh collection of preference data that would collapse again to the mean because you would

[10:54] collect it from a bunch of different people without necessarily understanding who they are, what they like, why they like it, when they like it. And if you don't break up that problem accordingly, you then end up again with preferences

[11:05] that kind of don't agree with each other. Because that naturally happens in the world, right? I bet that some of you might like one style better than another. And that doesn't mean either of those things are wrong or it doesn't

[11:13] mean that the best answer is the average of what two people might like. It means that we need to fundamentally understand that the world is multi-preference and how do we do that matching accordingly. So this almost like understanding of how

[11:25] do we create like a preference vector let's say for someone and attach that to even something like preference data can help us to train in a way that allows for that more pluralism of preferences intentionally instead of that data being

[11:37] turned into something that's noisy. when we talk about data quality as well for these domains, I think it becomes very uh I don't know if any of you have bought data for example for these domains or or have tried to curate data

[11:49] yourselves. Um but there's it's very hard to define okay like now I'm realming to the side of data. What is actually good? What is actually going to be helpful to my model? Um and there's obviously a few things that are harder

[12:00] to define but a few that I think become more controllable and how do we actually understand patterns of quality so that we can measure them. So one I would say is that problem decomposition. How do we force like true distributions of what

[12:11] you see in the world? How do you force true like expert selection across these u different buckets? And these are things that you can totally control, right? You can see who those experts are. You can do a selection pattern that

[12:21] is very strict um and you can decompose that problem and this is something that is completely in your control and that totally helps with the um results let's say of the experiment being being good. Um the second is I would say that like

[12:36] flow of like how do you determine then the right problem routeed to the right solution. Um we also I would say do a lot of what we call essentially like QA on this data and I think there's two ways to do that is understanding what are properties about

[12:50] that data point that correlate with being it being rich and high signal. So for example, specificity when you're trying to ask an expert to define is this good, is this bad or put reasoning behind it or create a whole observation

[13:05] system around uh how they would judge an asset. The specificity of their language and of how precise they're being able to be with how they're doing that description is what will determine that data quality. Or for example, if you can

[13:18] tie their commentary with actually which piece in the code does this relate to. Like let's say you have an expert that's judging a landing page. Uh they might be able to just like write a paragraph describing this. But we know that models

[13:31] have a tricky time kind of actually connecting the piece of the code to the visual. And so if you can find for example a method to tie that exact code component to the commentary of the expert, suddenly you have data that is

[13:42] way less noisy and way more clear. So these are some things that we can do both in terms of the flow of how you connect the data uh of how you collect the data but also in these like QA checks of how do you determine characteristics about it that will uh

[13:55] correlate highly let's say with with valuable data and same with human QA. I think by the way human QA is tricky here because there's two sides to it. There is a side of for example let's say you're collecting uh a bunch of

[14:06] preference data about slide design. Um you could have human QA be like okay is this again high quality data is the following the specs which most people would agree on but suddenly if you ask for expert consensus and you

[14:20] try to have another expert see if they agree with the initial designers like votes you might start seeing some disagreement there and you I think the key is understanding is that disagreement something that's actually a flaw in the data meaning are they for

[14:34] example disagreeing on something that they should be agreeing on such as alignment like alignment is something that's pretty objective So it would be kind of odd to see experts disagreeing on that front. But suddenly if they're

[14:44] disagreeing on things like sty style or um aesthetics that is not necessarily bad data that's actually good data. It shows you that there is a distinction for what people like. And so uh this almost like analysis of how do you run

[14:58] human QA in a way that both screens for kind of the fundamentals but then when you use consensus I think in an intentional way is another big big piece of this. Um and then obviously kind of seeing actually how this data is is

[15:09] interacting with models. Uh we run a lot of research on our side. Obviously when you're interacting with labs as we do um it there's a lot more involved and we oftentimes don't get that feedback loop of exactly what affected this cause

[15:21] which is why we're so adamant on focusing on these things we can control in terms of data quality because these are things that uh we can completely measure on on our side. Um so I think one other uh piece of advice or message

[15:35] of the day is I think especially when it comes to subjective domains I would advocate for a quality over quantity approach. I think creating high quality data is expensive. It's difficult. It takes a lot of understanding and depth around a

[15:50] specific domain. and having that be incredibly high quality done by people that also are incredibly high taste or whatever you want to call it in that domain uh yield far better results than getting a bunch of noisy data or a bunch

[16:01] of messy data uh that was not necessarily intentional or didn't have all those things we talked about of like the problem breakdown. So that is my my message of of the day. Thank you. >> [music]
