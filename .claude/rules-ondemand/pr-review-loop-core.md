# PR review loop: core

The full rule is 64 KB. A hook cannot send it whole, so this page holds the decisions and an index.
Full rule: `C:/Users/dkhay/.claude/rules-ondemand/pr-review-loop.md`
Read the matching section of the full rule with the Read tool BEFORE the open, the checkpoint and the land steps. Find a section with `Grep '^## '`. A session that read only this page must not open, checkpoint or land a PR.

## Decisions this page settles

- The review pick is Dave's tap. Call `pr_checkpoint {pr, body}`. It returns his question: ask it with AskUserQuestion word for word, then call `pr_checkpoint` again with the same arguments. Never write your own review question. Never add a `review:` label by hand.
- Below risk band HIGH the recommended pick is none (no bot review). The tool sets the recommendation, and most HIGH PRs get none too. Only his tap records a pick. Do not ask him "which review?" in chat.
- Post a plain `@coderabbitai review` only when the `pr_watch` line says a round is left or Dave allowed round N, and never when the free-slot queue holds the PR. A paid round needs Dave's priced tap on the Paid round question. Post it only with `node scripts/github/cr-paid.mjs post --pr N`, never by hand.
- Only Dave merges. Land only after his Land tap, with `pwsh -File scripts/github/land-pr.ps1 -Pr <N>`. Say "ready" only when `node scripts/github/review-status.mjs <N>` prints READY.
- Open a PR as a draft, with a body file (`-F body=@<file>`), after `node scripts/github/pre-pr.mjs --body <file>` passed on the head. Then call `pr_watch {pr}` and `pr_checkpoint` in the same turn.

## The five taps

Each tap is an AskUserQuestion that a script builds. Pass its JSON word for word. Act only on the label he taps.
1. Commit and push: `node scripts/github/ship-ask.mjs commit-and-push --msg <file> --json`
2. Open PR: `ship-ask.mjs open-pr --json`
3. Review pick: `pr_checkpoint {pr, body}`
4. Paid round: `ship-ask.mjs paid-round --pr <N> --json`
5. Land: `ship-ask.mjs land --pr <N> --json`

## Which section to read

- Before you open a PR: summary file, pre-pr, stamp, the five taps, review budget per class.
- Review band and review models: bands LOW to CRITICAL, which band gets which pick.
- Waiting for the review: what counts as a review; the free-slot queue.
- No review on the head: drafts, `review:none`, rate limits, waivers.
- When the review lands: read every finding, fix, reply, resolve threads.
- Paid PR reviews: the six conditions, `cr-paid.mjs`.
- Proof in the PR body: the Evidence block, proof types, what READY checks.
- Before you call a PR ready, or land it: READY, `land-pr.ps1`, Gate C, Gate D.
- Repos still on CodeRabbit, Loop prompt, Thread state, Enforced by hook, Label routing at ready: the rest of the loop.
- Target: not built. Do not act on it.
