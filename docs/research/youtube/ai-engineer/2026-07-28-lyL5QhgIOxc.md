---
video_id: lyL5QhgIOxc
title: "Serving 2 Million Models Without Melting: Scaling the Hugging Face Hub — Arek Borucki, Hugging Face"
channel: "AI Engineer"
channel_id: UCLKPca3kwwd-B59HNr-_lvA
channel_slug: ai-engineer
url: "https://www.youtube.com/watch?v=lyL5QhgIOxc"
upload_date: 2026-07-28
duration_s: 1299
duration: 21:39
view_count: 1168
like_count: 53
subtitle_lang: en-orig
transcript_source: auto
transcript_words: 1956
ingested_at: 2026-08-06T11:00:33.948Z
ingest_version: 1
---

# Serving 2 Million Models Without Melting: Scaling the Hugging Face Hub — Arek Borucki, Hugging Face
**Channel:** AI Engineer · **Uploaded:** 2026-07-28 · **Duration:** 21:39 · **Views:** 1,168  
**Watch:** https://www.youtube.com/watch?v=lyL5QhgIOxc

## Description

Type llama into a catalog of 3 million public models and the result still has to feel instant. At 20,000 models any query is fast; at Hugging Face's scale, 14 million users and a million datasets on top, search becomes the hard part. Arek Borucki shows how the Hub keeps it quick: full text search on Apache Lucene, served through MongoDB Atlas, which stores only the metadata while the model artifacts sit in S3 so compute scales on its own. Regex ranking did not hold, so relevance now runs through one unified query with the $search operator, sorted by downloads, likes, and trending.

Underneath is a seven node MongoDB cluster where only the primary takes writes, with a hidden analytics node soaking up the heavy queries so production traffic never feels them. Keep queries light, push everything else elsewhere, and once the catalog outgrows a single primary, shard the data across nodes by key. The front end scales the same way: Kubernetes goes from 10 to 500 pods and CastAI adds machines underneath, and because HPA only watches CPU and memory, they scale on event loop utilization through KEDA, which sees the request queue HPA cannot.

Speaker info:
- https://x.com/_Aras_B
- https://www.linkedin.com/in/arekborucki/
- https://arekborucki.cloud/

Timestamps:
0:00 - Introduction: scaling the Hugging Face Hub
1:44 - The numbers: 14 million users, millions of models
3:57 - Why search at scale is the hard part
5:09 - Full text search on Apache Lucene
5:46 - Request flow: autoscaling, MongoDB Atlas, and S3
7:55 - How a search for "llama" works
10:11 - Ranking and Atlas Search with the $search operator
13:00 - The seven node cluster and a hidden analytics node
16:42 - Sharding the database
18:14 - Kubernetes autoscaling: 10 to 500 pods and CastAI
20:07 - Scaling on event loop utilization with KEDA

## Chapters

- [0:00](https://youtu.be/lyL5QhgIOxc?t=0) Introduction: scaling the Hugging Face Hub
- [1:44](https://youtu.be/lyL5QhgIOxc?t=104) The numbers: 14 million users, millions of models
- [3:57](https://youtu.be/lyL5QhgIOxc?t=237) Why search at scale is the hard part
- [5:09](https://youtu.be/lyL5QhgIOxc?t=309) Full text search on Apache Lucene
- [5:46](https://youtu.be/lyL5QhgIOxc?t=346) Request flow: autoscaling, MongoDB Atlas, and S3
- [7:55](https://youtu.be/lyL5QhgIOxc?t=475) How a search for "llama" works
- [10:11](https://youtu.be/lyL5QhgIOxc?t=611) Ranking and Atlas Search with the $search operator
- [13:00](https://youtu.be/lyL5QhgIOxc?t=780) The seven node cluster and a hidden analytics node
- [16:42](https://youtu.be/lyL5QhgIOxc?t=1002) Sharding the database
- [18:14](https://youtu.be/lyL5QhgIOxc?t=1094) Kubernetes autoscaling: 10 to 500 pods and CastAI
- [20:07](https://youtu.be/lyL5QhgIOxc?t=1207) Scaling on event loop utilization with KEDA

## Transcript

[0:01] [music] Good afternoon everyone. I have a question. How many of you knows hugging face? Nice. How many of you already use hugging face? Amazing. Almost everyone. But I think we still have opportunity to grow our usage. My name is Ar Borutki. I

[0:43] work as machine learning platform and database engineer at hugging face. Today I would like to walk you through how hugging faced scaled infrastructure and how we ended up serving 3 million models to developers around the world.

[1:09] I would like to share architectural decisions we made, challenges we faced, and lessons we learned while scaling one of the fastest growing open-source AI communities in the world. I hope you will enjoy it and let's get

[1:33] started. Before I dive into technical details, let's talk about scale. Today, Hugging Face serves more than 14 million users and this number is growing very fast, especially in the last couple of months. We host three million public models,

[2:03] 1 million data sets, 50,000 organizations, and not only hobbyists or scientists. More than 30% of Fortune 500 use hugging face as a part of AI workflows. Just to give you some perspective, few years ago we had 20,000 models.

[2:36] Today 3 million. It is around 150x increase in just last couple of years. And this grow is exactly why I'm here today talking about infrastructural decisions that keep the hub healthy at scale. This is how fast the number of public

[3:06] models is growing on the hub. Every big release like llama or deepseek generated thousands of new models on top and our infrastructure needs to handle that and it is not only models also data sets. In 2022, we had 10K. In 2024,

[3:38] 100K. Less than a year ago, we had 500K. Today, 1 million. All this data must be stored, indexed, and also must be searchable. And that's the hardest part. And this is also the reason why we had to rethink our search. At 20,000 models, any query is fast.

[4:14] Even without an index, trust me, no one would notice. At 3 million, same approach breaks. Imagine what would you do if the hub search would be slow. you would just leave and go somewhere else. And this is also what user are

[4:34] doing. They expect fast instant results. With 14 million users, even 1% is a not small number. It is 140,000 of people hitting slow search at scale. P99 is much more important than P50 and we are paying a lots of attention to P99

[5:09] and that's the reason why we invest in premputee tokens denormalize optimize for read collection in MongoDB full text search based on Apache lucine Kubernetes autoscaling and soon in database sharding. The next slides will show you how

[5:41] high level architecture when user interact with the hugging face hub his request flows from the front end to the hub API. The hub is running on Kubernetes. Currently we are using horizontal pot autoscaler. During spikes new ports scale up

[6:07] automatically to handle the load and scale back down when traffic drops. This help us to keep the hub healthy without manual intervention. Next the request goes to MongoDB Atlas which is source of true for our metadata.

[6:34] And there is one point that sometimes surprise people. MongoDB does not store the models themselves. It stores everything about the models. What doesn't mean in practice in MongoDB we hold all the metadata users repositories

[7:02] models data sets buckets spaces information configuration data billing data access control and more. The actual models artifacts, tokenizer files, cart assets and configuration files are stored separately in cloud object storage such

[7:31] as AWSS3. This separation of concern let us scale metadata independently from binary storage and compute independently from both. We can optimize each component individually for specific workload. Now let's check how search works in

[7:58] details. For example, someone wants to search the model on the hub and let's say that's llama. So someone type llama into hugging face search bar. His request flows through the hub to an optimized read collection on MongoDB. And this is

[8:20] not our main repo collection when we keep all the data. It's a separate denormalized copy only for reads and listings. The key information is on the left. We tokenize model names on insert time, not at query time. For example, someone wants to publish

[8:51] model meta minus llama/ llama 3.18b. We split the long model name into small tokens like meta lama 3.18b and we store them in an array in MongoDB document. Next, Atlas search which is using Apache Lucin under the hood use autocomplete

[9:20] to find matching models instantly. This is example of single document from our model collection. In this example, I'm using find one method. I want to find model ID meta minus llama/lama 3.1. So that's the model from the previous slide.

[9:47] And I'm projecting only search token array. And we see that all those premputee tokens are part of this array. So we have metal lama 3.1 metal lama etc. Next there must be a query. In the past we were using classical MongoDB find method on models collection

[10:16] with reax operator and this reax operator we're searching in search tokens arrays models which are equal to llama and then we were s sorting results by trending score which is calculated every five minutes. This is number of

[10:40] downloads and number of likes is as far as I remember from the last seven days. This solution was working well as long as data set was small. Reax doesn't scale well. So when our data set started to grow very quickly, we started to having problems with

[11:04] latency. So we decided to switch to Atlas search that's a feature which is using Apache lucine under the hood. So MongoDB doesn't provide in core MongoDB server full text search there is additional process MongoD uh this MongoDBT process is a wrapper

[11:33] around Apache lucine for end user users this is transparent you are just using Unifi MongoDB query API and when You use aggregation pip pipeline together with dollar search operator. MongoDB will know that you would like to search

[11:59] Apache Lucin index. Obviously you need to put the name of this index which is in this scenario model search autocomplete model equal to llama path search tokens and we still sort results by trending score and this solution is much more

[12:26] efficient and is so far scale Well, so we don't have any more latency issues in our search bar. First two results returned by previous query. First metal lama has trending score 33. Second one 14. But hugging face hub is not only search.

[13:00] We have hundreds of different services in hugging face which are utilizing which are using MongoDB to handle million of queries. We use seven nodes MongoDB clusters cluster with multiple machines. We can distribute queries across multiple

[13:24] nodes. So no single node become read bottleneck. This is how it works. Application talk to the MongoDB cluster. All inserts, deletions or updates goes to single primary because only primary can handle them. However, we are distributing reads across

[13:48] multiple machines. We also have one analytic hidden node. What does it mean? This mean this node is invisible from application. MongoDB driver is not routing any queries to this hidden node. This node is still replicating data from

[14:12] primary but is not interacting with interacting with production traffic. We are connecting directly to this node and we use him for any kind of reporting traffic on or any kind of really heavy queries. All secondaries continuously

[14:38] tail the oplog from primary keeping cluster in sync. Now let's have a look what actually is running on secondaries. First all queries which doesn't require the latest data goes to secondaries. Only queries that must have strong consistency

[15:05] stay on primary and we are paying a lots of attention to this. We are paying lots of attention to the queries which must run on primary. Second, complex aggregations. Aggregations pipelines that scan large amount of data, sort, group or transform

[15:29] the data should not go on primary. They are heavy. Secondaries are better placed for them. Third, change streams. We react to data changes in real time for several reasons. For example, caching validation, sync to different

[15:51] data store technologies like for example AWS, Red Shift or for eventdriven workloads. Those kind of operations are also not very light and they should stay impossible on secondaries. Fourth, all ad hoc queries, reporting queries,

[16:13] maybe some experimental queries go to hidden MongoDB replicas set member which is isolated from production traffic. The pattern is simple. Primary should focus on what only primary can do. Anything else can be pushed to different

[16:35] machines. However, with 14 million users, 3 million models and our grow soon single MongoDB replica set will not be enough. The next step is sharding. Sharding means scaling your database horizontally. Instead of putting full data set on one

[17:06] replic on one replica set cluster, we are going to cut data into pieces and put each piece on separate chart. Each shard will have his own replication primary and secondary. So we will keep replication just multiplied. The key difference between replica set

[17:28] cluster and sharded cluster is replica set keep full data set on each node. Sharded cluster keep only part of the data on each shard. And then if you want to scale horizontally more you are just adding more shards and then MongoDB

[17:45] balancer will balance data across all those shards. There is also shard key which must be selected. This is not trivial operation but this talk is not about choosing short key. This way we are going to scale everything CPU

[18:05] memory storage reads and writes. Now let's have a look what is going on the hub level. DHA is running on Kubernetes. Currently we are using horizontal pot autoscaler. When CPU or memory threshold go above target, Kubernetes adds new pot

[18:34] automatically to handle this spike and scale them back down when traffic drops. Our deployment hub deployment can scale from 10 to 500 bots depends of on the traffic. This is how we keep the hub healthy without manual interventions

[18:55] and without infrastructure overprovisioning. So this is also cost effective solution. However, what happens if horizontal pot autoscaler want to add new ports but kubernetes does not have free nodes anymore. This is where second layer comes in. We

[19:20] are using cast AI for Kubernetes note autoscaling when pods are pending because there is no capacity and Kubernetes scheduler is not able to schedule them. Cast AAI is adding new nodes and then scheduler is able to schedule

[19:41] those spots. So we have two layers of scaling. First one is at deployment level. Second one is at infrastructure level via castai. But we are going to migrate horizontal port autoscaler to keta kubernetes eventdriven autoscaling. The difference

[20:07] HPA scale only based on CPU and memory. KDA scale on real application metrics like request per second or event loop utilization. It means scaling is driven by actual workload not by resource utilization only. For example, pot can have low CPU but high

[20:35] request Q. KDA can see it. HPA not the best part of this architecture. You never have to think about it. When you pop when you push the model, search the hub or download the model, it just works. This is what scaling medium

[21:00] models is really about. Keeping the user experience simple no matter how complex it gets under the hood. Thank you very much. It was pleasure for me to be here today and I wish nice day for all of you. Thank [applause] you.
