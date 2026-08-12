---
video_id: LZuWZRze3MU
title: "The New Primitives: Building AI Native Software — Kwindla Kramer, Daily"
channel: "AI Engineer"
channel_id: UCLKPca3kwwd-B59HNr-_lvA
channel_slug: ai-engineer
url: "https://www.youtube.com/watch?v=LZuWZRze3MU"
upload_date: 2026-08-07
duration_s: 1274
duration: 21:14
view_count: 1375
like_count: 44
subtitle_lang: en-orig
transcript_source: auto
transcript_words: 3241
ingested_at: 2026-08-08T12:16:47.862Z
ingest_version: 1
---

# The New Primitives: Building AI Native Software — Kwindla Kramer, Daily
**Channel:** AI Engineer · **Uploaded:** 2026-08-07 · **Duration:** 21:14 · **Views:** 1,375  
**Watch:** https://www.youtube.com/watch?v=LZuWZRze3MU

## Description

In 1945 Vannevar Bush described document scanning, OCR, speech to text, hypertext, search engines, a head mounted camera, and voice interfaces, in a single essay, before any of it existed. Kwindla Hultman Kramer uses As We May Think to set up the uncomfortable part: he was a baby programmer in 1995 writing HTML by hand and web servers in C, as excited about web pages then as he is about agents now. Web pages turned out to be a primitive, not a destination. His argument is that agents are the web page of this era, and the thing worth building is the AI native software that comes after.

The tour through the decades is the evidence. Each one had a job: programming languages to carry human intent into the machine, interactivity in the 1960s, abstractions for scale in the 1970s, then the personal computer. VisiCalc is the example he keeps returning to, because it did not put accountants out of work, it made vastly more accounting possible and invented categories of work nobody could have described when a screen of calculations took a room full of people. He offers that as the reply to the mass unemployment worry. The talk closes on Gradient Bang, a massively multiplayer game with an LLM at the core of every interaction and hundreds of inference calls in flight, built specifically to exercise the primitives he thinks come next: asynchronous non blocking context compression, long running subagents that share context, progressive skills loading, dynamic interface generation, and conversational voice.

Speaker info:
- https://x.com/kwindla
- https://www.linkedin.com/in/kwkramer/
- https://machine-theory.com/
- https://github.com/pipecat-ai/pipecat

Timestamps:
0:00 - Daily, Pipecat, and what comes after agents
1:31 - What Vannevar Bush predicted in 1945
2:13 - Nadella on multimodel harnesses
4:12 - Agents are the web pages of 1995
5:25 - From the abacus to the stored program computer
6:46 - The 1950s: getting human intent into the machine
7:30 - The 1960s: interactivity, Sketchpad, and Star Trek
8:51 - The 1970s: abstractions that scale
9:32 - VisiCalc and why it did not replace accountants
10:49 - Knowledge Navigator, Apple's 1987 prediction
12:46 - The web was multimodal from the start
13:24 - Minority Report, Iron Man, and building it for real
17:10 - Cloud, then agents, then what
18:24 - Knowledge Navigator rebuilt on real technology

## Chapters

- [0:00](https://youtu.be/LZuWZRze3MU?t=0) Daily, Pipecat, and what comes after agents
- [1:31](https://youtu.be/LZuWZRze3MU?t=91) What Vannevar Bush predicted in 1945
- [2:13](https://youtu.be/LZuWZRze3MU?t=133) Nadella on multimodel harnesses
- [4:12](https://youtu.be/LZuWZRze3MU?t=252) Agents are the web pages of 1995
- [5:25](https://youtu.be/LZuWZRze3MU?t=325) From the abacus to the stored program computer
- [6:46](https://youtu.be/LZuWZRze3MU?t=406) The 1950s: getting human intent into the machine
- [7:30](https://youtu.be/LZuWZRze3MU?t=450) The 1960s: interactivity, Sketchpad, and Star Trek
- [8:51](https://youtu.be/LZuWZRze3MU?t=531) The 1970s: abstractions that scale
- [9:32](https://youtu.be/LZuWZRze3MU?t=572) VisiCalc and why it did not replace accountants
- [10:49](https://youtu.be/LZuWZRze3MU?t=649) Knowledge Navigator, Apple's 1987 prediction
- [12:46](https://youtu.be/LZuWZRze3MU?t=766) The web was multimodal from the start
- [13:24](https://youtu.be/LZuWZRze3MU?t=804) Minority Report, Iron Man, and building it for real
- [17:10](https://youtu.be/LZuWZRze3MU?t=1030) Cloud, then agents, then what
- [18:24](https://youtu.be/LZuWZRze3MU?t=1104) Knowledge Navigator rebuilt on real technology
- [19:38](https://youtu.be/LZuWZRze3MU?t=1178) Gradient Bang and the primitives it exercises
- [20:52](https://youtu.be/LZuWZRze3MU?t=1252) Closing

## Transcript

[0:01] [music] Good morning. I know a lot of you in this room. It's great to see you. Welcome to the voice track at AI Engineer Worlds Fair. Uh for those of you who don't know me, my name is Quinn Low Holman Kramer. Uh I work at a

[0:25] company called Daily. We make developer infrastructure for real-time audio, video, and AI. And we're the team behind Pipecat, which is the most widely used framework for building voice agents today. Pipcat is open source and vendor

[0:38] neutral. It's used by companies like AWS and Nvidia and Anthropic and thousands of startups and scaleups and enterprises. And today I'm going to talk about what kind of agents we're building today, including voice agents, but not

[0:53] just voice agents. and what I'm interested in building next. And I'm going to try to put all this in the context of the roughly 80year history of digital computing so far. So, we've got a lot to cover. We're going to go fast,

[1:09] but we're going to start in 1945 with an essay called As We may Think written by an engineer, an academic, a civil servant named Vanavar Bush. Bush deeply understood technologies ranging from analog computers to photography to radio

[1:25] to radar and as we may think is a extraordinary piece of writing. The essay predicts the development of among other things document display on a screen and document scanning and OCR and speech to text and text to speech and

[1:39] programming languages and hypertext and search engines and data networks. Something like the GoPro camera. something weirdly like the Amazon Kindle store and voice interfaces and brain computer interfaces. And I've been

[1:54] thinking a lot about as we may think lately because Bush wrote this essay right at the very beginning of the computing age. And I think it feels to most of us like we're working right at the beginning of a new age, the intelligence age. So what will we build?

[2:13] Well, at the moment we're building agents and we're having a lot of fun doing it. And a lot of the AI engineering work we're all talking about this week is focused on building a full coherent software stack for AI agents.

[2:28] Here is Satia Nadella talking a couple weeks ago on a crossover episode of the no priors and latent space pod about the challenges of building agents in 2026. >> Some sort of >> That's right. So, so in some sense you kind of want the harness to define the

[2:44] models, the the data uh and the tools and so that you have a loop across those three and so what we are trying to first of all make sure is each of our products that we build right whether it's GitHub copilot or the security cop the stuff we

[3:00] showed with mdash or even the discovery for science it doesn't matter all of them are multimodel harnesses um with tools tools access so that you can do this progressive uh disclosure of tools even so that they're token

[3:14] efficient uh and then you're feeding it with very rich context. So if you were here last year at AI engineer worlds fair you could draw a through line from the things we were talking about last year to loops and tool calls and context engineering and

[3:29] the stuff we're focused on this year to some emerging ideas. Uh you can hear that in Nadella's clip just there. I think of this as kind of agents plus+ like multi-model harnesses and software co-pilots embedded in every single piece

[3:44] of software organization level harnesses. So how do we go from agents to agents plus to the next thing beyond agents? Well, the last time we had this kind of massive change in how we write software and what we write software for and to do

[4:01] was the early days of the worldwide web. And I was around for the early days of the worldwide web. I was a baby programmer in 1995 and the thing we talked about all the time in 1995, the way we talk about agents today is web

[4:14] pages. I spent a lot of time writing HTML by hand and building web server software in C and indexing and search software in C and authoring tooling and management infrastructure for web pages in Pearl. I was as excited about HTML in

[4:30] 1995 as I am about agents today. And the web page is still with us and it's still important and useful. But today we talk a lot more about web applications and native mobile applications than we talk about web pages. So just like we went from web

[4:46] pages to full-blown web and native mobile, clearly we're going to chart a path to a new fully AI native software that comes after agents and agents plus. So let's keep going back in time to in order to think about this future. Here's

[5:02] a timeline Venavar Bush lays out in as we may think. He talks about the abacus which was both an immensely useful device for doing practical everyday mathematical calculations and also an incredibly important theoretical tool

[5:18] that led to ideas like numeric place value and the concept of zero. And Bush talks about the massive jump from the abacus to the state-of-the-art electromechanical keyboard calculating machines that he had in 1945. And then he posits that we're about or

[5:36] he is about to uh witness and help create uh an an equally large leap to what he calls the arithmetical machine. And then he goes a step even further than that. And he invents or designs in that essay a device he calls the mimics.

[5:56] And we have a little bit of an advantage over over Bush in 1945. We've seen 80 years of computing play out. So we can modify his timeline a little bit. We can go from the abacus to the stored program computer to 40 years later the personal computer

[6:10] and 40 years after that this AI agents era that we're all collectively helping to invent and create and bring into being. So the question for me is what did we build to go from those very first digital computers in the 1940s to the

[6:26] personal computer in the 1980s? Well, in the 1950s, the big job was to figure out more effective ways of transmitting human intent to these new computing machines. We built the first programming languages. We wrote the first compilers. And the the theoretical

[6:41] underpinnings here were figuring out how to combine the elegance of mathematical formalisms with something a little bit more like natural language. And then building on that, in the 1960s, the challenge was to make these machines

[6:56] interactive, make these machines capable of a two-way dialogue with humans. The 60s also saw the birth of graphical programming with systems like Ivan Sutherland's Sketchpad. And the 60s were an amazing era for science fiction. Even though almost

[7:13] nobody had access to a computer, the computer became a big part of the popular imagination. The idea of a computer really resonated with people and ideas matter. For example, here is the idea of the computer in Star Trek on

[7:30] record. >> Recording. >> Come. Captain's log supplemental. Engineering officer Scott informs warp engines damaged but can be made operational and re-energized. >> Computed and recorded, dear. Computer, you will not address me in

[7:51] that manner. Computed. >> Computed. Dear, >> I love the background sound of punch cards going through a punch card reader. So, like you know the computer is working even though it's talking to you about what it's actually computing.

[8:11] There were of course a bunch of other talking computers in in science fiction of the 60s. And next year after this, the Kubric movie that was a interpretation of Arthur C. Clark's 2001 of Space Odyssey had the HAL 9000 computer. This is a much much more

[8:24] dystopian view of a talking computer than the Star Trek computers. And by the 1970s, computers had become powerful enough that the next big job was designing abstractions that could scale to much larger amounts of data and

[8:37] much more powerful computing substrates. We got relational databases which introduced new theoretical underpinnings for data manipulation and we got declarative languages which leveraged those new theoretical insights and

[8:51] programming languages in general continued to evolve in what to me at least are really amazing ways. We got Small Talk and object-oriented programming in the 70s and all of this set the stage for the personal computer in the 1980s. The Macintosh shipped in

[9:04] 1984. Windows 1.0 ship in 1985 and Microsoft's mission statement was a computer on every desk and in every home and incredibly Microsoft delivered on that mission statement and we got a computer on every desk and in every home

[9:19] because these new personal computers delivered real amazing tangible benefits. Take VisiCalc for example which was the first spreadsheet program. A truly new abstraction for doing computation numerical computing two-dimensional interactive so durable

[9:37] and so useful that probably most of us in this room use a direct descendant of Visical regularly Google Google Sheets or Microsoft Excel or whatever. Or put another way, this was a spreadsheet in 1957 and this was a spreadsheet in 1985.

[9:57] And I think a lot about VisiCalc these days too because I think VisiCalc is an example of how transformative new technologies can be in the way of delivering a capability that used to require a lot of specialized people and

[10:08] specialized knowledge and making it generally accessible. And I think VisiCalc is a potentially a counterargument to the argument or the fear or the concern that AI is going to lead to mass unemployment because Visical didn't put accountants out of

[10:22] business. Instead, it made much much much more accounting like work possible. And it made new categories of work possible that we couldn't even really conceive of when a spreadsheet or doing a screen's worth of calculations as we

[10:37] think about it today took a room full of people. So, if we were here in the Moscone Center in 1985 and these two interfaces, the Macintosh system 2 and Windows 1.0 were state-of-the-art, what would we have said the world would look like in

[10:53] 10 or 20 or 30 or 40 years? Well, we actually have a really great example of a prediction from that time, like as we may think, another famous document in the history of human computer interaction concept video from Apple made in 1987 called Knowledge

[11:09] Navigator. This is very much worth tracking down online and watching all of if you haven't seen it. I'm just going to play about 20 seconds from the middle. You have three messages. Your graduate research team in Guatemala just checking

[11:27] in. Robert Jordan, a second semester junior requesting a second extension on his term paper. And your mother reminding you about your father >> surprise birthday party next Sunday. So the video shows a foldable tablet, a

[11:43] touchscreen interface, [clears throat] a conversational voice assistant with a really strong personality, access to both global and personal information, real-time video generation, real-time computer vision, seamless video call

[11:54] integration, delegation of complex tasks for autonomous execution, and what we might call today continual learning. And it's really, really clearly influenced by, as we may think, but it's also quite different. It really is updated for 40

[12:08] years of progress and it really does sort of preage this AI agents era we're in now in a way that Vanavar Bush's mimics didn't and maybe couldn't. The knowledge navigator video divides our timeline I think quite neatly in half.

[12:21] And hold that thought because we're going to come back to it. The 1990s were about the network. First local area networks and dialup and then the internet and the web. And with the benefit of hindsight, I now think that

[12:36] the single most important thing about the web was that it was multimodal from the very beginning. More even than the gooies of the 1980s, the web anticipated that text and audio and video and data were not different things to be used in

[12:51] different programs. They belonged together. And in a real sense, the web was an attempt and a conscious attempt on the part of a lot of people building the web to make that knowledge navigator video real. Then in the first decade of the new

[13:05] millennium, the big job was to make all of this computing stuff mobile and continually connected to put this new multimodalorked computer in your pocket. Literally to give a supercomput to everybody in the world that they could carry around in

[13:20] their hand. And as with the 1960s, there was an efflloresence of like futurism on screen in the first few years of the new millennium. And I think it was because computers you could carry around with you and cameras everywhere and a kind of

[13:34] Moors law for pixels making screens super cheap really gave us a chance to think through what we thought the future would look like in a new way. A lot of stuff we could almost but not quite build was cohering in the minds of

[13:50] people working on these machines. And the best and most famous Hollywood computers from that era were created by John Underoffer [clears throat] for the film's Minority Report and Iron Man. Here's Minority Report from 2002.

[14:05] >> It's no longer Dave. >> Time frame >> 13 minutes. >> Hey Chief, investigator from the Fed's here. >> Yeah, I don't need some twink from the Fed poking around right now. John, I wrote it down on your calendar. I left you a message at your house.

[14:16] >> Check in with the papers ahead of forward and see if the neighbors knew where they went. Check all relations. >> Check your neighbors and relations. >> But John, >> fledge. Just get them some coffee. Tell them some stories how I save [music]

[14:24] your ass every day and you can't live without me. >> I got coffee. Thank you. Danny Woodward, the tween from the fed. Oops. Got him. >> So, the gestural interface in Minority Report was implemented on screen as special effects, but it was actually

[14:37] based on John's PhD work at the MIT Media Lab. In a real sense, this was real technology. John had brought the UI out of the small screen and into the world with us in a bunch of really interesting and lovely ways. John also

[14:48] consulted on Iron Man, which is a very different view of the future than you Minority Report, which was Spielberg working in like the American Kubric dystopian tradition. Iron Man is really squarely in that Star Trek goofy

[14:59] futurist tradition. But I think you could see the common elements in the UI depicted on screen. It's still from the same era. Wake up, Daddy Sean. >> Welcome home, [music] sir. Congratulations on the opening ceremonies. They were such a success, as

[15:18] was your Senate hearing. [music] And may I say how refreshing it is to finally see you in a video with your clothing on, sir. >> You swear to God, I'll dismantle you. I'll soak your motherboard. I'll turn you into a wine rack.

[15:37] I co-ounded a startup with John in 2006 to make the Minority Report interface into a commercial product. This is our demo reel from 2012, 6 years into that work. [music] [music] >> [music] [music] >> Heat. Heat. >> [music]

[16:56] [music] >> This long project to build the multimodal, multi-device, multi-creen, multiplayer, ubiquitously connected computer is still what I'm working on 15 years later in 2010s we built out the cloud which laid the groundwork for the

[17:25] infrastructure and data centers and data capacity we would need to scale up AI training and inference which brings us to now we're building agents and we're starting to think about agents plus I think we can also start to think about

[17:40] the next thing the AI native software that is to agents what today's internet is to the web pages of 1995 and one way to think about the story is this. We went from the calculator to the computer to the personal computer to the

[17:53] global cloud computer and now we actually have the ability to build the mimics and Jarvis from Iron Man and knowledge navigator from that 1987 video for real completely working. And by building those things, we'll figure out

[18:06] what we want to build next. A couple of weeks ago, the team at Tavis released a reimagined knowledge navigator video. This time entirely built on real and available technology. I'll just play another 20 seconds of this, but like the

[18:20] original knowledge navigator video, this is worth tracking down and watching in full. Good evening, Hassan. I adore that hounds tooth jacket you're wearing today. Anything I can help with or would you like to review tomorrow's schedule?

[18:39] >> Thanks so much, Tom. Yeah, let's review tomorrow's schedule and see how busy it is. >> Opening your calendar now. Here is the quick version since it is late. Tomorrow morning is slammed. Investor meeting at 9, then back-to-back one-on- ones and

[18:53] internal meetings until 1. So, the full 4-minute video is one take, completely real. And when you watch it, it really does feel both like the knowledge navigator video from 1987, familiar, but built on real technology, and like

[19:08] something brand new. And I'll just close with a massively multi-player game project I've been working on with some friends as a canvas to really think about what AI native software can be. This game is built from the ground up

[19:21] with LLMs as the core of every interaction at every moment in the game. There are hundreds of inference calls happening and we couldn't have built anything like this even a year ago. Oh, sorry. Welcome to Gradient Bang, a multiplayer

[19:38] game [music] that showcases real time agent orchestration. Gradient Bang demonstrates several patterns for AI sub agents such as asynchronous non-blocking context compression. >> Okay, make a note for later. We are going to eliminate Hilly Tatley from

[19:54] existence. >> Noted. >> Long running sub aents that share [music] context. >> Eagle is on five trade loops. Hawk and Raptor are on five exploration loops [music] each. Your fleet is busy. >> Progressive skills loading. >> How much does your average ship cost?

[20:10] >> Ships range [music] quite a bit, Captain. >> Dynamic user interface generation. >> Show my task history. >> Certainly. >> Uh, hide the map. >> Okay. >> And conversational [music] voice. >> No, I don't want to exchange it. I just

[20:24] want to sell it for cold, hard cash, please. >> I'm afraid [music] the galaxy doesn't allow you to be shipless and hitchhike. So, I went long. I have to wrap up. But I will say that the first version of this new draft talk was an hour. So, I

[20:38] have a lot more things I'm super excited to talk about with all of you. So, if you are interested in this stuff, come find me. We have a booth on the show floor. I'm online everywhere. And I'm excited to build agents because agents

[20:50] are awesome, but also to build the next next thing, too. Thank you. [applause] >> [music]
