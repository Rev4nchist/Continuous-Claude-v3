#!/usr/bin/env node
import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/auto-build.ts
async function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => data += chunk);
    process.stdin.on("end", () => resolve(data));
  });
}
async function main() {
  await readStdin();
  console.log(JSON.stringify({}));
}
main().catch((err) => {
  console.error("[auto-build] Error:", err.message);
  console.log(JSON.stringify({}));
});
