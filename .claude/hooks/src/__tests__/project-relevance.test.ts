/**
 * Tests for shared/project-relevance.ts
 *
 * Cross-project relevance detection for ROADMAP contamination guard.
 * Tests cover both getProjectIdentity and isContentRelevantToProject.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'node:os';

// Mock fs before importing the module under test
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    readFileSync: vi.fn(),
    existsSync: vi.fn(),
  };
});

import {
  getProjectIdentity,
  isContentRelevantToProject,
  ProjectIdentity,
  RelevanceResult,
} from '../shared/project-relevance.js';

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const MOCK_REGISTRY = {
  projects: [
    {
      name: 'continuous-claude',
      path: '/home/testuser/continuous-claude',
      status: 'active',
    },
    {
      name: 'NorthStar Transformation',
      path: '/home/testuser/Projects/northstar-transformation',
      status: 'active',
    },
    {
      name: 'Fourth Connect',
      path: '/home/testuser/Projects/fourth-connect',
      status: 'active',
    },
    {
      name: 'ECG Lead Reactivation Engine',
      path: '/home/testuser/Projects/ECG Lead Reactivation Engine',
      status: 'active',
    },
    {
      name: 'agent-factory',
      path: '/home/testuser/Projects/agent-factory',
      status: 'active',
    },
  ],
};

const MOCK_PACKAGE_JSON = {
  name: 'continuous-claude',
  version: '1.0.0',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockedReadFileSync = vi.mocked(fs.readFileSync);

function setupRegistryMock(projectDir: string, registry: object | null, packageJson: object | null = null) {
  mockedReadFileSync.mockImplementation((filePath: fs.PathOrFileDescriptor, _options?: any) => {
    const p = String(filePath);
    // Resolve like the code does: on Windows path.resolve('/home/x') is 'C:\home\x', so an
    // unresolved key never matches and the read falls through to ENOENT.
    const root = path.resolve(projectDir);
    const registryPath = path.join(root, '.claude', 'project-registry.json');
    const fallbackRegistryPath = path.join(homedir(), 'continuous-claude', '.claude', 'project-registry.json');
    const pkgPath = path.join(root, 'package.json');

    if (registry && (p === registryPath || p === fallbackRegistryPath)) {
      return JSON.stringify(registry);
    }
    if (packageJson && p === pkgPath) {
      return JSON.stringify(packageJson);
    }
    throw new Error(`ENOENT: no such file: ${p}`);
  });
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// =============================================================================
// getProjectIdentity
// =============================================================================

describe('getProjectIdentity', () => {
  it('returns dir basename as dirName', () => {
    setupRegistryMock('/home/testuser/continuous-claude', null);
    const identity = getProjectIdentity('/home/testuser/continuous-claude');
    expect(identity.dirName).toBe('continuous-claude');
  });

  it('extracts keywords from directory name split on hyphens', () => {
    setupRegistryMock('/home/testuser/Projects/northstar-transformation', null);
    const identity = getProjectIdentity('/home/testuser/Projects/northstar-transformation');
    expect(identity.keywords).toContain('northstar');
    expect(identity.keywords).toContain('transformation');
  });

  it('reads registry and finds matching project by path', () => {
    setupRegistryMock('/home/testuser/continuous-claude', MOCK_REGISTRY);
    const identity = getProjectIdentity('/home/testuser/continuous-claude');
    expect(identity.registryName).toBe('continuous-claude');
  });

  it('returns other project names from registry', () => {
    setupRegistryMock('/home/testuser/continuous-claude', MOCK_REGISTRY);
    const identity = getProjectIdentity('/home/testuser/continuous-claude');
    expect(identity.otherProjects).toContain('NorthStar Transformation');
    expect(identity.otherProjects).toContain('Fourth Connect');
    expect(identity.otherProjects).toContain('ECG Lead Reactivation Engine');
    expect(identity.otherProjects).toContain('agent-factory');
    expect(identity.otherProjects).not.toContain('continuous-claude');
  });

  it('handles missing registry gracefully', () => {
    setupRegistryMock('C:/some/unknown/project', null);
    const identity = getProjectIdentity('C:/some/unknown/project');
    expect(identity.registryName).toBeNull();
    expect(identity.otherProjects).toEqual([]);
    expect(identity.dirName).toBe('project');
  });

  it('reads package.json name field', () => {
    setupRegistryMock('/home/testuser/continuous-claude', MOCK_REGISTRY, MOCK_PACKAGE_JSON);
    const identity = getProjectIdentity('/home/testuser/continuous-claude');
    expect(identity.packageName).toBe('continuous-claude');
  });

  it.skipIf(process.platform !== 'win32')('handles Windows paths with mixed separators via path.resolve', () => {
    // path.win32 folds slashes; the POSIX path module does not, so this case is Windows-only.
    const forward = 'C:/Users/ada.lovelace/continuous-claude';
    const registry = {
      projects: MOCK_REGISTRY.projects.map((p) =>
        p.name === 'continuous-claude' ? { ...p, path: forward } : p,
      ),
    };
    setupRegistryMock(forward, registry);
    const identity = getProjectIdentity('C:\\Users\\ada.lovelace\\continuous-claude');
    expect(identity.dirName).toBe('continuous-claude');
    expect(identity.registryName).toBe('continuous-claude');
  });

  it('adds registry name as a keyword', () => {
    setupRegistryMock('/home/testuser/continuous-claude', MOCK_REGISTRY);
    const identity = getProjectIdentity('/home/testuser/continuous-claude');
    expect(identity.keywords).toContain('continuous-claude');
    expect(identity.keywords).toContain('continuous');
    expect(identity.keywords).toContain('claude');
  });

  it('stopwords toxic generic tokens out of distinctiveKeywords', () => {
    setupRegistryMock('/home/testuser/continuous-claude', MOCK_REGISTRY);
    const identity = getProjectIdentity('/home/testuser/continuous-claude');
    // The bare tokens "continuous" and "claude" are poisonous -- they match
    // unrelated plans ("continuous integration", any "claude" mention).
    expect(identity.distinctiveKeywords).not.toContain('continuous');
    expect(identity.distinctiveKeywords).not.toContain('claude');
    // The full multi-token identity survives as a distinctive signal.
    expect(identity.distinctiveKeywords).toContain('continuous-claude');
  });

  it('keeps distinctive single tokens (e.g. northstar) but drops stopwords', () => {
    setupRegistryMock('/home/testuser/Projects/northstar-transformation', MOCK_REGISTRY);
    const identity = getProjectIdentity('/home/testuser/Projects/northstar-transformation');
    expect(identity.distinctiveKeywords).toContain('northstar');
    expect(identity.distinctiveKeywords).toContain('transformation');
  });

  it('records the resolved project path on the identity', () => {
    setupRegistryMock('/home/testuser/continuous-claude', MOCK_REGISTRY);
    const identity = getProjectIdentity('/home/testuser/continuous-claude');
    expect(identity.projectPath).toBe(path.resolve('/home/testuser/continuous-claude'));
  });

  it('collects distinctive tokens of other registered projects', () => {
    setupRegistryMock('/home/testuser/continuous-claude', MOCK_REGISTRY);
    const identity = getProjectIdentity('/home/testuser/continuous-claude');
    expect(identity.otherProjectTokens).toContain('northstar');
    expect(identity.otherProjectTokens).toContain('ecg');
    // Generic stopwords from sibling names must not leak in.
    expect(identity.otherProjectTokens).not.toContain('the');
  });

  it('deduplicates keywords', () => {
    setupRegistryMock('/home/testuser/continuous-claude', MOCK_REGISTRY, MOCK_PACKAGE_JSON);
    const identity = getProjectIdentity('/home/testuser/continuous-claude');
    const uniqueKeywords = [...new Set(identity.keywords)];
    expect(identity.keywords.length).toBe(uniqueKeywords.length);
  });
});

// =============================================================================
// isContentRelevantToProject
// =============================================================================

describe('isContentRelevantToProject', () => {
  // Helper to build a minimal identity for testing
  function makeIdentity(overrides: Partial<ProjectIdentity> = {}): ProjectIdentity {
    return {
      dirName: 'continuous-claude',
      registryName: 'continuous-claude',
      packageName: 'continuous-claude',
      projectPath: '/home/testuser/continuous-claude',
      keywords: ['continuous', 'claude', 'continuous-claude'],
      // distinctiveKeywords drops generic stopwords (continuous, claude, code, ...)
      // and keeps multi-token identity signals.
      distinctiveKeywords: ['continuous-claude'],
      otherProjects: ['NorthStar Transformation', 'Fourth Connect', 'ECG Lead Reactivation Engine'],
      otherProjectTokens: ['northstar', 'transformation', 'fourth', 'connect', 'ecg', 'lead', 'reactivation', 'engine'],
      ...overrides,
    };
  }

  it('returns relevant=false when content mentions NorthStar but identity is continuous-claude', () => {
    const identity = makeIdentity();
    const content = 'Plan: Implement the NorthStar Transformation dashboard with new metrics and charts for the enterprise platform.';
    const result = isContentRelevantToProject(content, identity);
    expect(result.relevant).toBe(false);
    expect(result.confidence).toBe('high');
    expect(result.reason).toContain('NorthStar Transformation');
  });

  it('returns relevant=false when content mentions Fourth Connect but identity is ECG', () => {
    const identity = makeIdentity({
      dirName: 'ECG Lead Reactivation Engine',
      registryName: 'ECG Lead Reactivation Engine',
      packageName: null,
      keywords: ['ecg', 'lead', 'reactivation', 'engine', 'ecg lead reactivation engine'],
      otherProjects: ['continuous-claude', 'NorthStar Transformation', 'Fourth Connect'],
    });
    const content = 'Plan: Update the Fourth Connect dashboard with new brand components and navigation redesign for the platform.';
    const result = isContentRelevantToProject(content, identity);
    expect(result.relevant).toBe(false);
    expect(result.confidence).toBe('high');
    expect(result.reason).toContain('Fourth Connect');
  });

  it('returns relevant=true when content mentions hook development with identity for continuous-claude', () => {
    const identity = makeIdentity();
    const content = 'Plan: Implement the cross-project ROADMAP contamination guard for Continuous Claude hooks. This involves creating a shared utility module and editing three existing hook files.';
    const result = isContentRelevantToProject(content, identity);
    expect(result.relevant).toBe(true);
  });

  it('returns relevant=true when content has no project identifiers (fail-open)', () => {
    const identity = makeIdentity();
    const content = 'Plan: Refactor the authentication system to use JWT tokens instead of session cookies. Add rate limiting to prevent brute force attacks on login endpoints.';
    const result = isContentRelevantToProject(content, identity);
    expect(result.relevant).toBe(true);
    expect(result.confidence).toBe('low');
    expect(result.reason).toBe('no cross-project signals');
  });

  it('returns relevant=true for empty content (fail-open)', () => {
    const identity = makeIdentity();
    const result = isContentRelevantToProject('', identity);
    expect(result.relevant).toBe(true);
    expect(result.confidence).toBe('low');
    expect(result.reason).toBe('content too short');
  });

  it('returns relevant=true for content shorter than 50 chars (fail-open)', () => {
    const identity = makeIdentity();
    const result = isContentRelevantToProject('Short plan about NorthStar', identity);
    expect(result.relevant).toBe(true);
    expect(result.confidence).toBe('low');
    expect(result.reason).toBe('content too short');
  });

  it('returns relevant=true when no other projects in registry (fail-open)', () => {
    // No registry => no sibling names AND no sibling tokens (they derive together).
    const identity = makeIdentity({ otherProjects: [], otherProjectTokens: [] });
    const content = 'Plan: Implement the NorthStar Transformation dashboard with new metrics and charts for the enterprise.';
    const result = isContentRelevantToProject(content, identity);
    expect(result.relevant).toBe(true);
    expect(result.confidence).toBe('low');
    expect(result.reason).toBe('no cross-project signals');
  });

  it('returns relevant=false when identity has empty keywords but other project is mentioned', () => {
    const identity = makeIdentity({
      dirName: 'my-project',
      registryName: null,
      packageName: null,
      keywords: ['my'],  // too short (< 3 chars), will be skipped
      otherProjects: ['NorthStar Transformation'],
    });
    const content = 'Plan: Implement the NorthStar Transformation dashboard with new metrics and charts for the enterprise platform.';
    const result = isContentRelevantToProject(content, identity);
    expect(result.relevant).toBe(false);
    expect(result.confidence).toBe('high');
  });

  it('returns relevant=true when content mentions BOTH this project and another project', () => {
    const identity = makeIdentity();
    const content = 'Plan: Sync the continuous-claude hook system with NorthStar Transformation to share the authentication patterns across both projects.';
    const result = isContentRelevantToProject(content, identity);
    expect(result.relevant).toBe(true);
  });

  it('is case-insensitive when matching project names', () => {
    const identity = makeIdentity();
    const content = 'Plan: Update the northstar transformation platform with new dashboard components and redesigned navigation for better UX.';
    const result = isContentRelevantToProject(content, identity);
    expect(result.relevant).toBe(false);
    expect(result.confidence).toBe('high');
  });

  it('returns relevant=true for null content (fail-open)', () => {
    const identity = makeIdentity();
    const result = isContentRelevantToProject(null as any, identity);
    expect(result.relevant).toBe(true);
    expect(result.confidence).toBe('low');
  });

  it('returns relevant=true for undefined content (fail-open)', () => {
    const identity = makeIdentity();
    const result = isContentRelevantToProject(undefined as any, identity);
    expect(result.relevant).toBe(true);
    expect(result.confidence).toBe('low');
  });

  // ---------------------------------------------------------------------------
  // QW-03 regression suite (D2d-01 positive flip + toxic-keyword stopword fix)
  // ---------------------------------------------------------------------------

  // SEED-02 / Session-9: the post-plan-roadmap hook clobbered continuous-claude's
  // Current Focus with a foreign "Harden the Alpha + Lay a Solid FastMCP v3
  // Foundation" goal mentioning Salesforce/FastMCP. The registered sibling is
  // named "fourth-salesforce-mcp" (its literal name is NOT a substring of the
  // title), so the old registered-name substring check passed it through.
  it('Session-9 regression: BLOCKS a foreign Salesforce/FastMCP goal with no continuous-claude identity', () => {
    const identity = makeIdentity({
      // The sibling distinctive token "salesforce" comes from fourth-salesforce-mcp.
      otherProjects: ['NorthStar Transformation', 'fourth-salesforce-mcp', 'agent-factory'],
      otherProjectTokens: ['northstar', 'transformation', 'fourth', 'salesforce', 'mcp', 'agent', 'factory'],
    });
    const content =
      'Harden the Alpha and Lay a Solid FastMCP v3 Foundation. Ship the approved ' +
      'SOQL COUNT fix first; defer wiring the tool-call rate limiter because Salesforce ' +
      'upstream limits suffice for the 16 users on the hosted MCP server.';
    const result = isContentRelevantToProject(content, identity);
    expect(result.relevant).toBe(false);
    expect(result.confidence).toBe('high');
  });

  it('Session-9 regression: BLOCKS a foreign FastMCP-only goal with no continuous-claude identity', () => {
    const identity = makeIdentity();
    const content =
      'Build out the FastMCP v3 hosted server foundation: harden the alpha, add ' +
      'guardrails and cleanup, and finalize the OAuth token store for the tenant proxy.';
    const result = isContentRelevantToProject(content, identity);
    expect(result.relevant).toBe(false);
    expect(result.confidence).toBe('high');
  });

  // Proves the toxic-keyword stopword fix: before stopwording, the bare token
  // "continuous" (from continuous-claude) matched inside "continuous integration"
  // and "claude" was equally toxic, so a foreign CI plan slipped through fail-open.
  it("'continuous' false-positive: BLOCKS a foreign 'continuous integration pipeline' plan with no real cc identity", () => {
    const identity = makeIdentity();
    const content =
      'Stand up a continuous integration pipeline for the Salesforce deployment service: ' +
      'add build, lint and test stages, then wire automated rollouts to the staging tenant.';
    const result = isContentRelevantToProject(content, identity);
    expect(result.relevant).toBe(false);
    expect(result.confidence).toBe('high');
  });

  it("'claude' false-positive: BLOCKS a foreign plan that only mentions the word 'claude'", () => {
    const identity = makeIdentity();
    const content =
      'Add a Claude-powered chat assistant to the NorthStar Transformation dashboard, ' +
      'wiring streaming responses into the existing enterprise metrics view.';
    const result = isContentRelevantToProject(content, identity);
    expect(result.relevant).toBe(false);
    expect(result.confidence).toBe('high');
  });

  // No regression for legitimate continuous-claude plans: the distinctive
  // identity signal (full "continuous-claude" name) is positive own evidence.
  it('legit plan: ALLOWS a real continuous-claude plan that names the project and its components', () => {
    const identity = makeIdentity();
    const content =
      'Continuous-claude session 9: build and wire codegraph behind /code-intel, ' +
      'reconcile the hooks and memory subsystems, and decide the bus-bias hybrid-recall lift.';
    const result = isContentRelevantToProject(content, identity);
    expect(result.relevant).toBe(true);
  });

  it('legit plan: ALLOWS a continuous-claude plan referenced by project path', () => {
    const identity = makeIdentity();
    const content =
      'Refactor the contamination guard at ' +
      '/home/testuser/continuous-claude/.claude/hooks/src/shared/project-relevance.ts ' +
      'to require positive own-project evidence before writing the ROADMAP Current Focus.';
    const result = isContentRelevantToProject(content, identity);
    expect(result.relevant).toBe(true);
  });

  // Fail-open is preserved ONLY for genuinely ambiguous content (no project-like
  // entity named at all) -- a generic engineering refactor must still pass.
  it('preserves fail-open for genuinely ambiguous content with no project entity', () => {
    const identity = makeIdentity();
    const content =
      'Refactor the authentication system to use JWT tokens instead of session cookies. ' +
      'Add rate limiting to prevent brute force attacks on login endpoints.';
    const result = isContentRelevantToProject(content, identity);
    expect(result.relevant).toBe(true);
    expect(result.confidence).toBe('low');
  });
});
