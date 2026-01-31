#!/usr/bin/env node
/**
 * PRD/Task Template Enforcer Hook
 *
 * PreToolUse hook that enforces ai-dev-tasks template compliance for PRD and task files.
 *
 * Triggers on: Write tool calls for PRD/task files
 * Enforces:
 *   - Correct file location (/tasks/ directory)
 *   - Correct filename format (prd-*.md, tasks-*.md)
 *   - Task files use checkbox format (- [ ])
 *   - PRD files have required sections
 */

import { readFileSync } from 'fs';

interface HookInput {
    event: string;
    tool_name?: string;
    tool_input?: {
        file_path?: string;
        content?: string;
    };
}

interface HookOutput {
    decision: 'allow' | 'block';
    reason?: string;
}

// Detect if this is a PRD or task file based on content
function detectFileType(content: string, filePath: string): 'prd' | 'task' | 'unknown' {
    const lowerPath = filePath.toLowerCase();
    const lowerContent = content.toLowerCase();

    // Check filename patterns
    if (lowerPath.includes('prd') || lowerPath.includes('product-requirements')) {
        return 'prd';
    }
    if (lowerPath.includes('task')) {
        return 'task';
    }

    // Check content patterns
    if (lowerContent.includes('product requirements') ||
        lowerContent.includes('## goals') && lowerContent.includes('## user stories')) {
        return 'prd';
    }
    if (lowerContent.includes('## tasks') ||
        (lowerContent.includes('- [ ]') && lowerContent.includes('sub-task'))) {
        return 'task';
    }

    return 'unknown';
}

// Check if file is in correct location
function checkLocation(filePath: string): { valid: boolean; error?: string } {
    // Allow /tasks/ directory (relative or absolute)
    if (filePath.includes('/tasks/') || filePath.includes('\\tasks\\')) {
        return { valid: true };
    }

    // Block /docs/ directory for PRD/task files
    if (filePath.includes('/docs/') || filePath.includes('\\docs\\')) {
        return {
            valid: false,
            error: `PRD/Task files must be saved to /tasks/ directory, not /docs/. Use: /tasks/${filePath.split(/[/\\]/).pop()}`
        };
    }

    // For other locations, warn but allow
    return { valid: true };
}

// Validate task file format
function validateTaskFormat(content: string): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // Check for checkbox format
    const hasCheckboxes = content.includes('- [ ]') || content.includes('- [x]');
    if (!hasCheckboxes) {
        errors.push('Task files MUST use checkbox format: "- [ ] 1.1 Task description"');
        errors.push('Found non-standard format. Reference ~/.claude/ai-dev-tasks/generate-tasks.md');
    }

    // Check for markdown header task format (wrong)
    const headerTaskPattern = /^###\s+T?\d+\.\d+/m;
    if (headerTaskPattern.test(content)) {
        errors.push('Task files should NOT use header format (### T1.1). Use checkbox format instead.');
    }

    // Check for "Relevant Files" section (required by template)
    if (!content.includes('## Relevant Files') && !content.includes('## relevant files')) {
        errors.push('Missing "## Relevant Files" section. See generate-tasks.md template.');
    }

    // Check for instructions section
    if (!content.includes('Instructions for Completing Tasks') &&
        !content.includes('instructions for completing tasks')) {
        errors.push('Missing "Instructions for Completing Tasks" section. See generate-tasks.md template.');
    }

    return { valid: errors.length === 0, errors };
}

// Validate PRD file format
function validatePrdFormat(content: string): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    const lowerContent = content.toLowerCase();

    // Required sections from create-prd.md template
    const requiredSections = [
        { name: 'Introduction/Overview', patterns: ['## introduction', '## overview', '# introduction', '# overview'] },
        { name: 'Goals', patterns: ['## goals', '# goals'] },
        { name: 'User Stories', patterns: ['## user stories', '# user stories'] },
        { name: 'Functional Requirements', patterns: ['## functional requirements', '# functional requirements', '## requirements'] },
        { name: 'Non-Goals', patterns: ['## non-goals', '## out of scope', '# non-goals'] },
    ];

    for (const section of requiredSections) {
        const hasSection = section.patterns.some(p => lowerContent.includes(p));
        if (!hasSection) {
            errors.push(`Missing required section: "${section.name}". See create-prd.md template.`);
        }
    }

    return { valid: errors.length === 0, errors };
}

// Check filename format
function checkFilename(filePath: string, fileType: 'prd' | 'task'): { valid: boolean; error?: string } {
    const filename = filePath.split(/[/\\]/).pop() || '';
    const lowerFilename = filename.toLowerCase();

    if (fileType === 'prd') {
        // Should be prd-<feature>.md
        if (!lowerFilename.startsWith('prd-') || !lowerFilename.endsWith('.md')) {
            return {
                valid: false,
                error: `PRD filename should be "prd-<feature>.md", got "${filename}"`
            };
        }
    } else if (fileType === 'task') {
        // Should be tasks-<feature>.md
        if (!lowerFilename.startsWith('tasks-') || !lowerFilename.endsWith('.md')) {
            return {
                valid: false,
                error: `Task filename should be "tasks-<feature>.md", got "${filename}"`
            };
        }
    }

    return { valid: true };
}

function main() {
    try {
        const input = readFileSync(0, 'utf-8');
        const data: HookInput = JSON.parse(input);

        // Only process PreToolUse for Write tool
        if (data.event !== 'PreToolUse' || data.tool_name !== 'Write') {
            const output: HookOutput = { decision: 'allow' };
            console.log(JSON.stringify(output));
            return;
        }

        const filePath = data.tool_input?.file_path || '';
        const content = data.tool_input?.content || '';

        // Detect file type
        const fileType = detectFileType(content, filePath);

        // If not a PRD or task file, allow
        if (fileType === 'unknown') {
            const output: HookOutput = { decision: 'allow' };
            console.log(JSON.stringify(output));
            return;
        }

        const allErrors: string[] = [];

        // Check location
        const locationCheck = checkLocation(filePath);
        if (!locationCheck.valid && locationCheck.error) {
            allErrors.push(locationCheck.error);
        }

        // Check filename
        const filenameCheck = checkFilename(filePath, fileType);
        if (!filenameCheck.valid && filenameCheck.error) {
            allErrors.push(filenameCheck.error);
        }

        // Validate format based on type
        if (fileType === 'task') {
            const formatCheck = validateTaskFormat(content);
            allErrors.push(...formatCheck.errors);
        } else if (fileType === 'prd') {
            const formatCheck = validatePrdFormat(content);
            allErrors.push(...formatCheck.errors);
        }

        // If errors found, block with detailed message
        if (allErrors.length > 0) {
            let reason = `\n${'━'.repeat(50)}\n`;
            reason += '🚫 PRD/TASK TEMPLATE VIOLATION\n';
            reason += `${'━'.repeat(50)}\n\n`;
            reason += `File type detected: ${fileType.toUpperCase()}\n`;
            reason += `File path: ${filePath}\n\n`;
            reason += 'VIOLATIONS:\n';
            allErrors.forEach((err, i) => {
                reason += `  ${i + 1}. ${err}\n`;
            });
            reason += '\nREQUIRED ACTION:\n';
            reason += '  1. Read the template: ~/.claude/ai-dev-tasks/';
            reason += fileType === 'prd' ? 'create-prd.md\n' : 'generate-tasks.md\n';
            reason += '  2. Follow the template workflow and format\n';
            reason += '  3. Save to /tasks/ directory with correct filename\n';
            reason += `\n${'━'.repeat(50)}\n`;

            const output: HookOutput = { decision: 'block', reason };
            console.log(JSON.stringify(output));
            return;
        }

        // All checks passed
        const output: HookOutput = { decision: 'allow' };
        console.log(JSON.stringify(output));

    } catch (error) {
        // On error, allow (fail open)
        const output: HookOutput = { decision: 'allow' };
        console.log(JSON.stringify(output));
    }
}

main();
