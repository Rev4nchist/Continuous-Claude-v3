#!/usr/bin/env python3
import json, sys, glob

data = json.load(sys.stdin)
if data.get('stop_hook_active'):
    print('{}'); sys.exit(0)

ctx_files = glob.glob('/tmp/claude-context-pct-*.txt')
if ctx_files:
    try:
        pct = int(open(ctx_files[0]).read().strip())
        if pct >= 85:
            print(json.dumps({
                "decision": "block",
                "reason": f"Context at {pct}%. Run: /create_handoff"
            }))
            sys.exit(0)
    except: pass
print('{}')
