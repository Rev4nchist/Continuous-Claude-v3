"""Headless Claude Code runs for skill evals.

Every run follows one contract:
  - `claude -p --output-format stream-json --verbose`, the prompt on stdin
  - ANTHROPIC_API_KEY removed from the child env, so the run bills the subscription
  - hooks off and an empty strict MCP config, so only the skill and the built-in tools act
  - spawned with shell=False (see scripts/skills/trigger-probe.mjs for the same pattern)
  - a --max-turns cap
Never Haiku. Models come from resolve_models().
"""

import json
import os
import re
import shutil
import subprocess
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path

DEFAULT_TOOLS = "Skill,Read,Glob,Grep"  # read-only: an eval run must not change the machine
DEFAULT_MAX_TURNS = 12
DEFAULT_TIMEOUT = 600


@dataclass(frozen=True)
class Model:
    alias: str
    id: str
    effort: str


# The eval loop: Sonnet at high effort, Opus, Fable. Effort is high for all three so a model
# comparison does not also compare effort settings.
KNOWN_MODELS = {
    "sonnet": Model("sonnet", "claude-sonnet-5-5", "high"),
    "opus": Model("opus", "claude-opus-5-5", "high"),
    "fable": Model("fable", "claude-fable-5-1", "high"),
}
DEFAULT_ALIASES = ("sonnet", "opus", "fable")
_ID_RE = re.compile(r"^claude-[a-z0-9][a-z0-9.-]*$")


def resolve_models(spec: str | None) -> list[Model]:
    """Parse a comma list of aliases (sonnet, opus, fable) or claude-* ids. Reject Haiku."""
    if spec is None or not spec.strip():
        return [KNOWN_MODELS[a] for a in DEFAULT_ALIASES]
    out: list[Model] = []
    for part in re.split(r"[,\s]+", spec.strip()):
        if not part:
            continue
        low = part.lower()
        if "haiku" in low:
            raise ValueError(f"model '{part}' is Haiku. The eval loop never uses Haiku.")
        if low in KNOWN_MODELS:
            model = KNOWN_MODELS[low]
        elif _ID_RE.match(low):
            model = Model(low.replace("claude-", "", 1), low, "high")
        else:
            raise ValueError(f"unknown model '{part}'. Use sonnet, opus, fable or a claude-* model id.")
        if model not in out:
            out.append(model)
    if not out:
        raise ValueError("no model given")
    return out


# Credentials that would bill the API instead of the subscription.
BILLING_ENV = ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN")


def child_env(base: dict | None = None) -> dict:
    """The environment of a headless child: the parent env without the API credentials."""
    env = dict(os.environ if base is None else base)
    for key in list(env):
        if key.upper() in BILLING_ENV:
            del env[key]
    return env


def user_settings(home: Path | None = None) -> dict:
    """The user's ~/.claude/settings.json, or {} when it is missing or unreadable."""
    path = Path(home or Path.home()) / ".claude" / "settings.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def user_skill_overrides(home: Path | None = None) -> dict:
    """The user's skillOverrides map. A --settings file may replace it, so both configs of an eval
    carry the same map and differ only by the skill under test."""
    overrides = user_settings(home).get("skillOverrides")
    return dict(overrides) if isinstance(overrides, dict) else {}


def api_key_helper_warning(home: Path | None = None) -> str | None:
    """apiKeyHelper in the user settings can supply an API key that env removal does not stop."""
    if user_settings(home).get("apiKeyHelper"):
        return ("apiKeyHelper is set in ~/.claude/settings.json. Removing ANTHROPIC_API_KEY from the child env "
                "does not stop a helper from supplying a key, so a run may bill the API. Check before a large run.")
    return None


def name_matches(candidate: str, name: str) -> bool:
    """A skill name, or a plugin-qualified form of it (plugin:name). skillOverrides does not reach plugin skills."""
    return candidate == name or candidate.endswith(":" + name)


def find_claude(env: dict | None = None) -> str:
    """The claude executable on PATH. A .cmd shim is not accepted: it would need a shell."""
    env = env or os.environ
    names = ["claude.exe"] if os.name == "nt" else ["claude"]
    for d in str(env.get("PATH") or env.get("Path") or "").split(os.pathsep):
        for n in names:
            p = Path(d) / n
            if p.is_file():
                return str(p)
    raise RuntimeError("claude executable not found on PATH (a .cmd shim is not supported: it needs a shell)")


def make_temp(prefix: str) -> Path:
    """A temp folder under its long-form path. On Windows TEMP can be an 8.3 short name
    (C:\\Users\\DAVID~1.HAY\\...). Claude Code treats that as a suspicious path, asks for approval,
    and the run's Skill and Read calls fail."""
    return Path(os.path.realpath(tempfile.mkdtemp(prefix=prefix)))


def _fwd(p) -> str:
    return str(p).replace("\\", "/")


def write_json(path: Path, data) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=1), encoding="utf-8", newline="\n")
    return path


def write_settings(path: Path, skill_overrides: dict | None = None, deny_reads: list[str] | None = None) -> Path:
    """A --settings file: every hook off, plus skillOverrides and Read deny rules when given.

    deny_reads blocks direct reads of the real skill's folders. With the skill off, a model that
    knows the skill exists (CLAUDE.md names some skills) can still open its SKILL.md with Read,
    which contaminates the baseline.
    """
    data: dict = {"disableAllHooks": True}
    if skill_overrides:
        data["skillOverrides"] = dict(skill_overrides)
    if deny_reads:
        data["permissions"] = {"deny": [f"Read({p})" for p in deny_reads]}
    return write_json(path, data)


def write_empty_mcp(path: Path) -> Path:
    return write_json(path, {"mcpServers": {}})


def build_command(model: Model, settings: Path, mcp_config: Path, tools: str = DEFAULT_TOOLS,
                  max_turns: int = DEFAULT_MAX_TURNS, exe: str | None = None, allowed: str | None = None) -> list[str]:
    """The argv of one headless run. The prompt goes on stdin.

    `tools` is the set of built-in tools the run can see. `allowed` pre-approves tools: without it,
    `claude -p` denies a tool that needs permission, such as the Skill tool.
    """
    cmd = [exe or find_claude(), "-p", "--output-format", "stream-json", "--verbose", "--tools", tools]
    if allowed:
        cmd += ["--allowedTools", allowed]
    return cmd + ["--max-turns", str(max_turns),
                  "--strict-mcp-config", "--mcp-config", _fwd(mcp_config), "--settings", _fwd(settings),
                  "--no-session-persistence", "--model", model.id, "--effort", model.effort]


@dataclass
class ClaudeRun:
    stdout: str
    stderr: str
    returncode: int | None
    error: str | None
    seconds: float


def run_claude(cmd: list[str], prompt: str, cwd: Path, timeout: int = DEFAULT_TIMEOUT) -> ClaudeRun:
    """Run one headless session. A failed run (exit, timeout, spawn error) is an error, not a miss."""
    start = time.time()
    try:
        r = subprocess.run(cmd, input=prompt, capture_output=True, text=True, encoding="utf-8", errors="replace",
                           cwd=str(cwd), env=child_env(), timeout=timeout, shell=False)
    except subprocess.TimeoutExpired as e:
        out = e.stdout.decode("utf-8", "replace") if isinstance(e.stdout, bytes) else (e.stdout or "")
        return ClaudeRun(out, "", None, f"timeout after {timeout}s", time.time() - start)
    except OSError as e:
        return ClaudeRun("", "", None, f"spawn failed: {e}", time.time() - start)
    error = None if r.returncode == 0 else f"exit {r.returncode}"
    return ClaudeRun(r.stdout or "", (r.stderr or "")[:500], r.returncode, error, time.time() - start)


# ---------------------------------------------------------------- stream-json

def _events(text: str):
    for line in text.splitlines():
        if line.startswith("{"):
            try:
                yield json.loads(line)
            except ValueError:
                continue


def _content(ev: dict) -> list:
    """The content blocks of an event. Some events carry "message": "<text>", which has none."""
    message = ev.get("message")
    content = message.get("content") if isinstance(message, dict) else None
    return content if isinstance(content, list) else []


def parse_stream(text: str) -> dict:
    """Read one run's stream-json: tool calls, Skill tool_use names, Read paths, the result."""
    tool_calls: list[dict] = []
    skills: list[str] = []
    reads: list[str] = []
    counts: dict[str, int] = {}
    texts: list[str] = []
    result = None
    listed = None  # skills the session listed at start: proves a skillOverrides "off" took effect
    skill_calls: dict[str, str] = {}  # tool_use id -> skill name
    skill_errors: list[str] = []
    read_calls: dict[str, str] = {}  # tool_use id -> path; a Read counts only when its result is not an error
    failed_reads: set[str] = set()
    for ev in _events(text):
        if ev.get("type") == "result":
            result = ev
        if ev.get("type") == "system" and ev.get("subtype") == "init" and isinstance(ev.get("skills"), list):
            listed = [str(s) for s in ev["skills"]]
        if ev.get("type") == "user":
            for block in _content(ev):
                if not (isinstance(block, dict) and block.get("type") == "tool_result" and block.get("is_error")):
                    continue
                if block.get("tool_use_id") in skill_calls:
                    skill_errors.append(f"{skill_calls[block['tool_use_id']]}: {str(block.get('content'))[:200]}")
                if block.get("tool_use_id") in read_calls:
                    # A denied or failed Read did not read the file: it is not contamination.
                    failed_reads.add(block["tool_use_id"])
        if ev.get("type") != "assistant":
            continue
        for block in _content(ev):
            if not isinstance(block, dict):
                continue
            if block.get("type") == "text":
                texts.append(block.get("text", ""))
            elif block.get("type") == "tool_use":
                name, inp = block.get("name", ""), block.get("input") or {}
                tool_calls.append({"name": name, "input": inp})
                counts[name] = counts.get(name, 0) + 1
                if name == "Skill":
                    s = str(inp.get("skill") or inp.get("command") or "").lstrip("/")
                    if s:
                        skills.append(s)
                        if block.get("id"):
                            skill_calls[block["id"]] = s
                elif name == "Read" and inp.get("file_path"):
                    read_calls[block.get("id") or f"_anon{len(read_calls)}"] = str(inp["file_path"])
    reads = [p for tid, p in read_calls.items() if tid not in failed_reads]
    # The answer is the result event's text, and only from a successful run. The last narration of a
    # run that ended in error_max_turns or lost its result event is not an answer.
    ok = result is not None and result.get("subtype") == "success" and isinstance(result.get("result"), str)
    return {"listed_skills": listed, "skills_fired": skills, "skill_errors": skill_errors, "files_read": reads,
            "tool_counts": counts, "tool_calls": tool_calls, "final_text": result["result"] if ok else "", "result": result,
            "last_text": texts[-1] if texts else ""}


def result_error(info: dict) -> str | None:
    """Why a parsed run is not a success: no result event, or a subtype other than success
    (error_max_turns, error_during_execution, ...). None when the run succeeded."""
    result = info.get("result")
    if result is None:
        return "no result event in the stream"
    subtype = result.get("subtype")
    if subtype != "success":
        detail = "; ".join(str(e) for e in (result.get("errors") or []))[:200]
        return f"run ended with {subtype}" + (f" ({detail})" if detail else "")
    if result.get("is_error"):
        return "result is_error is true"
    return None


def skill_fired(text: str, name: str) -> bool:
    """True when the run called the Skill tool with exactly this skill name."""
    return any(name_matches(s, name) for s in parse_stream(text)["skills_fired"])


def _norm(p) -> str:
    return os.path.normcase(os.path.abspath(str(p)))


def skill_files(skill_dir: Path) -> list[str]:
    """Files a run could read inside a skill, relative with forward slashes. SKILL.md is excluded:
    the Skill tool injects it, so it is never a Read."""
    skip_dirs = {"evals", "tests", "__pycache__", "node_modules", ".git"}
    out = []
    for p in sorted(Path(skill_dir).rglob("*")):
        rel = p.relative_to(skill_dir)
        if not p.is_file() or rel.parts[0] in skip_dirs or p.suffix in (".pyc", ".pyo") or rel.as_posix() == "SKILL.md":
            continue
        out.append(rel.as_posix())
    return out


def navigation(files_read: list[str], skill_dir: Path, extra_roots=()) -> dict:
    """Which files a run read: inside the skill (in read order), outside it, and the skill files never read.

    `skill_dir` lists the skill's files. A read under `skill_dir` or under any of `extra_roots` (the
    renamed project copy, the personal copy in ~/.claude/skills) counts as inside the skill.
    """
    roots = [_norm(r) for r in (skill_dir, *extra_roots)]
    listing = skill_files(skill_dir)
    inside, outside = [], []
    for f in files_read:
        n = _norm(f)
        root = next((r for r in roots if n.startswith(r + os.sep)), None)
        if root:
            rel = Path(n[len(root) + 1:]).as_posix()
            # normcase may lower-case: map back to the real spelling when the file exists
            real = next((r for r in listing if r.lower() == rel.lower()), rel)
            if real not in inside:
                inside.append(real)
        elif f not in outside:
            outside.append(f)
    return {"skill_files_read": inside,
            "skill_files_unread": [r for r in listing if r not in inside],
            "reads_outside_skill": outside}


def render_transcript(text: str, prompt: str, limit: int = 1500) -> str:
    """The stream as markdown for the grader: prompt, assistant text, tool calls, trimmed results."""
    lines = ["# Transcript", "", "## Prompt", "", prompt, ""]
    step = 0
    for ev in _events(text):
        content = _content(ev)
        if ev.get("type") == "assistant":
            for b in content:
                if not isinstance(b, dict):
                    continue
                if b.get("type") == "text" and b.get("text", "").strip():
                    step += 1
                    lines += [f"### Step {step}: assistant", "", b["text"].strip(), ""]
                elif b.get("type") == "tool_use":
                    step += 1
                    lines += [f"### Step {step}: tool call", "", f"Tool: {b.get('name')}", "```json",
                              json.dumps(b.get("input") or {}, ensure_ascii=False)[:limit], "```", ""]
        elif ev.get("type") == "user":
            for b in content:
                if isinstance(b, dict) and b.get("type") == "tool_result":
                    body = b.get("content")
                    if isinstance(body, list):
                        body = " ".join(x.get("text", "") for x in body if isinstance(x, dict))
                    lines += ["Tool result (trimmed):", "```", str(body or "")[:limit], "```", ""]
    return "\n".join(lines)


def metrics(result: dict | None, seconds: float) -> dict:
    """Numbers from the result event: tokens, cost, turns, duration."""
    r = result or {}
    usage = r.get("usage") or {}
    tokens = sum(v for k, v in usage.items() if isinstance(v, int) and k.endswith("tokens"))
    return {"total_tokens": tokens, "cost_usd": r.get("total_cost_usd"), "turns": r.get("num_turns"),
            "duration_seconds": round(r["duration_ms"] / 1000, 1) if r.get("duration_ms") else round(seconds, 1),
            "is_error": bool(r.get("is_error"))}


def copy_skill(src: Path, dest: Path) -> Path:
    """Copy a skill folder for a run. Eval files, tests and caches stay behind."""
    shutil.copytree(src, dest, ignore=shutil.ignore_patterns("evals", "tests", "__pycache__", "*.pyc", "node_modules", ".git"))
    return dest
