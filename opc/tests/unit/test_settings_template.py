"""Tests for settings.json template generation.

Tests render_settings_json(), which replaces {{placeholders}} in
settings.json.template with machine-specific paths.
"""
from __future__ import annotations

import json
import textwrap
from pathlib import Path

import pytest


# ---- Fixtures ----

@pytest.fixture
def sample_template(tmp_path: Path) -> Path:
    """Create a minimal settings.json.template with placeholders."""
    template = tmp_path / "settings.json.template"
    template.write_text(json.dumps({
        "env": {
            "CLAUDE_OPC_DIR": "{{OPC_DIR}}",
        },
        "hooks": {
            "PreToolUse": [
                {
                    "matcher": "Agent",
                    "hooks": [
                        {
                            "type": "command",
                            "command": "node {{CLAUDE_HOME}}/hooks/dist/agent-validate.mjs",
                            "timeout": 3000,
                        }
                    ],
                }
            ],
        },
        "statusLine": {
            "type": "command",
            "command": "node {{CLAUDE_HOME}}/plugins/claude-hud/launcher.mjs",
        },
        "mcpServers": {
            "qlty": {
                "type": "stdio",
                "command": "{{CLAUDE_HOME}}/venv/bin/python",
                "args": ["{{CLAUDE_HOME}}/servers/qlty/server.py"],
            }
        },
    }, indent=2))
    return template


@pytest.fixture
def full_template(tmp_path: Path) -> Path:
    """Create a template with all 4 placeholder types."""
    template = tmp_path / "settings.json.template"
    template.write_text(json.dumps({
        "env": {
            "CLAUDE_OPC_DIR": "{{OPC_DIR}}",
        },
        "hooks": {
            "PreToolUse": [
                {
                    "hooks": [
                        {
                            "type": "command",
                            "command": "node {{CLAUDE_HOME}}/hooks/dist/test.mjs",
                        }
                    ]
                }
            ],
            "UserPromptSubmit": [
                {
                    "hooks": [
                        {
                            "type": "command",
                            "command": "python {{CLAUDE_HOME}}/hooks/braintrust_hooks.py user_prompt_submit",
                        }
                    ]
                }
            ],
        },
        "statusLine": {
            "type": "command",
            "command": "node {{CLAUDE_HOME}}/plugins/hud.mjs",
        },
        "mcpServers": {
            "qlty": {
                "type": "stdio",
                "command": "{{CLAUDE_HOME}}/venv/bin/python",
                "args": ["{{CLAUDE_HOME}}/servers/qlty/server.py"],
            }
        },
        "someUserField": "{{USER_HOME}}/documents",
        "repoRef": "{{REPO_ROOT}}/scripts/check.py",
    }, indent=2))
    return template


REPO = Path(__file__).resolve().parents[3]
TEMPLATE = REPO / ".claude" / "settings.json.template"


# ---- Tests for render_settings_json ----

class TestGenerateSettingsJson:
    """Test the template-based settings.json generation."""

    def test_function_exists(self):
        """render_settings_json is importable and the old name is gone."""
        import scripts.setup.claude_integration as ci
        from scripts.setup.claude_integration import render_settings_json
        assert callable(render_settings_json)
        assert not hasattr(ci, "generate_settings_json")

    def test_replaces_claude_home(self, sample_template: Path, tmp_path: Path):
        """{{CLAUDE_HOME}} is replaced with actual .claude path."""
        from scripts.setup.claude_integration import render_settings_json

        target = tmp_path / "output" / "settings.json"
        variables = {
            "CLAUDE_HOME": "C:/Users/newuser/.claude",
            "OPC_DIR": "C:/Users/newuser/continuous-claude/opc",
            "REPO_ROOT": "C:/Users/newuser/continuous-claude",
            "USER_HOME": "C:/Users/newuser",
        }
        render_settings_json(sample_template, target, variables)

        result = json.loads(target.read_text())
        # Check hook command has newuser path
        hook_cmd = result["hooks"]["PreToolUse"][0]["hooks"][0]["command"]
        assert "C:/Users/newuser/.claude/hooks/dist/agent-validate.mjs" in hook_cmd
        assert "{{CLAUDE_HOME}}" not in hook_cmd

    def test_replaces_opc_dir(self, sample_template: Path, tmp_path: Path):
        """{{OPC_DIR}} is replaced with actual opc path."""
        from scripts.setup.claude_integration import render_settings_json

        target = tmp_path / "output" / "settings.json"
        variables = {
            "CLAUDE_HOME": "C:/Users/newuser/.claude",
            "OPC_DIR": "C:/Users/newuser/continuous-claude/opc",
            "REPO_ROOT": "C:/Users/newuser/continuous-claude",
            "USER_HOME": "C:/Users/newuser",
        }
        render_settings_json(sample_template, target, variables)

        result = json.loads(target.read_text())
        assert result["env"]["CLAUDE_OPC_DIR"] == "C:/Users/newuser/continuous-claude/opc"
        assert "{{OPC_DIR}}" not in target.read_text()

    def test_replaces_all_four_placeholders(self, full_template: Path, tmp_path: Path):
        """All four placeholder types are replaced."""
        from scripts.setup.claude_integration import render_settings_json

        target = tmp_path / "output" / "settings.json"
        variables = {
            "CLAUDE_HOME": "/home/alice/.claude",
            "OPC_DIR": "/home/alice/continuous-claude/opc",
            "REPO_ROOT": "/home/alice/continuous-claude",
            "USER_HOME": "/home/alice",
        }
        render_settings_json(full_template, target, variables)

        content = target.read_text()
        assert "{{CLAUDE_HOME}}" not in content
        assert "{{OPC_DIR}}" not in content
        assert "{{REPO_ROOT}}" not in content
        assert "{{USER_HOME}}" not in content
        assert "/home/alice/.claude" in content
        assert "/home/alice/continuous-claude/opc" in content
        assert "/home/alice/continuous-claude/scripts/check.py" in content
        assert "/home/alice/documents" in content

    def test_output_is_valid_json(self, full_template: Path, tmp_path: Path):
        """Generated settings.json is valid JSON."""
        from scripts.setup.claude_integration import render_settings_json

        target = tmp_path / "output" / "settings.json"
        variables = {
            "CLAUDE_HOME": "/home/bob/.claude",
            "OPC_DIR": "/home/bob/cc/opc",
            "REPO_ROOT": "/home/bob/cc",
            "USER_HOME": "/home/bob",
        }
        render_settings_json(full_template, target, variables)

        # Should not raise
        parsed = json.loads(target.read_text())
        assert isinstance(parsed, dict)

    def test_creates_parent_directories(self, sample_template: Path, tmp_path: Path):
        """Target parent directory is created if it doesn't exist."""
        from scripts.setup.claude_integration import render_settings_json

        target = tmp_path / "deep" / "nested" / "dir" / "settings.json"
        variables = {
            "CLAUDE_HOME": "/home/x/.claude",
            "OPC_DIR": "/home/x/cc/opc",
            "REPO_ROOT": "/home/x/cc",
            "USER_HOME": "/home/x",
        }
        render_settings_json(sample_template, target, variables)
        assert target.exists()

    def test_raises_on_missing_template(self, tmp_path: Path):
        """Raises FileNotFoundError if template doesn't exist."""
        from scripts.setup.claude_integration import render_settings_json

        template = tmp_path / "nonexistent.template"
        target = tmp_path / "settings.json"
        variables = {
            "CLAUDE_HOME": "/x",
            "OPC_DIR": "/x/opc",
            "REPO_ROOT": "/x",
            "USER_HOME": "/x",
        }
        with pytest.raises(FileNotFoundError):
            render_settings_json(template, target, variables)

    def test_forward_slashes_on_windows_paths(self, sample_template: Path, tmp_path: Path):
        """Windows-style paths use forward slashes in output."""
        from scripts.setup.claude_integration import render_settings_json

        target = tmp_path / "settings.json"
        variables = {
            "CLAUDE_HOME": "C:/Users/someone/.claude",
            "OPC_DIR": "C:/Users/someone/continuous-claude/opc",
            "REPO_ROOT": "C:/Users/someone/continuous-claude",
            "USER_HOME": "C:/Users/someone",
        }
        render_settings_json(sample_template, target, variables)

        content = target.read_text()
        assert "\\" not in content  # No backslashes

    def test_preserves_non_path_values(self, sample_template: Path, tmp_path: Path):
        """Non-placeholder values are preserved exactly."""
        from scripts.setup.claude_integration import render_settings_json

        target = tmp_path / "settings.json"
        variables = {
            "CLAUDE_HOME": "/home/z/.claude",
            "OPC_DIR": "/home/z/cc/opc",
            "REPO_ROOT": "/home/z/cc",
            "USER_HOME": "/home/z",
        }
        render_settings_json(sample_template, target, variables)

        result = json.loads(target.read_text())
        # Timeout and type fields should be unchanged
        hook_entry = result["hooks"]["PreToolUse"][0]["hooks"][0]
        assert hook_entry["type"] == "command"
        assert hook_entry["timeout"] == 3000


class TestSettingsTemplate:
    """Test the actual settings.json.template file in the repo."""

    def test_template_exists(self):
        """settings.json.template exists in .claude/ directory."""
        template_path = TEMPLATE
        assert template_path.exists(), "settings.json.template must exist"

    def test_template_has_no_hardcoded_paths(self):
        """Template contains zero occurrences of 'david.hayes'."""
        template_path = TEMPLATE
        if not template_path.exists():
            pytest.skip("Template not yet created")
        content = template_path.read_text()
        assert "david.hayes" not in content, (
            f"Template still contains hardcoded 'david.hayes' path"
        )

    def test_template_has_placeholders(self):
        """Template contains expected placeholder tokens."""
        template_path = TEMPLATE
        if not template_path.exists():
            pytest.skip("Template not yet created")
        content = template_path.read_text()
        assert "{{CLAUDE_HOME}}" in content
        assert "{{OPC_DIR}}" in content

    def test_template_is_parseable_with_placeholders(self):
        """Template is valid JSON (placeholders are inside string values)."""
        template_path = TEMPLATE
        if not template_path.exists():
            pytest.skip("Template not yet created")
        content = template_path.read_text()
        # Should parse as JSON since placeholders are inside string values
        parsed = json.loads(content)
        assert isinstance(parsed, dict)

    def test_template_roundtrip_produces_valid_settings(self):
        """Generating from template produces valid settings with correct structure."""
        from scripts.setup.claude_integration import render_settings_json

        template_path = TEMPLATE
        if not template_path.exists():
            pytest.skip("Template not yet created")

        import tempfile
        with tempfile.NamedTemporaryFile(suffix=".json", delete=False, mode="w") as f:
            target = Path(f.name)

        try:
            variables = {
                "CLAUDE_HOME": "C:/Users/testuser/.claude",
                "OPC_DIR": "C:/Users/testuser/continuous-claude/opc",
                "REPO_ROOT": "C:/Users/testuser/continuous-claude",
                "USER_HOME": "C:/Users/testuser",
            }
            render_settings_json(template_path, target, variables)

            result = json.loads(target.read_text())
            # Verify key structural elements
            assert "hooks" in result
            assert "env" in result
            assert "mcpServers" not in result
            assert result["env"]["CLAUDE_OPC_DIR"] == "C:/Users/testuser/continuous-claude/opc"

            # Verify no placeholders remain
            content = target.read_text()
            assert "{{" not in content
            assert "}}" not in content

            # Verify paths point to testuser
            assert "C:/Users/testuser" in content
            assert "david.hayes" not in content
        finally:
            target.unlink(missing_ok=True)
