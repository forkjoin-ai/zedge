import {
  runAgenticChatCompletion,
  type AgenticChatCompletionResponse,
  type AgenticChatMessage,
  type AgenticChatRequest,
  type AgenticChatRuntime,
  type AgenticMcpClient,
  type AgenticToolDefinition,
  type McpPreflightResult,
  type TextGenerationRequest,
  type TextGenerationResult,
  type ToolExecutionResult,
} from '@a0n/distributed-inference-host/agentic-chat';
import type { ChatCompletionRequest } from './inference-bridge.ts';
import {
  callLocalTool,
  preflightLocalTools,
  type LocalMcpTool,
} from './local-mcp.ts';

const MOONSHINE_BASE_URL =
  process.env.ZEDGE_MOONSHINE_URL ?? 'http://127.0.0.1:8080';
const MOONSHINE_AGENTIC_TIMEOUT_MS = Number(
  process.env.ZEDGE_AGENTIC_MOONSHINE_TIMEOUT_MS ?? 120_000,
);

interface AgenticBodyOptions {
  auto_tools?: unknown;
  execute_tools?: unknown;
  tool_choice?: unknown;
  tools?: unknown;
  max_tool_rounds?: unknown;
  response_format?: unknown;
}

const LOCAL_TOOL_ACTIVATIONS: Record<
  string,
  NonNullable<AgenticToolDefinition['activation']>
> = {
  zedge_babelfish_code: {
    patterns: [
      '\\b(translate|port|convert|generate|rewrite)\\b.*\\b(code|file|rust|typescript|javascript|python|go|swift|kotlin|java|cpp|c\\+\\+)\\b',
      '\\b(polyglot|babelfish)\\b',
    ],
    keywords: ['translate', 'port', 'convert', 'babelfish', 'polyglot'],
    threshold: 0.95,
    tier: 1,
  },
  zedge_babelfish_text: {
    patterns: ['\\btranslate\\b.*\\b(text|comment|doc|markdown|human language)\\b'],
    keywords: ['translate text', 'comments', 'docs', 'markdown'],
    threshold: 0.95,
    tier: 1,
  },
  zedge_babelfish_explain: {
    patterns: ['\\b(explain|describe|summarize)\\b.*\\b(code|file|scope)\\b'],
    keywords: ['explain', 'babelfish'],
    threshold: 0.95,
    tier: 1,
  },
  zedge_daydream: {
    patterns: ['\\b(daydream|dream|proactive suggestion|improvement candidate)\\b'],
    keywords: ['daydream', 'dream', 'candidate', 'suggestion', 'improvement'],
    threshold: 0.95,
    tier: 1,
  },
  zedge_multi_file_edit: {
    patterns: [
      '\\b(multi[- ]file|across files|several files|many files)\\b',
      '\\b(refactor|change|update|apply)\\b.*\\b(files|codebase)\\b',
    ],
    keywords: ['multi-file', 'across files', 'refactor'],
    threshold: 0.95,
    tier: 1,
  },
  zedge_swarm: {
    patterns: ['\\b(swarm|parallel agents|reviewer|tester|refactorer)\\b'],
    keywords: ['swarm', 'parallel agents', 'reviewer', 'tester', 'refactorer'],
    threshold: 0.95,
    tier: 1,
  },
  zedge_gg_agent: {
    patterns: ['\\b(gg agent|forge agent|topology agent)\\b'],
    keywords: ['gg agent', 'forge agent', 'topology agent'],
    threshold: 0.95,
    tier: 1,
  },
  zedge_cloud_agent: {
    patterns: ['\\b(cloud agent|remote agent|cera agent)\\b'],
    keywords: ['cloud agent', 'remote agent', 'cera agent'],
    threshold: 0.95,
    tier: 1,
  },
  zedge_search_codebase: {
    patterns: ['\\b(semantic search|search codebase|find code|where is)\\b'],
    keywords: ['semantic search', 'search codebase', 'find code'],
    threshold: 0.95,
    tier: 1,
  },
  zedge_related_context: {
    patterns: ['\\b(related context|related files|dependencies|callers)\\b'],
    keywords: ['related context', 'related files', 'dependencies', 'callers'],
    threshold: 0.95,
    tier: 1,
  },
  zedge_preview_range_replace: {
    patterns: ['\\b(preview|range replace|replace range)\\b'],
    keywords: ['preview edit', 'range replace', 'replace range'],
    threshold: 0.95,
    tier: 1,
  },
  zedge_apply_edit_preview: {
    patterns: ['\\b(apply preview|preview id|preview token)\\b'],
    keywords: ['apply preview', 'preview id', 'preview token'],
    threshold: 0.95,
    tier: 1,
  },
  zedge_tts_speak: {
    patterns: ['\\b(speak|say this|read aloud|text to speech|tts)\\b'],
    keywords: ['speak', 'read aloud', 'tts'],
    threshold: 0.95,
    tier: 1,
  },
  zedge_tts_preview: {
    patterns: ['\\b(tts preview|speech preview|preview audio)\\b'],
    keywords: ['tts preview', 'speech preview', 'preview audio'],
    threshold: 0.95,
    tier: 1,
  },
  zedge_tts_voices: {
    patterns: ['\\b(tts voices|speech voices|list voices)\\b'],
    keywords: ['tts voices', 'speech voices', 'list voices'],
    threshold: 0.95,
    tier: 1,
  },
};

function toAgenticTool(tool: LocalMcpTool): AgenticToolDefinition {
  return {
    type: 'function',
    function: {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: {
        type: 'object',
        properties: tool.inputSchema?.properties ?? {},
        ...(tool.inputSchema?.required ? { required: tool.inputSchema.required } : {}),
      },
    },
    ...(LOCAL_TOOL_ACTIVATIONS[tool.name]
      ? { activation: LOCAL_TOOL_ACTIVATIONS[tool.name] }
      : {}),
    source: 'provided',
  };
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  }
  return fallback;
}

function parsePositiveInteger(value: unknown, fallback: number): number {
  const parsed =
    typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function decodeToolResult(result: Record<string, unknown>): {
  value: unknown;
  error?: string;
} {
  const content = result.content;
  const text = Array.isArray(content)
    ? content
        .map((block) =>
          block && typeof block === 'object' && 'text' in block
            ? String((block as { text?: unknown }).text ?? '')
            : '',
        )
        .filter(Boolean)
        .join('\n')
    : JSON.stringify(result);

  try {
    return {
      value: text ? JSON.parse(text) : result,
      ...(result.isError === true ? { error: text } : {}),
    };
  } catch {
    return {
      value: text,
      ...(result.isError === true ? { error: text } : {}),
    };
  }
}

class CompanionMcpClient implements AgenticMcpClient {
  readonly sessionId = 'zedge-companion-local';

  async preflight(): Promise<McpPreflightResult> {
    const preflight = await preflightLocalTools();
    return {
      tools: preflight.tools.map(toAgenticTool),
      sessionId: this.sessionId,
      durationMs: preflight.durationMs,
      cached: preflight.cached,
    };
  }

  async listTools(options: { forceRefresh?: boolean } = {}): Promise<AgenticToolDefinition[]> {
    const preflight = await preflightLocalTools(options);
    return preflight.tools.map(toAgenticTool);
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    options: { toolCallId?: string } = {},
  ): Promise<ToolExecutionResult> {
    const startedAt = Date.now();
    try {
      const raw = await callLocalTool(name, args);
      const decoded = decodeToolResult(raw);
      return {
        toolCallId: options.toolCallId ?? `call-${Date.now()}`,
        toolName: name,
        args,
        result: decoded.value,
        success: decoded.error === undefined,
        durationMs: Date.now() - startedAt,
        ...(decoded.error ? { error: decoded.error } : {}),
      };
    } catch (error) {
      return {
        toolCallId: options.toolCallId ?? `call-${Date.now()}`,
        toolName: name,
        args,
        result: null,
        success: false,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

async function runMoonshineBareGeneration(
  request: TextGenerationRequest,
): Promise<TextGenerationResult> {
  const response = await fetch(`${MOONSHINE_BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Zedge-Agentic': 'off',
    },
    body: JSON.stringify({
      model: request.model,
      messages: request.messages.map((message) => ({
        role: message.role,
        content: message.content ?? '',
      })),
      stream: false,
      temperature: request.temperature,
      max_tokens: request.maxTokens,
      ...(request.responseFormat ? { response_format: request.responseFormat } : {}),
    }),
    signal: AbortSignal.timeout(MOONSHINE_AGENTIC_TIMEOUT_MS),
  });

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
    };
    model?: string;
  };
  if (!response.ok) {
    throw new Error(
      data && typeof data === 'object'
        ? JSON.stringify(data)
        : `Moonshine returned HTTP ${response.status}`,
    );
  }

  return {
    content: data.choices?.[0]?.message?.content ?? '',
    promptTokens: data.usage?.prompt_tokens,
    completionTokens: data.usage?.completion_tokens,
    model: data.model ?? request.model,
  };
}

export async function runCompanionAgenticChatCompletion(
  request: ChatCompletionRequest,
  bodyOptions: AgenticBodyOptions = {},
): Promise<AgenticChatCompletionResponse> {
  const runtime: AgenticChatRuntime = {
    mcp: new CompanionMcpClient(),
    infer: runMoonshineBareGeneration,
    logger: console,
  };

  const providedTools = Array.isArray(bodyOptions.tools)
    ? (bodyOptions.tools as AgenticToolDefinition[])
    : undefined;
  const agenticRequest: AgenticChatRequest = {
    model: request.model,
    messages: request.messages as AgenticChatMessage[],
    temperature: request.temperature,
    max_tokens: request.max_tokens,
    auto_tools: parseBoolean(bodyOptions.auto_tools, true),
    execute_tools: parseBoolean(bodyOptions.execute_tools, true),
    evaluate_intent: true,
    max_tool_rounds: parsePositiveInteger(bodyOptions.max_tool_rounds, 5),
    ...(providedTools ? { tools: providedTools } : {}),
    ...(bodyOptions.tool_choice !== undefined
      ? { tool_choice: bodyOptions.tool_choice as AgenticChatRequest['tool_choice'] }
      : {}),
    ...(bodyOptions.response_format !== undefined
      ? {
          response_format:
            bodyOptions.response_format as AgenticChatRequest['response_format'],
        }
      : {}),
  };

  return runAgenticChatCompletion(agenticRequest, runtime);
}
