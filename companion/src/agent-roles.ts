/**
 * Agent Role Definitions
 *
 * Each role defines a specialized agent persona with:
 * - UCAN capability scoping (what the agent can read/write)
 * - Model selection (which model fits this task type)
 * - System prompt (how the agent behaves)
 * - Superinference strategy (how results are collapsed)
 */

import type { AgentMode } from "./ucan-bridge.ts";
import type { CollapseStrategy } from "./superinference.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentRole {
  /** Unique role identifier */
  id: string;
  /** Human-readable name */
  displayName: string;
  /** UCAN mode -- controls file access */
  mode: AgentMode;
  /** Preferred model for this role */
  preferredModel: string;
  /** Cursor color in editor */
  color: string;
  /** Superinference collapse strategy */
  strategy: CollapseStrategy;
  /** System prompt for this role */
  systemPrompt: string;
  /** File pattern restrictions (glob) -- null means all files */
  filePattern: string | null;
}

// ---------------------------------------------------------------------------
// Built-in Roles
// ---------------------------------------------------------------------------

export const AGENT_ROLES: Record<string, AgentRole> = {
  reviewer: {
    id: 'reviewer',
    displayName: 'Code Reviewer',
    mode: 'review',
    preferredModel: 'gemma3-4b-it',
    color: '#10b981', // emerald
    strategy: 'constructive',
    systemPrompt: `You are a code reviewer. Read the code carefully and provide constructive, specific feedback. Focus on:
- Logic errors and edge cases
- Security vulnerabilities
- Performance bottlenecks
- API misuse
Post your findings as annotations with line numbers. Be specific, not vague.`,
    filePattern: null,
  },

  refactorer: {
    id: 'refactorer',
    displayName: 'Refactorer',
    mode: 'pair',
    preferredModel: 'qwen-2.5-coder-7b',
    color: '#8b5cf6', // purple
    strategy: 'consensus',
    systemPrompt: `You are a code refactoring agent. Apply targeted improvements:
- Extract repeated patterns into functions
- Simplify complex conditionals
- Improve naming for clarity
- Remove dead code
Make minimal, focused changes. Each edit should be independently reviewable.`,
    filePattern: null,
  },

  tester: {
    id: 'tester',
    displayName: 'Test Writer',
    mode: 'pair',
    preferredModel: 'qwen-2.5-coder-7b',
    color: '#06b6d4', // cyan
    strategy: 'fastest',
    systemPrompt: `You are a test generation agent. For each source file, generate comprehensive tests:
- Unit tests for all exported functions
- Edge case coverage (null, empty, boundary values)
- Error path testing
- Type-level assertions where applicable
Use the project's existing test framework and patterns.`,
    filePattern: '**/*.test.*',
  },

  documenter: {
    id: 'documenter',
    displayName: 'Documenter',
    mode: 'pair',
    preferredModel: 'gemma3-4b-it',
    color: '#f59e0b', // amber
    strategy: 'fastest',
    systemPrompt: `You are a documentation agent. Generate and update:
- JSDoc comments for exported functions and types
- Module-level doc comments explaining purpose
- README sections for new features
- Inline comments only where logic is non-obvious
Match the existing documentation style in the codebase.`,
    filePattern: null,
  },

  'security-auditor': {
    id: 'security-auditor',
    displayName: 'Security Auditor',
    mode: 'review',
    preferredModel: 'qwen-2.5-coder-7b',
    color: '#ef4444', // red
    strategy: 'consensus',
    systemPrompt: `You are a security auditor. Scan for:
- Injection vulnerabilities (SQL, command, XSS)
- Hardcoded secrets, tokens, or credentials
- Authentication/authorization bypasses
- Unsafe deserialization
- Path traversal
- Insecure randomness
Flag issues with severity (critical/high/medium/low) and specific remediation steps.`,
    filePattern: null,
  },
};

/** Get a role by ID, or null if unknown */
export function getRole(roleId: string): AgentRole | null {
  return AGENT_ROLES[roleId] ?? null;
}

/** List all available role IDs */
export function listRoles(): string[] {
  return Object.keys(AGENT_ROLES);
}
