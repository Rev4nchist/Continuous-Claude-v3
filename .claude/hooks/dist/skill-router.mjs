#!/usr/bin/env node
import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/skill-router.ts
import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join } from "path";

// src/shared/skill-router-types.ts
var CircularDependencyError = class extends Error {
  constructor(cyclePath) {
    super(`Circular dependency detected: ${cyclePath.join(" -> ")}`);
    this.cyclePath = cyclePath;
    this.name = "CircularDependencyError";
  }
};

// src/skill-router.ts
var PROMPT_WEIGHTS = {
  multiple_files: 0.2,
  task_conjunctions: 0.15,
  uncertainty_markers: 0.1,
  architecture_keywords: 0.3,
  debug_intermittent: 0.25,
  new_project_intent: 0.35
};
var FILE_WEIGHTS = {
  imports_over_10: 0.15,
  cross_module: 0.2,
  test_files: 0.1,
  config_files: 0.15
};
var COMPLEXITY_THRESHOLD_SUGGEST = 0.5;
var COMPLEXITY_THRESHOLD_FORCE = 0.7;
var AGENT_TYPES = {
  scout: "exploration",
  oracle: "research",
  architect: "planning",
  phoenix: "refactoring",
  kraken: "implementation",
  spark: "quick-fix",
  arbiter: "testing",
  atlas: "e2e-testing",
  critic: "review",
  judge: "review",
  surveyor: "review",
  liaison: "integration",
  sleuth: "debugging",
  "debug-agent": "debugging",
  aegis: "security",
  profiler: "performance",
  herald: "release",
  scribe: "documentation",
  maestro: "orchestration"
};
function loadSkillRules() {
  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  const rulesPath = join(homeDir, ".claude", "skills", "skill-rules.json");
  if (!existsSync(rulesPath)) {
    return { skills: {}, agents: {} };
  }
  try {
    const content = readFileSync(rulesPath, "utf-8");
    return JSON.parse(content);
  } catch {
    return { skills: {}, agents: {} };
  }
}
function detectCircularDependency(skillName, rules) {
  const visited = /* @__PURE__ */ new Set();
  function dfs(current, path, pathSet) {
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
        ...skill.prerequisites.suggest || [],
        ...skill.prerequisites.require || []
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
  return dfs(skillName, [], /* @__PURE__ */ new Set());
}
function topologicalSort(skillName, rules) {
  const reachable = /* @__PURE__ */ new Set();
  const queue = [skillName];
  while (queue.length > 0) {
    const current = queue.shift();
    if (reachable.has(current)) continue;
    reachable.add(current);
    const skill = rules.skills[current];
    if (skill?.prerequisites) {
      const deps = [
        ...skill.prerequisites.suggest || [],
        ...skill.prerequisites.require || []
      ];
      for (const dep of deps) {
        queue.push(dep);
      }
    }
  }
  const inDegree = /* @__PURE__ */ new Map();
  const adjList = /* @__PURE__ */ new Map();
  for (const node of reachable) {
    inDegree.set(node, 0);
    adjList.set(node, []);
  }
  for (const node of reachable) {
    const skill = rules.skills[node];
    if (skill?.prerequisites) {
      const deps = [
        ...skill.prerequisites.suggest || [],
        ...skill.prerequisites.require || []
      ];
      for (const dep of deps) {
        if (reachable.has(dep)) {
          adjList.get(dep).push(node);
          inDegree.set(node, (inDegree.get(node) || 0) + 1);
        }
      }
    }
  }
  const sorted = [];
  const kahnQueue = Array.from(reachable).filter((n) => inDegree.get(n) === 0).sort();
  while (kahnQueue.length > 0) {
    const current = kahnQueue.shift();
    sorted.push(current);
    for (const dependent of adjList.get(current) || []) {
      const newDegree = (inDegree.get(dependent) || 1) - 1;
      inDegree.set(dependent, newDegree);
      if (newDegree === 0) {
        const insertIdx = kahnQueue.findIndex((q) => q > dependent);
        if (insertIdx === -1) {
          kahnQueue.push(dependent);
        } else {
          kahnQueue.splice(insertIdx, 0, dependent);
        }
      }
    }
  }
  if (sorted.length !== reachable.size) {
    const remaining = Array.from(reachable).filter((n) => !sorted.includes(n));
    const cyclePath = detectCircularDependency(remaining[0], rules) || remaining;
    throw new CircularDependencyError(cyclePath);
  }
  return sorted;
}
function getLoadingMode(skillName, rules) {
  const skill = rules.skills[skillName];
  if (!skill) return "lazy";
  const mode = skill.loading;
  if (!mode) return "lazy";
  const validModes = ["lazy", "eager", "eager-prerequisites"];
  if (!validModes.includes(mode)) {
    console.warn(`Skill "${skillName}" has invalid loading mode "${mode}", defaulting to lazy`);
    return "lazy";
  }
  return mode;
}
function resolveCoActivation(skillName, rules) {
  const skill = rules.skills[skillName];
  if (!skill?.coActivate) {
    return { peers: [], mode: "any" };
  }
  const peers = skill.coActivate.filter((peer) => peer !== skillName);
  for (const peer of peers) {
    if (!rules.skills[peer]) {
      console.warn(`Skill "${skillName}" co-activates non-existent peer "${peer}"`);
    }
  }
  const mode = skill.coActivateMode || "any";
  return { peers, mode };
}
function resolvePrerequisites(skillName, rules) {
  const skill = rules.skills[skillName];
  const suggest = skill?.prerequisites?.suggest || [];
  const require2 = skill?.prerequisites?.require || [];
  const loadOrder = topologicalSort(skillName, rules);
  return { suggest, require: require2, loadOrder };
}
function buildEnhancedLookupResult(baseMatch, rules) {
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
    loading
  };
}
function extractPromptSignals(task, context = "") {
  const signals = [];
  const combined = `${task} ${context}`.toLowerCase();
  const filePattern = /[\w/\\]+\.\w{2,4}/g;
  const filesFound = combined.match(filePattern) || [];
  signals.push({
    name: "multiple_files",
    weight: filesFound.length > 1 ? PROMPT_WEIGHTS.multiple_files : 0,
    detected: filesFound.length > 1,
    detail: filesFound.length > 1 ? `Found ${filesFound.length} file references` : ""
  });
  const conjunctions = ["and also", "and then", "then also", ", and ", " also "];
  const conjunctionCount = conjunctions.filter((c) => combined.includes(c)).length;
  signals.push({
    name: "task_conjunctions",
    weight: Math.min(PROMPT_WEIGHTS.task_conjunctions * conjunctionCount, 0.45),
    detected: conjunctionCount > 0,
    detail: conjunctionCount > 0 ? `Found ${conjunctionCount} task conjunctions` : ""
  });
  const uncertainty = ["how", "should i", "what's the best way", "which approach", "is it better"];
  const hasUncertainty = uncertainty.some((u) => combined.includes(u));
  signals.push({
    name: "uncertainty_markers",
    weight: hasUncertainty ? PROMPT_WEIGHTS.uncertainty_markers : 0,
    detected: hasUncertainty,
    detail: hasUncertainty ? "Question/uncertainty detected" : ""
  });
  const archKeywords = ["refactor", "migrate", "redesign", "restructure", "architect", "overhaul"];
  const archFound = archKeywords.filter((k) => combined.includes(k));
  signals.push({
    name: "architecture_keywords",
    weight: archFound.length > 0 ? PROMPT_WEIGHTS.architecture_keywords : 0,
    detected: archFound.length > 0,
    detail: archFound.length > 0 ? `Architecture keywords: ${archFound.join(", ")}` : ""
  });
  const debugKeywords = ["debug", "fix", "bug", "error", "issue"];
  const intermittent = ["intermittent", "sometimes", "random", "sporadic", "occasional", "flaky"];
  const hasDebug = debugKeywords.some((d) => combined.includes(d));
  const hasIntermittent = intermittent.some((i) => combined.includes(i));
  signals.push({
    name: "debug_intermittent",
    weight: hasDebug && hasIntermittent ? PROMPT_WEIGHTS.debug_intermittent : 0,
    detected: hasDebug && hasIntermittent,
    detail: hasDebug && hasIntermittent ? "Debug + intermittent pattern detected" : ""
  });
  const newKeywords = ["build", "create", "new", "implement", "add feature", "develop"];
  const scratchKeywords = ["from scratch", "new project", "new app", "new feature", "greenfield"];
  const hasNew = newKeywords.some((n) => combined.includes(n));
  const hasScratch = scratchKeywords.some((s) => combined.includes(s));
  signals.push({
    name: "new_project_intent",
    weight: hasNew && hasScratch ? PROMPT_WEIGHTS.new_project_intent : 0,
    detected: hasNew && hasScratch,
    detail: hasNew && hasScratch ? "New project/feature intent detected" : ""
  });
  return signals;
}
function extractFileSignals(files, cwd = "") {
  const signals = [];
  if (!files || files.length === 0) {
    return signals;
  }
  const dirs = /* @__PURE__ */ new Set();
  for (const f of files) {
    const parts = f.split(/[/\\]/);
    if (parts.length > 1) {
      dirs.add(parts.slice(0, -1).join("/"));
    }
  }
  const crossModule = dirs.size > 1;
  signals.push({
    name: "cross_module",
    weight: crossModule ? FILE_WEIGHTS.cross_module : 0,
    value: dirs.size
  });
  const testPatterns = [".test.", ".spec.", "_test.", "_spec.", "test_", "tests/"];
  const testFiles = files.filter(
    (f) => testPatterns.some((p) => f.toLowerCase().includes(p))
  );
  signals.push({
    name: "test_files",
    weight: testFiles.length > 0 ? FILE_WEIGHTS.test_files : 0,
    value: testFiles.length
  });
  const configPatterns = ["package.json", "tsconfig", "pyproject.toml", "setup.py", ".env", "config"];
  const configFiles = files.filter(
    (f) => configPatterns.some((p) => f.toLowerCase().includes(p))
  );
  signals.push({
    name: "config_files",
    weight: configFiles.length > 0 ? FILE_WEIGHTS.config_files : 0,
    value: configFiles.length
  });
  signals.push({
    name: "imports_over_10",
    weight: 0,
    value: 0
  });
  return signals;
}
function calculateComplexity(task, context, files, cwd = "") {
  const promptSignals = extractPromptSignals(task, context);
  const fileSignals = extractFileSignals(files, cwd);
  const promptScore = promptSignals.filter((s) => s.detected).reduce((sum, s) => sum + s.weight, 0);
  const fileScore = fileSignals.filter((s) => s.weight > 0).reduce((sum, s) => sum + s.weight, 0);
  const total = Math.min(promptScore + fileScore, 1);
  let action = "proceed";
  if (total >= COMPLEXITY_THRESHOLD_FORCE) {
    action = "force_maestro";
  } else if (total >= COMPLEXITY_THRESHOLD_SUGGEST) {
    action = "suggest_maestro";
  }
  return {
    total,
    prompt_score: promptScore,
    file_score: fileScore,
    prompt_signals: promptSignals,
    file_signals: fileSignals,
    action
  };
}
function calculateGreenfieldScore(task, context, cwd = "") {
  let score = 0;
  const combined = `${task} ${context}`.toLowerCase();
  const newKeywords = ["build", "create", "new", "implement", "start", "init"];
  if (newKeywords.some((k) => combined.includes(k))) {
    score += 0.15;
  }
  const scratchKeywords = ["from scratch", "new project", "greenfield", "new app"];
  if (scratchKeywords.some((k) => combined.includes(k))) {
    score += 0.2;
  }
  if (cwd && existsSync(cwd)) {
    if (!existsSync(join(cwd, ".git"))) {
      score += 0.1;
    }
    if (!existsSync(join(cwd, "package.json")) && !existsSync(join(cwd, "pyproject.toml"))) {
      score += 0.1;
    }
    try {
      const entries = readdirSync(cwd);
      const fileCount = entries.filter((e) => {
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
    }
  }
  return Math.min(score, 1);
}
function matchSkills(task, context, rules) {
  const matches = [];
  const combined = `${task} ${context}`.toLowerCase();
  const skills = rules.skills || {};
  for (const [skillName, config] of Object.entries(skills)) {
    const triggers = config.promptTriggers;
    if (!triggers) continue;
    const keywords = triggers.keywords || [];
    let matchedKeyword = null;
    for (const kw of keywords) {
      if (combined.includes(kw.toLowerCase())) {
        matchedKeyword = kw;
        break;
      }
    }
    const intentPatterns = triggers.intentPatterns || [];
    let matchedIntent = false;
    for (const pattern of intentPatterns) {
      try {
        const regex = new RegExp(pattern, "i");
        if (regex.test(combined)) {
          matchedIntent = true;
          break;
        }
      } catch {
        continue;
      }
    }
    if (matchedKeyword || matchedIntent) {
      const matchType = matchedIntent ? "intent" : "keyword";
      const confidence = matchedIntent ? 0.9 : 0.75;
      matches.push({
        name: skillName,
        enforcement: config.enforcement || "suggest",
        priority: config.priority || "medium",
        confidence,
        reason: `${matchedIntent ? "Intent pattern" : "Keyword"} match: ${matchedKeyword || "pattern"}`,
        match_type: matchType
      });
    }
  }
  const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  matches.sort((a, b) => {
    const pa = priorityOrder[a.priority] ?? 4;
    const pb = priorityOrder[b.priority] ?? 4;
    if (pa !== pb) return pa - pb;
    return b.confidence - a.confidence;
  });
  return matches;
}
function matchAgents(task, context, rules, exclude = []) {
  const matches = [];
  const combined = `${task} ${context}`.toLowerCase();
  const agents = rules.agents || {};
  for (const [agentName, config] of Object.entries(agents)) {
    if (exclude.includes(agentName)) continue;
    const triggers = config.promptTriggers;
    if (!triggers) continue;
    const keywords = triggers.keywords || [];
    let matchedKeyword = null;
    for (const kw of keywords) {
      if (combined.includes(kw.toLowerCase())) {
        matchedKeyword = kw;
        break;
      }
    }
    const intentPatterns = triggers.intentPatterns || [];
    let matchedIntent = false;
    for (const pattern of intentPatterns) {
      try {
        const regex = new RegExp(pattern, "i");
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
        type: AGENT_TYPES[agentName] || config.type || "general",
        confidence,
        reason: `${matchedIntent ? "Intent pattern" : "Keyword"} match`
      });
    }
  }
  matches.sort((a, b) => b.confidence - a.confidence);
  return matches;
}
function recommendPattern(task, context, skills, complexity) {
  const combined = `${task} ${context}`.toLowerCase();
  if (["research", "find", "explore", "understand", "analyze"].some((k) => combined.includes(k))) {
    if (["multiple", "compare", "different"].some((k) => combined.includes(k))) {
      return "swarm";
    }
    return "hierarchical";
  }
  if (["implement", "build", "create", "add"].some((k) => combined.includes(k))) {
    if (complexity >= 0.7) {
      return "pipeline";
    }
    return "hierarchical";
  }
  if (["debug", "fix", "investigate", "root cause"].some((k) => combined.includes(k))) {
    return "hierarchical";
  }
  if (["review", "validate", "check", "audit"].some((k) => combined.includes(k))) {
    if (combined.includes("critical") || combined.includes("security")) {
      return "jury";
    }
    return "generator_critic";
  }
  if (["refactor", "migrate", "upgrade"].some((k) => combined.includes(k))) {
    return "pipeline";
  }
  if (complexity >= 0.7) {
    return "hierarchical";
  }
  return null;
}
function route(input) {
  const {
    task,
    context = "",
    files = [],
    current_pattern,
    exclude_agents = [],
    cwd = ""
  } = input;
  const rules = loadSkillRules();
  const complexity = calculateComplexity(task, context, files, cwd);
  const greenfield = calculateGreenfieldScore(task, context, cwd);
  const skills = matchSkills(task, context, rules);
  const agents = matchAgents(task, context, rules, exclude_agents);
  const pattern = current_pattern || recommendPattern(task, context, skills, complexity.total);
  return {
    skills,
    agents,
    complexity_score: Math.round(complexity.total * 1e3) / 1e3,
    recommended_pattern: pattern,
    llm_assisted: false,
    greenfield_score: Math.round(greenfield * 1e3) / 1e3
  };
}
async function main() {
  let inputData;
  try {
    const input = readFileSync(0, "utf-8");
    inputData = JSON.parse(input);
  } catch {
    console.log(JSON.stringify({ error: "Invalid JSON input or no input provided" }));
    process.exit(1);
  }
  const result = route(inputData);
  console.log(JSON.stringify(result, null, 2));
}
if (process.argv[1] && process.argv[1].includes("skill-router")) {
  main().catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  });
}
export {
  buildEnhancedLookupResult,
  detectCircularDependency,
  getLoadingMode,
  resolveCoActivation,
  resolvePrerequisites,
  route,
  topologicalSort
};
