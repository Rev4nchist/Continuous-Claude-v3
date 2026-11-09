"""Setup builds the hooks in the repo, then copies the built hooks to ~/.claude.

Failure modes covered:
- npm runs in the active dir, not the repo hooks dir
- the copy does not run after a good build
- the copy runs after a failed build
- src or node_modules reach ~/.claude
- files outside the sync list reach ~/.claude
- any subprocess call runs bash
- unchanged files are rewritten on every run
- symlink mode copies a tree onto itself
- a failure message does not end with the manual steps
- a message uses a semicolon, parentheses or " - "
- a wizard call site passes the wrong symlinked flag or opc_source
- update.py still copies hooks/src into ~/.claude, or skips the build
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

opc_root = Path(__file__).parent.parent.parent
sys.path.insert(0, str(opc_root))

from scripts.setup import hooks_build  # noqa: E402
from scripts.setup.hooks_build import build_and_sync_hooks, manual_steps  # noqa: E402

COPIED_TOP_LEVEL = ["run.sh", "hook.py", "mod.mjs", "start.ps1", "package.json", "tsconfig.json"]
NOT_COPIED_TOP_LEVEL = ["README.md", "notes.txt", "vitest.config.ts"]


@pytest.fixture
def layout(tmp_path):
    """A fake repo with a built hooks tree, and a fake home."""
    repo = tmp_path / "repo"
    opc_source = repo / ".claude"
    hooks = opc_source / "hooks"
    (hooks / "dist").mkdir(parents=True)
    (hooks / "src").mkdir()
    (hooks / "node_modules" / "pkg").mkdir(parents=True)
    for name in COPIED_TOP_LEVEL + NOT_COPIED_TOP_LEVEL:
        (hooks / name).write_text(f"top {name}")
    (hooks / "package.json").write_text("{}")
    (hooks / "dist" / "a.mjs").write_text("dist a")
    (hooks / "dist" / "b.mjs").write_text("dist b")
    (hooks / "dist" / "a.mjs.map").write_text("map")
    (hooks / "dist" / "inputs.json").write_text("{}")
    (hooks / "src" / "x.ts").write_text("export {}")
    (hooks / "node_modules" / "pkg" / "i.js").write_text("module")
    home = tmp_path / "home"
    claude_dir = home / ".claude"
    claude_dir.mkdir(parents=True)
    return repo, opc_source, claude_dir


class Runner:
    """Fake subprocess.run. Records every call and answers by command."""

    def __init__(self, npm_fail_on=None, on_active_install=None):
        self.calls = []
        self.npm_fail_on = npm_fail_on
        self.on_active_install = on_active_install

    def __call__(self, argv, **kwargs):
        self.calls.append((list(argv), kwargs))
        failed = self.npm_fail_on is not None and self.npm_fail_on in argv
        return MagicMock(returncode=1 if failed else 0, stdout="", stderr="npm err")

    def npm_calls(self):
        return [c for c in self.calls if "--omit=dev" not in c[0]]

    def active_install_calls(self):
        return [c for c in self.calls if "--omit=dev" in c[0]]


def run_helper(layout, runner, symlinked=False):
    _repo, opc_source, claude_dir = layout
    with patch.object(hooks_build.subprocess, "run", runner), \
         patch.object(hooks_build.shutil, "which", return_value="npm"):
        return build_and_sync_hooks(opc_source, claude_dir, symlinked, log=lambda _m: None)


def relative_files(root: Path) -> set[str]:
    if not root.exists():
        return set()
    return {p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file()}


def test_npm_runs_in_repo_hooks_not_active_dir(layout):
    _repo, opc_source, claude_dir = layout
    runner = Runner()
    run_helper(layout, runner)
    npm = runner.npm_calls()
    assert [c[0][1:] for c in npm][:2] == [["install"], ["run", "build"]]
    for _argv, kwargs in npm[:2]:
        assert Path(kwargs["cwd"]) == opc_source / "hooks"
        assert Path(kwargs["cwd"]) != claude_dir / "hooks"


def test_good_build_copies_exactly_the_sync_list(layout):
    _repo, _opc, claude_dir = layout
    ok, msg = run_helper(layout, Runner())
    assert ok, msg
    assert relative_files(claude_dir / "hooks") == {
        *COPIED_TOP_LEVEL,
        "dist/a.mjs",
        "dist/b.mjs",
    }
    assert (claude_dir / "hooks" / "dist" / "a.mjs").read_text() == "dist a"


def test_src_and_node_modules_are_never_copied(layout):
    _repo, _opc, claude_dir = layout
    run_helper(layout, Runner())
    assert not (claude_dir / "hooks" / "src").exists()
    assert not (claude_dir / "hooks" / "node_modules").exists()


def test_no_subprocess_call_runs_bash(layout):
    runner = Runner()
    (layout[2] / "hooks").mkdir()
    (layout[2] / "hooks" / "package.json").write_text("{}")
    run_helper(layout, runner)
    assert runner.calls
    for argv, _kwargs in runner.calls:
        assert argv[0] == "npm"
        assert "bash" not in " ".join(argv).lower()
        assert "sync-to-active" not in " ".join(argv)


@pytest.mark.parametrize("failing", ["install", "build"])
def test_failed_build_copies_nothing(layout, failing):
    _repo, _opc, claude_dir = layout
    ok, msg = run_helper(layout, Runner(npm_fail_on=failing))
    assert not ok
    assert "npm" in msg
    assert not (claude_dir / "hooks").exists()


def test_unchanged_files_are_not_rewritten(layout):
    _repo, _opc, claude_dir = layout
    run_helper(layout, Runner())
    with patch.object(hooks_build.shutil, "copy2") as copy2:
        ok, msg = run_helper(layout, Runner())
    assert ok, msg
    assert copy2.call_count == 0


def test_changed_file_is_overwritten(layout):
    _repo, opc_source, claude_dir = layout
    run_helper(layout, Runner())
    (opc_source / "hooks" / "dist" / "a.mjs").write_text("dist a v2")
    run_helper(layout, Runner())
    assert (claude_dir / "hooks" / "dist" / "a.mjs").read_text() == "dist a v2"


def test_symlink_flag_skips_copy(layout):
    _repo, _opc, claude_dir = layout
    runner = Runner()
    with patch.object(hooks_build.shutil, "copy2") as copy2:
        ok, msg = run_helper(layout, runner, symlinked=True)
    assert ok, msg
    assert copy2.call_count == 0
    assert not (claude_dir / "hooks").exists()
    assert "linked" in msg
    assert len(runner.npm_calls()) == 2
    assert runner.active_install_calls() == []


def test_active_hooks_linked_to_repo_skips_copy(layout):
    _repo, opc_source, claude_dir = layout
    try:
        (claude_dir / "hooks").symlink_to(opc_source / "hooks", target_is_directory=True)
    except OSError:
        pytest.skip("symlinks not allowed here")
    runner = Runner()
    with patch.object(hooks_build.shutil, "copy2") as copy2:
        ok, msg = run_helper(layout, runner, symlinked=False)
    assert ok, msg
    assert copy2.call_count == 0
    assert runner.active_install_calls() == []


def test_runtime_deps_installed_when_active_has_no_node_modules(layout):
    _repo, _opc, claude_dir = layout
    runner = Runner()
    ok, msg = run_helper(layout, runner)
    assert ok, msg
    last = runner.calls[-1]
    assert last[0][1:] == ["install", "--omit=dev"]
    assert Path(last[1]["cwd"]) == claude_dir / "hooks"
    # the package.json it reads comes from the copy
    assert (claude_dir / "hooks" / "package.json").is_file()


def test_runtime_deps_not_installed_when_node_modules_exists(layout):
    _repo, _opc, claude_dir = layout
    (claude_dir / "hooks" / "node_modules").mkdir(parents=True)
    runner = Runner()
    ok, msg = run_helper(layout, runner)
    assert ok, msg
    assert runner.active_install_calls() == []


def test_runtime_deps_failure_ends_with_manual_steps(layout):
    repo, _opc, _claude = layout
    runner = Runner(npm_fail_on="--omit=dev")
    ok, msg = run_helper(layout, runner)
    assert not ok
    assert msg.endswith(manual_steps(repo))


def test_manual_steps_text(tmp_path):
    text = manual_steps(tmp_path)
    hooks = tmp_path / ".claude" / "hooks"
    lines = text.splitlines()
    assert lines[0] == f'cd "{hooks}"'
    assert lines[1] == "npm install"
    assert lines[2] == "npm run build"
    assert "dist/*.mjs" in lines[3]
    assert "~/.claude/hooks/dist" in lines[3]
    assert len(lines) == 4
    assert "sync-to-active" not in text
    assert "agents" not in text


def failure_cases(layout):
    repo, opc_source, claude_dir = layout

    def boom_timeout(argv, **kwargs):
        raise subprocess.TimeoutExpired(argv, 1)

    def boom_os(argv, **kwargs):
        raise OSError("no exec")

    return [
        ("install", lambda: run_helper(layout, Runner(npm_fail_on="install"))),
        ("build", lambda: run_helper(layout, Runner(npm_fail_on="build"))),
        ("active", lambda: run_helper(layout, Runner(npm_fail_on="--omit=dev"))),
        ("timeout", lambda: run_helper(layout, boom_timeout)),
        ("oserror", lambda: run_helper(layout, boom_os)),
        ("no_npm", lambda: _no_npm(opc_source, claude_dir)),
    ]


def _no_npm(opc_source, claude_dir):
    with patch.object(hooks_build.shutil, "which", return_value=None), \
         patch.object(hooks_build.platform, "system", return_value="Linux"):
        return build_and_sync_hooks(opc_source, claude_dir, False, log=lambda _m: None)


@pytest.mark.parametrize("name", ["install", "build", "active", "timeout", "oserror", "no_npm"])
def test_every_failure_message_ends_with_manual_steps(layout, name):
    repo = layout[0]
    run = dict(failure_cases(layout))[name]
    ok, msg = run()
    assert not ok
    assert msg.endswith(manual_steps(repo))


def test_copy_error_ends_with_manual_steps(layout):
    repo = layout[0]
    with patch.object(hooks_build.shutil, "copy2", side_effect=OSError("disk full")):
        ok, msg = run_helper(layout, Runner())
    assert not ok
    assert "disk full" in msg
    assert msg.endswith(manual_steps(repo))


@pytest.mark.parametrize("name", ["install", "build", "active", "timeout", "oserror", "no_npm"])
def test_failure_message_style(layout, name):
    ok, msg = dict(failure_cases(layout))[name]()
    assert not ok
    first_part = msg.split("Manual steps:")[0]
    for bad in (";", "(", ")", " - "):
        assert bad not in first_part
    assert "sync-to-active" not in msg
    assert "agents" not in msg


def test_success_message_style(layout):
    for symlinked in (False, True):
        ok, msg = run_helper(layout, Runner(), symlinked=symlinked)
        assert ok
        for bad in (";", "(", ")", " - "):
            assert bad not in msg
        assert "sync-to-active" not in msg


def test_no_package_json_message_style(layout):
    _repo, opc_source, claude_dir = layout
    (opc_source / "hooks" / "package.json").unlink()
    ok, msg = build_and_sync_hooks(opc_source, claude_dir, False, log=lambda _m: None)
    assert ok
    assert " - " not in msg


def test_module_has_no_bash_or_sync_script_logic():
    assert not hasattr(hooks_build, "find_git_bash")
    assert not hasattr(hooks_build, "_run_sync")
    source = Path(hooks_build.__file__).read_text(encoding="utf-8")
    assert "sync-to-active" not in source
    assert "SYNC_ALLOW_BRANCH" not in source


def test_update_no_longer_copies_hooks_src(tmp_path):
    from scripts.setup import update

    repo = tmp_path / "repo"
    (repo / "opc").mkdir(parents=True)
    src = repo / ".claude" / "hooks" / "src"
    src.mkdir(parents=True)
    (src / "a.ts").write_text("export {}")
    home_claude = tmp_path / "home" / ".claude"
    home_claude.mkdir(parents=True)
    build = MagicMock(return_value=(True, "ok"))
    with patch.object(update, "get_opc_dir", return_value=repo / "opc"), \
         patch.object(update, "get_global_claude_dir", return_value=home_claude), \
         patch.object(update, "git_pull", return_value=(True, "ok")), \
         patch.object(update, "Confirm", None), \
         patch.object(update.subprocess, "run", MagicMock(returncode=0, stdout="", stderr="")), \
         patch.object(update, "build_and_sync_hooks", build):
        update.run_update()

    assert not (home_claude / "hooks" / "src").exists()
    assert build.call_count == 1
    assert Path(build.call_args.args[0]) == repo / ".claude"
    assert Path(build.call_args.args[1]) == home_claude


def test_wizard_reports_failure_with_manual_steps(tmp_path):
    from scripts.setup import wizard

    steps = manual_steps(tmp_path)
    with patch("scripts.setup.hooks_build.build_and_sync_hooks",
               return_value=(False, f"npm install failed. Manual steps:\n{steps}")) as build, \
         patch.object(wizard, "console") as console:
        wizard.build_and_report_hooks(tmp_path / ".claude", tmp_path / "home", symlinked=True)

    assert build.call_args.args[:3] == (tmp_path / ".claude", tmp_path / "home", True)
    printed = " ".join(str(c.args[0]) for c in console.print.call_args_list)
    assert "WARN" in printed
    assert "npm run build" in printed
    assert "sync-to-active" not in printed


class _StopWizard(Exception):
    pass


# (is there an existing setup, menu answer, expected symlinked flag)
WIZARD_CASES = [
    pytest.param(True, "1", False, id="existing-full-install"),
    pytest.param(True, "3", True, id="existing-symlink"),
    pytest.param(False, "1", False, id="fresh-copy"),
    pytest.param(False, "2", True, id="fresh-symlink"),
]


@pytest.mark.parametrize("has_existing,answer,expected_symlinked", WIZARD_CASES)
def test_wizard_call_sites_pass_right_args(tmp_path, has_existing, answer, expected_symlinked):
    """Drive run_setup_wizard to each install branch. Stop at _install_plugins."""
    import asyncio

    from scripts.setup import claude_integration as ci
    from scripts.setup import wizard

    opc_source = tmp_path / "repo" / ".claude"
    claude_dir = tmp_path / "home" / ".claude"
    existing = MagicMock(has_existing=has_existing, hooks=[], skills=[], rules=[], mcps=[])
    conflicts = MagicMock(has_conflicts=False)
    ok_result = {
        "success": True, "installed_hooks": 0, "installed_skills": 0, "installed_rules": 0,
        "installed_agents": 0, "installed_servers": 0, "merged_items": [],
        "backed_up_dirs": [], "symlinked_dirs": [],
    }

    prompt = MagicMock()
    prompt.ask.side_effect = lambda text, *a, **k: "sqlite" if "Database mode" in text else answer
    confirm = MagicMock()
    confirm.ask.return_value = False
    helper = MagicMock()

    patches = [
        patch.object(wizard, "console", MagicMock()),
        patch.object(wizard, "Panel", MagicMock()),
        patch.object(wizard, "Prompt", prompt),
        patch.object(wizard, "Confirm", confirm),
        patch.object(wizard, "check_prerequisites_with_install_offers",
                     MagicMock(side_effect=lambda: _async({
                         "docker": True, "python": True, "uv": True, "all_present": True,
                     }))),
        patch.object(wizard, "prompt_devops_integration", MagicMock(side_effect=lambda: _async(None))),
        patch.object(wizard, "generate_env_file", MagicMock()),
        patch.object(wizard, "build_and_report_hooks", helper),
        patch.object(wizard, "_install_plugins", MagicMock(side_effect=_StopWizard)),
        patch.object(ci, "get_global_claude_dir", return_value=claude_dir),
        patch.object(ci, "backup_global_claude_dir", return_value=None),
        patch.object(ci, "backup_claude_dir", return_value=None),
        patch.object(ci, "detect_existing_setup", return_value=existing),
        patch.object(ci, "get_opc_integration_source", return_value=opc_source),
        patch.object(ci, "analyze_conflicts", return_value=conflicts),
        patch.object(ci, "generate_migration_guidance", return_value=""),
        patch.object(ci, "install_opc_integration", return_value=ok_result),
        patch.object(ci, "install_opc_integration_symlink", return_value=ok_result),
    ]
    from contextlib import ExitStack

    with ExitStack() as stack:
        for p in patches:
            stack.enter_context(p)
        with pytest.raises(_StopWizard):
            asyncio.run(wizard.run_setup_wizard())

    assert helper.call_count == 1
    args, kwargs = helper.call_args
    bound = dict(zip(["opc_source", "claude_dir", "symlinked"], args))
    bound.update(kwargs)
    assert bound["opc_source"] == opc_source
    assert bound["claude_dir"] == claude_dir
    assert bound["symlinked"] is expected_symlinked


async def _async(value):
    return value
