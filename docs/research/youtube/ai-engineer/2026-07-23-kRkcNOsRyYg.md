---
video_id: kRkcNOsRyYg
title: "AI on Your Lakehouse: Context Comes in Shapes, Not Queries — Zach Blumenfeld, Neo4j"
channel: "AI Engineer"
channel_id: UCLKPca3kwwd-B59HNr-_lvA
channel_slug: ai-engineer
url: "https://www.youtube.com/watch?v=kRkcNOsRyYg"
upload_date: 2026-07-23
duration_s: 7150
duration: 1:59:10
view_count: 1615
like_count: 17
subtitle_lang: en-orig
transcript_source: auto
transcript_words: 18147
ingested_at: 2026-07-30T04:43:33.450Z
ingest_version: 1
---

# AI on Your Lakehouse: Context Comes in Shapes, Not Queries — Zach Blumenfeld, Neo4j
**Channel:** AI Engineer · **Uploaded:** 2026-07-23 · **Duration:** 1:59:10 · **Views:** 1,615  
**Watch:** https://www.youtube.com/watch?v=kRkcNOsRyYg

## Description

Your agent can reach your data and still get it wrong. Vector search hands it a slice, Text2SQL hands it another, and neither tells it what is actually relevant or how the pieces connect, so the answer comes back confident and wrong. Zach Blumenfeld's argument in this hands on workshop is that the missing piece is not a better model or a better query. It is context, and context comes in shapes.

He builds three reusable graph shapes on top of lakehouse data with Neo4j, each answering a question the agent cannot ask a table. Trees give a table of contents, so the agent can navigate what is even there. Communities surface themes, the patterns nobody named. Paths and cycles trace connections, how entities, documents, and records actually relate. The shapes are portable to BigQuery, Databricks, or Snowflake, and you leave with the code to run them on your own data and agents.

Speaker info:
- https://www.linkedin.com/in/zachblumenfeld/
- https://graphacademy.neo4j.com/courses/workshop-lakehouse

Timestamps:
0:00 - Introduction: context comes in shapes, not queries
6:25 - The three graph shapes to build
10:56 - Environment setup: Codespaces and Neo4j
21:47 - Schema, shared terms, and join paths
45:25 - Shape 1: a table of contents for your data (trees)
50:30 - Building the containment tree and links
59:48 - Serving the graph to the agent over MCP
1:12:21 - Q&A: naming and the containment shape
1:22:54 - Shape 2: surfacing themes with communities
1:24:24 - Community detection with Leiden
1:31:09 - Hierarchical communities and naming themes
1:43:22 - Shape 3: connections and cross links
1:50:20 - Watching the agent use outlines and themes
1:55:05 - Wrap: theme types and real time linking

## Chapters

- [0:00](https://youtu.be/kRkcNOsRyYg?t=0) Introduction: context comes in shapes, not queries
- [6:25](https://youtu.be/kRkcNOsRyYg?t=385) The three graph shapes to build
- [10:56](https://youtu.be/kRkcNOsRyYg?t=656) Environment setup: Codespaces and Neo4j
- [21:47](https://youtu.be/kRkcNOsRyYg?t=1307) Schema, shared terms, and join paths
- [45:25](https://youtu.be/kRkcNOsRyYg?t=2725) Shape 1: a table of contents for your data (trees)
- [50:30](https://youtu.be/kRkcNOsRyYg?t=3030) Building the containment tree and links
- [59:48](https://youtu.be/kRkcNOsRyYg?t=3588) Serving the graph to the agent over MCP
- [1:12:21](https://youtu.be/kRkcNOsRyYg?t=4341) Q&A: naming and the containment shape
- [1:22:54](https://youtu.be/kRkcNOsRyYg?t=4974) Shape 2: surfacing themes with communities
- [1:24:24](https://youtu.be/kRkcNOsRyYg?t=5064) Community detection with Leiden
- [1:31:09](https://youtu.be/kRkcNOsRyYg?t=5469) Hierarchical communities and naming themes
- [1:43:22](https://youtu.be/kRkcNOsRyYg?t=6202) Shape 3: connections and cross links
- [1:50:20](https://youtu.be/kRkcNOsRyYg?t=6620) Watching the agent use outlines and themes
- [1:55:05](https://youtu.be/kRkcNOsRyYg?t=6905) Wrap: theme types and real time linking

## Transcript

[0:12] Hello everyone. Welcome today to get started on AIE. Um, so right here, uh, there's some steps for getting started. I went over this around 10 minutes ago. Um, but basically our workshop that we're going to take today is driven by a website called

[0:30] Graph Academy. And if you go to that first QR code there to the left, uh, that'll take you there. You have to enroll with your email. Um, and then if you go down to set up your environment, uh, there's a code spaces there with

[0:45] everything set up and you can get that rolling now. It'll take maybe about five minutes or so. Um, and you can grab your credentials then as well. There's um an anthropic API key. Uh if you have your own cloud code key um or your your own

[1:00] subscription, please feel free to use that. Otherwise, we provided one for you. Um and then there's another key there for reading from BigQuery tables. So with that in mind, uh we'll go ahead and get started with AI on your

[1:14] lakehouse, um which is about context coming in shapes and not necessarily queries. So today your team um will be myself. My name is Zach Blumenfeld. I am an AI research engineer at Neo Forj. Uh we also have Ben Squire over there in the

[1:32] back um who is our senior developer advocate um as well as Ryan here in the center um who is our partner architect helping customers get this stuff up and running. So, as you have questions, um I don't have a mic set up for you, but uh

[1:49] go ahead and raise your hand. I'll sort of I'll take time around every 10-15 minutes during natural breaks. Um and and I can take some questions, but also flag Ben and Ryan as well if you're going through some steps and you're

[2:03] having some trouble setting things up. Um and they can help get you unblocked. Um so what we're going to talk about today um is really about when you start using uh a lakehouse right there's sort of two sides obviously there's a

[2:18] warehouse which is your structured data and your tables um and then there's the data lake part which is all of your unstructured documents and oftent times what can happen is you're given these tools like text to SQL and vector search

[2:34] and nowadays we don't really have trouble accessing that data Um, but sometimes there are still some challenges around how do you give your agent the right type of context, whether or not they can see all the data in the

[2:46] way that they need um, and really take a slice to answer the right type of question. And so what we've put together today inside of our course is an agnostic data model um that basically creates a graph representation uh both

[3:00] from the structured side your warehouse um but then also provides structure for some of your documents um and then allows you to do a lot of useful stuff with that. Uh we do have a scenario here that we're going to go over. Um, we've

[3:15] created a fictional autofix group, uh, which is, think of it like a a Pep Boys Auto or something. It's a national auto repair chain. And they have all of these bays. They have these libraries of manuals on vehicles, um, as well as

[3:30] safety bulletins and recalls and then a warehouse of all of the repairs that they've logged. Um, and you have sort of your floor technicians, right? These are the Danny's that are listed here where they have the cars inside of the bay and

[3:44] they're going to need to ask some questions. Um, you have leadership at this organization that wants to create a co-pilot uh to be able to assist these technicians on the floor. Um, and then obviously you have people like Sam who

[3:58] are us, the AI engineers who actually have to build the thing. Um, and so if they already have their data in a warehouse, what we're going to be looking at today is the example on BigQuery. So imagine, right, you have your documents inside of cloud storage

[4:14] and then um you have BigQuery as your uh data warehouse, but these patterns are also extendable to data bricks as well as snowflake. Um and essentially if they just create a co-pilot on top of uh BigQuery and the data that they have um

[4:32] it can pull the data correctly um but sometimes it can be confidently wrong. Um, basically it could get it could pull stuff with vector search from documents and it can do text to SQL um on just a few tables. But when those tables become

[4:48] massive and you get hundreds of tables or when you have large document stores where you have hundreds and thousands and millions of documents um things can get lost and fall through the cracks. And really where graph can come in to

[5:02] help with these shapes um is not only in these single questions that someone might have about how you know I have a broken part that I need to replace and how do I repair this vehicle but oftent times it's going to be on these estate

[5:14] level questions. So things like for example, what are we missing? Like what documentation maybe don't we not have to cover all of the different cars that are coming in or what documentation maybe are we not leveraging at all. So this is

[5:29] sort of like proving a negative which can be very hard with something like semantic search uh which can only match similar things, right? It can't really find a negative example. Um there's also questions that we have where we want

[5:41] patterns across everything. So say, you know, you might want to ask, well, you know, what are, you know, the common types of patterns that we see? Is there anything that we're failing to fix over and over again? Or, you know, are there,

[5:54] you know, specific groupings of different types of recalls that are popping up and and things of this nature where you really need to traverse the entire data set. Um, and then the other one is just asking how records relate

[6:06] inside of a large SQL store. Um, and when you have one big lookalike schema where you have lots of similar tables, um, how do you understand how to join those together correctly? And so there's going to be three concrete shapes that we'll introduce you

[6:21] to today. Uh, so the first one um, we're going to call table of contents and it's somewhat like a tree structure uh, but with also different types of links between them. You'll see how it works. Um this is going to be used on the

[6:36] unstructured data. Uh on the unstructured data site as well, we have something called themes. Um and what themes does is it surfers surfaces global patterns inside of your data that might not be apparent um or you might

[6:51] not know about beforehand. So uncovering unknown patterns and groupings. Um, and then the third one which when we take the course we're actually going to go over first is this connection shape which is essentially a semantic layer on

[7:05] top of your data warehouse. And so how many people just a show of hands here are familiar with like graph and graph rag. Okay so a fair number of you then how many people in here have used neo forj before? Okay. Also like uh maybe 30 40%

[7:28] something like that. So this room seems like you know fair fairly uh fairly familiar with graph basics but I'll I'll go over it just here really quick. So Neoraj we're we're a graph intelligence platform. We have a graph database at at

[7:43] at the heart of it. Right. Um and basically when we talk about what a graph is we're talking about it from a property graph data model perspective. And so everything inside of our database and our analytics platform is modeled to

[7:57] these three different types of elements which is nodes that represent people, places and things. Relationships which are the verbs or associations between those things. So like person owns car, person drives car, person is related to other person.

[8:15] And then we have properties that go on these both the relationships or sometimes we'll call those edges and the nodes which are sometimes called vertices. And those can be anything from strings, they can be numbers, they can

[8:29] be dates, they can be vectors, um um all sorts of things. And so the basic idea with a graph, right, is as you start adding data to it, it's almost like a bunch of pre-joined tables and everything's already interconnected and

[8:44] you can hop between all the nodes very easily. Um, and that provides a ton of benefits that we'll see we'll see later in the course. So, with that in mind, why don't you go ahead and get started and go over into these if um if you haven't heard before

[9:02] and I'll actually just show you here really quick. Um inside of the workshop lakehouse, have it open here. I should probably restart this guy really quick. Start my code base. Um, but basically it should take you to this page. Um, this

[9:23] shouldn't wouldn't say continue course for you if you if it's your first time going to it. It would say enroll to take the course. So, you have to go through that path to enroll to take the course. Um, and then basically the whole thing

[9:36] from here on out is just going to be me guiding you through this course and kind of showing you all the different uh things that we can do. Um, there's about 17 lessons in here. We've broken it up by the different shapes. Um, but

[9:49] basically if you go into the course, you can kind of click through here. I go over the scenario a little bit. But while I'll do that, I think what you should do is jump to this environment section. So basically, you go down to

[10:06] the bottom here. go to your environment and um from here you can say open code space and in fact I will open a new code space here just so that I can I can walk through it uh live with you as well. Yeah, of course. Um, go back to here.

[10:39] Why don't you all go ahead and capture that? Yes. So it'll create a code space in your own GitHub if you want. There's a link to the repository. You could run it locally. Um just keep in mind that we've set it up so that it will auto start in

[11:08] the code space. So there's another um bash script that you can run to run it locally and it will it will set everything up for you. Um but it it depends a little bit on your local environment. You have to make sure you have cloud code installed um and all

[11:23] these sorts of things. So, we'd recommend that you use a Code Space one if if you're comfortable doing it locally. I I I've run it locally all the time before, too. All right, everyone's everyone's copied the uh QR code.

[11:46] I'll give it another 10 seconds or so and then I'll I'll move back over. Yep. Ben and Ryan can help you out if if you don't have this one. Okay. So, when you start up as well, there's some workshop credentials here. Uh I'll

[12:09] I'll be uh blasting these keys uh a after the course. I'll leave them up for just a little bit. Um but basically, give it some time to start up. Uh- once it once it does, what you'll do is you'll go into your environment file

[12:26] here. And maybe I can make this just a little bit bigger so it's easier to see. You will place your anthropic key in here as well as the uh the BigQuery key. The other thing that you're going to want to place in uh if you go back to

[12:42] the course um is down here, it should give you a um Neo Forj credential. So, this is accessing our graph database. They've been all pre-provisioned, so it's going to be different for each one of you. You're going to have a different

[13:03] one. So, copy the one from your screen. Um, and you're going to put it inside of this environment file as well. Um, and it it will take a while, like you see with mine, the environment file hasn't uh quite popped up yet. So, it

[13:17] can take a few minutes for that all to go through. Um, so we'll we'll give that a little bit of time to start up. Hopefully, it won't take too long here. While that's running, I'll I'll give a little bit of an overview here of what

[13:42] we're going to do in the next step. So, basically, once we get this set up and and we get Claude up and running, um we're going to walk through um the first shape for our day, which is this connection semantic layer shape. And

[13:58] then after that we'll follow it with the table of contents one that we were talking about and the communities one. So we'll be working with the structured data first and then moving into the into the unstructured bits. Um once for those of you who do have it

[14:17] loaded basically you have your terminal down here. You can go ahead and call Claude. Um, we'll be working through Claude Code as our agent. Um, the internet is a little bit slow too, which is expected as you go through with this as well. I

[14:54] should um Oh, here we go. We'll set up show you what this looks like here in a second. Anthropic key as well as BigQuery one. All right, perfect. And if it does this where it's trying to get you to do a subscription, basically

[15:50] what you do is you'll go plus, open up a new terminal window, and then it should here give you the option to select the enthropic key. Just go through and press enter. Yes. And then you want to use the MCP server here. So you're going to select yes. And

[16:11] I'm going to skip the tour. And then I can ask that question just to make sure it can connect to Neo4j. And for me, I already have some nodes in because I'm working with um a graph that's been cached already for my previous course.

[16:51] Um for you, it will it will come up as an empty sandbox. So, one thing that uh I want to note here too in terms of how we're going to be working with Neo forj and with cipher, which is our graph query language. I think we've come to a point now where

[17:09] a lot of us aren't h hand typing uh our own code line by line anymore. We're using agents to help us build things obviously. And so in this workshop it's going to be the same thing. Basically we're going to be using something called

[17:26] the Neo Forj CLY um which is a CLY tool that will allow your agent to run uh queries directly against the database. When I was working inside of Claude, you saw it running there for a second. And that also ships with a Neoraj cipher

[17:43] skill. Um, that allows the agent to sort of leverage how to put queries together in the most modern way, as well as something called a GDS skill, which stands for graph data science. And we'll use that for some of the algorithms when

[17:56] we get to the theme section. Um, in terms of just helping us do agentic coding. So, I'm not going to have you guys handw write really any um cipher query code. I'm going to show you throughout this workshop how to use an

[18:11] agent to help you write that with with specs that are created. Um and hopefully that'll be useful for you more on on the day-to-day if you ever decide to use uh cipher um whether it be with Neo forj or not. Um, so how is everybody doing now? I I'll take

[18:34] a second here to stop. Go ahead and raise your hand if you have any questions here. Or are we all good? I have one question over there. >> Yeah. So the question is, can I use cursor? And so the answer to that is you should be able to. Yes. I haven't

[19:02] personally tested it, but if you go up to the top, there should be a link to the repository that we're using. Um if not, when you go to open code, yeah, you can clone the repository here. So if you follow that link, you could clone

[19:19] it. You can get it locally. Um and then you'll see here there's directions. There's a shell file that you can run that will set everything up. You can take a look at what's in there. It's it's a bunch of basic stuff. Okay.

[19:31] Awesome. Yeah. And just a little bit about the structure of this thing. I forgot to mention um there's a lot of stuff inside of the uh inside of uh the the workspace here. Um obviously inside of Cloud we have our skills file. Um, so I've gone ahead and

[19:52] pre-written a skill here. Um, that covers basically a lot of what we're going to do. Uh, inside of here as well, there's uh a file called uh outline and search and theme. So, these are going to be the shapes that we'll be working

[20:09] with. um to query BigQuery there's just a very small um well that this is actually a a database query file but the run SQL one this one for querying bigquery just a very simple um um basically way of uh reaching out to BigQuery and just calling it with a uh

[20:29] with um a simple SQL command. Um and inside of these files as we'll see later there's there's places to fill in a spec. So that's going to be where we do some of our agentic coding. Um, but everything in here, if you wanted to

[20:43] like load this into BigQuery yourself, there's something for that. Um, if you want to go ahead and run this on data bricks, there's directions here to like load it into into data bricks and use Genie and AI search there if you want to

[20:56] compare. Um, and then this is just a sim link over back to the uh cloud files. Um, there's solution scripts as well. Also if you get stuck for example where for some reason the coding agent can't you know create the right query um you

[21:11] you can copy stuff from there. Um and then all of the source data too for creating both the structured and unstructured data is in here um including our uh PDF sources. So if you go in here we have our bulletins and our

[21:28] manuals and everything. Um this is showing you the uh the raw PDF. But if I go to the corpus, which is the the markdown version, uh you'd be able to to actual re actually read the contents inside of them. Um so anyway, with all of that, we'll go

[21:47] ahead and hop along to our first section here, which is going to be connections. So, we have basically our data inside of BigQuery right now. And in fact, if I go back to my overview, just to show you what it looks like really quick. This is

[22:09] the uh schema. Uh so, we've kept it very simple for this course. Obviously, in the real world, you'd have a much bigger schema than this. Um but we have our work orders, uh which is sort of like the middle or the star of the scheme.

[22:23] you have your vehicles, um the different uh DTC codes, procedures, uh work order parts, and then the parts themselves. Um and they join together in a very simple primary foreign key pattern. Um we'll get into our documents later in the

[22:39] course. It's just basically a a big bucket of of PDF files. And so what we want to do here is to help our agent be able to effectively join everything together, we're going to give it a graph representation of a semantic layer. And to build that

[22:59] semantic layer, we're going to use something called Neoarta. Um Neoarta is a labs project. So at Neo Forj, we have our core engineering, which is like our, you know, cloud SAS platform, um our graph analytics stuff and all of that.

[23:14] But we also have labs projects where we move a little bit faster. Um, and inside of that labs project, we created this neocarta. Um, and what it does is it creates a metadata graph. Um, also although we're not leveraging it here,

[23:27] you can add business terminology and business processes and a whole bunch of other things into a graph structure. Um, and if you think about it, people, you know, these words ontology and semantic layer and all these things are kind of

[23:40] they're thrown around a lot lately, especially this summer. And so the the basic uh mental paradigm that I use to kind of think through these is an ontology helps something interpret and reason about the data. A semantic layer

[23:53] helps something understand what the consistent agreed upon terms are so it can query the data accurately. Um and then at Neo Forj we have other things like virtual graph. There's a link in here in the course which will actually

[24:05] give you a sort of a a federated graph view of your SQL data that you can um that you can query over directly with cipher. We won't be using that here, but there there is um sometimes uh value in in giving sort of a graph view of the

[24:20] schema. Um but anyway, what Neo Carter will do is it we'll see in this next section um uh it has an MCP server basically that will sort of suck all the data in from the um from BigQuery just the metadata and it will create this graph.

[24:39] Um and that's what you do in the next section. So, I'll go ahead and jump to there. And I've already run this script. But basically, when you see this script, what you're going to do is you're going to copy it. And then you're going to go

[24:52] over to here. And then, um, you're going to bring up your terminal, which our terminal. And then, uh, I like to just open a new window. That's not my cloud window. Um, and you're going to allow paste. And then you're going to go ahead and run

[25:12] that. I've I've already run it. Um so I won't do it again, although it should be item potent. Um but basically once you run that, uh it'll create this um these six tables with these five reference join paths. And once you've done that,

[25:29] you can come back in here and even just run this to check. And it's kind of cool what it looks like. Um this is this is what it looks like inside of the graph database. And basically what you'll see is you have this uh this node in the

[25:43] middle that represents your um your well first your database and then your schema and then if you follow that out it'll be has table and then you'll have your table and then you have your columns. Um and those can also optionally have these

[26:00] representative values on top of them. Um, and so these join paths, basically when the agent reads that, um, if I was to go down here and try, so I have, um, a little example prompt down here and I can go into my window and go back to Claude

[26:25] and I can ask a question like this. Which vehicle received part IC 2042? And I in this case I'm going to tell it to use the the MCP server and the warehouse schema and all this to to go and grab everything then use the Python

[26:40] script. Um inside of the skill itself it it has directions for this as well. Um, but what you'll see it'll do of this. It'll call that MCP server for Neo Carta and it's it's going to read that metadata semantic layer graph that we

[27:02] have in Neo forj. And so if you notice the thing that we're doing here really is we're not using the graph to copy the data over. There's not like an ETL into graph. What we're doing is we're using the graph as a semantic layer. So we're

[27:17] just pulling metadata about the columns and the rows and all of these things and we're going to use that to inform a text to SQL query once it uh decides to go ahead and run here. How is claude working for everyone right

[27:45] now? Are we seeing a lot of uh slow clouds? Fast. Yeah, slow. Okay. Interesting. I'll give it a little bit of time here. I don't know why it would be go moving. Huh. A little bit slow. >> Yeah. Does everyone have Yes. >> Yeah, sure. So, the question is, can I

[28:50] recount how I got to here while we're we're waiting for Claude to come along? So, basically, um the QR codes that are being passed around, there's two here. uh one of them is uh to enroll in the course. So the course that I'm going

[29:07] through is online. It's freely available so anyone can go uh once once you show up inside of the course basically you'll see a button here to enroll. Um so you have to sign in and enroll in the course. Uh once you do that you'll

[29:21] you'll click through and you'll make it to this environment section. Um, and when you do that, uh, it'll take about five minutes or so for everything to to populate and come up. Um, if you're using code spaces, you have the option

[29:36] to run it locally. Um, but then once you do that, essentially, um, you're going to come in here and you're going to get your credentials and you're going to grab the anthropic API key, um, as well as the, uh, the BigQuery key here. Um,

[29:52] and then once you do that, you'll be able to um access all the things in the workshop. Basically, um, you're using, as you saw here, um, oh, cool. We're actually making progress. Um, we're using cloud code inside of inside of

[30:09] code spaces here. >> Sorry, can you repeat that really quick? >> Yes. The Neo Forj sandbox is um if I if I were to go back to that environment section um you see the button here to open code space and then you should have down here

[30:39] um your own sandbox credentials. So, it won't be these exact ones because it's it's different for every participant, but you'll go ahead and copy those. And then once you're in here, uh you'll be able to um you have your environment file. And inside of

[30:58] your environment file where you put your anthropic and your BigQuery key, you'll also put the Neo Forj ones. If you don't see a environment file and you see nothing or you see the end.ample, example, it just takes it a while to

[31:12] populate that. There's other things that are running. It's running another shell script to kind of create everything for you and um populate all the different files. So, my my hunch, and someone can scream at me if I'm wrong, is that if

[31:28] Anthropics this slow right now, it's more of a anthropic problem and not necessarily a one person's account problem. Um, if it continues being bad, I might try to provide another key from a different account, but I don't

[31:41] actually think that that's what the problem is. I think it's it's >> Yeah. Well, yeah, but this should also be running remotely, right? >> Is it Is it just the Wi-Fi? Okay. >> Yeah. Well, the funny thing is I would think in Well, never mind. I don't know.

[31:59] It's running in Codespaces, but maybe Code Spaces is still using the the local uh the local Wi-Fi. Um, okay. So, so we're back here. Basically, what basically what it did to grab this list is um it it went through and it it

[32:18] basically read um that metadata graph um and then it created the um the different uh queries that it wanted to run. You can see it ran that the small SQL uh Python file um and it it did all of its selects and it joins to be able to to

[32:36] pull together uh these tables that list out um the the answer to that question essentially. Um if I was to go back the question here was uh what would we ask? Go back to the connection shape. Um yeah, which vehicles received, you know,

[33:01] these these separate parts over here. Um and and it it provided that list um down here by by make apparently um and then vehicle count. Um so that's the basics of this first shape. And you can imagine that as your data starts to grow and you start to get

[33:20] more and more tables, it's very useful to have this semantic layer um to then help essentially guide how everything joins together. Uh in this case, it used a primary foreign key uh relationship inside of the information schema inside

[33:34] of BigQuery uh to enforce that. Neoarta can also use things like query logs or you can sort of manually put together how you want things to join with other terminology and metrics. Um, are there any uh questions about this

[33:50] first sort of connections graph semantic layer shape that we're working with? >> Yes, I have one over here. Neo for you. So the question was can you give us more context into the Neo Forj near quarter like what we're doing

[34:20] strategically um so what Neo Forj is doing strategically and this right here so Neo forj as a company right we're for a long time you've been able to import data into our database and represent things as a graph which is very useful if

[34:37] you're trying to run these graph specific queries right so if you have a supply chain for example and you need to find an optimal route from point A to B and you have to do these like variable length, you know, shortest path type of

[34:48] calculations. A graph database is very good for that. But the other thing that a graph database is really great at doing is not just making those complicated queries run faster, but actually providing a view or a representation of the data that allows

[35:04] an agent to understand how tables might interrelate. So that even though the end join it might only be a three or four hop join, you might have had to understand hundreds of tables or something to be able to arrive at that

[35:16] conclusion. And so we're focused a lot right now on these concepts of ontologies and semantic layers and what we're calling virtual graph where the focus isn't only just etling data in but about okay maybe you want to keep your

[35:31] data where it is and you still want to use SQL and and access it in in the ways you have been but you need some way to sort of guide the agent to be able to do that correctly. Um so Neo Carta is a labs project. We also uh just recently

[35:46] um in preview have released uh something called virtual graph which will be similar but it essentially gives you um almost like these push down cipher queries. So it gives you a graph schema of your of your database and then it

[36:00] allows you to run cipher directly um which can be useful because then you sort of have the view down at the query interface level and not just at the metadata semantic layer level. So, there was a table in there um in the previous

[36:13] section that was kind of explaining that, but hopefully that's helpful so you understand kind of where where we're going with things. >> Yeah. Yep. Grap and Yes. And we're doing a ton of stuff inside of context graphs as well and and and um and all of those

[36:31] layers. Yep. All right. Awesome. Um any other questions? Okay, I have one question over here. >> Yeah. So, so the question is um why would we not take our OOLTP data which is right now is this warehouse of vehicle orders and and stuff and just

[37:13] migr or or some subset of it. Why wouldn't we just push that into the graph? Well, I think in a lot of cases that's easier said than done, right? Because if you think about a lot of production use cases, you can have terabytes of data

[37:30] which gets updated continuously. And so, right, if you had to put that into the graph, you would then have to find some way of syncing that while you move everything in. Um, and there's might be a lot of extra properties or

[37:44] things that you might need to build a custom ETL where there's some things that you might not want in the graph. And then a lot of times what people end up not really understanding until they get in those situations is the security

[37:56] posture. Because if you have sensitive data that's in one system, it might not even though you could physically move it in, you you might not actually be able to for security reasons take that data and just move it into another database.

[38:08] Um so so there's various reasons why you might not necessarily want to move your data over. Uh where you do get an advantage of the ETL over just this metadata and semantic layer graph is if you have graph queries that need that

[38:23] performance, right? So like that supply chain case that I had earlier like if you're doing these really large recursive joins and you need them to happen very quickly or you need to run graph algorithms maybe you need to

[38:34] produce graph embeddings or you need to do some sort of clustering or something in that case it makes a lot more sense to to bring the data in. Um and then as we'll see in the next sections when your data is already unstructured uh there's

[38:46] benefits to bringing it into a graph because then you can give it a graph structure. All right. I saw one other question over here. Yes. >> So the the question is does it rebuild the graph every time you initialize Neo Carta? And the answer to that question

[39:09] is no. What it will do is basically when uh we we ran that build connection script um it went ahead and ran an MCP server function that ports the data in um and then once it's ingested into Neoarta just the metadata then that

[39:27] stays there. So like for me I didn't rerun that build connections right because I just took the course last night. Um so like for me I and I probably could have because I I think it's an item pot and load but I just didn't want to deal with it. So, it was

[39:40] there for me and then I just ran the queries on top of it. Yep. All right. Any any other questions? I have one over here at the end. Yes. Yes. You >> the the Neo Forj cipher skill. Um, so I don't know if I might be able to uh grab it really

[40:14] quick. Um, I can show you Neo forj cipher skill. But this is these are all developed internally by our team. So if you go here actually through the Neo Forj CL, you can download a ton of these skills. So if you see here, there's there's the

[40:36] cipher one, but then we also have the different ones for like agent memory, for cloud infrastructure, for different drivers, like if you're using Java or Go or or all those things. Um, so I can't necessarily say exactly how we landed on

[40:52] this particular skill MD, but what I will tell you is it was created by us and our internal teams who are like always up to date on the latest, you know, cipher 2526. Um, so so it it it has all of the latest. So I' I'd encourage you to use

[41:10] the Neo Forj CLI because it will basically you can load one or multiple of these skills and you'll get the latest knowledge there because it otherwise what what it's going to do is it's going to go on the internet and get

[41:23] the Stack Overflow questions from like four or five or six years ago and it's going to give you outdated bad cipher basically. >> CLI >> it is. Yes, it is loaded in. And uh if you look at the um the install file that we use inside of dev container, uh

[41:42] you'll see um where we installed the Neo Forj agent client, the skill. So the commands in there um that that basically allowed you to do that. All righty, I'll take one more question and then I think I'll have to move on to

[41:58] the next section unless there isn't another one. Yes, right there. um bronze so like the different like delta tables where um so I mean we're we're exploring basically um the traditional like SQL structured data warehouse and then NeoAR Carta is really

[42:34] customer-driven for us. It was made by our field team. So as customers come in and they have questions about less un less structured data um and even things like documents have been considered for Neo Carta and so there's this backlog

[42:49] that's forming right now. Everything's moving very fast. I think I mean Ryan is is somewhere in the room and he might be able to to speak on sort of what's what's the next thing for Neo Carta, but I know we're working right now on a data

[43:02] bricks connector um and maybe some metric views and other things. >> All right, awesome. So meet with uh with Ryan afterwards and then everyone watching on YouTube I guess can meet with Ryan afterwards but by then we'll

[43:24] we'll have we'll have an amazing Neil Carta. So all righty. So so let me go ahead and move on for sake of time because we're coming 15 minutes on the halfway point and it might be nice to take a few minute break at some point in

[43:37] the middle just to just to give ourselves a little bit of a breather. So now I'm going to jump to the next section. And so that was working with structured data and now I want to work with unstructured data. And this is

[43:51] going to be the documents part. So we have if we go over to our little uh our little uh source data stuff here. So in this case I'm going to read them locally to load them. Um but you know it's reading from cloud storage reading

[44:10] locally. Um there there often isn't a huge difference. Um basically we have these bulletins in PDFs. Um we have manuals which are considerably longer. Um and then we have recalls as well. And because it's giving me this funky view,

[44:27] I also have them in uh in this raw corpus where they're they're inside of um these uh markdown files here. Um, but basically, uh, there are these multi-section documents. Um, and you'll see here that they have, uh, this

[44:46] linking that they do to go over to different sections in other documents. So, they're all kind of interlin together as they refer to one another. Um, so, for example, right inside of inside of this manual, um, it talks about these different platform codes for

[45:01] this ABS system, um, and diagnostic troubleshooting, right? and it will link over to there. All of this data, by the way, is I simulated. It's not sensitive or or anything like that. Um, but it's meant to simulate kind of a real world

[45:15] uh system where you have these manuals and bulletins and recalls of all these different vehicles. And um what we want to accomplish with this basically is we want to give our agent a table of contents. And and by a table of contents, I mean something that

[45:30] looks like this thing. So, what I want to allow the agent to do here is not just search for key terms. We'll give it search too, but I don't know if has anyone heard of like page index? Anyone know who they are? Maybe some of you.

[45:47] So, there's so there's this idea of navigation through your documents where basically almost like a human if you look at the table of contents inside of a book and not I'll call this outline. I'll call it table of contents. I need

[46:01] to get the terminology a little bit better aligned. But the idea here is that you can sort of read the indentations and you can see how you have a document or in this case a library. You have the bulletins which is a subfolder. Then you have these

[46:17] documents underneath. And so you have this containment tree. And then in addition to that containment tree that gives you all these sections, you also have these links that'll take you to a different document. So it's more than

[46:31] just a table of contents that's a tree that goes down. It also has these links, right? And these links and basically everything in here have a URI. And the idea is that if we can come up with a good graph representation, we can

[46:48] basically make it so that these URIs which are hierarchical. So you see like you have your technical library here, right? And then slashbulletins. So, like if I'm down in, you know, this TSB recall notice, I know that it's part of

[47:04] bulletins, um, or safety bulletin, rather, not a recall, and it's part of a technical library, just like it's also linking to a manual here. Um, and you can see the name of the manual, then it's inside of the manual subfolder. Um,

[47:19] and if I have that, I can take that and I can plug it in and I can actually grab a node from the graph that has like the raw text or or even a link to the raw text. And so, and then if I uh plug this in and we'll see how this works with

[47:34] outline later, I can actually get these sub trees so I can like dig in and drill down on these different pieces of content. Um, that's the general idea with this. And so what this gives the agent to do is not just search like

[47:46] vector search or or lexical search but actually kind of traverse through the documents in a sense. Um and the data model that we're going to use in this case we're actually going to import the data into graph. Um I have a I have a quick question for

[48:06] everyone. So, everyone here is knows Graphrag. When they think of Graphrag, and maybe someone can raise your hand and I'll I'll pick on someone for a second. I want you to tell me what you think like the pro the the building the

[48:21] graph process is for Graph Frag. So, I don't know if anyone wants to wants to volunteer if they're familiar. You're going to raise your hand. >> Yes. Yeah. And they build they build the they build the links from from the So there's different ways,

[48:53] right? And and you said I think in in your when you talk about creating um a graph, you build the links from the data that's inside of the documents, right? And so graph rag oftentimes we have an entity extraction piece to it as well.

[49:09] So we can use an LLM to kind of say hey like extract the different parts the different vehicles from the from the graph and have them be separate entities and then have those links to like the original document chunks and all all of

[49:25] this stuff. And that's great and that works really well. Um here what I'm going to show you is something that's much more lightweight and I think maybe to the point that you were making um we're actually going to use a deterministic loading. So if you see

[49:43] here the way that this graph structure is going to work is you're going to have your library and then you're going to have this containment tree that reflects what we saw. And all this is really doing is it's breaking down, you see the

[49:54] folders, the document, and then these documents have sections and they can have multiple sections that will also nest underneath each other at different section levels. Um, and then you'll have um next section links. So you get a

[50:09] concept of ordering as well as linked to which uses in this case we're using um these named links uh sort of like you might see inside of an Obsidian vault a little bit um but you can also do it with hyperlinking and other things

[50:25] depending on depending on what your data looks like. So, it's all deterministic with the containment tree for one and then the ordering of the sections as well as the links. Um, and the benefits of having a deterministic load like this

[50:39] is number one, it's going to be item potent. Um, so like you're not relying on an LLM in the beginning. Um, it's often going to be a little bit faster. Um and so if you already have documents which have a lot of inherent structure

[50:52] to them and a lot of interlinking um sometimes just to get something up and running quickly it can be very beneficial to approach a graph like this where I'd say it's more of a lexical or document structure graph rather than

[51:05] like a full like entity uh you know extraction type of pipeline to create a graph. Um and it it explains here what I just said with the different link types. Um and then and and like I said before these URLs carry a hierarchy. So every

[51:22] node for example that that head node at the top here for the library will get its URI manuals will have that plus back slashmanuals um going down sort of the containment tree to the to the file name and then the different sections

[51:41] and um this is the script you're going to copy to load it in. So basically again you'll take this, you'll go over to here. Um you'll open your bash terminal. Now I believe I've already done this so I'm not going to run it

[51:55] again even though I I'm pretty sure it's item potent. Um but basically once you run that um what you'll end up getting is and I'll just make sure it's actually in the graph. It is for me. You'll end up getting that uh that model that we just

[52:10] saw. It should only take Well now it might take a while if the Wi-Fi is slow. although I don't think it should. Um, but it'll create this graph for you where you have again your top of the folder structure which is our technical

[52:23] library, our folders, and then you can see we have our documents followed up here into our different sections. And if I were to zoom in here, um, you'll see we have the has links in the next section, but then we also have the links too. And I can go in

[52:40] and click on these and you can see kind of how the thing grows and everything kind of links to each other. And now that we have that, um, basically in the next section, we can go ahead and build our tool. Um, basically the script

[52:58] that goes along with our our custom autofix skill that we've created uh to um to actually like create that outline shape that we saw in the beginning, the the table of contents to hand our agent. And so if I go ahead to that next

[53:15] section, um, and again, like I said, what I want to do here is I'm going to go ahead and copy this. This is the this is the prompt. Um, where if I go ahead and feed that to my claude, it should go ahead and get to work.

[53:44] And because I know that's going to take a while, I'm going to have it start running here. But basically, what it's doing as it goes through um is if I go under and I look at my skills, um you'll see that I left inside of here

[54:04] um this wired query. This is this is the query that it needs to create um to be able to create that outline shape. And I've instructed it inside of the language here to use the Neo Forj cippher skill and reference a spec in

[54:20] doc outline format.m MD. So this is generally how I like to write more complicated cipher queries, more complicated graph queries is I'll write a spec for it. Um, and so if I go to my docs folder, you'll see I'll have my

[54:36] specs in here and I have my outline format spec where I say this is the shape, right? And then it it talks here about how it needs to be human readable and uh yes, we will allow you to edit and um and some of the optional

[54:54] arguments it needs to have. So, right, because oftent times it's like pseudo code that we'll have and we don't know exactly how to put it together. Um, um, in this case, I did give it the hint about having a variable length path

[55:12] query uh to basically put everything uh put everything in order. [snorts] And then it will say when it's done. And so basically what you'll get out of that is if I go back here and it will talk a little bit about like one of the keys to

[55:39] this you'll see in the file is it does this thing here which it goes has which is that containment edge and you see this star 0.25 it's actually parameterized inside of the inside of the query. So like uh if I go back to my

[56:00] um me go to where it changed um if I go back to here it's it's parameterized inside of this string. So it gives you like an option to how deep you want to traverse. Um and that that's sort of the graphy nature of kind of

[56:16] putting together this table of contents. There's there's a second query in here too which is much simpler which just grabs the links after that. Um so that basically uh once that's done I can go ahead and um copy I'll run the whole thing. If if you just

[56:36] run the script without any depth parameter or without a specific URI, it's going to return everything in the graph. So it wouldn't be the way that I'd I'd run it with with a larger graph here. We end up with because we only

[56:49] have a couple hundred documents. Um so I can get away with it here. Um, but if I ran that, um, it'll it'll bring back a ton. And, but you can kind of see here, um, zoom out. So, you can see, right, that it gave me this. And you can see

[57:12] how a lot of these documents again, it's not just the structure, it's like the links between all of them that it's that it's providing. Um and then what you can do with this right is you can give it an optional depth parameter. So for example, if I

[57:26] just said depth equals one. Uh go you don't like clearing to the bottom and I say depth one. Then if I did that um it'll go ahead and just go one down. And then the other cool thing with this too is you can provide it a specific URI.

[57:51] So if I saw you know a specific URI here that I wanted to give it um then it will basically start at that Falcon 2.0 no document just like you know if I um if I was here now and say okay well actually you know I want to do

[58:13] um I want to do it but I want to do it for something that I see up above like maybe this links to you know this um coil identification thing I can go ahead and snag that URI and then I can put it in the script and then it will basically give me you

[58:32] know that document and everything it links to. So you can say see how an agent can go through now and sort of grab these URIs and kind of traverse all through the through the graph and give itself these hierarchical and and linked

[58:44] views. Um the okay yeah why don't we why don't we take a second for questions. So we have one in the middle here. Um well so later in the course I'll in the workshop here for some of the last questions I do instruct the agent to say

[59:25] exactly what steps it followed. Um are you seeing it use something different? >> Right. >> Yeah. So it should be apparent in the tool call history. Um so you can you can look at the different tool calls that it made because in the case for example of

[59:48] connections it's calling an MCP server. So those should be inside of your tool calls. And the question by the way for everyone if if you couldn't hear um it was just how do you know that the agent's actually calling the things that

[59:59] it's supposed to right yeah so so for cloud code for example you can look at the tool call history um and informally what I'll do in this course is for some of the prompts I'll I'll just direct it to say like hey like clearly like say

[1:00:13] like what steps and logic you use to be able to to answer this question. Um, you know, obviously for a production system, you would you would want to look at the logs and everything, but for here and for learning, I I that's how I'll I'll

[1:00:27] expose it. Um, is there are there any other questions about uh trees outlines? >> Yes. One right here. >> Yeah. >> Yeah. So, um it is uh all the code for that should be in uh oh yeah, we'll need to restart. Um oh, that was a different codebase.

[1:01:03] Thank Thank goodness. All right. Um yes, inside of load, if you go to load documents, this is this is just the cipher queries. And then you have your parse corpus um down here. So yeah, it's basically just using regx in here to try to find,

[1:01:26] you know, the the right stuff. In this case, the documents are already fairly well structured, right? So mileage may vary depending on what your document sources are. In this case, right, if you have a lot of manuals that are often

[1:01:39] structured the same way, then you can get away with sort of regex and plain NLP techniques. If it's messier, you might have to use like um you know, gler or different types of looms and there's stages of complexity for that.

[1:01:53] All right. Yes, we have a question over here. Yes. Yep. Can be done with any model. The only thing that Neoarta and any of these tools well neo I'll start with neocarta neocarta is really responsible for creating that semantic layer metadata

[1:02:21] graph and providing you an MCP endpoint right so as long as you can access that MCP server it's model agnostic okay so that was that was a question about basically we're using opus 4.8 here and can we use any other type of

[1:02:36] model and the answer to that question is is yes we're using a skills framework and then in and then for Neo Carta we have MCP um Neo Carta also has a CLI so there's there's other ways to access it too um I have one question all the way

[1:02:51] in back there So the question is around if if I'm understanding correctly, how do you decide what to name your relationships and how descriptive they have to be and who is naming the relationships. So in this case, we have a very deterministic

[1:03:27] load. So we're deciding ahead of time what to name our relationships. Um, and that is a bit of a a taste or a judgment call, right? Uh, I tried to keep it simple here where has is very simple. It's a containment relationship. I also

[1:03:43] know that I'm going to want containment going multiple levels. So, I probably want a common name for all of those because if I have like has folder, has document section, it makes the cipher complicated. Um, so that's sort of why I

[1:03:56] kept that naming very short. Same with links too. Um the more granular you get with naming um basically the more sort of detailed uh your agent can be and your end tools can be in putting a query together. But then the more complicated

[1:04:12] your data model becomes. And so it's a little bit of a thing that you have to manage because if you end up in like a production scenario where you have hundreds of different types of relationships um that might get hard to

[1:04:24] manage inside of a context window and it can lead to models maybe not having the easiest time putting those cipher queries together with something like the Neo Forj CL or humans, right? When we're trying to, you know, write our own uh

[1:04:36] sort of parameterized queries. Yep. Yeah, that's true too. Um, and we see that right that that's the whole semantic layer argument too with on the warehouse side is you can have these metrics views and other things which use

[1:04:55] business terminology that might be different from sort of the the physical data model that you have, right? Um, and so that's that's part of the reason why we have these metadata graphs to to help manage that sort of different or that

[1:05:08] delta between them. I'll take a couple more questions and then we'll we can move on. Yep. >> Yeah, that's an interesting question. Um, I think it would be naive to call it a replacement because most of the people that I see using this will eventually

[1:05:37] incorporate some sort of hybrid vector retrieval or full text search work I do. I use at least full text search um, with this sort of stuff. So, I don't think it's a replacement, but as we'll see later in the course when we get to some

[1:05:51] of the estate level questions. Um, there's certain things that semantic search is not as great at answering that really require document navigation to understand how like everything connects together, right? Um, so big examples

[1:06:06] would be like proving something doesn't exist. Like how do you do that with semantic search, right? or understanding um even like how you know there might be different parts related to a specific document or something. You know, you

[1:06:22] could in theory do like a bunch of vector queries to keep pulling passages, but there's more, you know, chance for error that you might not catch the right document and all this sort of stuff. Um so yeah, not the question was if it's a

[1:06:35] replacement for semantic search and I don't think it is. No. Um, one more in uh back there. So, um the question is do we redefine the types of nodes um as well as the relationships and so is this a question of like how do you decide what the node

[1:07:08] labels should be? Um, yeah. And again, it's it's again, it's a data modeling question, right? Like there could be a situation where we're looking at the data model that we just went over. Um, well, it's not it's not here. It's in my

[1:07:22] uh it's in my last one. um when I look at the uh when I look at the shape um zoom out of that a little bit where it might be useful to have like an actual parts node or something right um here for this type of use case I'm letting

[1:07:44] the agent kind of infer parts and extract them from the documents and then use that to go find something from the metadata graph and query SQL or the or the other way around. Um, and that works for me. So, you know, it's still as as

[1:08:00] things evolved, like two years ago, I probably would have said you would need that like additional node. Now, it seems like agents are smart enough where maybe you don't all the time anymore. Um and but for some use cases, you know,

[1:08:13] especially like we see this in life sciences for example, where there's these really specific ontologies around, you know, different types of molecules and medications and things and you you really do need that represented in the

[1:08:25] graph or else it just your inference isn't going to make sense. So I hate to say it depends on use case. I don't want to be that person, but it it sort of does in a sense. All right. Um, oh, okay. Yeah, let me let me move on

[1:08:41] only because we're a little bit over halfway through and I have some more course to to get through here. So, um, let's go to So, we went over all of this stuff. Um, oh yes. So, we need to build our uh search query. So, similar to what we

[1:09:02] just did and to the the question that the gentleman had over here, uh we want to be able to um we want to be able to build um some sort of search as well to help augment this. So, um this is going to be much more simple, this search uh file. Um

[1:09:24] basically, I'm just going to use a lucine style index. Uh, and I I'm not going to use vector search here. It's the Neo Forj itself has um a lucine full text search index, but and I'm going to do and if you see here, it's basically doing the same

[1:09:41] thing where I have the uh this this wire that it has to fill in. Um, and it's going to use a cipher skill to do that. While it's it's running there, you're allowed to edit. Um, we might as well wait till it's done. All right, it's going to finish up. So,

[1:10:03] basically, uh, if you see here, it's the way this works is you call the full text index. Um, it's indexed on the document and the section nodes. Uh, so every node that has text in it, like we don't put folders through through this lucine

[1:10:19] index. Um, and then it will give you a score. Um and then because we have everything in those URI format um we can also scope it by subtree um basically with like a starts with filter. Uh so if I was to go back into this uh file um

[1:10:37] and I looked at the way that this query run I have this wear statement. Um so I'm applying this as a post filter basically where I'm doing the full text search first. Um and then I am filtering it by the URI. So I can say like only

[1:10:52] search under like this section of the manuals basically. Um so it just helps me refine my my search a little bit with those hierarchical URIs. Uh, and the other thing that I do, um, and and I do this because I work like in in the the

[1:11:09] research role that I have, I work with so many different AI models and on so many different platforms. Like you wouldn't think about it, but like choosing like and wiring like options to be like work with like six different

[1:11:20] vendors for vectors is kind of tough. So what I often do for this is I'll use something called semantic expansion. Um and basically what it does is it it instructs the AI model to say hey like use your world knowledge if someone asks

[1:11:34] for you know an engine shuttering that it might be a misfire or something else too. So it and because this is a lucine index um I can do that. So for example right I can say like misfire or rough idle and it will search for either of

[1:11:51] those. Um, if I go back to my bash script and I run that now that the uh thing's filled it in and then you'll see it'll give me my uh documents with with the scoring for for the different ones. And it I can also search as I was saying

[1:12:09] before under recall. So I can search for coils under just the recall uh subfolder library. So that would be the idea here. Um, so you can see it's still leveraging uh that hierarchical containment shape, the tree, um, but it's doing it through

[1:12:27] the URI um, ID structure so that it doesn't have to do as much graph reversal. It just sort of filters down to to things underneath. Um, all righty. Awesome. Um, are there any quick questions just around the search piece there? The lucine search.

[1:12:54] We have one question over here. Yeah. So the question is we just loaded the documents into the into lucine and then we're searching underneath different sections appropriate sections. Yeah. So basically if it might make more sense if we

[1:13:23] actually took a look at the the query that we're running here. So here's the I'll make it this big. Um so here's here's the cipher query and I'll I'll create a space here so you can kind of see it better. So we have a lucine index that we've set and we set

[1:13:44] it when we loaded the graph. We set it on the document and the section nodes. So every time that I call this index full text query nodes, it's going to hit the name of the index which is content search and then this parameter lucine is

[1:14:01] whatever I've fed it in with that script. And so that's going to do our initial filter to just a bunch of documents and sections because we've structured our IDs for every node as a URI that's hierarchical. If I know that I only want to search

[1:14:17] underneath recall notices, I can hand it that URI and it will say only nodes whose URI starts with that thing. So it's applying that post filter afterwards if that makes sense. >> Yeah. Yep. You have a question. So the question is if say you already

[1:14:57] have a graph and you haven't created your lucine index yet, could you prompt claude code to basically do this for you? Um so I I think yes to be honest I might have done that with this course initially. I might have actually had

[1:15:12] Claude do it. I can't remember because I' I've rebuilt this in in a in a few different ways. Um, but I think the answer to that is yes, your mileage may vary depending on your data. A lot of times with when you set up a lucine

[1:15:26] index too, it's like especially it's very flexible inside of Neo forj. So it's like you can set it up on top of one node or multiple nodes, multiple properties on one node, multiple properties between multiple nodes. So,

[1:15:39] you know, there there's a lot that flexibility can also be a little bit of an Achilles heel too when you ask an AI model to do because it might not understand, you know, all those various options. But in general, yes, you you

[1:15:51] can have um you can use agentic coding to to help put this together for you. >> Um yes, in the middle there So the question is how important is it that the name of the documents be accurate for the agent to traverse it effectively?

[1:16:22] Um, >> I think I think it would. Yeah. If if your documents weren't named very well and you had that outline view, then the agent doesn't have as much to go off of when it's trying to traverse. So, it might misinterpret what a document

[1:16:45] means, right? Um that's why having the search augmentation alongside of it is useful because it can actually look in the document. Um with these things what I've seen because I use this actually for my own knowledgebased management. I

[1:16:59] have my own open source library that I use which has these tools. Um the biggest problem is when you have documents that are outdated or drifted, right? Um, so I've thought about, well, maybe we need to add like a last updated

[1:17:12] date or something or like um whether or not a document should be authoritative, right? Um, and the document naming is actually important. Um, and link naming as well is important too. Um, so if you're if you have links that um don't

[1:17:28] have like um I forget what it's called, but like in Obsidian, you can sort of you can name the you can give it um uh a synonym or something, right? where you name the link like that can be very helpful if that's there right because

[1:17:41] then it's like oh I know exactly why I'm linking out to this other thing um so that's when sometimes using like a language model inside of the ingest if you don't have that could could be beneficial um yes over here so when you get a new document that

[1:18:04] comes in um so the nice thing about this is that it's all an item potent load which means that say your entire graph went away tomorrow as long as your documents didn't change if you load them you'll get the same graph so worst case scenario yes you

[1:18:24] would have to reload the whole graph but this load is deterministic now you can also and I've experimented with this again in some of my other um work is you can say oh well I have one document that changed and I just want to update that

[1:18:38] one node. You just have to be aware of the fact that it links to other things. So it's like well if you got if you changed if you updated this document over here um if you changed its name then you have to you know did your other

[1:18:53] documents also update like the URL reference to that document. So there's little edge cases there that you have to work through. But um if you're able to do that maybe we can talk after and I can show you. You can have like just add

[1:19:06] to like this part of the tree and clean up this part of the tree so you can do like partial sinking. Yep. All righty. Um is do you have your hand up back there? You're just scratching your head. All right. Um then I guess we have one

[1:19:26] question here. right? the default after something like page index would be search. >> Yeah. Yeah. So I think the question is the question basically like um for the way that the agent reasons about it that it would call outline first to then use

[1:20:21] like search. Yeah. Yeah. It it could work that way. It could work some way where it will search first to find a relevant document and then try to find everything it links to. In which case, it would be the opposite way around.

[1:20:35] All right, awesome. Let's um let's move on here then to make sure that we have time for all of our questions. Um so what are we doing here? This is just more asking more full text search. Why don't we because we're at 39.

[1:21:02] Well, I think we already effectively went over a lot of this material here. Um, some of this is designed so that if you come back to it later, it kind of overdocuments what I'm talking about. So these steps and some of the optional

[1:21:18] work will help you understand cipher a little bit better. Um and kind of exactly how exactly how all the pieces fit together. But given given the pace that we're moving at, why don't I go ahead and jump over to our um theme

[1:21:34] section. So I'm going to skip over the optional practice lesson here and I'm going to go right into into themes. So this is going to be our third and uh last shape of today. The the idea with this is if you run so this cipher query is basically going to

[1:21:56] be loading a graph and I'm just looking at that links to relationship between the documents. So when you have documents that have a lot of interlinking um it's always nice to think about using a graph because this structure basically

[1:22:12] what it's saying here is right we have these manuals these recalls and these bulletins and they link and they refer to each other. Um, so you can see like this, you know, um, uh, this this this guide here that's a um that's a manual

[1:22:31] is being linked to by all of these different repair procedures. And if if you zoom out, what ends up happening is you'll get natural clusters of things. And this also happens a lot like in these kaparthy style like knowledge

[1:22:46] bases where you'll see that like concepts will naturally start grouping together and a graph can help you surface those themes those things that you didn't actually know existed before. And so we're going to use something

[1:23:04] called lien community detection. By a show of hands, how many people in this room are familiar with what graph data science is? Well, yes. Okay. So, so not too many of you. Do how many people know what community detection in a graph is?

[1:23:21] Okay. So, we we have some of you. So, so community detection is this idea where right if if I have this graph um and you can kind of see if I zoom out if you if especially if you're running it locally you can see that there's

[1:23:35] these like natural little like clusters right of nodes that are highly interlin together and so the idea is like well what if we can like try to label these clusters such that within a cluster things are highly interconnected so like

[1:23:50] this little globule of nodes becomes a cluster cluster, then this globule becomes a cluster and this one down here. Um, and and if if we can do that, we can start understanding our data at a global scale really well. So, this is

[1:24:03] like that initial like Microsoft graph rag idea too of like of global versus local search, right? We're doing something very similar here, but we're doing it in a very lightweight way where we're not really doing any LLM

[1:24:15] extraction. We're just going off of literally the the structure of the documents. The algorithm that we're going to use for that labeling is called Leiden, which is similar to Louane, which if you talk about community detection, Luane will come up a lot.

[1:24:30] Leiden is I almost see it as like a um the sort of next step. It's a little bit more efficient um in in the way that it runs. And um it it's using Neo Forj's graph data science library. So basically what we have to do or what what we do to

[1:24:48] make it very performant is in addition to just having the database we have this other um projection where we'll take a part of the graph into memory um and then we'll run these high concurrency algorithms on top of that so that if you

[1:25:04] have a graph that has say millions or billions of nodes we can start performing this clustering and then identifying um basically the different interconnected communities. and um these clusters. If I um keep going down, basically the the

[1:25:24] format that we're going to go for here, sort of the view that we're going to show our agent is this one. And so it's a little bit hard to see because it's a sliding window, but basically we'll have what are what we're calling themes. And

[1:25:38] these themes are going to be these buckets of documents. we'll have a sense of how tightly or loosely they're interlin using um this conduance metric. It's basically like going to be this metric around like how interconnected

[1:25:51] the nodes inside cluster are versus how much they um are connected outside of the cluster. So we can say something's tightly interlin or loosely interlin. um we'll use the labels on the links as the top shared targets and we will um

[1:26:09] talk about the most linked docs and so so the highest centrality docs inside each of them and so what we end up with without any sort of um tagging or labeling by AI or a language model um is just simply from the document structure

[1:26:25] we can tell that this first one um is about you know um BCM um and and bus and all these sorts of things. And then if if I go down like this next cluster is going to be about brakes um and rotor pads and um hydraulic lines. So it's all braking

[1:26:47] stuff. So you end up with these very natural sort of clusters that come up. And so this is very useful from sort of a whole estate wide question because you can start to understand in your data kind of how everything kind of groups

[1:26:59] and clusters together. Uh and so the way that we build that is similar to what we were doing before where we have that script and we have our um our spec as well. Um, so collapsing the sections and it talks a little bit here and I I kind of want

[1:27:23] to give us the last half an hour to go through the final questions. So I'll speedrun this a little bit, but basically when we create this projection and I'll just go ahead and and copy this thing. Maybe I'll I'll do this script

[1:27:36] thing first. So like we did before, um, inside of here, uh, if I look inside of my themes.py Pi file I I have this wire for this for the projection that piece where we take the graph and put it into memory. Um the actual liiden algorithm here I'm just

[1:27:53] calling it with that graph data science library. Um so in theory you can you can kind of agent code all of these. Um but I'll just do this one. Um oh that's not good. I want to be able to make sure I copy the right thing. So, similar to

[1:28:08] before, um, we have our, um, sure that the right thing that I just gave it. Yeah. So, we're telling it to use a cipher skill and the GDS skill to put this together. If you went inside of our docs, you have the uh, theme format

[1:28:25] one, which will give it the the shape that we want and everything. Um, and it will tell us kind of how we want all the headers and things to be formatted. Um, and so we'll go ahead and um create that create that for me. And while it's

[1:28:45] creating that, I'll talk a little bit about the projection. So there's some graph manipulation that we do to bring it efficiently into a projection. Um, basically we collapse the relationships on the URI so that the if we have

[1:29:00] sections that interlink with each other like one section of a doc interlinks to another subsection, we just aggregate that all to the document level. Um, and that creates kind of a cleaner interpretation to how our documents link

[1:29:13] together rather than just all our individual sections and we can get out the communities um, easier that way as well. All righty. So, that looks like it's coming along. Yes. Okay. So, it went ahead and created that for us. Um, and then once we get that back,

[1:29:44] uh, I can go ahead and copy the script that it just helped me create and I can run that inside of my terminal. Let me just make a new terminal. So, I can go ahead and and call that theme script that we just edited. And then it will do that community

[1:30:03] detection. And you'll see here that I'll get that view. Um so I have my you can see like the this you know circuit you know one I have all my different uh documents that are that are grouped together and I kind of understand now um

[1:30:20] all the different areas of the vehicles that that my documents go over. Um there's other parameters that you can feed this. Um so for example we have a gamma parameter and basically what that will do is uh basically tells it kind of

[1:30:38] um how how much to split everything into. So it's one parameter that we're exposing. If you went to the graph data science documentation there's many others. Um but like I got 13 groups running it here. If I if I try to make

[1:30:54] it more refined with gamma equal to two. So it's one by default. it will give me I think in this case 14. Um so it basically splits it up into more groups. A lot of these community detection algorithms also because they're hierarchical you can choose to

[1:31:11] sort of you can choose your level of granularity that you want. Basically um as you go along and you start to understand your corpus better, you may want to tune some of these hyperparameters. Um and this gave us 14 different themes.

[1:31:26] Um, let's see what we have here. Yeah. And it never really names a theme is sort of the point of this. So like everything that you get um is just directly from the document. If I was to look at like the the theme here, the

[1:31:49] names of the links, the the names of the the top files that were read, all of those things are just directly from the data. And then because you get the URIs, the IDs of some of these documents, you can start doing the thing where you can

[1:32:05] go back to the outline shape or the search shape and you can like search underneath all of these things. So, it gives the agent the ability to kind of jump between multiple tools like this. Um and so this the these sorts of things

[1:32:21] are good for these estate level questions. So things like where are issues concentrated? Where's documentation thing thin? Where does new documentation possibly belong on some other different type of subject that just came in for adding more data.

[1:32:36] Um all righty. So that brings us to the end of themes and we have 27 minutes about left. Are there any questions around this themes uh algorithm that anyone has really quickly? Uh yes. >> Yep. Yeah. So that's a good question and the

[1:33:26] question is once you get the themes so all the line algorithm will do is assign an ID to these different groups right and then what you do after that is sort of your choice and your question is are you just sort of taking from the data

[1:33:44] and just putting that there or are you making some sort of inference afterward to label the different groups. Here we're doing the former. We're just taking what's in the data and we're just showing it to you. Um, and the advantage

[1:33:59] of that is every time I run it, it'll be the same as long as the data stays the same. If the data changes, it will change to reflect the data. So, it's very stable. The disadvantage to it would be if your links in your documents

[1:34:13] um, and the titles and things that are being scooped up, because this is really only looking basically at document metadata and link metadata. um if those things aren't already wellleeled, this view might not be super informative

[1:34:26] right off the bat. That's why you have, you know, with like the the graph rag methods that Microsoft came up with, they do a lot of heavy entity extraction because then what that will give is this sort of and they'll do um hierarchical

[1:34:40] level summaries, right? So after they get the light in community, which is the same algorithm that they use, they'll do a summary that'll be LLM driven on top of each theme. Um, so that's possible to do. Um, but then obviously it costs more

[1:34:54] money, it's slower, and the you if you run it twice, it might not return the same thing. So there's trade-offs between uh each way of doing it. I'm showing you the sort of lighter way of doing it and the easier way. Um, just

[1:35:08] because it's faster and if you're just getting started with this, it might be easier to to start there. Um, may we have time for maybe one maybe two more questions. Um, yes. >> Temporal data. >> Yeah. I mean, um, I've seen customers,

[1:35:36] you know, basically every time because because the way Leiden works is it's it really is this algorithm that where it will suck everything into a projection. it will create its labels and it'll it'll die down and then it will go away. So if

[1:35:52] your data is being updated constantly um you can recreate your ids um and you can have almost like a time series of of different theme ids for example um and then you can if you want create summaries sort of at the snapshot of

[1:36:07] when they existed or you can see how they evolved over time um but it's a very common use case a lot of people will actually use this even before AI they'll use this for things like um fraud detection so like looking at um

[1:36:21] like credit chargeback fraud or like some of these other like um anti-moneylaundering type of stuff to look at clusters and for that they'll have to do it temporally like they have to keep running it um to kind of see how

[1:36:31] things change over time and then predict the future. Right. So they're used in those scenarios too. Yep. All right. One more maybe and then I'm gonna have to move on. All right. I Okay. Yes. So the question is if you have a really

[1:37:03] big graph, how do you take this view that's being sent to the AI model and make it manageable? Yeah. Um so for this view I think it's showing like 14 themes. So there are cuto offs that you can make. So for example you can say like for communities

[1:37:27] that are smaller than X threshold like you don't necessarily need to highlight them. Sometimes small communities are very important which is why that conduance metric which is powering that tightly interlin loosely inter interlin

[1:37:40] you can also make that a cutoff. So if I'm interpreting your question correctly, it's sort of filtering down kind of the amount of information to what's most important to show the AI model on a larger graph. Do I understand

[1:37:53] that correctly? to make sure that the relationships on the nodes are correct. And um so yeah. Yeah. I mean, so in this scenario, we're really sort of trusting, we're taking the source data kind of at its word, right? If something links to a

[1:38:35] document, it links to the document, right? If it's erroneously linking to a document or there's a section that's malformatted, um, we wouldn't necessarily catch that. But I suppose a good thing about something like an outline shape is that

[1:38:49] you can have your agent traverse it um automatically without you necessarily seeing it in small pieces and it might be able to catch some of those things, right? Um so I suppose it does give you that navigation would give you a way to

[1:39:02] kind of have an agent supervise the graph and understand like malformed data or data that's been a problem. Um but it's a good question. I don't know if we have a perfect solution to it. It's cleaning and cleaning messy data has

[1:39:16] always been a, you know, a thing. Yep. All righty. Let's go ahead and and move on because I only have 20 minutes left and I anticipate this last uh section will be this is the the meatiest one. So hopefully we'll have enough time to go

[1:39:30] through it especially because Claude has been slow. So cross your fingers um because this one is probably the heavier use of claude. So there is a section here around just using the Neo Forj CLY because we're just 20 minutes in. Um I'm

[1:39:46] probably end I'm not going to go through it all the way but I'll talk about it for a couple minutes. The Neo Forj CLY is a a Cly tool. So I can run it in the command line. So here for example um if I opened up a terminal window I can go

[1:40:02] ahead and copy it in and it will run a uh query for me and it also has the ability here to grab the graph schema. Um and what that enables me to do is um basically understand what's in the graph and then write a query based on that.

[1:40:21] And if you have your agent which in this case because we're using a coden agent it can access the neo forj cli it gives it the ability to do this graph reasoning read the schema and then do flexible queries. So this is very useful

[1:40:33] if you have a question that you didn't anticipate and the agent's sort of gluing things together between the shapes, right? It has to write its own custom cipher query. It can do that very efficiently. Um, and I've seen a lot of

[1:40:46] improvements using this along with the skills. So much better than the text to cipher experience that we've had like even as as soon as a year ago or six months ago. Um, if you are going to be writing cipher or doing anything text to

[1:40:59] cipher with an agent, I'd highly recommend using the Neo Forj CLY. Um, as well as the cipher and GDS skills that we were just going over. So, with that in mind, I'll go ahead and take it on to our, in this case, our last section. If you

[1:41:15] were to take this offline, there's otherformational sections that come after it. Um but basically we're going to start asking um some questions. Uh the first question that we're going to ask it and I will jump right to it because a lot of

[1:41:33] this documentation we've already went over is if you remember from the beginning we had our different personas right we had sort of our our who we called our Danny which is the floor technician right and they might have a

[1:41:47] question like hey for this VIN with this specific code that I'm getting what fix what have we done that has fixed this on similar vehicles. Um, and the motivation behind this, right, and behind a lot of the data is as an auto repair shop, you

[1:42:04] want to minimize your um, comeback ratio, which is basically how many times a customer has to come back because, you know, the fix didn't work, right? Um, and so the data, especially on the warehouse side, will show um some of

[1:42:20] that history combined with the documentation on the actual parts and the recalls and the bulletins. So, what I've done here is similar to the gentleman's questions before, I uh I have it explained the steps that it used

[1:42:35] for the different shapes. You can see it's loading um the auto server skill. So that was the um the skill that we have here where we've also contains all of the scripts we've been working with. So the outline search and theme script

[1:42:50] it has access to as well as the run SQL and the MCP server. Um that was this skill that we were talking about before. So I've pre-written that for this. You can read it um if you like, but it basically gives it um some general

[1:43:05] guidance on how to access the warehouse and also deal with the different shapes in the command interface. And you'll see what it will do here. Um it will look for the document code. It'll do a full text search. It'll use

[1:43:22] the tree shape here to find cross links and causes. Um and then it will get the join paths. Um, and it will actually do the query for the VIN. Um, and when it does that, it will go ahead and come back with basically the part number that

[1:43:41] needs to be replaced. And in this case, there was like an old ignition coil that got revised that it had to replace it with. Um, so if you look right, it at first it did full text search to sort of ground uh the document with the right

[1:43:55] code. Um so it looked for the code and also the misfire or rough idle. Um it found uh the uh top hit which is this engine type. It confirmed its grounding. So it shows the links from that uh manual over to these different

[1:44:14] procedures. And then from there it did a join path. Um it basically looked at all the work orders um with that DTC code uh for that part. Um and then it was able to bring back the ultimate question which is like you know from all the

[1:44:30] parts that were replaced and how we dealt with that code it went to the warehouse to grab that information. So you can see like this is a simple question. So if you were using vector search and like Genie, like their AI search and Genie

[1:44:44] and like data bricks, you could do this, but what often happens is to to basically find what it would need to do that linking on that tree shape, it would have to do much more vector hits, which each of those is is a chance,

[1:44:58] right, for this to run into an issue and not find the right document or potentially hallucinate and get something on a misfire that maybe wasn't n't related to that specific part, but because it grounded in the tree shape

[1:45:11] and everything, it was able to to get the right information and then link that back to the table. Um, and so it can be helpful and it can help with efficiency in these smaller questions. Um, but then what can happen is when you get to the estate level

[1:45:28] questions is where it can get really interesting. So, I'm going to go ahead and just copy this question and I'm going to let it start running. Um it seems like claude is moving faster now which is good but I'll talk about it as

[1:45:40] it's running. So this is a question around hey are there mismatches between our documented procedures and problems that we're seeing in the field and what documents are missing or sort of on the other half like what documentations are

[1:45:55] we not leveraging at all inside of our warehouse data right because we have our documents which tell us about like the recalls and the bulletins and and all this sort of stuff um and the manuals but then we also have the work order

[1:46:07] history from our warehouse and so this is a question that someone in a supervisor role or someone in an analytics role might be interested in, right? Because it's sort and it's sort of like proving a negative or a mismatch

[1:46:21] because you're you're sort of saying like, you know, I I don't know what I'm looking for. I'm looking for a gap though. And you can imagine that with a tool like vector search, this would be a very hard question because sim or any

[1:46:35] type of similarity or lexical search because like if you're just doing that alone by definition, you're search you can't really search for a negative. You have to search for things that are there. Um, and so what I found and I

[1:46:47] think what we found as a company is that graphs can be very useful when you start having these more global types of questions, these estate level questions that you want to ask, particularly if they're around patterns where you might

[1:46:59] not even know what you're looking for yet. Yes. And so this one takes a while to run because it at at a certain point here, it does have to take a large number of codes and join some data together. Um, but you'll see at the end here,

[1:47:17] it'll it'll kind of uh trickle in and it it'll it'll tell you how it went about finding everything. Um, and oftent times what you see with these, it'll it'll use some of the document data with some shapes and then it will go back and it will go back to

[1:47:32] the warehouse and query from there. um run through a lot of different things here. Um, another thing just to just while it's working on that, I did tell it here for sake of clarity to not use the near forjly. And the reason that I I have

[1:47:55] that here is so that you can see it using the um the different shapes. Um, just for sake of understanding how the different shapes kind of fit together and work. Once you hand your agent the Neo Forj CLY um it becomes very powerful

[1:48:12] because it can start writing custom cipher queries and there will be instances where it'll prefer doing that over some prefix shape. Um, and I'd say that as our sort of Texas cipher capabilities and as we keep building up

[1:48:25] more skills, it'll start to prefer more free form Neo forj Cly stuff uh much more frequently. And this one can sometimes take a little while to work through. So, I'll give it a another 20 seconds or so. Or maybe I can even open it up to a few questions

[1:48:43] while we're here. While we're waiting for this one. Yep. So, basically what it's going to do is it's going to look at the um well, I actually have to have it come back and remind me exactly how it um how it goes through. Um but basically

[1:49:16] what you can see from the work orders what has been worked on right and then you can sort of take the codes from there and see what documents it has been using. Um and then there's also going to be high comeback history on using some

[1:49:31] of the wrong parts. And so you sort of get this view of okay well there's a bunch of documentation that we're maybe not hitting because we're getting all these comebacks from like using potentially the wrong part. Um so then

[1:49:44] there's that half of it and then there's some um documentation that we have um that's just not covered because we're using DTC codes that's just not covered inside of the warehouse. So we'll know that like certain documentation hasn't

[1:49:57] really been hit at all. Um, so here it actually took a little bit more of a um, and it will do this sometimes. Here it used semantic expansion. Um, so it actually went in and did a much more comprehensive um, semantic expansion search. It's supposed

[1:50:18] to in this case use the outline. I think because it had the hierarchical URI um, it was probably able to do this a little bit better. Um but if I go back up um where did it show? Um yeah it well it was able to show here

[1:50:37] the field codes essentially um that it was missing. So um there was basically two field codes um that got a um yeah the headline mismatch or diagnosed with the wrong procedure. Um, so there's basically this mismatch um where a couple of these parts

[1:51:03] on the library document. Yeah. So there where the correct repair isn't um referred to basically. Um and that's causing a problem for the warehouse. Um and then there's other um DTC codes that occur in the field. Exactly. that have

[1:51:20] two um that have no code level documentation which are these two. So there's codes that are occurring which basically aren't documented that it was able to find. Um it's a shame here that it didn't use the outline it's supposed

[1:51:31] to do that because basically when it uses the outline it's able to traverse through and find all of the links a little bit more efficiently. It wouldn't have done the comprehensive full text search crawl that took it a while in

[1:51:44] this case. Um, but even here because it had the hierarchical URIs and that semantic expansion on the um, full text search, it was able to eventually find it. Um, but it's a good lesson that when it does use the outline, it can come

[1:51:58] back faster because it can traverse out on the different links. Um, the other thing here, the last one that I'll run because we only have eight minutes left. Um, I'll go ahead and copy it here. Um, and this one is primarily,

[1:52:13] if I go ahead and copy it, um, is going to leverage our, uh, theme shape. So, um, this is asking for common patterns across all our bulletins and recalls um, and how many of the cars sort of each affects. So, we have our work order

[1:52:32] history inside of our uh, warehouse. And uh basically what we want to find out is like which you know how does the sort of themes that we have correlate with um our work order history. Um and to do that it runs that theme pattern to

[1:52:50] be able to pull out the highle themes and then correlate it back to our work orders. And so it's a coverage question. So you can see it'll run the themes and then um eventually here it will go ahead and bring back um all of the all the relevant information.

[1:53:14] But basically what it's doing is it's it's finding the themes. It's going to go and pull sort of the types of fixes that it has in the work order history and then it's going to do a join of sorts to kind of group them under the

[1:53:27] right theme. While this is running, are there any other questions about this theme shape or anything? I know other people there's Yes. Go ahead. >> Sorry. Say that one more time. how during the graph construction. >> Yeah.

[1:53:57] >> Yeah. So the shapes that I that I are actually defined inside of our specs. So if you go here, our outline shape um our specs in our docs. So this was defined more thinking through like here's what we want it to look like for

[1:54:14] the agent. And then once we define that, we come up with sort of the query structure that we want and we use that to inform our data model. Um, and all of the documents were loaded essentially um into that data model that I went over

[1:54:28] about an hour and a half before towards the beginning of the course. Um, it's that has containment tree with all the links between it. Um, and you can see here it'll um it'll bring back the um that it used themes. it didn't use search. Um, and then it uh

[1:54:51] also uh queried the um if I go up here, you can see the cars affected. So, it basically went to the warehouse with that connection shape um and it was able to sort of group them under um the different uh theme types. So, it's like

[1:55:08] that theme, the different theme types um that we have and then kind of with the cars and the work orders grouped underneath by percentages. Um yes, over here. >> Yeah, either one. Do do I have a sense of accuracy of how

[1:55:34] well these do when the knowledge bases expand? Um, for this I haven't run any specific benchmarking on like exactly what I've shown you today. But I will say that when we do have customers that run these, they'll often come up with

[1:55:47] their own custom ontologies and then they will run benchmarks uh that will basically say like how effective is this query pattern against you know ordinary vector search for example and you would use that to prove it out on on a

[1:56:00] specific type of data set. Here for this course this is more conceptual to understand kind of like the different shapes that you would use to help ground your data. Um, and it can always use work in terms of how you were to like

[1:56:13] build the skill, right? To make sure it guides through the right thing so it uses, you know, each step efficiently essentially. >> Are there any other questions? >> Yep. Yeah. >> Well, maybe I don't fully understand. So, you have um a connection point

[1:56:58] between between what? Between Yeah. >> Yeah. >> Yeah. No, we do not have so right now. So, now that I understand your question, the question is, is there a link between the connection structured data graph and the unstructured one? And there is not.

[1:57:28] In this case, it's they're completely unlin and the agent is sort of extracting, you know, a part from one or it's extracting like um yeah, basically like a code, right? And then referring back to the document. So, it's it's

[1:57:44] using that to kind of do its own join in real time. You could create that linking and that could be valuable for more deterministic mapping. Um here we didn't do it and the main reason I didn't do it was really for speed of getting started

[1:58:00] because I did kind of want to provide code that would be easy and also model agnostic. Um and this is that and then if you wanted to later create those connections or those links you could. Um any other questions? All righty. Well, thank you everyone.

[1:58:19] Hopefully that was uh informative. If you want to go back, the the workshop's available for you to take, it's it's online. I am going to have to take the anthropic key and the big query down eventually. I'll I'll leave the

[1:58:34] BigQuery one up uh for a while, but the anthropic one I'll have to eventually take down. So, unfortunately, you will need to provide your own key, but other than that, you should be able to take it just fine. Um, and I think that's all I

[1:58:47] have. So, I'll leave it for my next guest. Hopefully you guys have enough time to jump into your next session. >> [music]
