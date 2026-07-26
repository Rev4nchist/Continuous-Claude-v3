#!/usr/bin/env node
import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/prd-task-template-enforcer.ts
import { readFileSync } from "fs";
function detectFileType(content, filePath) {
  const lowerPath = filePath.toLowerCase();
  const lowerContent = content.toLowerCase();
  if (lowerPath.includes("prd") || lowerPath.includes("product-requirements")) {
    return "prd";
  }
  if (lowerPath.includes("task")) {
    return "task";
  }
  if (lowerContent.includes("product requirements") || lowerContent.includes("## goals") && lowerContent.includes("## user stories")) {
    return "prd";
  }
  if (lowerContent.includes("## tasks") || lowerContent.includes("- [ ]") && lowerContent.includes("sub-task")) {
    return "task";
  }
  return "unknown";
}
function checkLocation(filePath) {
  if (filePath.includes("/tasks/") || filePath.includes("\\tasks\\")) {
    return { valid: true };
  }
  if (filePath.includes("/docs/") || filePath.includes("\\docs\\")) {
    return {
      valid: false,
      error: `PRD/Task files must be saved to /tasks/ directory, not /docs/. Use: /tasks/${filePath.split(/[/\\]/).pop()}`
    };
  }
  return { valid: true };
}
function validateTaskFormat(content) {
  const errors = [];
  const hasCheckboxes = content.includes("- [ ]") || content.includes("- [x]");
  if (!hasCheckboxes) {
    errors.push('Task files MUST use checkbox format: "- [ ] 1.1 Task description"');
    errors.push("Found non-standard format. Reference ~/.claude/ai-dev-tasks/generate-tasks.md");
  }
  const headerTaskPattern = /^###\s+T?\d+\.\d+/m;
  if (headerTaskPattern.test(content)) {
    errors.push("Task files should NOT use header format (### T1.1). Use checkbox format instead.");
  }
  if (!content.includes("## Relevant Files") && !content.includes("## relevant files")) {
    errors.push('Missing "## Relevant Files" section. See generate-tasks.md template.');
  }
  if (!content.includes("Instructions for Completing Tasks") && !content.includes("instructions for completing tasks")) {
    errors.push('Missing "Instructions for Completing Tasks" section. See generate-tasks.md template.');
  }
  return { valid: errors.length === 0, errors };
}
function validatePrdFormat(content) {
  const errors = [];
  const lowerContent = content.toLowerCase();
  const requiredSections = [
    { name: "Introduction/Overview", patterns: ["## introduction", "## overview", "# introduction", "# overview"] },
    { name: "Goals", patterns: ["## goals", "# goals"] },
    { name: "User Stories", patterns: ["## user stories", "# user stories"] },
    { name: "Functional Requirements", patterns: ["## functional requirements", "# functional requirements", "## requirements"] },
    { name: "Non-Goals", patterns: ["## non-goals", "## out of scope", "# non-goals"] }
  ];
  for (const section of requiredSections) {
    const hasSection = section.patterns.some((p) => lowerContent.includes(p));
    if (!hasSection) {
      errors.push(`Missing required section: "${section.name}". See create-prd.md template.`);
    }
  }
  return { valid: errors.length === 0, errors };
}
function checkFilename(filePath, fileType) {
  const filename = filePath.split(/[/\\]/).pop() || "";
  const lowerFilename = filename.toLowerCase();
  if (fileType === "prd") {
    if (!lowerFilename.startsWith("prd-") || !lowerFilename.endsWith(".md")) {
      return {
        valid: false,
        error: `PRD filename should be "prd-<feature>.md", got "${filename}"`
      };
    }
  } else if (fileType === "task") {
    if (!lowerFilename.startsWith("tasks-") || !lowerFilename.endsWith(".md")) {
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
    const input = readFileSync(0, "utf-8");
    const data = JSON.parse(input);
    if (data.event !== "PreToolUse" || data.tool_name !== "Write") {
      const output2 = { decision: "allow" };
      console.log(JSON.stringify(output2));
      return;
    }
    const filePath = data.tool_input?.file_path || "";
    const content = data.tool_input?.content || "";
    const fileType = detectFileType(content, filePath);
    if (fileType === "unknown") {
      const output2 = { decision: "allow" };
      console.log(JSON.stringify(output2));
      return;
    }
    const allErrors = [];
    const locationCheck = checkLocation(filePath);
    if (!locationCheck.valid && locationCheck.error) {
      allErrors.push(locationCheck.error);
    }
    const filenameCheck = checkFilename(filePath, fileType);
    if (!filenameCheck.valid && filenameCheck.error) {
      allErrors.push(filenameCheck.error);
    }
    if (fileType === "task") {
      const formatCheck = validateTaskFormat(content);
      allErrors.push(...formatCheck.errors);
    } else if (fileType === "prd") {
      const formatCheck = validatePrdFormat(content);
      allErrors.push(...formatCheck.errors);
    }
    if (allErrors.length > 0) {
      let reason = `
${"\u2501".repeat(50)}
`;
      reason += "\u{1F6AB} PRD/TASK TEMPLATE VIOLATION\n";
      reason += `${"\u2501".repeat(50)}

`;
      reason += `File type detected: ${fileType.toUpperCase()}
`;
      reason += `File path: ${filePath}

`;
      reason += "VIOLATIONS:\n";
      allErrors.forEach((err, i) => {
        reason += `  ${i + 1}. ${err}
`;
      });
      reason += "\nREQUIRED ACTION:\n";
      reason += "  1. Read the template: ~/.claude/ai-dev-tasks/";
      reason += fileType === "prd" ? "create-prd.md\n" : "generate-tasks.md\n";
      reason += "  2. Follow the template workflow and format\n";
      reason += "  3. Save to /tasks/ directory with correct filename\n";
      reason += `
${"\u2501".repeat(50)}
`;
      const output2 = { decision: "block", reason };
      console.log(JSON.stringify(output2));
      return;
    }
    const output = { decision: "allow" };
    console.log(JSON.stringify(output));
  } catch (error) {
    const output = { decision: "allow" };
    console.log(JSON.stringify(output));
  }
}
main();
