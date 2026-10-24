import { getKnownZedgeModel } from './model-catalog.ts';

export interface PromptBudgetMessage {
  role: string;
  content: string;
}

const SMALL_MODEL_MAX_TOKENS = 2048;
const SMALL_MODEL_SYSTEM_PROMPT_MAX_CHARS = 900;
const DEFAULT_SYSTEM_PROMPT_MAX_CHARS = 2000;
const HEAVY_SYSTEM_CONTEXT_MARKERS = ['<codebase_context>', '<agent_memory>'];
const COMPACT_CONVERSATION_MODELS = new Set([
  'rwkv7-mini',
  'rwkv7-2.9b',
  'qwen2.5-0.5b-instruct',
  'tinyllama-1.1b',
  'smollm2-360m',
  'deepseek-r1-1.5b',
  'mamba-2.8b',
  'falcon-mamba-7b',
]);
const REFERENTIAL_USER_TURN =
  /\b(it|its|they|them|their|this|that|these|those|former|latter|above|previous)\b/i;
const DIRECT_REPLY_PREFIX = 'Reply directly and briefly to the user message:';

const COMPACT_SYSTEM_PROMPT = [
  'You are a concise coding assistant for the Forkjoin.ai monorepo.',
  'Read code, tests, and errors before editing.',
  'Prefer `pnpm run a0 -- ...` and `pnpm run gnode -- ...` over raw tools when possible.',
  'Keep verification scoped to the files you touched.',
  'Do not add paid AI services.',
].join(' ');

function replaceSystemMessages(
  messages: PromptBudgetMessage[],
  replacement: string
): PromptBudgetMessage[] {
  const compacted: PromptBudgetMessage[] = [];
  let inserted = false;

  for (const message of messages) {
    if (message.role === 'system') {
      if (!inserted) {
        compacted.push({ role: 'system', content: replacement });
        inserted = true;
      }
      continue;
    }
    compacted.push(message);
  }

  return compacted;
}

function dropSystemMessages(
  messages: PromptBudgetMessage[]
): PromptBudgetMessage[] {
  return messages.filter((message) => message.role !== 'system');
}

function totalSystemChars(messages: PromptBudgetMessage[]): number {
  return messages.reduce(
    (sum, message) =>
      message.role === 'system' ? sum + message.content.length : sum,
    0
  );
}

function hasHeavySystemContext(messages: PromptBudgetMessage[]): boolean {
  return messages.some(
    (message) =>
      message.role === 'system' &&
      HEAVY_SYSTEM_CONTEXT_MARKERS.some((marker) =>
        message.content.includes(marker)
      )
  );
}

/**
 * Handles the zedge get Compact System Prompt workflow.
 */
export function getCompactSystemPrompt(): string {
  return COMPACT_SYSTEM_PROMPT;
}

/**
 * Handles the zedge should Skip Heavy System Context workflow.
 */
export function shouldSkipHeavySystemContext(modelId: string): boolean {
  if (modelId.startsWith('wasm-local')) {
    return true;
  }

  const knownModel = getKnownZedgeModel(modelId);
  return (
    (knownModel?.maxTokens ?? Number.POSITIVE_INFINITY) <=
    SMALL_MODEL_MAX_TOKENS
  );
}

/** Keep instruction-fragile SSM/small-model prompts focused on this turn. */
export function applyConversationPromptBudget(
  modelId: string,
  messages: PromptBudgetMessage[]
): PromptBudgetMessage[] {
  if (!COMPACT_CONVERSATION_MODELS.has(modelId.toLowerCase())) {
    return messages;
  }

  const latestUserIndex = messages.findLastIndex(
    (message) => message.role === 'user' && message.content.trim().length > 0
  );
  if (latestUserIndex < 0) return messages;

  const latestUser = messages[latestUserIndex]!;
  const framedUser = {
    ...latestUser,
    content: `${DIRECT_REPLY_PREFIX}\n\n${latestUser.content}`,
  };
  if (!REFERENTIAL_USER_TURN.test(latestUser.content)) {
    return [framedUser];
  }

  for (let index = latestUserIndex - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === 'assistant' && message.content.trim().length > 0) {
      return [message, framedUser];
    }
  }
  return [framedUser];
}

/**
 * Handles the zedge apply System Prompt Budget workflow.
 */
export function applySystemPromptBudget(
  modelId: string,
  messages: PromptBudgetMessage[]
): PromptBudgetMessage[] {
  const systemMessageCount = messages.filter(
    (message) => message.role === 'system'
  ).length;

  if (systemMessageCount === 0) {
    return messages;
  }

  if (modelId.startsWith('wasm-local')) {
    return dropSystemMessages(messages);
  }

  const systemChars = totalSystemChars(messages);

  if (shouldSkipHeavySystemContext(modelId)) {
    const needsCompaction =
      systemMessageCount > 1 ||
      systemChars > SMALL_MODEL_SYSTEM_PROMPT_MAX_CHARS ||
      hasHeavySystemContext(messages);
    return needsCompaction
      ? replaceSystemMessages(messages, COMPACT_SYSTEM_PROMPT)
      : messages;
  }

  return systemChars > DEFAULT_SYSTEM_PROMPT_MAX_CHARS
    ? replaceSystemMessages(messages, COMPACT_SYSTEM_PROMPT)
    : messages;
}
