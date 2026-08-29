import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { PYTHON_EXE, REPO_ROOT, TARGETS_ROOT, YT_ROOT, slugify } from './config.mjs';
import { contentHash, writeJsonAtomic } from './records.mjs';

export function normalizeTargetContent(content) {
  return String(content).replace(/\r\n?/g, '\n');
}

export function hashTargetContent(content) {
  return contentHash(normalizeTargetContent(content));
}

export function verifyTargetBaseline(updatePackage, currentContent) {
  const currentHash = hashTargetContent(currentContent);
  if (currentHash !== updatePackage.baselineHash) {
    return { ok: false, code: 'TARGET_DRIFT', expected: updatePackage.baselineHash, actual: currentHash };
  }
  return { ok: true, currentHash };
}

export function createTargetProfile({ id, path, type, audience, objective, topics = [], updatePolicy = 'draft-only' }) {
  if (!path) throw new Error('Target path is required.');
  const absolutePath = resolve(REPO_ROOT, path);
  if (!absolutePath.startsWith(`${REPO_ROOT}\\`) && absolutePath !== REPO_ROOT) throw new Error('Target must be inside the repository.');
  const targetId = id || slugify(path);
  return { schemaVersion: 1, id: targetId, path, type: type || extname(path).slice(1), audience, objective, topics, updatePolicy, registeredAt: new Date().toISOString() };
}

export function snapshotTextTarget(profile) {
  const absolutePath = resolve(REPO_ROOT, profile.path);
  if (!existsSync(absolutePath)) throw new Error(`Target does not exist: ${profile.path}`);
  const content = readFileSync(absolutePath, 'utf8');
  const sections = [];
  const lines = normalizeTargetContent(content).split('\n');
  lines.forEach((line, index) => {
    const heading = line.match(/^#{1,6}\s+(.+)/) || line.match(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/i);
    if (heading) sections.push({ locator: `line:${index + 1}`, heading: heading[1].replace(/<[^>]+>/g, '') });
  });
  return { targetId: profile.id, capturedAt: new Date().toISOString(), baselineHash: hashTargetContent(content), sections, content };
}

export function snapshotTarget(profile) {
  const extension = extname(profile.path).toLowerCase();
  if (['.md', '.mdx', '.html', '.htm', '.tsx', '.jsx', '.txt'].includes(extension)) return snapshotTextTarget(profile);
  if (extension === '.pptx') {
    const absolutePath = resolve(REPO_ROOT, profile.path);
    if (!existsSync(absolutePath)) throw new Error(`Target does not exist: ${profile.path}`);
    const result = spawnSync(PYTHON_EXE, [join(YT_ROOT, 'python', 'snapshot_pptx.py'), absolutePath], {
      encoding: 'utf8', windowsHide: true, input: '', timeout: 120_000,
    });
    if (result.error) throw new Error(`PPTX adapter unavailable: ${result.error.message}`);
    if (result.status !== 0) throw new Error(`PPTX adapter failed: ${(result.stderr || result.stdout).slice(0, 1200)}`);
    const structured = JSON.parse(result.stdout);
    return { targetId: profile.id, capturedAt: new Date().toISOString(), baselineHash: contentHash(readFileSync(absolutePath)), ...structured };
  }
  throw new Error(`Unsupported target format ${extension || '(none)'}; generate a structured update package without apply.`);
}

export function currentTargetHash(profile) {
  const absolutePath = resolve(REPO_ROOT, profile.path);
  const content = readFileSync(absolutePath);
  return extname(profile.path).toLowerCase() === '.pptx' ? contentHash(content) : hashTargetContent(content.toString('utf8'));
}

export function validateTargetChanges(record) {
  if (!record || !Array.isArray(record.changes)) throw new Error('Impact result must contain changes.');
  const actions = new Set(['add', 'revise', 'retract', 'flag']);
  for (const change of record.changes) {
    if (!actions.has(change.action)) throw new Error(`Invalid target change action: ${change.action}`);
    if (!change.locator || !change.proposedContent || !change.rationale) throw new Error('Each target change needs locator, proposedContent, and rationale.');
    if (!Array.isArray(change.evidenceIds) || !change.evidenceIds.length) throw new Error(`Target change ${change.locator} has no evidence.`);
  }
  return record;
}

export function persistTargetProfile(profile) {
  const path = join(TARGETS_ROOT, profile.id, 'profile.json');
  writeJsonAtomic(path, profile);
  return path;
}
