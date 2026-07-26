#!/usr/bin/env node
import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/session-start-intel-prune.ts
import { readFileSync } from "fs";

// src/shared/intel-bus.ts
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
var DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1e3;
function intelBusPath(projectDir) {
  const root = projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  return join(root, ".claude", "logs", "intel-bus.jsonl");
}
function pruneIntelBus(opts = {}) {
  try {
    const now = opts.now ?? (() => Date.now());
    const stat = opts.stat ?? ((p) => ({ mtimeMs: statSync(p).mtimeMs }));
    const unlink = opts.unlink ?? unlinkSync;
    const maxAgeMs = opts.maxAgeMs ?? DEFAULT_RETENTION_MS;
    const live = intelBusPath(opts.projectDir);
    const cutoff = now() - maxAgeMs;
    for (const suffix of [".1", ".2"]) {
      const rotated = `${live}${suffix}`;
      try {
        const { mtimeMs } = stat(rotated);
        if (mtimeMs < cutoff) {
          unlink(rotated);
        }
      } catch {
      }
    }
  } catch {
  }
}

// src/session-start-intel-prune.ts
function runPrune(projectDir) {
  if (process.env.CCV3_BUS_OFF === "1") return;
  pruneIntelBus(projectDir ? { projectDir } : {});
}
function main() {
  try {
    readFileSync(0, "utf-8");
  } catch {
  }
  try {
    runPrune();
  } catch {
  }
  console.log("{}");
}
if (process.argv[1] && process.argv[1].includes("session-start-intel-prune")) {
  main();
}
export {
  runPrune
};
