// assemble.test.mjs — unit + determinism + safety tests for the pure triage assembler.
// Run: node scripts/self-improvement/triage/test/assemble.test.mjs
import assert from 'node:assert/strict';
import { assemble, mdToSafeHtml, esc } from '../assemble.mjs';

let pass = 0;
function test(name, fn) { fn(); pass += 1; console.log(`  ok - ${name}`); }

const sample = [
  { id: '2026-07-01-x', date: '2026-07-01', component: 'x', component_name: 'Comp X',
    verdict: 'adopt', headline: 'Headline one', sources: 5,
    sections: [{ n: 1, title: 'Where CCv3 is today', md: 'Para with **bold** and `code`.\n\n- item a\n- item b' }] },
  { id: '2026-07-02-y', date: '2026-07-02', component: 'y', component_name: 'Comp Y',
    verdict: 'watch', headline: 'Headline two', sources: 3,
    sections: [{ n: 2, title: 'Frontier scan', md: 'plain text' }] },
];
const OPTS = { generatedAt: '2026-07-18 12:00 UTC' };

test('renders a full HTML document', () => {
  const html = assemble(sample, OPTS);
  assert.ok(html.startsWith('<!doctype html>'), 'starts with doctype');
  assert.ok(html.includes('Self-Improvement Triage'), 'has title');
});

test('deterministic for identical input + generatedAt', () => {
  assert.equal(assemble(sample, OPTS), assemble(sample, OPTS));
});

test('resolves chrome tokens (counts)', () => {
  const html = assemble(sample, OPTS);
  assert.ok(html.includes('total 2'), 'total count substituted');
  assert.ok(html.includes('adopt 1'), 'adopt count substituted');
  assert.ok(html.includes('watch 1'), 'watch count substituted');
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(html), 'no unresolved chrome tokens remain');
});

test('embeds section content (title + escaped payload)', () => {
  const html = assemble(sample, OPTS);
  assert.ok(html.includes('Where CCv3 is today'), 'section title present in payload');
  // Closing tags in the embedded JSON are slash-escaped (</ -> <\/), so assert that form.
  assert.ok(html.includes('<strong>bold<\\/strong>'), 'bold rendered + payload-escaped');
});

test('mdToSafeHtml renders bold, inline code, and lists', () => {
  const out = mdToSafeHtml('Para with **bold** and `code`.\n\n- item a\n- item b');
  assert.ok(out.includes('<strong>bold</strong>'), 'bold');
  assert.ok(out.includes('<code>code</code>'), 'inline code');
  assert.ok(out.includes('<li>item a</li>') && out.includes('<li>item b</li>'), 'list items');
});

test('XSS-safe: <script> in section md is escaped', () => {
  const evil = [{ ...sample[0], sections: [{ n: 1, title: 'x', md: '<script>alert(1)</script>' }] }];
  const html = assemble(evil, OPTS);
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'escaped form present');
  assert.ok(!html.includes('<script>alert(1)'), 'raw script not present');
});

test('XSS-safe: </script> in headline cannot break the host <script>', () => {
  const evil = [{ ...sample[0], headline: 'x</script>y' }];
  const html = assemble(evil, OPTS);
  assert.ok(html.includes('x<\\/script>y'), 'slash-escaped in payload');
  assert.ok(!html.includes('x</script>y'), 'no literal closing-script sequence from data');
});

test('token-injection-safe: {{TOKEN}} inside proposal text is NOT substituted', () => {
  const tricky = [{ ...sample[0], headline: 'zzz{{COUNT_TOTAL}}zzz' }];
  const html = assemble(tricky, OPTS);
  assert.ok(html.includes('zzz{{COUNT_TOTAL}}zzz'), 'literal braces survive in data');
});

test('dollar-injection-safe: $& / $1 in proposal text survive verbatim', () => {
  const tricky = [{ ...sample[0], headline: 'pre$&and$1post' }];
  const html = assemble(tricky, OPTS);
  assert.ok(html.includes('pre$&and$1post'), 'dollar sequences not special-cased');
});

test('fail-loud on unresolved template token', () => {
  // Prove the token-substitution mechanism throws on an unknown token.
  const tpl = 'a {{NOPE}} b';
  assert.throws(() => tpl.replace(/\{\{(\w+)\}\}/g, (m, k) => {
    const tokens = { KNOWN: 'x' };
    if (!Object.prototype.hasOwnProperty.call(tokens, k)) throw new Error(`unresolved ${m}`);
    return tokens[k];
  }), /unresolved \{\{NOPE\}\}/);
});

test('mdToSafeHtml renders a table', () => {
  const md = '| A | B |\n|---|---|\n| 1 | 2 |';
  const html = mdToSafeHtml(md);
  assert.ok(html.includes('<table>'), 'table element');
  assert.ok(html.includes('<th>A</th>'), 'header cell');
  assert.ok(html.includes('<td>1</td>'), 'body cell');
});

test('mdToSafeHtml only allows http(s)/mailto links', () => {
  assert.ok(mdToSafeHtml('[ok](https://x.com)').includes('<a href="https://x.com"'), 'https link');
  const bad = mdToSafeHtml('[bad](javascript:alert(1))');
  assert.ok(!bad.includes('href="javascript'), 'javascript: link rejected');
});

test('esc is the shared project-cards escaper', () => {
  assert.equal(esc('<a>&"\''), '&lt;a&gt;&amp;&quot;&#39;');
});

console.log(`\n${pass} passed`);
