---
video_id: pdoSAWWCDO8
title: "Claude Design Full Breakdown: GitHub Imports, Skills, and Local Model Handoff"
channel: "Jake Van Clief"
channel_id: UCPR4DV8qMQVs_YBa-CQZQBQ
channel_slug: jake-van-clief
url: "https://www.youtube.com/watch?v=pdoSAWWCDO8"
upload_date: 2026-04-20
duration_s: 2549
duration: 42:29
view_count: 11937
like_count: 375
subtitle_lang: en-orig
transcript_source: auto
transcript_words: 8568
ingested_at: 2026-07-25T15:24:26.282Z
ingest_version: 1
---

# Claude Design Full Breakdown: GitHub Imports, Skills, and Local Model Handoff
**Channel:** Jake Van Clief · **Uploaded:** 2026-04-20 · **Duration:** 42:29 · **Views:** 11,937  
**Watch:** https://www.youtube.com/watch?v=pdoSAWWCDO8

## Description

Join my Community to learn more! : https://www.skool.com/cliefnotes/about Join my Skool community Clief Notes for full classrooms on folder structure, AI workflows, and the history of software engineering that makes all of this make sense: [https://www.skool.com/quantum-quill-lyceum-1116/about] 

Local Models : 
https://huggingface.co/Qwen/Qwen3-Coder-Next
https://deepmind.google/models/gemma/codegemma/
https://mistral.ai/news/devstral
https://github.com/deepseek-ai/DeepSeek-Coder-V2

Claude Design tutorial covering how to build a full brand design system, import assets from GitHub and Figma, export the folder structure, and run the same workflow in Claude Code or a local open source model. If you want to use Claude Design without burning through your usage limits, this is the workflow.

Claude Design is Anthropic's new design tool built on Claude Code, skills, and folder structures. In this video I walk through importing a full GitHub repo of brand assets for my company Eduba, generating a design system with custom skills, reviewing the output, and exporting it as a zip I can open in VS Code or Claude Code. I also cover local AI coding models like Qwen 3 Coder Next, Code Gemma, Devstral, and DeepSeek so you are not locked into one provider.

Topics covered: Claude Design workflow, Claude skills explained, folder structure for AI agents, exporting to Claude Code, local AI models for design, Remotion for animated videos, Obsidian for file navigation, and how to productionize your design opinions so AI amplifies your work instead of replacing it.


TIMESTAMPS

00:00 Claude Design intro and what this video covers
01:15 Usage limits on the Claude Max plan
02:40 What you can build with Claude Design
04:00 Why your own assets are the real power
05:30 Starting a project in Claude Design: wireframe vs high fidelity
07:00 Claude skills explained and where to find public skills on GitHub
10:00 Skills are just markdown files
12:00 Importing assets from GitHub, Figma, or local folders

## Chapters

- [0:00](https://youtu.be/pdoSAWWCDO8?t=0) Claude Design intro and what this video covers
- [1:15](https://youtu.be/pdoSAWWCDO8?t=75) Usage limits on the Claude Max plan
- [2:40](https://youtu.be/pdoSAWWCDO8?t=160) What you can build with Claude Design
- [4:00](https://youtu.be/pdoSAWWCDO8?t=240) Why your own assets are the real power
- [5:30](https://youtu.be/pdoSAWWCDO8?t=330) Starting a project in Claude Design: wireframe vs high fidelity
- [7:00](https://youtu.be/pdoSAWWCDO8?t=420) Claude skills explained and where to find public skills on GitHub
- [10:00](https://youtu.be/pdoSAWWCDO8?t=600) Skills are just markdown files
- [12:00](https://youtu.be/pdoSAWWCDO8?t=720) Importing assets from GitHub, Figma, or local folders
- [14:00](https://youtu.be/pdoSAWWCDO8?t=840) Using an existing animation code base as a starting point
- [17:30](https://youtu.be/pdoSAWWCDO8?t=1050) Uploading company PDFs and documents for context
- [19:30](https://youtu.be/pdoSAWWCDO8?t=1170) Building a custom design system from scratch
- [21:00](https://youtu.be/pdoSAWWCDO8?t=1260) Why designers will get the most out of Claude Design
- [22:30](https://youtu.be/pdoSAWWCDO8?t=1350) Watching Claude Design explore the GitHub repo
- [26:00](https://youtu.be/pdoSAWWCDO8?t=1560) Reviewing the generated brand system and style guide
- [28:30](https://youtu.be/pdoSAWWCDO8?t=1710) Voice and tone markdown files
- [31:00](https://youtu.be/pdoSAWWCDO8?t=1860) Productionize your opinion
- [32:00](https://youtu.be/pdoSAWWCDO8?t=1920) Exporting the design system as a zip
- [34:00](https://youtu.be/pdoSAWWCDO8?t=2040) Opening the folder in Claude Code locally
- [36:00](https://youtu.be/pdoSAWWCDO8?t=2160) Running the same project in VS Code
- [37:30](https://youtu.be/pdoSAWWCDO8?t=2250) Local open source coding models: Qwen 3 Coder Next, Code Gemma, Devstral, DeepSeek
- [39:30](https://youtu.be/pdoSAWWCDO8?t=2370) Obsidian for visualizing folder structure and mind maps
- [40:30](https://youtu.be/pdoSAWWCDO8?t=2430) Remotion for rendering animated videos locally
- [41:30](https://youtu.be/pdoSAWWCDO8?t=2490) Build systems that grow with time
- [42:00](https://youtu.be/pdoSAWWCDO8?t=2520) Closing thoughts

## Transcript

[0:00] So, you want to know how Claude design works? You want to know how not to hit usage limits? And you want to know, maybe is there a way to do it without Claude? Could you possibly use local models? What kind of assets do you want?

[0:11] I'm going to be going over a lot of that over the next maybe 20, 30 minutes. We'll see. It could be 40 minutes by the time I'm done recording these. I always record them in one shot. But I'm going to show you my experiments with it, what

[0:21] I've learned, and how I've built a process locally, as well as building one in front of you that mostly works. And we'll show you what that looks like here shortly. Now, starting off the bat, Claude design is a new app from Claude

[0:33] that essentially is a series of Claude code and folder structures, which if you've been following my work, I'm a big folder structure design guy. It helps you create all sorts of prototypes and processes. It create You can create

[0:44] slide decks. You can create entire areas from your own branding and literally download branding and logo processes. You can create animations from it as well, being able to go into I think I created one. Yep, just yesterday. You

[0:57] can create all sorts of different explainer video animations and stuff with just basic prompting and brand assets as well. I created quite a few videos the other day on this. Now, when you're actually using this, the problem

[1:09] is when you're inside of Claude, you can come down here. It has its own usage credits, and it uses it fast. I'm on the top max plan that you can have, and I went through almost the full usage in the matter of gosh, I don't even know, a

[1:24] day. We can come down here and actually look. Claude design, I just started using it yesterday, and it's already at 83%, and I didn't even use it that much to just test these features. So, what does it actually look like to maybe get

[1:37] around that? How do we not How do we use it best? How do we best get the best output out of it? But also, how do we maybe figure out better ways to use it? Well, right off the bat, let's just look at what you can actually do with it.

[1:49] Now, what I like to do, and where I think the most power behind it is actually taking things that you or maybe your designers have used. So, I'm going to go through and show you different assets that you can actually bring in,

[2:00] extract information from, and create a design system that allows you to create almost anything from those assets in a very controlled environment. Now, I have a large GitHub where me and my front-end developer K, who's awesome, have put a

[2:15] whole bunch assets, components, SVGs. Some he built custom himself in Figma, some with React, HTML, all sorts of different things, JavaScript, right? We have all sorts of different weird assets in here that we've built for my personal

[2:27] company, uh Aduba. But we also have Figma, right? I've made quite a lot of different uh assets and slides for workshops that I've been doing, and a lot of these are really good, and I want to keep them and use them. You could

[2:39] also, maybe if you had Canva, you can use this as a starting point, or even just slides and PowerPoint. You can extract assets from that, right? That's a whole area. But essentially, what you can actually do is you could just come in and create

[2:52] a new project, right? I created a new test project here where I wanted to create an animated video on the skills that it's using. Or you can just come in and say, "Hey, I want to create a slide deck very quickly." Or just a project

[3:05] that doesn't have a aspect here. Now, generally, when you start a new project, project for video, you have a the standard default design system. You won't see any other design systems. I'll show you what happens when you make your own, but for right now,

[3:19] let's stick in here. Now, wireframe is using a lot less tokens and essentially is a way to just look at what something might look like. High fidelity is actually building something. Uh and it will create a lot better outputs faster,

[3:32] but again, use tokens significantly fast. When you actually come in, it has a folder set up, much like something you would have on your desktop or with uh Claude code. And you immediately have specific skills. So, you'll see these

[3:45] things right here, interactive prototype, high-fi design, design system. These are all skills. These are prompt systems. And if you actually come in and want to add more, when you click on design system, you'll see skills that

[3:58] you can add. And for those of you who are familiar with skills, they're essentially large text files or maybe a little bit of code on teaching Claude how to use certain things. And I've shown in past videos, uh which if you

[4:11] want to check them out, how to access some of the best skills out there. Anthropic actually has their own GitHub where they show their skills that they actually publish. Not all of them are there. Uh you can come in and see,

[4:23] right? Let's say you want to go in, there's a front-end design skill that helps Claude or other AI. You can give these skills to any AI out there because of how they're designed. And essentially, all it is is a markdown

[4:34] file describing how to think about design. Before you're building anything, do these things. You can build your own skills all the time, but that's essentially what these are. Now, inside of Claude design, it's kind of the same

[4:47] concept here, right? You come in, and all of these are markdown files, maybe multiple markdown files depending on the order, how to convert stuff into PDFs, how to save things as an HTML. This allows AI to do the same thing every

[5:00] time, the best way. And actually, skills, while they upload and use tokens, can often save you tokens downstream if from it making errors or just getting you the best area. But right? So, if I hit use, boom, it adds that in there. All of these are just

[5:14] markdown documents, ideas, right? Create an animated video for this. Now, there is a lot more behind the skill that they're not showing there. If you were to actually lay this skill out, it looks like something else. I actually had

[5:26] Claude design create a design for that skill. I believe it was No, it was this test. And I was basically, "Hey, go ahead and create a page that explains your animated video skill." And it immediately did that for me, which is

[5:43] See if it's going to open up. There we go. And really beautiful, explained, "Hey, this skill basically turns things into a contained HTML page and breaks it down." And it makes frames for the animations, and it gives them examples

[5:56] of how to stage it, how to handle sprites, how to handle entry and exit times. Again, these are explanations of how to create a process. And those are what skills are at the end. Uh hopefully, for those of you who already

[6:08] understand skills, this wasn't annoying or boring. But that's important to know because design system Claude design is built entirely around organizing skills, organizing folders, and organizing components. Well, I have some older

[6:21] videos where I was doing this I think two or three months ago with my animations. Maybe I'll link it below or link it right here, where essentially I talk about creating animations with Remotion and Claude, and that organizing

[6:33] it in a folder structure allows it to create much better animations and save tokens. But we'll get to that here in a moment. Now, when you actually come in here, uh and you go and create this project, right? And you selected those.

[6:46] What you can actually do is import directly from GitHub, and I have my GitHub directly at connected. You can import Figma files, which is what I was just showing here. Or you can import just link a folder that you have on your

[6:58] desktop. So, if you've already designed a whole bunch of stuff, what I did for a prior video is not this one, but was actually for these. I already had been building animated videos for a client, and I already had a large code base with

[7:12] those videos and those aspects, right? So, if this is my local version of Claude design is a good way to look at it. I'm able to take my scripts and turn them into animations, and I'm able to organize them all. I already had component libraries. I had

[7:27] areas where you were able to come in and look at them. So, I think uh it was under this one right here. So, this was what uh a scene I had already created, except instead of using just HTML, I had used uh JavaScript and uh React

[7:41] essentially. Same concept, just different code. And this created various scenes for me to create an animated video, and Claude can read them, and so on. And if you really want to understand more about my folder structure, and you

[7:52] haven't already watched some of my previous videos, highly recommend it. I talk about building local folder structure and routing logic for Claude code or Codex or Gemini. Any agent that can read files can use this uh kind of

[8:05] context. It allows you to be a lot more agent agnostic. But anyway, I had already had this code base, so I just I didn't pull this whole code base in, but I went in, I found the animations that I liked from these videos, and I tossed it

[8:17] in there, and it was able to copy videos almost frame for frame, and then I could rebuild inside of it with new info. So, I uploaded a PowerPoint that had more brand assets in it, and I walked through and talked about it what I wanted, what

[8:30] those videos were. I even created a series of scripts and frames specifically around how I wanted the videos, and just pasted in. I said it a much more complicated version of this, "Based on all of those design templates,

[8:45] I need a video that does this based on this script." And oops. Imagine that I need a video that does this. Imagine this is a large prompt in itself, me describing what that video is based on this script. And then there's another

[9:02] file that has that script. And you can actually store those locally in here. Let me see if it'll let me I think this uh being at full screen makes this awkward. Let me come here. And so, you can see, Claude Anthropic is using a

[9:15] very similar folder structure than what I'm doing, and I guarantee you behind the scenes, it's very similar routing. And from there, it pulled in those components, those processes. It created themes out of those, and organized it.

[9:26] And these are my uploads. These are updates I'm working with an amazing company, NLP Logics. They're a machine learning company. Your guys are going to hear about them more if you're in my community. They're going to come in and

[9:36] talk. They've been doing machine learning since 2010. Love working with them. They are an awesome company. But they basically gave me PDFs, which I can't share because we have some, you know, important data that can't be out

[9:46] there like that. But a huge update on their finances, on what they're doing, where their work is, what they're trying to share. And this allows me to organize it a lot better. This could be the the for your company. If you have updates,

[9:57] PDFs, things, those can be contacts and ideas for your agents. Not just in design folders, but across any sort of flow. The idea is you're creating data in which the AI can build and expand off of. The better the core data it starts

[10:12] with, the more organized the data is, the easier it is for the AI to create what you want, what your alignment out of it is. But, anyway, that's something that I did there really great. But, what you really want to do, if you were starting from scratch and

[10:26] you were just diving in, what you actually want to go through, and if you know you're going to be using a system like this or you want to have a really core design system that AI can use well, you can actually come over here and you

[10:38] can look at examples of what people have done and how they've done it. And these are cool, but I'm going to be honest with you, they're very basic. They're just kind of cool stuff. They're not compiled together for business outcomes.

[10:48] You want to have repeatable processes that allow you to support a business outcome like creating slide decks because you get paid for it or maybe working together and creating animated videos that support your YouTube channel so that gets more

[11:01] marketing or if think of a thousand things, maybe even internal documents, making it easier to share internal documents. Well, you want to actually build your own design system. Now, it's immediately going to look a little complicated when

[11:13] you come in, right? Let me go back through this. You You're in Claude design, you come to design systems, you can come over and you can actually hit create new design. You probably won't see any of these here, right? And I'm

[11:24] going to have probably a hundred messing around with this in the next month, but we'll see how much usage I can get out of it. But, you can hit create. When you hit create, you can talk about your company, what it is, the name there. I actually

[11:35] just skipped that entirely and this is, again, a series of components and branding. It's a more complicated version of Figma files or Canva, right? We have the actual codebase of all of these. And I'm actually going to create a new design

[11:48] system cuz this is a cleaned-up one that we took from our original codebase that I used to create a brand system designed specifically for Claude to read and look at around our brand because we realized that that would make it way more

[12:01] efficient and it would use a lot less tokens. So, I can actually come in and just link that GitHub here. And I can hit add. Now, you're going to need to connect your GitHub, if you have a GitHub page, to it to give it access,

[12:14] but it's as simple as just it'll say connect right here and you'll just log in through GitHub, just normal process there. If you're not doing that, you can just drag a folder from your computer. So, if you download your codebase or

[12:26] whatever it is that has your assets, you can just upload it. Again, you can download a Figma file, right? Come in, and this is what's cool is that you can spend the time in Figma. Figma's not useless anymore. Everyone's like, "Oh,

[12:37] Figma's gone." Now, I get to come in and design exactly what I want down to the very specific thing. This is my older brand. We're not like this anymore, but I get to be the person that I want my design. Then, this design can then be

[12:49] downloaded and amplified exponentially by some systems like this. And that's where the real value is. You want to go in and spend the time making your first draft perfect, exactly what you want. All the assets are exactly how you want

[13:02] it. Then, you give it to this tool system. You do the creative process and it will amplify it into all the different versions that you want, which you'll see here. You can add fonts, you can add Figma files. In fact, I think a

[13:14] designer, someone who's been a designer, will use Claude design better than almost anyone else. But, if you don't have a design background, that's okay. You can still throw this stuff in there. You can also add some notes, maybe some

[13:24] nuance there, but again, just to show you the power of this, I'm just throwing my GitHub library in here. I'm going to go ahead and hit generate. Now, it does take some time, so I'm not going to make you wait. I know that my

[13:36] GitHub is going to take a lot longer than 5 minutes because of how much we have, but let me explain to you while it is doing this. Don't worry, I'm going to cut here shortly. It's going to immediately explore that GitHub. And so,

[13:47] what it's going through is it's read me, it's understanding the fundamentals, it's going through and it's seeing the files that we have. Oh, you have assets and SVGs. What does that SVG look like? What is it there? Oh, it's this little

[13:58] corner thing that we use, right? The more specific you can get with your codebase on assets that you like, that is your brand, and this is huge for enterprise companies, the better Claude will be able to generate something from

[14:10] this. Maybe we have animations that we're using on our website. Let me see if I actually have an example of this that I can throw for you real quick. And so, we're cleaning up this front one. This is an old placeholder right now,

[14:20] don't worry about that. But, the idea is, right? See those small little animations in there? We hand-coded those, right? We wanted those to be there for very specific reason. We're affecting the spacing. The spacing isn't

[14:30] right. But, this idea So, you see you can see folder structure and the idea behind folder structures is very much here. I figured that would be cool to add into our website since it's such a big part of it. But, like all of these

[14:41] are things that can grow. They can be components and processes that we actually are able to incorporate. And so, we can take all these assets and reuse them in a thousand different ways if we compile them somewhere, which is

[14:54] exactly what we did in our GitHub, um which I think is cool. So, it become our websites that we've built, the things that we've already spent time on, become an asset to then amplify our future work. Uh and that's exactly what it's

[15:06] going to go through. It's going to read all the JSX. This is why it used so many tokens because it is navigating all of the files deeply. It's using Essentially, it's Claude code behind the scenes with a series of good routing, uh

[15:20] a series of good tool calls, the ability to use GitHub files, to use the GitHub CLI. It's actually going through and listing any other repos that might be connected to it. Uh and it's reading every single file. And while it's taking

[15:32] these, it's taking notes. It's adding each of these to its own design folder that it thinks are important. So, it's actually going to skip a lot of the files that maybe aren't as important to what we're building here, right? So,

[15:46] there might be uh certain preview files that aren't useful, might not be what we want. And it's actually deciding which ones to ignore or vice versa. If you uploaded a slide, these are super old. This is years ago, so please ignore

[15:59] these. These were when I was testing with AI at earlier versions. This is like 2 or 3 years ago when I was trying to get uh GPT-3 to build slides for me. Which at time, this was next level that it could even generate a slide, which is

[16:10] crazy to think that 3 years ago this was crazy for AI to do. Uh we've moved so quickly, but it could take concepts from this, images from this and and sectionalize them away. I wouldn't use this cuz this is terrible compared to

[16:23] actual branding and processes, but the idea is there is it simplifies the process, right? It could pull from anything that you've already built in things. Funny enough, this is actually what K, my front-end developer, we were part of

[16:36] a a UK uh startup program when I was going to university there and we built an app called Sin Space as part of the competition, which was was funny. Um and this is a quick, man. If we had what the tools we had now back then, we

[16:48] could make such such great decks before. This was all built by hand uh back in the olden days before AI. Um but, I find that very funny. Anyway, and so that's what it's doing. And then it's also creating style sheets. And then it's creating its own

[17:03] skill documents. So, if we open this up, we can see it's designed This is a skill for Aduba's design. Use this skill to generate branded references for Aduba, what we're doing. First of all, here's the routing. So, it's doing my routing

[17:17] process. My routing process is a little bit more complicated, so I'm probably going to clean up these files myself. But, it's the idea in my older videos, it's going through and it's saying, "Hey, here's some important files that

[17:27] you want to look about." Here's non-negotiables. It's deciding, "These are the main colors you need to use. These are the main ideas you need to So, it's a skill on how to use the design files that it's extracting, which

[17:39] is very useful. I used to have to do this manually, and I still do do it manually. That's kind of how I created my my previous animation sets, but that's exactly what it's doing. So, after it's done importing and understanding these, sometimes it

[17:52] imports some of them, so it doesn't have to recreate it, right? Because it's importing actual code, actual design methodology, and adding it to these folders. Again, it's all folders and text documents at the end of the day

[18:03] referencing code and components. That's All the best AI systems out there are this, which means you can rebuild this locally, which I will share here more. I know I said I was going to skip ahead, but honestly, I figured I could teach pretty

[18:19] well while it's doing this. And it's adding extra HTML, so these ones it decided it wanted to recreate. And so, looks like previews, so that might be under UI kits. Uh possibly. No, these are other components. And that's the

[18:30] thing is I can come in and look and it's sharing and storing certain things that it thinks are there. It downloaded this directly from what we were looking at, but it doesn't have the animations, right? Because this is just the HTML

[18:41] code. So, it's able to organize it into structures to save tokens in the future. Right now, it's burning a lot of tokens, and that's what you want to understand. This is allowing using a lot of tokens all at once to organize everything for you. And

[18:57] then eventually, you're going to be able to actually export this, which I'll show you here in a moment. It can't the whole process. You can download this as a zip, bring it onto your local file, and you don't even need to use Claude.

[19:09] You could use Gemma or these local models, which I'll actually This is a good time to go over to now. We'll hit two birds with one stone. So, it creates this huge design system, and it's going through and I get to go and review it, right? And this is what

[19:22] it's doing right here. It's as it's going through this, I get to say, "Is that a good read me, right? Is this what Aduba represents?" Usually, I'd edit these, but let's just say it looks good. Then, are these my colors? Is this what

[19:32] I really wanted? Do we want to edit these? I can say needs work and readjust it. Again, the whole idea is you want to refine the starting data so that in the future, you never have to refine it again. We've got different aspects here.

[19:45] I'm going to go ahead and just smash looks good. I do think we are changing some of the typography and whatnot in this, but this is cool. This is just for all of you to see. It even talks about labeling, how we're actually setting up

[19:56] where our indexes, what are the pixels, how many how large should the font be, where should the font be in that. Type case rules, what that actual type case is. It's breaking down our brand from our websites, from our branding

[20:10] documents, and organizing it like a brand designer would. And here's the thing, if it as a brand designer, if you think this is taking your job, you need to take a step back. This just made you more valuable because you know how to

[20:23] guide this even more. And now you can do quadruple the work for the same amount of time. You can charge more as a freelance designer if you're using this tool and get high-quality non-AI slop. People are going to come to you because

[20:37] you can use this tool well. It's very important that you all understand this, right? And it's doing this well. Again, all of these assets were built by my designer, my partner, K, who's looking in this area. What's also cool and what

[20:49] I think uses a lot of tokens is what you see here. There's a little mini thing. It's actually going through and looking at them. It's taking screenshots of it right now. So, as it's coming through and it just finished, which is cool,

[21:01] it's verifying that everything looks good itself, that it all got in there, and noticing any issues, right? And so, I'm just going to go through and say all of this looks good. I'm very happy with it. It's it's solid and again, this is

[21:12] for use cases. And again, you can go back and oop, I didn't mean to like that. But once it all looks good, you can go and publish it. But we're not going to do that yet because we want to double-check. So, it went through,

[21:23] again, it read GitHub files, it looked through scripts, it wrote its own skills, right? It came in and it said, "You know what? This is the whole project. So, here's your assets, here's all your SVGs, here's all of the main

[21:36] things that you might be using. But there's also icons that you might need to use, right?" Then there's also this skill. Every time it's adding a new folder, it's referencing where it is. The way you could make this more

[21:47] efficient is actually show the folder structure. That way when Claude is reading through it, it knows where those files are. It's not spending time to go find those files. It's looking through it, knows, "Oh, well, hey, that file

[22:01] that I'm looking for is in the script lab and it's two folders deep." versus it having to search through the folders to find that file. That's just something I would add personally. I'm sure Claude or Anthropic will add that that soon as

[22:12] long as they watch my videos. But that's the idea here. It's all just folders, texts, and components. That's all it's doing. It's very impressive and it even has voice MDs, right? These are just markdown files of how the concepts,

[22:25] "Hey, we're calm, we're useful, we're never theatrical." You can come in and edit these if you want. They go through. Where are these aspects? You could add case studies of these, right? Which there isn't any here cuz I didn't add

[22:37] case studies. But you could literally say, "Hey, this is when we did branding right and it got a lot of information. This is when we did something wrong, right?" In these aspects. All of these files are there. And it seems to have

[22:49] done that, right? Surface level UI exists. Yep, you're right. I didn't give it any other high-level UI aspects. It did look at our So, we do have this kind of core aspect for Scramble, which could be more complicated to make it better.

[23:03] So, it recognized issues with what it created. And if you're a designer, you'll be able to expand on these issues more. If you're not, it's okay. You got what you needed out of it. And then it's asking, "Hey, can you recalibrate? Maybe the voice needs to be

[23:15] better." which is what we were just looking at here. How do we want our voice to sound? Is this who we are? Immediately, this I'm going to change that. I don't like that voice. This is cool. I am a Marine. I did go engineer

[23:26] and governance research. And that's a cool vibe, but that sounds kind of salesy and and weird. I I have my own voice structures that I've spent a lot of time writing. Um actually, I think I have some right here that I can show

[23:38] you. Should be in my docs. I actually forgot where I put that one. Could it be brief notes? Nope. Uh is it in my script lab? Yes, my voice. So, I already have a voice document of how I like to speak, what we do. Here it is. I'm actually

[23:55] going to condense this even more. I even gave my own versions of what's wrong and right. And that's not even considering the AI side of things. No, I'd never say that. I say, "And that's just if you wrote the line yourself." I'm barely

[24:05] referencing AI. I'm referencing structures, concepts, right? And that's what you can do right here. You can just say, "Hey." Or you can leave it. Again, you don't have to get as complicated as me. I like to be nuanced. I like to dive

[24:15] in. That's where I see and get the most value. The ROI is my opinion. Uh everyone can make a decent thing now. Everyone can get all the answers. Now the questions are important. Things that are metrics of best uh or where best

[24:29] doesn't exist is what becomes valuable. And my opinion on who we are is now an active code choice because at the end of the day, everyone's going to be able to get the decent enough code. But is it going to be at that top 10%? When you

[24:42] get in the top 10% of design or code or even mathematics, opinions become the actual valuable thing. Uh you want to productionize your opinion, which I'm going to make a shirt that says that honestly for myself. I think that would

[24:54] be good. At the end of the day, you're left with a really big, beautiful design system. And you can just simply hit publish and use a new design method. But before I do that, I can actually come in. I can look at this whole project. I

[25:09] instead of using more tokens inside of design, I can come in, I can hit share, and I can either duplicate this project, I can download it as a zip, which is exactly what I'm going to do here, or I can export it to PowerPoint, HTML, and

[25:24] it'll create an entire briefing document, a design document that I can hand to other designers or my vendors or contractors. I can import it to Canda Canva, or I can go directly to Claude code. They know how I'm about to show

[25:37] you how to use this, right? You can literally import this project into Claude code, but I I'm going to show you how to do it simpler way, which is through the zip. But let's say, right? I've downloaded it, I have it there. Now

[25:47] I can hit new use a new design. Now I have Oh, crap. I should have named it something else, but that's okay. One of these is the proper Aduba design system. I'm going to assume it's this one. >> [laughter] >> That was a mistake on my part, but

[25:59] that's okay. And now I can go in and say, "I want to go make a slide deck pitch." And so, I can come in and let's say I'm creating a pitch for an investor or something like that. I can come in and say, "I want to make a pitch for Y

[26:16] Combinator." Now, generally speaking, you want to have a lot of info on your company. Sometimes what I do is if you use Claude or any other tools, you can create a briefing document, which I did recently. But I can literally just copy

[26:30] that and paste that into here. And so, not only does it have all of that info on my company, what I'm doing, what the kind of pitch is that I want, but it's also using the Aduba design system and making a slide deck. So, it's

[26:44] all those skills compiled into one place. I can trust that the assets it's pulling from, the folders it's pulling from, are going to work well. This Aduba design system is more than just a skill. It is a literal set of folders, right?

[26:57] It is all of our assets condensed into a folder structure, which actually, I'm going to go ahead and show you what that looks like locally and how my folder structure is literally that. Oh my god, I have so many things open.

[27:11] I already made a little folder cuz I knew I was going to do this. So, let's say I threw this folder really quickly. Just created a folder on my desktop, right? Through the This is the zip we just downloaded with our Aduba design

[27:23] process. Come in. I'm just going to go ahead and extract it here. Why not right-click it? Yeah, there we go. Extract all. Yes, I would like to extract it there. I think that's the right spot. Boom, cool. So, now I can just go ahead

[27:38] and move that out of it. Now this is the Claude design. So, what we're seeing right here when we're inside of this, right? This Aduba design system with all these folders and Claude being here, I technically have a similar version of

[27:52] it. If I open up, you can either use VS Code or I can use Claude Code Work or Claude Code in the app. So, if you have Claude downloaded, I can navigate to that folder, right? So, use a different folder, come in, right? Boom, select that folder. Should

[28:11] work. Now I'm inside of that folder. Or I can do the same thing with Claude Code, right? You come in, new session, I'm going to go and find the folder I want. Desktop, design. Again, this is where I just extracted the zip. I can now ask

[28:29] it, "Hey, I want to make a PowerPoint, right?" Trust this workspace. It's going to immediately read all of those files, all of those structures, and it's going to know because a skill was already created from this workspace.

[28:45] Use the themes in this workspace to make a test PowerPoint to show you understand branding here. And so, what it should read what is in this file locally. You could also do a {slash} initiate command, right? So, then it'll read that file. It's going

[29:06] through the read me though, so that should work well. It sees what's in the contents, what's in the documents, what this design system is. It's doing what Claude design is doing, except it's using way less tokens. It's using it

[29:17] locally. Now I personally I'll let this run. I love Claude Code in this aspect. And as you can see it This is I didn't have to create all of this. This was already created by the Aduba design system. This is a skill, essentially.

[29:30] Again, markdown files with routing, where it came from, context, the paths of where to find it, embedded into it for me downloading it right here. By just uploading my GitHub or my Canvas, I'm getting the folder structure that I need, the folder

[29:46] structure that I've been teaching about in all of my videos and whatnot. And it's immediately going to do similar processes. The difference is for the animation videos and all of that stuff, you're going to need to download a

[29:57] couple extra tools like playwright or remotion, which I have videos on how to do that. But it's important to understand that. Now, you can also, instead of opening it there, is open it inside of VS Code, which is my personal favorite and I have

[30:11] videos on how to install VS Code with Claude and all that, so go check those out. But I can come in and go find the I know someone's going to say that I I I know design spelled wrong. I wrote it quickly. I'm going to open this one. Did I hit

[30:23] open folder? Don't hit open folder. That's important. Come here, click design, boom, right? And now, same thing. I'm working in here and while the other version of Claude Code is working in here, it's already creating that

[30:36] slide deck. My design system is here, too. I can open up Claude and do the same thing. And let me show you what the initiate command will do, right? So, it's going to go through and immediately read. Now, I have two agents creating

[30:48] sub agents working these. Uh-oh, I've hit my session limit. I have a current project that I'm running right now where we're beasting through tokens. Um I almost never hit my limit, but I've had it run straight for 3 days right now. Uh

[31:01] essentially, I'm creating websites for 350 companies in the matter of 24 hours. Uh we'll talk about that. I'll make a video on that here soon. But I have been eating through my usage, but it's still less than if I was doing API calls. Um

[31:12] and luckily, I have um I'm paying for extra right now because I wanted to show these aspects, but this is another reason why you might want to use local models and I'll show you here. I can actually have this convert over to

[31:22] local. But see, it's going through and it's getting ready. It's reading it. It's understanding it. And now that I have it initiated, it's going to create a Claude MD, which is based off of and might link to these readme files. But

[31:33] now it lets me go through and now, the reason I love it is if you are really wanting to get into it, you can look at your whole structure. This is everything Claude Design created. This is the whole process, the structure. This is your

[31:45] whole brand document. You can now give this folder structure to Codex, right? I have Codex installed. I can literally do the same thing. Read and understand this code base, right? Oh, I don't have it set up right now. I need to reconnect

[32:01] it. I'll set it up later, but you could do Codex in here. And this is a good point to double down on the I know my videos are always ADHD, so I hope you all get very good value out of this, but you could use local coding models as

[32:12] long as the model can read files and navigate a folder structure, you can use it to use these documents. It will read skill files. It will read these folders. It might not do it to the level that some models will, but one that I love is

[32:26] Qwen 3 Coder Next, specifically the next edition, because it allows you to use an 80 billion parameter model, but it only loads certain parameters at a time, so you can use it on smaller graphics cards. Uh but this is a really great.

[32:39] I'll make videos on installing and using local models. Another one that I like a lot is uh Code Gemma. This is from Google DeepMind. Um you can access the cloud version of it or download the smaller versions that will run locally

[32:51] on very not too powerful computers. Mistral has a local model called Devro, and you can even access it through your API if you don't have a strong computer. DeepSeek does as well. They have um B2, which is really good. Um you find here

[33:05] and it's open source and whatnot. Again, same thing. There's certain limitations and then some people argue that DeepSeek has some tracking that's being sent back even in their open source models, but there's a lot of arguments. We don't

[33:18] have to get into there. Um you are in government work, especially in the US, there's a lot of arguments about whether DeepSeek is allowed. Very great model, very powerful tool, but again, the reason you want to understand this,

[33:30] the reason I'm teaching folder structure is because if you understand the folder structure, if you can navigate it, you can remove the need to only use Claude, right? Like I hit my limits. I could just swap over to another model.

[33:44] I could swap over to a local one. Um and worry about being locked into a model and I get to tweak and control, right? I'm going to come through and rip this skill apart. I'm going to change this file structure. I'm going to give it my

[33:57] own version of the Claude that MD. See, this Claude that MD isn't even good in my opinion because it doesn't show um the actual structure of the folders. Even though it says where it goes, I find building it out like you saw in my

[34:11] other one. Um really does make a difference not just for other people, but for me. There's also the option of using Obsidian, which I haven't made a video on. I keep saying I'm going to, but Obsidian's a local file control

[34:24] structure app that you can download that lets you look at all These are the markdown files that you were just looking at, right? But it actually renders markdown and you can create dashboards around where everything is. So, where certain files

[34:39] are, where they're located. You create metadata and you can create mind maps with it, which I I have on this one. I think I have it. Yeah. You can create kind of maps. I haven't been spending a lot of time cleaning mine up, but it can

[34:52] show you how certain readmes connect to other workers or functions or processes and immediately click them. So, you can navigate your file structure a lot faster um by going through and clicking on these uh services and processes. Which

[35:06] So, Obsidian's really cool for creating mind maps. Again, it's cool and it's useful in certain situations. I don't think it's as important as people put it out there for most use cases or for early users. I think as you navigate these structures,

[35:22] as you get better in understanding um type of software engineering, quote unquote, then Obsidian becomes more useful, which is why I haven't been spending as much time sharing or talking about it. But it is really cool.

[35:33] Um anyway, once you've got this all set up, if you can install another local model, you can ask it to create these animations, create these slide decks, these processes, right? Have it come through. And right now, that's exactly

[35:45] what it's doing. And if I come in, I can even access it without VS Code, without any of that. I can just go and be like, "Oh, okay. These slides look Oh, that's a good slide." At the end, what Claude is going to do, um I Claude Code on my

[35:59] desktop, is it's generating each slide and then it's going to connect them together as one large HTML file or convert that HTML file to a PowerPoint. Um exactly what's happening right here. It's just generating each slide. That is

[36:12] exactly what Claude Design is doing. Literally, if you come in and we look at my last project where I had it create a slide deck, right? This is our new pitch. This pitch. Um it is all HTML, right? It's creating HTML briefings and then you can

[36:33] convert them to slide decks, download as slide decks, right? And I did that literally from Claude Design. Right. I'm able to download that and it converts it because of the skill for converting um and so then I took those HTMLs and then

[36:51] now this is a fully editable power deck, right? Um it convert the typology so that it could be um automated. If you have the typology downloaded, then you can actually have it transfer, which my brand's typology is, so it's much larger in how it's

[37:08] written and whatnot. But that's the concept here, right? Design is a way that Anthropic helps you navigate and control assets to creating folder structures. And this is just one aspect of it. I promise you, over the next 5

[37:23] years, more tools and processes are going to come out like this. Less and less are you going to need to build agents that navigate folders and collect things. More and more you're going to need to condense your structures and

[37:34] processes into something that one or two agents or one really good coding agent can read and conform and make tool calls to create processes. And the reason you want to not waste your time building with one single company and focus on the

[37:49] fundamentals is because then you can have it locally. You can control it. This can cut costs or you at least understand how to edit it. But essentially, that's a really good way to dive into it. Um if you wanted to start

[38:03] creating animations in here, again, go check out my remotion video and you want to download the remotion library um at the skill for for remotion, but essentially, this lets you render locally on your computer. Um yes, you know what? This is a long

[38:20] video. Keep it longer. If I come into my content one, I have remotion installed here. So, we'll go ahead and terminal and you can see that I can just host a kind of artifact locally. So, Claude Design hosted as an HTML.

[38:39] Um I can actually render JSX and all of these animations and look at them here. Or, if you wanted to go really simple, you don't even need to download remotion. Do everything motion animations in HTML and then you can just

[38:53] open up those those HTML files, right? Um See if it'll let me do that here. Or Yeah, I can come here and I should be able to Now, I think I used JSX in this one, so yeah, it's going to work the same way. Um this is where you would

[39:08] want So, it's rendering JSX and HTML in a single environment. If I had both of these downloaded in a folder and then I open the HTML, I'd be able It would just be like opening a web page. Uh remotion lets you kind of in and look at each

[39:21] frame and actually break down where those frames are. And then I can even hook Claude up to this. And let me find my long form Um and Claude can actually come in here and edit these animated videos. These were all I built all of these way before

[39:37] Claude Design. I had videos like this months ago. Um I had been built using this folder structure. Again, this whole content design system was basically Claude design before Claude design came out. I'm sure they probably stole some

[39:49] of my ideas from me. Not stole, they used it. They understand it. Everyone gets upset, "Oh, they stole it from me." Look, you can have a million ideas. Implementation and reaching an audience is the only thing that matters.

[39:59] Um ideas are useless until they're implemented. Uh you can steal something without the effort of implementing it. Now, if you implemented it and you're getting value, then there's an issue there. But again, this is the future of a lot of design

[40:11] and processing and it's only going to get better. Again, I built this folder structure system. I have all of these animations. It now just got better because of this feature, not replaced. I'm not chasing, trying to be better or

[40:23] outcompete Anthropic. My systems are getting better because these tools keep growing. That's what you want to build. You want to build the systems that grow with time, not get replaced with time. And I know I'm growing a lot faster now.

[40:38] I've gotten 30,000 subscribers, I think, on YouTube in the last uh month. But I promise you, and this is me being delusional, in the next year, my teachings will become even more relevant. I'm teaching stuff that's useful in 5 years, not just

[40:54] now. So, I hope you all stay tuned and learn it. If this is one of your first YouTube videos that you're inside of, uh please come join my community, Cleef Notes. I have all sorts of classrooms and foundations where I talk about

[41:06] folder structure, full workflows on how to set up folder structures, the concepts around it, and not just folder structure, but like the history of coding and processing. What it actually means to think about this. I didn't just

[41:20] come to these conclusions on my own. This has all been written about over years, if not hundreds of years. I mean, 50 years ago, you can learn stuff that will help you today if you look at what people were developing over the last few

[41:33] years, break it down, and look at the fundamentals. But I think I am done with this video. We should be done there. Um I'll put all these links, um these local models and other things like that. This is going to be a video that's turned into a course,

[41:48] as well. Um probably add an extra video or two after once I get a chance or maybe a text page. Uh so, please stay tuned. I hope you like this. I hope you've learned a lot. And uh yeah, don't have to waste tokens on Claude design.

[42:01] Have fun. Have a good day, everyone. Oh, and happy learning.
