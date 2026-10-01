"""Tests for install_enabled_plugins().

enabledPlugins only turns a plugin on; the wizard must also download it.
Failure modes covered, one test each:
1. A plugin set to false is installed anyway.
2. A GitHub marketplace from extraKnownMarketplaces is not added before the installs.
3. A directory marketplace (a local path) is passed to `marketplace add`.
4. One failed install stops the plugins after it.
5. No claude CLI on PATH crashes the wizard.
6. Marketplaces clone over SSH, which fails on a machine with no GitHub key.
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

from scripts.setup.claude_integration import install_enabled_plugins


def _settings(tmp_path: Path, data: dict) -> Path:
    path = tmp_path / "settings.json"
    path.write_text(json.dumps(data), encoding="utf-8")
    return path


class FakeRun:
    def __init__(self, fail: set[str] | None = None):
        self.calls: list[list[str]] = []
        self.envs: list[dict] = []
        self.fail = fail or set()

    def __call__(self, cmd, **kwargs):
        self.calls.append(cmd[1:])
        self.envs.append(kwargs.get("env") or {})
        code = 1 if any(arg in self.fail for arg in cmd) else 0
        return subprocess.CompletedProcess(cmd, code, stdout="out", stderr="")


SETTINGS = {
    "enabledPlugins": {
        "microsoft-docs@claude-plugins-official": True,
        "braintrust@braintrust-claude-plugin": False,
        "typesafe@typesafe-ai": True,
    },
    "extraKnownMarketplaces": {
        "typesafe-ai": {"source": {"source": "github", "repo": "typesafe-ai/skills"}},
        "local": {"source": {"source": "directory", "path": "C:/somewhere"}},
    },
}


def test_disabled_plugin_is_not_installed(tmp_path: Path) -> None:
    run = FakeRun()
    install_enabled_plugins(_settings(tmp_path, SETTINGS), claude_cmd="claude", run=run)
    installed = [c[2] for c in run.calls if c[:2] == ["plugin", "install"]]
    assert installed == ["microsoft-docs@claude-plugins-official", "typesafe@typesafe-ai"]


def test_github_marketplaces_are_added_before_installs(tmp_path: Path) -> None:
    run = FakeRun()
    install_enabled_plugins(_settings(tmp_path, SETTINGS), claude_cmd="claude", run=run)
    adds = [c[3] for c in run.calls if c[:3] == ["plugin", "marketplace", "add"]]
    assert adds == ["anthropics/claude-plugins-official", "typesafe-ai/skills"]
    first_install = next(i for i, c in enumerate(run.calls) if c[1] == "install")
    assert all(c[1] == "marketplace" for c in run.calls[:first_install])


def test_directory_marketplace_is_not_added(tmp_path: Path) -> None:
    run = FakeRun()
    install_enabled_plugins(_settings(tmp_path, SETTINGS), claude_cmd="claude", run=run)
    assert not any("C:/somewhere" in c for c in run.calls)


def test_failed_install_does_not_stop_the_rest(tmp_path: Path) -> None:
    run = FakeRun(fail={"microsoft-docs@claude-plugins-official"})
    results = install_enabled_plugins(_settings(tmp_path, SETTINGS), claude_cmd="claude", run=run)
    status = {step: ok for step, ok, _ in results}
    assert status["microsoft-docs@claude-plugins-official"] is False
    assert status["typesafe@typesafe-ai"] is True


def test_every_command_prefers_https(tmp_path: Path) -> None:
    run = FakeRun()
    install_enabled_plugins(_settings(tmp_path, SETTINGS), claude_cmd="claude", run=run)
    assert run.envs and all(e.get("CLAUDE_CODE_PLUGIN_PREFER_HTTPS") == "1" for e in run.envs)


def test_missing_claude_cli_returns_one_failed_step(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr("shutil.which", lambda name: None)
    run = FakeRun()
    results = install_enabled_plugins(_settings(tmp_path, SETTINGS), run=run)
    assert results == [("claude CLI", False, "not on PATH; run `claude plugin install <id>` later")]
    assert run.calls == []
