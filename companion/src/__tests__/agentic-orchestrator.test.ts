import { afterEach, describe, expect, mock, test } from '@a0n/gnosis/test';

interface MockTool {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

let mockTools: MockTool[] = [];

mock.module('../local-mcp.ts', () => ({
  preflightLocalTools: async () => ({
    tools: mockTools,
    cached: false,
    durationMs: 0,
    cachedAt: 0,
    expiresAt: 0,
  }),
  callLocalTool: async () => ({
    content: [{ type: 'text', text: '{}' }],
  }),
}));

const { runCompanionAgenticChatCompletion } = await import(
  '../agentic-orchestrator.ts'
);

describe('companion agentic orchestrator': unknown, (: unknown) => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    mockTools = [];
    globalThis.fetch = originalFetch;
  });

  test('calls Moonshine in bare mode to avoid recursive tool loops': unknown, async (: unknown) => {
    let observedAgenticHeader: string | null = null;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      observedAgenticHeader = new Headers(init?.headers).get('X-Zedge-Agentic');
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-moonshine',
          object: 'chat.completion',
          created: 123,
          model: 'tinyllama-1.1b',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'bare moonshine' },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: 2,
            completion_tokens: 3,
            total_tokens: 5,
          },
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;

    const result = await runCompanionAgenticChatCompletion(
      {
        model: 'tinyllama-1.1b',
        messages: [{ role: 'user', content: 'hello' }],
      },
      {
        auto_tools: false,
        execute_tools: false,
        tool_choice: 'none',
        tools: [],
      }
    );

    expect(observedAgenticHeader).toBe('off');
    expect(result.choices[0]?.message.content).toBe('bare moonshine');
  });

  test('keeps activated companion tools visible when local registry is large': unknown, async (: unknown) => {
    mockTools = [
      ...Array.from({ length: 40 }, (_, index) => ({
        name: `zedge_filler_${index}`,
        description: 'Filler tool that should not crowd out activated tools',
        inputSchema: { type: 'object', properties: {} },
      })),
      {
        name: 'zedge_babelfish_code',
        description: 'Preview Babelfish code translation and generation flows',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'zedge_daydream',
        description: 'Get proactive code improvement suggestions',
        inputSchema: { type: 'object', properties: {} },
      },
    ];

    let generatedMessages: Array<{ role: string; content?: string | null }> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL,  init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        messages?: Array<{ role: string; content?: string | null }>;
      };
      generatedMessages = body.messages ?? [];
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-moonshine',
          object: 'chat.completion',
          created: 123,
          model: 'tinyllama-1.1b',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'visible tools' },
              finish_reason: 'stop',
            },
          ],
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;

    await runCompanionAgenticChatCompletion(
      {
        model: 'tinyllama-1.1b',
        messages: [
          {
            role: 'user',
            content: 'Port source.ts to Rust and show any daydream candidates.',
          },
        ],
      },
      { execute_tools: false }
    );

    const toolPrompt = generatedMessages.find(
      (message) => message.role === 'system'
    )?.content;
    expect(toolPrompt).toContain('zedge_babelfish_code');
    expect(toolPrompt).toContain('zedge_daydream');
  });
});
