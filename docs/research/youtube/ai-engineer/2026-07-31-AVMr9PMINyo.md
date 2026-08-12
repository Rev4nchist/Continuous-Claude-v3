---
video_id: AVMr9PMINyo
title: "Agents at Scale: Inside MiniMax's Model and the Infrastructure Behind It — Dan Fu and Olive Song"
channel: "AI Engineer"
channel_id: UCLKPca3kwwd-B59HNr-_lvA
channel_slug: ai-engineer
url: "https://www.youtube.com/watch?v=AVMr9PMINyo"
upload_date: 2026-07-31
duration_s: 1214
duration: 20:14
view_count: 1188
like_count: 21
subtitle_lang: en-orig
transcript_source: auto
transcript_words: 3975
ingested_at: 2026-08-06T11:00:33.815Z
ingest_version: 1
---

# Agents at Scale: Inside MiniMax's Model and the Infrastructure Behind It — Dan Fu and Olive Song
**Channel:** AI Engineer · **Uploaded:** 2026-07-31 · **Duration:** 20:14 · **Views:** 1,188  
**Watch:** https://www.youtube.com/watch?v=AVMr9PMINyo

## Description

In this conversation, Olive Song, who leads reinforcement learning at MiniMax, opens up the stack behind the company's open weight models and the infrastructure that serves them. Her starting point is a belief in open source: put the weights out, let builders optimize on them, and share the capability widely. From there she walks through what it takes for a model to land well, from agentic coding that also understands and builds games, to computer use problems trained with RL against environments like OS World.

Much of the discussion is the unglamorous engineering that makes a launch real. When a model ships, the team wants the inference stack ready on day zero, which means writing and tuning GPU kernels, working through benchmarks like a parallel kernel bench, and threading optimization into everything from KV cache handling to routing. Song also talks through multimodality and the training pitfalls that come with it, such as text and vision collapsing after training unless you train both modalities together, and reflects on longer horizon tasks like replicating a twelve hour run. She closes optimistic that open models are closing the gap faster than a year ago would have suggested.

Speaker info:
- https://x.com/olive_jy_song

Timestamps:
0:00 - Introducing the RL lead at MiniMax
1:17 - Why open source and open weights
3:45 - What builders are doing with the model
4:11 - A model that builds games
5:12 - Computer use and OS World
5:49 - Writing GPU kernels
6:25 - Parallel kernel bench
7:28 - A day zero inference stack
9:34 - Optimization across the stack
10:47 - Multimodality and training collapse
14:10 - Replicating a twelve hour run
17:22 - Where open models go next

## Chapters

- [0:00](https://youtu.be/AVMr9PMINyo?t=0) Introducing the RL lead at MiniMax
- [1:17](https://youtu.be/AVMr9PMINyo?t=77) Why open source and open weights
- [3:45](https://youtu.be/AVMr9PMINyo?t=225) What builders are doing with the model
- [4:11](https://youtu.be/AVMr9PMINyo?t=251) A model that builds games
- [5:12](https://youtu.be/AVMr9PMINyo?t=312) Computer use and OS World
- [5:49](https://youtu.be/AVMr9PMINyo?t=349) Writing GPU kernels
- [6:25](https://youtu.be/AVMr9PMINyo?t=385) Parallel kernel bench
- [7:28](https://youtu.be/AVMr9PMINyo?t=448) A day zero inference stack
- [9:34](https://youtu.be/AVMr9PMINyo?t=574) Optimization across the stack
- [10:47](https://youtu.be/AVMr9PMINyo?t=647) Multimodality and training collapse
- [14:10](https://youtu.be/AVMr9PMINyo?t=850) Replicating a twelve hour run
- [17:22](https://youtu.be/AVMr9PMINyo?t=1042) Where open models go next

## Transcript

[0:12] This is a discussion that I'm particularly excited about because the field is moving so fast and we have two people that that kind of have this unique vantage point on the field and what I want to do is kind of ask questions to see if we can learn from

[0:25] that. So I want to start off with intros, talk a little bit about your role, what you're thinking about, what you're working on. Maybe Dan if you can go first. >> Uh hey everyone. I'm Dan. I'm the VP of Kernels Together AI.

[0:37] I lead inference, GPU optimization, trying to figure out how to use GPUs most effectively to serve AI models. >> Yeah. So one of the things that I wanted to dive in with Dan about is like you model drops, what are what is everything

[0:51] that goes on behind the scenes to serve it so that everybody here there's a lot of builders here that can use it. Olive I want to throw it over to you to talk about your role and what you're focusing on. >> Yeah. I'm Olive and I am the research

[1:03] lead of RL at MiniMax and I am responsible for the final training of the model and the shipping of the model. So basically everything before the inference, right? >> Okay. Awesome. Um so maybe I wanted to start off this panel is focusing on open

[1:17] source. I wanted to start off with this is your strongest model yet, MiniMax M3. Why open source it? What's the kind of the the idea behind that as a company as you're releasing these models? >> We do believe that the open source

[1:31] community as a whole is very strong and powerful. While we open source the model, everyone can use it. So it aligns with our mission that we want to have intelligence with everyone and also different developers can contribute to

[1:45] the model through feedbacks, through their own PRs and we can build the models even stronger. And also like for example, Dan you you will be able to optimize on our open weight model and make it inference faster and then serve better

[1:59] for everyone. >> Yeah. Yeah, we're we're big believers in open source that together and yeah, I think when we we've been you know, following you guys for for a while. I think from way old old older MiniMax models. So seeing M3 and seeing

[2:13] how far it's come is is really impressive and really great. >> So I wanted to kind of pick on this a little bit more. Can you explain so we've got the model creators themselves MiniMax. We've got experts on the inference side of things. How did

[2:26] this partnership come to be? So they launch an open source model and we're now distributing it. I I checked this morning. We have the lion's share of token usage for MiniMax M3. How does this partnership come to be and how do

[2:39] we serve a model like this at scale? >> Yeah, yeah, great question. So at together, I think one of the things that that we're really interested in is how do you make intelligence abundant? So how do you get more tokens to more people to do

[2:53] more useful things and and and get get all these capabilities into more people's hands. So we follow all the open models very closely. I I don't remember when exactly we we started part. Oh, actually I think I do know this. We had a car event in Las

[3:08] Vegas sometime last year. And with someone from MiniMax came and there he was like, guys, you really got to serve our next model. It's going to be really really great. So I think from there we we started talking. We were serving MiniMax 2.5

[3:21] and I think 2.7 for for a while and then when leading up to the launch of of M3, we were we were quite excited about it. I think we we're seeing the the usage and what people were doing with it was it was really quite exciting

[3:36] and and so from there that's really where we partner. We start working on the model. The architecture, optimizing it, figuring out you know, what's the best way to serve inference on it and and all those great pieces. >> Yeah. I wanted to actually get into more

[3:51] on the model side of things. And so as the creator of a model, as as somebody who's like post-training this thing, the model lands and all the builders that are here start using it. From your perspective, um what are the

[4:04] kind of the unique capabilities that you love to see people use it for? And what are maybe some of the hidden gems that you haven't You thought, "Oh, people would love to build this." but you haven't seen a little bit. Could you

[4:13] shed more light on that? >> Mhm. Mhm. So, MiniMax M3, which was different from the M2 series, was that it was actually multi-modal So, it not only understands text and it not only writes code, it also understands videos and images. So, we

[4:27] did see a lot of applications on a gen tech multi-modal agents, which is very cool. Um and I would say there are a couple that we can highlight, right? For example, computer uses. The model can is able to navigate through a computer and

[4:42] then do some pretty good creations with the tools that they they can utilize. And also, um you can develop games with the model. Um it's very fun that I I don't I think that's one of the hidden gems is that we actually worked on

[4:56] um game development. So, the model can help you develop a real cool games. Um yeah. >> Yeah, one So, when the when the blog dropped and then the paper dropped, one of the things I noticed was that you guys highlighted SVG bench, you guys

[5:11] highlighted kernel bench, you also touched on OS world. Can you talk more about Like, what does it take to post-train, especially for those particular domains? >> Mhm. Mhm. Uh I would say it's the very important thing is the data and

[5:24] how we define the problems. Um it could be very different from different tasks. For example, let's say the kernel one, right? The It would be very important to design the environments of the data so that we can deliberately train reinforcement

[5:37] learning in those very complex environments and let the model to optimize the kernels themselves and iteratively improve the performance. >> And one one aspect that I wanted to talk to you about on the kernel development

[5:51] side of things, um where are you seeing open models when it comes to kernel development? You recently released a benchmark specifically for this. So, I was wondering if you could talk on that a little bit as >> Yeah, yeah, it's a it's a great

[6:02] question. So, I think we're seeing all sorts of models of the closed frontier models and the open models get increasingly better at writing kernels. So, we use models all the time when we are developing kernels and and and

[6:16] writing the optimization frameworks. I think the the interesting thing that we are starting to look at is this benchmark that that we recently released called um parallel kernel bench. So, it actually has a bunch of unsolved

[6:28] problems in it. So, we went around surveyed all the different ways they can serve model inference. And one of the interesting things that we found is that there's a lot of things that we can think of that would actually

[6:39] speed models up that there don't exist good kernels for. So, one of the reasons that we put that benchmark out was, you know, one thing that people worry about is like bench maxing or or overfitting to particular benchmarks.

[6:51] One of our intentions with this benchmark was that if you overfit to it, that's great cuz we'll go take those kernels and use them to to to accelerate the the the the inference and the development. >> Yeah, this is a really interesting

[7:02] point. A lot of people have problems with bench maxing, but the way I think about it is if researchers like you put all the really useful benchmarks out and we bench max on all of them and everything is in distribution, then

[7:13] that's a perfect world, right? That's a very useful model that we can then use. Um Okay, cool. So, I wanted to touch on the inference side of things now as well. So, like a new model drops like this, what does it take Could you take me like

[7:27] behind the scenes at the inference stack? And what does it take to go from day zero launch and then optimizing it week over week, month over month? >> Yeah, yeah, great question. So, when we partner with someone like MiniMax, we

[7:37] will get some early model details. So, for M3, for example, there are things like the minimax sparse attention and and some of those choices that were a little bit different from any model that's out there. And I think if you

[7:49] look at any of the open models now, they are all quite different from each other in different ways. So, there's different attention, different MOE choices, differences in quantization and and all these pieces. So, as soon as we get

[8:00] those details, we start writing kernels, benchmarking, figuring out is there existing kernels that work for it? Do we need to modify something? Do we need to write something from scratch? And then so day zero, we're trying to

[8:14] think about things like quality. So, when this model launches, is it going to have the quality that we all expect? Are we going to be able to provide the right the the right user experience? And then from there, as soon as it

[8:28] launches that day zero, we have a long list of things that we know, hey, we have to do this with the KV cache, we have to do this with the attention kernels, we have to do we're going to look at this part of the quantization, and things like that. So,

[8:40] we we we have that list and then we start working on it and start optimizing over the course of weeks so that when you use these models, they actually get faster between day zero and day seven and day 14 and etc. >> Yeah, I was just talking to Ingrid

[8:56] actually yesterday and I and I asked her, have we been improving the performance of M3? And I meant over the last month and she said, oh, did you mean from last night? And this is the pace at which these guys work. So, it's very real.

[9:09] One aspect that I wanted to touch on with this is we're seeing the workloads shift. We're going from kind of predominantly chat workloads where you have turns coming in now to agentic workloads where you've got this thing

[9:21] sitting inside a harness and you're doing hundreds and hundreds of multi-turn tool calls. >> Yeah. >> Does that change the way you build the inference stack? >> Yeah, it definitely does. So, these agentic turn-based workloads,

[9:34] they go into everything from informing your KV cash, your prompting, your pieces like this. So, it it informs what part of the stack you want to go optimize because now I think when we're in the chat chat chat world, you have a system

[9:48] prompt of a few thousand, and then you just have the the chat logs. Now, with the coding base agentic workflows, you'll upload your whole code base to the model, and that's a very different optimization and routing and kernel challenge than than just the the

[10:02] chat base workload. So, yeah, we're we we follow these work codes very closely. It's really interesting to see how they evolve and and how to adapt the inference stack and the inference engines to to really take to really

[10:12] serve them well. >> Not only do you have agentic workloads, but you've also got multimodal workloads in there. So, what I like to do often with these coding agents is get them to optimize a web app and then get it to use it and then do a feedback

[10:26] loop. So, one thing that I wanted to come to you all the four is Minimax M3 is multimodal, M2.7, all the ones before that were not multimodal. And like, can you talk a little bit about the optimizations and how you trained it for that aspect? And

[10:41] then also, I want to get into the architecture of it afterwards as well. >> Right. Definitely. So, what's different from before was that it was trained multimodal from scratch. So, from step zero, we trained not only text data, we

[10:54] also trained image data. And it was normal for many other labs that the model would collapse after training a little bit, and we managed to solve that problem. And what we found was actually that with this kind of training from

[11:09] scratch, if you look at the attention map, it actually the visual of the the text tokens would attend to the visual tokens. So, that they are naturally combined together, they naturally understand each other. So, for example,

[11:21] we are developing, for example, websites, right? It is better if we train with both modalities. Also, like, for example, it can look at the website, it can understand how it looks, and then better optimize for it. Like for example, during reinforcement

[11:37] learning. Um so yeah, I think that is pretty cool. >> So one one thing that kind of stuck out with this model for me was the fact that it introduced a lot of new things. The multi-modality, the increase of context to 1 million, um the fact that you have

[11:54] a sparse attention now. Um so if you go to the inference side, it's almost a a nightmare, isn't it? You get You get this new model and there's so many things that you could optimize to speed up inference. Um practically, what are

[12:05] the things that you focus on? There's like a thousand things that you could optimize, but where do you get the most bang for your buck? >> I mean, you focus on a thousand and one things, yeah. Like you just you just go and you keep you keep doing it. You find

[12:17] every edge that you can, um and and you go and and you push on it. Um so yeah, I think there there's there's no there's no stone that you leave unturned and you just uh keep keep going at it. If someone tells me you can't do the thousand first

[12:29] thing, yeah, like I don't know, try harder. >> Yeah. >> And then get up a little later. >> Yeah, like go ahead. >> No, I know. So the other thing that I wanted to ask is there's a whole kind of um zoo of open source models. As you're

[12:44] talking about speeding up inference, are there things that are there lessons that you can take from one model and apply it to MiniMax M3? Um or or do you have to like restart from scratch as you're thinking about the inference engine, the

[12:56] kernels, like how does that work? >> Right. Um yeah, so there there's definitely things that you learn from optimizing one model that you take to another. Um so I think sparse attentions are something that have become quite

[13:07] popular now. So the MiniMax sparse attention is a little bit different from the uh from the deep seek and the and and and those and the and the ones that you find in JLM. Um but the they're still similar lessons that you can take from

[13:21] that optimization process and that kernel writing process that you can then bring to to the new sparse attentions. And you know, we've been in in some form or or another I've been thinking about this problem for for many years.

[13:35] So going all the way back to my PhD. So it's it's it's great to see some validation that that folks can now train it at scale and people are using it and and it's and it's it's going pretty well. >> Yeah. >> Yeah, one of the interesting things

[13:48] especially about open source is you've got all these labs that are learning from each other kind of taking the wins from each other, right? So if if if one lab figures out that Minimax does this really well, then that gets becomes the

[14:00] golden standard. Um one of the things on model launch that I in the blog post that you guys go into is that this model was actually able to replicate a 12-hour run where it could reproduce an ICLR paper. And so somebody who's training this

[14:16] model to do this thing, how do you actually go about that? Cuz that seems like a pretty ludicrous task. >> Right. So letting the model to do cool stuff like replicating papers, optimizing kernel frameworks and stuff like that is always exciting for us

[14:31] researchers because it's like very related to our job. But training it can be very tricky because it's very long horizon and like the task itself would require GPUs. It has hardware constraints. So it's very interesting to train tasks

[14:48] like that and I would say the key there is still the environments and the data and how you formulate the problem, how you formulate the rewards, how you formulate the environment and how you change the reinforcement learning

[15:02] algorithm a little bit so that it's trained more efficiently so that you can see cool things emerging through the the iterations of RL runs. >> Mhm. Can you talk maybe if I keep pulling on this thread a little bit? How do you do

[15:16] evaluation over these longer longer scale runs? So if you're if you want the thing to do a 12-hour task, yes, it might or might not do it at the end, but are there like a intermediate things that you can also look at? >> Yes, we do. For these tasks, they are

[15:31] there are iterations, right? So, the model can submit several times, and we would evaluate each of them. Some of them some of the times the models would hack, and we do do like validation and test with for it to test if it's really

[15:45] improving on the performance or it's hacking. And also, we design our internal evaluations. So, for example, for the release of 2.7, we touched a bit on self-evolution, right? So, we're actively using the model to improve the speed of

[16:00] development internally, which like out of it out of it we can build our own evaluations that are closely related to our own work that we can evaluate the models on. >> Yeah. When So, when we start talking about these long horizon tasks that are 12

[16:16] hours long, we gave an entire workshop on this on Monday, but what I wanted to come to you, Dan, for is KB cache. So, if let's say you you have concurrent requests that are 500 to a million thousand context length long, how do you

[16:30] deal with the KB cache that just keeps on growing, and how does the infrastructure deal with that? >> Yeah, so there there's a lot of different pieces that that you put there. Like in in some sense, it's like recreating a distributed file system.

[16:41] So, we we're in some sense building something like that or a very big database. It's it's pretty simple in theory. It's like the type of thing that you should have done in your third year of undergrad or something like that, but

[16:54] most of us actually skipped that class, so now we're rediscovering it live in in industry. But it's it's all about where do you store that cache? How do you know Have you have you seen this before? How do you fetch it? How do

[17:05] how do you send it from one place to another? So, yeah, it's it's a it's it's not that complicated, but you you do have to make sure that that you do a good job. >> Yeah, one thing I noticed you you gave a a um a lecture at Stanford recently and

[17:20] one thing that stood out was that if you fast forward like 2 3 years, 2 3 years is is is a long time in AI. And if you look back you said that we'll realize that how um how early we are right now. >> Yeah. >> So, from your vantage point, where 3

[17:34] years out, what do you think we'll look back on be like, "Why were we doing it this way?" >> Great question. Um uh some things that I hope for, so I think we underutilize our GPUs a lot right now. Um you know, SpaceX said they would have like 10%

[17:48] flop utilization or something like that. I hope in 3 years, well, they they should already be embarrassed about it, but I hope in 3 years they're extra embarrassed by it. Um so, certainly training should be should be pretty

[18:00] um should be pretty good. I think at Anthropic we can do a lot better with the hardware that we're using uh that we have today, so I hope uh in a few years we'll we'll say uh we'll we'll have seen the light on on some of those pieces. Um

[18:12] and I think there'll be a lot more models, there'll be a lot better. Um I I hope finally by then we've put uh put to bed this question about the open models. You know, there's every few months there's someone like, "Oh,

[18:25] Anthropic OpenAI, they're so ahead, yada yada." Um but I think uh we're we're seeing with models like M3 and GLM and Kimmy and and all those models that um the open-source frontier really can catch up. Um and and it's it's not even

[18:38] that far behind, so so I think that that's quite exciting. >> Yeah. I I wanted to throw that same question over to you, Olive, but you mentioned that you it for for the M2 series and the M3 series, you're using this idea of

[18:49] self-evolution, where the model is building its own harness, and then it's training inside of that, and then you get the next checkpoint. Um if you look back 3 years uh out and then you say like, "What in RL or post-training um do you think uh made

[19:03] the biggest difference?" What do you think that is from this vantage point? >> Um great question. But, 3 years ago I was still in in >> [laughter] >> I actually didn't start this industry yet. >> Yeah. So I wouldn't have imagined what's

[19:16] happening right now today. So it's really exciting. But I can see how models that were developed are were already improving the speed of development maybe a year ago or even further than a year ago. So I could see how this speed is actually accelerating.

[19:32] How the development is accelerating. And that's how like open weight models can really catch up with frontier labs and Yeah, that's how we think we are more mission to bring this model to everyone so that everyone can use it. Yeah.

[19:50] >> Awesome. Thank you guys. Thank you Dan. Thank you Thank you Olive. Thank you guys so much. Have a great day. Very cool. Thanks so much. >> [music]
