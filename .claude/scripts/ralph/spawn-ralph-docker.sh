#!/usr/bin/env bash
# spawn-ralph-docker.sh - Enhanced Ralph spawn with memory integration
#
# Orchestrates Docker-isolated agents with:
# 1. Pre-spawn context preparation (memory query, knowledge tree)
# 2. Docker container execution with context mounted
# 3. Post-completion learning extraction
#
# Usage:
#   ./spawn-ralph-docker.sh \
#     --task "Implement authentication middleware" \
#     --story-id "STORY-001" \
#     --project-dir "/path/to/project" \
#     [--iteration 1] \
#     [--max-iterations 30]
#
# Environment:
#   ANTHROPIC_API_KEY - Required for Claude
#   DATABASE_URL - PostgreSQL for memory (optional)

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Defaults
CLAUDE_HOME="${CLAUDE_HOME:-$HOME/.claude}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ITERATION=1
MAX_ITERATIONS=30
TASK_ID=""
CONTEXT_DIR=""
DOCKER_IMAGE="ralph-ralph"

# ═══════════════════════════════════════════════════════════════════════════════
# Auto-build Docker image if not present
# ═══════════════════════════════════════════════════════════════════════════════
ensure_docker_image() {
    if ! docker image inspect "$DOCKER_IMAGE" &>/dev/null; then
        echo -e "${YELLOW}Docker image '$DOCKER_IMAGE' not found. Building (first time only)...${NC}"
        echo -e "${BLUE}This may take 5-10 minutes due to CUDA/PyTorch dependencies.${NC}"

        local dockerfile_dir="$CLAUDE_HOME/docker/ralph"
        if [[ ! -f "$dockerfile_dir/Dockerfile" ]]; then
            echo -e "${RED}Error: Dockerfile not found at $dockerfile_dir/Dockerfile${NC}"
            exit 1
        fi

        docker build -t "$DOCKER_IMAGE" "$dockerfile_dir"

        if [[ $? -eq 0 ]]; then
            echo -e "${GREEN}✓ Docker image '$DOCKER_IMAGE' built successfully${NC}"
        else
            echo -e "${RED}✗ Docker image build failed${NC}"
            exit 1
        fi
    fi
}

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --task)
            TASK_DESCRIPTION="$2"
            shift 2
            ;;
        --story-id)
            STORY_ID="$2"
            shift 2
            ;;
        --project-dir)
            PROJECT_DIR="$2"
            shift 2
            ;;
        --iteration)
            ITERATION="$2"
            shift 2
            ;;
        --max-iterations)
            MAX_ITERATIONS="$2"
            shift 2
            ;;
        --task-id)
            TASK_ID="$2"
            shift 2
            ;;
        -h|--help)
            echo "Usage: $0 --task <description> --story-id <id> --project-dir <path> [options]"
            echo ""
            echo "Options:"
            echo "  --task          Task description for the agent"
            echo "  --story-id      Story ID for tracking"
            echo "  --project-dir   Path to the project"
            echo "  --iteration     Current iteration number (default: 1)"
            echo "  --max-iterations Maximum iterations (default: 30)"
            echo "  --task-id       Custom task ID (default: auto-generated)"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Validate required arguments
if [[ -z "${TASK_DESCRIPTION:-}" ]]; then
    echo -e "${RED}Error: --task is required${NC}"
    exit 1
fi

if [[ -z "${STORY_ID:-}" ]]; then
    echo -e "${RED}Error: --story-id is required${NC}"
    exit 1
fi

if [[ -z "${PROJECT_DIR:-}" ]]; then
    echo -e "${RED}Error: --project-dir is required${NC}"
    exit 1
fi

# Generate task ID if not provided
if [[ -z "$TASK_ID" ]]; then
    TASK_ID="task-$(date +%s)-$$"
fi

# Set up context directory
CONTEXT_DIR="/tmp/ralph-context/$TASK_ID"

echo -e "${BLUE}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║          Ralph Docker Agent - Memory Integration             ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${YELLOW}Story:${NC} $STORY_ID"
echo -e "${YELLOW}Task:${NC} $TASK_DESCRIPTION"
echo -e "${YELLOW}Iteration:${NC} $ITERATION / $MAX_ITERATIONS"
echo ""

# ═══════════════════════════════════════════════════════════════════════════════
# Phase 1: Prepare Context
# ═══════════════════════════════════════════════════════════════════════════════

echo -e "${GREEN}[1/4] Preparing agent context...${NC}"

cd "$CLAUDE_HOME/scripts/ralph"

# Run prepare-agent-context.py
PREPARE_RESULT=$(uv run python prepare-agent-context.py \
    --task-description "$TASK_DESCRIPTION" \
    --project-dir "$PROJECT_DIR" \
    --story-id "$STORY_ID" \
    --output-dir "$CONTEXT_DIR" \
    --iteration "$ITERATION" \
    --max-iterations "$MAX_ITERATIONS" \
    --json 2>/dev/null || echo '{"success": false, "error": "prepare script failed"}')

if echo "$PREPARE_RESULT" | grep -q '"success": false'; then
    ERROR=$(echo "$PREPARE_RESULT" | grep -o '"error": "[^"]*"' | cut -d'"' -f4)
    echo -e "${RED}  ✗ Context preparation failed: $ERROR${NC}"
    exit 1
fi

LEARNINGS_COUNT=$(echo "$PREPARE_RESULT" | grep -o '"working_solutions": [0-9]*' | grep -o '[0-9]*')
echo -e "${GREEN}  ✓ Context prepared at $CONTEXT_DIR${NC}"
echo -e "${GREEN}  ✓ Recalled ${LEARNINGS_COUNT:-0} relevant learnings${NC}"

# ═══════════════════════════════════════════════════════════════════════════════
# Phase 2: Build Agent Prompt
# ═══════════════════════════════════════════════════════════════════════════════

echo -e "${GREEN}[2/4] Building agent prompt...${NC}"

# Read the agent prompt template and substitute variables
AGENT_PROMPT_TEMPLATE="$CLAUDE_HOME/templates/ralph/AGENT_PROMPT.md"
if [[ ! -f "$AGENT_PROMPT_TEMPLATE" ]]; then
    echo -e "${RED}  ✗ Agent prompt template not found: $AGENT_PROMPT_TEMPLATE${NC}"
    exit 1
fi

# Get project name
PROJECT_NAME=$(basename "$PROJECT_DIR")

# Create the prompt with substitutions
AGENT_PROMPT=$(cat "$AGENT_PROMPT_TEMPLATE" | \
    sed "s|{{TASK_DESCRIPTION}}|$TASK_DESCRIPTION|g" | \
    sed "s|{{STORY_ID}}|$STORY_ID|g" | \
    sed "s|{{ITERATION}}|$ITERATION|g" | \
    sed "s|{{MAX_ITERATIONS}}|$MAX_ITERATIONS|g" | \
    sed "s|{{PROJECT_NAME}}|$PROJECT_NAME|g" | \
    sed "s|{{TASK_TYPE}}|implement|g" | \
    sed "s|{{REQUIREMENTS}}|See task description|g" | \
    sed "s|{{FILES}}|Determined by agent|g" | \
    sed "s|{{COMMIT_MESSAGE}}|feat($STORY_ID): $TASK_DESCRIPTION|g")

# Write prompt to context dir
echo "$AGENT_PROMPT" > "$CONTEXT_DIR/agent-prompt.md"
echo -e "${GREEN}  ✓ Agent prompt generated${NC}"

# ═══════════════════════════════════════════════════════════════════════════════
# Phase 3: Run Docker Container
# ═══════════════════════════════════════════════════════════════════════════════

echo -e "${GREEN}[3/4] Spawning Docker agent...${NC}"

# Ensure Docker image exists (builds if needed - first time only)
ensure_docker_image

# Ensure .ralph directory exists in project
mkdir -p "$PROJECT_DIR/.ralph"

# Check for docker-compose file
COMPOSE_FILE="$CLAUDE_HOME/docker/ralph/docker-compose.yml"
if [[ ! -f "$COMPOSE_FILE" ]]; then
    echo -e "${YELLOW}  ! docker-compose.yml not found, using direct docker run${NC}"

    # Direct docker run fallback with resource limits
    # Memory: 8GB, CPU: 4 cores, PIDs: 512
    docker run --rm \
        --network host \
        --memory="${RALPH_MEMORY_LIMIT:-8g}" \
        --cpus="${RALPH_CPU_LIMIT:-4}" \
        --pids-limit=512 \
        --security-opt=no-new-privileges:true \
        -e ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}" \
        -e DATABASE_URL="${DATABASE_URL:-}" \
        -e STORY_ID="$STORY_ID" \
        -e RALPH_PROJECT="$PROJECT_NAME" \
        -v "$CONTEXT_DIR:/context:ro" \
        -v "$PROJECT_DIR:/workspace" \
        -v "$CLAUDE_HOME/hooks:/home/node/.claude/hooks:ro" \
        -v "$CLAUDE_HOME/settings.json:/home/node/.claude/settings.json:ro" \
        -v "$CLAUDE_HOME/scripts/core:/home/node/.claude/scripts/core:ro" \
        -w /workspace \
        --name "ralph-$TASK_ID" \
        "$DOCKER_IMAGE" \
        claude -p "$(cat "$CONTEXT_DIR/agent-prompt.md")"

    DOCKER_EXIT=$?
else
    # Use docker-compose with context mount
    CONTEXT_DIR="$CONTEXT_DIR" \
    WORKSPACE="$PROJECT_DIR" \
    STORY_ID="$STORY_ID" \
    RALPH_PROJECT="$PROJECT_NAME" \
    docker-compose -f "$COMPOSE_FILE" run --rm ralph \
        claude -p "$(cat "$CONTEXT_DIR/agent-prompt.md")"

    DOCKER_EXIT=$?
fi

if [[ $DOCKER_EXIT -ne 0 ]]; then
    echo -e "${RED}  ✗ Docker container exited with code $DOCKER_EXIT${NC}"
    # Still try to extract learnings from failure
fi

echo -e "${GREEN}  ✓ Docker agent completed${NC}"

# ═══════════════════════════════════════════════════════════════════════════════
# Phase 4: Extract Learnings
# ═══════════════════════════════════════════════════════════════════════════════

echo -e "${GREEN}[4/4] Extracting learnings...${NC}"

OUTPUT_FILE="$PROJECT_DIR/.ralph/agent-output.json"

if [[ -f "$OUTPUT_FILE" ]]; then
    cd "$CLAUDE_HOME/scripts/ralph"

    EXTRACT_RESULT=$(uv run python extract-agent-learnings.py \
        --output-file "$OUTPUT_FILE" \
        --story-id "$STORY_ID" \
        --task-description "$TASK_DESCRIPTION" \
        --project-dir "$PROJECT_DIR" \
        --json 2>/dev/null || echo '{"success": false, "error": "extract script failed"}')

    if echo "$EXTRACT_RESULT" | grep -q '"success": true'; then
        LEARNING_TYPE=$(echo "$EXTRACT_RESULT" | grep -o '"learning_type": "[^"]*"' | cut -d'"' -f4)
        if [[ -n "$LEARNING_TYPE" ]]; then
            echo -e "${GREEN}  ✓ Learning stored: $LEARNING_TYPE${NC}"
        else
            echo -e "${YELLOW}  ~ Learning skipped (blocked or no signal)${NC}"
        fi
    else
        ERROR=$(echo "$EXTRACT_RESULT" | grep -o '"error": "[^"]*"' | cut -d'"' -f4)
        echo -e "${YELLOW}  ! Learning extraction failed: $ERROR${NC}"
    fi

    # Parse status from output
    STATUS=$(cat "$OUTPUT_FILE" | grep -o '"status": "[^"]*"' | cut -d'"' -f4 || echo "unknown")
    echo -e "${BLUE}  Agent status: $STATUS${NC}"
else
    echo -e "${YELLOW}  ! No agent-output.json found - agent may not have completed properly${NC}"
    STATUS="no_output"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# Summary
# ═══════════════════════════════════════════════════════════════════════════════

echo ""
echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}                        Summary                                 ${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
echo -e "Story:      $STORY_ID"
echo -e "Task:       $TASK_DESCRIPTION"
echo -e "Status:     $STATUS"
echo -e "Context:    $CONTEXT_DIR"
echo -e "Output:     $OUTPUT_FILE"
echo ""

# Update orchestration.json
ORCH_FILE="$PROJECT_DIR/.ralph/orchestration.json"
if [[ -f "$ORCH_FILE" ]]; then
    # Update iteration count and last run info
    jq --arg status "$STATUS" \
       --arg task "$TASK_DESCRIPTION" \
       --argjson iter "$ITERATION" \
       --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
       '.current_iteration = $iter | .last_task = $task | .last_status = $status | .last_run = $timestamp' \
       "$ORCH_FILE" > /tmp/orch.json && mv /tmp/orch.json "$ORCH_FILE"
    echo -e "${GREEN}✓ Updated orchestration.json${NC}"
fi

# Clean up context directory (optional - keep for debugging)
# rm -rf "$CONTEXT_DIR"

# Exit with appropriate code
if [[ "$STATUS" == "success" ]]; then
    exit 0
elif [[ "$STATUS" == "blocked" ]]; then
    exit 2
else
    exit 1
fi
