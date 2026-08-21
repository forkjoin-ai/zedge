import { describe, test, expect } from '@a0n/gnosis/test';
import { createSSEProxyStream } from '../inference-bridge';
import type { TierAttempt } from '../inference-bridge';

// --- Helpers ---

/** Build a ReadableStream from raw SSE text */
function sseStream(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

/** Build a ReadableStream that delivers chunks with a delay */
function slowSSEStream(
  chunks: string[],
  delayMs = 10
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
        await new Promise((r) => setTimeout(r, delayMs));
      }
      controller.close();
    },
  });
}

/** Consume a ReadableStream<Uint8Array> to a string */
async function consumeStream(
  stream: ReadableStream<Uint8Array>
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }
  return result;
}

/** Parse SSE text into individual events (data lines) */
function parseSSEEvents(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice(6));
}

/** Parse SSE text into JSON data objects (excluding [DONE]) */
function parseSSEDataObjects(text: string): unknown[] {
  return parseSSEEvents(text)
    .filter((payload) => payload !== '[DONE]')
    .map((payload) => JSON.parse(payload));
}

function parseNamedSSEEvents(text: string): Array<{
  event: string;
  data: string;
}> {
  return text
    .split(/\n\n+/)
    .map((frame) => {
      const event = frame
        .split('\n')
        .find((line) => line.startsWith('event: '))
        ?.slice('event: '.length);
      const data = frame
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice('data: '.length))
        .join('\n');
      return event ? { event, data } : null;
    })
    .filter((event): event is { event: string; data: string } => event !== null);
}

// --- Tests ---

describe('SSE Chat Completions (createSSEProxyStream)', () => {
  test('forwards data lines from upstream SSE', async () => {
    const chunk = JSON.stringify({
      id: 'chatcmpl-1',
      object: 'chat.completion.chunk',
      created: 1000,
      model: 'test-model',
      choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }],
    });
    const upstream = sseStream(`data: ${chunk}\n\ndata: [DONE]\n\n`);

    const proxy = createSSEProxyStream(upstream, 'echo');
    const output = await consumeStream(proxy);

    const events = parseSSEEvents(output);
    expect(events).toContain('[DONE]');

    const dataObjects = parseSSEDataObjects(output);
    expect(dataObjects.length).toBeGreaterThanOrEqual(1);
    const first = dataObjects[0] as {
      choices: Array<{ delta: { content: string } }>;
    };
    expect(first.choices[0].delta.content).toBe('Hello');
  });

  test('always emits [DONE] even if upstream omits it', async () => {
    const chunk = JSON.stringify({
      id: 'chatcmpl-2',
      object: 'chat.completion.chunk',
      created: 1000,
      model: 'test-model',
      choices: [{ index: 0, delta: { content: 'Hi' }, finish_reason: null }],
    });
    // Upstream closes without [DONE]
    const upstream = sseStream(`data: ${chunk}\n\n`);

    const proxy = createSSEProxyStream(upstream, 'echo');
    const output = await consumeStream(proxy);

    const events = parseSSEEvents(output);
    expect(events).toContain('[DONE]');
  });

  test('does not duplicate [DONE] when upstream sends it', async () => {
    const upstream = sseStream('data: [DONE]\n\n');

    const proxy = createSSEProxyStream(upstream, 'echo');
    const output = await consumeStream(proxy);

    const doneCount = parseSSEEvents(output).filter(
      (e) => e === '[DONE]'
    ).length;
    expect(doneCount).toBe(1);
  });

  test('handles null upstream body gracefully', async () => {
    const proxy = createSSEProxyStream(null, 'echo');
    const output = await consumeStream(proxy);

    const events = parseSSEEvents(output);
    // Should have an error event and [DONE]
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events).toContain('[DONE]');

    const errorEvent = events.find((e) => e !== '[DONE]');
    expect(errorEvent).toBeDefined();
    const parsed = JSON.parse(errorEvent!);
    expect(parsed).toHaveProperty('error');
  });

  test('strips upstream SSE comments (heartbeat, prefill)', async () => {
    const chunk = JSON.stringify({
      id: 'chatcmpl-3',
      object: 'chat.completion.chunk',
      created: 1000,
      model: 'test-model',
      choices: [{ index: 0, delta: { content: 'World' }, finish_reason: null }],
    });
    const upstream = sseStream(
      `: heartbeat\n\n: some-comment\n\ndata: ${chunk}\n\ndata: [DONE]\n\n`
    );

    const proxy = createSSEProxyStream(upstream, 'cloudrun');
    const output = await consumeStream(proxy);

    // Raw upstream comments should not appear as data lines
    const lines = output.split('\n');
    const commentLines = lines.filter(
      (l) => l.startsWith(': heartbeat') || l.startsWith(': some-comment')
    );
    expect(commentLines.length).toBe(0);

    // But data should still come through
    const dataObjects = parseSSEDataObjects(output);
    expect(dataObjects.length).toBeGreaterThanOrEqual(1);
  });

  test('renders prefill progress with an empty cell and filled cells', async () => {
    const chunk = JSON.stringify({
      id: 'chatcmpl-progress-bar',
      object: 'chat.completion.chunk',
      created: 1000,
      model: 'test-model',
      choices: [{ index: 0, delta: { content: 'Done' }, finish_reason: null }],
    });
    const upstream = sseStream(
      `: prefill 0/100\n\n: prefill 50/100\n\n: prefill 100/100\n\ndata: ${chunk}\n\ndata: [DONE]\n\n`
    );

    const proxy = createSSEProxyStream(
      upstream,
      'moonshine',
      {},
      [{ tier: 'moonshine', status: 'ok', ms: 5 }],
      'gnosis-local'
    );
    const output = await consumeStream(proxy);
    const dataObjects = parseSSEDataObjects(output) as Array<{
      choices: Array<{ delta: { content?: string } }>;
    }>;
    const renderedContent = dataObjects
      .map((data) => data.choices[0].delta.content ?? '')
      .join('');

    expect(renderedContent).toMatch(/^\*\d+t\/s \| moonshine:ok\(5ms\) prefill \u2591/);
    expect(renderedContent).toContain('*0t/s |');
    expect(renderedContent).toContain(`prefill \u2591${'\u2588'.repeat(20)}`);
    expect(renderedContent).toContain('moonshine:ok(5ms)');
    expect(renderedContent).not.toContain('▁');
    expect(renderedContent).toContain('Done');
  });

  test('keeps prefill progress visible after an empty role chunk', async () => {
    const roleChunk = JSON.stringify({
      id: 'chatcmpl-role',
      object: 'chat.completion.chunk',
      created: 1000,
      model: 'rwkv7-mini',
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    });
    const tokenChunk = JSON.stringify({
      id: 'chatcmpl-token',
      object: 'chat.completion.chunk',
      created: 1000,
      model: 'rwkv7-mini',
      choices: [
        { index: 0, delta: { content: 'Done' }, finish_reason: null },
      ],
    });
    const upstream = sseStream(
      `data: ${roleChunk}\n\n: prefill 0/100\n\n: prefill 50/100\n\ndata: ${tokenChunk}\n\ndata: [DONE]\n\n`
    );

    const output = await consumeStream(
      createSSEProxyStream(upstream, 'skymesh-relay', {}, [], 'rwkv7-mini')
    );
    const dataObjects = parseSSEDataObjects(output) as Array<{
      choices: Array<{ delta: { content?: string } }>;
    }>;
    const renderedContent = dataObjects
      .map((data) => data.choices[0].delta.content ?? '')
      .join('');

    expect(renderedContent).toContain(`prefill \u2591${'\u2588'.repeat(10)}`);
    expect(renderedContent).toContain('Done');
  });

  test('converts named upstream prefill events without forwarding custom data by default', async () => {
    const chunk = JSON.stringify({
      id: 'chatcmpl-named-prefill',
      object: 'chat.completion.chunk',
      created: 1000,
      model: 'test-model',
      choices: [{ index: 0, delta: { content: 'Ready' }, finish_reason: null }],
    });
    const upstream = sseStream(
      [
        'event: prefill',
        'data: {"type":"prefill","completed_tokens":0,"total_tokens":10}',
        '',
        'event: prefill',
        'data: {"type":"prefill","completed_tokens":10,"total_tokens":10}',
        '',
        `data: ${chunk}`,
        '',
        'data: [DONE]',
        '',
      ].join('\n')
    );

    const proxy = createSSEProxyStream(
      upstream,
      'moonshine',
      {},
      [{ tier: 'moonshine', status: 'ok', ms: 5 }],
      'gnosis-local'
    );
    const output = await consumeStream(proxy);
    const namedEvents = parseNamedSSEEvents(output);

    expect(namedEvents.filter((event) => event.event === 'prefill')).toEqual(
      []
    );

    const renderedContent = (
      parseSSEDataObjects(output) as Array<{
        choices?: Array<{ delta?: { content?: string } }>;
      }>
    )
      .map((data) => data.choices?.[0]?.delta?.content ?? '')
      .join('');
    expect(renderedContent).toContain(`prefill \u2591${'\u2588'.repeat(20)}`);
    expect(renderedContent).toContain('Ready');
  });

  test('passes through named upstream prefill events when explicitly enabled', async () => {
    const chunk = JSON.stringify({
      id: 'chatcmpl-named-prefill',
      object: 'chat.completion.chunk',
      created: 1000,
      model: 'test-model',
      choices: [{ index: 0, delta: { content: 'Ready' }, finish_reason: null }],
    });
    const upstream = sseStream(
      [
        'event: prefill',
        'data: {"type":"prefill","completed_tokens":0,"total_tokens":10}',
        '',
        'event: prefill',
        'data: {"type":"prefill","completed_tokens":10,"total_tokens":10}',
        '',
        `data: ${chunk}`,
        '',
        'data: [DONE]',
        '',
      ].join('\n')
    );

    const proxy = createSSEProxyStream(
      upstream,
      'moonshine',
      {},
      [{ tier: 'moonshine', status: 'ok', ms: 5 }],
      'gnosis-local',
      { forwardNamedEvents: true }
    );
    const output = await consumeStream(proxy);
    const namedEvents = parseNamedSSEEvents(output);

    expect(namedEvents.filter((event) => event.event === 'prefill')).toEqual([
      {
        event: 'prefill',
        data: '{"type":"prefill","completed_tokens":0,"total_tokens":10}',
      },
      {
        event: 'prefill',
        data: '{"type":"prefill","completed_tokens":10,"total_tokens":10}',
      },
    ]);
  });

  test('handles CRLF-delimited SSE frames', async () => {
    const chunk = JSON.stringify({
      id: 'chatcmpl-crlf',
      object: 'chat.completion.chunk',
      created: 1000,
      model: 'test-model',
      choices: [{ index: 0, delta: { content: 'CRLF' }, finish_reason: null }],
    });
    const upstream = sseStream(`data: ${chunk}\r\n\r\ndata: [DONE]\r\n\r\n`);

    const proxy = createSSEProxyStream(upstream, 'edge');
    const output = await consumeStream(proxy);

    const dataObjects = parseSSEDataObjects(output) as Array<{
      choices: Array<{ delta: { content: string } }>;
    }>;
    expect(dataObjects[0]?.choices[0]?.delta.content).toBe('CRLF');
    expect(parseSSEEvents(output)).toContain('[DONE]');
  });

  test('handles multi-chunk streaming correctly', async () => {
    const makeChunk = (content: string, i: number) =>
      JSON.stringify({
        id: 'chatcmpl-4',
        object: 'chat.completion.chunk',
        created: 1000,
        model: 'test-model',
        choices: [
          {
            index: 0,
            delta: i === 0 ? { role: 'assistant', content } : { content },
            finish_reason: null,
          },
        ],
      });

    const upstream = slowSSEStream([
      `data: ${makeChunk('Hello', 0)}\n\n`,
      `data: ${makeChunk(' world', 1)}\n\n`,
      `data: ${makeChunk('!', 2)}\n\n`,
      'data: [DONE]\n\n',
    ]);

    const proxy = createSSEProxyStream(upstream, 'cloudrun');
    const output = await consumeStream(proxy);

    const dataObjects = parseSSEDataObjects(output) as Array<{
      choices: Array<{ delta: { content?: string } }>;
    }>;
    // Should have at least the 3 content chunks (may also have debug/progress chunks)
    const contentChunks = dataObjects.filter(
      (d) => d.choices?.[0]?.delta?.content !== undefined
    );
    expect(contentChunks.length).toBeGreaterThanOrEqual(3);

    const assembled = contentChunks
      .map((d) => d.choices[0].delta.content)
      .join('');
    expect(assembled).toContain('Hello');
    expect(assembled).toContain(' world');
    expect(assembled).toContain('!');

    expect(parseSSEEvents(output)).toContain('[DONE]');
  });

  test('handles upstream error mid-stream', async () => {
    const encoder = new TextEncoder();
    const chunk = JSON.stringify({
      id: 'chatcmpl-5',
      object: 'chat.completion.chunk',
      created: 1000,
      model: 'test-model',
      choices: [{ index: 0, delta: { content: 'Start' }, finish_reason: null }],
    });

    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${chunk}\n\n`));
        controller.error(new Error('connection reset'));
      },
    });

    const proxy = createSSEProxyStream(upstream, 'edge');
    const output = await consumeStream(proxy);

    // Should still have [DONE] despite the error
    expect(parseSSEEvents(output)).toContain('[DONE]');

    // Should have an error event
    const errorEvents = parseSSEDataObjects(output).filter(
      (d) => (d as Record<string, unknown>).error
    );
    expect(errorEvents.length).toBeGreaterThanOrEqual(1);
  });

  test('flushes a buffered final data line before reporting stream errors', async () => {
    const encoder = new TextEncoder();
    let sent = false;
    const chunk = JSON.stringify({
      id: 'chatcmpl-partial',
      object: 'chat.completion.chunk',
      created: 1000,
      model: 'test-model',
      choices: [{ index: 0, delta: { content: 'Tail' }, finish_reason: null }],
    });

    const upstream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) {
          controller.error(new Error('connection reset'));
          return;
        }

        sent = true;
        controller.enqueue(encoder.encode(`data: ${chunk}`));
      },
    });

    const proxy = createSSEProxyStream(upstream, 'edge');
    const output = await consumeStream(proxy);

    const dataObjects = parseSSEDataObjects(output).filter(
      (payload) =>
        (payload as { choices?: unknown[] }).choices ||
        (payload as Record<string, unknown>).error
    ) as Array<{
      choices?: Array<{ delta?: { content?: string } }>;
      error?: string;
    }>;

    expect(
      dataObjects.some(
        (payload) => payload.choices?.[0]?.delta?.content === 'Tail'
      )
    ).toBe(true);
    expect(
      dataObjects.some((payload) => payload.error === 'connection reset')
    ).toBe(true);
    expect(parseSSEEvents(output)).toContain('[DONE]');
  });

  test('passes tier attempt info to logs (not to stream)', async () => {
    const upstream = sseStream('data: [DONE]\n\n');
    const attempts: TierAttempt[] = [
      { tier: 'mesh', status: 'skipped', ms: 2, detail: 'no peers' },
      { tier: 'edge', status: 'error', ms: 30000, detail: 'timeout' },
      { tier: 'cloudrun', status: 'ok', ms: 500 },
    ];

    const proxy = createSSEProxyStream(
      upstream,
      'cloudrun',
      {},
      attempts,
      'tinyllama-1.1b'
    );
    const output = await consumeStream(proxy);

    // Tier attempt info should NOT appear as raw text in the SSE stream
    // (it goes into HTTP headers and inference logs instead)
    expect(output).not.toContain('mesh:skipped');
    expect(output).not.toContain('edge:error');
    expect(parseSSEEvents(output)).toContain('[DONE]');
  });

  test('all data chunks have valid OpenAI-compatible structure', async () => {
    const makeChunk = (content: string) =>
      JSON.stringify({
        id: 'chatcmpl-6',
        object: 'chat.completion.chunk',
        created: 1000,
        model: 'test-model',
        choices: [{ index: 0, delta: { content }, finish_reason: null }],
      });

    const upstream = sseStream(
      `data: ${makeChunk('A')}\n\ndata: ${makeChunk('B')}\n\ndata: [DONE]\n\n`
    );

    const proxy = createSSEProxyStream(upstream, 'wasm');
    const output = await consumeStream(proxy);

    const dataObjects = parseSSEDataObjects(output) as Array<
      Record<string, unknown>
    >;
    for (const obj of dataObjects) {
      // Every chunk must have these OpenAI-required fields
      expect(obj).toHaveProperty('id');
      expect(obj).toHaveProperty('object');
      expect(obj).toHaveProperty('choices');
      expect((obj as Record<string, unknown>).object).toBe(
        'chat.completion.chunk'
      );
      const choices = (obj as Record<string, unknown>).choices as Array<
        Record<string, unknown>
      >;
      expect(Array.isArray(choices)).toBe(true);
      expect(choices.length).toBeGreaterThan(0);
      expect(choices[0]).toHaveProperty('index');
      expect(choices[0]).toHaveProperty('delta');
    }
  });

  test('SSE format uses correct line endings', async () => {
    const chunk = JSON.stringify({
      id: 'chatcmpl-7',
      object: 'chat.completion.chunk',
      created: 1000,
      model: 'test-model',
      choices: [{ index: 0, delta: { content: 'test' }, finish_reason: null }],
    });
    const upstream = sseStream(`data: ${chunk}\n\ndata: [DONE]\n\n`);

    const proxy = createSSEProxyStream(upstream, 'echo');
    const output = await consumeStream(proxy);

    // SSE spec: events are separated by blank lines (\n\n)
    // Each data line ends with \n, followed by another \n for the blank line
    expect(output).toContain('data: [DONE]\n');
    // Should not have \r\n (SSE uses \n not \r\n)
    expect(output).not.toContain('\r\n');
  });
});

describe('SSE JSON-to-SSE drip-feed (server path)', () => {
  // This tests the server.ts path where upstream returns JSON but client wants stream=true.
  // We test the stream construction logic directly.

  test('drip-feed produces valid SSE from JSON response', async () => {
    const jsonResponse = {
      id: 'chatcmpl-drip-1',
      created: 1000,
      model: 'tinyllama-1.1b',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Hello world test' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    };

    // Replicate the drip-feed logic from server.ts
    const content = jsonResponse.choices[0].message.content;
    const tokens = content.match(/\S+\s*/g) ?? [content];
    const encoder = new TextEncoder();

    const sseStream = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (let i = 0; i < tokens.length; i++) {
          const chunk = {
            id: jsonResponse.id,
            object: 'chat.completion.chunk',
            created: jsonResponse.created,
            model: jsonResponse.model,
            choices: [
              {
                index: 0,
                delta:
                  i === 0
                    ? { role: 'assistant', content: tokens[i] }
                    : { content: tokens[i] },
                finish_reason: null,
              },
            ],
          };
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`)
          );
        }
        // Finish chunk
        const finishChunk = {
          id: jsonResponse.id,
          object: 'chat.completion.chunk',
          created: jsonResponse.created,
          model: jsonResponse.model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: jsonResponse.usage,
        };
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(finishChunk)}\n\n`)
        );
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });

    const output = await consumeStream(sseStream);
    const events = parseSSEEvents(output);
    const dataObjects = parseSSEDataObjects(output) as Array<
      Record<string, unknown>
    >;

    // Should have content chunks + finish chunk + [DONE]
    expect(events).toContain('[DONE]');
    expect(dataObjects.length).toBe(tokens.length + 1); // content chunks + finish

    // First chunk should have role + content
    type SSEChunk = {
      choices: Array<{
        delta: { role?: string; content?: string };
        finish_reason: string | null;
      }>;
      usage?: Record<string, unknown>;
    };
    const first = dataObjects[0] as SSEChunk;
    expect(first.choices[0].delta.role).toBe('assistant');
    expect(first.choices[0].delta.content).toBeDefined();

    // Last data chunk should have finish_reason: stop
    const last = dataObjects[dataObjects.length - 1] as SSEChunk;
    expect(last.choices[0].finish_reason).toBe('stop');
    expect(last).toHaveProperty('usage');

    // Reassembled content should match original
    const reassembled = dataObjects
      .filter((d) => (d as SSEChunk).choices?.[0]?.delta?.content)
      .map((d) => (d as SSEChunk).choices[0].delta.content)
      .join('');
    expect(reassembled).toBe(content);
  });
});
