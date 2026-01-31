#!/usr/bin/env node
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';

interface HookInput {
    session_id: string;
    transcript_path: string;
    cwd: string;
    permission_mode: string;
    tool_name: string;
    tool_input: Record<string, unknown>;
}

interface SkillMetadata {
    name: string;
    description: string;
    keywords: string[];
    type: 'skill' | 'agent';
}

interface MatchedItem {
    name: string;
    description: string;
    score: number;
    type: 'skill' | 'agent';
}

let cachedMetadata: SkillMetadata[] | null = null;
let cacheTimestamp = 0;

function tokenize(text: string): string[] {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2)
        .map(w => {
            // Simple stemming: remove common suffixes
            if (w.endsWith('ing') && w.length > 5) return w.slice(0, -3);
            if (w.endsWith('ed') && w.length > 4) return w.slice(0, -2);
            if (w.endsWith('s') && w.length > 3 && !w.endsWith('ss')) return w.slice(0, -1);
            return w;
        });
}

function extractFrontmatter(content: string): { name?: string; description?: string } {
    // Handle both Unix (LF) and Windows (CRLF) line endings
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return {};

    const yaml = match[1];
    const nameMatch = yaml.match(/^name:\s*(.+?)\r?$/m);
    const descMatch = yaml.match(/^description:\s*(.+?)\r?$/m);

    return {
        name: nameMatch?.[1]?.trim(),
        description: descMatch?.[1]?.trim(),
    };
}

function loadSkillsFromFiles(skillsDir: string): SkillMetadata[] {
    const skills: SkillMetadata[] = [];

    if (!existsSync(skillsDir)) return skills;

    function scanDir(dir: string) {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = join(dir, entry.name);
            if (entry.isDirectory() && entry.name !== 'archive' && entry.name !== 'node_modules') {
                const skillFile = join(fullPath, 'SKILL.md');
                if (existsSync(skillFile)) {
                    try {
                        const content = readFileSync(skillFile, 'utf-8');
                        const fm = extractFrontmatter(content);
                        if (fm.name && fm.description) {
                            const keywords = [
                                ...tokenize(fm.name),
                                ...tokenize(fm.description),
                            ];
                            skills.push({
                                name: fm.name,
                                description: fm.description,
                                keywords,
                                type: 'skill',
                            });
                        }
                    } catch {
                        // Skip unreadable files
                    }
                }
                scanDir(fullPath);
            }
        }
    }

    scanDir(skillsDir);
    return skills;
}

function loadAgentsFromRules(rulesPath: string): SkillMetadata[] {
    const agents: SkillMetadata[] = [];

    if (!existsSync(rulesPath)) return agents;

    try {
        const content = readFileSync(rulesPath, 'utf-8');
        const rules = JSON.parse(content);

        if (rules.agents) {
            for (const [name, config] of Object.entries(rules.agents)) {
                const cfg = config as { description?: string; promptTriggers?: { keywords?: string[] } };
                if (cfg.description) {
                    const keywords = [
                        ...tokenize(name),
                        ...tokenize(cfg.description),
                        ...(cfg.promptTriggers?.keywords || []).flatMap(k => tokenize(k)),
                    ];
                    agents.push({
                        name,
                        description: cfg.description,
                        keywords,
                        type: 'agent',
                    });
                }
            }
        }
    } catch {
        // Skip if rules file is invalid
    }

    return agents;
}

function loadAllMetadata(): SkillMetadata[] {
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    const skillsDir = join(homeDir, '.claude', 'skills');
    const rulesPath = join(skillsDir, 'skill-rules.json');

    const now = Date.now();
    if (cachedMetadata && (now - cacheTimestamp) < 60000) {
        return cachedMetadata;
    }

    const skills = loadSkillsFromFiles(skillsDir);
    const agents = loadAgentsFromRules(rulesPath);

    cachedMetadata = [...skills, ...agents];
    cacheTimestamp = now;

    return cachedMetadata;
}

function computeScore(taskWords: string[], itemKeywords: string[]): number {
    if (taskWords.length === 0 || itemKeywords.length === 0) return 0;

    const taskSet = new Set(taskWords);
    const matches = itemKeywords.filter(k => taskSet.has(k));

    const overlap = matches.length;
    const normalizedScore = overlap / Math.sqrt(taskWords.length * itemKeywords.length);

    return normalizedScore;
}

function findRelevantItems(task: string, metadata: SkillMetadata[]): MatchedItem[] {
    const taskWords = tokenize(task);

    return metadata
        .map(item => ({
            name: item.name,
            description: item.description,
            score: computeScore(taskWords, item.keywords),
            type: item.type,
        }))
        .filter(item => item.score > 0.05)
        .sort((a, b) => b.score - a.score)
        .slice(0, 8);
}

function formatOutput(skills: MatchedItem[], agents: MatchedItem[]): string {
    let output = '\n';
    output += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    output += '📋 PLAN MODE ACTIVE\n';
    output += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';

    if (skills.length > 0 || agents.length > 0) {
        output += 'RELEVANT FOR THIS TASK:\n';

        if (skills.length > 0) {
            output += '  Skills:\n';
            for (const skill of skills.slice(0, 4)) {
                const desc = skill.description.length > 50
                    ? skill.description.slice(0, 47) + '...'
                    : skill.description;
                output += `    → /skill:${skill.name} (${desc})\n`;
            }
        }

        if (agents.length > 0) {
            output += '  Agents:\n';
            for (const agent of agents.slice(0, 4)) {
                const desc = agent.description.length > 50
                    ? agent.description.slice(0, 47) + '...'
                    : agent.description;
                output += `    → ${agent.name} (${desc})\n`;
            }
        }

        output += '\n';
    }

    output += 'FORMAT REMINDER:\n';
    output += '  ✗ Keep CONCISE - brevity > grammar\n';
    output += '  ✓ End with "Unresolved Questions:"\n';
    output += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

    return output;
}

async function main() {
    try {
        const input = readFileSync(0, 'utf-8');
        const data: HookInput = JSON.parse(input);

        if (data.tool_name !== 'EnterPlanMode') {
            process.exit(0);
        }

        const transcriptPath = data.transcript_path;
        let task = '';

        if (existsSync(transcriptPath)) {
            try {
                const transcript = readFileSync(transcriptPath, 'utf-8');
                const lines = transcript.split('\n');
                for (let i = lines.length - 1; i >= 0; i--) {
                    const line = lines[i];
                    if (line.startsWith('human:') || line.startsWith('user:')) {
                        task = line.replace(/^(human|user):\s*/i, '');
                        break;
                    }
                }
            } catch {
                // Use empty task if transcript can't be read
            }
        }

        if (!task) {
            console.log(formatOutput([], []));
            process.exit(0);
        }

        const metadata = loadAllMetadata();
        const matched = findRelevantItems(task, metadata);

        const skills = matched.filter(m => m.type === 'skill');
        const agents = matched.filter(m => m.type === 'agent');

        console.log(formatOutput(skills, agents));
        process.exit(0);

    } catch (err) {
        console.error('Error in plan-mode-discovery hook:', err);
        process.exit(0);
    }
}

main();
