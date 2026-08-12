---
video_id: xbPriQWXtWM
title: "The Base Model Is Dead — Varun Singh, Arcee AI"
channel: "AI Engineer"
channel_id: UCLKPca3kwwd-B59HNr-_lvA
channel_slug: ai-engineer
url: "https://www.youtube.com/watch?v=xbPriQWXtWM"
upload_date: 2026-07-31
duration_s: 1064
duration: 17:44
view_count: 925
like_count: 26
subtitle_lang: en-orig
transcript_source: auto
transcript_words: 2491
ingested_at: 2026-08-06T11:00:33.769Z
ingest_version: 1
---

# The Base Model Is Dead — Varun Singh, Arcee AI
**Channel:** AI Engineer · **Uploaded:** 2026-07-31 · **Duration:** 17:44 · **Views:** 925  
**Watch:** https://www.youtube.com/watch?v=xbPriQWXtWM

## Description

The old story is that a base model is a mirror of the internet, a good model of human web text that everything else gets bolted onto. Varun Singh, who leads pre-training at Arcee AI, argues that story is dead: no modern base model reflects the web the way GPT-3 once did. Instruction data and synthetic reasoning traces have moved earlier and earlier into training, and a distinct mid-training stage has emerged for longer datapoints that look much more like the downstream capabilities you actually want. Reading recent open recipes, from Nemotron to Kimi K2, the pattern is clear: raw web text is taking a backseat.

The rest of the talk is what that shift does to how you build. Once reinforcement learning became the thing that got models to reason, the base model stopped being a cherry on top and started needing to carry the prior that RL builds on, which changes the data mix and pulls post-training-flavored data forward. Singh walks through the practical pitfalls his team hit training the Trinity series, like getting the balancing coefficients right and establishing stable representations early so the model is prepared for what it must compose during RL. The message is that as capabilities advance, the base model's job keeps redefining itself, and pretending it still just mirrors the internet will cost you.

Speaker info:
- https://x.com/stochasticchasm
- https://www.linkedin.com/in/varun-singh-cs

Timestamps:
0:00 - The base model as a mirror of the web
1:26 - How knowledge accumulates in training
2:49 - When instruction data moves earlier
4:11 - After o1: RL and reasoning
5:41 - What prior the base model must carry
6:18 - Filtering web text, adding synthetic
8:01 - Reading the open data recipes
9:41 - Lessons from training Trinity
12:02 - Balancing coefficients and early stability
13:30 - Why RL keeps raising the stakes
15:55 - The base model's shifting job

## Chapters

- [0:00](https://youtu.be/xbPriQWXtWM?t=0) The base model as a mirror of the web
- [1:26](https://youtu.be/xbPriQWXtWM?t=86) How knowledge accumulates in training
- [2:49](https://youtu.be/xbPriQWXtWM?t=169) When instruction data moves earlier
- [4:11](https://youtu.be/xbPriQWXtWM?t=251) After o1: RL and reasoning
- [5:41](https://youtu.be/xbPriQWXtWM?t=341) What prior the base model must carry
- [6:18](https://youtu.be/xbPriQWXtWM?t=378) Filtering web text, adding synthetic
- [8:01](https://youtu.be/xbPriQWXtWM?t=481) Reading the open data recipes
- [9:41](https://youtu.be/xbPriQWXtWM?t=581) Lessons from training Trinity
- [12:02](https://youtu.be/xbPriQWXtWM?t=722) Balancing coefficients and early stability
- [13:30](https://youtu.be/xbPriQWXtWM?t=810) Why RL keeps raising the stakes
- [15:55](https://youtu.be/xbPriQWXtWM?t=955) The base model's shifting job

## Transcript

[0:12] Hi everyone. My name is Varon. I'm the pre-training lead at RCAI. And the talk I'm going to be giving today is called the base model is dead. Um but not really. Um the idea of the base model that we have um kind of is like

[0:29] built on uh this idea of like training on super large-scale web text and the base model kind of being a reflection of like the whole knowledge of like the uh human internet. Um you can see in like uh these I've I've taken these uh from a

[0:47] bunch of uh different papers on like the entire LM training process. Um our own model RC uh training large thinking, um the process looked kind of like the simplified diagram on the left. I've taken the top one from uh GLM 4.5, the

[1:03] bottom one from GLM 5. Um all these have a pre-training phase and uh pre-training is like the stage where the model look accumulates world knowledge, builds useful representations uh all through next token prediction on

[1:21] um web text. Um I've got a simplified uh transformer diagram um decoder-only transformer. And um a screenshot from the GPT-3 paper that talks about how um language models can uh learn how to do in-context learning through um

[1:44] unsupervised or self-supervised or um some some even just call it supervised um learning on uh through next token prediction. Um the way that uh older base models were trained was, like I said, mostly on uh things that reflected the entirety of

[2:04] human knowledge. Uh so, Common Crawl, uh which is like a commonly available web scrape, uh made up most of the training data set for GPT-3. Um WebText-2, another web scrape data set. Um some sources from like uh books as well. Um

[2:23] and Wikipedia as like a high-quality representation of human knowledge. Um you can see that uh WebText alone here, including like Wikipedia, makes up like roughly 85% of the whole training mix. Um looking at uh the bottom with Llama 3,

[2:43] um WebText still kind of makes up a majority of of the um model's training data with like 50% of the tokens corresponding to general knowledge. Back then, post-training was mostly shaping the model to use um the parts it to like surface

[3:05] uh the knowledge that it accumulates and accumulated in pre-training uh in like a chat interface. So, mostly allowing the model to adapt to a chat template, to the question-answer format, um and be be useful in an interaction

[3:20] that way. Um RL was mostly just a cherry on top, um shaping the, you know, flavor of the interactions more than conferring extra um knowledge or quality onto the base model itself. Now, in in like this realm of of how language

[3:41] models used to be, pre-training um and the base model kind of defined how good you were able to get a model. Um it was like the bulk of the compute uh budget and it was um, the the like core of the training process. Um,

[4:02] however, uh, this kind of changed a lot last year when um, OpenAI I guess 2024 actually. OpenAI released 01, um, pioneering reasoning models and DeepSeek uh, also released R1 in January 2025, um, allowing the whole world to know how

[4:25] to build these types of language models. And now we have this new uh, new um, use for reinforcement learning, which is no longer a cherry on top, but it can dramatically improve the performance of of the model on various

[4:43] different tasks. Um, the the famous graphs from 01 there talking about uh, AIME performance, um, competitive math contest. Um, and then even later in the year we we saw Cloud Code um, coming to being as a way for developers to easily

[5:02] um, kind of use uh, language models in a in a terminal to build out applications as models got stronger and stronger on things like function calling. Um, and then people realized you could uh, you know, RL this end-to-end.

[5:17] Um, and now models could learn how to interact with software environments and build software and uh, perform really useful work. And so, um, the question then becomes like, is your standard base model still uh, what the best uh,

[5:38] what will be the best um, prior for the for the this large-scale reinforcement learning phase that uh, research knows and um agentic models now use. And we can kind of see like in the in a few open research papers what the trend

[5:57] is where the trend is going. Um and interestingly enough, the um it seems like not super clear yet. Um I have my opinions on like synthetic data being the way forward, but I'm I've got like two contrasting uh perspectives

[6:16] here kind of in the slide. The top image is from the MEI uh Thinking 1 paper where they make a make it really large point to not use any synthetic data or any uh data from any other language model. Um and they really try to, you know,

[6:30] filter their web scripts for this as well. Um in order uh to kind of adhere to like the previous um paradigm of like uh using human knowledge as a way to bootstrap uh model representations and like uh capabilities. Um But I would say that this is also, like

[6:52] even even though they stuck with no synthetic data, the data mix that they've chosen here is still um totally different from what you'd expect in like a um in a in a classical uh language model. And I mean, the the main reason for that

[7:07] is that web text, which used to make up like up to 85% of the train data in GPT uh 3, is now all the way down at 15%. And that I mean, that just shows that uh the value of like web text contributing to like the downstream

[7:25] um performance of like the models on RL and stuff is kind of uh it it's still important, but taking a backseat to things like code and stem abilities as the models kind of gain more real-world use cases related to to those.

[7:43] Um the other approach uh is to bring um post-training data and large-scale synthetic data back uh through pull it back through the process into the pre-training phase. Um the the bottom chart I've taken from NeMo Tron 3 Ultra. Um what they reveal

[8:01] there um the data recipe and not sure how readable it is, but these top three um on the left uh pie chart, the top three on the kind of right right side of it, uh they're all labeled SFT with with SFT as a prefix. And that's the type of question and answer

[8:24] kind of chat data set that you'd you'd expect to see only in post-training, but by pulling it back into the process, they're able to like get the model to learn um the shape of these conversations and what kind of tasks they might be

[8:38] expected to do downstream um from the very beginning of the pre-training process. Um and uh this follows like uh a similar um trend in like diminishing uh the amount of web text used in the model. Um Yeah. Um it's really interesting to see the

[9:03] the NeMo Tron series leans so heavily into synthetic data, but uh MAI Thinking 1 kind of lean in the opposite direction. Um I've I've I've just got this slide here as like a con uh easy contrast that people can see on the like amount of web

[9:21] text and the amount of books and stuff um being less of a percentage here. And GPT-3 didn't even used to have any specific code data sets, but now code is like the dominating um data data subset that we have in uh pre-training recipes.

[9:41] Um so I mentioned synthetic data, but what is actually uh like how is synthetic data used? There's a lot of uh talk around synthetic data that, you know, blindly tossing it into a model can cause the model to collapse and uh

[9:56] and performance to tank, but there's been a lot of work and uh even at like a large scale, you know, example of this uh turning out really well. Um so in our own in our in our own uh model Trinity Lodge, we uh had a large amount of uh web uh web

[10:15] scale synthetic data um mostly through rephrasing, where you take a seed data item and you sort of upsample it in the mix by uh generating synthetic rephrases of the same information. So, the model sees the same information in like multiple ways.

[10:32] Um the bottom two uh screenshots are from Kimikay2, um an even larger scale model that uh broadly used this um across the whole pre-training data set. Um the top uh top right um screenshot is from a paper that uh resulted in the data sets Swallow Code

[10:55] and Swallow Math, which are early examples of this. But, the trend seems to be that um synthetic data not only allows you to get more and more tokens, uh but also, you know, clean up tokens, get higher quality tokens, and have um

[11:12] tokens that are shaped more like instruct or agentic tasks all the way back in pre-training and uh allowing the model to like learn those task representations from the very beginning. Um another reason that it's uh beneficial to add post-training data

[11:28] early in pre-training is now with MOEs, um one of the biggest uh pain points in training an MOE is dealing with load balancing. Um, where experts can specialize over the course of training and um they uh and load balancing objectives

[11:46] aim to uh achieve broadly equal utilization of the experts um in a given batch or sequence depending on the objective. Um without uh post-training data in uh early in pre-training uh with an MOE one really easy pitfall uh that we can fall

[12:04] into is this is kind of illustrated in the MAI thinking one report, which is that the data distribution that the model sees uh in post-training is really really different uh compared to what it sees in pre-training. And this can cause massive imbalances

[12:21] and um MAI overcame it by uh really cranking up the load balancing coefficient during the SFT stages. Um but I mean, ideally you don't want to mess with the balance that far into training and the model should learn stable

[12:40] representations from really early on. Another uh interesting thing that um is changing in base models now is that you is this whole advent of mid-training, uh which is exposing the model to the distribution that it would see during post-training

[12:57] in RL and at a longer context, so for things like agentic traces to be allowed into the mix and uh to kind of help prepare the model that way. Um a lot of models though are training with much longer context in pre-training and

[13:12] there's no reason that these data sets can't be pulled back into the mix to allow for more stable representations from the very beginning. Um I think uh a better uh better way to understand the current uh phase of LM training uh isn't so much like

[13:28] pre-training, mid-training, post-training, RL. It all gets a bit muddy that way, but there's two broad paradigms that are like that really help build a LM today, and that's supervised learning to next token prediction and RL.

[13:44] Um and RL is becoming more and more important. Um The bottom thing is a screenshot from interview um with uh the head of Xiaomi's Mimo Labs, uh where she talks about how they allocate compute between research, pre-training, and post-training. And

[14:04] pre-training and post-training in the final model have a roughly equal compute allocation. Um Composer 2.5 takes us to the extreme where um Kosar really uh sank much, much more RL compute into the model than the model had ever seen

[14:19] in supervised learning. But with RL dominating such a massive amount of the compute budget, uh it makes sense to view supervised learning as a way specifically to prepare the model for to build useful representations for for

[14:35] RL instead of it being the bulk of like um what the model would be used for like previously. Um there's been some some work on how supervised learning affects RL. Um I really like this one paper where the main takeaways are basically

[14:55] that uh the base model needs to have some exposure to like uh like the atomic skills that it would need to compose during RL, and um the model can learn to extrapolate from there during RL given like the environment has a sufficient level

[15:11] of difficulty. Um I had to put in the classic AlphaGo graph there where RL eventually overtakes supervised learning. Uh it's unclear if we'll see something like for language models because of course, you know, uh, human language is such an insane

[15:27] distribution to have to like learn through reinforcement learning alone. Um, but it's definitely possible that we might see diminished supervised learning in more and more RL, uh, which makes this kind of thinking of a base model as, um,

[15:41] atomic skills for RL more and more valuable. Another thing that some labs are doing, um, is kind of introducing novel data, uh, during supervised learning. And by novel, I mean something that the model really wouldn't have seen the shape of before.

[15:57] Uh, easy example is, you know, reasoning traces. They don't really look like a like a ton of what, um, humans output. And, um, another interesting thing is like training for test time compute, um, schemes, um, by kind of warming the

[16:14] model up to them during SFT, um, or even pre-training itself. Um, this These screenshots were taken from, uh, Zephyr's Ziya 1 paper. Um, and I think if they're, uh, very interesting ways of thinking about how data can affect, um,

[16:32] like, uh, the skills needed to explore well in RL. Um, in conclusion, um, base models have kind of moved from general, uh, human knowledge and world priors to reasoning and agentic behavior priors. Um, of course, that's kind of, uh,

[16:50] reductive in the in the in a way that reasoning reasoners and agents are like the main way we see, uh, bots, uh, the main way we see these chatbots used now. But, if a new paradigm were to take off, like a new way of interacting with the

[17:05] models, um, it makes sense to like think of a base model as building a prior for that instead of, um, just building off like a a massive, uh, script of web text. And yeah. Thanks for Thanks for listening. Thanks for your time.

[17:24] And >> [applause]
