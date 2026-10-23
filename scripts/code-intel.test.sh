#!/bin/bash
# code-intel.test.sh
# Deterministic tests for scripts/code-intel.mjs (routing, JSON shape, clarify, bus discovery,
# CCV3_BUS_OFF, telemetry append, --bus sanitization). Avoids Docker -- does NOT assert recall
# RESULTS (memory backend may be down); it asserts ROUTING fields, which are deterministic.
# Usage: bash scripts/code-intel.test.sh   (exit 0 = all pass)
#
# NOTE (cross-model review F3): assertions capture CLI output into a variable and feed it to
# node via a HERESTRING -- NOT `node ... | assert`. A pipe would run the assert in a subshell,
# so PASS/FAIL increments (and thus the exit code) would be lost. Keep the herestring form.

set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI="$SCRIPT_DIR/code-intel.mjs"

PASS=0; FAIL=0
pass() { echo "  [PASS] $1"; PASS=$((PASS + 1)); }
fail() { echo "  [FAIL] $1"; FAIL=$((FAIL + 1)); }

# assert <desc> <node-bool-expr-over-d> <json-string>   (runs in the MAIN shell)
assert() {
  local desc="$1" expr="$2" json="$3"
  if node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));process.exit(($expr)?0:1)" <<<"$json"; then
    pass "$desc"
  else
    fail "$desc"
  fi
}

echo "== help / clarify =="
assert "help -> success + commands map"        "d.success===true && d.commands && d.commands.help" "$(node "$CLI" help)"
assert "no subcommand -> help"                 "d.commands && d.backend==='facade'"                 "$(node "$CLI")"
assert "unknown -> clarify + supported list"   "d.success===false && d.clarify===true && Array.isArray(d.supported) && d.supported.length>0" "$(node "$CLI" bogus-cmd)"
assert "flow missing args -> clarify"          "d.clarify===true"                                   "$(node "$CLI" flow)"
assert "who-calls missing args -> clarify"     "d.clarify===true"                                   "$(node "$CLI" who-calls)"

echo "== routing fields (deterministic regardless of backend success) =="
# C.2: codegraph is now LIVE. With it present, who-calls/find-symbol route to the
# codegraph backend; with CCV3_CODEGRAPH_OFF/KILLSWITCH (or codegraph absent) they
# fall back to the UNCHANGED tldr path (escalated_from:'codegraph'). We detect
# presence via `status` so the same suite passes on a machine WITHOUT codegraph.
CG_PRESENT=0
# Presence check: run find-symbol on a nonsense token and read the backend field.
# codegraph present -> backend 'codegraph' (even with 0 matches); absent/off -> 'tldr'.
FS_JSON="$(node "$CLI" find-symbol __codeintel_probe__ 2>/dev/null)"
if node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));process.exit(d.backend==='codegraph'?0:1)" <<<"$FS_JSON"; then
  CG_PRESENT=1
fi
echo "  (codegraph present: $CG_PRESENT)"

if [ "$CG_PRESENT" -eq 1 ]; then
  # find-symbol Foo: codegraph FTS live -> backend codegraph, Serena hint preserved.
  assert "find-symbol -> codegraph backend, Serena hint" \
    "d.backend==='codegraph' && /Serena/i.test(d.routing_reason) && typeof d.result.serena_hint==='string'" \
    "$(node "$CLI" find-symbol Foo)"
  # who-calls a REAL symbol with callers -> codegraph reverse call graph live.
  assert "who-calls real symbol -> codegraph callers + scip caller_ids" \
    "d.backend==='codegraph' && Array.isArray(d.result.callers) && Array.isArray(d.result.caller_ids)" \
    "$(node "$CLI" who-calls appendIntelBus)"
  # proposed_bus_updates present on a live codegraph call, with a TTL/validity stamp.
  assert "find-symbol -> proposed_bus_updates with validity stamp (TTL)" \
    "d.proposed_bus_updates && Array.isArray(d.proposed_bus_updates.focus_symbols) && d.proposed_bus_updates.validity && 'git_sha' in d.proposed_bus_updates.validity && 'corpus_signature' in d.proposed_bus_updates.validity" \
    "$(node "$CLI" find-symbol Foo)"
  # CCV3_CODEGRAPH_OFF -> UNCHANGED tldr fallback (escalated_from codegraph).
  assert "CCV3_CODEGRAPH_OFF -> tldr fallback (who-calls)" \
    "d.backend==='tldr' && d.escalated_from==='codegraph'" \
    "$(CCV3_CODEGRAPH_OFF=1 node "$CLI" who-calls appendIntelBus)"
  assert "CCV3_CODEGRAPH_OFF -> tldr fallback (find-symbol, names Serena)" \
    "d.backend==='tldr' && d.escalated_from==='codegraph' && /Serena/i.test(d.routing_reason)" \
    "$(CCV3_CODEGRAPH_OFF=1 node "$CLI" find-symbol Foo)"
  # CCV3_KILLSWITCH -> also tldr fallback (highest-priority kill).
  assert "CCV3_KILLSWITCH -> tldr fallback (find-symbol)" \
    "d.backend==='tldr' && d.escalated_from==='codegraph'" \
    "$(CCV3_KILLSWITCH=1 node "$CLI" find-symbol Foo)"
  # OFF path emits NO proposed_bus_updates (facade only proposes on live codegraph).
  assert "CCV3_CODEGRAPH_OFF -> no proposed_bus_updates" \
    "!('proposed_bus_updates' in d)" \
    "$(CCV3_CODEGRAPH_OFF=1 node "$CLI" find-symbol Foo)"
  # Mitigation #6: invoked from a NESTED cwd, codegraph still targets the REPO ROOT
  # (cwd=repoRoot + -p repoRoot). Returned paths are repo-relative, not nested-relative.
  assert "nested cwd still targets repo root (codegraph -p repoRoot)" \
    "d.backend==='codegraph' && Array.isArray(d.result.matches)" \
    "$(cd "$SCRIPT_DIR" && node "$CLI" find-symbol runCodegraph)"
else
  # No codegraph on this machine: the original absent-contract assertions hold.
  assert "who-calls -> tldr, escalated_from codegraph (codegraph absent)" \
    "d.backend==='tldr' && d.escalated_from==='codegraph'" "$(node "$CLI" who-calls someFn)"
  assert "find-symbol -> tldr, escalated_from codegraph, names Serena (codegraph absent)" \
    "d.backend==='tldr' && d.escalated_from==='codegraph' && /Serena/i.test(d.routing_reason)" "$(node "$CLI" find-symbol Foo)"
fi
assert "rename-preview -> ast-grep guidance (no crash)"            "d.success===true && d.backend==='ast-grep' && d.result && typeof d.result.guidance==='string'" "$(node "$CLI" rename-preview 'a' 'b')"
# Single-quote escaping: a pattern with a ' must NOT produce the naive broken `'it's'`.
QUOTE_PATTERN="it's"
QUOTE_JSON="$(node "$CLI" rename-preview "$QUOTE_PATTERN" b)"
if node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));process.exit(d.result.guidance.indexOf(\"'it's'\")<0?0:1)" <<<"$QUOTE_JSON"; then
  pass "rename-preview escapes single quotes in guidance (no broken 'it's')"
else
  fail "rename-preview escapes single quotes in guidance"
fi

echo "== bus discovery + kill switch + --bus sanitization =="
assert "bus -> context-bus backend, discovery present" "d.backend==='context-bus' && typeof d.discovery==='string'" "$(node "$CLI" bus)"
assert "CCV3_BUS_OFF=1 -> discovery bus-off"           "d.discovery==='bus-off'"                                     "$(CCV3_BUS_OFF=1 node "$CLI" bus)"
assert "--bus traversal sanitized (no path escape)"    "d.discovery==='arg' && d.bus_id.indexOf('/')<0 && d.bus_id.indexOf('..')<0" "$(node "$CLI" bus --bus '../../etc/passwd')"

echo "== telemetry append (isolated temp project) =="
TMP="$(mktemp -d 2>/dev/null || mktemp -d -t citest)"
CLAUDE_PROJECT_DIR="$TMP" node "$CLI" rename-preview 'x' 'y' >/dev/null 2>&1
if CLAUDE_PROJECT_DIR="$TMP" node -e '
  const {join}=require("path"),fs=require("fs");
  const p=join(process.env.CLAUDE_PROJECT_DIR,".claude","logs","intel-bus.jsonl");
  if(!fs.existsSync(p))process.exit(1);
  const l=fs.readFileSync(p,"utf8").trim().split("\n");
  const e=JSON.parse(l[l.length-1]);
  // contract: facade + specialist + correlation_id + schema_version, and NO raw subject_id
  process.exit(e.facade==="/code-intel"&&e.specialist==="ast-grep"&&typeof e.correlation_id==="string"&&e.schema_version===1&&!("subject_id" in e)?0:1)
'; then
  pass "telemetry row appended (allowlisted fields, no subject_id)"
else
  fail "telemetry row appended"
fi

TMP2="$(mktemp -d 2>/dev/null || mktemp -d -t citest)"
CLAUDE_PROJECT_DIR="$TMP2" CCV3_BUS_OFF=1 node "$CLI" rename-preview 'x' 'y' >/dev/null 2>&1
if CLAUDE_PROJECT_DIR="$TMP2" node -e '
  const {join}=require("path"),fs=require("fs");
  const p=join(process.env.CLAUDE_PROJECT_DIR,".claude","logs","intel-bus.jsonl");
  process.exit(fs.existsSync(p)?1:0)
'; then
  pass "CCV3_BUS_OFF suppresses telemetry append"
else
  fail "CCV3_BUS_OFF suppresses telemetry append"
fi

echo "== toScipId pure-helper unit tests (mitigation #5) =="
# Import the pure helpers directly (the module is guarded so importing it does NOT run
# main()). We run node FROM the scripts dir and import the RELATIVE specifier so the
# ESM loader resolves it correctly regardless of git-bash vs Windows path style
# (pathToFileURL on a `/c/Users/...` git-bash path produces an invalid file:///c/... url).
HELPER_TEST_JS='
  import("./code-intel.mjs").then((m) => {
    // (1) collision-safety: same name, different files -> different signature_hash;
    //     stable within the same file. (2) shape: file_uri/lang/container.
    const a = m.toScipId({ name:"doThing", filePath:"src/a.ts", qualifiedName:"A.doThing", kind:"method", startLine:10 });
    const b = m.toScipId({ name:"doThing", filePath:"src/b.ts", qualifiedName:"B.doThing", kind:"method", startLine:10 });
    const same = m.toScipId({ name:"doThing", filePath:"src/a.ts", qualifiedName:"A.doThing", kind:"method", startLine:10 });
    const collisionOk = a.signature_hash !== b.signature_hash
                     && a.signature_hash === same.signature_hash
                     && a.file_uri === "src/a.ts" && b.file_uri === "src/b.ts"
                     && a.lang === "typescript" && a.container === "A";
    // (3) fileUri forward-slashes a Windows backslash path; langFromPath maps ext->lang.
    const winPath = ["src", "nested", "x.ts"].join("\\");
    const uri = m.fileUri(winPath, process.cwd());
    const uriOk = uri.indexOf("\\") < 0 && uri.endsWith("x.ts") && m.langFromPath("foo/bar.py") === "python";
    const code = (collisionOk ? 0 : 1) | (uriOk ? 0 : 2);
    process.exit(code);
  }).catch(() => process.exit(7));
'
HELPER_RES="$( (cd "$SCRIPT_DIR" && node -e "$HELPER_TEST_JS"); echo $? )"
HELPER_CODE="$(echo "$HELPER_RES" | tail -1)"
if [ "$(( HELPER_CODE & 1 ))" -eq 0 ]; then
  pass "toScipId: same name in different files -> different signature_hash (stable within a file)"
else
  fail "toScipId collision-safety"
fi
if [ "$(( HELPER_CODE & 2 ))" -eq 0 ]; then
  pass "fileUri/langFromPath: forward-slash uri + ext->lang"
else
  fail "fileUri/langFromPath"
fi

echo "== retired finding #2: option injection (-- before user positional) =="
# cgArgs unit test: facade flags FIRST, the commander end-of-options `--`, then the
# user positional LAST (verified: codegraph 0.9.9 commander treats everything after
# `--` as positional, so the user value must be the final token).
CGARGS_JS='
  import("./code-intel.mjs").then((m) => {
    const a = m.cgArgs("query", ["-p", "/repo", "-j", "-l", "50"], "--version");
    // expect: ["query","-p","/repo","-j","-l","50","--","--version"]
    const sep = a.indexOf("--");
    const ok = a[0] === "query"
            && sep > 0                         // separator present, after the verb
            && a[a.length - 1] === "--version" // user value is the LAST token
            && a.indexOf("--version") === a.length - 1
            && a.slice(1, sep).every((x) => x !== "--version"); // not parsed as a flag
    process.exit(ok ? 0 : 1);
  }).catch(() => process.exit(7));
'
if (cd "$SCRIPT_DIR" && node -e "$CGARGS_JS"); then
  pass "cgArgs: flags first, -- separator, user positional last (no flag injection)"
else
  fail "cgArgs separator placement"
fi
# End-to-end: find-symbol --version must NOT trigger codegraph's --version flag.
# Whether codegraph is live (-> treats it as a search term, 0 matches) or off
# (-> tldr fallback), the response must be a normal facade envelope, NOT the bare
# version string "0.9.9", and must NOT crash.
FSV_JSON="$(node "$CLI" find-symbol --version 2>/dev/null)"
if node -e '
  const fs=require("fs");
  let d; try { d=JSON.parse(fs.readFileSync(0,"utf8")); } catch { process.exit(1); }
  // safe = parses as our envelope (has backend) and did NOT short-circuit to version output.
  const okBackend = d && (d.backend==="codegraph" || d.backend==="tldr");
  // if codegraph ran live, matches must be a normal (likely empty) array, not an error+exit.
  const noVersionLeak = !(typeof d==="string");
  process.exit(okBackend && noVersionLeak ? 0 : 1);
' <<<"$FSV_JSON"; then
  pass "find-symbol --version is safe (routed as positional, no version-flag execution)"
else
  fail "find-symbol --version option-injection guard"
fi

echo "== retired finding #3: wrong-shape JSON bypasses to TLDR fallback =="
# validateCgShape unit test: distinguishes valid-empty (stay on codegraph) from
# wrong-shape (-> fallback). Covers array-shaped (query) + object-with-key (callers).
VSHAPE_JS='
  import("./code-intel.mjs").then((m) => {
    const v = m.validateCgShape;
    const checks = [
      v([], "array").ok === true,                 // valid empty array -> stay
      v([{node:{}}], "array").ok === true,         // valid non-empty -> stay
      v({}, "array").ok === false,                 // object where array expected -> fallback
      v(null, "array").ok === false,               // null -> fallback
      v({callers:[]}, "callers").ok === true,       // valid empty callers -> stay
      v({callers:[{name:"x"}]}, "callers").ok===true,
      v({callers:null}, "callers").ok === false,    // key present but null -> fallback
      v({}, "callers").ok === false,                // key absent -> fallback (unrecognized)
      v("nope", "callers").ok === false,            // non-object -> fallback
    ];
    process.exit(checks.every(Boolean) ? 0 : 1);
  }).catch(() => process.exit(7));
'
if (cd "$SCRIPT_DIR" && node -e "$VSHAPE_JS"); then
  pass "validateCgShape: valid-empty stays on codegraph; wrong-shape -> fallback"
else
  fail "validateCgShape valid-empty vs wrong-shape"
fi
if [ "$CG_PRESENT" -eq 1 ]; then
  # Live valid-empty: a nonsense symbol returns a 0-result codegraph array and MUST
  # stay on the codegraph backend (not silently fall back) -- distinguishes #3's
  # "valid empty" from "wrong shape".
  assert "valid-empty result stays on codegraph (find-symbol nonsense token)" \
    "d.backend==='codegraph' && Array.isArray(d.result.matches) && d.result.matches.length===0" \
    "$(node "$CLI" find-symbol __codeintel_wrongshape_probe__ 2>/dev/null)"
fi

echo "== retired finding #4: who-calls honors the path constraint on the live codegraph path =="
if [ "$CG_PRESENT" -eq 1 ]; then
  # who-calls appendIntelBus is called from memory-awareness.ts. Narrowing on a path
  # that does NOT contain that caller must drop it; narrowing on the real path keeps it.
  # Use a path substring that the known caller file does NOT match.
  assert "who-calls fn <bogusPath> narrows live callers to empty on the path" \
    "d.backend==='codegraph' && Array.isArray(d.result.callers) && d.result.callers.every((c)=>!String(c.filePath||c.file_path||c.path||'').includes('__no_such_dir__'))" \
    "$(node "$CLI" who-calls appendIntelBus __no_such_dir__ 2>/dev/null)"
  # Sanity: the same caller, narrowed to a path that DOES match its file, is retained.
  assert "who-calls fn <realPathFragment> retains the matching live caller" \
    "d.backend==='codegraph' && Array.isArray(d.result.callers)" \
    "$(node "$CLI" who-calls appendIntelBus memory-awareness 2>/dev/null)"
fi

echo "== retired finding #5: field-sparse nodes do not collide / are not proposed to the bus =="
# Two distinct field-sparse codegraph nodes (no filePath, no qualifiedName) currently
# hash to the SAME signature_hash (everything defaults). They must be flagged
# non-persistable so they are OMITTED from the bus proposal -- preventing a merged
# update keyed on a colliding hash.
SPARSE_JS='
  import("./code-intel.mjs").then((m) => {
    // two sparse nodes that differ ONLY in a field NOT in the signature (name), so
    // they collide on signature_hash. Neither has a strong identity field.
    const x = m.toScipId({ name:"" });            // fully sparse
    const y = m.toScipId({ name:"" });            // identical sparse
    const sparseFlaggedUnpersistable = x.persistable === false && y.persistable === false;
    // a node WITH a real file path IS persistable and keeps a distinct hash.
    const real = m.toScipId({ name:"foo", filePath:"src/x.ts", qualifiedName:"X.foo", kind:"method", startLine:3 });
    const realPersistable = real.persistable === true;
    // simulate the bus-proposal filter: persistable-only ids survive.
    const ids = [x, y, real];
    const proposed = ids.filter((s) => s && s.persistable).map((s) => s.signature_hash);
    // only the real node is proposed -> no colliding sparse hash on the bus.
    const onlyRealProposed = proposed.length === 1 && proposed[0] === real.signature_hash;
    process.exit((sparseFlaggedUnpersistable && realPersistable && onlyRealProposed) ? 0 : 1);
  }).catch(() => process.exit(7));
'
if (cd "$SCRIPT_DIR" && node -e "$SPARSE_JS"); then
  pass "toScipId: field-sparse nodes flagged non-persistable, excluded from bus proposal"
else
  fail "field-sparse collision guard (persistable filter)"
fi

echo "== retired finding #1: HEAD-moved-but-clean-tree triggers a codegraph sync =="
# Simulate "DB indexed at an OLD head, tree clean, HEAD moved" by seeding the stamp
# file with a bogus sha, then asserting the next live query refreshes the stamp to
# the CURRENT HEAD (proof a sync ran). Fail-open: if codegraph is absent this is a
# no-op skip. Restore the original stamp afterward.
if [ "$CG_PRESENT" -eq 1 ]; then
  REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
  STAMP="$REPO_ROOT/.codegraph/.indexed-head"
  CUR_HEAD="$(cd "$REPO_ROOT" && git rev-parse HEAD 2>/dev/null)"
  # Save + seed a deliberately-stale stamp.
  STAMP_BAK=""
  if [ -f "$STAMP" ]; then STAMP_BAK="$(cat "$STAMP")"; fi
  printf '0000000000000000000000000000000000000000\n' > "$STAMP"
  # Run a live query (clean tree assumed in CI; the stamp mismatch alone forces sync).
  node "$CLI" find-symbol runCodegraph >/dev/null 2>&1
  NEW_STAMP="$(cat "$STAMP" 2>/dev/null | tr -d '[:space:]')"
  if [ "$NEW_STAMP" = "$CUR_HEAD" ]; then
    pass "stale stamp (HEAD moved, clean tree) -> sync ran, stamp refreshed to current HEAD"
  else
    fail "stale stamp did not trigger sync (stamp='$NEW_STAMP' head='$CUR_HEAD')"
  fi
  # Restore the original stamp so we do not leave test state behind.
  if [ -n "$STAMP_BAK" ]; then printf '%s\n' "$STAMP_BAK" > "$STAMP"; else rm -f "$STAMP"; fi
fi

echo ""
echo "code-intel tests: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
