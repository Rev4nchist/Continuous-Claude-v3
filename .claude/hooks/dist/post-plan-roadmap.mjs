#!/usr/bin/env node
import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/post-plan-roadmap.ts
import * as fs2 from "fs";
import * as path2 from "path";
import { spawn } from "child_process";

// src/shared/project-relevance.ts
import * as fs from "fs";
import * as path from "path";
import { homedir } from "node:os";
var IDENTITY_STOPWORDS = /* @__PURE__ */ new Set([
  "claude",
  "continuous",
  "code",
  "anthropic",
  "project",
  "the",
  "app",
  "platform",
  "engine",
  "server",
  "service",
  "system"
]);
var FOREIGN_PROJECT_MARKERS = ["salesforce", "fastmcp"];
function getProjectIdentity(projectDir) {
  const resolvedDir = path.resolve(projectDir);
  const dirName = path.basename(resolvedDir);
  const identity = {
    dirName,
    registryName: null,
    packageName: null,
    projectPath: resolvedDir,
    keywords: [],
    distinctiveKeywords: [],
    otherProjects: [],
    otherProjectTokens: []
  };
  const dirKeywords = tokenize(dirName);
  const keywordSet = new Set(dirKeywords);
  keywordSet.add(dirName.toLowerCase());
  const otherTokenSet = /* @__PURE__ */ new Set();
  const registry = readRegistry(resolvedDir);
  if (registry) {
    for (const project of registry.projects) {
      const projectPath = path.resolve(project.path);
      if (projectPath === resolvedDir) {
        identity.registryName = project.name;
        for (const w of tokenize(project.name)) keywordSet.add(w);
      } else {
        identity.otherProjects.push(project.name);
        for (const w of tokenize(project.name)) {
          if (!IDENTITY_STOPWORDS.has(w)) otherTokenSet.add(w);
        }
      }
    }
  }
  try {
    const pkgPath = path.join(resolvedDir, "package.json");
    const pkgContent = fs.readFileSync(pkgPath, "utf-8");
    const pkg = JSON.parse(pkgContent);
    if (pkg.name && typeof pkg.name === "string") {
      identity.packageName = pkg.name;
      const cleanName = pkg.name.replace(/^@[^/]+\//, "");
      for (const w of tokenize(cleanName)) keywordSet.add(w);
      keywordSet.add(cleanName.toLowerCase());
    }
  } catch {
  }
  if (identity.registryName) {
    keywordSet.add(identity.registryName.toLowerCase());
  }
  identity.keywords = [...keywordSet];
  identity.distinctiveKeywords = identity.keywords.filter((kw) => !IDENTITY_STOPWORDS.has(kw));
  identity.otherProjectTokens = [...otherTokenSet];
  return identity;
}
function tokenize(name) {
  return name.toLowerCase().split(/[-_\s]+/).filter((w) => w.length > 1);
}
function matchesAsWord(content, term) {
  if (!term) return false;
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[-_\s/]+/g, "[-_\\s/]+");
  try {
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(content);
  } catch {
    return content.toLowerCase().includes(term.toLowerCase());
  }
}
function isContentRelevantToProject(content, identity) {
  if (!content || content.length < 50) {
    return { relevant: true, confidence: "low", reason: "content too short" };
  }
  const distinctiveNames = [identity.registryName, identity.dirName, identity.packageName].filter((n) => !!n);
  for (const name of distinctiveNames) {
    if (matchesAsWord(content, name)) {
      return { relevant: true, confidence: "high", reason: `matches project identity "${name}"` };
    }
  }
  for (const kw of identity.distinctiveKeywords) {
    if (kw.length < 3) continue;
    if (matchesAsWord(content, kw)) {
      return { relevant: true, confidence: "high", reason: `matches distinctive keyword "${kw}"` };
    }
  }
  if (identity.projectPath && content.toLowerCase().includes(identity.projectPath.toLowerCase())) {
    return { relevant: true, confidence: "high", reason: "mentions this project path" };
  }
  for (const otherName of identity.otherProjects) {
    if (matchesAsWord(content, otherName)) {
      const thisName = identity.registryName || identity.dirName;
      return {
        relevant: false,
        confidence: "high",
        reason: `content mentions "${otherName}" but not "${thisName}"`
      };
    }
  }
  for (const token of identity.otherProjectTokens) {
    if (token.length < 3) continue;
    if (matchesAsWord(content, token)) {
      const thisName = identity.registryName || identity.dirName;
      return {
        relevant: false,
        confidence: "high",
        reason: `content mentions foreign project token "${token}" but no "${thisName}" identity`
      };
    }
  }
  for (const marker of FOREIGN_PROJECT_MARKERS) {
    if (matchesAsWord(content, marker)) {
      const thisName = identity.registryName || identity.dirName;
      return {
        relevant: false,
        confidence: "high",
        reason: `content mentions foreign project "${marker}" but no "${thisName}" identity`
      };
    }
  }
  return { relevant: true, confidence: "low", reason: "no cross-project signals" };
}
function readRegistry(projectDir) {
  const ccv3Dir = process.env.CLAUDE_CCV3_DIR || path.join(homedir(), "continuous-claude");
  const candidates = [
    path.join(projectDir, ".claude", "project-registry.json"),
    path.join(ccv3Dir, ".claude", "project-registry.json")
  ];
  for (const candidate of candidates) {
    try {
      const content = fs.readFileSync(candidate, "utf-8");
      const parsed = JSON.parse(content);
      if (parsed && Array.isArray(parsed.projects)) {
        return parsed;
      }
    } catch {
    }
  }
  return null;
}

// src/shared/roadmap-parser.ts
var SECTION_PREFIXES = [
  // Order matters: more specific first.
  { key: "sessions", prefix: "## recent planning" },
  { key: "current", prefix: "## current" },
  { key: "completed", prefix: "## completed" },
  { key: "planned", prefix: "## planned" }
];
function detectSection(strippedLower) {
  for (const { key, prefix } of SECTION_PREFIXES) {
    if (strippedLower.startsWith(prefix)) {
      return key;
    }
  }
  if (strippedLower.startsWith("## ")) {
    return null;
  }
  return void 0;
}
function bucketize(rawPriority) {
  const p = rawPriority.toLowerCase();
  if (p.includes("high")) return "high";
  if (p.includes("low")) return "low";
  return "medium";
}
function parseRoadmap(content) {
  const result = {
    current: null,
    completed: [],
    planned: [],
    sessions: [],
    rawContent: content,
    rawSections: /* @__PURE__ */ new Map()
  };
  if (!content) return result;
  const lines = content.split("\n");
  let section = null;
  let sectionStart = -1;
  const closeSection = (endLine) => {
    if (section && sectionStart >= 0) {
      result.rawSections.set(section, { start: sectionStart, end: endLine });
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const stripped = line.trim();
    const lower = stripped.toLowerCase();
    const detected = detectSection(lower);
    const isAnyH2 = stripped.startsWith("## ");
    const isKnownH2 = typeof detected === "string";
    const isUnrelatedH2 = detected === null;
    if (isKnownH2) {
      closeSection(i);
      section = detected;
      sectionStart = i;
      continue;
    }
    if (isUnrelatedH2) {
      closeSection(i);
      section = null;
      sectionStart = -1;
      continue;
    }
    if (section === "current") {
      if (stripped.startsWith("**") && stripped.endsWith("**") && stripped.length >= 4) {
        const title = stripped.replace(/\*\*/g, "").trim();
        if (title.length > 0) {
          result.current = { title };
        }
        continue;
      }
      const checkboxCurrent = stripped.match(/^-\s*\[\s*\]\s*(.+)$/);
      if (checkboxCurrent && !result.current) {
        result.current = { title: checkboxCurrent[1].trim() };
        continue;
      }
      if (result.current && stripped.startsWith("- ")) {
        const text = stripped.slice(2).trim();
        if (/^started:/i.test(text)) {
          result.current.started = text.replace(/^started:\s*/i, "").trim();
        } else if (/^progress:/i.test(text)) {
          result.current.progress = text.replace(/^progress:\s*/i, "").trim();
        } else {
          if (result.current.description) {
            result.current.description = `${result.current.description}; ${text}`;
          } else {
            result.current.description = text;
          }
        }
        continue;
      }
    }
    if (section === "completed") {
      const m = stripped.match(/^-\s*\[x\]\s*(.+?)(?:\s*\(([^)]+)\))?$/i);
      if (m) {
        result.completed.push({
          title: m[1].trim(),
          completed: m[2] || ""
        });
      }
      continue;
    }
    if (section === "planned") {
      const m = stripped.match(/^-\s*\[\s*\]\s*(.+?)(?:\s*\(([^)]+)\))?$/);
      if (m) {
        const rawPriority = m[2] || "normal";
        result.planned.push({
          title: m[1].trim(),
          priority: rawPriority,
          priorityBucket: bucketize(rawPriority)
        });
      }
      continue;
    }
    if (section === "sessions") {
      const sessHeader = stripped.match(/^###\s*(\d{4}-\d{2}-\d{2}):\s*(.+)$/);
      if (sessHeader) {
        result.sessions.push({
          date: sessHeader[1],
          title: sessHeader[2].trim(),
          decisions: []
        });
        continue;
      }
      if (result.sessions.length > 0 && stripped.startsWith("-")) {
        const last = result.sessions[result.sessions.length - 1];
        last.decisions.push(stripped.slice(1).trim());
      }
      continue;
    }
  }
  closeSection(lines.length);
  return result;
}

// src/post-plan-roadmap.ts
function renderSectionBody(key, sections) {
  const lines = [];
  if (key === "current") {
    lines.push("## Current Focus");
    if (sections.current) {
      lines.push(`**${sections.current.title}**`);
      if (sections.current.description) {
        lines.push(`- ${sections.current.description}`);
      }
      if (sections.current.started) {
        lines.push(`- Started: ${sections.current.started}`);
      }
    } else {
      lines.push("No current focus set.");
    }
  } else if (key === "completed") {
    lines.push("## Completed");
    if (sections.completed.length > 0) {
      for (const item of sections.completed) {
        const dateStr = item.completed ? ` (${item.completed})` : "";
        lines.push(`- [x] ${item.title}${dateStr}`);
      }
    } else {
      lines.push("_No completed items yet._");
    }
  } else if (key === "planned") {
    lines.push("## Planned");
    if (sections.planned.length > 0) {
      for (const item of sections.planned) {
        const bucket = item.priorityBucket || "medium";
        lines.push(`- [ ] ${item.title} (${bucket} priority)`);
      }
    } else {
      lines.push("_No planned items yet._");
    }
  } else {
    lines.push("## Recent Planning Sessions");
    if (sections.sessions.length > 0) {
      for (const session of sections.sessions.slice(0, 5)) {
        lines.push(`### ${session.date}: ${session.title}`);
        if (session.summary) {
          lines.push(`**Summary:** ${session.summary}`);
          lines.push("");
        }
        if (session.decisions.length > 0) {
          lines.push("**Key Decisions:**");
          for (const decision of session.decisions) {
            lines.push(`- ${decision}`);
          }
          lines.push("");
        }
        if (session.steps && session.steps.length > 0) {
          lines.push("**Implementation:**");
          for (const step of session.steps) {
            lines.push(`- ${step}`);
          }
          lines.push("");
        }
        if (session.files && session.files.length > 0) {
          lines.push(`**Files:** ${session.files.join(", ")}`);
          lines.push("");
        }
        if (session.verification && session.verification.length > 0) {
          lines.push(`**Verification:** ${session.verification[0]}`);
          lines.push("");
        }
      }
    } else {
      lines.push("_No planning sessions recorded._");
    }
  }
  return lines;
}
function renderManagedSection(key, sections) {
  const lines = renderSectionBody(key, sections);
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  lines.push("");
  return lines;
}
function generateRoadmap(sections) {
  const lines = ["# Project Roadmap", ""];
  lines.push(...renderSectionBody("current", sections), "");
  lines.push(...renderSectionBody("completed", sections), "");
  lines.push(...renderSectionBody("planned", sections), "");
  lines.push(...renderSectionBody("sessions", sections));
  return lines.join("\n");
}
function applyRoadmapUpdate(sections) {
  const original = sections.rawContent;
  if (!original.trim()) return generateRoadmap(sections);
  const lines = original.split("\n");
  const MANAGED = ["current", "completed", "planned", "sessions"];
  const present = MANAGED.map((key) => ({ key, range: sections.rawSections.get(key) })).filter((x) => x.range).sort((a, b) => a.range.start - b.range.start);
  const out = [];
  let cursor = 0;
  for (const { key, range } of present) {
    for (let i = cursor; i < range.start; i++) out.push(lines[i]);
    out.push(...renderManagedSection(key, sections));
    cursor = range.end;
  }
  for (let i = cursor; i < lines.length; i++) out.push(lines[i]);
  for (const key of MANAGED) {
    if (!sections.rawSections.get(key)) out.push(...renderManagedSection(key, sections));
  }
  return out.join("\n");
}
function demoteCurrentFocusToPlanned(sections, newTitle) {
  if (!sections.current || sections.current.title === newTitle) return;
  const old = sections.current;
  if (sections.planned.some((p) => p.title === old.title)) return;
  sections.planned.unshift({ title: old.title, priority: "high", priorityBucket: "high" });
}
var CAPTURE_KEYWORDS = [
  // Decisions
  "decision",
  "decided",
  "approach",
  "strategy",
  "chose",
  "selected",
  // Goals
  "goal",
  "objective",
  "purpose",
  "target",
  "aim",
  // Implementation
  "implement",
  "create",
  "add",
  "modify",
  "update",
  "fix",
  "build",
  "step",
  "action",
  "task",
  "change",
  // Verification
  "verify",
  "test",
  "check",
  "confirm",
  "validate",
  "ensure",
  // Risks
  "risk",
  "edge case",
  "caveat",
  "limitation",
  "warning",
  "note",
  // Analysis
  "problem",
  "issue",
  "cause",
  "root cause",
  "reason",
  "why"
];
function parseSections(content) {
  const sections = {};
  const lines = content.split("\n");
  let currentSection = "_intro";
  let sectionContent = [];
  for (const line of lines) {
    const h2Match = line.match(/^##\s+(.+)$/);
    if (h2Match) {
      if (sectionContent.length > 0) {
        sections[currentSection] = sectionContent.join("\n");
      }
      currentSection = h2Match[1].trim().toLowerCase();
      sectionContent = [];
    } else {
      sectionContent.push(line);
    }
  }
  if (sectionContent.length > 0) {
    sections[currentSection] = sectionContent.join("\n");
  }
  return sections;
}
function extractBullets(content, keywords) {
  const bullets = [];
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("-") && !trimmed.startsWith("*") && !trimmed.match(/^\d+\./)) {
      continue;
    }
    const bulletText = trimmed.replace(/^[-*]\s*/, "").replace(/^\d+\.\s*/, "").trim();
    if (!bulletText) continue;
    let cleanText = bulletText.replace(/^\[[ x]\]\s*/i, "");
    cleanText = cleanText.replace(/^\*\*([^*]+)\*\*:?\s*/, "$1: ").replace(/^`([^`]+)`\s*[-–]\s*/, "").replace(/^\*([^*]+)\*:?\s*/g, "$1 ").replace(/::\s*\*/g, ": ").replace(/\*\s+/g, " ").replace(/\s+/g, " ").trim();
    if (cleanText.length < 15) continue;
    if (cleanText.startsWith("|") || cleanText.startsWith("```")) continue;
    if (cleanText.match(/^`[^`]+`$/) || cleanText.match(/^[A-Za-z_]+\.[a-z]+$/)) continue;
    if (cleanText.match(/\{[^}]+\}/) && cleanText.length < 50) continue;
    if (keywords) {
      const lower = cleanText.toLowerCase();
      if (keywords.some((kw) => lower.includes(kw))) {
        bullets.push(cleanText);
      }
    } else {
      bullets.push(cleanText);
    }
  }
  return bullets;
}
function extractFirstParagraph(content) {
  const lines = content.split("\n");
  const paragraphLines = [];
  let foundStart = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!foundStart) {
      if (trimmed.startsWith("#") || !trimmed) continue;
      foundStart = true;
    }
    if (foundStart && (!trimmed || trimmed.startsWith("#"))) {
      if (paragraphLines.length > 0) break;
      continue;
    }
    paragraphLines.push(trimmed);
  }
  const summary = paragraphLines.join(" ").slice(0, 300);
  return summary.length === 300 ? summary + "..." : summary;
}
function extractFilesFromContent(content) {
  const files = [];
  const backtickMatches = content.match(/`([^`]+\.[a-z]{2,4})`/gi) || [];
  for (const match of backtickMatches) {
    const file = match.replace(/`/g, "");
    if (file.includes("/") || file.includes("\\") || file.match(/\.\w{2,4}$/)) {
      files.push(file);
    }
  }
  const tableMatches = content.match(/\|\s*`?([^|`]+\.[a-z]{2,4})`?\s*\|/gi) || [];
  for (const match of tableMatches) {
    const file = match.replace(/[|`\s]/g, "");
    if (file.match(/\.\w{2,4}$/)) {
      files.push(file);
    }
  }
  return [...new Set(files)];
}
function extractPlanInfo(planContent, filePath) {
  const sections = parseSections(planContent);
  let title = "Planning Session";
  const titleMatch = planContent.match(/^#\s+(?:Plan:\s*)?(.+)/m);
  if (titleMatch && titleMatch[1].trim() !== "Planning Session") {
    title = titleMatch[1].trim();
  } else if (filePath) {
    const basename2 = filePath.replace(/\\/g, "/").split("/").pop()?.replace(".md", "") || "";
    if (basename2 && !basename2.match(/^plan[-_]?\d*$/i)) {
      title = basename2.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
    }
  }
  let summary = "";
  const summarySection = sections["summary"] || sections["problem summary"] || sections["purpose"] || sections["overview"];
  if (summarySection) {
    summary = extractFirstParagraph(summarySection);
  } else if (sections["_intro"]) {
    summary = extractFirstParagraph(sections["_intro"]);
  }
  const decisionSection = sections["decisions"] || sections["key decisions"] || sections["approach"] || "";
  let decisions = extractBullets(decisionSection);
  if (decisions.length === 0) {
    decisions = extractBullets(planContent, CAPTURE_KEYWORDS);
  }
  const implSection = sections["implementation plan"] || sections["implementation"] || sections["steps"] || sections["plan"] || "";
  let steps = extractBullets(implSection);
  if (steps.length === 0 && sections["step 1"]) {
    steps = Object.keys(sections).filter((k) => k.match(/^step \d/)).map((k) => sections[k].split("\n")[0]?.trim() || k).filter(Boolean);
  }
  const verifySection = sections["verification"] || sections["verification plan"] || sections["testing"] || sections["test plan"] || "";
  const verification = extractBullets(verifySection);
  const filesSection = sections["files to modify"] || sections["files"] || sections["affected files"] || "";
  let affectedFiles = extractFilesFromContent(filesSection);
  if (affectedFiles.length === 0) {
    affectedFiles = extractFilesFromContent(planContent);
  }
  return {
    title,
    summary: summary.slice(0, 500),
    decisions: decisions.slice(0, 10),
    steps: steps.slice(0, 8),
    verification: verification.slice(0, 5),
    affectedFiles: affectedFiles.slice(0, 10)
  };
}
function storePlanningLearnings(planInfo, projectDir) {
  const decisions = planInfo.decisions.slice(0, 5);
  if (decisions.length === 0) {
    console.error("No decisions to store in memory");
    return;
  }
  const contentLines = [
    `Planning: ${planInfo.title}`,
    "",
    "Decisions:",
    ...decisions.map((d) => `- ${d}`)
  ];
  if (planInfo.steps.length > 0) {
    contentLines.push("", "Key Steps:", ...planInfo.steps.slice(0, 3).map((s) => `- ${s}`));
  }
  const content = contentLines.join("\n");
  const opcDir = process.env.CLAUDE_OPC_DIR || path2.join(process.env.USERPROFILE || process.env.HOME || "", "continuous-claude", "opc");
  const sessionId = `plan-${Date.now()}`;
  try {
    const child = spawn("uv", [
      "run",
      "python",
      "scripts/core/store_learning.py",
      "--session-id",
      sessionId,
      "--type",
      "ARCHITECTURAL_DECISION",
      "--content",
      content,
      "--context",
      `planning: ${planInfo.title}`,
      "--tags",
      "planning,decisions,architecture",
      "--confidence",
      "high"
    ], {
      cwd: opcDir,
      detached: true,
      stdio: "ignore",
      env: { ...process.env, PYTHONPATH: "." }
    });
    child.unref();
  } catch {
  }
}
async function main() {
  const input = await readStdin();
  if (!input.trim()) {
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  let data;
  try {
    data = JSON.parse(input);
  } catch {
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  if (data.tool_name !== "ExitPlanMode") {
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const roadmapPath = path2.join(projectDir, "ROADMAP.md");
  const planDirNested = path2.join(projectDir, ".claude", "plans");
  const planDirDirect = path2.join(projectDir, "plans");
  const userHome = process.env.USERPROFILE || process.env.HOME || "";
  const userPlanDir = path2.join(userHome, ".claude", "plans");
  const hasPlanFiles = (dir) => {
    try {
      return fs2.existsSync(dir) && fs2.readdirSync(dir).some((f) => f.endsWith(".md"));
    } catch {
      return false;
    }
  };
  const planDir = hasPlanFiles(planDirNested) ? planDirNested : hasPlanFiles(planDirDirect) ? planDirDirect : hasPlanFiles(userPlanDir) ? userPlanDir : planDirNested;
  const isGlobalPlanDir = planDir === userPlanDir;
  const STALENESS_THRESHOLD_MS = 6e5;
  let planContent = "";
  let latestPlanPath;
  if (fs2.existsSync(planDir)) {
    const now = Date.now();
    const planFiles = fs2.readdirSync(planDir).filter((f) => f.endsWith(".md") && !f.startsWith("_")).map((f) => ({
      name: f,
      mtime: fs2.statSync(path2.join(planDir, f)).mtime.getTime()
    })).filter((f) => {
      if (isGlobalPlanDir) return now - f.mtime < STALENESS_THRESHOLD_MS;
      return true;
    }).sort((a, b) => b.mtime - a.mtime);
    if (planFiles.length > 0) {
      planContent = fs2.readFileSync(path2.join(planDir, planFiles[0].name), "utf-8");
      latestPlanPath = path2.join(planDir, planFiles[0].name);
    }
  }
  const toolOutput = data.tool_output || data.tool_result || "";
  if (!planContent && toolOutput) {
    planContent = toolOutput;
  }
  let sections;
  if (fs2.existsSync(roadmapPath)) {
    const existingContent = fs2.readFileSync(roadmapPath, "utf-8");
    sections = parseRoadmap(existingContent);
  } else {
    sections = {
      current: null,
      completed: [],
      planned: [],
      sessions: [],
      rawContent: "",
      rawSections: /* @__PURE__ */ new Map()
    };
  }
  const planInfo = extractPlanInfo(planContent, latestPlanPath);
  const identity = getProjectIdentity(projectDir);
  const relevance = isContentRelevantToProject(planContent, identity);
  if (!relevance.relevant) {
    console.error(`[post-plan-roadmap] BLOCKED: Plan is about a different project. ${relevance.reason}`);
    console.log(JSON.stringify({
      result: "continue",
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: `ROADMAP update skipped: cross-project guard triggered. "${planInfo.title}" does not match project "${identity.dirName}". ${relevance.reason}`
      }
    }));
    return;
  }
  const today = (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
  if (planInfo.title && planInfo.title !== "Planning Session") {
    demoteCurrentFocusToPlanned(sections, planInfo.title);
    sections.current = {
      title: planInfo.title,
      description: planInfo.decisions.slice(0, 2).join("; ") || "",
      started: today
    };
  }
  const newSession = {
    date: today,
    title: planInfo.title,
    summary: planInfo.summary || void 0,
    decisions: planInfo.decisions.slice(0, 5),
    steps: planInfo.steps.length > 0 ? planInfo.steps.slice(0, 5) : void 0,
    verification: planInfo.verification.length > 0 ? planInfo.verification.slice(0, 3) : void 0,
    files: planInfo.affectedFiles.length > 0 ? planInfo.affectedFiles.slice(0, 8) : void 0
  };
  const existingToday = sections.sessions.findIndex((s) => s.date === today);
  if (existingToday >= 0) {
    sections.sessions[existingToday] = newSession;
  } else {
    sections.sessions.unshift(newSession);
  }
  sections.sessions = sections.sessions.slice(0, 5);
  const newContent = applyRoadmapUpdate(sections);
  fs2.mkdirSync(path2.dirname(roadmapPath), { recursive: true });
  fs2.writeFileSync(roadmapPath, newContent, "utf-8");
  console.error(`[post-plan-roadmap] ROADMAP.md updated: ${planInfo.title}`);
  storePlanningLearnings(planInfo, projectDir);
  const stats = [
    `Goal: ${planInfo.title}`,
    `Decisions: ${planInfo.decisions.length}`,
    `Steps: ${planInfo.steps.length}`,
    `Files: ${planInfo.affectedFiles.length}`
  ].join(" | ");
  const output = {
    result: "continue",
    message: `\u{1F4CB} ROADMAP.md updated: ${planInfo.title}`,
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: `Planning session recorded:
${stats}
ROADMAP: ${roadmapPath}`
    }
  };
  console.log(JSON.stringify(output));
}
async function readStdin() {
  return new Promise((resolve2) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => data += chunk);
    process.stdin.on("end", () => resolve2(data));
    setTimeout(() => resolve2(data), 1e3);
  });
}
main().catch((err) => {
  console.error("[post-plan-roadmap] Error:", err.message);
  console.log(JSON.stringify({ result: "continue" }));
});
export {
  applyRoadmapUpdate,
  demoteCurrentFocusToPlanned
};
