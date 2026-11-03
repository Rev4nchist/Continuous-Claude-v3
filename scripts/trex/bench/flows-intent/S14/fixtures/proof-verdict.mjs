import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const climb = (start, rel) => {
  let d = start;
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(path.join(d, rel))) return d;
    const parent = path.dirname(d);
    if (parent === d) return '';
    d = parent;
  }
  return '';
};
const rel = 'scripts/checks/prove-check.mjs';
const root = climb(process.cwd(), rel) || climb(path.dirname(fileURLToPath(import.meta.url)), rel);
if (!root) throw new Error('prove-check.mjs not found');
const { classifyRun, judge } = await import(pathToFileURL(path.join(root, rel)).href);

const treeOf = (text) => {
  const tree = mkdtempSync(path.join(tmpdir(), 's14-'));
  mkdirSync(path.join(tree, 'src'));
  writeFileSync(path.join(tree, 'src', 'a.mjs'), text);
  return tree;
};
const bug = 'userContentEdits(first:20){nodes{editor{login}}}\n';
const preTree = treeOf(`const other = 1;\n${bug}`);
const movedTree = treeOf(`const other = 1;\nconst a = 2;\nconst b = 3;\nconst c = 4;\n${bug}`);
const sg = (line, tree) => ({ code: 0, stderr: '', tree, stdout: JSON.stringify({ errors: [], results: [{ check_id: 'rule-x', path: 'src/a.mjs', start: { line } }] }) });
const row = { major: '#64', check: 'c1', pre: 'p', fix: 'f', paths: ['src/a.mjs'], cmd: ['semgrep', '--json'], fireMatch: 'rule-x src/a\\.mjs:\\d+', fireText: 'userContentEdits\\(first:20\\)\\{nodes', copy: [], expect: { pre: 'fire', fix: 'no-fire' } };
const preRun = sg(2, preTree);
const bugLine = classifyRun(row, preRun).verdict;
const innocent = classifyRun(row, sg(1, preTree)).verdict;
const movedPasses = judge(row, preRun, sg(5, movedTree)).ok ? 'yes' : 'no';
const noJsonPasses = judge(row, preRun, { code: 0, stdout: '', stderr: '', tree: preTree }).ok ? 'yes' : 'no';
const plain = { major: '#64', check: 'c1', pre: 'p', fix: 'f', paths: ['a'], cmd: ['node', '--test'], fireMatch: 'pageInfo bug', copy: [], expect: { pre: 'fire', fix: 'no-fire' } };
const importPasses = judge(plain, { code: 1, stdout: "Cannot find module 'x'\nnot ok 1 - pageInfo bug\n", stderr: '' }, { code: 0, stdout: 'ok\n', stderr: '' }).ok ? 'yes' : 'no';
const line = `bugLine=${bugLine} innocent=${innocent} movedPasses=${movedPasses} noJsonPasses=${noJsonPasses} importPasses=${importPasses}`;
console.log(line);
process.exit(line === 'bugLine=fire innocent=no-fire movedPasses=no noJsonPasses=no importPasses=no' ? 0 : 1);
