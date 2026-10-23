#!/usr/bin/env node
// sync-current-state.mjs — print a machine snapshot.
// docs/tri-model/CURRENT-STATE.md is a dated record and this script does not rewrite it.
// Deterministic, zero-LLM, zero deps.
//
// Run:  node scripts/tri-model/sync-current-state.mjs

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BEGIN = "<!-- machine:begin (sync-current-state.mjs — do not hand-edit this block) -->";
const END = "<!-- machine:end -->";

function git(...args) {
  try {
    return execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8", timeout: 15000 }).trim();
  } catch {
    return "";
  }
}

function preflightSnapshot() {
  const script = path.join(ROOT, "scripts", "tri-model", "preflight.mjs");
  if (!existsSync(script)) return { line: "preflight.mjs: NOT PRESENT on this branch", ready: null };
  const r = spawnSync(process.execPath, [script, "--json"], {
    encoding: "utf8", timeout: 120000, windowsHide: true,
  });
  try {
    const j = JSON.parse(r.stdout);
    const fails = (j.checks || []).filter((c) => !c.ok && !/git_state/.test(c.name)).map((c) => c.name);
    const v = j.versions || {};
    const versionLine = `grok=${v.grok ?? "?"} (pin ${v.grok_pin ?? "?"})`;
    return {
      line: `preflight: ready=${j.ready} ${j.ready ? "" : "FAILING: " + fails.join(", ")} | ${versionLine}`.replace(/\s+\|/, " |"),
      ready: j.ready,
    };
  } catch {
    return { line: `preflight: could not parse --json output (exit ${r.status})`, ready: null };
  }
}

function rooms() {
  const dir = path.join(ROOT, ".workroom", "rooms");
  if (!existsSync(dir)) return [];
  const out = [];
  for (const id of readdirSync(dir)) {
    const sf = path.join(dir, id, "status.json");
    if (!existsSync(sf)) continue;
    try {
      const s = JSON.parse(readFileSync(sf, "utf8"));
      out.push(`| \`${s.room_id ?? id}\` | ${s.phase ?? "?"} | ${s.current_milestone ?? "-"} | ${s.next_actor ?? "-"} |`);
    } catch {
      out.push(`| \`${id}\` | (unreadable status.json) | - | - |`);
    }
  }
  return out;
}

function surfacePresence() {
  const surfaces = [
    ["/workroom skill", ".claude/skills/workroom/SKILL.md"],
    ["/game-plan skill", ".claude/skills/game-plan/SKILL.md"],
    ["/harness-update skill", ".claude/skills/harness-update/SKILL.md"],
    ["workroom protocol", ".workroom/PROTOCOL.md"],
    ["preflight gate", "scripts/tri-model/preflight.mjs"],
    ["static suite", "scripts/tri-model/tri-model-suite.sh"],
  ];
  return surfaces.map(([label, rel]) => `${existsSync(path.join(ROOT, rel)) ? "[x]" : "[ ]"} ${label} (\`${rel}\`)`);
}

const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
const branch = git("branch", "--show-current") || "(detached)";
const head = git("log", "-1", "--format=%h %s");
const lastTriModel = git("log", "-1", "--format=%h %ad %s", "--date=short", "--", "docs/tri-model", "scripts/tri-model", ".workroom", ".claude/skills/workroom", ".claude/skills/game-plan");
const pf = preflightSnapshot();
const roomRows = rooms();

const block = [
  BEGIN,
  "",
  `**Auto-snapshot:** ${now} · branch \`${branch}\` · HEAD \`${head}\``,
  "",
  `- Last tri-model change: \`${lastTriModel || "n/a"}\``,
  `- ${pf.line}`,
  "- Surfaces present on this checkout:",
  ...surfacePresence().map((l) => `  - ${l}`),
  "",
  "**Workrooms (runtime, gitignored):**",
  "",
  "| Room | Phase | Milestone | Next actor |",
  "|---|---|---|---|",
  ...(roomRows.length ? roomRows : ["| (none) | - | - | - |"]),
  "",
  `_Printed by \`node scripts/tri-model/sync-current-state.mjs\`. docs/tri-model/CURRENT-STATE.md is a dated record and is not rewritten._`,
  "",
  END,
].join("\n");

console.log("docs/tri-model/CURRENT-STATE.md is a dated record. This script does not rewrite it.");
console.log(block);
