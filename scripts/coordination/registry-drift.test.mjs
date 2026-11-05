// Unit tests for registry-drift.mjs: do the repo copy and the home mirror of project-registry.json agree on what picks a board?
// CodeRabbit PR 297, project-registry.json:129. A stale mirror gives apps/agentic-os the board 'agentic-os' and `add` writes
// lanes with that project_key. Each test names the change that breaks it: dropping a compared field (key, board, status, root),
// or comparing a field that does not pick a board (notes), or treating an unreadable file as "same".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { registryDrift, mirrorRegistryPath } from './registry-drift.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'regdrift-'));
let n = 0;
const write = (projects) => { const f = path.join(tmp, `r${n++}.json`); fs.writeFileSync(f, JSON.stringify({ version: '1.0', projects })); return f; };
const e = (key, p, extra = {}) => ({ name: key, key, path: p, status: 'active', ...extra });
const REPO = [e('cc', 'C:/Users/x/continuous-claude', { laneBoard: 'continuous-claude' }), e('agentic-os', 'C:/Users/x/continuous-claude/apps/agentic-os', { laneBoard: 'continuous-claude' })];

test('identical board fields are the same, whatever the path spelling, key order or non-board fields', () => {
  const mirror = [
    { ...REPO[1], path: 'c:\\users\\X\\Continuous-Claude\\apps\\agentic-os\\', notes: 'only the mirror has this', stack: ['ts'] },
    { laneBoard: 'continuous-claude', status: 'Active', path: 'C:/Users/x/continuous-claude/', key: 'cc', name: 'renamed display name' },
  ];
  assert.deepEqual(registryDrift(write(REPO), write(mirror)), { state: 'same', diffs: [] });
});

test('a mirror that lacks laneBoard differs and the diff names the key and the board values', () => {
  const stale = [REPO[0], { ...REPO[1], laneBoard: undefined }];
  const r = registryDrift(write(REPO), write(stale));
  assert.equal(r.state, 'differ');
  assert.deepEqual(r.diffs, ['agentic-os: board repo=continuous-claude mirror=agentic-os']);
});

test('a laneBoard that moved a nested entry to its parent board is a board diff', () => {
  const repo = [e('cc', 'C:/p', { laneBoard: 'continuous-claude' }), e('sub', 'C:/p/sub', { laneBoard: 'continuous-claude' })];
  const stale = [e('cc', 'C:/p', { laneBoard: 'continuous-claude' }), e('sub', 'C:/p/sub')];
  const r = registryDrift(write(repo), write(stale));
  assert.deepEqual(r.diffs, ['sub: board repo=continuous-claude mirror=sub']);
});

test('a status change (dead root still active in the mirror) and a changed root are diffs', () => {
  const repo = [e('a', 'C:/a', { status: 'inactive' }), e('b', 'C:/b2')];
  const stale = [e('a', 'C:/a'), e('b', 'C:/b')];
  const r = registryDrift(write(repo), write(stale));
  assert.deepEqual(r.diffs, ['a: status repo=inactive mirror=active', 'b: root repo=c:/b2 mirror=c:/b']);
});

test('a key in only one copy is a diff on that side', () => {
  const r = registryDrift(write([e('a', 'C:/a'), e('new', 'C:/new')]), write([e('a', 'C:/a'), e('gone', 'C:/gone')]));
  assert.deepEqual(r.diffs, ['gone: only in the mirror', 'new: only in the repo copy']);
});

test('a missing or unreadable copy cannot be judged: absent and unreadable are not "same"', () => {
  const ok = write(REPO);
  const bad = path.join(tmp, 'bad.json');
  fs.writeFileSync(bad, '{ not json');
  assert.equal(registryDrift(path.join(tmp, 'nope.json'), ok).state, 'repo-absent');
  assert.equal(registryDrift(ok, path.join(tmp, 'nope.json')).state, 'mirror-absent');
  assert.equal(registryDrift(ok, bad).state, 'unreadable');
  assert.equal(registryDrift(bad, ok).state, 'unreadable');
});

test('mirrorRegistryPath follows the chain lane-board.mjs reads: LANE_REGISTRY_PATH, then USERPROFILE, HOME', () => {
  assert.equal(mirrorRegistryPath({ LANE_REGISTRY_PATH: 'X:/r.json', USERPROFILE: 'U', HOME: 'H' }), 'X:/r.json');
  assert.equal(mirrorRegistryPath({ USERPROFILE: 'U', HOME: 'H' }), path.join('U', '.claude', 'project-registry.json'));
  assert.equal(mirrorRegistryPath({ HOME: 'H' }), path.join('H', '.claude', 'project-registry.json'));
});

// laneArtifact (PR C): the phone page url of a board. The hooks read it from the mirror, so a repo copy that has it and a
// mirror that lacks it leaves the Stop gate blind to the page. Each test fails if fieldsByKey stops comparing laneArtifact.
const PAGE = 'https://claude.ai/artifact/AbCdEf_123-x';

test('a laneArtifact the repo copy has and the mirror lacks is a diff that names the key and both values', () => {
  const repo = [e('gm', 'C:/gm', { laneArtifact: PAGE })];
  const r = registryDrift(write(repo), write([e('gm', 'C:/gm')]));
  assert.equal(r.state, 'differ');
  assert.deepEqual(r.diffs, [`gm: laneArtifact repo=${PAGE} mirror=(none)`]);
});

test('a laneArtifact that differs between the copies is a diff; the same url in both is the same', () => {
  const other = 'https://claude.ai/artifact/Other_9';
  const changed = registryDrift(write([e('gm', 'C:/gm', { laneArtifact: PAGE })]), write([e('gm', 'C:/gm', { laneArtifact: other })]));
  assert.deepEqual(changed.diffs, [`gm: laneArtifact repo=${PAGE} mirror=${other}`]);
  const same = registryDrift(write([e('gm', 'C:/gm', { laneArtifact: PAGE })]), write([{ laneArtifact: PAGE, status: 'Active', path: 'C:/GM/', key: 'gm', name: 'x' }]));
  assert.deepEqual(same, { state: 'same', diffs: [] });
});

test('a mirror that has a laneArtifact the repo copy lacks (a hand edit of the live copy) is a diff', () => {
  const r = registryDrift(write([e('gm', 'C:/gm')]), write([e('gm', 'C:/gm', { laneArtifact: PAGE })]));
  assert.deepEqual(r.diffs, [`gm: laneArtifact repo=(none) mirror=${PAGE}`]);
});
