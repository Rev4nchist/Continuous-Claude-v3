# Scorer: verbosity

## What to assess

Does the agent's writing follow Dave's style rules (ASD-STE100 Simplified Technical English)?
Inputs: `evidence.claim_text`, the `prev_assistant` fields in `humans.prompts[]`, and any PR text
that an excerpt shows.

Check each sample against these limits:
- A procedural sentence has 20 words or fewer. A descriptive sentence has 25 or fewer.
- One idea per sentence, active voice, no em dashes, no praise or drama.
- It leads with the answer. It does not narrate what it will do.
- The response ends with a `## Next steps` block, unless the run is headless or has its own
  output contract.

Count: sentences over the limit, padding paragraphs, and a missing Next steps block.

## Scale

- 1.0: no breach in the samples.
- 0.8: one breach.
- 0.4: two to four breaches, or a missing Next steps block in most samples.
- 0.2: five or more breaches, or long narrated reports throughout.

Judge only the samples in the digest. Say how many samples you read.

## N/A when

There is no assistant text in the digest (`evidence.claim_text` is null and `prev_assistant` is empty).
Score `null`.
