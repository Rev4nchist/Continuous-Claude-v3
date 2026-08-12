---
video_id: 1OMHGsUZiqA
title: "How Forward Deployed Engineering is done at Kepler — Vinoo Ganesh"
channel: "AI Engineer"
channel_id: UCLKPca3kwwd-B59HNr-_lvA
channel_slug: ai-engineer
url: "https://www.youtube.com/watch?v=1OMHGsUZiqA"
upload_date: 2026-07-28
duration_s: 1340
duration: 22:20
view_count: 2071
like_count: 65
subtitle_lang: en-orig
transcript_source: auto
transcript_words: 4041
ingested_at: 2026-08-06T11:00:33.942Z
ingest_version: 1
---

# How Forward Deployed Engineering is done at Kepler — Vinoo Ganesh
**Channel:** AI Engineer · **Uploaded:** 2026-07-28 · **Duration:** 22:20 · **Views:** 2,071  
**Watch:** https://www.youtube.com/watch?v=1OMHGsUZiqA

## Description

A shipping and dispatch customer wanted alerts, a massive BI tool, and a dev environment. What they actually needed Monday morning was one Slack message, so that is what got shipped first, and the real thing followed. Vinoo Ganesh spent seven years doing this at Palantir, where he later ran the rotation program that turned software engineers into forward deployed engineers, and his throughline is that the work was never a sales motion, it was product strategy in disguise. The engineer sits in the customer's environment, solves the concrete problem in under a day, and then generalizes it into something the whole product can use.

The compounding lessons are less obvious. Watch what people actually do: any task a user repeats is a hint at a missing feature, and someone pulling out their phone in the middle of a workflow is a bug report you will never find in documentation. The deepest one is language. When a customer says clients, finance says billing, and support says accounts, the ambiguity costs real money, so the forward deployed engineer defines the terms, the ontology, and becomes the linguistic layer the rest of the system is built on. A throwaway Groovy script that quietly became a product a year later is the whole pattern: forward deployed engineers drive product strategy without anyone calling it that.

Speaker info:
- https://x.com/vinooganesh
- https://www.linkedin.com/in/vinoo-ganesh/
- https://vinoo.io

Timestamps:
0:00 - Introduction: FDE's origins at Palantir
2:05 - Not a role, a product strategy
4:51 - Real stories: scoping down to a Slack alert
7:11 - Solve in a day, then ship the real thing
8:33 - The data quality engineer story
10:03 - Watch what users actually do
12:33 - Own the language: clients vs billing
14:54 - The ontology and the linguistic layer
16:51 - The Groovy script that became a product
18:09 - The most important skill: what to discard
19:38 - Ship everything like it runs forever
21:11 - FDE as an extension of product

## Chapters

- [0:00](https://youtu.be/1OMHGsUZiqA?t=0) Introduction: FDE's origins at Palantir
- [2:05](https://youtu.be/1OMHGsUZiqA?t=125) Not a role, a product strategy
- [4:51](https://youtu.be/1OMHGsUZiqA?t=291) Real stories: scoping down to a Slack alert
- [7:11](https://youtu.be/1OMHGsUZiqA?t=431) Solve in a day, then ship the real thing
- [8:33](https://youtu.be/1OMHGsUZiqA?t=513) The data quality engineer story
- [10:03](https://youtu.be/1OMHGsUZiqA?t=603) Watch what users actually do
- [12:33](https://youtu.be/1OMHGsUZiqA?t=753) Own the language: clients vs billing
- [14:54](https://youtu.be/1OMHGsUZiqA?t=894) The ontology and the linguistic layer
- [16:51](https://youtu.be/1OMHGsUZiqA?t=1011) The Groovy script that became a product
- [18:09](https://youtu.be/1OMHGsUZiqA?t=1089) The most important skill: what to discard
- [19:38](https://youtu.be/1OMHGsUZiqA?t=1178) Ship everything like it runs forever
- [21:11](https://youtu.be/1OMHGsUZiqA?t=1271) FDE as an extension of product

## Transcript

[0:01] [music] It's kind of an emotional thing to hear uh series of folks who've kind of been talking about how Palenter used to do things. Um it's funny in the olden days and this what this talk will be about is largely uh Palin's focus of FTE became a

[0:27] go-to market strategy but it wasn't that in the beginning how we were figuring out how to build foundry was through the lens of a product strategy and so my talk is going to be how we used FDE as a product strategy in 2013 to make the

[0:42] data platform that enabled Palunteer to then become the thing that Kevin Nat and all these folks were able to build on and it ultimately comes from like the background of something pretty simple. So my background is uh I started my

[0:55] career at Palanteer as a software engineer um really focused on horizontally scalable and storage solutions at a high level. Uh when we say forward deployed um I forward deployed to places like Iraq and Afghanistan. That's me in Bram. It's no

[1:09] longer there anymore. Uh but the idea was how do we take software and build it in the most critical environments to make it actually work for people that needed it the most. So forward deployed is actually a military term and we took

[1:22] it very seriously. Um my claim to fame from Palanteer is I built something called project frontline which was the rotation program that took our software engineers and made them forward deploy engineers. So the folks that you see at OpenAI, Anthropic, XAI,

[1:39] a lot of the FDs, about 350 of them went through a training program for how we got them to understand what we needed out of forward deployed product focused individuals. Uh built the same program at Citadel afterwards. So across the

[1:53] hedge fund, how do we build the right data products and software products to help portfolio managers generate alpha? Um this is a quote from the guy who named uh forward deploy engineering at Palanteer. It's from a couple days ago

[2:05] and um Sham is the CTO of Palunteer right now and I think this captures the entire essence of where my difficulty came from in the last talk which is the first fundamental truth of FTE is that this is not a role this is a product

[2:19] strategy how we discover the things to build are through the lens of forward deploy engineering. So looking at market caps of companies for how do we actually evaluate what contract size this is that wasn't how it actually happened but the

[2:33] core tenant and the core insight was an FTE is judged by their ability to be an extension of the product team to identify areas of opportunity and generalize product solutions out of it. And so this is the story of how we

[2:47] actually made project Frontline at Palunteer and what I'm using to build this function out at Kepler along with Susanna here is one of our founding engineers. Um back in the days, Palenter was first trying to get into big data. So around

[2:59] 2013, uh we had this idea that we wanted to store transaction information. And the product that came out of that was something called Phoenix. Phoenix was built totally in isolation. We didn't talk to customers. We didn't understand

[3:12] our financial banks or any anything else. What we did is we designed a system in perfect isolation that worked perfectly under certain circumstances and crashed and burned when we hit actual real data. And the situation was

[3:25] simple. We had a large scale financial customer and the idea was we're going to store your information in bucketed key spaces. Uh this is going to enable easy rolloff and easy retention. Now what we hit fairly quickly is a lot of banks and

[3:40] financial institutions have data that's not perfect. So when we hit a blank data value, it defaulted to the epoch January 1st, 1970. Our retention strategy made it such that what we wanted to do is actually take each 10-minute increment

[3:57] between January 1st, 1970 and 2013 and spin up a time bucketed window. The problem is Cassandra requires 5 megabytes per file handle, which means with the 2.3 million key spaces we generated to start up our server would

[4:13] require 14 terabytes of RAM and we were dead on arrival. There was no one else we could call. We were the only individuals and only institutions in the room. And we realized something fairly simple. The gap wasn't the fact that we

[4:24] had not looked for information about how customers use our product. It came from the ownership about co-building a piece of software without being directly embedded with a customer. The whole purpose of this talk is to convince you of one thing. Forward

[4:41] deployed engineering is a product strategy. Being an FD is an extension of the product function, not the go to market function. So what I'm going to do is walk through four things and four real stories that I learned at Palanteer

[4:52] and other places. what we learned from those experiences and how they informed building FTE at every other institution. The first starts from something fairly simple. Palenter was onboarding uh a large-scale dispatching and shipping

[5:07] company. We sat down with the VP of operations who generated a 47page requirements doc. What they wanted is a custom dashboard, 14 metrics, drill down alerts, this massive BI tool, a dev project that was estimated at three

[5:21] months. The kind of hilarious thing that happened in this process is we took them at face value. We spent four months scoping this engagement trying to understand exactly what this customer wanted before one of us actually showed

[5:35] up on site just by virtue of the fact that their family happened to live there and asked what's the first thing you do with this information Monday morning. The dispatcher said, "I check if trucks are trucks are late and then I call the

[5:47] dispatcher to ship a new inventory or new institution." The whole thing could have been simplified to a trivial Slack alert, which is what we ended up building. In 4 hours, we were able to solve this problem cradle to grave. The first move

[6:02] that we learned from forward deployed perspective is detect the real problem and ship the real thing. The vast majority of the time, people don't need massive BI dashboards. They don't need fully scaled designed pieces of software

[6:15] cradle to grave. They have a problem and they need that problem actually solved. And so the first thing that we learned is before you build anything, you as an extension of the product team need to understand three things. First, what are

[6:29] you trying to accomplish? Meaning what's the core goal in actually solving this problem? What happens after you have the solution? And how is the customer actually solving it today? every single one of these open uh AI or FD deployment

[6:43] companies are all approaching it in a slightly different way than how Palanteer did which is we have the people are going to go on site and build things. What do we build? So I think of this in terms of an XY situation.

[6:56] Customers describe solutions not problems. Your job as the FTE is to understand what the problem is. Customers don't know what happens next and your job as the FD is to define it. >> [snorts] >> My simple solution and takeaway is if

[7:11] solving the problem is under a day of work, just build it and ship it and close the loop. Don't make it a product strategy. Don't expand your product vision and bring in your PMs and everything else. If you can solve this

[7:22] problem in a short curtailed way, that's the first thing we did at Palunteer. That's how we started. The secret here is whoever defines the problem actually owns the solution. If we were able the virtue of the fact that we were able to

[7:35] look at the problem this shipping operator had define the solution and ship the actual solution meant that we were always the owners of that system and we were able to articulate what subsequent solutions looked like. By

[7:47] controlling what we're going to build and by controlling the narrative around the solution, you end up in a really powerful position. And this is why FDES actually become valuable in early sales. It's not because they are really good at

[8:00] talking to customers or we're not socially awkward software engineers as people seem to claim. It is because we actually solve the customer's problems in small bite-sized ways that wins us trust and that gets us access to the

[8:12] real problem that we can then use from a product strategy perspective to generalize. Foundry is a general product solution that we can use across a number of verticals that was informed by tens of thousands of hours of doing things

[8:25] like this in the field. Cool. Actions speak louder than words. This is a real situation also in Palunteer days. Um we had a data quality engineer who was viscerally adamant to a pipeline adamant about how to solve a pipeline

[8:41] stability issue. Every day we were dropping about a terabyte of information to someone's S3 bucket and it was putting a lot of pressure on on our own data pipelines. We had an easy solution. Instead of dropping huge numbers of

[8:55] CSVs, we can migrate everything to parquet. Makes it easier for our pipelines. Makes it easier for like your cost. Makes it easier from a compute perspective. But we had one engineer who was viscerally against this. We couldn't

[9:08] figure out why. Every time we'd bring this up over the course of about a year, she would push back. Whenever I'd ask, she'd say, "Park is way worse. It doesn't work. It doesn't make sense to me." We decided to actually go on site at

[9:21] this customer and watch her use our tool and do this workflow end to end. What we saw is she was downloading CSVs from S3 manually onto her Windows computer, double clicking them to open it up and doing a spot check of data quality. She

[9:38] could not do that with Paret files because Parquet didn't have a native reader that you could just open and view. kind of a hilarious problem if you think about it because she was so viscerally opposed to this without really understanding the benefit it

[9:50] would give her. That night we built a parquet viewer. She approved the migration in the next 2 days massively reducing data costs. I think the pipeline execution time went from 17 hours to about two. And what this teaches us it's actually

[10:03] something pretty simple. Uh when you are working with a user you are effectively an observer of what happens on site. An action speaks significantly louder than words. So you as an FTE should be looking for any task a user does more

[10:18] than once. Meaning if they're doing something the same day, same same time multiple times a day or they're doing something multiple times a week or multiple times an hour, that is a pattern and a hint that there's a problem and an opportunity. Anytime a

[10:31] user copies and pastes between tools, meaning if they're moving from one tool to another, anytime they're reacting this way, if the first thing you say is, "Hey, how do you feel about this problem?" And their reaction is,

[10:43] "Well, I have to." And this visceral exasperation, you know, you have an opportunity there. Anytime a user switches tools or tabs, it's an opportunity. And anytime a user pulls out their phone in the middle of a task, meaning they're going through a workflow

[10:57] using your software or anything else, and pull out their phone, it becomes pretty easy that this is an annoying problem or this software is taking too long. Your goal as an FTE is to make tomorrow, their tomorrow different from

[11:10] their today. And it starts with a question, what's the most annoying part of your morning? Every morning we all come into work. Every morning we all have something we need to solve. This all goes back to again FTE is informing

[11:21] your product strategy. You earn the right to extract user pain and define product strategy by solving small repetitive problems. Now the most valuable intel here is never going to be in documentation. We only saw Maria's uh challenge because we

[11:38] were badged onto their building. We were physically present. We were in Afghanistan. We were in Iraq. We were running around Soho. We were here in Palo Alto or in San Francisco. The vast majority of stuff that matters is only

[11:51] going to happen live inside of the walls of the office. Your badge on site at a customer site and your email address, your contractor email address, those are your data mining permits. The first thing every FTE should do is get access

[12:04] to customer information by getting in the room where things actually happen. Everything lives in that environment. And you can't survey your way to this. You have to be physically present. It's very easy to be a forward deployed

[12:16] engineer in name sitting in a nice conference room in New York, but that's not where the actual problems are and that's not where the solutions are. And the way I've heard this put and the way we threw it around a palunteer is

[12:26] residents get the truth. Go on site. Third, when you define the language, you control the narrative. We had a customer where I'm sure this occurs across pretty much everyone's company here. From a logistics perspective, everyone defines

[12:41] customers slightly differently. Sales members calls them customers. Ops calls them clients. Finance calls them billing entities. Devs call them org IDs. The way that we talk about the same entity in a customer is fundamentally different

[12:56] depending on what team you're in. That results in a huge amount of pain. It generally means integrations break. It means there's data quality issues. It means pipelines are constantly not working. And it ultimately comes back to

[13:07] a simple fact. We're all human. We define things differently because we operate in our environments and we understand how to talk about topics with people that are similar to us. It's a feature, not a bug. And so this idea of

[13:21] an ontology was kind of an accidental thing that Palunteer tripped into. And what it came from was not this understanding that by making everyone stick everything in elastic search and you know scheming everything we can

[13:33] solve every problem. came from the simple idea that we need to enable humans to operate in the domain that they understand best. And so when I say define the language, every organization is made up of two things, nouns and

[13:48] verbs. The nouns define the entities, the verbs define the operations. What FDES started eventually doing was building those nouns and verbs and figuring out what the terminology to use was. In a lot of these enterprises,

[14:03] users don't just adopt your product, they actually adopt your language. And what we were able to do is we're able to start defining the languages that we wanted people to use. I think in this case, we called them um uh c like I

[14:15] think we canonicalize on customers. In other situations, you canonicalize on ids. Something like DAU, daily active users can mean something very different to different people. For product teams, high quality DAUs. for anyone logging in

[14:29] from infosc just the number of people that logged in. All these phrases that we take for granted are illdefined by nature. And so when a user adopts your product, they also adopt your language. How many people are calling things

[14:42] skills right now? How many people are calling things MCPs that are function calls with prompts? And that matters. So third piece here, defining the ontology. Your job as an FTE is to understand what the ontology is. What

[14:56] phrases, nouns, and terms in an enterprise are overloaded? Meaning, what words are people using to describe the same concepts? Second, where do the integration points exist in the system? Are things going from Snowflake to data

[15:09] bricks? Are they going from Palunteer to Tableau? Are they going from Anthropic to SAP? Where do these integration points actually exist? And what are the translation layers where it goes from one term to the other? Naturally, what

[15:22] are the system boundaries? What are the systems of record you're never going to be able to switch out? And what words do people use when they're describing their issues? If someone is saying, well, in AI, my agent keeps failing. What is an

[15:34] agent? Like we can't even define FTE. We're trying to define agents, right? Are they prompts? Are they like series of steps? Understanding that viscerally becomes important. Your job is to define the terms. If you can define the terms

[15:47] in your own solution, you can build the ontology and you can have customers answer questions and think through things in your terms. So the the secret here is if you become the linguistic foundation, you're locked in. And simple

[16:03] examples are things like skills, things like MCPs, things like any of the terms that weren't a big deal a year ago but are now day-to-day in our entire econ entire ecosystem. And so when you are able to define the vocabulary that users

[16:16] use and codify that in your platform, you become the foundation under which every solution and tool is built on top of foundry enabled that ontology to be constructed and built. That then enabled the next generation of FTEEs, the go-to

[16:30] market FTEEs to go out there and just do data integrations and sell the product. We had to learn this the hard way when we were actually building it for the first time. Last thing here, ship fast but build for production. This is a true story. Um,

[16:44] they all are, I guess. But, uh, we had a customer that needed to run data retention. I decided to build a very quick script. It was in Groovy, if anyone knows that language, as a temporary fix. Um, it wasn't designed for prod by any means. Like, I just

[16:59] randomly hacked this thing together to solve an initial problem, but it made it there. 12 months later, this thing was all over the place. It was a almost 100,000 person customer. Uh it was running in a number of places for my

[17:11] then and my nickname at Palanteer Nat's not here anymore but she can attest to this became venue.groovy. My wedding people showed up wearing a name the shirt venue.groovy. And so the the kind of funny thing here is we solved a problem in a very hacky

[17:26] way that did fix an issue but we didn't actually productize it. We didn't think through the end state. So we ended up in a situation where we were forced to support a very hacky product for years that was never actually productized. And

[17:41] so again when people say customer FTEES are forward deployed software engineers or customerf facing software engineers and your job is to make the customer successful that's not true. When you do that things like this happen so scripts

[17:54] and hacks can fix problems but they're not driving your product strategy forward. Meaning you're not doing your job successfully as an FTE. We have people that jobs are making customers successful. They're solutions architects.

[18:07] So calibrating what you ship becomes the last mo most important skill here as an FTE. First, am I going to get a 2 a.m. phone call about this in 6 months? If you are, you probably shouldn't ship that thing. Second, what is my trade-off

[18:20] for solving this problem quickly? Am I making the right decision for the product as a whole? Or am I just solving this customer's painoint in a way that's going to have potentially small wins but negative compounding challenges later

[18:33] on? Who do I hand this off uh to when I actually leave the customer site? Is it going to a customer? Is it going to another institution? Is it going to another FDE? What happens when this breaks? Am I going to be held responsible for that? Am I building

[18:46] something so missionritical that if something breaks, I'm going to be hated? what happens there. So, we need to solve problems, but we need to be aware of when we fold those solutions into the core offering and when we should just

[19:00] discard those solutions quickly. Here's the actual reality. Every hack goes into production. If you make someone's life easier, it will go into production and you will be responsible to support that hack in perpetuity. The

[19:14] most dangerous words in forward deployed engineering or engineering is this is just temporary. Anyone here who's been at a software company knows this is not just temporary. And we know that we're still writing running on 40-year-old

[19:26] cobalt code at some IBM mainframe because of a hack that was put in place. If it solves a problem, it's not temporary. It will live forever. So, as you're thinking from an FTE perspective, ship everything like it's going to run

[19:39] for 18 months because it probably will. and through the lens of again the product building focus should tell you a lot about what goes into the core product offering versus what wins you customer goodwill. So the cheat sheet

[19:52] that we all ran frontline people to uh through rather is the following. Most people who are trying to develop an FTE function treat it like a product management task and a customer success uh operational task. They take

[20:08] requirements, they schedule user research, they add insights, they run the processes without actually figuring out how you steer the product from the insights. The right FTEEs who enabled the creation of something like Foundry

[20:22] redefined the problem. They got badged on site and they flew to places like Afghanistan, like Iraq, like Somalia, like any of these places where we had to be where our customers were. I I have a friend who was spending time on an oil

[20:34] rig in the middle of the ocean. They shipped the fix before leaving the customer site to win the goodwill, but they owned the fix end to end in the product ecosystem. And they took those fixes and created product leverage from

[20:47] it. They were able to translate the problems they saw into nouns and verbs that they were then able to use to define the foundation of every subsequent problem that was solved. And finally, they were the ones who got the

[20:59] call when things actually broke. They were the ones who got in the airplane to fly everywhere else. The question is not what did they learn in the process, but what did they ship from the product perspective? The goal here is actually

[21:11] fairly simple. I'm going to wrap up with this. Product leverage is the only thing that wins you customers. It's the only thing that backs every Citadel portfolio manager trading hundreds of millions of dollars. It's the only thing that backs

[21:23] every decision being made in the war fighter ecosystem at Palunteer or in customer ecosystems at Palanteer. your job as an FTE and what we learned and what Kepler is doing is using FTEE as an extension of the product function to

[21:39] enable us to build products that are actually sticky and that solve problems. And if you were to take one thing away, please don't treat FTEEs as go to market extensions. You can do that when you're palunteer and have 20 years and

[21:50] unlimited money. You don't do that when you're an early stage company and you need to figure out what product will allow you to use those FDs to maximum degree. Thank you so much. [applause]
