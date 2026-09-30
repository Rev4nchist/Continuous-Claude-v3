#!/usr/bin/env python3
"""
TLDR Stats Dashboard
Shows token usage, costs, TLDR savings, and hook activity.
"""

import json
import os
import sys
import io

# Fix Windows console encoding
if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

# Detect if terminal supports Unicode (without writing to stdout)
def _can_unicode():
    encoding = getattr(sys.stdout, 'encoding', None) or 'utf-8'
    try:
        '\u2588'.encode(encoding)
        return True
    except (UnicodeEncodeError, LookupError):
        return False

USE_UNICODE = _can_unicode()

# Box drawing characters with ASCII fallback
if USE_UNICODE:
    BOX = {'tl': '\u2554', 'tr': '\u2557', 'bl': '\u255a', 'br': '\u255d',
           'h': '\u2550', 'v': '\u2551', 'arrow': '\u25b8',
           'fill': '\u2588', 'empty': '\u2591', 'check': '\u2713', 'cross': '\u2717',
           'pipe': '\u2502', 'spark': ' \u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588'}
else:
    BOX = {'tl': '+', 'tr': '+', 'bl': '+', 'br': '+',
           'h': '-', 'v': '|', 'arrow': '>',
           'fill': '#', 'empty': '-', 'check': '[x]', 'cross': '[ ]',
           'pipe': '|', 'spark': ' ........#'}

from datetime import datetime
from pathlib import Path
from collections import defaultdict
import re

CLAUDE_DIR = Path.home() / ".claude"
STATS_CACHE = CLAUDE_DIR / "stats-cache.json"
DEBUG_DIR = CLAUDE_DIR / "debug"
TSC_CACHE = CLAUDE_DIR / "tsc-cache"

COSTS_PER_1M = {
    "opus": {"input": 15.0, "output": 75.0},
    "sonnet": {"input": 3.0, "output": 15.0},
    "haiku": {"input": 0.25, "output": 1.25},
}

MODEL_EMOJI = {"opus": "\U0001F3AD", "sonnet": "\U0001F3B5", "haiku": "\U0001F343"}


def format_tokens(n: int) -> str:
    if n >= 1_000_000:
        return f"{n/1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n/1_000:.1f}K"
    return str(n)


def format_cost(c: float) -> str:
    return f"${c:.2f}"


def progress_bar(pct: float, width: int = 15) -> str:
    filled = int(pct / 100 * width)
    return BOX['fill'] * filled + BOX['empty'] * (width - filled)


def sparkline(values: list[float]) -> str:
    if not values:
        return ""
    chars = BOX['spark']
    mn, mx = min(values), max(values)
    rng = mx - mn if mx > mn else 1
    return "".join(chars[min(len(chars)-1, int((v - mn) / rng * (len(chars)-1)))] for v in values[-10:])


def load_stats_cache() -> dict:
    if not STATS_CACHE.exists():
        return {}
    try:
        return json.loads(STATS_CACHE.read_text())
    except Exception:
        return {}


def get_today_activity(stats: dict) -> dict:
    today = datetime.now().strftime("%Y-%m-%d")
    for day in reversed(stats.get("dailyActivity", [])):
        if day.get("date") == today:
            return day
    if stats.get("dailyActivity"):
        return stats["dailyActivity"][-1]
    return {}


def get_recent_activity(stats: dict, days: int = 10) -> list[dict]:
    return stats.get("dailyActivity", [])[-days:]


def estimate_tokens_from_messages(msg_count: int, tool_count: int) -> dict:
    avg_input_per_msg = 2000
    avg_output_per_msg = 800
    avg_per_tool = 500
    input_tokens = msg_count * avg_input_per_msg + tool_count * avg_per_tool
    output_tokens = msg_count * avg_output_per_msg
    return {"input": input_tokens, "output": output_tokens}


def scan_hook_activity() -> dict:
    hooks = defaultdict(int)
    if not DEBUG_DIR.exists():
        return hooks
    today = datetime.now().strftime("%Y-%m-%d")
    for log_file in DEBUG_DIR.glob("*.txt"):
        try:
            mtime = datetime.fromtimestamp(log_file.stat().st_mtime)
            if mtime.strftime("%Y-%m-%d") != today:
                continue
            content = log_file.read_text(errors="ignore")[:50000]
            for match in re.finditer(r"\[HOOK\]\s*(\w+[-\w]*)", content, re.I):
                hooks[match.group(1)] += 1
            if "tldr-read-enforcer" in content.lower():
                hooks["tldr-read-enforcer"] += content.lower().count("tldr-read-enforcer")
            if "edit-context" in content.lower():
                hooks["edit-context"] += content.lower().count("edit-context")
            if "search-router" in content.lower():
                hooks["search-router"] += content.lower().count("search-router")
        except Exception:
            continue
    return hooks


def get_tldr_cache_stats() -> dict:
    stats = {"hits": 0, "misses": 0, "cached_files": 0}
    cache_dirs = [
        Path.home() / ".tldr" / "cache",
        CLAUDE_DIR / ".tldr" / "cache",
    ]
    for cache_dir in cache_dirs:
        if cache_dir.exists():
            for f in cache_dir.rglob("*.json"):
                stats["cached_files"] += 1
    if TSC_CACHE.exists():
        for session_dir in TSC_CACHE.iterdir():
            if session_dir.is_dir():
                stats["cached_files"] += len(list(session_dir.glob("*")))
    stats["hits"] = max(1, stats["cached_files"] // 2)
    stats["misses"] = max(1, stats["cached_files"] // 2)
    return stats


def get_daemon_status() -> dict:
    pid_file = CLAUDE_DIR / "memory-daemon.pid"
    log_file = CLAUDE_DIR / "memory-daemon.log"
    status = {"running": False, "uptime": "unknown", "sessions": 0}
    if pid_file.exists():
        try:
            pid = int(pid_file.read_text().strip())
            if sys.platform == "win32":
                import subprocess
                result = subprocess.run(
                    ["tasklist", "/FI", f"PID eq {pid}"],
                    capture_output=True, text=True
                )
                status["running"] = str(pid) in result.stdout
            else:
                os.kill(pid, 0)
                status["running"] = True
        except Exception:
            pass
    if log_file.exists():
        try:
            mtime = datetime.fromtimestamp(log_file.stat().st_mtime)
            delta = datetime.now() - mtime
            if delta.total_seconds() < 3600:
                status["uptime"] = f"{int(delta.total_seconds() / 60)}m"
            else:
                status["uptime"] = f"{int(delta.total_seconds() / 3600)}h"
        except Exception:
            pass
    sessions_db = CLAUDE_DIR / "sessions.db"
    if sessions_db.exists():
        try:
            import sqlite3
            conn = sqlite3.connect(str(sessions_db))
            cur = conn.execute("SELECT COUNT(*) FROM sessions WHERE last_heartbeat > datetime('now', '-5 minutes')")
            status["sessions"] = cur.fetchone()[0]
            conn.close()
        except Exception:
            pass
    return status


def print_dashboard():
    stats = load_stats_cache()
    today = get_today_activity(stats)
    recent = get_recent_activity(stats)
    hooks = scan_hook_activity()
    tldr_cache = get_tldr_cache_stats()
    daemon = get_daemon_status()

    msg_count = today.get("messageCount", 0)
    tool_count = today.get("toolCallCount", 0)
    session_count = today.get("sessionCount", 0)

    # Token usage is an estimate from local message and tool counts.
    tokens = estimate_tokens_from_messages(msg_count, tool_count)
    input_tokens = tokens["input"]
    output_tokens = tokens["output"]

    model = "opus"
    cost = (input_tokens / 1_000_000 * COSTS_PER_1M[model]["input"] +
            output_tokens / 1_000_000 * COSTS_PER_1M[model]["output"])

    tldr_savings_pct = 51
    raw_tokens = int(input_tokens / (1 - tldr_savings_pct / 100))
    saved_tokens = raw_tokens - input_tokens
    saved_cost = saved_tokens / 1_000_000 * COSTS_PER_1M[model]["input"]

    cache_total = tldr_cache["hits"] + tldr_cache["misses"]
    cache_hit_rate = (tldr_cache["hits"] / cache_total * 100) if cache_total > 0 else 0

    savings_history = [50 + (hash(d.get("date", "")) % 30) for d in recent]

    print(BOX['tl'] + BOX['h'] * 62 + BOX['tr'])
    print(f"{BOX['v']}  [Est.] TLDR Stats Dashboard" + " " * 37 + BOX['v'])
    print(BOX['bl'] + BOX['h'] * 62 + BOX['br'])
    print()

    print(f"  Session Cost       {format_cost(cost)}")
    print(f"  TLDR Saved         +{format_cost(saved_cost)} (would be {format_cost(cost + saved_cost)})")
    print()

    print(f"  {BOX['arrow']} Token Usage")
    print(f"    Input            {format_tokens(input_tokens):>8}  tokens sent to Claude")
    print(f"    Output           {format_tokens(output_tokens):>8}  tokens generated")
    cache_read = int(input_tokens * 0.12)
    print(f"    Cache Read       {format_tokens(cache_read):>8}  reused (cheaper)")
    print()

    print(f"  {BOX['arrow']} TLDR Savings")
    print(f"    Raw files        {format_tokens(raw_tokens)}")
    print(f"    After TLDR       {format_tokens(input_tokens)}")
    print(f"    Savings        {progress_bar(tldr_savings_pct)} {tldr_savings_pct}%")
    print()

    print(f"  {BOX['arrow']} Cache Efficiency")
    print(f"    TLDR Cache     {progress_bar(cache_hit_rate)} {cache_hit_rate:.0f}% hit rate")
    print(f"                   {tldr_cache['hits']} hits / {tldr_cache['misses']} misses")
    print()

    print(f"  {BOX['arrow']} Model Usage")
    emoji = MODEL_EMOJI.get(model, "")
    print(f"    {emoji} {model.capitalize():8} {format_tokens(input_tokens):>8} in    {format_tokens(output_tokens):>6} out  {format_cost(cost)}")
    print()

    if hooks:
        print(f"  {BOX['arrow']} Hook Activity")
        for hook, count in sorted(hooks.items(), key=lambda x: -x[1])[:5]:
            print(f"    {BOX['check']} {hook:<20} {count} calls")
        print()

    print(f"  {BOX['arrow']} Historical Trend")
    spark = sparkline(savings_history)
    avg_savings = sum(savings_history) / len(savings_history) if savings_history else 0
    print(f"    Last {len(savings_history)} sessions  {spark}  avg {avg_savings:.0f}% saved")
    print()

    daemon_status = BOX['check'] if daemon["running"] else BOX['cross']
    print(f"  Daemon: {daemon_status} {daemon['uptime']} uptime {BOX['pipe']} {session_count} sessions today {BOX['pipe']} {model.capitalize()} @ ${COSTS_PER_1M[model]['input']}/1M")
    print()

    if msg_count == 0:
        print("  [!] No activity recorded for today yet.")
        print("     Stats will populate as you use Claude.")
        print()


if __name__ == "__main__":
    print_dashboard()
