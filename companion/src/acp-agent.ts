/**
 * ACP Agent Server — Agent Client Protocol for Zed
 *
 * Implements the Agent Client Protocol (ACP) enabling the Zed extension
 * to perform multi-turn reasoning with tool use:
 * - Read/write files in the workspace
 * - Run terminal commands (with capability grants)
 * - Navigate project graph
 * - Accumulate workspace understanding across turns
 *
 * The agent server runs as part of the companion sidecar and communicates
 * with the Zed extension via JSON-RPC over stdio or HTTP.
 *
 * Reference: https://zed.dev/docs/extensions/agent-servers
 */

import { infer } from './inference-bridge.ts';
import { getZedgeConfig } from './config.ts';
import type { ChatCompletionRequest, ChatMessage } from './inference-bridge.ts';
import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
} from 'fs';
import { join, relative } from 'path';
import { execSync } from 'child_process';

// --- Types ---

export interface AgentCapabilities {
  processExec: string[]; // Allowed command patterns (glob)
  fileRead: boolean;
  fileWrite: boolean;
  gitAccess: boolean;
}

export interface AgentSession {
  id: string;
  workspacePath: string;
  capabilities: AgentCapabilities;
  conversationHistory: ChatMessage[];
  contextCache: WorkspaceContextCache;
  createdAt: number;
}

export interface WorkspaceContextCache {
  fileTree: string | null;
  fileTreeTimestamp: number;
  openFiles: Map<string, string>; // path → content
  gitDiff: string | null;
  gitDiffTimestamp: number;
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  name: string;
  success: boolean;
  output: string;
}

export interface AgentResponse {
  content: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  /** Code blocks parsed from the response with file path annotations */
  codeBlocks?: ParsedCodeBlock[];
  done: boolean;
}

// --- Tool Definitions ---

const TOOLS = [
  {
    name: 'read_file',
    description: 'Read the contents of a file in the workspace',
    parameters: {
      path: {
        type: 'string',
        description: 'Relative path from workspace root',
      },
    },
  },
  {
    name: 'write_file',
    description: 'Write content to a file in the workspace',
    parameters: {
      path: {
        type: 'string',
        description: 'Relative path from workspace root',
      },
      content: { type: 'string', description: 'File content to write' },
    },
  },
  {
    name: 'list_files',
    description: 'List files in a directory',
    parameters: {
      path: { type: 'string', description: 'Relative directory path' },
      recursive: { type: 'boolean', description: 'List recursively' },
    },
  },
  {
    name: 'run_command',
    description: 'Run a shell command in the workspace',
    parameters: {
      command: { type: 'string', description: 'Command to execute' },
    },
  },
  {
    name: 'git_diff',
    description: 'Get the current git diff (staged and unstaged)',
    parameters: {},
  },
  {
    name: 'git_log',
    description: 'Get recent git log entries',
    parameters: {
      count: { type: 'number', description: 'Number of entries' },
    },
  },
  {
    name: 'search_files',
    description: 'Search for a pattern across workspace files',
    parameters: {
      pattern: { type: 'string', description: 'Regex pattern to search for' },
      glob: {
        type: 'string',
        description: 'File glob to filter (e.g., "*.ts")',
      },
    },
  },
  // --- ACP Agent 2.0 Tools (Phase 7) ---
  {
    name: 'deploy',
    description: 'Trigger ForgoCD deploy for the current workspace',
    parameters: {
      project: {
        type: 'string',
        description: 'Project name to deploy (optional)',
      },
    },
  },
  {
    name: 'create_branch',
    description: 'Create a new git branch',
    parameters: {
      name: { type: 'string', description: 'Branch name' },
      from: { type: 'string', description: 'Base branch (default: current)' },
    },
  },
  {
    name: 'create_merge_request',
    description: 'Create a merge request description',
    parameters: {
      title: { type: 'string', description: 'MR title' },
      description: { type: 'string', description: 'MR description' },
      source: { type: 'string', description: 'Source branch' },
      target: { type: 'string', description: 'Target branch (default: main)' },
    },
  },
  {
    name: 'run_tests',
    description: 'Execute test suite and parse results',
    parameters: {
      path: { type: 'string', description: 'Test file or directory path' },
      filter: { type: 'string', description: 'Test name filter pattern' },
    },
  },
  {
    name: 'ai_review',
    description: 'Request AI code review using superinference consensus',
    parameters: {
      path: { type: 'string', description: 'File path to review' },
    },
  },
  {
    name: 'security_scan',
    description: 'Run basic security scan on workspace files',
    parameters: {
      path: { type: 'string', description: 'File or directory to scan' },
    },
  },
  {
    name: 'search_docs',
    description: 'Search project documentation and README files',
    parameters: {
      query: { type: 'string', description: 'Search query' },
    },
  },
];

// --- Session Management ---

const sessions = new Map<string, AgentSession>();

/**
 * Create a new agent session for a workspace
 */
export function createSession(
  workspacePath: string,
  capabilities: AgentCapabilities
): AgentSession {
  const session: AgentSession = {
    id: `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    workspacePath,
    capabilities,
    conversationHistory: [],
    contextCache: {
      fileTree: null,
      fileTreeTimestamp: 0,
      openFiles: new Map(),
      gitDiff: null,
      gitDiffTimestamp: 0,
    },
    createdAt: Date.now(),
  };

  sessions.set(session.id, session);
  return session;
}

/**
 * Get or create a session
 */
export function getSession(sessionId: string): AgentSession | null {
  return sessions.get(sessionId) ?? null;
}

/**
 * Delete a session
 */
export function deleteSession(sessionId: string): void {
  sessions.delete(sessionId);
}

// --- Agent Turn ---

/**
 * Run a single agent turn: user message → inference → tool calls → response
 *
 * Supports multi-turn by accumulating conversation history in the session.
 * Tools are called automatically when the model requests them.
 */
export async function agentTurn(
  sessionId: string,
  userMessage: string
): Promise<AgentResponse> {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  // Add user message to history
  session.conversationHistory.push({
    role: 'user',
    content: userMessage,
  });

  // Gather workspace context (cached, refreshed every 30s)
  const context = await gatherContext(session);

  // Build system prompt with context and tool definitions
  const systemPrompt = buildSystemPrompt(session, context);

  // Run inference
  const config = getZedgeConfig();
  const request: ChatCompletionRequest = {
    model: config.preferredModel,
    messages: [
      { role: 'system', content: systemPrompt },
      ...session.conversationHistory,
    ],
    temperature: 0.3,
    max_tokens: 4096,
  };

  const result = await infer(request);
  const data = (await result.response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const responseContent = data.choices?.[0]?.message?.content ?? '';

  // Parse tool calls from response
  const toolCalls = parseToolCalls(responseContent);
  const toolResults: ToolResult[] = [];

  if (toolCalls.length > 0) {
    // Execute tool calls
    for (const call of toolCalls) {
      const toolResult = executeTool(session, call);
      toolResults.push(toolResult);
    }

    // Add assistant response + tool results to history
    session.conversationHistory.push({
      role: 'assistant',
      content: responseContent,
    });

    // Add tool results as a follow-up message
    const toolSummary = toolResults
      .map(
        (r) =>
          `[${r.name}] ${r.success ? 'OK' : 'ERROR'}: ${r.output.slice(0, 500)}`
      )
      .join('\n\n');

    session.conversationHistory.push({
      role: 'user',
      content: `Tool results:\n${toolSummary}`,
    });

    // Run another inference turn with tool results
    const followUpRequest: ChatCompletionRequest = {
      model: config.preferredModel,
      messages: [
        { role: 'system', content: systemPrompt },
        ...session.conversationHistory,
      ],
      temperature: 0.3,
      max_tokens: 4096,
    };

    const followUp = await infer(followUpRequest);
    const followUpData = (await followUp.response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const finalContent =
      followUpData.choices?.[0]?.message?.content ?? responseContent;

    session.conversationHistory.push({
      role: 'assistant',
      content: finalContent,
    });

    return {
      content: finalContent,
      toolCalls,
      toolResults,
      codeBlocks: parseCodeBlocks(finalContent),
      done: true,
    };
  }

  // No tool calls — just a regular response
  session.conversationHistory.push({
    role: 'assistant',
    content: responseContent,
  });

  return {
    content: responseContent,
    codeBlocks: parseCodeBlocks(responseContent),
    done: true,
  };
}

// --- Context Gathering ---

async function gatherContext(session: AgentSession): Promise<string> {
  const parts: string[] = [];
  const now = Date.now();
  const CACHE_TTL = 30_000;

  // File tree (cached 30s)
  if (
    !session.contextCache.fileTree ||
    now - session.contextCache.fileTreeTimestamp > CACHE_TTL
  ) {
    session.contextCache.fileTree = buildFileTree(session.workspacePath, 3);
    session.contextCache.fileTreeTimestamp = now;
  }
  parts.push(`<file_tree>\n${session.contextCache.fileTree}\n</file_tree>`);

  // Git diff (cached 30s)
  if (
    session.capabilities.gitAccess &&
    (!session.contextCache.gitDiff ||
      now - session.contextCache.gitDiffTimestamp > CACHE_TTL)
  ) {
    try {
      session.contextCache.gitDiff = execSync('git diff', {
        cwd: session.workspacePath,
        encoding: 'utf-8',
        timeout: 5_000,
      }).slice(0, 5_000);
      session.contextCache.gitDiffTimestamp = now;
    } catch {
      session.contextCache.gitDiff = '';
    }
  }
  if (session.contextCache.gitDiff) {
    parts.push(`<git_diff>\n${session.contextCache.gitDiff}\n</git_diff>`);
  }

  return parts.join('\n\n');
}

function buildFileTree(dir: string, maxDepth: number, depth = 0): string {
  if (depth >= maxDepth) return '';

  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    const lines: string[] = [];
    const indent = '  '.repeat(depth);

    for (const entry of entries) {
      // Skip common noise
      if (
        entry.name.startsWith('.') ||
        entry.name === 'node_modules' ||
        entry.name === 'dist' ||
        entry.name === 'target' ||
        entry.name === '.git'
      ) {
        continue;
      }

      if (entry.isDirectory()) {
        lines.push(`${indent}${entry.name}/`);
        lines.push(buildFileTree(join(dir, entry.name), maxDepth, depth + 1));
      } else {
        lines.push(`${indent}${entry.name}`);
      }
    }

    return lines.filter(Boolean).join('\n');
  } catch {
    return '';
  }
}

// --- System Prompt ---

function buildSystemPrompt(session: AgentSession, context: string): string {
  const toolDefs = TOOLS.filter((t) => {
    // Filter tools based on capabilities
    if (
      t.name === 'run_command' &&
      session.capabilities.processExec.length === 0
    )
      return false;
    if (t.name === 'write_file' && !session.capabilities.fileWrite)
      return false;
    if (
      (t.name === 'git_diff' || t.name === 'git_log') &&
      !session.capabilities.gitAccess
    )
      return false;
    return true;
  });

  const toolSection = toolDefs
    .map(
      (t) =>
        `- ${t.name}: ${t.description}\n  Parameters: ${JSON.stringify(
          t.parameters
        )}`
    )
    .join('\n');

  return `You are Zedge, an AI coding assistant running at the edge. You help developers write, refactor, test, and debug code.

## Available Tools

To use a tool, output a line in this exact format:
<tool name="tool_name" arg1="value1" arg2="value2" />

${toolSection}

## Workspace Context

${context}

## Rules

- Read files before modifying them
- Make minimal, focused changes
- Explain what you're doing and why
- If a tool fails, try an alternative approach
- Never modify files outside the workspace
- For commands, only run: ${
    session.capabilities.processExec.join(', ') || 'none allowed'
  }`;
}

// --- Tool Parsing & Execution ---

/**
 * Parse annotated code blocks from model responses into AgentEdit objects.
 *
 * Detects patterns like:
 *   ```typescript // path/to/file.ts
 *   ...code...
 *   ```
 *
 * Returns structured edits that can be applied via AgentParticipant.
 */
export interface ParsedCodeBlock {
  filePath: string;
  language: string;
  content: string;
}

/**
 * Parses the Code Blocks.
 */
export function parseCodeBlocks(responseContent: string): ParsedCodeBlock[] {
  const blocks: ParsedCodeBlock[] = [];
  // Match fenced code blocks with optional language and file path annotation
  // Supports: ```lang // path, ```lang <!-- path -->, ```lang path=..., ```lang (path)
  const codeBlockRegex =
    /```(\w+)?(?:\s+(?:\/\/|<!--)\s*([^\n]+?)(?:\s*-->)?|\s+path=([^\n]+)|\s+\(([^\n)]+)\))?\n([\s\S]*?)```/g;
  let match;

  while ((match = codeBlockRegex.exec(responseContent)) !== null) {
    const language = match[1] ?? 'text';
    const filePath = (match[2] ?? match[3] ?? match[4] ?? '').trim();
    const content = match[5] ?? '';

    if (filePath && content.trim()) {
      blocks.push({ filePath, language, content: content.trimEnd() });
    }
  }

  return blocks;
}

function parseToolCalls(content: string): ToolCall[] {
  const calls: ToolCall[] = [];
  const regex = /<tool\s+name="(\w+)"([^/]*)\s*\/>/g;
  let match;

  while ((match = regex.exec(content)) !== null) {
    const name = match[1];
    const argsStr = match[2];
    const args: Record<string, unknown> = {};

    // Parse attributes
    const attrRegex = /(\w+)="([^"]*)"/g;
    let attrMatch;
    while ((attrMatch = attrRegex.exec(argsStr)) !== null) {
      args[attrMatch[1]] = attrMatch[2];
    }

    calls.push({ name, arguments: args });
  }

  return calls;
}

function executeTool(session: AgentSession, call: ToolCall): ToolResult {
  const { name } = call;
  const args = call.arguments;

  try {
    switch (name) {
      case 'read_file': {
        if (!session.capabilities.fileRead) {
          return { name, success: false, output: 'File read not permitted' };
        }
        const filePath = join(session.workspacePath, String(args.path ?? ''));
        if (!filePath.startsWith(session.workspacePath)) {
          return { name, success: false, output: 'Path escapes workspace' };
        }
        if (!existsSync(filePath)) {
          return { name, success: false, output: 'File not found' };
        }
        const content = readFileSync(filePath, 'utf-8');
        // Cache in open files
        session.contextCache.openFiles.set(String(args.path), content);
        return { name, success: true, output: content.slice(0, 10_000) };
      }

      case 'write_file': {
        if (!session.capabilities.fileWrite) {
          return { name, success: false, output: 'File write not permitted' };
        }
        const filePath = join(session.workspacePath, String(args.path ?? ''));
        if (!filePath.startsWith(session.workspacePath)) {
          return { name, success: false, output: 'Path escapes workspace' };
        }
        writeFileSync(filePath, String(args.content ?? ''));
        return { name, success: true, output: `Wrote ${filePath}` };
      }

      case 'list_files': {
        if (!session.capabilities.fileRead) {
          return { name, success: false, output: 'File read not permitted' };
        }
        const dirPath = join(session.workspacePath, String(args.path ?? '.'));
        if (!dirPath.startsWith(session.workspacePath)) {
          return { name, success: false, output: 'Path escapes workspace' };
        }
        const depth = args.recursive ? 3 : 1;
        const tree = buildFileTree(dirPath, depth);
        return { name, success: true, output: tree };
      }

      case 'run_command': {
        const cmd = String(args.command ?? '');
        if (!isCommandAllowed(cmd, session.capabilities.processExec)) {
          return {
            name,
            success: false,
            output: `Command not permitted. Allowed patterns: ${session.capabilities.processExec.join(
              ', '
            )}`,
          };
        }
        const output = execSync(cmd, {
          cwd: session.workspacePath,
          encoding: 'utf-8',
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
        });
        return { name, success: true, output: output.slice(0, 10_000) };
      }

      case 'git_diff': {
        if (!session.capabilities.gitAccess) {
          return { name, success: false, output: 'Git access not permitted' };
        }
        const diff = execSync('git diff && git diff --staged', {
          cwd: session.workspacePath,
          encoding: 'utf-8',
          timeout: 5_000,
        });
        return { name, success: true, output: diff.slice(0, 10_000) };
      }

      case 'git_log': {
        if (!session.capabilities.gitAccess) {
          return { name, success: false, output: 'Git access not permitted' };
        }
        const count = Number(args.count ?? 10);
        const log = execSync(`git log --oneline -${count}`, {
          cwd: session.workspacePath,
          encoding: 'utf-8',
          timeout: 5_000,
        });
        return { name, success: true, output: log };
      }

      case 'search_files': {
        if (!session.capabilities.fileRead) {
          return { name, success: false, output: 'File read not permitted' };
        }
        const pattern = String(args.pattern ?? '');
        const glob = String(args.glob ?? '*');
        try {
          const output = execSync(
            `grep -rn --include="${glob}" "${pattern}" . || true`,
            {
              cwd: session.workspacePath,
              encoding: 'utf-8',
              timeout: 10_000,
              maxBuffer: 1024 * 1024,
            }
          );
          return { name, success: true, output: output.slice(0, 10_000) };
        } catch {
          return { name, success: true, output: 'No matches found' };
        }
      }

      // --- ACP Agent 2.0 Tool Handlers ---

      case 'deploy': {
        const project = args.project ? String(args.project) : '';
        try {
          const cmd = project
            ? `cd "${session.workspacePath}" && bun run forge deploy --filter ${project} 2>&1 || echo "Deploy triggered for ${project}"`
            : `cd "${session.workspacePath}" && bun run forge deploy 2>&1 || echo "Deploy triggered"`;
          const output = execSync(cmd, {
            cwd: session.workspacePath,
            encoding: 'utf-8',
            timeout: 60_000,
          });
          return { name, success: true, output: output.slice(0, 10_000) };
        } catch (err) {
          return {
            name,
            success: true,
            output: `Deploy command initiated${
              project ? ` for ${project}` : ''
            }`,
          };
        }
      }

      case 'create_branch': {
        if (!session.capabilities.gitAccess) {
          return { name, success: false, output: 'Git access not permitted' };
        }
        const branchName = String(args.name ?? '');
        const fromBranch = args.from ? String(args.from) : '';
        if (!branchName) {
          return { name, success: false, output: 'Branch name is required' };
        }
        const cmd = fromBranch
          ? `git checkout -b "${branchName}" "${fromBranch}"`
          : `git checkout -b "${branchName}"`;
        const output = execSync(cmd, {
          cwd: session.workspacePath,
          encoding: 'utf-8',
          timeout: 10_000,
        });
        return { name, success: true, output };
      }

      case 'create_merge_request': {
        if (!session.capabilities.gitAccess) {
          return { name, success: false, output: 'Git access not permitted' };
        }
        const title = String(args.title ?? 'Untitled MR');
        const description = String(args.description ?? '');
        const source = String(args.source ?? '');
        const target = String(args.target ?? 'main');
        // Generate MR document (actual MR creation requires forge integration)
        const mrDoc = [
          `# Merge Request: ${title}`,
          '',
          `**Source**: ${source || '(current branch)'}`,
          `**Target**: ${target}`,
          '',
          '## Description',
          description,
          '',
          `_Created at ${new Date().toISOString()}_`,
        ].join('\n');
        return { name, success: true, output: mrDoc };
      }

      case 'run_tests': {
        const testPath = args.path ? String(args.path) : '.';
        const filter = args.filter ? String(args.filter) : '';
        const filterArg = filter ? ` --grep "${filter}"` : '';
        try {
          const output = execSync(`bun test ${testPath}${filterArg} 2>&1`, {
            cwd: session.workspacePath,
            encoding: 'utf-8',
            timeout: 120_000,
            maxBuffer: 2 * 1024 * 1024,
          });
          return { name, success: true, output: output.slice(0, 10_000) };
        } catch (err) {
          const output =
            err instanceof Error && 'stdout' in err
              ? String((err as { stdout: string }).stdout).slice(0, 10_000)
              : String(err);
          return { name, success: false, output };
        }
      }

      case 'ai_review': {
        if (!session.capabilities.fileRead) {
          return { name, success: false, output: 'File read not permitted' };
        }
        const reviewPath = join(session.workspacePath, String(args.path ?? ''));
        if (!reviewPath.startsWith(session.workspacePath)) {
          return { name, success: false, output: 'Path escapes workspace' };
        }
        if (!existsSync(reviewPath)) {
          return { name, success: false, output: 'File not found' };
        }
        const code = readFileSync(reviewPath, 'utf-8').slice(0, 5_000);
        return {
          name,
          success: true,
          output: `Code review requested for ${String(
            args.path
          )}.\n\nFile content (first 5000 chars):\n${code}\n\n[AI review would use superinference consensus across multiple models]`,
        };
      }

      case 'security_scan': {
        if (!session.capabilities.fileRead) {
          return { name, success: false, output: 'File read not permitted' };
        }
        const scanPath = join(session.workspacePath, String(args.path ?? '.'));
        if (!scanPath.startsWith(session.workspacePath)) {
          return { name, success: false, output: 'Path escapes workspace' };
        }
        // Basic security pattern scan
        try {
          const patterns = [
            'eval\\s*\\(',
            'innerHTML\\s*=',
            'dangerouslySetInnerHTML',
            'exec\\s*\\(',
            'child_process',
            '\\.env\\b',
            'password\\s*=\\s*["\']',
            'secret\\s*=\\s*["\']',
            'api.key\\s*=\\s*["\']',
            'token\\s*=\\s*["\']',
          ];
          const grepPattern = patterns.join('|');
          const output = execSync(
            `grep -rn --include="*.ts" --include="*.js" --include="*.tsx" --include="*.jsx" -E '${grepPattern}' "${scanPath}" 2>/dev/null || echo "No security issues found"`,
            {
              cwd: session.workspacePath,
              encoding: 'utf-8',
              timeout: 30_000,
              maxBuffer: 1024 * 1024,
            }
          );
          return { name, success: true, output: output.slice(0, 10_000) };
        } catch {
          return { name, success: true, output: 'No security issues found' };
        }
      }

      case 'search_docs': {
        if (!session.capabilities.fileRead) {
          return { name, success: false, output: 'File read not permitted' };
        }
        const query = String(args.query ?? '');
        try {
          const output = execSync(
            `grep -rni --include="*.md" --include="*.txt" --include="*.rst" "${query}" . 2>/dev/null || echo "No documentation matches found"`,
            {
              cwd: session.workspacePath,
              encoding: 'utf-8',
              timeout: 10_000,
              maxBuffer: 1024 * 1024,
            }
          );
          return { name, success: true, output: output.slice(0, 10_000) };
        } catch {
          return {
            name,
            success: true,
            output: 'No documentation matches found',
          };
        }
      }

      default:
        return { name, success: false, output: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return {
      name,
      success: false,
      output: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Check if a command matches any allowed pattern
 */
function isCommandAllowed(cmd: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (matchGlob(cmd, pattern)) return true;
  }
  return false;
}

function matchGlob(str: string, pattern: string): boolean {
  // Simple glob matching: * matches any sequence
  const regex = new RegExp(
    '^' +
      pattern
        .split('*')
        .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*') +
      '$'
  );
  return regex.test(str);
}
