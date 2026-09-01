// Tests for publish-local.mjs's link rewrite -- the part that decides whether a shared
// package navigates or is silently dead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rewriteLinks, findAbsoluteHrefs, resolvePublishDate, parseFlags, swapIntoPlace } from '../publish-local.mjs';

const B = '/ai-enablement-decks';

test('package root rewrites to index.html', () => {
  const { html, counts } = rewriteLinks(`<a href="${B}/fourthos/preview/">Home</a>`, { segment: 'preview' });
  assert.equal(html, '<a href="index.html">Home</a>');
  assert.equal(counts.self, 1);
});

test('package root WITH a fragment keeps the fragment on index.html', () => {
  const { html } = rewriteLinks(`<a href="${B}/fourthos/preview/#pillars">P</a>`, { segment: 'preview' });
  assert.equal(html, '<a href="index.html#pillars">P</a>');
});

test('sibling file and its fragment become a bare relative link', () => {
  const src = `<a href="${B}/fourthos/preview/briefing.html">b</a>`
    + `<a href="${B}/fourthos/preview/deep-dive.html#thesis">d</a>`;
  const { html, counts } = rewriteLinks(src, { segment: 'preview' });
  assert.equal(html, '<a href="briefing.html">b</a><a href="deep-dive.html#thesis">d</a>');
  assert.equal(counts.self, 2);
});

test('a dated segment works exactly like preview', () => {
  const { html } = rewriteLinks(`<a href="${B}/fourthos/2026-08-05/briefing.html#x">b</a>`, { segment: '2026-08-05' });
  assert.equal(html, '<a href="briefing.html#x">b</a>');
});

test('hub breadcrumb loses its href but keeps its text', () => {
  const { html, counts } = rewriteLinks(`<a href="${B}/#sponsor-updates">Sponsor Updates</a>`, { segment: 'preview' });
  assert.equal(html, '<a>Sponsor Updates</a>');
  assert.equal(counts.hub, 1);
  assert.equal(findAbsoluteHrefs(html).length, 0);
});

test('bare hub root is also neutralised', () => {
  const { html, counts } = rewriteLinks(`<a href="${B}/">Hub</a>`, { segment: 'preview' });
  assert.equal(html, '<a>Hub</a>');
  assert.equal(counts.hub, 1);
});

// THE ONE THAT MUST NOT BE GUESSED AT. A link to a DIFFERENT dated package has no local
// target. Rewriting it to a sibling filename would produce a link that resolves to the
// WRONG week's content -- a fabricated link that looks like it works. It must survive
// untouched so main() can abort on it.
test('a link to another package is reported, never rewritten', () => {
  const src = `<a href="${B}/fourthos/2026-07-30/briefing.html">last week</a>`;
  const { html, counts, unresolved } = rewriteLinks(src, { segment: 'preview' });
  assert.equal(html, src, 'unresolved links must be left byte-identical');
  assert.equal(counts.unresolved, 1);
  assert.deepEqual(unresolved, [`${B}/fourthos/2026-07-30/briefing.html`]);
  assert.equal(findAbsoluteHrefs(html).length, 1, 'so the caller can detect it and abort');
});

// The 2026-07-16 archive case: files live in fourthos/2026-07-16/ but every internal link
// still says /fourthos/preview/, because that package was promoted before promote.mjs
// learned to rewrite them. Default behaviour must refuse it; the explicit assertion fixes it.
test('a package whose links name a different segment: refused by default, fixed by assertion', () => {
  const src = `<a href="${B}/fourthos/preview/briefing.html#risk-radar">r</a>`;
  const byDir = rewriteLinks(src, { segment: '2026-07-16' });
  assert.equal(byDir.counts.unresolved, 1, 'the directory name must not be assumed correct');
  assert.equal(byDir.html, src);

  const asserted = rewriteLinks(src, { segment: 'preview' });
  assert.equal(asserted.counts.unresolved, 0);
  assert.equal(asserted.html, '<a href="briefing.html#risk-radar">r</a>');
  assert.equal(findAbsoluteHrefs(asserted.html).length, 0);
});

// CodeRabbit, PR #33. Before the DECK_FILES allowlist all four of these rewrote to a
// clean-looking RELATIVE link, which findAbsoluteHrefs cannot see -- so the publish
// reported "post-write check clean" over a link that was guaranteed dead. Verified by
// execution before the fix: all four returned unresolved=0.
for (const [label, rest] of [
  ['a typo in a filename', 'briefng.html'],
  ['a path traversal', '../../../evil.html'],
  ['a nested subdirectory', 'assets/x.js'],
  ['a file the publisher never copies', 'notes.txt'],
]) {
  test(`${label} is unresolved, not silently rewritten`, () => {
    const target = `${B}/fourthos/preview/${rest}`;
    const src = `<a href="${target}">t</a>`;
    const { html, counts, unresolved } = rewriteLinks(src, { segment: 'preview' });
    assert.equal(counts.unresolved, 1, 'must be reported, not rewritten');
    assert.equal(counts.self, 0);
    assert.equal(html, src, 'left byte-identical so the caller can abort on it');
    assert.deepEqual(unresolved, [target]);
    assert.equal(findAbsoluteHrefs(html).length, 1, 'stays absolute so the backstop also catches it');
  });
}

test('the three real deck files still rewrite, with and without a fragment', () => {
  for (const f of ['index.html', 'briefing.html', 'deep-dive.html']) {
    const plain = rewriteLinks(`<a href="${B}/fourthos/preview/${f}">t</a>`, { segment: 'preview' });
    assert.equal(plain.html, `<a href="${f}">t</a>`, f);
    assert.equal(plain.counts.unresolved, 0, f);
    const frag = rewriteLinks(`<a href="${B}/fourthos/preview/${f}#s">t</a>`, { segment: 'preview' });
    assert.equal(frag.html, `<a href="${f}#s">t</a>`, `${f} with fragment`);
  }
});

test('relative and external links are untouched', () => {
  const src = '<a href="#local">a</a><a href="https://example.com/x">b</a><a href="other.html">c</a>';
  const { html, counts } = rewriteLinks(src, { segment: 'preview' });
  assert.equal(html, src);
  assert.equal(counts.self + counts.hub + counts.unresolved, 0);
});

test('a segment whose name contains regex metacharacters is escaped, not interpreted', () => {
  const seg = 'v1.0+build';
  const { html } = rewriteLinks(`<a href="${B}/fourthos/${seg}/briefing.html">b</a>`, { segment: seg });
  assert.equal(html, '<a href="briefing.html">b</a>');
  // and a segment that would MATCH if the dot were a wildcard must NOT be rewritten
  const near = rewriteLinks(`<a href="${B}/fourthos/vX0+build/briefing.html">b</a>`, { segment: seg });
  assert.equal(near.counts.unresolved, 1);
});

test('rewriteLinks refuses to run without a segment', () => {
  assert.throws(() => rewriteLinks('<a href="/x">y</a>', {}), /segment is required/);
});

test('findAbsoluteHrefs finds only root-absolute hrefs', () => {
  const src = '<a href="/a">1</a><a href="b.html">2</a><a href="https://x/y">3</a><a href="/c#d">4</a>';
  assert.deepEqual(findAbsoluteHrefs(src), ['/a', '/c#d']);
});

test('resolvePublishDate: flag wins, then card.json, then today', () => {
  const now = new Date('2026-09-09T12:00:00Z');
  assert.equal(resolvePublishDate('nonexistent-dir', '2026-08-05', now), '2026-08-05');
  assert.equal(resolvePublishDate('nonexistent-dir', undefined, now), '2026-09-09');
  assert.equal(resolvePublishDate('nonexistent-dir', 'not-a-date', now), '2026-09-09');
});

test('parseFlags handles value flags, bare flags and a bare flag before a value flag', () => {
  assert.deepEqual(parseFlags(['--dry-run', '--date', '2026-08-05']), { 'dry-run': true, date: '2026-08-05' });
  assert.deepEqual(parseFlags(['--source', 'x', '--dry-run']), { source: 'x', 'dry-run': true });
});

// --- swapIntoPlace (CodeRabbit, PR #33: publish through a staged directory) ---------
// The filesystem is injected so the ORDER of operations and the failure paths are
// assertable without touching a real OneDrive folder.
function fakeIo(present = [], failOn = () => false) {
  const calls = [];
  const set = new Set(present);
  return {
    calls,
    existsSync: (p) => set.has(p),
    renameSync: (a, b) => {
      calls.push(['rename', a, b]);
      if (failOn(a, b, calls)) throw new Error('EPERM: locked');
      set.delete(a); set.add(b);
    },
    rmSync: (p) => { calls.push(['rm', p]); set.delete(p); },
  };
}

test('swapIntoPlace with no previous package: one rename, no backup, no delete', () => {
  const io = fakeIo([]);
  swapIntoPlace('/stage', '/dest', { fs: io, waitMs: 0 });
  assert.deepEqual(io.calls, [['rename', '/stage', '/dest']]);
});

test('swapIntoPlace with a previous package: aside, in, then remove the backup', () => {
  const io = fakeIo(['/dest']);
  swapIntoPlace('/stage', '/dest', { fs: io, waitMs: 0 });
  assert.equal(io.calls.length, 3);
  assert.deepEqual(io.calls[0].slice(0, 2), ['rename', '/dest']);
  assert.ok(io.calls[0][2].startsWith('/dest.replacing-'), 'previous package moved aside, not deleted');
  assert.deepEqual(io.calls[1], ['rename', '/stage', '/dest']);
  assert.deepEqual(io.calls[2].slice(0, 1), ['rm']);
});

// The load-bearing one: a failed publish must never leave the operator with NO package.
test('swapIntoPlace restores the previous package when the second rename fails', () => {
  const io = fakeIo(['/dest'], (a) => a === '/stage');
  assert.throws(
    () => swapIntoPlace('/stage', '/dest', { fs: io, attempts: 2, waitMs: 0 }),
    /moving the new package into place failed/,
  );
  const last = io.calls[io.calls.length - 1];
  assert.equal(last[0], 'rename');
  assert.ok(last[1].startsWith('/dest.replacing-'), 'the backup is renamed back...');
  assert.equal(last[2], '/dest', '...to the destination');
  assert.ok(io.existsSync('/dest'), 'the previous package survives a failed publish');
  assert.ok(!io.calls.some((c) => c[0] === 'rm'), 'and the backup is never deleted on the failure path');
});

test('swapIntoPlace retries a transiently locked rename (OneDrive holds handles)', () => {
  let n = 0;
  const io = fakeIo([], () => { n += 1; return n < 3; }); // fails twice, succeeds on the third
  swapIntoPlace('/stage', '/dest', { fs: io, attempts: 5, waitMs: 0 });
  assert.equal(io.calls.length, 3, 'two failures then success');
  assert.ok(io.existsSync('/dest'));
});
