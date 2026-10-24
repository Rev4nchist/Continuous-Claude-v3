"""Wizard export of CONTINUOUS_CLAUDE_DB_URL.

The value is read from opc/.env and handed to an injected writer.
Windows uses WinRegWriter (no subprocess, no value on argv).
POSIX writes a profile line that reads the env file and does not copy the value.
Stdout and stderr never contain the URL.
"""
from __future__ import annotations

import inspect
import io
import subprocess
import sys
from pathlib import Path

import pytest
from rich.console import Console

opc_root = Path(__file__).resolve().parents[2]
repo_root = opc_root.parent
if str(opc_root) not in sys.path:
    sys.path.insert(0, str(opc_root))

from scripts.setup.wizard import (  # noqa: E402
    PosixProfileWriter,
    WinRegWriter,
    apply_db_url_user_env,
)
import scripts.setup.wizard as wizard  # noqa: E402

PLACEHOLDER_URL = "postgresql://user:PLACEHOLDER@localhost:5432/db"
OTHER_URL = "postgresql://user:OTHER@localhost:5432/other"


class DictRegistry:
    def __init__(self) -> None:
        self.values: dict[str, str] = {}

    def read(self, name: str) -> str | None:
        return self.values.get(name)

    def write(self, name: str, value: str) -> None:
        self.values[name] = value


class RecordingWriter:
    def __init__(self, current: str | None = None) -> None:
        self.current = current
        self.writes: list[tuple[str, str]] = []

    def read(self, name: str) -> str | None:
        return self.current

    def write(self, name: str, value: str) -> None:
        self.writes.append((name, value))
        self.current = value


@pytest.fixture
def captured_console(monkeypatch: pytest.MonkeyPatch) -> io.StringIO:
    buf = io.StringIO()
    monkeypatch.setattr(wizard, "console", Console(file=buf, force_terminal=False, no_color=True))
    return buf


def _env_file(tmp_path: Path, value: str) -> Path:
    path = tmp_path / ".env"
    path.write_text(f"CONTINUOUS_CLAUDE_DB_URL={value}\n", encoding="utf-8")
    return path


def test_windows_mocked_writer_sets_url_without_printing_it(tmp_path: Path, captured_console: io.StringIO, capsys: pytest.CaptureFixture[str]) -> None:
    writer = RecordingWriter()
    status = apply_db_url_user_env(_env_file(tmp_path, PLACEHOLDER_URL), writer=writer)
    assert status == "set"
    assert writer.writes == [("CONTINUOUS_CLAUDE_DB_URL", PLACEHOLDER_URL)]
    captured = captured_console.getvalue() + capsys.readouterr().out + capsys.readouterr().err
    assert "set" in captured
    assert "postgresql://" not in captured
    assert "PLACEHOLDER" not in captured


def test_windows_writer_is_idempotent(tmp_path: Path, captured_console: io.StringIO) -> None:
    writer = RecordingWriter()
    env = _env_file(tmp_path, PLACEHOLDER_URL)
    assert apply_db_url_user_env(env, writer=writer) == "set"
    assert apply_db_url_user_env(env, writer=writer) == "already set"
    assert len(writer.writes) == 1


def test_windows_writer_keeps_a_different_value_unless_confirmed(tmp_path: Path, captured_console: io.StringIO, capsys: pytest.CaptureFixture[str]) -> None:
    writer = RecordingWriter(current=OTHER_URL)
    status = apply_db_url_user_env(_env_file(tmp_path, PLACEHOLDER_URL), writer=writer, confirm_replace=False)
    assert status == "differs (kept; confirm to replace)"
    assert writer.writes == []
    captured = captured_console.getvalue() + capsys.readouterr().out
    assert "differs" in captured
    assert "postgresql://" not in captured


def test_sqlite_mode_sets_nothing(tmp_path: Path, captured_console: io.StringIO) -> None:
    writer = RecordingWriter()
    status = apply_db_url_user_env(_env_file(tmp_path, ""), writer=writer)
    assert status == "skipped (sqlite mode)"
    assert writer.writes == []
    assert "skipped (sqlite mode)" in captured_console.getvalue()
    assert "postgresql://" not in captured_console.getvalue()


def test_winreg_writer_does_not_shell_out(monkeypatch: pytest.MonkeyPatch) -> None:
    def forbid(*args: object, **kwargs: object) -> None:
        raise AssertionError(f"subprocess invoked: {args} {kwargs}")

    monkeypatch.setattr(subprocess, "run", forbid)
    registry = DictRegistry()
    broadcasts: list[str] = []
    writer = WinRegWriter(registry=registry, broadcaster=lambda: broadcasts.append("Environment"))
    writer.write("CONTINUOUS_CLAUDE_DB_URL", PLACEHOLDER_URL)
    assert registry.read("CONTINUOUS_CLAUDE_DB_URL") == PLACEHOLDER_URL
    assert broadcasts == ["Environment"]
    source = inspect.getsource(WinRegWriter.write)
    assert "setx" not in source
    assert "subprocess" not in source


def test_posix_profile_reads_env_file_and_hides_the_value(tmp_path: Path, captured_console: io.StringIO, capsys: pytest.CaptureFixture[str]) -> None:
    env = _env_file(tmp_path, PLACEHOLDER_URL)
    profile = tmp_path / ".bashrc"
    profile.write_text("# existing\n", encoding="utf-8")
    writer = PosixProfileWriter(profile, env)
    status = apply_db_url_user_env(env, writer=writer)
    text = profile.read_text(encoding="utf-8")
    assert status == "set"
    assert "ccv3-db-url" in text
    assert str(env) in text
    assert "PLACEHOLDER" not in text
    assert "postgresql://" not in text
    assert apply_db_url_user_env(env, writer=writer) == "already set"
    assert profile.read_text(encoding="utf-8").count("ccv3-db-url") == 1
    captured = captured_console.getvalue() + capsys.readouterr().out + capsys.readouterr().err
    assert "postgresql://" not in captured
    assert "PLACEHOLDER" not in captured


def test_posix_default_writer_uses_temp_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, captured_console: io.StringIO) -> None:
    monkeypatch.setattr(wizard.Path, "home", lambda: tmp_path)
    monkeypatch.setenv("SHELL", "/bin/bash")
    monkeypatch.setattr(sys, "platform", "linux")
    (tmp_path / ".bashrc").write_text("# home\n", encoding="utf-8")
    env = _env_file(tmp_path, PLACEHOLDER_URL)
    status = apply_db_url_user_env(env)
    text = (tmp_path / ".bashrc").read_text(encoding="utf-8")
    assert status == "set"
    assert "PLACEHOLDER" not in text
    assert "ccv3-db-url" in text


def test_missing_env_file_is_not_reported_as_sqlite(tmp_path: Path, captured_console: io.StringIO, capsys: pytest.CaptureFixture[str]) -> None:
    writer = RecordingWriter()
    status = apply_db_url_user_env(tmp_path / ".env", writer=writer)
    captured = captured_console.getvalue() + capsys.readouterr().out + capsys.readouterr().err
    assert status == "skipped (no opc/.env)"
    assert writer.writes == []
    assert "sqlite" not in captured
    assert "postgresql://" not in captured


class _BoomRegistry:
    def read(self, name: str) -> str | None:
        return None

    def write(self, name: str, value: str) -> None:
        raise OSError("registry unavailable")


def test_winreg_oserror_is_reported_without_the_value(tmp_path: Path, captured_console: io.StringIO, capsys: pytest.CaptureFixture[str]) -> None:
    broadcasts: list[str] = []
    writer = WinRegWriter(registry=_BoomRegistry(), broadcaster=lambda: broadcasts.append("Environment"))
    status = apply_db_url_user_env(_env_file(tmp_path, PLACEHOLDER_URL), writer=writer)
    captured = captured_console.getvalue() + capsys.readouterr().out + capsys.readouterr().err
    assert status == "not set (registry write failed)"
    assert broadcasts == []
    assert "not set (registry write failed)" in captured
    assert "PLACEHOLDER" not in captured
    assert "postgresql://" not in captured
    assert "registry unavailable" not in captured


def test_verify_setup_checks_presence_only() -> None:
    text = (repo_root / "scripts" / "verify-setup.sh").read_text(encoding="utf-8")
    assert 'check "CONTINUOUS_CLAUDE_DB_URL is set"' in text
    needle = 'check "CONTINUOUS_CLAUDE_DB_URL is set"'
    line = next(line for line in text.splitlines() if needle in line)
    assert "echo" not in line
