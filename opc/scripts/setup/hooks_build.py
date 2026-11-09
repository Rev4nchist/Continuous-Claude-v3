"""Build the TypeScript hooks in the repo, then copy the built hooks to ~/.claude.

The repo owns the hooks source. The build runs in <repo>/.claude/hooks.
The copy covers the files that the repo sync script copies for hooks.
Those are the top-level hook scripts, package.json, tsconfig.json and dist/*.mjs.
The copy never includes hooks/src or node_modules.

Used by scripts/setup/wizard.py and scripts/setup/update.py.
"""

from __future__ import annotations

import filecmp
import hashlib
import platform
import shutil
import subprocess
from collections.abc import Callable
from pathlib import Path

NPM_INSTALL_TIMEOUT = 300
NPM_BUILD_TIMEOUT = 120

# The stamp sits next to node_modules in ~/.claude/hooks. It holds the hash of the
# files below at the last good install. The copy never touches it.
DEPS_STAMP_NAME = ".deps-stamp"
_DEPS_FILES = ("package.json", "package-lock.json")

# Top-level hook files to copy, by suffix and by exact name.
_TOP_LEVEL_SUFFIXES = (".sh", ".py", ".mjs", ".ps1")
_TOP_LEVEL_NAMES = ("package.json", "tsconfig.json")


def manual_steps(repo_root: Path) -> str:
    """Return the commands a user runs by hand when setup cannot finish."""
    hooks_dir = repo_root / ".claude" / "hooks"
    return "\n".join(
        [
            f'cd "{hooks_dir}"',
            "npm install",
            "npm run build",
            f"Then copy {hooks_dir.as_posix()}/dist/*.mjs to ~/.claude/hooks/dist",
        ]
    )


def _fail(message: str, steps: str) -> tuple[bool, str]:
    return False, f"{message} Manual steps:\n{steps}"


def _snippet(text: str | None) -> str:
    """Return a short one-line piece of command output."""
    return " ".join((text or "").split())[:200]


def _find_npm() -> str | None:
    npm_cmd = shutil.which("npm")
    if npm_cmd is None and platform.system() == "Windows":
        npm_cmd = shutil.which("npm.cmd")
    return npm_cmd


def _run_npm(npm_cmd: str, args: list[str], cwd: Path, timeout: int):
    return subprocess.run(
        [npm_cmd, *args],
        cwd=cwd,
        capture_output=True,
        text=True,
        timeout=timeout,
    )


def _build_in_repo(
    repo_hooks: Path, npm_cmd: str, log: Callable[[str], None]
) -> str | None:
    """Run npm install and npm run build in the repo. Return an error text or None."""
    log("  Running npm install...")
    result = _run_npm(npm_cmd, ["install"], repo_hooks, NPM_INSTALL_TIMEOUT)
    if result.returncode != 0:
        return f"npm install failed: {_snippet(result.stderr)}."
    log("  Running npm run build...")
    result = _run_npm(npm_cmd, ["run", "build"], repo_hooks, NPM_BUILD_TIMEOUT)
    if result.returncode != 0:
        return f"npm build failed: {_snippet(result.stderr)}."
    return None


def _is_linked_to_repo(claude_dir: Path, repo_hooks: Path) -> bool:
    active_hooks = claude_dir / "hooks"
    try:
        return active_hooks.exists() and active_hooks.resolve() == repo_hooks.resolve()
    except OSError:
        return False


def _files_to_copy(repo_hooks: Path) -> list[tuple[Path, Path]]:
    """Return (source, relative destination) pairs. Never src or node_modules."""
    pairs: list[tuple[Path, Path]] = []
    for src in sorted(repo_hooks.iterdir()):
        if src.is_file() and (src.suffix in _TOP_LEVEL_SUFFIXES or src.name in _TOP_LEVEL_NAMES):
            pairs.append((src, Path(src.name)))
    dist = repo_hooks / "dist"
    if dist.is_dir():
        for src in sorted(dist.glob("*.mjs")):
            if src.is_file():
                pairs.append((src, Path("dist") / src.name))
    return pairs


def _copy_hooks(repo_hooks: Path, active_hooks: Path) -> int:
    """Copy the built hooks. Skip files that did not change. Return the count copied."""
    copied = 0
    for src, rel in _files_to_copy(repo_hooks):
        dst = active_hooks / rel
        if dst.is_file() and filecmp.cmp(src, dst, shallow=False):
            continue
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        copied += 1
    return copied


def _deps_fingerprint(active_hooks: Path) -> str:
    """Hash package.json and package-lock.json. A missing lock file hashes as empty."""
    digest = hashlib.sha256()
    for name in _DEPS_FILES:
        path = active_hooks / name
        digest.update(name.encode())
        digest.update(path.read_bytes() if path.is_file() else b"")
    return digest.hexdigest()


def _deps_are_current(active_hooks: Path, fingerprint: str) -> bool:
    """True when node_modules exists and the stamp matches the fingerprint."""
    if not (active_hooks / "node_modules").exists():
        return False
    stamp = active_hooks / DEPS_STAMP_NAME
    try:
        return stamp.read_text(encoding="utf-8").strip() == fingerprint
    except OSError:
        return False


def _ensure_runtime_deps(active_hooks: Path, npm_cmd: str) -> str | None:
    """The copy skips node_modules. Install runtime deps in ~/.claude/hooks.

    Install when node_modules is missing or the deps stamp differs from the hash
    of package.json and package-lock.json. Write the stamp only after a good install.
    """
    if not (active_hooks / "package.json").is_file():
        return None
    fingerprint = _deps_fingerprint(active_hooks)
    if _deps_are_current(active_hooks, fingerprint):
        return None
    result = _run_npm(
        npm_cmd, ["install", "--omit=dev"], active_hooks, NPM_INSTALL_TIMEOUT
    )
    if result.returncode != 0:
        return (
            "Hooks are copied, but npm install --omit=dev failed in ~/.claude/hooks: "
            f"{_snippet(result.stderr)}. Run that command in that folder by hand."
        )
    (active_hooks / DEPS_STAMP_NAME).write_text(fingerprint, encoding="utf-8")
    return None


def build_and_sync_hooks(
    opc_source: Path,
    claude_dir: Path,
    symlinked: bool = False,
    log: Callable[[str], None] = print,
) -> tuple[bool, str]:
    """Build the hooks in <repo>/.claude/hooks, then copy them to claude_dir/hooks.

    Args:
        opc_source: The repo's .claude directory.
        claude_dir: The active directory (~/.claude).
        symlinked: True when setup linked claude_dir/hooks to the repo.
        log: Prints progress lines.

    Returns:
        (success, message). On failure the message ends with the manual steps.
    """
    repo_hooks = opc_source / "hooks"
    steps = manual_steps(opc_source.parent)

    if not repo_hooks.exists():
        return True, "Hooks directory does not exist."
    if not (repo_hooks / "package.json").exists():
        return True, "No package.json found. No npm build is needed."

    npm_cmd = _find_npm()
    if npm_cmd is None:
        return _fail("npm not found in PATH. Hooks are not built.", steps)

    try:
        error = _build_in_repo(repo_hooks, npm_cmd, log)
        if error:
            return _fail(error, steps)

        if symlinked or _is_linked_to_repo(claude_dir, repo_hooks):
            return True, (
                f"Hooks built in {repo_hooks}. "
                "~/.claude/hooks is linked to the repo, so no copy is needed."
            )

        log("  Copying hooks to ~/.claude/hooks...")
        count = _copy_hooks(repo_hooks, claude_dir / "hooks")

        error = _ensure_runtime_deps(claude_dir / "hooks", npm_cmd)
        if error:
            return _fail(error, steps)
    except subprocess.TimeoutExpired:
        return _fail("A command timed out.", steps)
    except OSError as e:
        return _fail(f"Hooks are not fully set up. {_snippet(str(e))}.", steps)

    return True, (
        f"Hooks built in {repo_hooks} and copied to ~/.claude/hooks. "
        f"Files changed: {count}. "
        "The repo hooks/dist can show as changed in git status."
    )
