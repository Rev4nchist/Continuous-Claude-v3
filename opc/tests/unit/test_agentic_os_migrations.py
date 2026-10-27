"""run_agentic_os_migrations: the setup step that creates the agentic_os schema.

Ways it can fail, one test each:
1. No database URL (SQLite mode) still calls npm.
2. A fresh checkout (no drizzle-kit) skips the package install.
3. A failed db:check still runs db:migrate (the safety gate is ignored).
4. An error message prints the database URL (it holds the password).
5. db:migrate runs without AGENTIC_OS_DATABASE_URL, so drizzle has no target.
6. npm is missing and the step reports success.
"""

import subprocess
from pathlib import Path

from scripts.setup.docker_setup import run_agentic_os_migrations

URL = "postgresql://claude:s3cret@localhost:5432/continuous_claude"


def _app(tmp_path: Path, installed: bool) -> Path:
    (tmp_path / "package.json").write_text("{}", encoding="utf-8")
    if installed:
        (tmp_path / "node_modules" / "drizzle-kit").mkdir(parents=True)
    return tmp_path


class Recorder:
    def __init__(self, fail_on: str | None = None, output: str = ""):
        self.calls: list[tuple[list[str], dict]] = []
        self.fail_on = fail_on
        self.output = output

    def __call__(self, cmd, **kwargs):
        self.calls.append((cmd, kwargs))
        failed = self.fail_on is not None and self.fail_on in " ".join(cmd)
        stderr = self.output if failed else ""
        return subprocess.CompletedProcess(cmd, 1 if failed else 0, stdout="", stderr=stderr)

    @property
    def steps(self) -> list[str]:
        return [" ".join(cmd[1:]) for cmd, _ in self.calls]


def test_no_url_skips_without_npm(tmp_path):
    rec = Recorder()
    result = run_agentic_os_migrations("", app_dir=_app(tmp_path, True), run=rec, npm="npm")
    assert result == {"success": True, "skipped": True}
    assert rec.calls == []


def test_fresh_checkout_installs_first(tmp_path):
    rec = Recorder()
    result = run_agentic_os_migrations(URL, app_dir=_app(tmp_path, False), run=rec, npm="npm")
    assert result["success"] is True
    assert rec.steps == ["ci", "run db:check", "run db:migrate"]


def test_installed_checkout_skips_install(tmp_path):
    rec = Recorder()
    run_agentic_os_migrations(URL, app_dir=_app(tmp_path, True), run=rec, npm="npm")
    assert rec.steps == ["run db:check", "run db:migrate"]


def test_failed_check_never_migrates(tmp_path):
    rec = Recorder(fail_on="db:check", output="DDL outside agentic_os")
    result = run_agentic_os_migrations(URL, app_dir=_app(tmp_path, True), run=rec, npm="npm")
    assert result["success"] is False
    assert "db:check" in result["error"]
    assert "run db:migrate" not in rec.steps


def test_error_masks_the_url(tmp_path):
    rec = Recorder(fail_on="db:migrate", output=f"connect failed: {URL}")
    result = run_agentic_os_migrations(URL, app_dir=_app(tmp_path, True), run=rec, npm="npm")
    assert result["success"] is False
    assert "s3cret" not in result["error"]
    assert "<db-url>" in result["error"]


def test_migrate_gets_the_url_in_env(tmp_path):
    rec = Recorder()
    run_agentic_os_migrations(URL, app_dir=_app(tmp_path, True), run=rec, npm="npm")
    for _, kwargs in rec.calls:
        assert kwargs["env"]["AGENTIC_OS_DATABASE_URL"] == URL


def test_missing_npm_is_a_failure(tmp_path, monkeypatch):
    monkeypatch.setattr("scripts.setup.docker_setup.shutil.which", lambda _name: None)
    result = run_agentic_os_migrations(URL, app_dir=_app(tmp_path, True), run=Recorder())
    assert result["success"] is False
    assert "npm not found" in result["error"]
