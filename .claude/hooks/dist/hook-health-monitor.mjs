import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/hook-health-monitor.ts
import * as fs2 from "fs";
import * as path2 from "path";
import * as os from "os";

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

// src/hook-health-monitor.ts
function parseHookCommands(settings) {
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== "object") {
    return [];
  }
  const seen = /* @__PURE__ */ new Set();
  const results = [];
  for (const [eventName, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!group.hooks || !Array.isArray(group.hooks)) continue;
      for (const hook of group.hooks) {
        if (hook.type !== "command" || !hook.command) continue;
        const commandLine = [hook.command, ...hook.args || []].join(" ");
        const distPath = extractDistPath(commandLine);
        if (!distPath) continue;
        if (seen.has(distPath)) continue;
        seen.add(distPath);
        const hookName = path2.basename(distPath, ".mjs");
        const srcPath = deriveSrcPath(distPath);
        results.push({
          distPath,
          srcPath,
          hookEvent: eventName,
          hookName,
          matcher: group.matcher
        });
      }
    }
  }
  return results;
}
function extractDistPath(command) {
  const match = command.match(/^node\s+(.+\.mjs)\s*$/);
  if (!match) return null;
  let filePath = match[1].trim();
  const normalized = filePath.replace(/\\/g, "/");
  if (!normalized.includes("hooks/dist/")) return null;
  if (filePath.startsWith("~/") || filePath.startsWith("~\\")) {
    filePath = path2.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}
function deriveSrcPath(distPath) {
  const normalized = distPath.replace(/\\/g, "/");
  const srcPath = normalized.replace("/hooks/dist/", "/hooks/src/").replace(/\.mjs$/, ".ts");
  return srcPath;
}
function checkHookHealth(hookInfo) {
  const { distPath, srcPath, hookEvent, hookName } = hookInfo;
  if (!fs2.existsSync(distPath)) {
    return { hookName, status: "missing", hookEvent };
  }
  if (!fs2.existsSync(srcPath)) {
    return { hookName, status: "healthy", hookEvent };
  }
  const distDir = path2.dirname(distPath);
  const srcRoot = path2.resolve(distDir, "..", "src");
  const freshness = assessFileFreshness(srcPath, srcRoot, loadBuildInputs(distDir));
  if (freshness.state === "stale") {
    return { hookName, status: "stale", hookEvent };
  }
  if (freshness.state === "unknown") {
    return { hookName, status: "healthy", hookEvent, info: freshness.info };
  }
  return { hookName, status: "healthy", hookEvent };
}
function formatHealthReport(results) {
  if (results.length === 0) {
    return "Hook Health: No hooks registered";
  }
  const healthy = results.filter((r) => r.status === "healthy");
  const issues = results.filter((r) => r.status !== "healthy");
  if (issues.length === 0) {
    return `Hook Health: All ${results.length} hooks healthy`;
  }
  const lines = [];
  const issueWord = issues.length === 1 ? "issue" : "issues";
  lines.push(`Hook Health: ${healthy.length}/${results.length} healthy, ${issues.length} ${issueWord} found`);
  for (const issue of issues) {
    if (issue.status === "missing") {
      lines.push(`- MISSING: ${issue.hookName}.mjs (fix: npm run build)`);
    } else if (issue.status === "stale") {
      lines.push(`- STALE: ${issue.hookName}.mjs (content differs from the build manifest, fix: npm run build)`);
    }
  }
  return lines.join("\n");
}
async function readStdin() {
  return new Promise((resolve2) => {
    let data = "";
    process.stdin.on("data", (chunk) => data += chunk);
    process.stdin.on("end", () => resolve2(data));
  });
}
async function main() {
  let input;
  try {
    const stdin = await readStdin();
    input = stdin ? JSON.parse(stdin) : { session_id: "unknown" };
  } catch {
    input = { session_id: "unknown" };
  }
  try {
    const userProfile = process.env.USERPROFILE || process.env.HOME || "";
    const settingsPath = path2.join(userProfile, ".claude", "settings.json");
    if (!fs2.existsSync(settingsPath)) {
      console.log(JSON.stringify({ result: "continue" }));
      return;
    }
    let settings;
    try {
      const content = fs2.readFileSync(settingsPath, "utf-8");
      settings = JSON.parse(content);
    } catch {
      console.error("hook-health-monitor: Could not parse settings.json");
      console.log(JSON.stringify({ result: "continue" }));
      return;
    }
    const hookFiles = parseHookCommands(settings);
    if (hookFiles.length === 0) {
      console.log(JSON.stringify({ result: "continue" }));
      return;
    }
    const results = hookFiles.map((hf) => checkHookHealth(hf));
    const report = formatHealthReport(results);
    const hasIssues = results.some((r) => r.status !== "healthy");
    const output = { result: "continue" };
    if (hasIssues) {
      output.hookSpecificOutput = {
        hookEventName: "SessionStart",
        additionalContext: report
      };
      console.error(report);
    } else {
      const info = results.find((r) => r.info)?.info;
      console.error(info ?? `Hook Health: All ${results.length} hooks healthy`);
    }
    console.log(JSON.stringify(output));
  } catch (err) {
    console.error(`hook-health-monitor error: ${err}`);
    console.log(JSON.stringify({ result: "continue" }));
  }
}
if (!process.env.VITEST) {
  main().catch((err) => {
    console.error(err);
    console.log(JSON.stringify({ result: "continue" }));
  });
}
export {
  checkHookHealth,
  formatHealthReport,
  parseHookCommands
};
