// Failure modes (label-page.html, the claude.ai labels artifact).
//  claude.use('db') never settles       -> the status stays "Loading pairs..." forever (no timeout)
//  the timeout fires after a success      -> a loaded page shows an error (timer not cleared)
//  the timeout fires after an error       -> the real error is overwritten (timer not cleared)
//  status class 'warn' has no CSS rule    -> "N of M pairs to label" has no colour cue
// The page script runs in node:vm with a stub DOM, a stub claude.use and hand-fired timers.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const HTML = readFileSync(new URL('./label-page.html', import.meta.url), 'utf8');
const SCRIPT = HTML.match(/<script>([\s\S]*?)<\/script>/)[1];
const TIMEOUT_TEXT = 'Pairs not loaded: no answer from the viewer. Reload the page.';

function node() {
  return { textContent: '', className: '', value: '', children: [], appendChild(c) { this.children.push(c); return c; } };
}

function runPage(use) {
  const nodes = { status: node(), list: node() };
  nodes.status.textContent = HTML.match(/<div id="status"[^>]*>([^<]*)<\/div>/)[1];
  const timers = new Map();
  const cleared = [];
  let next = 1;
  const ctx = {
    document: { getElementById: (id) => nodes[id], createElement: () => node() },
    setTimeout: (fn, ms) => { const h = next++; timers.set(h, { fn, ms }); return h; },
    clearTimeout: (h) => { cleared.push(h); timers.delete(h); },
    Promise,
    claude: { use },
  };
  vm.runInNewContext(SCRIPT, ctx);
  return { status: nodes.status, timers, cleared };
}

const flush = () => new Promise((r) => setImmediate(r));
const fireAll = (timers) => { for (const [h, t] of [...timers]) { timers.delete(h); t.fn(); } };

test('a db that never answers shows the reload message after 10 s', async () => {
  // Breaks when: the 10 s timer is removed or its message changes.
  const page = runPage(() => new Promise(() => {}));
  await flush();
  assert.equal(page.status.textContent, 'Loading pairs...');
  assert.deepEqual([...page.timers.values()].map((t) => t.ms), [10000]);
  fireAll(page.timers);
  assert.equal(page.status.textContent, TIMEOUT_TEXT);
  assert.equal(page.status.className, 'failed');
});

test('a db that answers clears the timer, so a late timeout never overwrites the page', async () => {
  // Breaks when: clearTimeout is missing on the success path.
  const db = { collection: () => ({ onSnapshot: (cb) => cb({ docs: [] }) }) };
  const page = runPage(() => Promise.resolve(db));
  await flush();
  assert.equal(page.timers.size, 0);
  assert.equal(page.cleared.length, 1);
  assert.equal(page.status.textContent, 'No pairs yet. Claude sends up to 20 a week.');
});

test('a db error clears the timer and keeps the real error', async () => {
  // Breaks when: clearTimeout is missing on the error path.
  const page = runPage(() => Promise.reject(new Error('denied')));
  await flush();
  assert.equal(page.timers.size, 0);
  assert.ok(page.cleared.length >= 1);
  assert.equal(page.status.textContent, 'Pairs not loaded: denied');
});

test('the warn status class has a CSS rule that uses --warn', () => {
  // Breaks when: the .warn rule is deleted, so open pairs get no colour cue.
  assert.match(HTML, /\.warn\s*\{[^}]*color:\s*var\(--warn\)/);
});
