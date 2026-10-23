#!/usr/bin/env python3
"""Cross-platform hook launcher for Claude Code hooks.

Replaces bash wrapper scripts (.sh) with a Python launcher that works
on Windows, macOS, and Linux.

Usage:
    python3 .claude/hooks/hook_launcher.py <hook-name>

    # In settings.json:
    "command": "python3 .claude/hooks/hook_launcher.py skill-activation-prompt"

The launcher:
1. Finds the hook script:
   - .mjs in dist/ (compiled JavaScript)
   - .ts in src/ (TypeScript source)
   - .py in root hooks dir (Python scripts)
2. Uses appropriate interpreter (node, npx tsx, or python3)
3. Pipes stdin JSON and returns the hook's JSON output

Supports both project-specific hooks ($CLAUDE_PROJECT_DIR/.claude/hooks)
and user-level hooks (~/.claude/hooks), with project hooks taking precedence.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any


def expand_path(path: str) -> str:
    """Expand ~ and environment variables in a path.

    Works on Windows, macOS, and Linux.

    Args:
        path: Path string that may contain ~ or $HOME/%USERPROFILE%

    Returns:
        Expanded absolute path string
    """
    # Expand ~ to home directory
    if path.startswith("~"):
        path = str(Path.home()) + path[1:]

    # Expand environment variables ($HOME, %USERPROFILE%, etc.)
    path = os.path.expandvars(path)

    # Normalize path separators for current platform
    return str(Path(path))


def get_hooks_dirs() -> list[Path]:
    """Get the Claude Code hooks directories.

    Returns both project-specific and user-level hooks directories.
    Project hooks take precedence over user hooks.

    Returns:
        List of paths to check for hooks (project first, then user)
    """
    dirs = []

    # Project-specific hooks (from CLAUDE_PROJECT_DIR env var)
    project_dir = os.environ.get("CLAUDE_PROJECT_DIR")
    if project_dir:
        dirs.append(Path(project_dir) / ".claude" / "hooks")

    # User-level hooks (~/.claude/hooks)
    dirs.append(Path.home() / ".claude" / "hooks")

    return dirs


def get_hooks_dir() -> Path:
    """Get the primary Claude Code hooks directory (for backwards compat).

    Returns:
        Path to ~/.claude/hooks
    """
    return Path.home() / ".claude" / "hooks"


def find_node() -> str | None:
    """Find the Node.js executable.

    Returns:
        Path to node executable, or None if not found
    """
    # Try common names
    for name in ["node", "node.exe", "nodejs"]:
        path = shutil.which(name)
        if path:
            return path

    # On Windows, also check common install locations
    if sys.platform == "win32":
        common_paths = [
            Path(os.environ.get("PROGRAMFILES", "")) / "nodejs" / "node.exe",
            Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "nodejs" / "node.exe",
        ]
        for p in common_paths:
            if p.exists():
                return str(p)

    return None


def find_python() -> str | None:
    """Find the Python executable.

    Returns:
        Path to python executable, or None if not found
    """
    # On Windows, check absolute paths FIRST to avoid WindowsApps stub
    if sys.platform == "win32":
        # Get user profile directory
        user_profile = os.environ.get("USERPROFILE") or os.environ.get("HOME") or str(Path.home())
        local_app_data = os.environ.get("LOCALAPPDATA") or str(Path(user_profile) / "AppData" / "Local")

        common_paths = [
            Path(user_profile) / "AppData" / "Local" / "Programs" / "Python" / "Python313" / "python.exe",
            Path(user_profile) / "AppData" / "Local" / "Programs" / "Python" / "Python312" / "python.exe",
            Path(user_profile) / "AppData" / "Local" / "Programs" / "Python" / "Python311" / "python.exe",
            Path(local_app_data) / "Programs" / "Python" / "Python313" / "python.exe",
            Path(local_app_data) / "Programs" / "Python" / "Python312" / "python.exe",
            Path(local_app_data) / "Programs" / "Python" / "Python311" / "python.exe",
        ]
        for p in common_paths:
            if p.exists():
                return str(p)

    # Try common names (but skip 'python' on Windows to avoid Store stub)
    names = ["python3", "python3.exe"] if sys.platform == "win32" else ["python3", "python", "python.exe", "python3.exe"]
    for name in names:
        path = shutil.which(name)
        if path:
            return path

    return None


def find_hook_script(name: str) -> tuple[Path | None, Path | None, Path | None]:
    """Find the hook script file.

    Searches project-specific hooks first, then user hooks.
    Search order: .mjs in dist/, .ts in src/, .py in root.

    Args:
        name: Hook name (e.g., "skill-activation-prompt")

    Returns:
        Tuple of (script_path, hooks_dir, project_root) or (None, None, None) if not found
    """
    for hooks_dir in get_hooks_dirs():
        # Determine project root for this hooks dir
        project_root = None
        if hooks_dir == Path.home() / ".claude" / "hooks":
            # User-level hooks: no specific project root, use home dir
            project_root = Path.home()
        else:
            # Project hooks: extract from hooks_dir path
            # hooks_dir is like: /path/to/project/.claude/hooks
            # project_root should be: /path/to/project
            # Try resolving via CLAUDE_PROJECT_DIR first
            env_project_dir = os.environ.get("CLAUDE_PROJECT_DIR")
            if env_project_dir:
                project_root = Path(env_project_dir)
            else:
                # Fallback: go up two levels from .claude/hooks
                project_root = hooks_dir.parent.parent

        # Try compiled .mjs first
        mjs_path = hooks_dir / "dist" / f"{name}.mjs"
        if mjs_path.exists():
            return mjs_path, hooks_dir, project_root

        # Fallback to TypeScript source
        ts_path = hooks_dir / "src" / f"{name}.ts"
        if ts_path.exists():
            return ts_path, hooks_dir, project_root

        # Python scripts in root hooks directory
        py_path = hooks_dir / f"{name}.py"
        if py_path.exists():
            return py_path, hooks_dir, project_root

    return None, None, None


def run_hook(
    name: str,
    input_json: dict[str, Any] | None = None,
    env: dict[str, str] | None = None,
    timeout: int = 30,
) -> dict[str, Any]:
    """Run a hook and return its output.

    Args:
        name: Hook name (e.g., "skill-activation-prompt")
        input_json: JSON data to pass via stdin
        env: Additional environment variables
        timeout: Timeout in seconds

    Returns:
        Dict with keys: returncode, stdout, stderr
    """
    # Find hook script first
    script_path, hooks_dir, project_root = find_hook_script(name)
    if not script_path:
        search_dirs = ", ".join(str(d) for d in get_hooks_dirs())
        return {
            "returncode": 1,
            "stdout": "",
            "stderr": f"Error: Hook '{name}' not found in [{search_dirs}]",
        }

    # Build command based on script type
    if script_path.suffix == ".py":
        # Use Python for .py scripts
        python_path = find_python()
        if not python_path:
            return {
                "returncode": 1,
                "stdout": "",
                "stderr": "Error: Python not found. Please install Python 3.",
            }
        cmd = [python_path, str(script_path)]
    elif script_path.suffix == ".ts":
        # Use npx tsx for TypeScript
        cmd = ["npx", "tsx", str(script_path)]
    else:
        # Use node for compiled .mjs
        node_path = find_node()
        if not node_path:
            return {
                "returncode": 1,
                "stdout": "",
                "stderr": "Error: Node.js not found. Please install Node.js.",
            }
        cmd = [node_path, str(script_path)]

    # Prepare environment
    run_env = os.environ.copy()
    if env:
        run_env.update(env)

    # Prepare stdin
    stdin_data = json.dumps(input_json) if input_json else "{}"

    try:
        result = subprocess.run(
            cmd,
            input=stdin_data,
            capture_output=True,
            text=True,
            timeout=timeout,
            env=run_env,
            cwd=str(project_root),  # Run from project root to avoid path doubling
        )
        return {
            "returncode": result.returncode,
            "stdout": result.stdout,
            "stderr": result.stderr,
        }
    except subprocess.TimeoutExpired:
        return {
            "returncode": 124,
            "stdout": "",
            "stderr": f"Error: Hook '{name}' timed out after {timeout}s",
        }
    except FileNotFoundError as e:
        return {
            "returncode": 127,
            "stdout": "",
            "stderr": f"Error: Command not found: {e}",
        }
    except Exception as e:
        return {
            "returncode": 1,
            "stdout": "",
            "stderr": f"Error running hook: {e}",
        }


def main() -> None:
    """CLI entrypoint for hook launcher.

    Usage: python -m scripts.hook_launcher <hook-name> [--env KEY=VALUE ...]
    """
    if len(sys.argv) < 2:
        print("Usage: python -m scripts.hook_launcher <hook-name>", file=sys.stderr)
        sys.exit(1)

    hook_name = sys.argv[1]

    # Parse --env arguments
    env_vars: dict[str, str] = {}
    i = 2
    while i < len(sys.argv):
        if sys.argv[i] == "--env" and i + 1 < len(sys.argv):
            key, _, value = sys.argv[i + 1].partition("=")
            env_vars[key] = value
            i += 2
        else:
            i += 1

    # Special handling for CLAUDE_PPID (pass parent PID)
    if "CLAUDE_PPID" not in env_vars and os.getppid():
        env_vars["CLAUDE_PPID"] = str(os.getppid())

    # Read stdin
    try:
        stdin_data = sys.stdin.read()
        input_json = json.loads(stdin_data) if stdin_data.strip() else {}
    except json.JSONDecodeError:
        input_json = {}

    # Run hook
    result = run_hook(hook_name, input_json=input_json, env=env_vars)

    # Output results
    if result["stdout"]:
        print(result["stdout"])
    if result["stderr"]:
        print(result["stderr"], file=sys.stderr)

    sys.exit(result["returncode"])


if __name__ == "__main__":
    main()
