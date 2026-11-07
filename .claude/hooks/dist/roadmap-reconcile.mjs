#!/usr/bin/env node
import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/roadmap-reconcile.ts
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

// src/shared/session-source.ts
var COMPACT_SOURCE = "compact";
function parseSessionSource(stdin) {
  try {
    const doc = JSON.parse(stdin);
    if (doc !== null && typeof doc === "object" && !Array.isArray(doc)) {
      const source = doc.source;
      if (typeof source === "string" && source !== "") return source;
    }
  } catch {
  }
  return "startup";
}
function isCompactSource(source) {
  return source === COMPACT_SOURCE;
}

// src/roadmap-reconcile.ts
var PACKAGE_ALIASES = {
  "passport": ["passport", "passport.js"],
  "redis": ["redis", "ioredis"],
  "mongoose": ["mongoose"],
  "prisma": ["prisma", "@prisma/client"],
  "apollo-server": ["apollo-server", "@apollo/server"],
  "socket.io": ["socket.io"],
  "helmet": ["helmet"],
  "express": ["express"],
  "fastify": ["fastify"],
  "next": ["next", "next.js", "nextjs"],
  "react": ["react"],
  "vue": ["vue", "vue.js", "vuejs"],
  "angular": ["@angular/core", "angular"],
  "tailwind": ["tailwindcss", "tailwind"],
  "jest": ["jest"],
  "vitest": ["vitest"],
  "mocha": ["mocha"],
  "webpack": ["webpack"],
  "vite": ["vite"],
  "esbuild": ["esbuild"],
  "typeorm": ["typeorm"],
  "sequelize": ["sequelize"],
  "knex": ["knex"],
  "graphql": ["graphql"],
  "axios": ["axios"],
  "lodash": ["lodash"],
  "moment": ["moment"],
  "dayjs": ["dayjs"],
  "zod": ["zod"],
  "joi": ["joi"]
};
function buildPackageLookup() {
  const lookup = /* @__PURE__ */ new Map();
  for (const [pkg, aliases] of Object.entries(PACKAGE_ALIASES)) {
    for (const alias of aliases) {
      lookup.set(alias.toLowerCase(), pkg);
    }
  }
  return lookup;
}
var PACKAGE_LOOKUP = buildPackageLookup();
function extractPaths(text) {
  const matches = text.match(/\b(?:src|lib|app|packages|modules|components)\/[\w/.-]+/g);
  return matches ? matches.map((p) => p.replace(/\/+$/, "")) : [];
}
function extractDecisions(content) {
  const decisions = [];
  const lines = content.split("\n");
  let inDecisionTable = false;
  let headerSeen = false;
  let separatorSeen = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("|") && /decision/i.test(trimmed) && !headerSeen) {
      inDecisionTable = true;
      headerSeen = true;
      continue;
    }
    if (inDecisionTable && !separatorSeen && /^\|[\s-|]+\|$/.test(trimmed)) {
      separatorSeen = true;
      continue;
    }
    if (inDecisionTable && separatorSeen && trimmed.startsWith("|")) {
      const cells = trimmed.split("|").map((c) => c.trim()).filter((c) => c.length > 0);
      if (cells.length >= 2) {
        decisions.push({
          decision: cells[0],
          rationale: cells[1]
        });
      }
      continue;
    }
    if (inDecisionTable && !trimmed.startsWith("|")) {
      inDecisionTable = false;
      headerSeen = false;
      separatorSeen = false;
    }
  }
  return decisions;
}
function extractMilestones(content) {
  const milestones = [];
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    const completedMatch = trimmed.match(/^-\s*\[x\]\s+(.+?)(?:\s*\((\d{4}-\d{2}-\d{2})\))?(?:\s*`[^`]*`)?$/i);
    if (completedMatch) {
      milestones.push({
        title: completedMatch[1].trim(),
        completed: true,
        date: completedMatch[2] || null
      });
      continue;
    }
    const plannedMatch = trimmed.match(/^-\s*\[\s*\]\s+(.+)$/);
    if (plannedMatch) {
      milestones.push({
        title: plannedMatch[1].trim(),
        completed: false,
        date: null
      });
    }
  }
  return milestones;
}
function extractCurrentFocus(content) {
  const currentMatch = content.match(/## Current Focus\n([\s\S]*?)(?=\n## |$)/);
  if (!currentMatch) return null;
  const section = currentMatch[1].trim();
  if (/no current goal/i.test(section)) return null;
  const titleMatch = section.match(/\*\*([^*]+)\*\*/);
  if (!titleMatch) return null;
  const title = titleMatch[1].trim();
  const details = section.split("\n").filter((l) => l.trim().startsWith("-")).map((l) => l.trim().replace(/^-\s*/, "")).join(" ");
  return { title, details };
}
function extractMentionedFiles(content) {
  const files = [];
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    const filesMatch = trimmed.match(/^\*?\*?Files:\*?\*?\s*(.+)$/i);
    if (filesMatch) {
      const fileList = filesMatch[1].split(",").map((f) => f.trim()).filter((f) => f.length > 0);
      files.push(...fileList);
    }
  }
  return files;
}
function extractMentionedPackages(content) {
  const packages = [];
  const contentLower = content.toLowerCase();
  for (const [alias, pkgName] of PACKAGE_LOOKUP) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`\\b${escaped}\\b`, "i");
    if (regex.test(contentLower)) {
      if (!packages.includes(pkgName)) {
        packages.push(pkgName);
      }
    }
  }
  return packages;
}
function validateDecisions(decisions, packageJson) {
  const issues = [];
  const allDeps = {
    ...packageJson.dependencies || {},
    ...packageJson.devDependencies || {}
  };
  const depNames = new Set(Object.keys(allDeps).map((d) => d.toLowerCase()));
  for (const decision of decisions) {
    const text = decision.decision.toLowerCase();
    for (const [alias, pkgName] of PACKAGE_LOOKUP) {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(`\\b${escaped}\\b`, "i");
      if (regex.test(text)) {
        const allAliases = PACKAGE_ALIASES[pkgName] || [pkgName];
        const found = allAliases.some((a) => depNames.has(a.toLowerCase()));
        if (!found) {
          issues.push(`Decision mentions "${pkgName}" but it is not in package.json`);
        }
      }
    }
  }
  return issues;
}
function validateMilestones(milestones, gitLog) {
  const issues = [];
  const logLower = gitLog.toLowerCase();
  const STOP_WORDS = /* @__PURE__ */ new Set(["the", "and", "for", "with", "from", "that", "this", "have", "been", "will", "been", "into", "also", "some", "than", "then", "when", "what", "which", "about", "after", "before"]);
  for (const milestone of milestones) {
    if (!milestone.completed) continue;
    const titleWords = milestone.title.toLowerCase().replace(/[^\w\s]/g, " ").split(/\s+/).filter((w) => w.length >= 5 && !STOP_WORDS.has(w));
    const matchCount = titleWords.filter((w) => logLower.includes(w)).length;
    const threshold = Math.min(2, titleWords.length);
    if (matchCount < threshold) {
      issues.push(`Completed milestone "${milestone.title}" has no matching commit in recent git log`);
    }
  }
  return issues;
}
function validateCurrentFocus(focus, existingPaths) {
  if (!focus) return [];
  const issues = [];
  const allText = `${focus.title} ${focus.details}`;
  const paths = extractPaths(allText);
  for (const normalized of paths) {
    if (!existingPaths.has(normalized)) {
      issues.push(`Current focus mentions "${normalized}" but it does not exist`);
    }
  }
  return issues;
}
function reconcile(projectDir) {
  const roadmapPath = path.join(projectDir, "ROADMAP.md");
  if (!fs.existsSync(roadmapPath)) {
    return {};
  }
  let content;
  try {
    content = fs.readFileSync(roadmapPath, "utf-8");
  } catch {
    return {};
  }
  const allIssues = [];
  const decisions = extractDecisions(content);
  const milestones = extractMilestones(content);
  const focus = extractCurrentFocus(content);
  const mentionedFiles = extractMentionedFiles(content);
  const packageJsonPath = path.join(projectDir, "package.json");
  if (fs.existsSync(packageJsonPath) && decisions.length > 0) {
    try {
      const pkgContent = fs.readFileSync(packageJsonPath, "utf-8");
      const packageJson = JSON.parse(pkgContent);
      allIssues.push(...validateDecisions(decisions, packageJson));
    } catch {
    }
  } else if (!fs.existsSync(packageJsonPath) && decisions.length > 0) {
    const mentionedPkgs = extractMentionedPackages(content);
    if (mentionedPkgs.length > 0) {
      allIssues.push(...validateDecisions(decisions, { dependencies: {}, devDependencies: {} }));
    }
  }
  let gitLog = "";
  try {
    gitLog = execSync("git log --oneline -10", {
      cwd: projectDir,
      encoding: "utf-8",
      timeout: 5e3,
      stdio: ["pipe", "pipe", "pipe"]
    }).trim();
  } catch {
  }
  if (gitLog && milestones.length > 0) {
    allIssues.push(...validateMilestones(milestones, gitLog));
  }
  if (focus) {
    const existingPaths = /* @__PURE__ */ new Set();
    const allText = `${focus.title} ${focus.details}`;
    const paths = extractPaths(allText);
    for (const normalized of paths) {
      const fullPath = path.join(projectDir, normalized);
      if (fs.existsSync(fullPath)) {
        existingPaths.add(normalized);
      }
    }
    allIssues.push(...validateCurrentFocus(focus, existingPaths));
  }
  for (const filePath of mentionedFiles) {
    const fullPath = path.join(projectDir, filePath);
    if (!fs.existsSync(fullPath)) {
      allIssues.push(`Referenced file "${filePath}" does not exist`);
    }
  }
  if (allIssues.length < 2) {
    return {};
  }
  const deduped = [...new Set(allIssues)];
  const message = `ROADMAP Reconciliation (${deduped.length} issues):
` + deduped.map((i) => `- ${i}`).join("\n");
  return {
    values: {
      system: message
    }
  };
}
async function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => data += chunk);
    process.stdin.on("end", () => resolve(data));
  });
}
async function main() {
  const input = await readStdin();
  if (isCompactSource(parseSessionSource(input))) {
    console.log(JSON.stringify({}));
    return;
  }
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const result = reconcile(projectDir);
  console.log(JSON.stringify(result));
}
main().catch((err) => {
  console.error("roadmap-reconcile error:", err.message || err);
  console.log(JSON.stringify({}));
});
export {
  extractCurrentFocus,
  extractDecisions,
  extractMentionedFiles,
  extractMentionedPackages,
  extractMilestones,
  reconcile,
  validateCurrentFocus,
  validateDecisions,
  validateMilestones
};
