#!/usr/bin/env python3
"""Container Stack Setup for OPC v3.

Manages the Docker/Podman Compose stack lifecycle including:
- Starting services (PostgreSQL, Redis, Sandbox)
- Waiting for health checks
- Running database migrations
- Verifying stack health

Supports both Docker and Podman as container runtimes.

USAGE:
    python -m scripts.setup.docker_setup
"""

import asyncio
import os
import platform
import shutil
import subprocess
from collections.abc import Callable
from pathlib import Path
from typing import Any

try:
    from rich.console import Console

    console = Console()
except ImportError:

    class Console:
        def print(self, *args, **kwargs):
            print(*args)

    console = Console()


# Default paths
PROJECT_ROOT = Path(__file__).parent.parent.parent
# Docker setup is in the docker/ directory at repo root (parent of opc/)
DOCKER_DIR = PROJECT_ROOT.parent / "docker"
DOCKER_COMPOSE_FILE = DOCKER_DIR / "docker-compose.yml"
MIGRATIONS_DIR = PROJECT_ROOT / "scripts" / "migrations"
# The agentic_os schema (lanes, coordination events) has its own drizzle migrations.
AGENTIC_OS_DIR = PROJECT_ROOT.parent / "apps" / "agentic-os"

# Container runtime - "docker" or "podman" (set by wizard after detection)
_CONTAINER_RUNTIME = "docker"


def set_container_runtime(runtime: str) -> None:
    """Set the container runtime to use (docker or podman)."""
    global _CONTAINER_RUNTIME
    _CONTAINER_RUNTIME = runtime


def get_container_runtime() -> str:
    """Get the current container runtime."""
    return _CONTAINER_RUNTIME


async def start_docker_stack(
    compose_file: Path | None = None,
    env_file: Path | None = None,
) -> dict[str, Any]:
    """Start the Docker Compose stack.

    Args:
        compose_file: Path to docker-compose.yml (defaults to project root)
        env_file: Path to .env file for variable substitution

    Returns:
        dict with keys: success, error (if failed), output
    """
    compose_path = compose_file or DOCKER_COMPOSE_FILE

    if not compose_path.exists():
        return {"success": False, "error": f"Docker compose file not found: {compose_path}"}

    # Build command with optional --env-file
    cmd = [_CONTAINER_RUNTIME, "compose", "-f", str(compose_path)]
    if env_file and env_file.exists():
        cmd.extend(["--env-file", str(env_file)])
    cmd.extend(["up", "-d"])

    try:
        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await process.communicate()

        if process.returncode == 0:
            return {"success": True, "output": stdout.decode()}
        else:
            return {"success": False, "error": stderr.decode(), "output": stdout.decode()}
    except Exception as e:
        return {"success": False, "error": str(e)}


async def wait_for_services(
    timeout: int = 60,
    services: list[str] | None = None,
    compose_file: Path | None = None,
) -> dict[str, Any]:
    """Wait for Docker services to become healthy.

    Args:
        timeout: Maximum seconds to wait
        services: List of service names to check (defaults to postgres, redis)
        compose_file: Path to docker-compose.yml

    Returns:
        dict with service health status and all_healthy flag
    """
    services = services or ["postgres"]
    compose_path = compose_file or DOCKER_COMPOSE_FILE
    result = {s: False for s in services}
    result["all_healthy"] = False

    start_time = asyncio.get_event_loop().time()

    while (asyncio.get_event_loop().time() - start_time) < timeout:
        all_healthy = True

        for service in services:
            try:
                process = await asyncio.create_subprocess_exec(
                    _CONTAINER_RUNTIME,
                    "compose",
                    "-f",
                    str(compose_path),
                    "ps",
                    service,
                    "--format",
                    "{{.Health}}",
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                stdout, _ = await process.communicate()

                health = stdout.decode().strip().lower()
                if health == "healthy" or process.returncode == 0 and "healthy" in health:
                    result[service] = True
                else:
                    pass
            except Exception:
                pass

        if all(result[s] for s in services):
            result["all_healthy"] = True
            return result

        await asyncio.sleep(1)

    return result


async def run_migrations(
    migrations_dir: Path | None = None,
    compose_file: Path | None = None,
) -> dict[str, Any]:
    """Run database migrations.

    Args:
        migrations_dir: Directory containing migration SQL files
        compose_file: Path to docker-compose.yml

    Returns:
        dict with keys: success, error (if failed), migrations_run
    """
    migrations_path = migrations_dir or MIGRATIONS_DIR
    compose_path = compose_file or DOCKER_COMPOSE_FILE

    # First, re-run the canonical init-schema.sql (the file docker-compose mounts).
    # Every statement is idempotent, so this also upgrades an older database.
    # (It used to look for opc/init-schema.sql, which does not exist, so it never ran.)
    init_sql = DOCKER_DIR / "init-schema.sql"

    try:
        if init_sql.exists():
            process = await asyncio.create_subprocess_exec(
                _CONTAINER_RUNTIME,
                "compose",
                "-f",
                str(compose_path),
                "exec",
                "-T",
                "postgres",
                "psql",
                "-v",
                "ON_ERROR_STOP=1",
                "-U",
                "claude",
                "-d",
                "continuous_claude",
                "-f",
                "/docker-entrypoint-initdb.d/init-schema.sql",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await process.communicate()

            if process.returncode != 0:
                # Try alternative approach - pipe the SQL directly
                process = await asyncio.create_subprocess_exec(
                    _CONTAINER_RUNTIME,
                    "compose",
                    "-f",
                    str(compose_path),
                    "exec",
                    "-T",
                    "postgres",
                    "psql",
                "-v",
                "ON_ERROR_STOP=1",
                    "-U",
                    "claude",
                    "-d",
                    "continuous_claude",
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                stdout, stderr = await process.communicate(input=init_sql.read_bytes())

                if process.returncode != 0:
                    return {"success": False, "error": stderr.decode()}

        # Run any additional migrations
        migrations_run = []
        if migrations_path.exists():
            for sql_file in sorted(migrations_path.glob("*.sql")):
                process = await asyncio.create_subprocess_exec(
                    _CONTAINER_RUNTIME,
                    "compose",
                    "-f",
                    str(compose_path),
                    "exec",
                    "-T",
                    "postgres",
                    "psql",
                "-v",
                "ON_ERROR_STOP=1",
                    "-U",
                    "claude",
                    "-d",
                    "continuous_claude",
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                stdout, stderr = await process.communicate(input=sql_file.read_bytes())

                if process.returncode != 0:
                    return {
                        "success": False,
                        "error": stderr.decode(),
                        "migrations_run": migrations_run,
                    }
                migrations_run.append(sql_file.name)

        return {"success": True, "migrations_run": migrations_run}

    except Exception as e:
        return {"success": False, "error": str(e)}


def _find_npm() -> str | None:
    npm = shutil.which("npm")
    if npm is None and platform.system() == "Windows":
        npm = shutil.which("npm.cmd")
    return npm


def _masked(text: str, secret: str) -> str:
    """Short error text with the database URL removed (it holds the password)."""
    return text.replace(secret, "<db-url>")[-400:] if secret else text[-400:]


def run_agentic_os_migrations(
    db_url: str | None,
    app_dir: Path | None = None,
    run: Callable[..., subprocess.CompletedProcess] = subprocess.run,
    npm: str | None = None,
) -> dict[str, Any]:
    """Create or update the agentic_os schema (lanes, coordination events).

    init-schema.sql builds only the public tables. Without this step a new
    database has no agentic_os schema: the lane board fails and coordination
    events are dropped. Order: install packages if drizzle-kit is missing,
    db:check (all DDL stays in agentic_os), then db:migrate. Safe to re-run.

    Returns:
        dict with keys: success, skipped (no database URL), error (if failed)
    """
    if not db_url:
        return {"success": True, "skipped": True}
    app = app_dir or AGENTIC_OS_DIR
    if not (app / "package.json").exists():
        return {"success": False, "error": f"agentic-os app not found: {app}"}
    npm = npm or _find_npm()
    if npm is None:
        return {"success": False, "error": "npm not found in PATH"}

    env = {**os.environ, "AGENTIC_OS_DATABASE_URL": db_url}
    steps = [["run", "db:check"], ["run", "db:migrate"]]
    if not (app / "node_modules" / "drizzle-kit").exists():
        steps.insert(0, ["ci"])
    for step in steps:
        try:
            result = run(
                [npm, *step], cwd=app, env=env, capture_output=True, text=True, timeout=300
            )
        except (OSError, subprocess.TimeoutExpired) as e:
            return {"success": False, "error": f"npm {' '.join(step)}: {_masked(str(e), db_url)}"}
        if result.returncode != 0:
            detail = _masked((result.stderr or "") + (result.stdout or ""), db_url)
            return {"success": False, "error": f"npm {' '.join(step)} failed: {detail}"}
    return {"success": True, "skipped": False}


async def verify_stack_health(compose_file: Path | None = None) -> dict[str, Any]:
    """Verify the health status of all services in the stack.

    Args:
        compose_file: Path to docker-compose.yml

    Returns:
        dict with service statuses and all_healthy flag
    """
    compose_path = compose_file or DOCKER_COMPOSE_FILE

    try:
        process = await asyncio.create_subprocess_exec(
            _CONTAINER_RUNTIME,
            "compose",
            "-f",
            str(compose_path),
            "ps",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await process.communicate()

        if process.returncode != 0:
            return {"all_healthy": False, "error": stderr.decode()}

        output = stdout.decode()
        result = {"all_healthy": True}

        # Parse output to extract service health
        # Check each line for service names and their status
        lines = output.strip().split("\n")
        for line in lines:
            line_lower = line.lower()

            # Match postgres service
            if "postgres" in line_lower:
                if "healthy" in line_lower:
                    result["postgres"] = "healthy"
                elif "up" in line_lower:
                    result["postgres"] = "running"
                else:
                    result["postgres"] = "unhealthy"
                    result["all_healthy"] = False

            # Match redis service
            if "redis" in line_lower:
                if "healthy" in line_lower:
                    result["redis"] = "healthy"
                elif "up" in line_lower:
                    result["redis"] = "running"
                else:
                    result["redis"] = "unhealthy"
                    result["all_healthy"] = False

            if "sandbox" in line.lower():
                if "up" in line.lower():
                    result["sandbox"] = "running"
                else:
                    result["sandbox"] = "stopped"

        return result

    except Exception as e:
        return {"all_healthy": False, "error": str(e)}


async def stop_docker_stack(compose_file: Path | None = None) -> dict[str, Any]:
    """Stop the Docker Compose stack.

    Args:
        compose_file: Path to docker-compose.yml

    Returns:
        dict with keys: success, error (if failed)
    """
    compose_path = compose_file or DOCKER_COMPOSE_FILE

    try:
        process = await asyncio.create_subprocess_exec(
            _CONTAINER_RUNTIME,
            "compose",
            "-f",
            str(compose_path),
            "down",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await process.communicate()

        if process.returncode == 0:
            return {"success": True}
        else:
            return {"success": False, "error": stderr.decode()}

    except Exception as e:
        return {"success": False, "error": str(e)}


async def main():
    """CLI entry point for Docker setup operations."""
    import sys

    if len(sys.argv) < 2:
        print("Usage: python -m scripts.setup.docker_setup <command>")
        print("Commands: start, stop, wait, migrate, health")
        sys.exit(1)

    command = sys.argv[1]

    if command == "start":
        result = await start_docker_stack()
        print(f"Start: {'OK' if result['success'] else result.get('error', 'Failed')}")

    elif command == "stop":
        result = await stop_docker_stack()
        print(f"Stop: {'OK' if result['success'] else result.get('error', 'Failed')}")

    elif command == "wait":
        result = await wait_for_services(timeout=60)
        print(f"Health: {result}")

    elif command == "migrate":
        result = await run_migrations()
        print(f"Migrate: {'OK' if result['success'] else result.get('error', 'Failed')}")

    elif command == "health":
        result = await verify_stack_health()
        print(f"Stack Health: {result}")

    else:
        print(f"Unknown command: {command}")
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
