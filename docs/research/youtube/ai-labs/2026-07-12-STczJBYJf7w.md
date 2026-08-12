---
video_id: STczJBYJf7w
title: "7 Rules To Use GPT 5.6 Sol Better Than 90% Of People"
channel: "AI LABS"
channel_id: UCelfWQr9sXVMTvBzviPGlFw
channel_slug: ai-labs
url: "https://www.youtube.com/watch?v=STczJBYJf7w"
upload_date: 2026-07-12
duration_s: 720
duration: 12:00
view_count: 17323
like_count: 451
subtitle_lang: en-orig
transcript_source: auto
transcript_words: 2581
ingested_at: 2026-07-30T03:54:23.703Z
ingest_version: 1
---

# 7 Rules To Use GPT 5.6 Sol Better Than 90% Of People
**Channel:** AI LABS · **Uploaded:** 2026-07-12 · **Duration:** 12:00 · **Views:** 17,323  
**Watch:** https://www.youtube.com/watch?v=STczJBYJf7w

## Description

GPT 5.6 Sol just dropped, and we ran OpenAI's new GPT 5.6 against Claude Fable 5 in Codex for four days. Here are 7 rules for getting the most out of gpt-5.6 Sol: what to use it for, where it beats Fable 5, where it doesn't, and the one setting to leave off.

Power your AI apps with SaladCloud, Get started today at: https://shr.pn/salad-cloud

Community with All Resources: http://ailabspro.io

The Roundup, our daily newsletter covering the AI stories that matter. Join now: https://www.theroundup.so/


Is GPT 5.6 Sol the model that finally beats Claude? As a software company we ran Sol on our own products for four days. It's not better or worse, it just behaves very differently from Fable, and here's how gpt 5.6 sol used fewer tokens and more autonomy across 7 rules:

1. Keep it on a leash. Sol keeps taking actions until it's done, so branch and commit first, then set approval to Never and sandbox to Workspace write (never Danger full access). Then use that autonomy for full features and reviews.
2. It's a better reviewer. Sol reviews parts of the app Fable refuses to touch and finds real problems there.
3. Point it at the screen. Sol uses computer use automatically, logging in as every account type to test a feature the way real users would.
4. Restructure your prompts. Drop instructions the model already follows, keep the ones that change the result. OpenAI saw 10-15% better results with 41-66% fewer tokens.
5. Don't use Ultra. It splits work across agents that each burn tokens, for only two or three points of gain.
6. Keep Sol as your Codex default. On a subscription, routing to the cheaper Terra and Luna dropped quality. We used 48% of our Codex limit vs 87% of Claude Code.
7. When to reach for which. Use Fable before the build for the decisions, then have Sol build, review, and check it on screen.

We're a software company that builds and runs our own products with Claude Code, Codex, and our Hermes agent, so this is how GPT 5.6 Sol holds up on real work. Whether you're searching gpt 5.6 sol vs fable 5, fable 5 vs gpt 5.6 sol, gpt 5.6 sol vs fable, chat gpt 5.6 sol, sol gpt 5.6, sol 5.6 gpt, gpt sol 5.6 vs fable 5, or gpt 5.6 sol free, this is the full gpt-5.6 Sol vs Claude Fable 5 breakdown. All the skills and workflows are in AI Labs Pro. Subscribe and hit the hype button.

00:00 Intro
00:49 GPT-5.6 release recap
02:20 Rule 1
04:07 Sponsor: Salad Cloud

## Chapters

- [0:00](https://youtu.be/STczJBYJf7w?t=0) Intro
- [0:49](https://youtu.be/STczJBYJf7w?t=49) GPT-5.6 release recap
- [2:20](https://youtu.be/STczJBYJf7w?t=140) Rule 1
- [4:07](https://youtu.be/STczJBYJf7w?t=247) Sponsor: Salad Cloud
- [5:03](https://youtu.be/STczJBYJf7w?t=303) Rule 2
- [5:39](https://youtu.be/STczJBYJf7w?t=339) Rule 3
- [7:17](https://youtu.be/STczJBYJf7w?t=437) Rule 4
- [9:16](https://youtu.be/STczJBYJf7w?t=556) Rule 5
- [9:57](https://youtu.be/STczJBYJf7w?t=597) Rule 6
- [10:36](https://youtu.be/STczJBYJf7w?t=636) Rule 7

## Transcript

[0:00] GPT 5.6 Soul just came out and right now everyone's asking the same thing. Is it finally the model that beats Claude? As you already know, we're a software company. So, we spent the last four days running Soul on our own products,

[0:11] including our custom-built community platform and on other client projects as well. And what we found isn't that it's better or worse. It's that Soul behaves very differently from Fable. So, using both models in the same way means you're

[0:23] not getting the best out of either one. It finished some work in one run that normally takes Fable several conversations, but it also kept taking actions in places where Fable would normally stop. And during reviews, it

[0:33] found problems in parts of our app that Fable had refused to inspect. So, after four days of testing, we ended up with seven rules for getting the best out of Soul. By the end of this video, you'll know what to use it for, where it beats

[0:45] Fable, where it doesn't, and the one setting you should leave turned off. Before we actually get into the video, let's catch up on OpenAI's latest model release in case you've missed it. So, OpenAI just shipped their latest models

[0:57] under GPT 5.6, and this time they released three of them. There's Luna and Terra, which are the smaller and cheaper models, and then there's Soul, which is their most capable one. So, what's actually new here? OpenAI's whole pitch

[1:09] this time is efficiency, basically getting more work out of every token and more performance out of every dollar you spend. OpenAI says Soul beats Fable on coding and long-running tasks while using fewer tokens and finishing in

[1:21] about half the time. On overall intelligence, their own numbers put it at about the same level as Fable, just at a lower cost. But, we'll be taking a look at that later on. They've also folded the separate Codex desktop app

[1:32] into the ChatGPT app. Although, you can still use Soul through the Codex CLI, which is the terminal version of Codex. OpenAI also added a new mode called Ultra, which runs multiple agents at once instead of one. We'll come back to

[1:44] whether that's worth using later on. So, right now there are two models at the top. There's Fable, the one you already use, and now there's Soul. So, the rest of this video is about how to get the most out of Soul, including when to use

[1:55] it over Fable. Let's start with the honest part first. Soul is not smarter than Fable. On hard problems without a clean solution, we've seen that Fable still finds the better answer. The difference shows up once the decision

[2:06] has already been made and the model has to complete the work. Fable is better at figuring out what you should do, while Soul is better at continuing through every step without needing you to keep bringing it back to the task. And that

[2:18] difference changes how you should use it. Starting off with the first rule, you need to set a boundary before you let Soul work on its own. We didn't have to think about this as much with Fable because Fable normally stops or refuses

[2:29] when it thinks an action is risky. Soul behaves differently. It keeps taking actions until it finishes the task. The clearest example happened while Soul was working through one of our tasks. It found files and running processes in its

[2:41] way, so it deleted the files and stopped the processes without asking us first. Fable would normally stop at that point, but Soul removed what was blocking it and continued with the task. Other people testing Soul saw a more extreme

[2:53] version of the same behavior, and we even saw one case where it deleted almost every file on someone's Mac. So before you leave it running, you need to limit what it can access. Before you start a long task, ask Codex to create a

[3:04] separate Git branch and commit the version that already works. The branch doesn't limit what Soul can touch, but it gives you a clean checkpoint so you can undo its changes if something goes wrong. To set this up in the Codex app,

[3:15] open the configuration, set the approval policy to never, and set the sandbox to workspace right. Never means Soul can keep working without waiting for you, while workspace right means it can only touch files inside that project. Just

[3:28] don't select full access because that gives it access to files outside your app as well. Now, once you've set those boundaries, you can use that same behavior to your advantage. We saw the other side of it when we gave Soul a

[3:38] full feature in AI Labs Pro. The same kind of work with Fable normally takes us several rounds of back and forth, but Soul stayed on the same goal and worked through the entire feature on its own. It also finished much faster than the

[3:50] the work normally takes us with Fable. So use for the work you'd normally have to split across several sessions. That could be a full feature, a complete review of your app, or any task that touches several parts of the product.

[4:01] And one place we saw this difference clearly was during reviews, which brings us to the second rule. But first, let's have a word by our sponsor, Salad Cloud. Running Open AI models usually means renting cloud GPUs that cost a fortune.

[4:13] Salad flips that. Since 2018, they've run a distributed GPU cloud built on the world's idle consumer GPUs, over 2 million of them, so their prices are often a fraction of the big providers, sometimes cheaper by an order of

[4:26] magnitude. For developers, the best part is their AI gateway. It's an Open AI compatible API, so you just point a tool like Cursor or Cline at one endpoint and run open models like Qwen 3.6. No servers, no cold starts. I swapped my

[4:40] endpoint for Salad's, ran Qwen 3.6 in Cline, and it built the feature end-to-end, the same workflow at a tiny fraction of the cost. And next to the usual cloud providers, the price difference is genuinely hard to believe.

[4:53] There's no lock-in, no contracts, and you can scale up the moment you need to. Sign up with my link below, then message their support to claim $10 in free credit and try it yourself. Salad is also better at reviewing work that Fable

[5:05] refuses to touch. And to be clear, we're not talking about the occasional routing to Opus 4.8, which mostly happens when you ask it to explain its reasoning or the task involves something harmful. We're talking about the safety

[5:16] restrictions built directly into Fable. We know this because we've already used Fable for these kinds of reviews, so we knew where it would normally stop. When we gave the same kind of work to Salad, it didn't stop there. It kept reviewing

[5:27] the parts of the app Fable had always refused to inspect, and it found problems in those areas. But this is only the first reason Salad reviews better. The other one is that it can open the finished app and test it itself, which brings us to the third

[5:39] rule. Whenever a task [snorts] involves something you can see or click on the screen, Salad will automatically start using computer use. Inside the new Chat GPT app, Soul's computer use can work across multiple tabs, use websites

[5:51] you're already signed into, and download files. So, it can move through the same screens you use instead of only working from the files inside your project. Here's what this looked like in our custom-built community. We were building

[6:02] a new store feature, and the app doesn't work the same way for every account. An admin has one set of options, a regular member has another, and someone on the $20 plan should be able to do different things from someone on the $100 plan.

[6:15] So, checking the feature once isn't enough. Soul went through the full journey for every one of those accounts. It logged in as each type of member, checked what they could access, went through the process of purchasing a

[6:26] product, and then repeated those checks across the other parts of the app that changed depending on the account. It tested the feature from the point of view of every person who would actually use it. So, when a feature behaves

[6:36] differently for different people, run the review in a new Soul conversation after the build is finished. Give it the different types of accounts and explain what each one should be able to do. Then, ask it to complete every journey

[6:47] from start to finish and only report the problems it can reproduce. For our store, that meant logging in as every account, purchasing a product, and checking that each person saw the right version of the feature. Now, this

[6:57] community website we are talking about contains all the skills, workflows, and other resources that we build and show you in our videos. So, if you found value in what we do and want to support the channel, this is the best way to do

[7:09] it. The link's in the description. Computer use changes how Soul checks the finished result, but you also need to change how you give it the task in the first place, which brings us to the fourth rule. The fourth rule's focuses

[7:20] on restructuring the prompts and skills you were already using. And this applies to both Fable and Soul, because the newer models are better at working out the basic steps for themselves. So, the goal isn't to make every prompt as short

[7:31] as possible. It's to remove instructions that don't change the result and make the instructions that do matter more precise. OpenAI explains this in the GPT-5.6 Prompting Guide. You should still give Soul the outcome, the

[7:43] important limits, and what needs to be true before the task is finished. But you don't need to map out every folder when the folders are already named properly, repeat the same rule in three places, or describe every step the model

[7:54] should take to get there. We can show you what this looks like through our animation system. The first thing we kept was the actual code the model needs to replicate in the HTML. Instead of describing the animation and leaving the

[8:05] model to interpret it, every rule gives it a working pattern it can copy. We also kept the exact background surface and accent colors so the model doesn't choose new ones on every run. But the more useful part was finding what we

[8:17] could remove. One of our rules told the model to always save the finished animation inside the output folder. We removed that line and ran the same kind of task again, and Soul still saved it there. The instruction wasn't changing

[8:29] the result because the model could already work out where the finished file belonged. We're still keeping that line for now because we switch between models, and a weaker model may not pick up the same pattern. But that's the test

[8:40] you should run on your own prompts and skills. Remove one instruction, run the same kind of task again, and check whether the result changes. If the model still does it reliably, that instruction probably doesn't need to be there.

[8:52] OpenAI reported that this kind of cleanup improved its own results by 10 to 15% while using 41 to 66% fewer tokens. Now, the prompt controls what Soul is trying to do, but the mode controls how many agents it uses to do

[9:06] it, which brings us to the fifth rule. And if you're enjoying the video so far, subscribe to the channel and hit the hype button. This small gesture of support goes a long way for us. Keep Ultra turned off for now. Ultra is

[9:18] Soul's multi-agent mode, so instead of running one agent, it divides the task and runs several of them at the same time. OpenAI positions it as the mode for the hardest work, but every agent uses its own tokens, which means Ultra

[9:30] can burn through your usage much faster than regular Soul. And when we used Ultra on the same kind of work we'd already been running through regular Saul, we didn't see a meaningful improvement in the finished result. The

[9:42] usage increased because several agents were running, but the quality stayed about the same. OpenAI's own results show the same small difference with Ultra improving the scores by roughly two or three points depending on the

[9:53] test. And if regular Saul is your default, the next question is whether you should save more usage by sending the smaller tasks to Terra or Luna. If you're using Codex to build your app, keep Saul as the default instead of

[10:05] switching smaller tasks to Terra or Luna. Terra and Luna are cheaper through the API, which matters when you're paying for every request your own product sends to the model. But when you're using Codex through a subscription, the decision is different

[10:18] because you're working within the usage included in your plan. We found this after routing the lighter parts of our work to the smaller models. They completed the task, but the drop in quality meant we spent more time correcting the result than we normally

[10:30] did with Saul. So we went back to Saul for the full task instead of changing models halfway through it. So that leaves the last question. When should you use Saul and when should you go back to Fable? After using both models in our

[10:42] daily workflow, the clearest way we'd position them is this. Fable is a preview of where coding models are heading, while Saul is the most complete version of how they work today. And the speed difference affects the workflow

[10:53] more than the benchmark scores do. In our daily use, Fable, Opus, and Sonnet all take longer to complete the same type of work. On the other hand, Codex models are way faster, and we're saying that without even turning on Codex's

[11:05] fast mode, which uses 1.5 times your usage. This, in our opinion, is one of the greatest deciding factors, and it's the reason that we've seen ourselves reaching more for Codex models rather than Claude. So use Fable before the

[11:17] build when you need help deciding how the app should work, how a feature should be structured, or why a difficult problem keeps happening. Once those decisions have been made, have Saul build it. That's where you use it for

[11:27] the full feature, the long-running work, the review, and anything that needs to be checked on the screen. >> [snorts] >> So, after 4 days of using Saul, it's become our default once we already know what the finished result should do while

[11:39] Fable still handles the decisions that need more judgment. The important part is setting the boundary, giving each model the right job, and reviewing the result before you ship it. That brings us to the end of this video. If you'd

[11:50] like to support the channel and help us keep making videos like this, you can do so by using the super thanks button below. As always, thank you for watching and I'll see you in the next one.
