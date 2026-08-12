---
video_id: AMiyLItEtLA
title: "fighting slop with slop — Vaibhav Gupta, Boundary"
channel: "AI Engineer"
channel_id: UCLKPca3kwwd-B59HNr-_lvA
channel_slug: ai-engineer
url: "https://www.youtube.com/watch?v=AMiyLItEtLA"
upload_date: 2026-07-31
duration_s: 1292
duration: 21:32
view_count: 5095
like_count: 162
subtitle_lang: en-orig
transcript_source: auto
transcript_words: 4029
ingested_at: 2026-08-06T11:00:33.824Z
ingest_version: 1
---

# fighting slop with slop — Vaibhav Gupta, Boundary
**Channel:** AI Engineer · **Uploaded:** 2026-07-31 · **Duration:** 21:32 · **Views:** 5,095  
**Watch:** https://www.youtube.com/watch?v=AMiyLItEtLA

## Description

You cannot tell great engineers what to do, and you increasingly cannot tell what an agent did either, so Vaibhav Gupta's answer is to fight slop with slop. At Boundary the team turns the same cheap, sloppy generation loose as a tool: agents that run constantly over the transcripts of other agents, flagging hallucinations, spotting which tool calls produced errors, and comparing which approaches produced fewer. He pairs that with hard invariants, the design docs, rules, and CLI checks that do not change for months and tell you exactly where a codebase stops converging, so the messy detection layer sits on top of something stable.

The deeper move is to attack the foundational layer from first principles. Instead of trusting generated code, he leans on type systems that make whole classes of mistakes impossible: types get inferred without you writing them, a division by zero is guaranteed to be handled or the code will not build, and there are no silent unknowns left for an agent to guess at. That is the bet behind BAML, which lets you work across Python, TypeScript, or Rust with strong boundaries around each function so an agent can move fast inside walls it cannot breach. His closing challenge is to go build these sloppy tools yourself and constrain the systems underneath them, because that is what actually wins the war on slop.

Speaker info:
- https://x.com/vaibcode
- https://www.linkedin.com/in/vaigup
- https://www.youtube.com/@boundaryml

Timestamps:
0:00 - Fighting slop with slop
0:27 - Code reviews and invariants
2:08 - Building rules that don't change
3:00 - Design docs with notifications
4:03 - CLI tools that catch where things break
5:08 - Agents reading agent transcripts
5:57 - Detecting hallucinations and errors
9:24 - Attacking the foundational layer
11:03 - Execution traces from first principles
14:26 - Type safe tools across platforms
15:42 - Making whole error classes impossible
17:57 - BAML across languages
20:37 - Go build the sloppy tools

## Chapters

- [0:00](https://youtu.be/AMiyLItEtLA?t=0) Fighting slop with slop
- [0:27](https://youtu.be/AMiyLItEtLA?t=27) Code reviews and invariants
- [2:08](https://youtu.be/AMiyLItEtLA?t=128) Building rules that don't change
- [3:00](https://youtu.be/AMiyLItEtLA?t=180) Design docs with notifications
- [4:03](https://youtu.be/AMiyLItEtLA?t=243) CLI tools that catch where things break
- [5:08](https://youtu.be/AMiyLItEtLA?t=308) Agents reading agent transcripts
- [5:57](https://youtu.be/AMiyLItEtLA?t=357) Detecting hallucinations and errors
- [9:24](https://youtu.be/AMiyLItEtLA?t=564) Attacking the foundational layer
- [11:03](https://youtu.be/AMiyLItEtLA?t=663) Execution traces from first principles
- [14:26](https://youtu.be/AMiyLItEtLA?t=866) Type safe tools across platforms
- [15:42](https://youtu.be/AMiyLItEtLA?t=942) Making whole error classes impossible
- [17:57](https://youtu.be/AMiyLItEtLA?t=1077) BAML across languages
- [20:37](https://youtu.be/AMiyLItEtLA?t=1237) Go build the sloppy tools

## Transcript

[0:01] [music] >> Fighting slop with slop. My name is Vaibhav and I'm going to talk about something that is a little I would say maybe a little silly at first. I'm going to show you our team's engineering practices really quickly.

[0:26] We do no code reviews. We require every engineer to work on things in parallel. And we have no standardization on how people do AI. And I know immediately what almost all of you are thinking. We're probably a Zoomer YC startup.

[0:41] And I can guarantee you I'm clearly a millennial. So what do we actually do at our company without code reviews? Well, we built about 3 years ago we decided to build a programming language. That's something that has absolutely no

[0:54] room for slop. It's something that has to work every single time exactly the same way. It's something that you can't just change a year later or a month later because you made a bad design decision. You have to be correct. And for last 3

[1:07] years we've been in an onslaught of war against slop. And when I first met this enemy, I went to my great mentor. Slop Sue. And he taught me something. To to defeat the slop, we must become the slop. So we began and we prepared and then we

[1:26] started winning. So when we think about it, what is slop? Slop is just any code you don't read. And whether any of you admit it or not, this is the least amount of slop that your code base will ever have. Cherish it. So we started fighting back against the

[1:42] slop and we started fighting back with slop. So how do we go ship a stable programming language with these engineering practices? Well, the first skirmish we ever had was a skirmish of standards. The hard part about hiring great

[1:56] engineers is you sadly can't tell them what to do. Some of them want to use Claude, some of them want to use Codex, some of them want want to use the latest thing that they just found on Hacker News. So, instead of trying to hold standards

[2:06] in our codebase, we did something that is an invariant. We built an architecture.md file. Instead of using Claude.md, just pick something that every model can just understand. This file has to be incredibly small, and it can only have

[2:20] things that will not change for months or for years. In our case, it's the layers of the compiler. You go deeper into the compiler, tell the agent to just talk to at least one other person. That slows it down a little bit.

[2:33] So, now we have standards, so anyone can use whatever they want. But, the real foe we faced was actually the battle of design. Everyone here knows that you have to write perfect design docs. And we have a very simple rule in our team.

[2:46] Code can be slop, writing cannot. And of course, if I tell every engineer this, they write beautiful writing, and they handwrite everything, they don't use AI. Well, sadly not. So, we built a design tool design doc tool. What this design doc tool does,

[2:57] it's a replacement for both Notion and GitHub effectively for design docs. It will have versioning, commenting, all the stuff you want. And obviously, we do this, people use this. Well, sadly not. We built another tool on top of that.

[3:09] And this tool was a Slack integration for that tool. Every time a design doc got updated, this channel got notifications. And what ended up happening is this channel became the most popular channel in our company really fast. At 2:00

[3:18] a.m., someone shipped a new design doc, three people started reading it right away cuz it's just interesting. Then, most interesting stuff is design docs that are not going to change. But, this wasn't enough. All of this is actually backed by

[3:30] Markdown files and simple CLI scripts that make it treat like GitHub without being GitHub itself. So, now agents can go do this. But, the real problem with all this is I built this, and I hit a little bit of AI psychosis, and I started shipping 10

[3:43] design docs a day, and soon the team was fighting my slop. So, we had to go and back at the last rule. This last rule was, if you're going to ship a design doc, you require people to actually go read it. And with this last standard, we suddenly had

[3:56] design docs that were incredibly high quality. But what about the battle of architecture? You how do you have your code base converge? We built another tool. This tool basically visualizes our dependency graph internally with some external

[4:08] dependencies as well, and allows us to watch the code base change. It has semantic boundaries, individual packages, but what's more interesting is we can go build CLI tools that guarantee that certain invariants can't be broken.

[4:20] And what this does is when Claude builds a new package or adds a dependency that's leaky, we now have CI/CD changing or a simple Git commit history that tells us exactly where things break. And by this, we're actually able to make our architecture

[4:33] change. We haven't changed our architecture in the last three or four months. But as much as we might do design docs, and as much as we might have stable code, would you genuinely ship code without reading it? Would you trust your

[4:45] team to go do that? And think about a programming language. A programming language just so many invariants. You have generics, you have closures, you have memory allocation, you have FFI boundaries. Could you trust that system?

[4:58] Python has bugs 25 years later. Well, here's where we did something slightly different. What we did was we built a system that actually has agents constantly running and creating BAML programs. We take these BAML programs.

[5:15] 1 second. And we have agents try and spin something up from scratch. We then look at the entire Claude transcript, see what tools it used, see what happened, and obviously we as humans can inspect them. But more importantly, we can have agents

[5:28] go inspect them. And agents find what was good, what was bad. And not just what was bad in terms of what was incorrect in the language, but what took three tool calls when it should have only taken one. And then we can go ahead and find

[5:40] issues, and we can have humans collaborate with these issues to figure out which ones are real, which ones are hallucinations, which ones aren't don't have taste, as much as I hate to use that word. And then we can have agents go ahead and

[5:50] create fixes to these problems and go to address them. And most importantly, instead of trying to just detect these issues, we can go one step further. What if you could find language features and instead of guessing what was good,

[6:03] guessing what skill was good, you could go and AB test it. You could figure out which ones took less tool calls, which one took uh which one made less errors, which one produced the correct outcome and deterministically know

[6:15] what's going on. The point is you can start building data-driven systems without ever writing a single line of code. And the thing that really I care about the most over here is not that any one of these tools is specifically what you should go build.

[6:30] But the fact of the matter is in order to build a programming language, it wouldn't have taken eight people. It wouldn't have taken less than two years. It would have taken hundreds and thousands and tens of thousands of

[6:41] man-hours and then you would still have a broken system. And today we can just spend millions of tokens and make it work. And we can make it stable. And you could you two can go home and build these internal tools and these

[6:51] sloppy tools to make sure that your code bases can ship without really having to read necessarily every single line of code. Cuz your engineers aren't going to. And I think we can start winning this battle against slop. And as we win this

[7:05] battle, slop can be defeated. But sadly, I have a sad thing to say. I think we're still going to lose the war. I think the reason that we're going to lose this war is because some of the foundational stuff that we try and go use itself is broken.

[7:22] How many of you have used TypeScript? Probably most of you hopefully at this point or at least your agents have, so something around there. Um did you know that TypeScript's main design goal is to strike a balance between correctness and productivity?

[7:36] And there's an asterisk here because what they really mean is human productivity. And if you think about it, there are things you would never do in a programming language at the very core layer if you were designing for in a

[7:48] world where humans never wrote a single line of code. Let me show you what that really means. I'm going to write something and try and guess what this code does. Pretty safe. What about this one? Or even more so, this one. Why do we turn things to

[8:12] strings when we sort them? This is just slop baked into the language, whether you like it or not. What about this? I love this part of TypeScript. And you know what my agent loves? This part of TypeScript. This is slop baked into the language.

[8:33] And whether you like it or not, the systems will have slop if you build using these tools. Oh, I'm sorry, wrong talk. But, if you think about what JavaScript does, JavaScript exists, and then after JavaScript existed, we started building

[8:52] systems to layer it on. We built CoffeeScript, then TypeScript, and now we're trying to build a fact. But thing is, the thing underneath is already broken. And more so, the way we write code is also different now. So, why are we trying to patch something

[9:07] like this? Why don't we just try and do something a little different? And I think what we might need if we try and go do that is basically going to be a made-up language. So, let me show you what BAML really can do. And when you start thinking from

[9:20] first principles, how you can try and combat slop from the very foundational layer itself. I keep talking about not reading code. Does it even matter? Well, let me show you a new way to think about code. And this isn't to say we all

[9:35] have to go do this right away. But, what if every single time I look at code, whoops. What if every single time I look at code, what I really saw was not the code itself, but a quick little thing that could actually visualize all the

[9:56] code for me. As I clicked around, it took me to exact lines of code that was linked to. If I wanted to have a slightly broader view, I could zoom in and click around and have it expand. I could navigate my code bases more interestingly.

[10:10] I'm going to let this run really quickly, but while it runs, I'll show you a different pipeline. Without any of you ever reading the code, you know I'm setting up stuff and I have an agent loop because the semantic boundaries in there. I can

[10:19] expand this. I can keep expanding this and I can say, "Nope, that's too much slop. Let's let that be slop." And walk away. So, instead of having to understand all the code, I can opt into what parts of the code I want to read and understand

[10:31] and go to the exact lines when I really care about them. But, if we go back to the previous pipeline that was running, what if while it's running, I can actually get a full execution trace? In a world where we don't read all the

[10:42] code, the only way to understand the code is actually by the execution trace. And actually by seeing exactly how much time was spent on what parts of my program at any given time. If you want to go and actually track your program through, think about how

[10:55] slow your program would be if you have to go trace everything in Python or TypeScript. It's untenable. And the best part here is if you start from first principles, you can make this effectively zero performance cost. Not only can we make it great for

[11:09] humans, but because it's all built for agents anyway, you can go ahead and make it so that every single file has a tracing system that Claude can navigate through. So, Claude can find what were bugs, what were errors, and what were inefficiencies and start

[11:21] optimizing your code without you having to do it yourself. And I think if we go start thinking about it from this way, it's not so much about reading all all code, but it's more so about us human understanding the system that you're

[11:33] working with. And the tools that you can build can give you information about the system that you're working with. But, I think there's another layer to it. We've spent decades building IDE tooling. And that Think about how long

[11:47] it took before someone like me who does not know how to escape Vim to this day can finally start using VS Code. It was a beautiful day when that happened. I became a real programmer. Well, according to some people, I'm still not cuz I can't write Vim code.

[12:02] But, what does agent-first tooling look like? I think we're all familiar with grep, so I'm not going to go and talk about it. But, I will talk about Ripgrep cuz grep should not be used anywhere. If I want to grep through my code base

[12:18] and understand what it was, I would Ripgrep say something like calculate, and it'd give me a bunch of code where everything was being used. And maybe it'd be somewhat useful. But, what if you could instead start describing code and say, "Can you

[12:32] describe calculate for me?" What if it came with all the docstrings? What if it came with the actual source code? And what if it also told you everywhere it was actually used under the hood? We can make something that used to be

[12:44] multiple tool calls a single tool call all of a sudden. What if the way you want to learn about libraries that you're using, instead of having to go to a web search, you just said you did you could just ask for any external library as well.

[13:00] And it would just give it to you. Because when I first started learning how to code, one valuable lesson I had was the code is always the source of truth. Don't read anything but the code itself. The docs may lie, the um

[13:12] the actual description or architecture file or readme file will definitely lie, but the code cannot lie. Except if you're working on some weird architectures. And then when you go down this road, you go from not reading the code to

[13:24] understand the architecture. You go from not searching the code to understanding exactly what you're getting in every one tool call. But, what's the next thing you do? Well, the last thing I do to truly understand code is I run the code.

[13:36] So, what if every single thing you ran, every single function you ever wrote was immediately available And I'll pull this code over here. Was immediately available as a simple CLI command. So, if I run add, add becomes a CLI command that has A and

[13:55] B parameters attached to it. And I can just run it really quickly and see what happens. What if every single CLI tool I had could be packed into a live into CLI that's completely standalone. Multiply. That I can just run without ever having

[14:13] to actually execute any of the code. And it's now a total CLI binary that has functions just bundled in. Suddenly, we can build really quick tooling where agents don't have to go grep through what's happening. Everything is type safe, everything is

[14:28] deterministic, and everything is actually guessable. And the best part is imagine you could build on any system, and your agents don't have to worry about deployments across Windows, Mac, and Linux. And you can just target any layer you want, and it builds

[14:42] for any architecture, including WASM systems. All of a sudden, as an engineer, you're super charged. You're no longer bottlenecked by what you can do in the systems underneath you are preventing. You can just move very fast. You can

[14:53] move at agent speed. But, a lot of the stuff that I've been talking about to this date has been about tooling. What if we try to fix some of the real sins of JavaScript? Some of the stuff that is deep in the language. Not the

[15:08] sort stuff, but I mean more important stuff, like errors. Have you seen error handling be beautiful ever, other than Rust? Um what I see agents do over here is you do try catch, and then they keep nesting try catch after try catch after try

[15:23] catch. And eventually they give up and say console.log some error happened and deal with it. What if we could do error handling from very first principles? What happens in that world? Well, I showed you add, multiply, subtract. I didn't show you divide.

[15:38] Divide is dangerous. It's spooky. So, let's go look at divide. You can see over here, divide throws a division by zero error. But, what else happens? The function actually knows that it throws division by zero error. Without you having to write any any

[15:56] code. If I go up to the calculate function, which at some point calls divide, this function also knows it throws division by zero error. So, error types now get inferred without you ever having to do any guesswork. That means if you catch or handle

[16:12] errors, we can do exhaustive guarantees, and the compiler can prove that you have handled the error or not handled the error. It's no more guessing. There's no unknowns. It's guaranteed to be proven. So, if you wanted to ship an API

[16:27] where it guarantees that it never throws, well, this system is broken because it doesn't meet the constraints. It has two errors that you're not throwing. If you wanted to go catch that, well, I can write the code for that in a

[16:39] second. But, you can start catching certain errors. Uh I mean, I'm just going to return a sentinel value for now. And now this parse thing, which previously threw division by zero error, is now guaranteed to no longer throw the division by zero

[17:00] error because if I catch any exceptions in here, I return a zero value every single time. The compiler and the tooling can do a lot of work for us. And we're already used to this in our codebases. We many of us probably don't know how compilers

[17:12] work under the hood, and we trust them. Code is a matter of trust. The reason that we don't use ML code blindly is because we don't trust it yet, cuz the systems underneath them don't have enough rigidity. One more thing.

[17:28] But before I tell you all to go write a bunch of ML code, cuz I've been there and I can tell you what someone tell me if I said, "Hey, use this new programming language. It's going to solve all your problems." It's just going to become come with

[17:41] a whole slew of new problems. So, we said, "I think we'll lose the war on slop if we try to ask everyone to rewrite all their code in the world into this new system." So, what does a solution like that look like where you don't have to rewrite all

[17:55] your code? Well, we What we started to do was we started to think about that about 2 years ago. And we said, "What if you could use ML not just stand-alone like I showed today, but from within any existing language of your choice? From Python to TypeScript

[18:11] to Rust to Go to Ruby to Java to anything new that comes up even after it." What if every function in ML is immediately accessible in the language of your choice? So, in this case, I'm calling the ML calculate function directly from Python, and it's

[18:26] completely type safe. Not only do we get calculate, we get calculate async in case some of us want to write async code. So, ML while it has no function coloring, it does give you the benefit of having to do whatever you

[18:37] want across your code. But what if you went a little bit sillier? What if you started passing around lambdas across language boundaries? I have a function here called with timeout. This function times out after a certain number of milliseconds, and if

[18:55] this work doesn't complete. And it's guaranteed to no matter how long it takes. Well, in that world, you can even pass Python lambdas across the bridge. You can pass generics across the bridge. You can pass closures. It should just work,

[19:08] so engineers don't have to go fuss with it. And more importantly, so when the agent does something, the type system never lies. The type system becomes the absolute center of truth that prevents invariants from entering your codebase.

[19:22] And what I really wanted to talk about today was not any one specific thing. But it's this general concept. You can build incredibly complex systems without traditional systems like code reviews. You don't You can work in things in

[19:35] parallel, and you can use AI however you want without requiring any sort of standardization. But the most important part is you have to be incredibly thoughtful about how your engineering team actually uses the systems under the hood.

[19:47] When we started building BAML, I didn't think it would be possible to build some of the software we did. And just yesterday one of our engineers built a partial C compiler purely in BAML. So, when I start pushing the boundaries

[20:00] of these systems and you stop reading the code, in some ways in my mind, it releases the floodgates for your engineering team to actually cover the gaps of what existed in your old process. Have you ever worked at a company that had no CI/CD? They said

[20:13] adding CI/CD would slow us down. They They do slow down for 3 months while they add it, but after that, they move a lot faster. Our processes have to evolve if we're going to ship at agent speed. And remember, this is the least

[20:26] amount of slop your codebase will ever have to this day. So, just embrace it and start fighting it back. I fell in love with software about 15 years ago, and it was the first thing that truly changed the way I perceive the world.

[20:41] And I really genuinely don't want slop to win. And I think we can all build a world of beautiful software. And I think what it takes is I want each of you to go home today and build these sloppy tools. Make your systems more

[20:52] robust. Make your processes more robust. And then for the bravest of you, I want you to go back and think about these core foundation layer systems. Think about how they're broken and see if you can imagine a way to fix them. I

[21:04] think we do need a new Git. I think we do need a new database, and yes, I think we need a new programming language. I'm Vaibhav, and I work on Bemo. Thank you.
