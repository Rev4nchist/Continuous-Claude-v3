#!/usr/bin/env node
/**
 * Skill Router API - TypeScript Implementation
 *
 * Provides deterministic skill/agent routing for workflow orchestration.
 * Mirrors the Python implementation for native performance in hooks.
 *
 * USAGE:
 *   # As module import
 *   import { route } from './skill-router.js';
 *   const result = route({ task: "debug auth errors", files: [] });
 *
 *   # As CLI (JSON stdin)
 *   echo '{"task": "implement feature"}' | node dist/skill-router.mjs
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import {
    SkillRouterAPIInput,
    SkillRouterAPIOutput,
    SkillRouterMatch,
    AgentRouterMatch,
    OrchestrationPattern,
    ComplexityScore,
    PromptSignal,
    FileSignal,
    SkillRulesConfig,
    SkillRule,
    SkillLookupResult,
    CircularDependencyError,
} from '../shared/skill-router-types.js';

// =============================================================================
// Configuration Constants
// =============================================================================

const PROMPT_WEIGHTS = {
    multiple_files: 0.2,
    task_conjunctions: 0.15,
    uncertainty_markers: 0.1,
    architecture_keywords: 0.3,
    debug_intermittent: 0.25,
    new_project_intent: 0.35,
};

const FILE_WEIGHTS = {
    imports_over_10: 0.15,
    cross_module: 0.2,
    test_files: 0.1,
    config_files: 0.15,
};

const COMPLEXITY_THRESHOLD_SUGGEST = 0.5;
const COMPLEXITY_THRESHOLD_FORCE = 0.7;

// =============================================================================
// Pattern Safety Helpers
// =============================================================================

/** Maximum allowed regex pattern length (chars). Patterns above this are skipped. */
const MAX_INTENT_PATTERN_LENGTH = 200;

/** Whitelist of orchestration pattern names accepted from untrusted JSON input. */
const KNOWN_ORCHESTRATION_PATTERNS: ReadonlySet<string> = new Set([
  'swarm',
  'hierarchical',
  'pipeline',
  'generator_critic',
  'adversarial',
  'map_reduce',
  'jury',
  'blackboard',
  'chain_of_responsibility',
  'event_driven',
  'circuit_breaker',
]);

/**
 * Heuristic regex shapes commonly associated with catastrophic backtracking.
 * Reject any pattern that contains nested quantifiers like `(...+)+`, `(...*)*`,
 * `(...+)*`, `(...*)+`, or alternations of identical branches like `(a|a)+`.
 * Conservative: prefers false-rejects over executing a potentially evil pattern.
 */
const REDOS_SHAPES: RegExp[] = [
  /\([^)]*[+*][^)]*\)\s*[+*]/,           // (X+)+ , (X*)*, (X+)*, (X*)+ etc.
  /\(([^|()]+)\|\1\)\s*[+*]/,            // (a|a)+
  // Overlapping alternations like (a|aa)+ where one branch is a prefix of another.
  // These bypass the identical-branch check above but exhibit the same exponential
  // backtracking on inputs like "aaaa...x".
  /\(([^|()]+)\|(\1[^|()]*|[^|()]*\1)\)\s*[+*]/,
];

/**
 * Validate an intent pattern string before passing it to `new RegExp(...)`.
 * Returns null when the pattern is safe to compile, else a short reason.
 */
function validateIntentPattern(pattern: unknown): string | null {
  if (typeof pattern !== 'string') return 'pattern is not a string';
  if (pattern.length === 0) return 'pattern is empty';
  if (pattern.length > MAX_INTENT_PATTERN_LENGTH) {
    return `pattern length ${pattern.length} > ${MAX_INTENT_PATTERN_LENGTH}`;
  }
  for (const shape of REDOS_SHAPES) {
    if (shape.test(pattern)) return 'pattern matches known catastrophic-backtracking shape';
  }
  return null;
}

const PATTERN_AGENT_MAP: Record<string, string> = {
    swarm: 'research-agent',
    hierarchical: 'kraken',
    pipeline: 'kraken',
    generator_critic: 'review-agent',
    adversarial: 'validate-agent',
    map_reduce: 'kraken',
    jury: 'validate-agent',
    event_driven: 'kraken',
    circuit_breaker: 'kraken',
};

const AGENT_TYPES: Record<string, string> = {
    scout: 'exploration',
    oracle: 'research',
    architect: 'planning',
    phoenix: 'refactoring',
    kraken: 'implementation',
    spark: 'quick-fix',
    arbiter: 'testing',
    atlas: 'e2e-testing',
    critic: 'review',
    judge: 'review',
    surveyor: 'review',
    liaison: 'integration',
    sleuth: 'debugging',
    'debug-agent': 'debugging',
    aegis: 'security',
    profiler: 'performance',
    herald: 'release',
    scribe: 'documentation',
};

// =============================================================================
// Skill Rules Loading
// =============================================================================

function loadSkillRules(): SkillRulesConfig {
    const homeDir = homedir();
    const rulesPath = join(homeDir, '.claude', 'skills', 'skill-rules.json');

    if (!existsSync(rulesPath)) {
        return { skills: {}, agents: {} };
    }

    try {
        const content = readFileSync(rulesPath, 'utf-8');
        return JSON.parse(content) as SkillRulesConfig;
    } catch {
        return { skills: {}, agents: {} };
    }
}

// =============================================================================
// Prerequisite Resolution & Dependency Analysis
// =============================================================================

/**
 * Detect circular dependencies in skill prerequisites using DFS.
 * Returns the cycle path if found, or null if no cycle exists.
 */
export function detectCircularDependency(
    skillName: string,
    rules: SkillRulesConfig
): string[] | null {
    const visited = new Set<string>();

    function dfs(current: string, path: string[], pathSet: Set<string>): string[] | null {
        if (pathSet.has(current)) {
            const cycleStart = path.indexOf(current);
            return path.slice(cycleStart).concat(current);
        }

        if (visited.has(current)) {
            return null;
        }

        path.push(current);
        pathSet.add(current);
        visited.add(current);

        const skill = rules.skills[current];
        if (skill?.prerequisites) {
            const neighbors = [
                ...(skill.prerequisites.suggest || []),
                ...(skill.prerequisites.require || []),
            ];
            for (const neighbor of neighbors) {
                const result = dfs(neighbor, path, pathSet);
                if (result !== null) {
                    return result;
                }
            }
        }

        path.pop();
        pathSet.delete(current);
        return null;
    }

    return dfs(skillName, [], new Set<string>());
}

/**
 * Topological sort of skill dependencies using Kahn's algorithm.
 * Returns skills in dependency-first order (roots first, target last).
 * Throws CircularDependencyError if a cycle is detected.
 */
export function topologicalSort(
    skillName: string,
    rules: SkillRulesConfig
): string[] {
    // Step 1: Collect all reachable nodes via BFS
    const reachable = new Set<string>();
    const queue = [skillName];
    while (queue.length > 0) {
        const current = queue.shift()!;
        if (reachable.has(current)) continue;
        reachable.add(current);
        const skill = rules.skills[current];
        if (skill?.prerequisites) {
            const deps = [
                ...(skill.prerequisites.suggest || []),
                ...(skill.prerequisites.require || []),
            ];
            for (const dep of deps) {
                queue.push(dep);
            }
        }
    }

    // Step 2: Build adjacency list and in-degree map
    const inDegree = new Map<string, number>();
    const adjList = new Map<string, string[]>();

    for (const node of reachable) {
        inDegree.set(node, 0);
        adjList.set(node, []);
    }

    for (const node of reachable) {
        const skill = rules.skills[node];
        if (skill?.prerequisites) {
            const deps = [
                ...(skill.prerequisites.suggest || []),
                ...(skill.prerequisites.require || []),
            ];
            for (const dep of deps) {
                if (reachable.has(dep)) {
                    adjList.get(dep)!.push(node);
                    inDegree.set(node, (inDegree.get(node) || 0) + 1);
                }
            }
        }
    }

    // Step 3: Kahn's algorithm with alphabetical ordering for determinism
    const sorted: string[] = [];
    const kahnQueue = Array.from(reachable)
        .filter(n => inDegree.get(n) === 0)
        .sort();

    while (kahnQueue.length > 0) {
        const current = kahnQueue.shift()!;
        sorted.push(current);
        for (const dependent of adjList.get(current) || []) {
            const newDegree = (inDegree.get(dependent) || 1) - 1;
            inDegree.set(dependent, newDegree);
            if (newDegree === 0) {
                // Insert in sorted position for determinism
                const insertIdx = kahnQueue.findIndex(q => q > dependent);
                if (insertIdx === -1) {
                    kahnQueue.push(dependent);
                } else {
                    kahnQueue.splice(insertIdx, 0, dependent);
                }
            }
        }
    }

    // Step 4: Cycle detection
    if (sorted.length !== reachable.size) {
        const remaining = Array.from(reachable).filter(n => !sorted.includes(n));
        const cyclePath = detectCircularDependency(remaining[0], rules) || remaining;
        throw new CircularDependencyError(cyclePath);
    }

    return sorted;
}

/**
 * Get the loading mode for a skill.
 * Returns 'lazy' as default, warns on invalid modes.
 */
export function getLoadingMode(
    skillName: string,
    rules: SkillRulesConfig
): 'lazy' | 'eager' | 'eager-prerequisites' {
    const skill = rules.skills[skillName];
    if (!skill) return 'lazy';

    const mode = skill.loading;
    if (!mode) return 'lazy';

    const validModes = ['lazy', 'eager', 'eager-prerequisites'];
    if (!validModes.includes(mode)) {
        console.warn(`Skill "${skillName}" has invalid loading mode "${mode}", defaulting to lazy`);
        return 'lazy';
    }

    return mode;
}

/**
 * Resolve co-activation peers for a skill.
 * Filters self-references and warns about non-existent peers.
 */
export function resolveCoActivation(
    skillName: string,
    rules: SkillRulesConfig
): { peers: string[]; mode: 'all' | 'any' } {
    const skill = rules.skills[skillName];
    if (!skill?.coActivate) {
        return { peers: [], mode: 'any' };
    }

    const peers = skill.coActivate.filter(peer => peer !== skillName);

    for (const peer of peers) {
        if (!rules.skills[peer]) {
            console.warn(`Skill "${skillName}" co-activates non-existent peer "${peer}"`);
        }
    }

    const mode = skill.coActivateMode || 'any';
    return { peers, mode };
}

/**
 * Resolve prerequisites for a skill.
 * Returns direct suggest/require lists and transitive loadOrder via topologicalSort.
 */
export function resolvePrerequisites(
    skillName: string,
    rules: SkillRulesConfig
): { suggest: string[]; require: string[]; loadOrder: string[] } {
    const skill = rules.skills[skillName];
    const suggest = skill?.prerequisites?.suggest || [];
    const require = skill?.prerequisites?.require || [];

    const loadOrder = topologicalSort(skillName, rules);

    return { suggest, require, loadOrder };
}

/**
 * Build an enhanced SkillLookupResult by composing prerequisites,
 * co-activation, and loading mode resolution.
 */
export function buildEnhancedLookupResult(
    baseMatch: { skillName: string; source: 'keyword' | 'intent' | 'memory' | 'jit'; priorityValue: number },
    rules: SkillRulesConfig
): SkillLookupResult {
    const prerequisites = resolvePrerequisites(baseMatch.skillName, rules);
    const coActivation = resolveCoActivation(baseMatch.skillName, rules);
    const loading = getLoadingMode(baseMatch.skillName, rules);

    return {
        found: true,
        skillName: baseMatch.skillName,
        confidence: baseMatch.priorityValue / 3,
        source: baseMatch.source,
        prerequisites,
        coActivation,
        loading,
    };
}

// =============================================================================
// Complexity Scoring
// =============================================================================

function extractPromptSignals(task: string, context: string = ''): PromptSignal[] {
    const signals: PromptSignal[] = [];
    const combined = `${task} ${context}`.toLowerCase();

    // Multiple files mentioned
    const filePattern = /[\w/\\]+\.\w{2,4}/g;
    const filesFound = combined.match(filePattern) || [];
    signals.push({
        name: 'multiple_files',
        weight: filesFound.length > 1 ? PROMPT_WEIGHTS.multiple_files : 0,
        detected: filesFound.length > 1,
        detail: filesFound.length > 1 ? `Found ${filesFound.length} file references` : '',
    });

    // Task conjunctions
    const conjunctions = ['and also', 'and then', 'then also', ', and ', ' also '];
    const conjunctionCount = conjunctions.filter(c => combined.includes(c)).length;
    signals.push({
        name: 'task_conjunctions',
        weight: Math.min(PROMPT_WEIGHTS.task_conjunctions * conjunctionCount, 0.45),
        detected: conjunctionCount > 0,
        detail: conjunctionCount > 0 ? `Found ${conjunctionCount} task conjunctions` : '',
    });

    // Uncertainty markers
    const uncertainty = ['how', 'should i', "what's the best way", 'which approach', 'is it better'];
    const hasUncertainty = uncertainty.some(u => combined.includes(u));
    signals.push({
        name: 'uncertainty_markers',
        weight: hasUncertainty ? PROMPT_WEIGHTS.uncertainty_markers : 0,
        detected: hasUncertainty,
        detail: hasUncertainty ? 'Question/uncertainty detected' : '',
    });

    // Architecture keywords
    const archKeywords = ['refactor', 'migrate', 'redesign', 'restructure', 'architect', 'overhaul'];
    const archFound = archKeywords.filter(k => combined.includes(k));
    signals.push({
        name: 'architecture_keywords',
        weight: archFound.length > 0 ? PROMPT_WEIGHTS.architecture_keywords : 0,
        detected: archFound.length > 0,
        detail: archFound.length > 0 ? `Architecture keywords: ${archFound.join(', ')}` : '',
    });

    // Debug + intermittent pattern
    const debugKeywords = ['debug', 'fix', 'bug', 'error', 'issue'];
    const intermittent = ['intermittent', 'sometimes', 'random', 'sporadic', 'occasional', 'flaky'];
    const hasDebug = debugKeywords.some(d => combined.includes(d));
    const hasIntermittent = intermittent.some(i => combined.includes(i));
    signals.push({
        name: 'debug_intermittent',
        weight: hasDebug && hasIntermittent ? PROMPT_WEIGHTS.debug_intermittent : 0,
        detected: hasDebug && hasIntermittent,
        detail: hasDebug && hasIntermittent ? 'Debug + intermittent pattern detected' : '',
    });

    // New project intent
    const newKeywords = ['build', 'create', 'new', 'implement', 'add feature', 'develop'];
    const scratchKeywords = ['from scratch', 'new project', 'new app', 'new feature', 'greenfield'];
    const hasNew = newKeywords.some(n => combined.includes(n));
    const hasScratch = scratchKeywords.some(s => combined.includes(s));
    signals.push({
        name: 'new_project_intent',
        weight: hasNew && hasScratch ? PROMPT_WEIGHTS.new_project_intent : 0,
        detected: hasNew && hasScratch,
        detail: hasNew && hasScratch ? 'New project/feature intent detected' : '',
    });

    return signals;
}

function extractFileSignals(files: string[], cwd: string = ''): FileSignal[] {
    const signals: FileSignal[] = [];

    if (!files || files.length === 0) {
        return signals;
    }

    // Cross-module changes
    const dirs = new Set<string>();
    for (const f of files) {
        const parts = f.split(/[/\\]/);
        if (parts.length > 1) {
            dirs.add(parts.slice(0, -1).join('/'));
        }
    }
    const crossModule = dirs.size > 1;
    signals.push({
        name: 'cross_module',
        weight: crossModule ? FILE_WEIGHTS.cross_module : 0,
        value: dirs.size,
    });

    // Test files
    const testPatterns = ['.test.', '.spec.', '_test.', '_spec.', 'test_', 'tests/'];
    const testFiles = files.filter(f =>
        testPatterns.some(p => f.toLowerCase().includes(p))
    );
    signals.push({
        name: 'test_files',
        weight: testFiles.length > 0 ? FILE_WEIGHTS.test_files : 0,
        value: testFiles.length,
    });

    // Config files
    const configPatterns = ['package.json', 'tsconfig', 'pyproject.toml', 'setup.py', '.env', 'config'];
    const configFiles = files.filter(f =>
        configPatterns.some(p => f.toLowerCase().includes(p))
    );
    signals.push({
        name: 'config_files',
        weight: configFiles.length > 0 ? FILE_WEIGHTS.config_files : 0,
        value: configFiles.length,
    });

    // Import analysis placeholder
    signals.push({
        name: 'imports_over_10',
        weight: 0,
        value: 0,
    });

    return signals;
}

function calculateComplexity(
    task: string,
    context: string,
    files: string[],
    cwd: string = ''
): ComplexityScore {
    const promptSignals = extractPromptSignals(task, context);
    const fileSignals = extractFileSignals(files, cwd);

    const promptScore = promptSignals
        .filter(s => s.detected)
        .reduce((sum, s) => sum + s.weight, 0);
    const fileScore = fileSignals
        .filter(s => s.weight > 0)
        .reduce((sum, s) => sum + s.weight, 0);
    const total = Math.min(promptScore + fileScore, 1.0);

    let action: 'proceed' | 'suggest_workflow' | 'force_workflow' = 'proceed';
    if (total >= COMPLEXITY_THRESHOLD_FORCE) {
        action = 'force_workflow';
    } else if (total >= COMPLEXITY_THRESHOLD_SUGGEST) {
        action = 'suggest_workflow';
    }

    return {
        total,
        prompt_score: promptScore,
        file_score: fileScore,
        prompt_signals: promptSignals,
        file_signals: fileSignals,
        action,
    };
}

// =============================================================================
// Greenfield Detection
// =============================================================================

function calculateGreenfieldScore(task: string, context: string, cwd: string = ''): number {
    let score = 0;
    const combined = `${task} ${context}`.toLowerCase();

    // Check prompt signals
    const newKeywords = ['build', 'create', 'new', 'implement', 'start', 'init'];
    if (newKeywords.some(k => combined.includes(k))) {
        score += 0.15;
    }

    const scratchKeywords = ['from scratch', 'new project', 'greenfield', 'new app'];
    if (scratchKeywords.some(k => combined.includes(k))) {
        score += 0.2;
    }

    // Check folder state
    if (cwd && existsSync(cwd)) {
        // No .git
        if (!existsSync(join(cwd, '.git'))) {
            score += 0.1;
        }
        // No package.json or pyproject.toml
        if (!existsSync(join(cwd, 'package.json')) && !existsSync(join(cwd, 'pyproject.toml'))) {
            score += 0.1;
        }
        // Few files
        try {
            const entries = readdirSync(cwd);
            const fileCount = entries.filter(e => {
                try {
                    return statSync(join(cwd, e)).isFile();
                } catch {
                    return false;
                }
            }).length;
            if (fileCount < 5) {
                score += 0.1;
            }
        } catch {
            // Ignore directory read errors
        }
    }

    return Math.min(score, 1.0);
}

// =============================================================================
// Skill Matching
// =============================================================================

function matchSkills(task: string, context: string, rules: SkillRulesConfig): SkillRouterMatch[] {
    const matches: SkillRouterMatch[] = [];
    const combined = `${task} ${context}`.toLowerCase();

    const skills = rules.skills || {};
    for (const [skillName, config] of Object.entries(skills)) {
        const triggers = config.promptTriggers;
        if (!triggers) continue;

        // Keyword matching
        const keywords = triggers.keywords || [];
        let matchedKeyword: string | null = null;
        for (const kw of keywords) {
            if (combined.includes(kw.toLowerCase())) {
                matchedKeyword = kw;
                break;
            }
        }

        // Intent pattern matching
        const intentPatterns = triggers.intentPatterns || [];
        let matchedIntent = false;
        for (const pattern of intentPatterns) {
            const reason = validateIntentPattern(pattern);
            if (reason) {
                console.warn(`[skill-router] skipping unsafe intent pattern for skill "${skillName}": ${reason}`);
                continue;
            }
            try {
                const regex = new RegExp(pattern, 'i');
                if (regex.test(combined)) {
                    matchedIntent = true;
                    break;
                }
            } catch {
                continue;
            }
        }

        if (matchedKeyword || matchedIntent) {
            const matchType = matchedIntent ? 'intent' : 'keyword';
            const confidence = matchedIntent ? 0.9 : 0.75;

            matches.push({
                name: skillName,
                enforcement: config.enforcement || 'suggest',
                priority: config.priority || 'medium',
                confidence,
                reason: `${matchedIntent ? 'Intent pattern' : 'Keyword'} match: ${matchedKeyword || 'pattern'}`,
                match_type: matchType as 'keyword' | 'intent' | 'file_type' | 'llm_assist',
            });
        }
    }

    // Sort by priority and confidence
    const priorityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    matches.sort((a, b) => {
        const pa = priorityOrder[a.priority] ?? 4;
        const pb = priorityOrder[b.priority] ?? 4;
        if (pa !== pb) return pa - pb;
        return b.confidence - a.confidence;
    });

    return matches;
}

function matchAgents(
    task: string,
    context: string,
    rules: SkillRulesConfig,
    exclude: string[] = []
): AgentRouterMatch[] {
    const matches: AgentRouterMatch[] = [];
    const combined = `${task} ${context}`.toLowerCase();

    const agents = rules.agents || {};
    for (const [agentName, config] of Object.entries(agents)) {
        if (exclude.includes(agentName)) continue;

        const triggers = config.promptTriggers;
        if (!triggers) continue;

        // Keyword matching
        const keywords = triggers.keywords || [];
        let matchedKeyword: string | null = null;
        for (const kw of keywords) {
            if (combined.includes(kw.toLowerCase())) {
                matchedKeyword = kw;
                break;
            }
        }

        // Intent pattern matching
        const intentPatterns = triggers.intentPatterns || [];
        let matchedIntent = false;
        for (const pattern of intentPatterns) {
            const reason = validateIntentPattern(pattern);
            if (reason) {
                console.warn(`[skill-router] skipping unsafe intent pattern for agent "${agentName}": ${reason}`);
                continue;
            }
            try {
                const regex = new RegExp(pattern, 'i');
                if (regex.test(combined)) {
                    matchedIntent = true;
                    break;
                }
            } catch {
                continue;
            }
        }

        if (matchedKeyword || matchedIntent) {
            const confidence = matchedIntent ? 0.85 : 0.7;

            matches.push({
                name: agentName,
                type: AGENT_TYPES[agentName] || (config as SkillRule).type || 'general',
                confidence,
                reason: `${matchedIntent ? 'Intent pattern' : 'Keyword'} match`,
            });
        }
    }

    // Sort by confidence
    matches.sort((a, b) => b.confidence - a.confidence);

    return matches;
}

// =============================================================================
// Pattern Recommendation
// =============================================================================

function recommendPattern(
    task: string,
    context: string,
    skills: SkillRouterMatch[],
    complexity: number
): OrchestrationPattern | null {
    const combined = `${task} ${context}`.toLowerCase();

    // Research patterns
    if (['research', 'find', 'explore', 'understand', 'analyze'].some(k => combined.includes(k))) {
        if (['multiple', 'compare', 'different'].some(k => combined.includes(k))) {
            return 'swarm';
        }
        return 'hierarchical';
    }

    // Implementation patterns
    if (['implement', 'build', 'create', 'add'].some(k => combined.includes(k))) {
        if (complexity >= 0.7) {
            return 'pipeline';
        }
        return 'hierarchical';
    }

    // Debug patterns
    if (['debug', 'fix', 'investigate', 'root cause'].some(k => combined.includes(k))) {
        return 'hierarchical';
    }

    // Review patterns
    if (['review', 'validate', 'check', 'audit'].some(k => combined.includes(k))) {
        if (combined.includes('critical') || combined.includes('security')) {
            return 'jury';
        }
        return 'generator_critic';
    }

    // Refactoring patterns
    if (['refactor', 'migrate', 'upgrade'].some(k => combined.includes(k))) {
        return 'pipeline';
    }

    // Default based on complexity
    if (complexity >= 0.7) {
        return 'hierarchical';
    }

    return null;
}

// =============================================================================
// Main Router Function
// =============================================================================

export function route(input: SkillRouterAPIInput): SkillRouterAPIOutput {
    const {
        task,
        context = '',
        files = [],
        current_pattern,
        exclude_agents = [],
        cwd = '',
    } = input;

    // Load rules
    const rules = loadSkillRules();

    // Calculate complexity
    const complexity = calculateComplexity(task, context, files, cwd);

    // Calculate greenfield score
    const greenfield = calculateGreenfieldScore(task, context, cwd);

    // Match skills
    const skills = matchSkills(task, context, rules);

    // Match agents
    const agents = matchAgents(task, context, rules, exclude_agents);

    // Recommend pattern -- only honor a caller-supplied current_pattern when it
    // matches the known orchestration whitelist; otherwise ignore it and fall back.
    const trustedCurrentPattern =
        typeof current_pattern === 'string' && KNOWN_ORCHESTRATION_PATTERNS.has(current_pattern)
            ? (current_pattern as OrchestrationPattern)
            : null;
    const pattern = trustedCurrentPattern ||
        recommendPattern(task, context, skills, complexity.total);

    // Suggest Ralph for greenfield
    const suggestRalph = greenfield > 0.4;

    return {
        skills,
        agents,
        complexity_score: Math.round(complexity.total * 1000) / 1000,
        recommended_pattern: pattern,
        llm_assisted: false,
        greenfield_score: Math.round(greenfield * 1000) / 1000,
        suggest_ralph: suggestRalph,
    };
}

// =============================================================================
// CLI Interface
// =============================================================================

async function main() {
    // Read JSON from stdin
    let inputData: SkillRouterAPIInput;

    if (process.stdin.isTTY) {
        // No piped input — print usage to stderr so JSON consumers don't choke
        // on the help text mixed into stdout.
        console.error('skill-router: expected JSON on stdin (e.g. echo \'{"task":"..."}\' | skill-router)');
        process.exit(2);
    }

    try {
        const input = readFileSync(0, 'utf-8');
        inputData = JSON.parse(input);
    } catch {
        console.error('skill-router: invalid JSON input or no input provided');
        process.exit(1);
    }

    // Validate payload shape before routing. JSON.parse accepts arrays,
    // strings, numbers, and {"task": ""} -- all of which would silently
    // produce empty/garbage routing decisions downstream.
    if (
        !inputData ||
        typeof inputData !== 'object' ||
        Array.isArray(inputData) ||
        typeof (inputData as { task?: unknown }).task !== 'string' ||
        (inputData as { task: string }).task.trim().length === 0
    ) {
        console.error('skill-router: input must be an object with a non-empty "task" string');
        process.exit(1);
    }

    const result = route(inputData);
    console.log(JSON.stringify(result, null, 2));
}

// Only run CLI if executed directly. Use a strict file-URL comparison so
// importing this module from another bundle never triggers main(); a
// substring check on argv[1] would fire for any path containing
// 'skill-router' (including symlinks, build artifacts, or test wrappers).
const isDirectExecution =
    typeof process.argv[1] === 'string' &&
    resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
    main().catch(err => {
        console.error('Error:', err);
        process.exit(1);
    });
}
