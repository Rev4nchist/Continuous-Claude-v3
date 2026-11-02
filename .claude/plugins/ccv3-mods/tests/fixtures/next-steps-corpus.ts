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
]
