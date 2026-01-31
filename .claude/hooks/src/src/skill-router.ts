#!/usr/bin/env node
/**
 * Skill Router API - TypeScript Implementation
 *
 * Provides deterministic skill/agent routing for Maestro orchestration.
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
import { join } from 'path';
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
} from './shared/skill-router-types.js';

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

const PATTERN_AGENT_MAP: Record<string, string> = {
    swarm: 'research-agent',
    hierarchical: 'kraken',
    pipeline: 'kraken',
    generator_critic: 'review-agent',
    adversarial: 'validate-agent',
    map_reduce: 'kraken',
    jury: 'validate-agent',
    blackboard: 'maestro',
    chain_of_responsibility: 'maestro',
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
    maestro: 'orchestration',
};

// =============================================================================
// Skill Rules Loading
// =============================================================================

function loadSkillRules(): SkillRulesConfig {
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
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

    let action: 'proceed' | 'suggest_maestro' | 'force_maestro' = 'proceed';
    if (total >= COMPLEXITY_THRESHOLD_FORCE) {
        action = 'force_maestro';
    } else if (total >= COMPLEXITY_THRESHOLD_SUGGEST) {
        action = 'suggest_maestro';
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

    // Recommend pattern
    const pattern = (current_pattern as OrchestrationPattern) ||
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

    try {
        const input = readFileSync(0, 'utf-8');
        inputData = JSON.parse(input);
    } catch {
        console.log(JSON.stringify({ error: 'Invalid JSON input or no input provided' }));
        process.exit(1);
    }

    const result = route(inputData);
    console.log(JSON.stringify(result, null, 2));
}

// Only run CLI if executed directly
if (process.argv[1] && process.argv[1].includes('skill-router')) {
    main().catch(err => {
        console.error('Error:', err);
        process.exit(1);
    });
}
