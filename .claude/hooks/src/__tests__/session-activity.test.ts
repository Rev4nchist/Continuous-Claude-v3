/**
 * Tests for session activity tracking module.
 *
 * The session-activity module provides a shared interface for hooks and skills
 * to log their activations during a session, and for the HUD to read that data.
 *
 * Storage: ~/.claude/cache/session-activity/{sessionId}.json
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import {
  getActivityPath,
  initActivity,
  logSkill,
  logHook,
  readActivity,
} from '../shared/session-activity.js';

import type { SessionActivity, ActivationEntry } from '../shared/session-activity.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tempDir: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;

const TEST_SESSION_ID = '2583b6ec-b864-4c99-a643-7a931a59142b';

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-activity-test-'));
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = tempDir;
  process.env.USERPROFILE = tempDir;
});

afterEach(() => {
  if (originalHome !== undefined) {
    process.env.HOME = originalHome;
  } else {
    delete process.env.HOME;
  }
  if (originalUserProfile !== undefined) {
    process.env.USERPROFILE = originalUserProfile;
  } else {
    delete process.env.USERPROFILE;
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// getActivityPath
// ---------------------------------------------------------------------------

describe('getActivityPath', () => {
  it('returns a path under ~/.claude/cache/session-activity/', () => {
    const result = getActivityPath(TEST_SESSION_ID);
    expect(result).toContain('session-activity');
    expect(result).toContain(TEST_SESSION_ID);
    expect(result).toMatch(/\.json$/);
  });

  it('creates the directory if it does not exist', () => {
    const result = getActivityPath(TEST_SESSION_ID);
    const dir = path.dirname(result);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('does not throw if directory already exists', () => {
    getActivityPath(TEST_SESSION_ID);
    expect(() => getActivityPath(TEST_SESSION_ID)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// initActivity
// ---------------------------------------------------------------------------

describe('initActivity', () => {
  it('creates an activity file with empty arrays', () => {
    initActivity(TEST_SESSION_ID);

    const filePath = getActivityPath(TEST_SESSION_ID);
    expect(fs.existsSync(filePath)).toBe(true);

    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as SessionActivity;
    expect(data.session_id).toBe(TEST_SESSION_ID);
    expect(data.started_at).toBeDefined();
    expect(data.skills).toEqual([]);
    expect(data.hooks).toEqual([]);
  });

  it('is idempotent -- does not overwrite existing file', () => {
    initActivity(TEST_SESSION_ID);

    // Add some data to the file
    const filePath = getActivityPath(TEST_SESSION_ID);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as SessionActivity;
    data.skills.push({ name: 'test-skill', first_seen: new Date().toISOString(), count: 1 });
    fs.writeFileSync(filePath, JSON.stringify(data));

    // Re-init should NOT overwrite
    initActivity(TEST_SESSION_ID);

    const after = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as SessionActivity;
    expect(after.skills).toHaveLength(1);
    expect(after.skills[0].name).toBe('test-skill');
  });

  it('sets started_at to a valid ISO timestamp', () => {
    initActivity(TEST_SESSION_ID);

    const filePath = getActivityPath(TEST_SESSION_ID);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as SessionActivity;
    const parsed = new Date(data.started_at);
    expect(parsed.getTime()).not.toBeNaN();
  });
});

// ---------------------------------------------------------------------------
// logSkill
// ---------------------------------------------------------------------------

describe('logSkill', () => {
  it('adds a new skill entry with count 1', () => {
    logSkill(TEST_SESSION_ID, 'systematic-debugging');

    const activity = readActivity(TEST_SESSION_ID);
    expect(activity).not.toBeNull();
    expect(activity!.skills).toHaveLength(1);
    expect(activity!.skills[0].name).toBe('systematic-debugging');
    expect(activity!.skills[0].count).toBe(1);
    expect(activity!.skills[0].first_seen).toBeDefined();
  });

  it('increments count for an existing skill', () => {
    logSkill(TEST_SESSION_ID, 'systematic-debugging');
    logSkill(TEST_SESSION_ID, 'systematic-debugging');
    logSkill(TEST_SESSION_ID, 'systematic-debugging');

    const activity = readActivity(TEST_SESSION_ID);
    expect(activity!.skills).toHaveLength(1);
    expect(activity!.skills[0].count).toBe(3);
  });

  it('preserves first_seen timestamp when incrementing', () => {
    logSkill(TEST_SESSION_ID, 'systematic-debugging');
    const firstActivity = readActivity(TEST_SESSION_ID);
    const firstSeen = firstActivity!.skills[0].first_seen;

    logSkill(TEST_SESSION_ID, 'systematic-debugging');
    const secondActivity = readActivity(TEST_SESSION_ID);
    expect(secondActivity!.skills[0].first_seen).toBe(firstSeen);
  });

  it('tracks multiple skills independently', () => {
    logSkill(TEST_SESSION_ID, 'systematic-debugging');
    logSkill(TEST_SESSION_ID, 'memory-awareness');
    logSkill(TEST_SESSION_ID, 'systematic-debugging');

    const activity = readActivity(TEST_SESSION_ID);
    expect(activity!.skills).toHaveLength(2);

    const skill = activity!.skills.find(s => s.name === 'systematic-debugging');
    const memory = activity!.skills.find(s => s.name === 'memory-awareness');
    expect(skill!.count).toBe(2);
    expect(memory!.count).toBe(1);
  });

  it('auto-initializes the activity file if it does not exist', () => {
    // Do NOT call initActivity first
    logSkill(TEST_SESSION_ID, 'auto-init-test');

    const activity = readActivity(TEST_SESSION_ID);
    expect(activity).not.toBeNull();
    expect(activity!.session_id).toBe(TEST_SESSION_ID);
    expect(activity!.skills).toHaveLength(1);
    expect(activity!.skills[0].name).toBe('auto-init-test');
  });
});

// ---------------------------------------------------------------------------
// logHook
// ---------------------------------------------------------------------------

describe('logHook', () => {
  it('adds a new hook entry with count 1', () => {
    logHook(TEST_SESSION_ID, 'session-register');

    const activity = readActivity(TEST_SESSION_ID);
    expect(activity).not.toBeNull();
    expect(activity!.hooks).toHaveLength(1);
    expect(activity!.hooks[0].name).toBe('session-register');
    expect(activity!.hooks[0].count).toBe(1);
  });

  it('increments count for an existing hook', () => {
    logHook(TEST_SESSION_ID, 'file-claims');
    logHook(TEST_SESSION_ID, 'file-claims');

    const activity = readActivity(TEST_SESSION_ID);
    expect(activity!.hooks).toHaveLength(1);
    expect(activity!.hooks[0].count).toBe(2);
  });

  it('tracks hooks and skills separately', () => {
    logSkill(TEST_SESSION_ID, 'systematic-debugging');
    logHook(TEST_SESSION_ID, 'task-router');

    const activity = readActivity(TEST_SESSION_ID);
    expect(activity!.skills).toHaveLength(1);
    expect(activity!.hooks).toHaveLength(1);
    expect(activity!.skills[0].name).toBe('systematic-debugging');
    expect(activity!.hooks[0].name).toBe('task-router');
  });

  it('auto-initializes the activity file if it does not exist', () => {
    logHook(TEST_SESSION_ID, 'auto-init-hook');

    const activity = readActivity(TEST_SESSION_ID);
    expect(activity).not.toBeNull();
    expect(activity!.hooks).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// readActivity
// ---------------------------------------------------------------------------

describe('readActivity', () => {
  it('returns null when no activity file exists', () => {
    const result = readActivity('nonexistent-session-id');
    expect(result).toBeNull();
  });

  it('returns the full activity data when file exists', () => {
    initActivity(TEST_SESSION_ID);
    logSkill(TEST_SESSION_ID, 'skill-a');
    logHook(TEST_SESSION_ID, 'hook-b');

    const result = readActivity(TEST_SESSION_ID);
    expect(result).not.toBeNull();
    expect(result!.session_id).toBe(TEST_SESSION_ID);
    expect(result!.skills).toHaveLength(1);
    expect(result!.hooks).toHaveLength(1);
  });

  it('returns null for corrupt/invalid JSON gracefully', () => {
    const filePath = getActivityPath(TEST_SESSION_ID);
    fs.writeFileSync(filePath, '{invalid json!!!}');

    const result = readActivity(TEST_SESSION_ID);
    expect(result).toBeNull();
  });

  it('returns null for empty file', () => {
    const filePath = getActivityPath(TEST_SESSION_ID);
    fs.writeFileSync(filePath, '');

    const result = readActivity(TEST_SESSION_ID);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Integration: mixed usage
// ---------------------------------------------------------------------------

describe('integration: full lifecycle', () => {
  it('supports a realistic session lifecycle', () => {
    // 1. Session starts
    initActivity(TEST_SESSION_ID);

    // 2. Various hooks and skills fire
    logHook(TEST_SESSION_ID, 'session-register');
    logHook(TEST_SESSION_ID, 'memory-awareness');
    logSkill(TEST_SESSION_ID, 'systematic-debugging');
    logHook(TEST_SESSION_ID, 'file-claims');
    logHook(TEST_SESSION_ID, 'memory-awareness');
    logSkill(TEST_SESSION_ID, 'systematic-debugging');
    logSkill(TEST_SESSION_ID, 'code-review');

    // 3. HUD reads activity
    const activity = readActivity(TEST_SESSION_ID);
    expect(activity).not.toBeNull();
    expect(activity!.session_id).toBe(TEST_SESSION_ID);

    // Verify skills
    expect(activity!.skills).toHaveLength(2);
    const debugging = activity!.skills.find(s => s.name === 'systematic-debugging');
    const review = activity!.skills.find(s => s.name === 'code-review');
    expect(debugging!.count).toBe(2);
    expect(review!.count).toBe(1);

    // Verify hooks
    expect(activity!.hooks).toHaveLength(3);
    const register = activity!.hooks.find(h => h.name === 'session-register');
    const memory = activity!.hooks.find(h => h.name === 'memory-awareness');
    const claims = activity!.hooks.find(h => h.name === 'file-claims');
    expect(register!.count).toBe(1);
    expect(memory!.count).toBe(2);
    expect(claims!.count).toBe(1);
  });
});
