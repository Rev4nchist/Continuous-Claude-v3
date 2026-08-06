# M3 — Model landscape & business/financial context (mined candidates)

> Miner: M3. Lane: model landscape + business/financial context. Corpus: 6 videos (1 workshop, 1 benchmark-relay, 1 sponsored tutorial, 1 news roundup, 1 macro podcast, 1 short). All transcripts are auto-captions; proper nouns taken from titles/descriptions, never captions. Graded per PILLAR1-FORMAT-DECISION.md.

## CANDIDATES

### C-1 · Shared connector chassis → model endpoint portability (continuity drill)

**Claim:** Frontier-model access is a supply risk that fired once already this cycle — the chassis should prove, not assume, that its model endpoint can be swapped and the 13-role test re-run on a second model.

- **Fourth artifact:** shared connector chassis (model binding) + the 13-role business test as the swap instrument.
- **Suggested verdict:** PILOT — run the 13-role suite once against a second model via config-level endpoint swap; kill criteria below.
- **Evidence:**
  - `R` US Commerce export controls suspended access to Anthropic's flagship model for roughly two weeks, then lifted them (June 26/30); a former administration AI official narrates the three-condition fact pattern and warns against over-extrapolating — but the suspension itself happened, on committed enterprise workloads [vid:wgdxSCsmS-Q @50:35, @52:11, @53:36]
  - `A` Reuters-relayed report that Beijing is considering restricting overseas access to advanced Chinese models, explicitly including open-weight models — the cheap-fallback direction is not risk-free either [vid:xjt7ulpGTZ4 @4:24, @5:09, @6:09]
  - `A` an open-weight model (Kimi K3, name from video title — captions mangle it) is claimed at frontier parity on coding/agentic leaderboards at roughly $3 in / $15 out per million tokens, about a third of frontier pricing; all claims are vendor-benchmark relays by a third-party channel [vid:DAKnynuGyy4 @9:44, @11:00, @29:13]
  - `Rⓥ` the 8090 CEO reports an in-house experiment: their harness wrapping an open-source model ran a code-migration task roughly 16x cheaper but ~3x slower than the frontier model alone; harness + Claude was ~1.4x cheaper and ~1.5x faster ⚠asr on the multipliers — narrated on a podcast, not shown [vid:wgdxSCsmS-Q @13:53, @14:11]
  - `A` counter-row: a relayed user report that the same open-weight model failed a real-codebase debugging task that two frontier models one-shotted — parity claims may not survive contact with existing-architecture work, which is exactly what a connector is [vid:DAKnynuGyy4 @33:49, @34:01]
- **Weakest link:** no row demonstrates a model swap on anything resembling our workload; the parity rows are vendor benchmarks relayed secondhand, and the one measured-sounding row (16.4x) is a self-reported vendor number.
- **Wrong if:** the second model fails the 13-role suite broadly — then portability is theoretical at current model quality, and the single-vendor dependency should be surfaced to sponsors as an accepted risk rather than a solvable one.

### C-2 · Internal harness / 13-role test → endpoint-interception eval pattern

**Claim:** You can evaluate an unmodified harness by handing it a fake OpenAI/Anthropic-compatible base URL and intercepting every request — the harness never knows it is under evaluation, so the same connector code serves production, model comparison, and trace capture.

- **Fourth artifact:** our own harness and eval practice — specifically running the 13-role test (and C-1's swap drill) without touching connector code.
- **Suggested verdict:** PILOT — wire one interception endpoint in front of the Salesforce connector harness and capture one full eval run's traces through it.
- **Evidence:**
  - `R` the interception-server pattern as the speaker's team ships it: each harness rollout gets a fake OpenAI- or Anthropic-compatible base URL; requests are intercepted, adjusted (log probs, temperature), forwarded, and returned — "the harness doesn't know... your harness is just code," so the same harness moves between eval, training, and deployment unchanged [vid:V-EDrhIhHzQ @22:07, @22:20, @22:43]
  - `R` environments decomposed into task set / harness / runtime, individually swappable; an eval CLI hot-swaps harness and runtime ("Codex, local, Docker, sandboxes... interchangeable") to answer "what's the best harness for this model, does this harness generalize across tasks" [vid:V-EDrhIhHzQ @12:54, @23:07, @23:30]
  - `A` the framing that earns the pattern its place: evals and environments are essentially the same asset, evals are "the thing that opens the door to post-training," and the immediate payoff is min-maxing intelligence vs dollars per task (which frontier tier, or open) [vid:V-EDrhIhHzQ @6:49, @7:01, @7:15]
- **Weakest link:** single source, and the speaker's employer sells a hosted platform built around this ecosystem (the interception pattern itself lives in their Apache-licensed open-source library, so the rows are graded R not Rⓥ — but the vendor-adjacency is real and a second independent source does not exist in this corpus).
- **Wrong if:** our connector harness does not consume a configurable base URL (auth or SDK binds it) — then interception costs a refactor, not hours, and the finding drops to a shelf item with that refactor as trigger.

### C-3 · Harness & eval practice → the post-training cost floor moved (context, not a build)

**Claim:** The cost premise behind "we can't afford custom models" is stale: a LoRA fine-tune of a trillion-parameter open-weight model was shown end-to-end for on the order of $131, and frontier-scale RL is quoted near $50K per full run — though nothing here demonstrates either beating harness engineering on a task like ours.

- **Fourth artifact:** our own harness and eval practice — the standing "harness engineering vs post-training" decision boundary.
- **Suggested verdict:** WATCH (with expiry) — no current Fourth use case; the eval assets from C-2 are the prerequisite either way.
- **Evidence:**
  - `D (1 case)` `ⓥ` a completed LoRA fine-tune job on a 1T-parameter open model (Kimi K2.7-code), dashboard shown with the cost read out ≈$131 for one epoch on a 4,600-row dataset, loss curve descending ⚠asr on the exact figure; the video is sponsored by the model vendor, disclosed on-air [vid:kxstlfc8Lw4 @19:47, @2:50]
  - `R ⓥ` same speaker: a larger-dataset run cost ~$800, and serving the result requires four B300-class GPUs rented hourly — deployment, not training, is where the cost lives [vid:kxstlfc8Lw4 @20:00, @20:30]
  - `R` the other end of the range, from the training-infra vendor: a full RL step on a frontier-scale open model (GLM-5, 131K context, long-horizon coding) on 28 nodes in under 5 minutes, a 1,000-step run in ~3 days at ~$50K rental — narrated results with figures, not measured in front of the audience [vid:V-EDrhIhHzQ @32:12, @32:31]
  - `A` the tutorial's quality evidence is eyeballing chat responses side-by-side — no eval suite, no measured gain [vid:kxstlfc8Lw4 @27:27, @28:29]
- **Weakest link:** both cost sources are commercially interested (sponsor; platform vendor), and neither shows the tuned model beating a well-harnessed frontier model on any measured task.
- **Wrong if:** a quality-grade fine-tune on a real task costs orders of magnitude more than the demo (the $131 was one epoch, no eval), or our own evals show harness+prompting already saturates the tasks we care about — both currently more likely than not.

## NOT COUNTED

- [vid:DAKnynuGyy4] all specific benchmark placements and scores — **ASR-excluded**: the captions render the model name as "Kimiko 3", "Qwen 1.5 3", and "Gemini K3" within one transcript and mangle benchmark names ("Qwen Code 2.0 bench internal"); number-bearing leaderboard claims are unusable. Only the A-grade pricing/parity direction survives, inside C-1.
- [vid:xjt7ulpGTZ4 @3:51] GPT-5.6 "2.2 trillion parameters" leak — **ASR-excluded + never-evidence**: a number-bearing rumor relayed from unnamed leaks.
- [vid:xjt7ulpGTZ4] GPT-5.6 launch timing, DeepSeek inference chip, Anthropic "J-space" research, Qwen 4 rumors, Grok 4.5 leaks, Tencent HY3, Meta Muse models, robot demo — **failed relevance**: no bearing on any Fourth artifact.
- [vid:xjt7ulpGTZ4 @14:35] Gemini API managed agents (hosted sandbox, remote MCP) — **failed relevance**: infrastructure we neither run nor plan; no current artifact it changes.
- [vid:wgdxSCsmS-Q @5:57–7:06] Anthropic verticalization pattern (Figma/Claude Design, Claude Code vs Cursor) and the enterprise data-sovereignty argument — **failed relevance as a card**: platform-strategy macro; names no change to a current Fourth artifact. Noted as background to C-1 only.
- [vid:wgdxSCsmS-Q @33:52 onward] AI jobs debate, SCOTUS, California budget — **failed relevance**: macro.
- [vid:3GvygTooqGw] AI circular-financing short — **failed relevance + shorts rule**: 95-second A-grade framing, dense with deal figures carrying ASR risk; vendor financial fragility maps to no current Fourth artifact.
- [vid:V-EDrhIhHzQ @29:20–42:26] Prime Intellect's async-RL internals (trace graphs, renderers, losses) — **failed relevance**: training-infra depth with no Fourth artifact; only the eval-side patterns (C-2) and the cost figure (C-3) bear.

## LANE READ

The model layer is commoditizing from two directions at once: open-weight models now claim frontier parity at a fraction of the price, while access to the incumbent frontier vendor proved regulator-suspendable for two weeks — and both directions land on the same design conclusion, that Fourth's chassis and eval assets should be model-portable, with the 13-role test as the instrument that makes portability checkable rather than asserted. Post-training cost floors dropped hard (hundreds of dollars for LoRA, ~$50K for frontier-scale RL), but nothing in this corpus demonstrates a tuned model beating disciplined harness engineering on existing-codebase work — the one relayed head-to-head on a real debugging task went the other way. Net: this lane's pressure is toward portable evals and swappable endpoints, not toward training anything.
