import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/msys-crash-capture.ts
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from "fs";
import { dirname, join } from "path";
import { spawnSync } from "child_process";
import { homedir } from "os";
var MSYS_SIGNATURES = [
  /fatal error - add_item/i,
  /cygheap base mismatch/i,
  /unable to remap/i,
  /couldn't allocate heap/i
];
var LOG_PATH = process.env.MSYS_EVENT_LOG || join(homedir(), ".claude", "logs", "msys-events.jsonl");
function responseText(resp) {
  if (resp === null || resp === void 0) return "";
  if (typeof resp === "string") return resp;
  if (resp && typeof resp === "object") {
    const o = resp;
    const parts = [o.output, o.stdout, o.stderr, o.error, o.content].filter((v) => typeof v === "string");
    if (parts.length) return parts.join("\n");
  }
  try {
    return JSON.stringify(resp ?? "");
  } catch {
    return "";
  }
}
function isMsysCrash(responseTxt, command) {
  if (!MSYS_SIGNATURES.some((re) => re.test(responseTxt))) return false;
  const cmd = command || "";
  if (/add_item|cygheap|msys-events|msys-crash|windows-platform/i.test(cmd)) return false;
  return true;
}
function exitCodeOf(resp) {
  if (resp && typeof resp === "object") {
    const o = resp;
    for (const k of ["exit_code", "exitCode", "code", "status"]) {
      if (typeof o[k] === "number") return o[k];
    }
    if (o.is_error === true) return -1;
  }
  return null;
}
function redactCommand(cmd) {
  if (!cmd) return "";
  return cmd.replace(/(api[_-]?key|token|secret|password|passwd)\s*[=:]\s*\S+/gi, "$1=<redacted>").replace(/\s+/g, " ").slice(0, 200);
}
function msysCensus() {
  try {
    const localAppData = process.env.LOCALAPPDATA || "";
    if (!localAppData) return { count: null, names: [] };
    const gitRoot = join(localAppData, "Programs", "Git");
    const ps = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$g='${gitRoot}'; (Get-CimInstance Win32_Process | ? { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($g,'OrdinalIgnoreCase') } | Select-Object -ExpandProperty Name) -join ','`
      ],
      { encoding: "utf8", timeout: 5e3, windowsHide: true }
    );
    if (ps.status !== 0) return { count: null, names: [] };
    const names = (ps.stdout || "").trim().split(",").map((s) => s.trim()).filter(Boolean);
    return { count: names.length, names };
  } catch {
    return { count: null, names: [] };
  }
}
var MAX_BYTES = Number(process.env.MSYS_EVENT_LOG_MAX_BYTES) || 5 * 1024 * 1024;
function rotateIfNeeded(path, maxBytes = MAX_BYTES) {
  try {
    if (statSync(path).size < maxBytes) return false;
    renameSync(path, path + ".1");
    return true;
  } catch {
    return false;
  }
}
function append(row) {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    rotateIfNeeded(LOG_PATH);
    appendFileSync(LOG_PATH, JSON.stringify(row) + "\n", "utf8");
  } catch {
  }
}
function main() {
  const raw = readFileSync(0, "utf8");
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    console.log("{}");
    return;
  }
  const tool = input.tool_name || "";
  if (tool !== "Bash" && tool !== "PowerShell") {
    console.log("{}");
    return;
  }
  const command = input.tool_input?.command || "";
  const text = responseText(input.tool_response);
  const crashed = isMsysCrash(text, command);
  const ts = (/* @__PURE__ */ new Date()).toISOString();
  if (!crashed) {
    append({ ts, lane: "bash-tool", tool, ok: 1 });
    console.log("{}");
    return;
  }
  const census = msysCensus();
  append({
    ts,
    lane: "bash-tool",
    tool,
    ok: 0,
    signature: (text.match(/fatal error - [a-z_]+|cygheap base mismatch|unable to remap/i) || [""])[0],
    exit_code: exitCodeOf(input.tool_response),
    command: redactCommand(command),
    cwd: input.cwd || null,
    session_id: input.session_id || null,
    // Sampled AFTER the failure -- a lower bound, not a count at crash time.
    msys_alive_after: census.count,
    msys_names_after: census.names
  });
  console.log("{}");
}
if ((process.argv[1] || "").includes("msys-crash-capture")) {
  try {
    main();
  } catch {
    console.log("{}");
  }
}
export {
  isMsysCrash,
  main,
  redactCommand,
  responseText,
  rotateIfNeeded
};
