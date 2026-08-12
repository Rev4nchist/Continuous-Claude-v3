---
video_id: pWXUkLP9uWM
title: "First Steps Toward Automated AI Research — Richard Socher, CEO Recursive AI"
channel: "AI Engineer"
channel_id: UCLKPca3kwwd-B59HNr-_lvA
channel_slug: ai-engineer
url: "https://www.youtube.com/watch?v=pWXUkLP9uWM"
upload_date: 2026-07-30
duration_s: 1223
duration: 20:23
view_count: 2144
like_count: 59
subtitle_lang: en-orig
transcript_source: auto
transcript_words: 3301
ingested_at: 2026-08-06T11:00:33.834Z
ingest_version: 1
---

# First Steps Toward Automated AI Research — Richard Socher, CEO Recursive AI
**Channel:** AI Engineer · **Uploaded:** 2026-07-30 · **Duration:** 20:23 · **Views:** 2,144  
**Watch:** https://www.youtube.com/watch?v=pWXUkLP9uWM

## Description

Humanity compressed the road from the enlightenment to the moon landing into a few hundred years, and Richard Socher's wager is that automating research compresses it again. He frames it through open ended evolution and Popper: science advances by trying things, finding the shortcomings, and fixing them, and an agent swarm can run that loop across medicine, economics, astrophysics, and more without any single person bottlenecking a field. He calls the goal a Eureka machine, and argues that rethinking the tools around it, web search that returns usable context instead of ten blue links, browsers, and GPUs, is part of building it.

The proof points are recursive self improvement, where a system improves its own code, harness, and results and then does it again over longer horizons. He shows small but concrete wins: an automated loop that lifts a model's accuracy well past a naive baseline, architecture search that trades hand tuning for a system that finds better designs, and CUDA kernel work that surfaced real improvements. He is careful that these are early samples, not a finished machine, and that the field is far from general across all of science, but the direction is the point, and he ends with an open invitation to help build it.

Speaker info:
- https://x.com/RichardSocher
- https://www.linkedin.com/in/richardsocher
- https://you.com

Timestamps:
0:00 - Automating research for humanity
1:41 - Why this matters now
2:19 - Compressing the timeline of progress
4:28 - Technoptimism and material limits
6:22 - Popper and open ended evolution
9:07 - The Eureka machine
10:39 - Rethinking search, browsers, and GPUs
13:41 - Recursive self improvement
14:46 - Proof point: improving a model
16:39 - Proof point: architecture search
17:16 - Proof point: CUDA kernels
19:11 - How far we still are, and an invitation

## Chapters

- [0:00](https://youtu.be/pWXUkLP9uWM?t=0) Automating research for humanity
- [1:41](https://youtu.be/pWXUkLP9uWM?t=101) Why this matters now
- [2:19](https://youtu.be/pWXUkLP9uWM?t=139) Compressing the timeline of progress
- [4:28](https://youtu.be/pWXUkLP9uWM?t=268) Technoptimism and material limits
- [6:22](https://youtu.be/pWXUkLP9uWM?t=382) Popper and open ended evolution
- [9:07](https://youtu.be/pWXUkLP9uWM?t=547) The Eureka machine
- [10:39](https://youtu.be/pWXUkLP9uWM?t=639) Rethinking search, browsers, and GPUs
- [13:41](https://youtu.be/pWXUkLP9uWM?t=821) Recursive self improvement
- [14:46](https://youtu.be/pWXUkLP9uWM?t=886) Proof point: improving a model
- [16:39](https://youtu.be/pWXUkLP9uWM?t=999) Proof point: architecture search
- [17:16](https://youtu.be/pWXUkLP9uWM?t=1036) Proof point: CUDA kernels
- [19:11](https://youtu.be/pWXUkLP9uWM?t=1151) How far we still are, and an invitation

## Transcript

[0:01] [music] >> All right. Hello everyone. Really excited to be here. It's a big room. Very uh very cool conference so far. Uh I want to talk to you today about something that's been on my mind for many many years. This is actually the

[0:25] first time I I talk about it, sort of my version of going to Mars. Um and that is the Eureka machine. A machine that will eventually invent pretty much all future inventions for humanity. Uh and the way we're going to get there is uh by taking

[0:42] a step back and thinking about what else has given us a lot of really incredible inventions, uh namely evolution, and how that leads us to automating research uh and pushing the scientific frontier forward. And this is a joint work with a lot of

[0:58] uh amazing folks uh at Recursive.com uh and even some uh folks at AIX Ventures. And some of these slides are uh actually inspired by uh and taken uh partially from one of my co-founders at Recursive, Tim Rocktäschel. So,

[1:13] uh why do I talk about evolution and why is it so important? Uh I think basically evolution is this like open-ended process that has gotten us to a lot of different things that we really like. Uh it started in biology, it's moving to

[1:28] science, technology, and eventually AI. And I think it can inspire us in a lot of different ways to build better AI systems as well. In fact, uh whenever we take out and there's this famous saying, "Whenever I fire a linguist, my accuracy goes up."

[1:44] Uh I think that's true for machine translation back in the day. And it may be true that we should fire all the AI engineers uh and that that are here uh and have them mostly manage an actual AI engineer that is AI and works on AI. Uh

[2:02] and so that may be uh one of the conclusions of this talk. Uh and I think most of us are going to be excited about it cuz it means that we'll all become managers of such an AI rather than having to do the nitty-gritty ourselves.

[2:16] All right. So, let's start with evolution, right? The really, really big picture, 3 and 1/2 billion years or so. Uh this is kind of the incredible process uh that has led from, you know, simple bacteria and plants and fish and

[2:31] amphibians and so on to, after many billions of years, us. So, I That's That's a good starting point. That gives us some indication that evolutionary processes can do pretty amazing things, right? But now, let's zoom in and uh go

[2:46] maybe down to a few million years. There, we can also see how in a very first primitive ways, technological evolution uh has basically increased the world's uh sort of product uh in terms of monetary value. It's a little bit

[3:02] harder to estimate in the beginning, but we can see these sort of sequences of exponentials. And most exponentials eventually become S curves. They flatten out, but humanity has done pretty well by basically developing uh many of these

[3:18] very basic technologies, hunting, farming, but then also thinking about science, the scientific method um in the early days of the Enlightenment, and then of course the Industrial Revolution. So, now we can zoom even further, uh and no worries, we're

[3:30] eventually going to get to Nanochat and actual auto research and and what we're doing. Uh it's a very, very quick zoom. Um and now we can zoom down to last few thousands of years. And what we're seeing there is that with more

[3:43] technology, we were able to sustain more people, right? So, when we're working on pushing that frontier forward, uh we're very certain that that will lead to more human flourishing, right? And especially in the last few

[3:57] uh, hundred years, we're seeing this incredible explosion in the population of people because of technology. And the evolution uh, that it brings. And in many cases, that evolutionary process is run by us, so it's sort of conscious. Uh, but there

[4:12] are sort of interesting uh, inspirations that we can take from that as we're thinking about the evolution of AI in the next cycles. Uh, in fact, and I might not agree with everything with Marc Andreessen, but uh, he is very smart and we agree on a lot

[4:26] of things. Uh, and so I think he wrote this really great uh, techno-optimist manifesto in which he, I think, correctly points out that the only perpetual source of growth for the entire economy, a lot of people worry about AI taking jobs and things

[4:40] like that, but the truth is it will very, very likely increase uh, the economy massively and that will benefit uh, benefit a lot of us. And so the perpetual source of growth is technology. Uh, in fact, we can go even further and say that there's no material

[4:55] problem, and again, it's not sort of psychological problems and things like that, but no material problems uh, that cannot be solved with even more technology. Right? For problem of starvation, we invented the green revolution, darkness, light, uh, cold,

[5:10] indoor heating, heat, air conditioning, and the list goes on. So, I think we can kind of realize that this evolutionary process has been going on for a very long time and continues to make a huge amount of progress. In fact,

[5:24] the progress is so fast that there can within one lifetime be a major, major shift. Right? If you're born in 1900, uh, then 3 years, when you're 3 years old, the first human ever was able to, thanks to the Wright brothers, kind

[5:41] of have sustained motored flight. And then about 60-ish years later, in 1969, humans flew all the way to the moon, right? So, that within one lifetime, humanity went from like no one can fly for a very long time other than sort of gliding down a hill

[5:59] or something, no one can really fly to we all fly to the moon, right? And so, for us, I think, what that means is we're probably, and I sometimes say this, we're like too late to explore Earth, we're too early to explore the stars, but we're right on

[6:15] time to build an AI that could actually do what flying did for some in one lifetime due to intelligence. We can build and move from AI being worse at everything that we do to possibly being better at any specific task that we do.

[6:32] Right? And that that will probably be our our 60-year time frame, and because everything moves faster, it might only be 30 years or so. So, then, uh there's an interesting connection between technology and science and theory, right? Like

[6:46] sometimes the application comes first, and then we develop the theory later, and then improve at the technology. Sometimes the theory comes first, and from that we can build new kinds of technologies. And so, it's very helpful

[6:57] to think a little bit about the philosophy of science, and no better uh to be inspired there than Karl Popper, wrote that just like in other types of evolution, when we choose a theory, we also choose one that is best uh in

[7:12] competition with other theories. Of course, you need if you wanted LLMs to do that, they need to find them, you need web search, for instance. Um but, uh in the theory that best holds its own, uh it's one that, just like

[7:25] evolution, has a certain natural selection process, right? It proves itself, uh and there is also a sort of survival of the fittest uh going on in scientific theories. And uh in fact, uh a lot of science, according to Popper, is basically us

[7:41] proposing a new theory hypothesis or explanation or description and then subjecting it to rigorous empirical testing. That is the essentially evolution evolutionary pressure of scientific theories. And basically that was a very short run

[8:02] through so the history of open-ended evolution which hopefully makes us all realize that more science lead to more technology which will lead to more growth which lead to more human flourishing. And so that then begs the

[8:14] question does it make sense for us to try to just scale up and spend a lot of our resources as humanity to scale up scientific discovery in order to lead to this flourishing. When when you double click into that you kind of realize

[8:29] which Stanisław Lem already realized a long time ago that the exponential growth of science will actually be at some point halted by the lack of people working on it, right? There's so many niche subfields now in all the different

[8:43] areas of science that is very hard to get a million people to work on that particular thing. And so as a result of this incredible widening of the scope he says the number of people focusing on any single section of it has decreased.

[8:58] And that then leads us to really thinking about how could we automate this and automate scientific discovery and that then leads us to what I call the Eureka machine. This is basically our attempt at trying to build a machine that automates the

[9:17] process of scientific discoveries. And in fact I like in a couple months I'll have a book coming out on on this exact idea and so I'll just give you a super high-level highlight of how such a Eureka machine could be built for

[9:30] basically everything from physics, chemistry, biology, neuroscience, medicine, economics, astrophysics and so on. And there are essentially four pillars that are all extremely important to this machine. One is, of course, you have to

[9:43] understand what knowledge is already out there, what things humanity has already invented. You have to get all the scientific measurement data into, as in the second pillar, this machine. Then, for things that you cannot yet measure, we don't

[10:01] yet know, you should try to then build simulations. Anything you can simulate, you can verify, and you can then solve with AI. And if all else fails, or at the very end of these processes, you still need to have some kind of physical industrial like

[10:18] lab that actually can run real experiments in the real world. And on top of all of this, you'll have a basically an agent swarm that will deal with all of these different sources of knowledge and data and experimentations and and rewards.

[10:35] And in terms of, you know, the foundational model of knowledge, of course, we also, you know, basically is is a good example of how every single technology we've built so far, especially in AI, but also before that, the internet, browsers, GPUs, and

[10:52] so on, we can rethink, and there are a lot of startups possible in rethinking every single one of the layers of technology as infrastructure for superintelligence. And at you.com, for instance, we work on web search for LLMs, right, and agents

[11:08] and so on. And that actually is quite different, right? Agents can read thousands of very long snippets, rather than just 10 blue links with like a very short snippet. And so, you can rethink each of these different layers

[11:22] of technology that we've built for people, and rebuild them for AI in order to use them as tools to then build a superintelligence. Now, that is essentially uh the sort of why. Like like we want to build superintelligence in order to automate

[11:42] science. Uh and to me, that will be the next big step function change uh in in humanity uh and technology as we know it. Now, how do we actually build it? Uh I think the best way to build it is to have it built itself, right? We moved as a field

[12:01] and especially natural language processing for instance, which I've worked on for many years. We moved from not having linguists. This feels like ancient, you know, BC uh history, uh but before ChatGPT, um we we moved from having linguists tell

[12:16] us a bunch of things about language and then training statistical models on top of that. And when we allowed neural networks to actually automate learning those features with word vectors and uh other neural network architectures and

[12:27] back-to-back uh and end-to-end learning and backpropagation, we basically uh were able to get much bigger improvements. Uh then we did a bunch of architecture engineering. Now a bunch of people at least are working on a unified

[12:40] architecture, uh but even that unified architecture has a lot of manual processes. And so, it's clear over and over again in AI that when we take out a manual process and we replace it with a learned system, improvements will follow. Uh and so,

[12:55] that's why I think uh we should try to build a supermachine by having uh an RSI that builds itself. And the beauty is that only now um AI can actually do this because AI is code and AI can code now. This this ability to really code in longer and

[13:16] longer time horizons has really only happened in the last like 6 to 8 months. And that now enables such an RSI to work on itself, to develop almost a certain sense of self-awareness of its own shortcomings and then fix those

[13:29] shortcomings. Uh and then once we have that machine that has gotten really, really good at doing research in AI itself, we can then use it to do AI research for a lot of other things uh in in other scientific fields. And so at a high level it's quite easy,

[13:46] right? We have three steps: ideation, implementation, and validation of ideas. That's true for basically almost every scientific field. And so uh to end maybe on some very specific examples, uh we have built this first kind of version of such a Eureka

[14:04] machine uh and we wanted to just show that it works on some small uh samples that a lot of people know uh and are aware of. And so we basically started uh with three things that show you and give you a very first glimpse of an and sort

[14:21] of simple proof points uh of what such a machinery can do. And that was basically better training, faster training, and and better kernels uh for for Nvidia GPUs. Um the first one, NanoChat, um I'm sure many of you have heard of it.

[14:35] A lot of people think that's already recursive self-improvement and it's kind of a weak form in the sense that usually when you do auto research, it's it's not recursive self-improvement, right? True recursive self-improvement is when you

[14:47] have an AI that has a sense of self-awareness of its own shortcomings, full access over everything uh in its arsenal from pre-training to RL training and harnesses and everything, and then actually updates that entire system in

[15:02] the next version of itself. Now you can also take such a system and just ask it to improve some other process, some other AI, like a small NanoChat run where you can train something in 5 minutes. And that is really exciting and it's an important

[15:16] milestone, but it's not actual RSI. So here we basically showed three examples of such an auto research system and what it can do and after a very very short time it essentially was able to outperform many different teams

[15:33] and teams that also use other AI research. So, let's double click into some of these. Nano chat is really exciting example. Basically, you train a very small chat model in less than 5 minutes and you basically want to have it get to the best possible

[15:53] bits per byte number. And so, the whole community had worked on this for quite some time and got to 0.93 and after training this for a little more than a day or two, we basically got it down to 0.91. Which is pretty exciting. Now, it

[16:15] wouldn't be that exciting if all it did was just find a couple of hyper parameters and tune them carefully, but it actually did find truly interesting novel ideas like hash bi-grams and tri-gram embeddings and tables for those

[16:31] and mixing that into various value paths of the intention through variety of learned gates. So, it actually started to doing more and more interesting things rather than just kind of tuning hyper parameters. Another one nano GPT speed run.

[16:47] Obviously, speed is very important. So, here we're able to work on this again, apply the system and after very short amount of time it got better than people working often together with the AI for over a year on on this very on this benchmark and

[17:04] made the whole thing another two seconds over two seconds faster at 70 seconds. And again, discovering very interesting ideas in the process. And then the third one is CUDA kernels. Of course, we all care about not burning

[17:20] through our GPU budgets too quickly and trying to be very efficient. I think in general it's actually kind of shocking how inefficient a lot of mixture of expert models still are running very large clusters that cost billions of dollars and then only have

[17:33] like 30% or so utilization. So a lot of work that's ongoing in the world to improve that and different fields or different groups of people are various different stages of that. But long story short, lots of different CUDA kernels are used during training

[17:50] and testing and here we basically again took that system and after a couple days it discovered better kernels than the leader boards best on the Nvidia benchmark website by again quite quite a sizable margin across all the different categories of

[18:12] those kernels. And while we are pretty good at AI and we actually in the team didn't have any particular CUDA kernel experts who just spent their entire careers writing good kernels. But still, you know, we do just enough

[18:27] to make sure and work together with Nvidia to make sure that there no reward hacks here and and other issues. But actually found that eventually these all checked out and were indeed pretty much all the different kernels

[18:41] found the best solutions there. And so with that I hope I could convince you that indeed RSI could be that next big S-curve an exponential that gets layered on top of previous exponentials and that should help us with not just AI but eventually science

[19:02] and then all of technology and then allowing many more people to flourish on our planet. And so maybe I'll end on this note here, which is a lot of people wonder how much longer I can go, right? Every exponential eventually flattens out and

[19:19] it's actually quite hard to know like when we even talk about exponential growth in the eye, what does that even mean? There are many different, I call them spaces of intelligence and we won't have time to go into all of all of

[19:29] these, but as soon as you actually try to define multiple different dimensions of each of these 10 spaces that make up this complex sort of volumetric uh thing that is intelligence, you'll realize that there's still so much more

[19:45] to go. Like on the upper bounds of intelligence, we're still astronomically far away from reaching those and across pretty much every single one of these dimensions and the spaces that they make up. So, if any of that is

[20:00] interesting and you want to help us build that, um we'd love to hear from you. Thank you.
