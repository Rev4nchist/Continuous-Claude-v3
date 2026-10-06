// ask-rate.test.mjs: parsers behind scripts/self-improvement/ask-rate.mjs.
// Run: node --test "scripts/self-improvement/test/*.test.mjs"
import assert from 'node:assert/strict';
import test from 'node:test';
import { isSurvey, endsWithQuestion, countAsks, interactiveHeadline } from '../ask-rate.mjs';

const j = (o) => JSON.stringify(o);
const ask = (question, extra = {}) => j({
  type: 'assistant', ...extra,
  message: { role: 'assistant', content: [{ type: 'tool_use', name: 'AskUserQuestion', input: { questions: [{ question }] } }] },
});
const say = (text, extra = {}) => j({ type: 'assistant', ...extra, message: { role: 'assistant', content: [{ type: 'text', text }] } });

test('isSurvey: the session-rating prompt is not a real ask', () => {
  assert.equal(isSurvey('How did this session go?'), true);
  assert.equal(isSurvey('Which runner should I use?'), false);
});

test('endsWithQuestion: the Next steps block is stripped before the check', () => {
  assert.equal(endsWithQuestion('Which one?'), true);
  assert.equal(endsWithQuestion('Done.\n\n## Next steps\n1. Run it. Ready?'), false);
  assert.equal(endsWithQuestion('Which one?\n\n## Next steps\n1. Reply A or B.'), true);
  assert.equal(endsWithQuestion('Done.'), false);
});

test('countAsks: counts AskUserQuestion, drops surveys and sidechain asks', () => {
  const r = countAsks([
    j({ type: 'user', entrypoint: 'cli', message: { role: 'user', content: 'hi' } }),
    ask('A or B?'),
    ask('How did this session go?'),
    ask('Sidechain ask?', { isSidechain: true }),
    say('Done.'),
  ]);
  assert.equal(r.entrypoint, 'cli');
  assert.equal(r.asks, 1);
  assert.equal(r.plainQ, 0);
});

test('countAsks: a final text ending in ? is a plain question', () => {
  assert.equal(countAsks([say('Done.'), say('Which file?')]).plainQ, 1);
});

test('endsWithQuestion: markdown closers after the ? still count', () => {
  assert.equal(endsWithQuestion('Use **vitest or node:test?**'), true);
  assert.equal(endsWithQuestion('Run it (ready?)'), true);
});

test('interactiveHeadline: plain final questions count beside AskUserQuestion calls', () => {
  const by = {
    cli: { sessions: 4, asks: 2, plainQ: 2 },
    'claude-vscode': { sessions: 1, asks: 0, plainQ: 1 },
    'sdk-cli': { sessions: 100, asks: 50, plainQ: 50 },
  };
  const h = interactiveHeadline(by);
  assert.deepEqual([h.sessions, h.asks, h.plainQ], [5, 2, 3]);
  assert.equal(h.asksPerSession, 0.4);
  assert.equal(h.asksPlusPlainPerSession, 1);
});
