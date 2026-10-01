"""Tests for _merge_plugins().

Failure modes covered, one test each:
1. Installing the repo's plugin files deletes Claude Code's plugin state
   (cache/, installed_plugins.json), which uninstalls every plugin.
2. The repo's claude-hud launcher does not reach the target.
"""
from __future__ import annotations

from pathlib import Path

from scripts.setup.claude_integration import _merge_plugins


def _repo_plugins(tmp_path: Path) -> Path:
    src = tmp_path / "repo" / "plugins"
    (src / "claude-hud").mkdir(parents=True)
    (src / "claude-hud" / "launcher.mjs").write_text("// launcher", encoding="utf-8")
    return src


def test_existing_plugin_state_survives(tmp_path: Path) -> None:
    dst = tmp_path / "home" / "plugins"
    (dst / "cache" / "claude-hud").mkdir(parents=True)
    (dst / "installed_plugins.json").write_text("{}", encoding="utf-8")
    _merge_plugins(_repo_plugins(tmp_path), dst)
    assert (dst / "installed_plugins.json").exists()
    assert (dst / "cache" / "claude-hud").is_dir()


def test_launcher_is_copied(tmp_path: Path) -> None:
    dst = tmp_path / "home" / "plugins"
    _merge_plugins(_repo_plugins(tmp_path), dst)
    assert (dst / "claude-hud" / "launcher.mjs").read_text(encoding="utf-8") == "// launcher"
