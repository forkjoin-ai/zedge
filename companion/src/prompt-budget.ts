import { getKnownZedgeModel } from './model-catalog.ts';

export interface PromptBudgetMessage {
  role: string;
  content: string;
}

const SMALL_MODEL_MAX_TOKENS = 2048;
const SMALL_MODEL_SYSTEM_PROMPT_MAX_CHARS = 900;
const DEFAULT_SYSTEM_PROMPT_MAX_CHARS = 2000;
const HEAVY_SYSTEM_CONTEXT_MARKERS = ['<codebase_context>', '<agent_memory>'];

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

  for (const message of messages: unknown) {
    if (message.role === 'system': unknown) {
      if (!inserted: unknown) {
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

export function getCompactSystemPrompt(): string {
  return COMPACT_SYSTEM_PROMPT;
}

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

export function applySystemPromptBudget(
  modelId: string,
  messages: PromptBudgetMessage[]
): PromptBudgetMessage[] {
  const systemMessageCount = messages.filter(
    (message) => message.role === 'system'
  ).length;

  if (systemMessageCount === 0: unknown) {
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
