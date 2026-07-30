---
video_id: KwhgfwOSToQ
title: "Forward Deployed Engineering 101 — Kevin Bai, Anthropic, ex Palantir & Rippling Founding FDE"
channel: "AI Engineer"
channel_id: UCLKPca3kwwd-B59HNr-_lvA
channel_slug: ai-engineer
url: "https://www.youtube.com/watch?v=KwhgfwOSToQ"
upload_date: 2026-07-28
duration_s: 1068
duration: 17:48
view_count: 7188
like_count: 240
subtitle_lang: en-orig
transcript_source: auto
transcript_words: 3203
ingested_at: 2026-07-30T04:44:51.827Z
ingest_version: 1
---

# Forward Deployed Engineering 101 — Kevin Bai, Anthropic, ex Palantir & Rippling Founding FDE
**Channel:** AI Engineer · **Uploaded:** 2026-07-28 · **Duration:** 17:48 · **Views:** 7,188  
**Watch:** https://www.youtube.com/watch?v=KwhgfwOSToQ

## Description

Look at public software companies and very few ever crack half a million dollars in average contract value, and that gap is where forward deployed engineering lives. Kevin Bai's 101 starts from the shape of the deal: when your buyer is not technical and the thing you sell is not a finished product they can pick up and configure themselves, you cannot just ship software and walk away. You loan them engineers who build a real solution on top of your platform, so the customer is neither buying a product nor a service but the outcome in between. That is the model Palantir made famous, and it is how you land Fortune 500 contracts a self serve motion never reaches.

The trap is doing it as pure custom work. Build a bespoke thing for every customer and you reinvent the wheel each time; what makes a forward deployed program work is a platform of reusable pieces the engineers assemble against, not a pile of one offs. So starting one comes down to two questions: is your product complex enough to need hand holding into a non technical org, and do you have engineers who can carry that. What has changed since the Palantir days is that building is easy now and nearly everything is agentic, which pulls this once niche motion toward the center of how software gets sold.

Speaker info:
- https://x.com/zkevinbai
- https://www.linkedin.com/in/zkevinbai
- https://zkevinbai.com/
- find Kevin on FDE Pod https://fdepod.substack.com/ https://www.youtube.com/@FDEPod

Timestamps:
0:00 - Introduction: what this 101 covers
1:47 - What Palantir does, and where FDE fits
3:14 - Selling a solution, not a product or a service
4:18 - When your buyer isn't technical
5:59 - The business case: landing large contracts
7:16 - FDE as a partnership on a reusable platform
9:48 - How to start: two questions to ask
11:34 - What has changed since Palantir
13:08 - Q&A

## Chapters

- [0:00](https://youtu.be/KwhgfwOSToQ?t=0) Introduction: what this 101 covers
- [1:47](https://youtu.be/KwhgfwOSToQ?t=107) What Palantir does, and where FDE fits
- [3:14](https://youtu.be/KwhgfwOSToQ?t=194) Selling a solution, not a product or a service
- [4:18](https://youtu.be/KwhgfwOSToQ?t=258) When your buyer isn't technical
- [5:59](https://youtu.be/KwhgfwOSToQ?t=359) The business case: landing large contracts
- [7:16](https://youtu.be/KwhgfwOSToQ?t=436) FDE as a partnership on a reusable platform
- [9:48](https://youtu.be/KwhgfwOSToQ?t=588) How to start: two questions to ask
- [11:34](https://youtu.be/KwhgfwOSToQ?t=694) What has changed since Palantir
- [13:08](https://youtu.be/KwhgfwOSToQ?t=788) Q&A

## Transcript

[0:16] All right. Thank you so much, Basil, for the introduction. Hello there. Those of you in the audience, thank you so much for joining us today. My name is Kevin. Uh, technically we don't really have titles. So I am member of technical

[0:28] staff at Anthropic working on the applied AI team. Uh before this I joined Ripling to help build their FTE function. I was the first person to join that team and we grew it to uh around 25 in a year. Um and so that's pretty cool.

[0:42] And then before that did a bunch of stuff at Palunteer. But you know list of companies is not really that interesting right because we're talking about a function. And what I I hope you're all here for is to hear about forward

[0:54] deployed engineering. Um if you are here for for evals or if you're here for I don't know videos of kittens that's probably one room over. Uh I'm also not qualified to talk about those things. So I am trying to give a talk to you on for

[1:09] deployed engineering 101. So what I want to do is walk you through the history of the role, the nature of the function, why Palunteer chose to adopt FTE as its go to market motion and then right extend that to maybe how you could apply

[1:26] it to your own organizations and businesses. Um and if possible at the end would love to take any and all questions. All right, does that sound good? >> Yeah. Okay, that's too low energy. Does that sound good? >> There we go. Oh my god, it's a

[1:41] conference, not a funeral. Let's go. Um, so, okay, high level, right? What does Palunteer do? Palunteer is a technology company that creates a technology platform, uh, a software platform called Foundry. What Foundry does is Foundry

[1:59] enables organizations of arbitrary size to centralize all of their data in one place to create an ontology. What that means is to create proper nouns out of their data. So that instead of having, you know, table one, table two, table

[2:14] three, if you have warehouses, you have a single table that's the source of truth for warehouses. And then on top of that, Foundry enables companies to build applications. Okay. So if I was to explain that to some industry leader or

[2:30] other, they would be like, cool, you've made my data organized, but what does that do for my actual business? Right? And and so that's that's kind of where it falls short if you're just selling technology. Um and then the other piece

[2:41] that's kind of interesting, right, is that you as a app building platform Foundry, your success is determined by how well your customers can use your particular piece of software. And so there's also a huge tax, right? Not only

[2:54] are customers paying to invest in this platform, they are also needing to train up their people to get effective on it. And then and only then are they able to build things. That is a terrible way to do business. And we soon realized that

[3:06] instead of selling just services or just products, you sell both. Um, so it's one combined thing where the customer is neither buying a piece of software nor are they buying the time of someone. They are buying an outcome, right? You are sending over

[3:22] really smart people who will go and understand the nature of the customer's business. Build them a solution on top of this platform foundry and then the thing that you get in the end is that outcome because if you are a a leader of

[3:37] industry right if you're working in CPG you care about you know getting more placement on the shelves or you care about higher throughput of sales you don't really care how the data is organized and nor should you care right

[3:47] that's more of an implementation detail. So where does this notion come from? This ridiculous idea of like sending engineers to the forefront because I'm pretty sure of all the folks in the audience, you know, if you're familiar

[3:58] with software engineers, myself included, where we're some of the last people that should be customerf facing. And so I want to make this like really really clear. Okay, you can imagine this as a punit square. Um it has to do with

[4:11] what it is you're selling and then who it is that's buying from you. So if you sell a very technical platform or product, right, let's forget Foundry for a second. If you sell a GitHub or if you sell um a data dog, it is a incredibly

[4:27] complicated piece of software. However, your ICP, right, are going to be CTO, CIOS, and then your users are going to be software engineers. They're going to be people who can take and absorb this complexity and use it because it's part

[4:39] of their job. The other situation is you are selling something that's not that complicated. Um, and your buyer is not that technical, which is also fine, right? Say you have a tool, uh, something like a Rippling or something

[4:51] like a Jira or like a Slack, and those tools might be complicated, but they're configurable. They're not meant to be developed upon. And so, it's fine to be selling to a non-technical buyer. You only need FTE if you are in this

[5:05] weird unique situation of Palunteer where you are having to sell something very technical to a non-technical buyer. Now, historically, why was that the case? You know, like, didn't Palanteer like to do things easier than that?

[5:18] Well, it's because the nature of Foundry, right, which is an app building platform, makes it inherently not as interesting to the large tech companies. Uh, Google, Meta, what have you, these days, the labs, they all have great

[5:30] software engineers and they can build whatever apps the organization needs. Um, but when you're selling to say uh, you know, Fortune 500 client that works in oil and gas, they're not really going to have that kind of engineering depth,

[5:42] right? Their pipelines are not data pipelines. It's more going to be, you know, uh, fluorocarbons or something like that. So, for them to really get full value of your platform, you could either trust that they'll spend the time

[5:54] to, you know, not only buy your platform and use it, or you could just say, "Hey, here's the setup. We will loan you some really good engineers that you don't have to hire, recruit, manage or retain. They will be trained in not only how to

[6:08] use this platform, but they will also, you know, work really closely with you in the same way that if you were at a fine dining restaurant, right, the waiter is there to cater to your every need and they will figure out how to

[6:19] solve you the problem and then build you the software. And so that ended up being the way that Palunteer went to market with the Fortune 500 um with the global Fortune 500 and and how has that turned out, right? Because because there's no

[6:32] point in me just getting on stage saying, "Oh, this is so cool. You know, here's the details, blah, blah, blah." So, I'll give you some numbers. If you look at the public SAS companies in the Fortune 500 and you measure them by ACV,

[6:46] average contract value, so uh you know of any given customer, how much money is that customer spending with that particular vendor? Balance is first at 4 million uh last I checked. Next biggest is Service Now at 1.2. Next biggest I

[6:59] want to say is workday at 600K. And then there is not a single public SAS company that even cracks half a million ACV. So just by these numbers I would say it works pretty well. Um Palunteer is at some ridiculous valuation now uh and

[7:13] only at a few thousand headcount. Um so okay what is this FTE thing? What is this model? What does this mean? Um do we have any startups in the audience or anybody working early stage? Yeah. Okay. Some hands. So I'm sure you're familiar

[7:27] with the concept of a design partnership. So in the early days of a startup when you don't know what your product is and your customers don't know what they're buying, you say, "Hey, let me work with you really closely. Let me

[7:38] figure out what it is you need. I will, you know, spend my time, my energy, my technology, my resources. You just give me the context on what your problem is and I'll build you a really good solution." That's generally how most

[7:49] startups at least in the B2B segment find product market fit. Um FDE is basically taking this concept of a design partnership and scaling it up into enterprise. Right? That was the core assertion of Palanteer was that who

[8:04] said who said that design partnerships were only for the beginning stages of a company. Why can you not just do that at scale at enterprise? Well, some of you in the audience who are very smart and observant might say, Kevin, you can't do

[8:17] that in the enterprise because you can't maintain it. If you build something custom for every single customer, you are going to be hurting a whole bunch of cats and you're going to have, you know, a a bunch of really shitty code and and

[8:28] no engineer is ever going to work for me because they can't maintain it and no one wants to learn 55 repos. And you would be totally right. If you were to implement an FTE function where each FTE is building entirely from scratch, my

[8:39] friends, you do not have an FTE function. You have a dev shop. Um, nothing wrong with that. Of course, those are really profitable businesses. But the thing that makes an FTE program different is that they are building on

[8:50] top of a platform. They are never writing software from scratch. Right? There is already a set of primitives on top of which they could assemble them into some application, some workflow, some solution that is arbitrarily

[9:04] valuable to their customers. That is kind of the really key ingredient here because otherwise you are reinventing the wheel from scratch again and again and before you know it your P&L will eat you alive from the maintenance costs um

[9:17] if your engineers don't all quit first. Okay. Uh I feel like I just said a lot of words. Do people have a general idea of what I'm talking about? Yeah, some hands. Okay, great. Great. Oh my gosh. Um I'm above where I thought I'd be. So,

[9:32] okay, you're now saying, Kevin, that's cool. You know, you've just told the story, you've given some frameworks, but then I I'm not here to to listen to you talk, right? I want to know how to apply this to my organization, to my business,

[9:45] how to bring this back to my team. Um, so how do you go about doing that? First and foremost, and this is the thing that I advise to everyone who's thinking through the concept of forward deployed engineering is really ask yourselves, do

[9:59] I need an FTE function? Like, do I need one? Not want, right? It's easy to want things that are in vogue. It's easy to want to do, you know, AI because that's what everyone else is doing. But like, do I need one? Do I have some corner

[10:13] case in my business where I must must GTM a technically complicated thing to a non-technical buyer? If I don't have a situation like this, probably FTE is not the right fit. There's a lot of great things you could do uh with Devril and

[10:29] building a great developer engagement uh team if you're having a technical go to market motion. There's a lot of great things you can do with an SLG salesled motion if you're doing more traditional SAS. Right? It's only in this situation

[10:40] where you need FTE. That's the first piece. So the second piece is do I have a platform or phrased another way am I willing to invest in building one because I assure you right no matter how tempting it is to uh have these

[10:54] engineers that can make you money if they are not building on top of a platform with some number of shared primitives you are in for a very bad time. I I just I could not begin to stress the amount of maintenance burden

[11:06] that will be on your team even if you have a robust platform. Um, never mind if you don't have one. And so these are the questions that I would really encourage you to think about from an FDE 101 perspective of do I have to sell

[11:21] something complicated to a non-technical buyer and do I have a platform on top of which my FTEEs can build? Okay, now for the the AI piece because that's obviously happening in 2026. Um what's changed since Palanteer uh came onto the

[11:37] market which I think was like 2004 or 2005 um and now is that uh artificial intelligence has made it really really easy to build really really easy to write code and also really easy to build sophisticated customizable software for

[11:54] customers. I mean, how many people in the audience are building agent for X, you know, insurance, legal, what have you, right? Um, I don't even need to see the hands for this one. But the thing that's changed is not that the world has

[12:05] suddenly realized Palunteer's FTE motion is a really good idea and they should do that. My personal hypothesis is that the thing which has changed is that the nature of doing business in the software industry itself is what's changed

[12:20] because now nearly every platform is agentic. And that means nearly every platform is customizable. And that also means nearly all of you are going to have a situation where your customers have no idea what the heck it is that

[12:33] you actually do. And if you leave the success or failure of your product to their hands and to their ability to implement, I I assure you this is not uh you know like going to be an easy motion as you try and sell either into the up

[12:48] market or try and expand horizontally or vertically. All right, I think that's enough words out of me. I would really like to hear some questions from the audience. Uh, anything and everything is on the table except my current work.

[12:59] Thank you. [applause] Hands. Yeah. >> Can you give a little more detail like how atomic should these primitives be? Yeah. Just some example. >> Yeah, that's that's a really good question. So, >> the question first. Oh yes. So the

[13:24] question was um talk about shared primitives. How atomic should those shared primitives be? What does that mean? Um so okay if you are trying to sell a uh a a platform where you're building you know something that involves data models right um perhaps

[13:42] one place to start is is not having to you know define a data model from scratch. Um, but I would say, you know, um, and this is a very lawyerly answer is that it depends on what it is that you're getting into. Um, there's a lot

[13:56] of industries and a lot of situations where you can get away with having very robust primitives, right? Where the app itself is like 60% built and then people are just customizing the other 40%. Uh and then there are certain use cases in

[14:08] certain industries and spaces where that's really not appropriate and you you need extremely granular uh configur configurations and like extremely granular tooling. Um a good example of a platform that I think all of you should

[14:21] be familiar with is AWS, right? Um I'm sure you know many of the folks in the audience are really great engineers and if you wanted to you could you know buy your own server racks and then get them online and then maintain them. But who's

[14:33] really done that since you know the 1990s? Um but like within AWS right they give you a shared set of primitives uh like DynamoB so you don't have to you know invent a database from scratch uh but that's because they're trying to

[14:45] serve an extremely broad swath of customers so it depends on your user base anyone else yes right there Yeah. So the question is on uh what is the collaboration mechanism? Uh you know if two FDES or multiple FDs work on a

[15:12] project I I would say that's really encouraged. Um that's a really good pattern because uh especially when you're doing custom work for a customer, the last thing you want is like a single point of failure, right? Where uh one

[15:24] person knows all the information, they go on vacation and then you're kind of screwed. And so >> two different companies, >> two different companies. >> Yeah. you go like let's just say to do a project you're going >> like working on the same project like a

[15:39] bake off okay or like collaboration like like a partner uh yeah yeah that model exists as well um it's just no different than having a contractor right uh you you have to figure out who the contractor is in that situation um but

[15:52] that's kind of the mental model >> all right uh right there in the back that goes on That is a really good question. The question is uh what engineering changes go onto the platform versus what uh engineering changes go onto the forward

[16:20] deployed side. So anything that's bespoke and unique to a particular customer um is uh something that should really only exist for that one customer. Anything that can be generalizable should be generalized in the long term.

[16:34] Now, when you begin uh your FTEing, right, probably you're not going to have a lot of different primitives, but that's okay because FD is also a great way to scout ahead and to find what additional product services you can

[16:46] build upon to further enable the success of your business. Um, how we doing on time? Good. Oh, no, not good. All right. All right. Last question right there. What is the perfect profile? >> Oh, this is so good. What is the perfect

[17:02] profile of an FTE? So, the the tagline that I will leave you with is that a FTE is nothing more than a customerfacing software engineer. And so, um it is a person who you would hire as a software engineer on your team, but at the same

[17:21] time, you would trust them in front of a customer in some shape or capacity. And then the rest you'll have to figure out as you go because we are capped. Thank you so much. [applause] >> [music]
