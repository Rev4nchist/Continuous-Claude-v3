---
video_id: jQDXzEVHMSE
title: "Building Turbopuffer: Gergely Orosz (@pragmaticengineer ) × Simon Eskildsen (CEO)"
channel: "AI Engineer"
channel_id: UCLKPca3kwwd-B59HNr-_lvA
channel_slug: ai-engineer
url: "https://www.youtube.com/watch?v=jQDXzEVHMSE"
upload_date: 2026-08-03
duration_s: 3389
duration: 56:29
view_count: 3544
like_count: 65
subtitle_lang: en-orig
transcript_source: auto
transcript_words: 11829
ingested_at: 2026-08-06T11:00:33.635Z
ingest_version: 1
---

# Building Turbopuffer: Gergely Orosz (@pragmaticengineer ) × Simon Eskildsen (CEO)
**Channel:** AI Engineer · **Uploaded:** 2026-08-03 · **Duration:** 56:29 · **Views:** 3,544  
**Watch:** https://www.youtube.com/watch?v=jQDXzEVHMSE

## Description

This fireside chat between Gergely Orosz and Simon Eskildsen explores the technical journey and engineering philosophy behind the database company Turbopuffer.

Video Timestamps
0:00 Introduction and Simon’s early history with computers
3:02 The International Olympiad in Informatics and early competitive programming
4:13 How Simon was recruited by Shopify while still in high school
8:46 Engineering challenges and scaling infrastructure at Shopify
14:56 Decision to leave Shopify and the creation of the "napkin math" project
20:40 The origin and technical motivations behind Turbopuffer
24:46 Design challenges of building a database on top of S3
28:41 Cursor becoming the first major customer
35:36 The meeting with Jensen Huang and Nvidia’s push for GPUs
39:01 The competitive reality of cloud infrastructure and CPU scarcity
43:06 Philosophical perspective on venture capital and funding
51:45 Building a remote-first culture with the "campfire" concept

Quotes

(19:49) "Because you batch. So an f-sync happens on usually a 4K... it's not intuitive. It's actually—I got caught—I just got obsessed with this question."
(30:33) "Yeah, you could do a million vectors for a dollar. And before that, I think the cheapest was maybe $100 per million for something that actually worked."
(36:56) "[Jensen Huang] said, 'Judging by your slide, maybe you should [pivot into vapes].'"
(43:53) "I promised Cursor that Justine and I could get their bill to 4K a month... that's the pricing we ship with."
(49:54) "The third reason to raise capital is for the founder's ego... I wish that it was more talked about because you're diluting all of your employees when you do it."

## Speakers

## Chapters

- [0:00](https://youtu.be/jQDXzEVHMSE?t=0) Introduction and Simon’s early history with computers
- [3:02](https://youtu.be/jQDXzEVHMSE?t=182) The International Olympiad in Informatics and early competitive programming
- [4:13](https://youtu.be/jQDXzEVHMSE?t=253) How Simon was recruited by Shopify while still in high school
- [8:46](https://youtu.be/jQDXzEVHMSE?t=526) Engineering challenges and scaling infrastructure at Shopify
- [14:56](https://youtu.be/jQDXzEVHMSE?t=896) Decision to leave Shopify and the creation of the "napkin math" project
- [20:40](https://youtu.be/jQDXzEVHMSE?t=1240) The origin and technical motivations behind Turbopuffer
- [24:46](https://youtu.be/jQDXzEVHMSE?t=1486) Design challenges of building a database on top of S3
- [28:41](https://youtu.be/jQDXzEVHMSE?t=1721) Cursor becoming the first major customer
- [35:36](https://youtu.be/jQDXzEVHMSE?t=2136) The meeting with Jensen Huang and Nvidia’s push for GPUs
- [39:01](https://youtu.be/jQDXzEVHMSE?t=2341) The competitive reality of cloud infrastructure and CPU scarcity
- [43:06](https://youtu.be/jQDXzEVHMSE?t=2586) Philosophical perspective on venture capital and funding
- [51:45](https://youtu.be/jQDXzEVHMSE?t=3105) Building a remote-first culture with the "campfire" concept

## Transcript

[0:01] [music] All right. It's great to be here and today with me here I'm I'm Gerge, author of the pragmatic engineer and I'm excited to have a chat with Simon Ericson uh founder CEO of Turbopuffer a very technical CEO and we're going to have a

[0:42] pretty technical discussion but before we jump into it Simon I wanted to ask where did you fall in love with computers? um through PowerPoint. >> PowerPoint you I don't know if any of you know this but in power well you probably know this

[0:59] but in PowerPoint right you can make the the diagrams and stuff when you click them go to another slide that becomes touring complete real quick right you can sort of you know create very complicated convoluted games and

[1:13] then at some point you know you make it through the Microsoft Office suite and you discover Front Page. Do you remember Front Page? >> Yeah, I remember Front Page. It it it was supposed to eliminate the need for all any front-end developers.

[1:25] >> Exactly. And it it only worked in Internet Explorer. I remember a heartbreak I had one day when someone opened a website I created in Firefox and it just it was it was all over the place. And then one day I accidentally

[1:37] clicked the HTML thing in front page and it just showed all of this stuff that I couldn't make sense of and it just started looking at it and then going online and finding little snippets that you could add in to make the cursor change and all of these

[1:50] different uh different things and then it just sort of escalated from there. Then you upgrade to Dreamweaver and now you're coding and then you're like well how do you make the pages dynamically? you learn PHP and then for me I

[2:03] exhausted the internet on Danish language programming advice. >> Mhm. >> Um and I was I was around 11 or 12 and so I just you know went and got addicted to World of Warcraft for four years but that gets you really really

[2:17] good at English. [laughter] So you kind of start hacking get into deeper. Now the logical step would have been to just you know go to university and learn properly about this stuff. But that's not what you did did you? I mean

[2:34] I just um I I started just I I mean you know then I learned video games then I learned English and then you know this like massive arsenal of the web. I now it'd be very interesting because the LLMs would just speak Danish to me and you

[2:49] could just you wouldn't have hit the wall like I did. Um, so that would have been very interesting. Maybe I would have been better at programming. That would have been nice. And then I Yeah. Then I just started picking up jobs and

[3:00] things like that throughout high school. And when I was in high school as well, I got exposed to this thing called the International Olympiad in Informatics. You heard of this thing? >> Yeah. Um, and I had a I had an internet

[3:12] friend and she lived in Australia and she was on the Australian team and she told there's probably something for the Danish team as well, but I had never I'd never heard about it before. And so I found it on some like little mysterious

[3:23] website and then applied and then solved these programming problems that look very different from the HTML and PHP things that I'd solved until >> were like the algorithmicalish programs. >> Exactly. It's sort of like this is not

[3:36] actually the kind of problem you would see there but I think it illustrates well the kind of problem that you might get right is you could imagine something like okay here's like n trucks here's m packages the m packages have these

[3:48] dimensions give me which trucks which packages should be in right and then do something optimal like that's an npmplete problem you can't solve that but you could compete with everyone else in the competition of doing the best thing so

[4:01] it's these kinds of problems right >> um and so I started doing that. In high school, I was working um I was working as well um for a startup. Um and then I just Shopify found me while I was still in high school. >> And and the whole like Shopify found me,

[4:18] was it through your open source contributions? Was it was it something else? It was because I had written an article where I had I had I dropped my iPhone and it was you know the iPhones are a lot like there used to be a time

[4:33] right where you drop your iPhone and you just knew it was over for the screen. >> It doesn't really happen as much anymore like the screens have gotten a lot better but back then it was like yeah one drop and it was dead and it just

[4:43] couldn't use it anymore. And so I went back to one of these old Nokia brick phones. And this is back in 2013. And people hadn't really realized all the pernicious effects of smartphones at the time. And so I wrote this article about

[4:54] how oh my god I'm like calling people and I have my sense of direction back. Um and I wrote an article about it. And this article it went on hacker news briefly and it um New York Times decided to feature it. >> No way.

[5:08] >> Yeah. And so a lot of traffic was driven to it and then some astute Shopify recruiter put it all together and um and I had a call with them and then I don't think they realized that I was still in high school but um but I had a great

[5:24] call with them. They invited me on site to Ottawa, Canada. Um I had no idea what Ottawa Canada is. I think the email says something like what's an Ottawa? I had no idea. Um, and so I went there and it was just like walked into the building

[5:38] and it was just a just felt right. Um, and so I I I interviewed with them and then said, "Well, I got to finish high school first and then uh and then I moved to Canada uh to to to work at Shopify." Yeah. In 2013. >> Yeah. I think that's that's a like legit

[5:55] excuse for like not even worrying about college and and university. >> But I did it crossed your mind. >> It did. I thought I was going I thought I was doing a gap year. I thought I was like, "Okay, I'm gonna go work at

[6:06] Shopify for a year and then I'll probably go back and do but I would just I was very insecure at the time about the fact that I hadn't studied computer science and my only exposure had been all the II competitions which is a

[6:18] pretty good crash course in a lot of computer science and if nothing else it had really taught me that you can just sit down and read a paper and just figure it out if you spend enough time on it." So I did I did that repeatedly

[6:30] and in my first year at Shopify I just every time I heard something that I didn't know what was I noted it down on a piece of paper and then I went home and then that evening I would just read about it because I felt insecure that

[6:40] like well if someone mentions mentions like TCP surely they know exactly what's in the three-way handshake and how TLS is like layered on top and they've looked at Wireshark and all of that. I don't think that's true but that's what

[6:50] I thought. >> So I went and did that for everything that I encountered. Um, so that was a really good crash course and then very quickly it became clear that well I just want to continue doing this. I don't want to go go somewhere else and then

[7:02] come back to this because I felt like I'd already found what I wanted to do. So it sounds sounds like it was a pretty good combination of like you just having this like very natural insecurity like you know you're young, you know, you

[7:12] don't have the education that everyone else has and inside a company that's just doing pretty like cutting edge stuff even at the time and even even to today, right? Like they're they're leading. So you just kept self-seing

[7:23] yourself like just catching up and go and then do I understand that you just went deep in every concept that you understood. You didn't like just like try to understand a surface level but like go as deep as you can search on the

[7:33] internet buy books whatever that is. I think it was just that I just wanted to know keep learning how computers work and I think that this is something that I now look for when we interview engineers is that you just you

[7:46] can't help yourself but trying to peel back the layers and for me that ended up with the infrastructure layer that was you know the people closest to the metal at at Shopify and I would just always sit next to them at lunch because I was

[8:00] working on the on the product side but I just I couldn't help myself. I was so I just wanted to learn what it was when they were talking about a reverse proxy. I'm like, why is it reverse? I I still can't answer that. [snorts]

[8:15] I I I mean, okay, [laughter] you know, well, what's in reverse? Because it's a proxy, right? I don't I don't know. I don't know. It's like an inverted index. Like what's inverted? It's like it's a terrible name. Anyway, yeah,

[8:34] I I mean it's still better when when you get the NAT nat tables, the lookups, some of those things like some of that. But yeah, I hear you there. There's some like weird names with this, but at at Shopify, what were some of the kind of like hard

[8:50] engineuring challenges that you engineering challenges, outages, like like learnings that kind of defined you that were really also fun at the time or interesting to learn, but it would have been hard to get it elsewhere. Yeah. So I think it was, you

[9:04] know, in the 2010s there's like a bunch of SAS companies that that scale really quickly and I felt so fortunate to have a front row seat to that and so I ended up on the infrastructure team and this was back in you know 134 and uh Docker

[9:18] was coming out and so we were containerizing everything and we were just every single year we had to you know the growth rates of of of SAS sometimes seems quaint in comparison to the growth rates of companies today but

[9:30] it was a company that was growing at you know 120 40% year-over-year. Um, and so every year we were just preparing for a Black Friday that was going to be a lot worse than the last. And this is back in the day of we're buying physical

[9:42] hardware, right? We have to like place an order at a particular point in time and do some interpolation based on that. Um, and the software also had to scale. And when you're scaling most software, a lot of the application layer problems

[9:54] end up back at the database layer. >> And so I just naturally found myself at this layer between Rails and the databases. Shopify didn't at the time at least contribute many patches to the databases themselves but mostly just

[10:06] spent time orchestrating. So we were doing sharding because as um my my dear boss Camilo used to say you can't cache rights. So there's a fundamental point where you you just you have to move beyond a single shard. Um so I wasn't I

[10:23] joined around the time and they did the sharding and they did it I think they did the cut over a week before Black Friday which is mindblowing. uh and very but it worked and then the the subsequent years we worked on things

[10:36] like going into multiple data centers. We also had this big mysterious reddish server that was like you know 128 GB of RAM which was a lot at the time. Today it's not that much and no one really knew what was in it and then it went

[10:47] down one day and people were like well that's super terrifying. Um because people had just been treating it as this KV store. Um and so we started splitting it out. We did all this stuff around making sure that if you if you if you go

[11:02] visit a Shopify store and the thing that stores your sessions is down, the right behavior is not just for the entire the of everything to be down. But that's kind of the default failure mode, right? You're not going to rescue all of that.

[11:15] Um unless you're in a programming language that really forces that decision. So we did things like um build this matrix out of okay well this service when this component is down should act this way. Um and I found myself writing the test suite for a

[11:30] bunch of that. And then I was like okay well we can't just mock all of this. And so um I came up with this idea at the time of like oh what we're going to do is we're just going to um shell out to GDB and then into the process and then

[11:41] close the file descriptor to the database to simulate the through the entire layer that the database fails. That was a little crazy and we never shipped that on CI but it did uncover a massive amount of issues in Rails that'

[11:53] be upstream and things like that of around just like handling failures at the connection layer. So then I moved on to create this proxy called Toxyroxy and >> have you heard of this before? >> No. No. >> Yeah. Toxyroxy is it's just like a layer

[12:06] 7 proxy that sits in between um you and well layer four but in between you and the databases. So you basically have just like this proxy and then my SQL whatever doesn't speak the protocol but then you can do an API call say take

[12:20] take uh take the database down make it slow um and over time it also added layer 7 things of like do a bunch of failures this way you're not mocking the low-level drivers but you're testing the drivers and their failure handling as

[12:33] well so then this entire matrix could be implemented in CI so the basically the proxy was just like a really thin layer which like was passed through but you built the functionality to like simulate problems with database or things like

[12:46] data corruption or whatever you wanted to do. So you could just do it in there and then you can anything that built on top of it but but then Oh yeah and then everyone had to like call this proxy or it needed to be on in a layer.

[12:58] >> Exactly. So you could do like do like my you know proxy.mmysql downdown and then pass it a lambda of what you wanted to do like get this page do a checkout whatever with the sessions table down and this just uncovered

[13:11] tens of issues right in the myql driver in the rails like it's just like no one in the ecosystem had been testing for this and it was very difficult to see this in prod right because in myql down you're focused on just getting back up

[13:24] and not like what could the application actually have done. Yeah, it's interesting. Of course, we're going to talk a bit more about databases obviously, but just thinking about how a lot of the problems or some of the most

[13:33] gnarly problems in large systems are always to do with state and I never connected until now that I mean state is usually there's a database. If there's no database, if you have stateless services, you know, I mean, you still

[13:44] have problems, you have nodes going down, you have, I don't know, corruption, whatever, but it's usually like more isolated. But basically, like if we have state, we typically have databases. is if we have databases and

[13:55] if you can simulate these problems suddenly you can I mean you you can like predict a lot of things but the problem with state often time is it's really hard to simulate problems happening ahead of time unless when they happen so

[14:08] did you it sounds like you have pretty good success with >> yeah I think to my knowledge it's still um running in like the CI system of Shopify today I don't know if anyone in the crowd is from Shopify but I'm pretty sure that it still does um and so we

[14:22] wrote all these tests against it to implement and all of these different uh different failure conditions and it just yeah it was it was it worked out great. So you spent eight years in total at at Shopify. So like starting from like all

[14:33] right just a gap year it just went on a year a year and another year. Um at what point did you think about leaving and why and what was your kind of decision framework? It sounds like you or you were like on Epic right now even today

[14:47] Shopify it's doing wonderful. It's probably doing even way better than like like you know that growth kind of kept on. So I'm sure there would have been an argument to stay and you know stay on their August ship. >> Yeah. So I I spent I spent eight years

[14:59] there from 13 to to 21. Um and I I think there just came a point where I wanted to see something different again. I've been inside of Shopify since I was 18 years old, right? I'd been seen one other startup in high school. I was

[15:14] like if I want to learn more about computers and learn faster, it might be time to inject some novelty into this function. Um, and so I I left in in in 21 and I'd worked on so many different parts of the infrastructure like

[15:27] caching. Um, me and Justine, who's now my co-founder, we wrote the entire storefront um, storefront for Shopify, um, which powered almost 100% of traffic 18 months after we embarked on it. Um, we've worked on running Shopify in

[15:40] multiple data centers. We've worked on so many database scaling projects like caching, all of these different things, right? Um, a lot of the a lot of the scalability came from the Kardashians launching lots of products on on

[15:52] Shopify, which would force a lot of traffic. Um, but that's that's eventually how I left. And so when I left, I didn't really know what I wanted to do. And so I one of the projects I had while I was at Shopify was this napkin math project. Have you seen this

[16:07] >> napkin math? No. >> No. Um, so napkin math was essentially just this table that I maintain on GitHub of how much bandwidth can you drive to DRAMM, what does a roundtrip to S3 cost, and how long does it take, how much bandwidth can you drive to an NVME

[16:26] SSD, how much bandwidth can you drive to an EBS volume? Just a collection of probably there's probably like 50 of these numbers and then a RS script that generates them all. um what all these things cost? What do you like? What does

[16:39] a gigabyte of memory cost? $2. What does a gigabyte of S3 cost? 2 cents. What does a gigabyte of um this cost? 10 cents, right? What does it cost on spot? What does it cost on a three-year commit? Like I had just have a massive

[16:50] table and then create flash cards for almost every single cell. So I know all these numbers. And this was a project I started taking on at Shopify because I found myself in um this role a lot where I would go in and review a project,

[17:02] right? So some product team would be like okay we got to do we got to build this thing so we got to build this infrastructure to support the feature and a lot of the times they would say okay well we've gone and benchmarked it

[17:12] on database A but the benchmarks are not very good so we're going to go with database B and I hate benchmarks so much because that's not a satisfying answer to me to me it's like this does not jive maybe my intuition database A that you're saying takes 10

[17:35] seconds to do this should take 10 milliseconds if you do the napkin math right if it's a search query right it's like okay you're searching for three terms there each term has this many documents that match it that's this many megabytes we inter

[17:51] intersect these many this many lists you have DRAM bandwidth on multiple cores of 100 gigabytes per second this should take 10 millisecond you tell me the benchmark takes 10 one of us is wrong. Either there's a gap in my understanding, which is very

[18:06] likely, or you would benchmark the wrong thing. And in some ways, some reasons, right, it's like, okay, you've done a benchmark. You don't didn't realize that your benchmark is doing a distributed query across a 100 different nodes. And

[18:18] so, of course, the P99 is going to be really, really high, right? Unless you've cut that off or or made some different set of trade-offs. So I just found myself in these discussions repeatedly where people were making infrastructure decisions based on poor

[18:30] benchmarks. And so I needed some I I needed some ammo to go in and just be like okay we can just do the calculation right here and then. Um because I was always doing these like little demos or like writing little prototype scripts to

[18:42] to demonstrate this. But it was just I just the argument of here's how a beach tree works. This is how many pages we have to visit. This is what a random SSD read takes. It takes one millisecond. you have to visit a thousand blah blah

[18:54] blah blah blah and then present it back and see if this is the difference to your query. Well, like is the query plan correct? Like is there a bug in my SQL? Do we have bad discs? Like what's the discrepancy here? And I just got caught

[19:05] with that bug. And so after I left Sha, I was just writing a lot of articles about this. I was just like, well, how long does should this query take? And then I one hypothesis I had at some point is like, okay, well, how many

[19:16] writes per second can MySQL do? Well, shouldn't the amount of writes per second that MySQL do equal the amount of f-syncs that you can do per second? That sort of makes sense, right? Every time you do a write, you f-sync to persist to

[19:27] disk. So, how many f-syncs can you do per second? Well, an f-sync takes one millisecond. So, you do a thousand writes per second. That well, that doesn't really match up. Like, feel like a database can do more than,000 rightes

[19:36] per second. Why can it do that? So, that was one of those things where I tested and it's like, okay, well, my SQL on a little dinky box could do 10,000 writes per second. Well, how is that possible? Mhm. >> And now you would just ask how is it

[19:48] possible? >> Because you batch. So an f-sync happens on usually a 4K. >> Yeah. >> Right. But it's like that's not intuitive. Like it's actually I I I got caught. It was like just like you know probably some like 24-hour period where

[20:01] I just got obsessed with this question where like you're writing like the BPF traces and all of that to do all of this. This is like pre-LM so it took forever and you and then I found out that oh every f-sync was like much

[20:12] larger than I would have inferred like oh it's batching you go into the code and you read it and then you found some obscure article by it's always somewhere in like a central German town that's like written some article about like how

[20:25] some intricacy of my SQL works and a patch that they did to it's like the entire internet runs on small towns in Bavaria. I'm convinced. Yeah. And then you decided to start Turbopuffer. Yeah. Did h how did you decide? Did you

[20:42] know what you wanted to build or was it more like I want to build something something databases because you were clearly very into databases. You you've done an awesome job benchmarking like what is the theoretical like limits? You

[20:54] were very familiar with this probably became you know like world expert in in this niche. And then how >> did did you want to go into databases again? >> I think it was there's three things that sort of came to a head. Um the last project that I

[21:12] worked on at Shopify was search and I didn't have a good time. >> What what what did you use back there? Um I don't we don't need to name names of other database companies but it was uh it was one of the one of the like

[21:25] traditional search companies that a lot of different um companies run and it was just very difficult to get it to do what I did and I was just like the projects that touched that database just I couldn't get them to perform at the

[21:39] napkin math and like there's there's no query planner and like I couldn't figure out why it wasn't there and sometimes it tracked and then sometimes it really didn't track at all and so I tried to learn as much as I could to figure out

[21:48] and like start reading the source code of it and I was just I couldn't get it to track very often. It was very difficult to operate and so I just that was sort of like in the back of my head. I never thought I would touch that

[21:57] again. Then the second ingredient was the napkin math project because it sort of just gave me a lot of facility with all of these napkin math numbers of what might be achievable with the machine if you utilized it perfectly

[22:10] >> properly. Yeah. And then the third one was that doing this you know leaving Shopify in 21 having spent eight years there and during that time I did this I called it angel engineering so I like joined my friends companies and then I

[22:22] just vested equity instead of um instead of just investing or something like that and because I wanted to have my fingers in it I wanted to like see what else was out there that's why I left and this problem kept coming up again again and

[22:34] again and again right like ChachiBT came out in 2022 and I was working with with a company then and They wanted to connect a bunch of documents to AI and that's when the context windows were really small. So you had to reach for

[22:47] search very quickly. >> So it's like a few kilobytes. >> It was eight kilobytes or four kilobytes depending on the model. It was very very small. So you had to reach for search very quickly. Right. And >> so I I I worked with them and I was I

[22:59] was I created a little recommendation engine and the recommendation engine was actually quite good. Um, like I s I found out that one of the co-founders wife was pregnant through the recommendations that I was getting when

[23:09] I was running it on his feed. Um, like it was it was it it >> weird but >> it was recommending. Yeah. I mean it was just like you know he was reading about like and I did get permission. I just like I don't think anyone expected to be

[23:22] good enough and just like okay it's this this thing is working and then I ran the back of the envelope math on what it would cost to do this for everyone like all the users. This is a company called Readwise. So it's like articles that you

[23:34] save and then and insert later. And it was going to cost 30 grand a month. And this was a company. It's a bootstrap Canadian company. They spend about five they at the time they were spending about 5k a month on all the other

[23:45] infrastructure combined. So it just it didn't the you know fundamentally in a company if you're doing an investment you have have to run some gross margin on top of whatever you're paying right and it just didn't line up. Um and so we just didn't ship

[23:59] it. I worked on I you know tuned to autovacuum on postcress or something like that which is a good pastime and then you I just couldn't stop thinking about why it was so expensive to store all of these vectors that we were using

[24:12] for the recommendations and I just sat and did the napkin math one day of like can we just use it all in S3 and do some clustering and then organize the files and just the way and it's like maybe you could build that and then

[24:25] one day I just kind of said [ __ ] it and did it and like sat down and started started to like to write it out. Um, and I spent the summer of of 23 just hammering my head against the wall trying to find an approach where I could

[24:39] get the latency that I wanted. Um, >> because the problem with S3 is it has really good durability, but latency we're talking hundreds of milliseconds, right? >> Yes. The P99 on a uh 256 or 512 kilobyte object on S3 um is around 200

[24:54] milliseconds. Um, >> and and you're saying P99 because like when you're talking large scale, you want to care about the P99, right? >> Yeah. I think when you're >> That's why we're not talking about P50. >> When you're designing a system, you want

[25:05] to optimize for the P99. And especially because when you're designing a system on on S3, generally in every roundtrip, you're not doing one request. You're often doing lots of requests, right? >> You're going to hit the P99 real quick.

[25:15] >> Exactly. So, it's like if you're navigating a tree on S3, right? It's like, okay, you get the upper layer of the tree 200 milliseconds. You get like another layer of the tree 200 milliseconds. You get a bunch of leaves

[25:23] of the tree in 200 millonds. So in aggregate you have like you want to look at the P99 probably even the P999 to design the system properly because you will need to minimize the number of round trips that you had to make. So, I

[25:35] just sat and sketched that out um and tried a bunch of different approaches and then and then finally in in in July of 23, I I I got something end to end that seemed to work and then rewrote it probably twice and then released it in

[25:50] in October of of 23 based on um based on just that that summer of of of working through it. And then you kind of you built it on on top of S3 because I guess durability and and all of and just really good. How did you make it fast?

[26:05] We didn't in the beginning or I didn't in the beginning. Um it was just me at the time and it was really like it was it was it was a project. It was not a company. It was not >> it was it was it was to satisfy a curiosity. It was not I did not set out

[26:20] to do this like I'm going to go like raise $10 million and do like I was like I barely knew what a VC was. Like I was like I just had to do this thing and I was so focused on doing it. so clear to me that if I wasn't going to do it,

[26:34] someone else was going to do it and I just became fully obsessed that summer with it. And so the first version was the simplest possible thing. I think I'm a very pragmatic person like I I didn't get buried. I barely read any like of

[26:50] the literature on LSM. I sort of like you know read a bunch of it just like got the basic idea barely implemented that because that would have taken too much time. It was the simplest possible version of what it could be. Like really

[27:00] what you have to imagine is that the simplest way you could do this is you run some clustering algorithm on the vectors. >> You get the clusters and then you put the clusters in files. The cl the files are called cluster one, cluster two,

[27:12] cluster three and then you have another file called centroidids of the clusters and then you do the search by downloading centroidids looking at the centrids and then downloading the n closest clusters. There was a few optimizations around merging some

[27:25] clusters that were JSON in files and so on just to like control some cost and some performance but that was basically it and then getting that to scale. That was the first version. And then how do we make it fast? Well, I didn't even

[27:37] implement a caching layer. I just put the reverse proxy in front of S3 with Engine X and then had it >> know what a reverse proxy is. >> I like I do know what it is. I just still don't know what what the reverse is about. But anyway, um the reverse the

[27:52] reverse proxy reverse things. Um the the performance in this case um maybe that's what it's about by caching right all of the all of the S3 objects. It again it was the simplest like it's like I'm just going to put that in front. I knew how

[28:07] to configure engine X like I've written more enginex Lua than u than a lot of engineext Lua very good software. um just had that cache in front and then the way that I would do things like deleting in the cache was just like

[28:20] shell out to XRX and just remove like things in the in the cache and reverse engineer the directory structure on engine X and that's what we shipped and it was just running on a single server in a T-Ox instance. I was like okay

[28:29] let's see if anyone gives a [ __ ] Yeah. So so far I mean this is kind of like cool engineering and like a cool side project and like a bunch of novel ideas and I you know like I think just some hardcore engineering. How did cursor

[28:41] come into play? Because like when I learned about Turbopuffer, I was talking with Cursor about like how they built their their back end, their database, how they scaled, and they're telling me all these migrations and they were

[28:54] telling me like, oh yeah, so we we were on Postgress, but it didn't no they did something else in Postgress. It didn't even work that well. They went to AWS Aurora, which is managed service of Postgress, and it didn't work well,

[29:04] which is very surprising. And they're like, "Oh, yeah." And then we went to this thing called Turbopuffer, and they worked well. And I was like, what's turbuffer? And they're like, oh yeah, turbopuffer. I think I think they said

[29:14] like we were one of their first customers. And this never computed to me. Curser was already massive at that point. How did you meet the folks? And how did they become would were they the first customer? One of the first.

[29:26] >> They were the first customer. >> The first >> the first. >> No. >> Um they they they reached out um after I just launched on on Twitter. I was like, "Hey, I built this thing." And frankly it was like in I exact you it was like hey launch

[29:43] this thing and to me I was like I am so sick of working on this like I was like I've been working on this all summer I don't know if anyone cares I only want to work on this if anyone cares. Let's put it on Twitter again single Tox

[29:53] instance on a 8 core node somewhere in GCP. I was like if someone goes to prod I'll I'll set it up properly on multiple and like I'll just block on that but let let's see if anyone cares. It was like the MVP of MVP. Anyone who's actually

[30:05] worked in the internal on databases would never have had like would have had too much pride to ship anything like that. Um, and I've just, you know, I've worked on I was just releasing it like a SAS project. Why can't you work on a

[30:19] database like it's SAS? I don't, you know, it's like if anyone uses it, we'll do it properly. I know how to run software with a lot of nines. Um, but it was not a proper LSN like it was very very it was the simplest version of what

[30:29] it could be. And then I released on Twitter. I was like, "Yeah, you could do a million vectors for a dollar." And before that, I think the the cheapest was maybe $100 per million for something that actually worked. >> Yeah.

[30:39] >> Um, and I knew it was reliable, right? I knew like I had these invariants like if you shut down all the VMs, like no data is lost, like all the rights are committed directly to object like it has all the same invariants it had today. Um

[30:51] and cursor reached out and knowing them now I'm sure at the time the cursor was maybe eight people and knowing the founders now I am sure that they had sat at the dinner table one day and we're like the unit economics of what we have

[31:03] right now where all the vectors are in DRAM are not working why hasn't anyone built it where we can put it in S3 and the actual code bases that are actively being used we can put in memory and everything else just sit in opic stores

[31:16] and then we just hotload it in and out of the cache >> makes so much sense right you open the codebase few seconds and it's in RAM and then the queries are as fast as anything else. It made so much sense. So I mean at the time they were if you look at

[31:27] some of Aman one of the co-founders early tweets he talks about uh using S3 for KV caching and things like that which barely anyone is still doing even though >> um the economics >> yeah price wise yeah it's and it's it's

[31:38] very it's very uncommon and I think it will happen right but they were ahead of their time >> and they I think they were I don't know if they were thinking of building it themselves I think that's quite likely um and they found Turboper and it just

[31:50] perfectly pattern matched into that again I don't know if this dinner conversation happened or if this was just inside Harvey's head. Um, but it pattern matched something and so we exchanged a bunch of emails and then something compelled. I didn't know

[32:04] anything about B2B sales. >> Now I love B2B sales. Um, I didn't know anything. I was just like I just want to help them cuz they they were they had some unit economics that didn't line up. So I just went to San Francisco, right?

[32:15] I live in Canada. I went to San Francisco and I showed up at the office and when I showed up at the office they um they were having some Postgress problem that they were discussing. Yeah, the AWS aurora problems. Yes. >> Yeah. Early on. And I was like, "Oh, do

[32:28] you guys have PG analyze?" And they said, "Oh, no, we don't." I let's let's get that going, right? Let's look at it. And it was the same thing as it always is with Postgress, which is autovacuum hadn't run enough and so they had all of

[32:40] these like going to heat when they should be doing index scans and blah blah blah. So, we were talking about all of that. And so, it's just helping them, right? It was like my, you know, my database genes just like kicked in. And

[32:50] I think this built enough trust with them that okay, well maybe if he knows how to help us with the database, maybe he also would know how to build one. And um at this time I'd also approached who I thought was the best engineer who ever

[33:06] worked at Shopify, my co-founder Justine. um and she'd come on and the first thing that she did was um remove the reverse proxy enginex cache with a file-based cache just a direct cache which again great like the S3 thing

[33:20] worked um and so she was online she was starting to work on it and um and cursor cursor cursor then that night was like okay well we're going to migrate and so they migrated everything over the course of like a week or two after that um but

[33:33] cursor was a small company back then right yeah and they were they just in the beginning of their massive rapid growth. Exactly. And I I told them that I was going to reduce their bill by 95%. And I did like we did. Justine and I

[33:47] did. We like they came on and their last bill with their previous vendor and the first bill with us, it was 95% lower. Yeah. And you're you're nice for not saying vendors, but I I can say talks to them and and it's in the deep dive about

[34:01] cursor. It was it was a it was Aurora specifically. Uh so >> this was this was not this was not Postgress. No, this was a >> it was a different one, but it's probably still in the write up. We don't we don't need to name names, but uh

[34:12] yeah, but they were the reason they went there is reliability was their main main pain point. I'm sure the unit economics would have been there, but yeah, this was and then what Swallow told me is he said like look like there's a few things

[34:23] that we did never ever do and he said one of them you should never ever bet your business on a tiny startup where you are their only or biggest customer except for Turbopuffer and he said I love love those guys. So I guess it just

[34:34] comes to show that even in your case like to me what this story is shows is is you can do things when you build highquality things and you're pushing for things good things can happen and on the other side of cursor when you're a

[34:46] startup it's okay to take sometimes irrational risks when you have conviction and it sounds to me that you gave them conviction by showing up in person by helping them by showing that you know you know your stuff like you

[34:58] suddenly brought in your your 10ish or eight years of Shopify experience and your curiosity and They probably took a risk because of that, not because you were some, you know, random vendor. They probably never done that. So, fast

[35:10] forward today, uh, Turbopuffer is now a lot bigger. You're you're working on some some some cool things, but you have this very interesting business where for you CPUs are important, right? You run on mostly CPUs. And you told me

[35:25] a story over dinner yesterday that uh you met Jensen uh and Jensen he really wanted to sell you on GPUs. Can you tell me how that meeting went? >> Um yeah, Jensen Hong, right? >> Yeah. I just I never met uh I'd never met uh Jensen before. We were we were at

[35:43] an event at uh at at Nvidia and we were just doing um presentations in a big HQ. Super impressive. >> Yeah, exactly. they've invited a couple of companies to go and and um and and and talk about um uh talk about our businesses and how we can partner with

[35:58] Nvidia and so on. And I I don't I I don't know. I was like I think I was in a goofy mood that day. And so I went up on on stage and I said, "Um, hey, I'm Simon from from Turbopuffer." And uh and yeah, if you're wondering about the name, it's like if

[36:15] everything goes south, we can always pivot into vapes. >> [laughter] >> I was kind of nervous and this is what I this is what I said and then and then he said back to >> wait who was in the room? Was it Jensen? Was it a direct report?

[36:29] >> It was it was Jensen and then I don't he has like I don't know if it's just 50 direct reports or it was like you know it was there was it was Jensen and then a bunch of the um like Nvidia Nvidia leadership, right? Um cuz you go there

[36:42] and then you talk about that you find opportunities to partner and work together, right? And so I said, "Yeah, you know, so plan B could be that we could pivot into vapes." And then he said, I was already nervous. He said,

[36:56] "Judging by your slide, maybe you should." [laughter] No, he did not. [laughter] And and [gasps] I didn't know what to say back to that. So I said, "Well, Jensen, do you vape?" [snorts] [laughter] He didn't he didn't answer the question.

[37:26] [laughter] And then someone um someone on the um someone on the on the team um wrote to the whole company, Turop Puffer Company, Simon just asked Jensen if he vapes. Um, and then you know this is this is a great start, right? And um, and then the

[37:44] team had team team had sort of talked to me beforehand. I was like, Simon, we got to make sure we don't say the C-word. We can't say CPUs. And so I just couldn't stop talking about CPUs. I was like, AVX 512 is so sick. Like we love SIMD and um, like we

[38:03] we we like there's so many CPUs. They're so easy to get. like um it's just a riot in CPU land. Like you know I I don't I think I stopped short of saying I'm so glad I don't need GPUs. [laughter] But but it was just it I just couldn't stop

[38:19] talking about CPUs. Yeah. And so you know Jensen took an interest in that. Yeah. So who who knows like I'm sure you made you made a memorable impression. Maybe he made it his mission now to like at some point get you guys onto GPUs. But speaking of

[38:34] CPUs, can you tell me a bit what you're seeing inside of the hypers scale, the cloud providers? You're now in AWS, you're you're in GCP, you're on Azure. What I would think naively is there's a GPU shortage and when I talk with

[38:46] inference companies, they are and and and AI labs, they're just getting whatever they can do. I would think getting CPUs is should be easy. Is it? >> No, >> it's not anymore. Why? What's happening? Can you tell us about dynamics on on on

[38:59] the why and what you've learned? Yeah. So, I think that GPUs will probably continue to be scarce. Like, I don't know, maybe there's going to be some surplus. I I refuse to speculate too much about the macro, but I think as as RL is becoming

[39:15] a very very large amount of the workloads that needs a lot of CPUs. So, the labs are sucking up a lot of CPUs because you need CPUs to be like, okay, we need to like teach this model how to how to search. We need to teach it how

[39:28] to use GP. We need to teach it how to boot up bash. We need it needs to run real things and learn from that takes a lot of CPU. >> Um and so I think as we RL is consuming a lot of CPU and then also just all of the agents are running on CPUs, right?

[39:42] They need to do all kinds of very general purpose things on a CPU and so as as as the demand curve is sort of shifting to the right and it's becoming more and more applied and that feeds back into RL by the way, right? because

[39:53] as things become more applied like oh the models are not that good at CAD or ship building I don't know and then you know you have to spin up even more RL environments to do that so I think that's what we're seeing and so we're on

[40:04] the other end of that needing these CPUs we need a lot of NVME SSDs as well um and a lot of this right now is tied up in DRAM right of of where like >> you need a lot of that also for the GPU servers um but I would assume that it

[40:18] gets a lot worse before it gets a lot better on the on the CPU side um and I think even the big companies are fighting amongst each other, right, to get the allocations and even we, you know, we're selling to companies that we

[40:29] also fight for CPU with and against, right? It's uh it's it's it's really difficult and so you write things to try to make sure you get these CPUs as f fast as possible. >> Yeah. And yesterday I was at a dinner that you hosted with your team where you

[40:41] actually have a bunch of Turbo customers. A bunch of them are AI AI labs or or AI startups but a lot of them one of them uh reflection had have hu massive amount of footprint and they were telling me that they're in a situation where they cannot buy more

[40:56] like they when it comes to GPUs or CPUs they max out they have the longest contracts that possible and I didn't realize how competitive it is in the cloud when you you go beyond a small fish to like a medium size or even a a

[41:09] large fish that now like It's it's interesting. So So now you have this and even you're having this this uh kind of fight behind the scenes that is maybe not as visible. >> Exactly. And I mean you you work with the clouds right you work with them to

[41:22] talk about which regions have um have CPU which regions are getting it comes down to power right of like okay well where is the power which is generally where they're going to ship the new CPUs. Um and so we have to work with

[41:35] some of our biggest customers on that. So these are real constraints right that are that are making our way to us. We're just very fortunate that it's very easy for us to run lots of turbuffer clusters because all we need are like a few CPUs

[41:47] and NVME SSDs and then S3 and then we're in a good place. But there's lots of changes that we can make even to the architecture um to try to protect from from a lot of this. Now I'd rather spend that engineering effort on other things

[41:59] but we are very very good at using a lot of very different SKs, right? So we don't need everything to be a particular CPU or instance type. We can run with many even many different types of machine types. Um >> Q meaning that's the it's a fancy name

[42:13] for like the different machine types. >> Yes. Exactly. Right. Like you know C4D or I AG or whatever they're called. >> What's your favorite one? >> Um we really like right now the um C4s on uh GCP. >> GCP. >> Um the Z4Ds are also performing really

[42:31] well um now that we've done done a bunch of of um of optimizations to them. Um those are really really great machine types. Uh we really like those. Um and then the ARM C4As as well um on on GCP. Um we like those. But I think that in

[42:48] general like when you're yeah when you're small it's very easy to suck up a bunch of but at Shopify I was also part of you know deciding ahead of BFCM right a few months out you have to tell the cloud providers how much you're intending to use. do commits

[43:02] on all of that, right? The the clouds are not infinite as they seem when you're small. >> And one way, of course, to like get like infrastructure and and also just like credibility is venture capital. If you raise $100 million, a billion dollars,

[43:14] some of your customers just raised $2 billion. Actually, I talked with them yesterday. You know, it gives you credibility, gives you cash, you can pay for this thing. Your specific Turbopufferers relationship to venture

[43:24] capital seems very interesting. I never heard you announce a raise until m maybe just very recently. Can you tell me how you and and you told me that when you started this thing, you didn't think too much outside of just building some cool

[43:36] stuff. How did you think about venture capital and how do you think about raising because again I feel you have a very fresh and different perspective than what which is typical inside of Silicon Valley. Yeah. So I think to to

[43:51] understand my how I think about capital you have to go back to the the beginning of Turbopuffer, right? where I promised cursor that Justine and I could get their bill to 4K a month. And this was based on some very rough napkin math on,

[44:06] okay, if if Turbopuffer was a better implementation than it currently is, then it should cost this much. And that's the pricing we ship with and that's what we guaranteed um guaranteed cursor. Um but the software was not that

[44:20] good. Like it was very reliable, but it was very simple, right? And that's like a core engineering principle of me is simplicity above everything. Um you and I have talked before about how software that ages well and some of the

[44:34] advantages of seeing be having long tenures inside of companies. You had a long tenure at Uber. I had a long tenure at Shopify. So you see simplicity just almost always wins. Um and at the time I was not convinced whether this was a

[44:47] venture scale opportunity because I understood that if you take venture capital no matter how many smiles there are in the room everyone's sort of expecting that you have to earn a big return on that on some timeline that

[44:59] makes sense to everyone involved and everyone involved are you know pension funds in Canada like that it's like it there's like a whole stack right of of of people that that need to so at the time I was like I don't you I don't know

[45:12] if this could be a billion dollar company. I didn't know that in the very very beginning. Um it wasn't completely clear to me. It felt like a very niche kind of product, right, to build this particular search engine. Um and that

[45:23] was completely fine with me. So I you know it's it's it was fine. And so then I just I just looked at the cursor bill and I looked at my GCP bill which is what we started on. and you know as like a you know dumb Danish person who's just like okay like this

[45:40] number should just be lower than the other number. >> Yeah, >> that's sort of like you know and it's just I don't think I'd spend enough time in San Francisco cuz I think the money over here it works a little bit differently. Um that's just that's all I

[45:53] knew. You you were doing business 101 as as long as you're making a profit you're good, right? >> Yeah. It was like I'm I'm not kidding in this exaggeration that it was just like that just made sense to me that Justine and I

[46:06] were just going to go optimize this until these numbers were roughly equal. And maybe if if if we could get some other workloads, we could start paying ourselves. But that was like very much the philosophy at the time. Um because I

[46:19] didn't know if I could go raise a bunch of of of money. I didn't know anyone who had the money. I I didn't have any relationships. Um you were an absolute outsider to the >> I was I was an outsider. I was like an outsider squared, right? I grew up in

[46:30] Aus, Denmark and I um I then moved to Ottawa, Canada. So it's like I'm an outsider to Canada and in Canada I'm an outsider to San Francisco. So I was just thinking about this from first principles like oh you're a venture

[46:45] capital you need this return you need it on this timeline. I don't know if I can deliver that yet. I would need more data to decide that because I want to like I kind of want to keep working on this and now I have to get to this point for it to not be a

[46:59] failure. Um in in in January then I uh there was a person that I was at II with in in uh in 2012 and 2013 and his name is Buen and he was on the North and Macedonian team um at II um and he was he's he was really good. He was so good

[47:18] that the North Macedonian team called him God. Um I don't know why but that was what he went by and he was yeah he was very good grew up and and I really wanted to work with Buen but I couldn't afford to work with Boyan [laughter]

[47:32] um and he was very much like this is what I can live off like you know I just like I want to build this date like that would be like this is what it can be but at this point Justine and I hadn't taken a salary for like 6 months and we'd

[47:44] already we'd already spent like tens of thousands of dollars on like on GCP bills and all of that and I was like I don't think we can I don't think we can we we can do it. And so I had met one one individual in in Silicon Valley uh

[47:58] his name is Locky and it just I ended up just calling him and saying hey I kind of want to learn a little bit faster here. Can I can we raise like 700K? That's like what I wanted to raise. So it's just like I want to have like two

[48:15] engineers for the rest of the year. Justine and I still don't need to be paid and then a little bit of buffer room. It's like this is what I need and if this doesn't have PMF and is a big opportunity by the end of the year, I

[48:25] don't think we're going to bother and we'll just shut the whole thing down and we won't have it taking a dime. We'll return everything to you. Um I think there was the first time you heard anyone say it like that. Um and um

[48:36] I told some other VCs that at the time and that was terrifying to them. I think to someone on the West Coast this sounds like you have low ambition or something like that. M >> um and to me it was just like I I don't know it just came from a when I don't

[48:49] know how to play a game I just play with open cards like this is how I see it >> and so I we were it was very clear to us that we wanted to do this and but also it became clear to us that we didn't want to just like keep working on this

[48:59] unless it could become big and we were starting to develop conviction conviction that this actually become really really big and so we we we did that and hired Buen and then became profitable later that year um and then

[49:12] just continued to hire and then it's like to raise more money, you need sort of there's six reasons to raise capital. The first reason to raise capital is to fund R&D. >> Mhm. >> That was the reason that we raised capital in January because we funded R&D

[49:27] with a lot of our own, you know, opportunity cost and not taking a salary and then paying the bills ourselves. Um, but we wanted to learn a little bit faster and so we hired Buen and Morgan as the first engineers. And then the

[49:40] second reason to raise capital is to fund growth. you've you you've built something and you want to tell the world about it and you want to spend more capital to do that. Um the third reason to to to raise capital is for the

[49:54] founders's ego. [snorts] >> Um it's a very popular appreciate the honesty. >> It's very popular, very very popular, right? big numbers, lots of press, like um and I think this is a very very dangerous reason to raise money. And I

[50:09] wish that it was more talked about because you're diluting all of your employees when you do it. You are um setting a certain price for future employees and their upside. It's it's it for some people it can become a status game and that's not what it's

[50:23] about. We're here to build a big business together and this is not a reason to raise money. Um, but I I do think that it happens. Um, the fourth reason to to to raise capital is to reward your employees, right? It's a you're on a very long journey and you

[50:40] want to work with the best people in the world and by definition there's not that many best people in the world. So, you want to reward them. Um, that was the reason that we took more capital in December um was to allow the employees

[50:51] to liquidate as some of their equity um instead of waiting for some like event like an IPO or something like further out. Um the fifth reason to raise is for a strategic partnership. There are strategic partnerships that have been

[51:03] made in this in this city that have made companies. Um and um the six reason to raise would be do doing M&A or or something like that. But it's like you have to be very honest about what reason you are raising in those six. First

[51:18] reason we raised was one and second reason we raised was four. Um so which which ones? The first reason to raise was R&D. R&D and the second reason was >> um to provide liquidity to the employees >> employees. Yep. >> I I think it's a it's a nice and healthy

[51:33] way and I think yeah the ego part we don't talk about and the identity and especially the closer you are to to tech ecosystems where a lot of people are raising it it will be part of it. As closing I I wanted to ask you about the

[51:47] way you have a remote culture these days. I'm seeing it especially for companies that do anything with AI, may that be building AI infra or or or just AI products. A lot of them prefer in person having a HQ often times in SF or

[52:03] wherever your headquarters may that be London or somewhere else because you often these companies often find that they have faster iteration. Uh it's just fewer layers cut in between and of course speed is is very very important.

[52:15] You have started full remote and you're still full remote. how is it working? Uh, and what kind of quirks or like or turbo ways have you found to to make this work better? >> Yeah, I think so. The the company started in in 23. So, sort of like on

[52:34] the on the on the cusp of COVID where a lot of companies were just remote. Um, the Shopify infra was remote since the very um very beginning because it was very difficult to get them all to move to Ottawa. Um, and so it was natural to me. It's like,

[52:49] okay, I think there's kind of maybe two cities where you can build a database company fast, and that's San Francisco and and and maybe New York. There are maybe other cities, right? But that's like kind of where it's been done.

[53:00] >> Yeah. >> And so if you don't want to do that, I think you have to go all in on on on some distributed model. >> And so we've tried to figure out what does that distributed model mean for Turppuffer? It doesn't mean the absence

[53:10] of in person. we get everyone together twice a year in in some in in some location. Uh earlier this year we were in in B, right? And then we were in Mexico City and so on. So it's like that's that's not that uncommon. Um but

[53:21] one of the things that we we we've been trying to do is we have this concept called campfires. And the concept of the campfire is that when a couple of people just sort of randomly congregate in a place, you call it a campfire and you

[53:33] encourage as many people as you want to come and join. So, for example, this week is a Turbo Puffer campfire in San Francisco because I'm here for this conference and a bunch of other things. And so, everyone is invited to come.

[53:44] Like, we're going to go meet customers, right? We're going to put on dinners for our customers and things like that. And we just make a thing out of it and and spend time together. And uh we encourage everyone to come. We've also gone to the

[53:55] extent now of um we want to encourage that, but not everyone not everyone needs to go to the campfire all the time. Some people just want to, you know, lock in and hacks into tent and that's great. We have people that just

[54:07] make it to the off sites twice a year and otherwise they're home, they're with their families and they don't they don't spend time on an airplane. Um, fantastic. Like that is completely compatible with this model. And there

[54:17] are other people at the company who are on a plane probably every two weeks. Um, we had someone the other day where they saw a campfire happening in New York and everyone was dialing in from a meeting room in New York and she had so much

[54:29] FOMO that she took an Uber straight to the airport in Ottawa and flew to [laughter] flew to New York to hang out with the team, right? And I think that's fantastic. Um and we've also introduced these things where um if you if you uh

[54:43] if you do a current conference talk or a blog post or something like that at Turbop or something a bit extracurricular, we give you a turbo credit and a turbo credit allows you to upgrade your next flight to business class which again encourages spending

[54:56] time together with the team. Um and now I mean turbo credits are probably going to take on a life of their own. Someone was talking about doing a central bank and doing interest rates on the turbo credits. um and doing a betting market

[55:08] on the turbo credits. And so like this might take on its life on its own. Um and uh you you know if you um if you're at a conference like this, there's some of the our engineers here who are just want to interact with customers and be

[55:22] on like and standing on a like expo floor all day is quite taxing. And so if you do that for two days because you want to do it, oh, you get a turbo credit, right? And so it's just like these fun little things that we try to

[55:32] do to to to encourage people to meet if they want to meet Thank you. Well, in this session, uh, what I found very interesting is Turbopuffer is a so many AI companies are using you as an infrastructure layer, but in this

[55:45] conversation, we managed to talk very little about AI and a lot more about engineering principles, pushing, being curious, and the human connection, how important it is for people to work together, to trust each other. So, just

[55:57] thank you very much for that. So, let's give a big round of applause for Simon. >> Thank you so much. This is great. Thank you. Are you [music]
