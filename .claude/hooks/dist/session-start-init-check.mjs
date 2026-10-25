#!/usr/bin/env node
import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/session-start-init-check.ts
import * as fs2 from "fs";
import * as path2 from "path";
import { execSync } from "child_process";

// src/lib/spawn-hidden.ts
import { spawn } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
var RELAY_ERROR_LOG = join(tmpdir(), "ccv3-spawn-hidden.log");
var RELAY_LAUNCH_FAILED = 127;
var RELAY_SCRIPT = `const{spawn}=require('child_process');const[c,...a]=process.argv.slice(1);const p=spawn(c,a,{stdio:'inherit',windowsHide:true});p.on('error',(e)=>{const m='['+new Date().toISOString()+'] spawn-hidden: cannot start '+c+': '+(e.code||'')+' '+e.message+'\\n';try{process.stderr.write(m)}catch{}try{require('fs').appendFileSync(process.env.CCV3_SPAWN_HIDDEN_LOG||require('path').join(require('os').tmpdir(),'ccv3-spawn-hidden.log'),m)}catch{}process.exit(${RELAY_LAUNCH_FAILED})});p.on('exit',(code)=>process.exit(code??1));`;
function spawnDetachedHidden(cmd, args, options = {}, spawnFn = spawn, platform = process.platform) {
  const opts = { ...options, detached: true, windowsHide: true };
  if (platform !== "win32") return spawnFn(cmd, [...args], opts);
  return spawnFn(process.execPath, ["-e", RELAY_SCRIPT, "--", cmd, ...args], opts);
}

// src/shared/dist-freshness.ts
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
var BUILD_INPUTS_NAME = ".build-inputs.json";
var MANIFEST_MISSING_INFO = "[i] Hook dist freshness manifest missing (.build-inputs.json); not using mtime, so no stale warning. Run: cd ~/.claude/hooks && npm run build";
function sha256(content) {
  const text = (typeof content === "string" ? content : content.toString("utf8")).replace(/\r/g, "");
  return createHash("sha256").update(text).digest("hex");
}
function srcKey(srcRoot, filePath) {
  return path.relative(srcRoot, filePath).split(path.sep).join("/");
}
function listSrcFiles(srcRoot) {
  const out = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) out.push(full);
    }
  };
  walk(srcRoot);
  return out;
}
function loadBuildInputs(distDir) {
  const manifestPath = path.join(distDir, BUILD_INPUTS_NAME);
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (parsed.version !== 1 || parsed.algorithm !== "sha256" || !parsed.inputs || typeof parsed.inputs !== "object") {
      return null;
    }
    return { version: 1, algorithm: "sha256", inputs: parsed.inputs };
  } catch {
    return null;
  }
}
function assessFileFreshness(srcPath, srcRoot, manifest) {
  if (!manifest) return { state: "unknown", info: MANIFEST_MISSING_INFO };
  let current;
  try {
    current = sha256(fs.readFileSync(srcPath));
  } catch {
    return { state: "stale" };
  }
  const recorded = manifest.inputs[srcKey(srcRoot, srcPath)];
  if (!recorded || recorded !== current) return { state: "stale" };
  return { state: "fresh" };
}
function assessTreeFreshness(srcRoot, distDir) {
  const srcFiles = listSrcFiles(srcRoot);
  const manifest = loadBuildInputs(distDir);
  if (!manifest) {
    return { state: "unknown", staleFiles: [], srcCount: srcFiles.length, info: MANIFEST_MISSING_INFO };
  }
  const staleFiles = srcFiles.filter((file) => assessFileFreshness(file, srcRoot, manifest).state === "stale");
  return {
    state: staleFiles.length > 0 ? "stale" : "fresh",
    staleFiles,
    srcCount: srcFiles.length
  };
}
function formatStaleDistWarning(srcRoot, result) {
  if (result.state === "unknown") return result.info ?? MANIFEST_MISSING_INFO;
  if (result.state !== "stale") return null;
  const names = result.staleFiles.slice(0, 3).map((file) => srcKey(srcRoot, file)).join(", ");
  const more = result.staleFiles.length > 3 ? `, +${result.staleFiles.length - 3} more` : "";
  return `[!] Hook dist/ is stale -- ${result.staleFiles.length} of ${result.srcCount} sources differ from the build manifest (${names}${more}). Run: cd ~/.claude/hooks && npm run build`;
}

// src/session-start-init-check.ts
var TREE_MAX_AGE_SECONDS = 300;
function getOpcDir() {
  return process.env.CLAUDE_OPC_DIR || path2.join(process.env.HOME || process.env.USERPROFILE || "", "continuous-claude", "opc");
}
function warmTldrDaemon(projectDir) {
  if (process.env.CCV3_TLDR_WARM_OFF) return false;
  try {
    const cmd = process.platform === "win32" ? "tldr.exe" : "tldr";
    const child = spawnDetachedHidden(cmd, ["daemon", "start", "--project", projectDir], {
      stdio: "ignore"
    });
    child.on("error", () => {
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
function isTreeStale(projectDir) {
  const treePath = path2.join(projectDir, ".claude", "knowledge-tree.json");
  if (!fs2.existsSync(treePath)) {
    return true;
  }
  try {
    const content = JSON.parse(fs2.readFileSync(treePath, "utf-8"));
    if (content._stale) return true;
    const stats = fs2.statSync(treePath);
    const ageSeconds = (Date.now() - stats.mtimeMs) / 1e3;
    return ageSeconds >= TREE_MAX_AGE_SECONDS;
  } catch {
    return true;
  }
}
function generateTree(projectDir) {
  const opcDir = getOpcDir();
  const lazyTreePath = path2.join(opcDir, "scripts", "core", "lazy_tree.py");
  if (!fs2.existsSync(lazyTreePath)) {
    const knowledgeTreePath = path2.join(opcDir, "scripts", "core", "knowledge_tree.py");
    if (!fs2.existsSync(knowledgeTreePath)) {
      return false;
    }
    try {
      execSync(
        `cd "${opcDir}" && uv run python scripts/core/knowledge_tree.py --project "${projectDir}"`,
        { encoding: "utf-8", timeout: 1e4, stdio: ["pipe", "pipe", "pipe"] }
      );
      return true;
    } catch {
      return false;
    }
  }
  try {
    execSync(
      `cd "${opcDir}" && uv run python scripts/core/lazy_tree.py regenerate --project "${projectDir}"`,
      { encoding: "utf-8", timeout: 1e4, stdio: ["pipe", "pipe", "pipe"] }
    );
    return true;
  } catch {
    return false;
  }
}
function isInitialized(projectDir) {
  const treePath = path2.join(projectDir, ".claude", "knowledge-tree.json");
  const roadmapPath = path2.join(projectDir, "ROADMAP.md");
  return {
    tree: fs2.existsSync(treePath),
    roadmap: fs2.existsSync(roadmapPath)
  };
}
function hasCodeFiles(projectDir) {
  const codeIndicators = [
    "package.json",
    "pyproject.toml",
    "Cargo.toml",
    "go.mod",
    "requirements.txt",
    "pom.xml",
    "build.gradle",
    "Gemfile",
    "README.md",
    "readme.md",
    ".git"
  ];
  for (const indicator of codeIndicators) {
    if (fs2.existsSync(path2.join(projectDir, indicator))) {
      return true;
    }
  }
  const codeExtensions = /* @__PURE__ */ new Set([
    ".py",
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".go",
    ".rs",
    ".rb",
    ".java",
    ".c",
    ".cpp",
    ".h",
    ".cs",
    ".kt",
    ".swift"
  ]);
  try {
    const entries = fs2.readdirSync(projectDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        const ext = path2.extname(entry.name).toLowerCase();
        if (codeExtensions.has(ext)) {
          return true;
        }
      }
    }
  } catch {
  }
  return false;
}
function checkExternalSkillStaleness() {
  const result = { needsRevetting: [], stale: [] };
  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  const rulesPath = path2.join(homeDir, ".claude", "skills", "skill-rules.json");
  const lockPath = path2.join(homeDir, ".agents", ".skill-lock.json");
  if (!fs2.existsSync(rulesPath)) return result;
  try {
    const rules = JSON.parse(fs2.readFileSync(rulesPath, "utf-8"));
    const skills = rules.skills || {};
    let lockData = {};
    if (fs2.existsSync(lockPath)) {
      try {
        const lock = JSON.parse(fs2.readFileSync(lockPath, "utf-8"));
        lockData = lock.skills || {};
      } catch {
      }
    }
    const now = Date.now();
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1e3;
    for (const [name, skill] of Object.entries(skills)) {
      if (!skill.source || skill.source.registry !== "skills.sh") continue;
      const dateStr = skill.source.updatedAt || skill.source.installedAt;
      if (dateStr) {
        const timestamp = new Date(dateStr).getTime();
        if (now - timestamp > THIRTY_DAYS_MS) {
          result.stale.push(name);
        }
      }
      if (lockData[name] && skill.source.folderHash) {
        if (lockData[name].skillFolderHash !== skill.source.folderHash) {
          result.needsRevetting.push(name);
        }
      }
    }
  } catch {
  }
  return result;
}
function detectProjectStack(projectDir) {
  const stack = [];
  const pkgPath = path2.join(projectDir, "package.json");
  if (fs2.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs2.readFileSync(pkgPath, "utf-8"));
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      stack.push(...Object.keys(allDeps));
    } catch {
    }
  }
  const pyprojectPath = path2.join(projectDir, "pyproject.toml");
  if (fs2.existsSync(pyprojectPath)) {
    try {
      const content = fs2.readFileSync(pyprojectPath, "utf-8");
      const depMatches = content.match(/^\s*"?([a-zA-Z0-9_-]+)"?\s*[>=<~^]/gm);
      if (depMatches) {
        stack.push(...depMatches.map((m) => m.trim().replace(/[">=<~^ ]/g, "")));
      }
    } catch {
    }
  }
  try {
    const topLevelFiles = fs2.readdirSync(projectDir);
    if (topLevelFiles.some((f) => f.endsWith(".bicep") || f.endsWith(".bicepparam"))) {
      stack.push("@azure/bicep-indicator");
    }
    if (topLevelFiles.includes("Cargo.toml")) {
      stack.push("rust-indicator");
    }
    if (topLevelFiles.includes("go.mod")) {
      stack.push("go-indicator");
    }
    for (const entry of topLevelFiles) {
      try {
        const subPath = path2.join(projectDir, entry);
        const stat = fs2.statSync(subPath);
        if (!stat.isDirectory() || entry.startsWith(".") || entry === "node_modules") continue;
        const subFiles = fs2.readdirSync(subPath);
        if (subFiles.includes("package.json")) {
          try {
            const pkg = JSON.parse(fs2.readFileSync(path2.join(subPath, "package.json"), "utf-8"));
            const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
            stack.push(...Object.keys(allDeps));
          } catch {
          }
        }
        if (subFiles.includes("pyproject.toml")) {
          try {
            const content = fs2.readFileSync(path2.join(subPath, "pyproject.toml"), "utf-8");
            const depMatches = content.match(/^\s*"?([a-zA-Z0-9_-]+)"?\s*[>=<~^]/gm);
            if (depMatches) {
              stack.push(...depMatches.map((m) => m.trim().replace(/[">=<~^ ]/g, "")));
            }
          } catch {
          }
        }
        if (subFiles.some((f) => f.endsWith(".bicep") || f.endsWith(".bicepparam"))) {
          if (!stack.includes("@azure/bicep-indicator")) {
            stack.push("@azure/bicep-indicator");
          }
        }
      } catch {
      }
    }
  } catch {
  }
  return stack;
}
function findRecommendedSkills(projectStack, installedSkills) {
  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  const catalogPath = path2.join(homeDir, ".claude", "skills", "skill-catalog.json");
  if (!fs2.existsSync(catalogPath)) return [];
  let catalog;
  try {
    catalog = JSON.parse(fs2.readFileSync(catalogPath, "utf-8"));
  } catch {
    return [];
  }
  const recommendations = [];
  for (const [stackName, stackDef] of Object.entries(catalog.stacks)) {
    const matched = stackDef.indicators.some(
      (ind) => projectStack.some((dep) => dep.toLowerCase() === ind.toLowerCase())
    );
    const fileMatched = (stackDef.fileIndicators || []).some((pattern) => {
      const ext = pattern.replace("*", "");
      return projectStack.some((dep) => dep.includes(ext + "-indicator") || dep.toLowerCase().includes(ext));
    });
    if (matched || fileMatched) {
      for (const skill of stackDef.skills) {
        if (!installedSkills.has(skill.name)) {
          recommendations.push({ ...skill, stackName });
        }
      }
    }
  }
  return recommendations;
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
  const sessionType = data.source || data.type || "startup";
  if (sessionType !== "startup") {
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  if (projectDir.includes(".claude") && !projectDir.includes("continuous-claude")) {
    console.error(
      `[init-check] Skipping bootstrap: project path contains '.claude' (cwd=${projectDir}). Set CLAUDE_PROJECT_DIR explicitly to override.`
    );
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  if (hasCodeFiles(projectDir) && warmTldrDaemon(projectDir)) {
    console.error("[init-check] warming tldr daemon (background)");
  }
  const status = isInitialized(projectDir);
  let treeGenFailed = false;
  if (!status.tree || isTreeStale(projectDir)) {
    if (hasCodeFiles(projectDir)) {
      console.error("[*] Generating knowledge tree...");
      const generated = generateTree(projectDir);
      if (generated) {
        console.error("[ok] Knowledge tree generated");
        status.tree = true;
      } else {
        console.error("[!] Failed to generate knowledge tree");
        treeGenFailed = true;
      }
    }
  }
  const skillStaleness = checkExternalSkillStaleness();
  const hasSkillIssues = skillStaleness.needsRevetting.length > 0 || skillStaleness.stale.length > 0;
  let skillRecommendations = [];
  try {
    const homeDir = process.env.HOME || process.env.USERPROFILE || "";
    const rulesPath = path2.join(homeDir, ".claude", "skills", "skill-rules.json");
    const installedSkills = /* @__PURE__ */ new Set();
    if (fs2.existsSync(rulesPath)) {
      try {
        const rules = JSON.parse(fs2.readFileSync(rulesPath, "utf-8"));
        for (const name of Object.keys(rules.skills || {})) {
          installedSkills.add(name);
        }
      } catch {
      }
    }
    const projectStack = detectProjectStack(projectDir);
    if (projectStack.length > 0) {
      skillRecommendations = findRecommendedSkills(projectStack, installedSkills);
    }
  } catch {
  }
  const hasRecommendations = skillRecommendations.length > 0;
  let hookDistLine = null;
  if (projectDir.includes("continuous-claude")) {
    const hookSrcDir = path2.join(projectDir, ".claude", "hooks", "src");
    const hookDistDir = path2.join(projectDir, ".claude", "hooks", "dist");
    if (fs2.existsSync(hookSrcDir) && fs2.existsSync(hookDistDir)) {
      try {
        hookDistLine = formatStaleDistWarning(hookSrcDir, assessTreeFreshness(hookSrcDir, hookDistDir));
      } catch {
      }
    }
  }
  if (status.tree && status.roadmap && !treeGenFailed && !hasSkillIssues && !hasRecommendations && !hookDistLine) {
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  if (!hasCodeFiles(projectDir) && !hasSkillIssues && !hasRecommendations) {
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  const missing = [];
  if (!status.roadmap) missing.push("ROADMAP.md");
  if (treeGenFailed) missing.push("knowledge-tree.json (generation failed - agents will lack project context)");
  const skillWarnings = [];
  if (skillStaleness.needsRevetting.length > 0) {
    skillWarnings.push(`[!] ${skillStaleness.needsRevetting.length} skill(s) updated externally, need re-vetting: ${skillStaleness.needsRevetting.join(", ")}. Run /vet-skill --all-unvetted`);
  }
  if (skillStaleness.stale.length > 0) {
    skillWarnings.push(`[i] ${skillStaleness.stale.length} skill(s) installed 30+ days ago without update check: ${skillStaleness.stale.join(", ")}. Run npx skills check`);
  }
  const skillRecommendationMessages = [];
  if (skillRecommendations.length > 0) {
    const lines = skillRecommendations.map(
      (r) => `  - ${r.name} (${r.publisher}): npx skills add ${r.source} -g -y`
    );
    skillRecommendationMessages.push(
      `[i] Skills available for this project stack:
${lines.join("\n")}
Install relevant skills to enhance your work on this project.`
    );
  }
  const maintenanceWarnings = [];
  const roadmapPath = path2.join(projectDir, "ROADMAP.md");
  if (fs2.existsSync(roadmapPath)) {
    try {
      const roadmapContent = fs2.readFileSync(roadmapPath, "utf-8");
      const completedCount = (roadmapContent.match(/^- \[x\]/gm) || []).length;
      if (completedCount > 50) {
        maintenanceWarnings.push(`[i] ROADMAP has ${completedCount} completed items (threshold: 50). Consider archiving old entries.`);
      }
    } catch {
    }
  }
  if (hookDistLine) maintenanceWarnings.push(hookDistLine);
  if (missing.length === 0 && skillWarnings.length === 0 && skillRecommendationMessages.length === 0 && maintenanceWarnings.length === 0) {
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  let message = "";
  if (missing.length > 0) {
    message += `[!] Project partially initialized. Missing: ${missing.join(", ")}. Run /init-project for full Continuous Claude setup.`;
  }
  if (skillWarnings.length > 0) {
    if (message) message += " | ";
    message += skillWarnings.join(" | ");
  }
  if (skillRecommendationMessages.length > 0) {
    if (message) message += "\n";
    message += skillRecommendationMessages.join("\n");
  }
  if (maintenanceWarnings.length > 0) {
    if (message) message += "\n";
    message += maintenanceWarnings.join("\n");
  }
  console.error(message);
  const output = {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: message
    }
  };
  console.log(JSON.stringify(output));
}
async function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => data += chunk);
    process.stdin.on("end", () => resolve(data));
  });
}
if ((process.argv[1] || "").includes("session-start-init-check")) {
  main().catch((err) => {
    console.error("session-start-init-check error:", err);
    console.log(JSON.stringify({ result: "continue" }));
  });
}
export {
  warmTldrDaemon
};
