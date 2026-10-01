"""Tests for how the wizard installs the repo's plugins/ folder.

Failure modes covered, one test each:
1. Installing the repo's plugin files deletes Claude Code's plugin state
   (cache/, installed_plugins.json), which uninstalls every plugin. Checked
   through both real installers, so a revert to rmtree in either one fails.
2. The repo's claude-hud launcher does not reach the target.
3. A config.json the plugin's configure command wrote is overwritten.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from scripts.setup.claude_integration import (
    install_opc_integration,
    install_opc_integration_symlink,
)

INSTALLERS = [install_opc_integration, install_opc_integration_symlink]


def _repo(tmp_path: Path) -> Path:
    opc_source = tmp_path / "repo" / ".claude"
    hud = opc_source / "plugins" / "claude-hud"
    hud.mkdir(parents=True)
    (hud / "launcher.mjs").write_text("// launcher", encoding="utf-8")
    (hud / "config.json").write_text('{"repo": true}', encoding="utf-8")
    return opc_source


def _home(tmp_path: Path) -> Path:
    target = tmp_path / "home" / ".claude"
    plugins = target / "plugins"
    (plugins / "cache" / "claude-hud").mkdir(parents=True)
    (plugins / "installed_plugins.json").write_text("{}", encoding="utf-8")
    return target


@pytest.mark.parametrize("install", INSTALLERS)
def test_existing_plugin_state_survives(tmp_path: Path, install) -> None:
    target = _home(tmp_path)
    result = install(target, _repo(tmp_path))
    assert result["success"], result.get("error")
    assert (target / "plugins" / "installed_plugins.json").exists()
    assert (target / "plugins" / "cache" / "claude-hud").is_dir()


@pytest.mark.parametrize("install", INSTALLERS)
def test_launcher_is_copied(tmp_path: Path, install) -> None:
    target = _home(tmp_path)
    install(target, _repo(tmp_path))
    launcher = target / "plugins" / "claude-hud" / "launcher.mjs"
    assert launcher.read_text(encoding="utf-8") == "// launcher"


@pytest.mark.parametrize("install", INSTALLERS)
def test_existing_config_is_kept(tmp_path: Path, install) -> None:
    target = _home(tmp_path)
    config = target / "plugins" / "claude-hud" / "config.json"
    config.parent.mkdir(parents=True)
    config.write_text('{"mine": true}', encoding="utf-8")
    install(target, _repo(tmp_path))
    assert config.read_text(encoding="utf-8") == '{"mine": true}'
