---
video_id: wpOA-UXynoM
title: "How Forward Deployed Engineering is done at Factory — Eno Reyes"
channel: "AI Engineer"
channel_id: UCLKPca3kwwd-B59HNr-_lvA
channel_slug: ai-engineer
url: "https://www.youtube.com/watch?v=wpOA-UXynoM"
upload_date: 2026-07-28
duration_s: 1281
duration: 21:21
view_count: 4028
like_count: 92
subtitle_lang: en-orig
transcript_source: auto
transcript_words: 3825
ingested_at: 2026-08-06T03:12:08.205Z
ingest_version: 1
---

# How Forward Deployed Engineering is done at Factory — Eno Reyes
**Channel:** AI Engineer · **Uploaded:** 2026-07-28 · **Duration:** 21:21 · **Views:** 4,028  
**Watch:** https://www.youtube.com/watch?v=wpOA-UXynoM

## Description

Factory's forward deployed engineers sit at the tip of the product, embedded with the largest customers and piping a constant stream of real world signals back into how the agent, Droid, gets built. Eno Reyes frames the whole thing as a software factory: signals flow in from the outside, become plans, pass through validation stages, and come out as shipped outcomes, a loop most orgs run badly until they actually invest in the system around it. The non negotiable piece is a model independent harness the customer owns, so the traces and the data stay theirs and Droid can even run air gapped inside their environment.

The frontier is autonomy. Factory scores a codebase on how agent ready it is, whether it runs linters and type checkers and how much of the work an agent can finish and verify without a human, and the payoff shows up on jobs like migrating 30 to 50 million line equities systems at a bank. Push too hard, though, and you hit the trap Eno Reyes borrows from city planning: an exemplar city built too far ahead of its time becomes a theme park, not a place people live. So the forward deployed job is a balancing act, moving customers up the autonomy curve fast enough to matter but not so fast that nothing holds, which is why the role now leans as much on business judgment as on engineering.

Speaker info:
- https://x.com/EnoReyes
- https://www.linkedin.com/in/enoreyes/
- https://enoreyes.com/

Timestamps:
0:00 - Introduction: where forward deployed sits
2:08 - The role inside the customer's environment
3:49 - The tip of the spear of the product
5:03 - The software factory: signals in, outcomes out
6:57 - Why you own the agent harness
8:11 - Air gapping Droid inside the customer
10:08 - The autonomy maturity model
12:05 - Making a codebase agent ready
14:53 - Migrating 40 million line codebases
16:38 - The city of the future analogy
18:34 - Constrained autonomy and legal droid
20:04 - Redefining the forward deployed role

## Chapters

- [0:00](https://youtu.be/wpOA-UXynoM?t=0) Introduction: where forward deployed sits
- [2:08](https://youtu.be/wpOA-UXynoM?t=128) The role inside the customer's environment
- [3:49](https://youtu.be/wpOA-UXynoM?t=229) The tip of the spear of the product
- [5:03](https://youtu.be/wpOA-UXynoM?t=303) The software factory: signals in, outcomes out
- [6:57](https://youtu.be/wpOA-UXynoM?t=417) Why you own the agent harness
- [8:11](https://youtu.be/wpOA-UXynoM?t=491) Air gapping Droid inside the customer
- [10:08](https://youtu.be/wpOA-UXynoM?t=608) The autonomy maturity model
- [12:05](https://youtu.be/wpOA-UXynoM?t=725) Making a codebase agent ready
- [14:53](https://youtu.be/wpOA-UXynoM?t=893) Migrating 40 million line codebases
- [16:38](https://youtu.be/wpOA-UXynoM?t=998) The city of the future analogy
- [18:34](https://youtu.be/wpOA-UXynoM?t=1114) Constrained autonomy and legal droid
- [20:04](https://youtu.be/wpOA-UXynoM?t=1204) Redefining the forward deployed role

## Transcript

[0:01] [music] >> This is the forward deployed engineering track in case you're in the wrong room. Um as you already know, forward deployed engineering is one of the hottest topics in AI. The most important companies on the planet are building out massive FTE

[0:24] teams. So, think OpenAI, Anthropic, Google DeepMind, you get the idea. Forward deployed engineering was pioneered by Palantir many years ago to embed really strong software engineers directly into their customers' orgs uh to implement customize their

[0:37] platforms around the nuances of the real world. So, today we brought in some amazing speakers from Anthropic, Cursor, Factory, Ramp, Decagon, and many more uh to talk about the current state of forward deployed engineering, how it

[0:50] works at their companies, and where it's going. Our first speaker Our first speaker is Eno Reyes. He's the co-founder and CTO at Factory, which is building autonomous software engineering agents for enterprise teams. Previously,

[1:02] he worked in machine learning and software engineering roles at Hugging Face and Microsoft. Let's give it up for Eno. >> [applause] >> Yeah, hey everyone. Excited to chat today. Um and you know, basically I I my hope is that at the end of this you guys

[1:19] get a sense of some of the work that we're doing on behalf of our customers and with our customers, and the role of what we call a deployed engineer should hopefully be a little bit clearer since I think that there are honestly tons of

[1:32] different models um for uh for how this should actually operate inside of an org. Um and so I think that when when we start I I I do think that there are some nuances in sort of like the Palantir era playbook. Um and I generally the way that forward

[1:50] deployed goes is I I see that there are lots of different takes on sort of where forward deployed sits within the org, how much it interfaces with the actual product team or the engineering team, how much work is done on behalf of the

[2:03] customers versus with them, and how much work is done on code itself or basically like in the software system versus with the humans and sort of strategizing, right? And so, um generally, I think the there's um in this older model, a lot of the way

[2:18] that software needed to be built was you needed to go and access that codebase. You needed to integrate directly in to data streams or software or products that basically you could only access behind the curtain of the customer. And

[2:32] so, if you were building something that was heavily integrated into their environment, yeah, you kind of had the need to send and sort of parachute in individuals into the org. Um but really that has transformed over time into a role that sort of forks out,

[2:49] and you see a lot of people who are sort of quote-unquote forward deployed engineers or deployed engineers or applied AI engineers, and it's always it's always a little bit unclear. Are they doing maybe professional services

[3:01] work on behalf of their customer? Are they transforming like the product around an individual customer? Are they just building entirely net new things in the customer's environment, maybe on top of your product? Uh and I think that the

[3:15] the at least at Factory, we definitely do not want to be doing professional services work on behalf of a customer. So, if a customer says, "I want to do a uh modernization of a codebase, uh and it's you know, I just got quoted from

[3:30] all of the big consulting firms, it's going to cost this much. Could you do this consulting work for us?" Uh our goal is not to go and actually do that migration on their behalf, even if we happen to be using our product, right?

[3:44] Um and that is because we don't think that that actually makes our product that much better. Uh and ultimately, that is a great way way get I'd say a decent amount of revenue, but I don't think that that's the way that you can

[3:54] scale a business out enormously, right? And so, what we've done is we've instead said, we need deployed engineers to be the tip of the spear of the product. And I'm going to do this and then go back. But but really when we say the tip of

[4:08] the spear, what we mean is that deployed engineers are basically the stream of information from our largest and most critical customers of the engineering leadership in that org. The on-the-ground tactical engineers, their

[4:23] thought process about how software development and AI is actually happening at that org, and then flowing all of that information back into our product to then rapidly adjust our product in order to then fit into the customer's

[4:35] environment better, right? And so, factory really should be when it gets deployed, and I'll talk about what factory is in a second, but we want that to be effectively self-assembled inside of our customer's environment, right?

[4:47] And then there's a lot of work that goes into understanding that customer's environment, what the flows that happen, and ultimately the ROI story. And what factory really is to our customers is a set of building blocks for building a software

[5:04] software factory, right? And so, when we say software factory, what we mean is there's this implicit process that every organization in the world sits on top of, where signals from the outside world flow in on one side, and those signals

[5:18] could be a lot of different things. It could be customer conversations, it could be bug reports, it could be internal Slack or Teams conversations, it could be an executive saying, "We're going to build this thing," right? All

[5:28] of these are signals. Some of them have higher weight than others, and those signals flow in, and humans implicitly or explicitly then choose to then prioritize, triage, and build plans around those signals. Those plans are

[5:43] then converted, typically by software developers, into changes into some source of truth, a code base, an engineering system. Um and as those changes are actually executed on, they flow through a validation stage where people maybe review the code, they QA,

[5:59] they assess the security implications, they uh pass it through automated validation like SAST tools, linters, type checkers, and ultimately when everything passes, they then ship and deploy. And what do you do with deployed

[6:12] monitored software? Well, it it generates more signals, right? So, this implicit feedback loop is instrumented very poorly, to be honest, at most organizations. And if you're able to take AI and actually transform each of

[6:26] these stages of the pipeline and build an understanding of what the workflow looks like at your org from each stage to each stage, then you actually can get to the point where you have a a flow through from signal to deploy that has

[6:40] no human intervention. Now, importantly, that does not mean that humans are not a part of engineering this system, right? But it is that the flow of signal to deploy is uninterrupted by a human. Um and that software factory concept is

[6:53] obviously not something that can just snap your fingers and it appears, right? Instead, it requires an investment from the organization. We we like to say this is built, not bought, right? But what the platform that we've built basically

[7:05] provides to people are the canonical one model independent agent harness that you need to do this, because if you want to build a software factory, if you choose to build that software factory in a vendor locked solution that has like one

[7:19] model available to it, uh that is going to not only be expensive, but two, uh there's open questions about model independence and like what is the role of the model provider in dictating what you can or cannot build with your

[7:32] software factory, right? Um and if you also don't own the traces, the data, everything that flows through your software factory, um then you're probably going to be in trouble as you start to want to evolve your software

[7:44] factory, right? And so with Droid, the hardness that we build, you not only have model independence, but you also have access to every piece of data that flows in in and out of Droid, alongside centralized governance and control at

[7:56] the enterprise layer to be able to dictate where what information flows where. Um you can air gap Droid if you want. Some of our partners um in, you know, the most secure uh environments, uh think finance, health care, uh gov,

[8:11] uh they air gap Droid and they run their software factories entirely contained. Um One of our deployed engineers jokes that you could run Droid in a submarine if you wanted to. And that's that's honestly true. And so when we think

[8:23] about what the role of this deployed engineer is in that context, which I probably should have started with, um you know, you really need somebody who can go in and say, I understand this new model of building software and I

[8:37] understand the building blocks and the pieces. I can help enable building and constructing these software factories with your team, but I ultimately would like to one, make it so that our product effectively, you know, one click

[8:50] self-assembled into your environment, which is needed when you have 45,000 people, maybe hundreds of thousands of uh of of engineers, maybe you have tens of thousands of code bases. Uh you you've got to self-assemble, right? You

[9:02] just can't manually install this level of of complexity. Um and and also on the sort of like end loop, why do all of this, right? I I would argue that there needs to be an ROI or an outcome story that is extremely clear

[9:17] from the beginning so that you can say, well, we know every code change that flows through that gets AI code review, AI QA, AI security analysis is maybe 87% less likely to hit a bug. And what that means is that we can reduce our our bug

[9:33] rate by X, that increases our customer satisfaction by Y, and that leads to revenue or growth or new business, right? Something needs to flow from this software factory process to core business goals. And that often is a

[9:47] complex story that requires engineering knowledge, it requires business knowledge. And so, if those are the types of things that you think are interesting, that is what deployed engineers today are doing for us. Um I've sort of outlined it a little bit

[10:01] here, but that teach the model step is super important because most organizations do not have an autonomy maturity model. They do not have a road map, they don't have a conception of what it means to truly build an autonomous software organization, right?

[10:17] I think a lot of people ask the question, what do the humans do in this world, right? For us, we see an extremely clear role for humans in evolving, refining, and scaling software factories, right? So, you basically the

[10:30] engineers at a company go from directly manipulating software to directly maintaining and managing a system that builds software. And that sort of like upgrade in the level of abstraction that you operate at is actually very

[10:43] difficult. And a lot of people find it extremely challenging. I would argue that in fact most people, even very thoughtful software engineers, will have a learning curve in trying to shift. The people who I think are are

[10:56] well suited for this are DevEx people who have already been thinking about enablement of other developers. I think product managers who want to become very technical very quick can become really great at doing this. And I think that

[11:10] generally like people who are used to to working on teams where >> [clears throat] >> high quality dev environments were a priority, you will you will get some of the canonical things necessary to enable these agents to succeed.

[11:25] Um I haven't really talked about this last one, which is design the workflows. And I will get to that in a sec, but I I think that when I say tip of the spear of the product, like keep in mind I really do mean everything that is

[11:40] happening inside of factory. So, our product encompasses enterprise controls, the droid harness, the workflows that run on top of it, the observability tools, the cost controls, the auto model routing, the quality of the harness.

[11:52] Like, all of these are pro- potential opportunities of improvement that you will discover when you work very closely in these varied or diverse orgs like how to solve. Um, so making a code base agent ready, right? This is a very challenging thing to do.

[12:10] Uh, most organizations have some degree of consistency in how they've chosen to build deterministic validation loops inside of their company, right? So, your code base runs linters, type checkers, uh, it might run some security scans,

[12:23] and it's like check mark. Like, it passes or it doesn't. The end end test, they pass or it doesn't, right? Or they don't. Um, what agent readiness really is is it's a measure of how many of these deterministic validation loops are

[12:35] present inside of your code base. Uh, when you have a huge volume of these feedback loops, uh, agents are able to operate for greater periods of time on more complex tasks without human intervention. So, we have like a product

[12:47] that we call missions, which I'll also touch on in a sec. But, missions is basically an extremely elaborate harness built around the concept of working on extremely difficult knowledge work problems that are validatable, right?

[13:00] And so, the quality of the output of these very long-running harnesses of advanced agents is directly proportional to the degree to which you can validate their work. And so, if you introduce the ability to validate at scale, then you

[13:13] introduce increasing autonomy to the org. So, what we'll look at is we have tools that help scan all of these things, but often times, uh, the change is not so simple. Uh, for I'd say maybe 30 to 40% of the low-hanging fruit, you

[13:26] click droid, please fix all of this and it'll go in and it'll fix it, right? But for the other 60% some of them involve workflow changes. Sometimes humans are not used to the degree of I would say like nitpickiness of these automated

[13:39] systems. And so you have to sort of be aware of the concerns, the the humans, you have to think about like the way that people are currently developing systems and say, "How do we introduce some of these more extreme validation strategies without

[13:52] interrupting the dev flow of the humans who are involved in the work?" Um and and I mentioned missions because really I think this is one of the more end game of the agent era at least, pre-software factory era. But the more

[14:07] end game of the agent era style harnesses where it's simply a long running harness that has almost no human intervention except for the planning stage, right? Where you go in and you say, "I would like to have this very

[14:18] bounded task. I know that I want to solve this task and here is what solving this task means. I will now basically push a lever of inference until the task is complete, right? And so that is actually unbelievably competent

[14:33] at solving problems where like is complete is verifiable. So if you can frame any problem as the set of verification uh systems that need to validate it, then you can solve that problem with AI today. Uh and we've seen this work on

[14:50] some pretty insane problem spaces like migrating, you know, 30, 40, 50 million plus line code bases uh fully autonomously, um working on advanced uh like deep learning strategies around biomed, health care uh sort of problems,

[15:06] uh financial institutions that optimize equity research where you can actually build models of different equities and sort of analyze and compare and and build sort of a system that can then back prop and or trade on top of the

[15:21] those equities. Um like it it's mind-blowing to me every day what I what I hear people are using with these tools, but it is not something that you can just download, install, and hit play, right? It does require agent readiness. So, if your code base isn't

[15:35] agent ready, you won't see any of the success of the most capable AI systems in the world today, right? So, this is why we want people to go in and help our customers and say, "Hey, look, you can solve this actually very difficult

[15:47] problem, but it is going to require a different form of investment than you were thinking. Less so solving the problem, more so preparing the environment for verification of the problem." And by the way, if you're familiar with

[15:59] how these models are actually trained, like this makes total sense, right? They they get dense reward when they get post trained on all these complex tasks. Models need dense reward. These verification signals form the basis of

[16:11] that reward that they use to keep them on track over a long-term goal-directed problem. Um So, I sort of mentioned this earlier, but but I think that the the core goal for us really is to say, if we can hand over a model to you of how this should this

[16:28] transformation should go, then we should theoretically be able to say, "Let's do this in a couple of different places, and then let your team actually scale this out across the company." I always use the analogy of if you're

[16:40] familiar with Walt Disney's Epcot, the the theme park. Like basically that theme park was created originally Disney wanted to create like a master planned exemplary city. He said, "Look, if I can create a city that is the future city,

[16:57] then I can use that as a model to the rest of the world cities, and they can develop entirely new forms of transportation and flourishing." And it became a theme park. But, what's interesting is that in that small example, a lot of other cities actually

[17:10] did cite some of the ideas that he was writing down and sharing about what like centralized urban transit should look like. And now you have like some more contemporary cities built in the last 50 years that basically modeled after that

[17:23] toy example. Um what we want to do is we want to make sure that we get some of that lesson that if you have a working example of a city of the future, of a code base of the future, um people are smart. They're clever. Humans will look

[17:37] at that and they'll say, "Man, that's really cool. Let's bring that to my part of the code base, right?" But if you build too much of an advanced example, then people will say, "That's a theme park. That is not at all how the

[17:49] rest of the world works. I just can't see how that would apply to the way that we currently work today, right?" So it's kind of a delicate balance that you have to walk of building something that demonstrates the future is achievable

[18:00] enough, but ultimately does not scare away uh an org who is thinking, "Man, what is going to be the cost of transforming at this pace, right?" Um I always think about that quote, you know, the the future is here, it's just

[18:13] not evenly distributed. Um there are some code bases, and I I say code bases, not even companies, that are truly remarkable. They are effectively uh beginning to run on autopilot. Uh we ourselves have roughly 15 to 20% of what

[18:27] we call like autonomy, and our autonomy ratio is like in the upper 80%, which means the ratio of actions done by humans to AI systems before interruption, right? So our own code base is fairly agent-ready, pretty autonomous, um but uh the code bases of

[18:43] some of our customers are actually even more autonomous because they operate in more constrained uh ways, right? So it's it's sort of like a uh it is not obvious like who gets 100% autonomy first. I would argue it's probably very contained

[18:57] internal tools. Like we have something we call like legal droid, which is our legal workflow. That is effectively 100% autonomously maintained, but our like core harness, uh we do not yet have validators that can validate some of the

[19:10] hard visual problems of a like terminal based harness. Uh Things like flickering are really hard to catch in a verif- in a verifiable way. So, we're unable to close the loop on some of those challenges. It's an engineering task to

[19:23] build the system that can verify some of those very hard problems. And that might give you a picture into sort of like the weird world of the future where humans are sort of visually our advantages in being visual, our advantages in having

[19:36] context of the outside world provide us a lot of work to do in order to build these systems. So, who's great at this? I If you are a former founder, for sure you should do this. I think it's like the quickest way to basically build out

[19:51] I mean each like stage of the SDLC that Droid has, we think is a billion-dollar business. Like just code review, just incident response, just QA, just testing. Like each of these you will help define basically the nature of these products.

[20:07] If you are someone who is used to tech communication, right? If you are fluent in AI, you understand how to speak to every level, you have business acumen, you have executive presence, that is another great example of someone who

[20:20] should do this. And if you are a systems thinker, if you love designing systems, if you love closing loops, modeling data, and understanding how the flow through a potentially extremely complex org should look, then you are also

[20:32] someone who would thrive at doing this. So, if all of this seems interesting, hopefully it does. Please do reach out. And you can reach out to me directly. I'm just Yeah, I'll say it. It's on the slide. I'm eno@factory.ai.

[20:49] And so, you can just email me directly or you can apply on our careers page. It's called engineer, {comma} deployed. So, that's the role. Hopefully this is interesting and gives you a taste of what we're doing at Factory.

[21:19] >> [music] >> Woo!
