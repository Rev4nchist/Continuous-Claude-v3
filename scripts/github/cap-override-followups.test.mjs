// coord-cap-override-followups, item 3: the ship-ask cap-override question shows the daily cap that pre-pr ENFORCES.
// pre-pr reads the config through loadStricterConfig (the stricter of the checkout file and fork/main). ship-ask read the checkout file only,
// so a checkout cap of 6 on top of a fork/main cap of 3 showed "$6.00" in the question while pre-pr enforced $3.00 (Dave tapped on a cap that was not the one in force).
// End to end: a temp git repo, the real ship-ask.mjs as a child process in it, the JSON of the question read back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SHIP_ASK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ship-ask.mjs');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const config = (cap) => `${JSON.stringify({ coderabbit: { cli_daily_cap_usd: cap }, decisions: { enforce: true } }, null, 2)}\n`;

function repoWith({ mainCap, checkoutCap }) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'capfu-ship-'));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 't@example.com');
  git(root, 'config', 'user.name', 't');
  writeFileSync(path.join(root, 'review-router.config.json'), config(mainCap));
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'main');
  git(root, 'update-ref', 'refs/remotes/fork/main', 'HEAD');
  git(root, 'checkout', '-q', '-b', 'feat/x');
  writeFileSync(path.join(root, 'review-router.config.json'), config(checkoutCap));
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'a.mjs'), 'export const a = 1;\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'feat');
  return root;
}

function question(root, ...flags) {
  const r = spawnSync(process.execPath, [SHIP_ASK, 'cap-override', '--branch', 'feat/x', ...flags, '--json'], { cwd: root, encoding: 'utf8', windowsHide: true, env: { ...process.env, CCV3_PAID_LEDGER: path.join(root, 'no-ledger.jsonl') } });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  return JSON.parse(r.stdout);
}
const textOf = (q) => JSON.stringify(q);

test('I3a: a checkout cap above fork/main shows the cap pre-pr enforces ($3.00), not the checkout file ($6.00)', () => {
  const root = repoWith({ mainCap: 3, checkoutCap: 6 });
  const text = textOf(question(root, '--usd', '7'));
  assert.match(text, /\$3\.00 daily cap/, text);
  assert.doesNotMatch(text, /\$6\.00 daily cap/, text);
});

test('I3b: when the checkout cap is the stricter one, the question shows it', () => {
  const root = repoWith({ mainCap: 6, checkoutCap: 3 });
  const text = textOf(question(root, '--usd', '7'));
  assert.match(text, /\$3\.00 daily cap/, text);
});
