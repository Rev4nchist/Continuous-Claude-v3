/**
 * The Next steps corpus: every input that ever made the Next steps parser (parseTurnEnd in
 * hooks/agentic-os/brief.ts) drop a real ask or invent one, with the ask list it must give.
 *
 * A row is { id, text, asks, source }:
 *   asks    one substring per expected ask, in order. [] means "no ask": the block clears the open asks.
 *   source  the test that first pinned the row in brief.test.ts, or the review finding it came from.
 *
 * Add a row when you change the parser or find a new input it reads wrong. The row must come from a
 * real answer or a real finding, not from the code under test. next-steps-corpus.test.ts runs every row.
 *
 * Not in the corpus on purpose: dataset findings #24 ("don't stop at X" read as an affirmative stop) and
 * #25 ("I will stop there." claims the goal slot). They concern goal and stop-at, not asks, and
 * no test pins their expected values yet. A row would invent behaviour.
 */
export type CorpusRow = { id: string; text: string; asks: string[]; source: string }

const steps = (...lines: string[]): string => `## Next steps\n${lines.join('\n')}`
const done = (...lines: string[]): string => `Opened PR 12.\n\n${steps(...lines)}`

export const CORPUS: CorpusRow[] = [
  // Asks that a waiting or a none lead must not drop (CodeRabbit #222, Majors #57 to #59, Minor #60).
  { id: 'R57', text: steps('1. Waiting on CI, then approve PR 12'), asks: ['approve PR 12'], source: 'P31, E14d (finding #57)' },
  { id: 'R58', text: 'Done.\n\n## Next steps\nNothing for you to do.\nCan you approve the PR?', asks: ['approve the PR'], source: 'P33 (finding #58)' },
  { id: 'R59a', text: steps('1. Waiting on CI—approve PR 12'), asks: ['approve PR 12'], source: 'P36 em dash (finding #59)' },
  { id: 'R59b', text: steps('1. Waiting on CI–approve PR 12'), asks: ['approve PR 12'], source: 'P36 en dash (finding #59)' },
  { id: 'R60', text: steps('1. Nothing needed'), asks: ['Nothing needed'], source: 'P37 (finding #60)' },
  { id: 'R32a', text: steps('1. None for now. Paste the build log here.'), asks: ['Paste the build log'], source: 'P32' },
  { id: 'R32b', text: steps('1. None, but please review the diff'), asks: ['review the diff'], source: 'P32' },
  { id: 'R35a', text: done('1. No action needed — paste the build log'), asks: ['paste the build log'], source: 'P35' },
  { id: 'R30a', text: steps("1. Waiting on Dave's approval."), asks: ["Waiting on Dave's approval"], source: 'P30' },
  { id: 'R30b', text: steps('1. Nothing for me to do.'), asks: ['Nothing for me to do'], source: 'P30' },
  { id: 'R14', text: steps('1. None of the three options fit. Pick another approach?'), asks: ['None of the three options fit. Pick another approach?'], source: 'P14' },
  // Closed no-ask forms: the block gives an empty list.
  { id: 'N13a', text: done('1. None — waiting on the CI run.'), asks: [], source: 'P13' },
  { id: 'N13b', text: done('1. **None** — waiting on the Greptile review.'), asks: [], source: 'P13' },
  { id: 'N27a', text: done('1. No action needed.'), asks: [], source: 'P27' },
  { id: 'N27b', text: done('1. Waiting on the workflow run.'), asks: [], source: 'P27' },
  { id: 'N27c', text: done("1. I'm waiting on the CodeRabbit review."), asks: [], source: 'P27' },
  { id: 'N26', text: "Pushed the fix.\n\n## Next steps\n1. None for now. I'm waiting on the workflow.", asks: [], source: 'P26' },
  { id: 'N29', text: 'Done.\n\n## Next steps\nNothing for you to do. Waiting on the CI run.', asks: [], source: 'P29' },
  // Coord status band fixes, fix 3 (2026-11-16): a peer wait with a one-sentence first-person tail is no ask; any other tail stays an ask.
  { id: 'R63a', text: steps('1. None - waiting on the end word from Coord hooks. I rule on its findings before any fix push'), asks: ['I rule on its findings'], source: 'band review 04, live seat 14:15:39: a second sentence stays an ask (known limit, no tail grammar)' },
  { id: 'N61b', text: steps('1. None for the seat'), asks: [], source: 'band review 04, fix 3' },
  { id: 'N61c', text: steps('1. None, waiting on CI'), asks: [], source: 'band review 04, fix 3' },
  { id: 'R61a', text: steps('1. None - waiting on CI. Paste the build log'), asks: ['Paste the build log'], source: 'seat guard 1: an order in the tail' },
  { id: 'R61b', text: steps('1. None - waiting on CI. Dave picks the band after'), asks: ['Dave picks the band after'], source: 'seat guard 1: names Dave' },
  { id: 'R61c', text: steps('1. None - waiting on CI. I rule on it after you pick'), asks: ['after you pick'], source: 'seat guard 1: names you' },
  { id: 'R61d', text: steps('1. None - waiting on CI. I wait. Paste the build log'), asks: ['Paste the build log'], source: 'seat guard 1: a second sentence' },
  { id: 'R61e', text: steps('1. None - waiting on CI. Should I rule on it?'), asks: ['Should I rule on it?'], source: 'seat guard 1: a question mark' },
  { id: 'R61f', text: steps('1. None - waiting on CI. I rule after Dave picks'), asks: ['I rule after Dave picks'], source: 'seat guard 1: a first-person tail that names Dave' },
  { id: 'R61g', text: steps('1. None - waiting on CI. I rule on your reply'), asks: ['I rule on your reply'], source: 'seat guard 1: a first-person tail that names your' },
  { id: 'R61h', text: steps('1. None - waiting on CI. I rule on it after the long review of the whole change set after the long review of the whole change set after the long review of the whole change set after the long review of the whole change set after the long review of the whole change set'), asks: ['after the long review'], source: 'tail bound: over 160 characters stays an ask' },
  { id: 'R63b', text: steps('1. None - waiting on CI. We decide the band after the build'), asks: ['We decide the band'], source: 'critic round 2: we can include Dave' },
  { id: 'R61i', text: steps('1. None - waiting on CI. It rules after the build'), asks: ['It rules after the build'], source: 'a tail that does not start with I or We stays an ask' },
  { id: 'R62a', text: steps('1. None - waiting on CI. I need the log pasted'), asks: ['I need the log pasted'], source: 'critic: a need is an ask' },
  { id: 'R62b', text: steps('1. None - waiting on CI. I\'d like a yes'), asks: ['I\'d like a yes'], source: 'critic: a wish is an ask' },
  { id: 'R62c', text: steps('1. None - waiting on CI. I’d like a yes'), asks: ['like a yes'], source: 'critic: curly apostrophe' },
  { id: 'R62d', text: steps('1. None - waiting on CI. I need approval to push'), asks: ['I need approval to push'], source: 'critic: an approval' },
  { id: 'R62e', text: steps('1. None - waiting on CI. I wait - paste the build log'), asks: ['paste the build log'], source: 'critic: a second clause after a dash' },
  { id: 'R62f', text: steps('1. None - waiting on CI. I wait, then paste the build log'), asks: ['paste the build log'], source: 'critic: a second clause after a comma' },
  { id: 'R62g', text: steps('1. None - waiting on CI. I wait: paste the build log'), asks: ['paste the build log'], source: 'critic: a second clause after a colon' },
  { id: 'R62h', text: steps('1. None - waiting on CI. I will wait unless the answer is no'), asks: ['unless the answer is no'], source: 'critic: a condition on an answer' },
  { id: 'R62i', text: steps('1. None - waiting on CI. I need yours'), asks: ['I need yours'], source: 'critic: yours' },
  { id: 'R62j', text: steps('1. None - waiting on CI. I rule.Paste the log'), asks: ['Paste the log'], source: 'critic: a period with no space' },
  { id: 'R62k', text: steps('1. None, waiting on Dave\'s approval'), asks: ['Dave\'s approval'], source: 'critic: comma separator, object names Dave' },
  { id: 'R62l', text: steps('1. None, waiting on your yes'), asks: ['your yes'], source: 'critic: comma separator, object names you' },
  { id: 'R62m', text: steps('1. None - waiting on CI. I rule on yours'), asks: ['I rule on yours'], source: 'yours is not an own-action tail' },
  { id: 'R62n', text: steps('1. None - waiting on CI. I rule on it, paste the build log'), asks: ['paste the build log'], source: 'a comma opens a second clause' },
  { id: 'R63c', text: steps("1. None - waiting on CI. I'll rule on it after the build"), asks: ['rule on it after the build'], source: 'no tail grammar: a contraction tail stays an ask' },
  { id: 'R63d', text: steps('1. None - waiting on CI. I post the PR after approval'), asks: ['after approval'], source: 'critic round 2: a hidden approval' },
  { id: 'R63e', text: steps('1. None, waiting on yours'), asks: ['waiting on yours'], source: 'critic round 2: yours' },
  { id: 'R63f', text: steps('1. Waiting on yours'), asks: ['Waiting on yours'], source: 'critic round 2: yours, bare form' },
  // coord-hooks-followups PR 1 (2026-11-16): hidden-question holes of the wait forms. Every row below is a question for Dave.
  { id: 'H64a', text: steps("1. Waiting on  Dave's approval"), asks: ["Dave's approval"], source: 'item 10: two spaces after on' },
  { id: 'H64b', text: steps('1. Waiting on CI (paste the build log)'), asks: ['paste the build log'], source: 'item 6: parentheses in the object' },
  { id: 'H64c', text: steps('1. Waiting on CI -> approve PR 12'), asks: ['approve PR 12'], source: 'item 6: an arrow' },
  { id: 'H64d', text: steps('1. None - waiting on CI.Paste the build log'), asks: ['Paste the build log'], source: 'item 6: a period with no space' },
  { id: 'H64e', text: steps('1. Waiting on CI before you approve PR 12'), asks: ['you approve PR 12'], source: 'item 6b: you inside the object' },
  { id: 'H64f', text: steps("1. None - waiting on Dave's approval of PR 12"), asks: ["Dave's approval"], source: 'item 6b: dash form, Dave in the object' },
  { id: 'H64g', text: steps('1. None. Waiting on your yes'), asks: ['your yes'], source: 'item 6b: period form, your' },
  { id: 'H64h', text: steps('1. None \u2014 waiting on you to paste the build log'), asks: ['paste the build log'], source: 'item 6b: em dash form, you' },
  { id: 'H64i', text: steps('1. None - waiting on yours'), asks: ['yours'], source: 'item 6b: yours' },
  { id: 'H64j', text: steps('1. None - waiting on CI | paste the log'), asks: ['paste the log'], source: 'item 6: a pipe' },
  { id: 'H64k', text: steps('1. Waiting on CI \u2192 approve it'), asks: ['approve it'], source: 'item 6: a unicode arrow' },
  { id: 'H64l', text: steps('1. Waiting on CI (run 12)'), asks: ['CI (run 12)'], source: 'known cost: a plain line with parentheses is a false question, by the rule that a false question beats a hidden one' },
  { id: 'H64n', text: steps('1. None — waiting on your merge yes'), asks: ['your merge yes'], source: 'P22 used to pin this as no ask; it asks Dave to merge, so it is a question (card rule)' },
  { id: 'H64m', text: steps('1. Waiting on Dave'), asks: ['Dave'], source: 'Dave as the whole object' },
  // The no-ask forms that must stay no-ask.
  { id: 'N64a', text: steps('1. Waiting on the CI run.'), asks: [], source: 'PR 1: stays no ask' },
  { id: 'N64b', text: steps('1. None - waiting on Coord hooks'), asks: [], source: 'PR 1: stays no ask' },
  { id: 'N64c', text: steps('1. None for now. I\'m waiting on the caf\u00e9 review'), asks: [], source: 'PR 1: letters beyond ASCII stay no ask' },
  { id: 'N64e', text: steps('1. Waiting on the pre-merge check'), asks: [], source: 'PR 1: a hyphen stays no ask' },
  { id: 'N64f', text: steps('1. None - waiting on PR #12 checks'), asks: [], source: 'PR 1: a hash and digits stay no ask' },
  { id: 'N64d', text: steps("1. Waiting on CodeRabbit's review"), asks: [], source: 'PR 1: an apostrophe stays no ask' },
]
