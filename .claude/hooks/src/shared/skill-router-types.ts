/**
 * Shared type definitions for Skill Router hook.
 *
 * These types are used across phases of the self-improving skill system:
 * - Phase 2: Basic types and lookup stub
 * - Phase 3: Skill matching (keywords)
 * - Phase 4: Intent pattern matching
 * - Phase 5-6: Memory integration
 * - Phase 7+: JIT skill generation
 *
 * Plan: thoughts/shared/plans/self-improving-skill-system.md
 */

// =============================================================================
// Hook Input/Output Types
// =============================================================================

/**
 * Input from UserPromptSubmit hook event.
 * Contains the user's prompt and session context.
 *
 * Note: Fields are optional to support graceful degradation
 * when input is malformed or incomplete.
 */
export interface SkillRouterInput {
  session_id?: string;
  prompt?: string;
  // Additional fields from UserPromptSubmit event
  cwd?: string;
  conversation_id?: string;
}

/**
 * Output for hook response.
 * Returns continue/block with optional system message.
 */
export interface SkillRouterOutput {
  result: 'continue' | 'block';
  message?: string;
}

// =============================================================================
// Skill Lookup Types
// =============================================================================

/**
 * Result from skill lookup operation.
 * Used to determine if a matching skill was found.
 */
export interface SkillLookupResult {
  /** Whether a matching skill was found */
  found: boolean;
  /** Name of the matched skill (if found) */
  skillName?: string;
  /** Path to the skill's SKILL.md file (if found) */
  skillPath?: string;
  /** Confidence score 0-1 (higher = better match) */
  confidence: number;
  /** Source of the match: 'keyword', 'intent', 'memory', 'jit' */
  source?: 'keyword' | 'intent' | 'memory' | 'jit';

  // NEW: Enhanced lookup result fields
  /** Prerequisite resolution result */
  prerequisites?: {
    suggest: string[];
    require: string[];
    loadOrder: string[];  // Topologically sorted
  };
  /** Co-activation resolution result */
  coActivation?: {
    peers: string[];
    mode: 'all' | 'any';
  };
  /** Loading mode for this skill */
  loading?: 'lazy' | 'eager' | 'eager-prerequisites';
}

// =============================================================================
// Router API Types
// =============================================================================

/** Input to the route() API */
export interface SkillRouterAPIInput {
  task: string;
  context?: string;
  files?: string[];
  current_pattern?: string;
  exclude_agents?: string[];
  cwd?: string;
}

/** Output from route() API */
export interface SkillRouterAPIOutput {
  skills: SkillRouterMatch[];
  agents: AgentRouterMatch[];
  complexity_score: number;
  recommended_pattern: OrchestrationPattern | null;
  llm_assisted: boolean;
  greenfield_score: number;
}

/** A matched skill from prompt/file analysis */
export interface SkillRouterMatch {
  name: string;
  enforcement: string;
  priority: string;
  confidence: number;
  reason: string;
  match_type: 'keyword' | 'intent' | 'file_type' | 'llm_assist';
}

/** A matched agent from prompt analysis */
export interface AgentRouterMatch {
  name: string;
  type: string;
  confidence: number;
  reason: string;
}

/** Orchestration pattern type */
export type OrchestrationPattern =
  | 'swarm'
  | 'hierarchical'
  | 'pipeline'
  | 'generator_critic'
  | 'adversarial'
  | 'map_reduce'
  | 'jury'
  | 'blackboard'
  | 'chain_of_responsibility'
  | 'event_driven'
  | 'circuit_breaker';

/** Complexity scoring result */
export interface ComplexityScore {
  total: number;
  prompt_score: number;
  file_score: number;
  prompt_signals: PromptSignal[];
  file_signals: FileSignal[];
  action: 'proceed' | 'suggest_workflow' | 'force_workflow';
}

/** Signal detected from prompt analysis */
export interface PromptSignal {
  name: string;
  weight: number;
  detected: boolean;
  detail: string;
}

/** Signal detected from file analysis */
export interface FileSignal {
  name: string;
  weight: number;
  value: number;
}

// =============================================================================
// Error Types
// =============================================================================

/**
 * Error thrown when a circular dependency is detected in skill prerequisites.
 */
export class CircularDependencyError extends Error {
  constructor(public readonly cyclePath: string[]) {
    super(`Circular dependency detected: ${cyclePath.join(' -> ')}`);
    this.name = 'CircularDependencyError';
  }
}

// =============================================================================
// Skill Rules Types (for Phase 3+)
// =============================================================================

/**
 * Trigger configuration for a skill.
 * Defines how prompts are matched to skills.
 */
export interface SkillTrigger {
  keywords?: string[];
  intentPatterns?: string[];
}

/**
 * Single skill entry in skill-rules.json.
 */
export interface SkillRule {
  type?: 'domain' | 'workflow' | 'meta' | 'process' | 'exploration' | 'research' | 'planning' | 'validation' | 'debugging' | 'development';
  enforcement?: 'suggest' | 'require' | 'auto' | 'block' | 'warn';
  priority?: 'low' | 'medium' | 'high' | 'critical';
  description?: string;
  promptTriggers?: SkillTrigger;
  reminder?: string;

  // NEW: Prerequisites (vertical chain)
  prerequisites?: {
    suggest?: string[];   // Suggest before loading this skill
    require?: string[];   // Must be loaded before this skill
  };

  // NEW: Co-activation (horizontal chain)
  coActivate?: string[];          // Peers to activate together
  coActivateMode?: 'all' | 'any'; // all = activate all peers, any = suggest peers

  // NEW: Loading mode
  loading?: 'lazy' | 'eager' | 'eager-prerequisites';
}

/**
 * Complete skill-rules.json structure.
 */
export interface SkillRulesConfig {
  version?: string;
  description?: string;
  skills: Record<string, SkillRule>;
  agents?: Record<string, SkillRule>;
  notes?: Record<string, unknown>;
}
