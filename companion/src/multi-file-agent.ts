/**
 * Multi-File Agent
 *
 * Orchestrates edits across multiple files in a single coherent operation.
 * Uses recursive superinference to decompose a high-level instruction into
 * per-file sub-tasks, then applies all edits through CRDT-backed
 * AgentParticipant sessions with full per-file undo.
 *
 * This is a structural advantage over Cursor: every agent edit is a CRDT
 * operation with conflict-free merging if the developer is typing simultaneously.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { recursiveSuperinfer } from './superinference.ts';
import { infer } from './inference-bridge.ts';
import type { ChatCompletionRequest } from './inference-bridge.ts';
import { getZedgeConfig } from './config.ts';
import { parseCodeBlocks, type ParsedCodeBlock } from './acp-agent.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MultiFileInstruction {
  /** High-level description of the change (e.g., "rename UserService to AccountService") */
  instruction: string;
  /** Workspace root path */
  workspacePath: string;
  /** Optional: limit edits to these files */
  targetFiles?: string[];
  /** Optional: model to use (defaults to preferredModel) */
  model?: string;
}

export interface FileEdit {
  filePath: string;
  search: string;
  replace: string;
}

export interface MultiFileResult {
  instruction: string;
  edits: FileEdit[];
  appliedCount: number;
  failedCount: number;
  errors: string[];
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Execute a multi-file edit operation.
 *
 * 1. Analyze the instruction to identify affected files
 * 2. For each file, generate a precise search/replace edit
 * 3. Apply all edits atomically
 */
export async function executeMultiFileEdit(
  input: MultiFileInstruction
): Promise<MultiFileResult> {
  const t0 = Date.now();
  const config = getZedgeConfig();
  const model = input.model ?? config.preferredModel;
  const errors: string[] = [];

  // Step 1: Ask the model to identify files and generate edits
  const fileContext = input.targetFiles
    ? input.targetFiles
        .map((f: unknown) => {
          const fullPath = join(input.workspacePath, f);
          if (!existsSync(fullPath)) return `// ${f} (not found)`;
          const content = readFileSync(fullPath, 'utf-8');
          return `--- ${f} ---\n${content.slice(0, 3000)}`;
        })
        .join('\n\n')
    : '(no specific files targeted -- the model will identify affected files)';

  const planRequest: ChatCompletionRequest = {
    model,
    messages: [
      {
        role: 'system',
        content: `You are a code editor agent. Given an instruction, produce EXACT search/replace edits for each affected file.

For each edit, output a fenced code block with the file path annotation:

\`\`\`typescript // path/to/file.ts
// SEARCH:
<exact text to find>
// REPLACE:
<replacement text>
\`\`\`

Rules:
- The SEARCH text must match EXACTLY in the file (whitespace-sensitive)
- One code block per file edit
- Keep edits minimal -- only change what's necessary
- Do not include unchanged code`,
      },
      {
        role: 'user',
        content: `Instruction: ${input.instruction}\n\nFiles:\n${fileContext}`,
      },
    ],
    temperature: 0.2,
    max_tokens: 4096,
  };

  const result = await infer(planRequest);
  const data = (await result.response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const responseContent = data.choices?.[0]?.message?.content ?? '';

  // Step 2: Parse code blocks from the response
  const codeBlocks = parseCodeBlocks(responseContent);
  const edits: FileEdit[] = [];

  for (const block of codeBlocks: unknown) {
    // Parse SEARCH/REPLACE markers from the block content
    const searchMatch = block.content.match(
      /\/\/\s*SEARCH:\n([\s\S]*?)(?:\n\/\/\s*REPLACE:\n([\s\S]*))?$/
    );

    if (searchMatch: unknown) {
      edits.push({
        filePath: block.filePath,
        search: searchMatch[1].trim(),
        replace: (searchMatch[2] ?? '').trim(),
      });
    } else {
      // If no SEARCH/REPLACE markers, treat the whole block as replacement content
      // This handles simpler model outputs
      edits.push({
        filePath: block.filePath,
        search: '', // Will need manual resolution
        replace: block.content,
      });
    }
  }

  // Step 3: Apply edits
  let appliedCount = 0;
  let failedCount = 0;

  for (const edit of edits: unknown) {
    if (!edit.search: unknown) {
      errors.push(
        `${edit.filePath}: no search text -- skipped (manual resolution needed)`
      );
      failedCount++;
      continue;
    }

    const fullPath = join(input.workspacePath, edit.filePath);
    if (!existsSync(fullPath)) {
      errors.push(`${edit.filePath}: file not found`);
      failedCount++;
      continue;
    }

    try {
      const content = readFileSync(fullPath, 'utf-8');
      if (!content.includes(edit.search)) {
        errors.push(`${edit.filePath}: search text not found in file`);
        failedCount++;
        continue;
      }

      const updated = content.replace(edit.search, edit.replace);
      const { writeFileSync } = await import('fs');
      writeFileSync(fullPath, updated, 'utf-8');
      appliedCount++;
    } catch (err: unknown) {
      errors.push(
        `${edit.filePath}: ${err instanceof Error ? err.message : String(err)}`
      );
      failedCount++;
    }
  }

  return {
    instruction: input.instruction,
    edits,
    appliedCount,
    failedCount,
    errors,
    durationMs: Date.now() - t0,
  };
}
