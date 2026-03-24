/**
 * Streaming Reconnection
 *
 * If an SSE stream drops mid-response, reconnects to the next tier
 * and continues from the last received token.
 *
 * Works by:
 * 1. Buffering tokens as they arrive
 * 2. Detecting stream failures (network error, timeout, incomplete response)
 * 3. Reconnecting to the next tier in the chain
 * 4. Sending a continuation prompt with the buffered tokens
 */

import { infer, createSSEProxyStream } from "./inference-bridge.ts";
import type { ChatCompletionRequest, InferenceTier } from "./inference-bridge.ts";

// --- Types ---

export interface StreamSession {
  id: string;
  request: ChatCompletionRequest;
  bufferedTokens: string;
  currentTier: InferenceTier;
  reconnectCount: number;
  maxReconnects: number;
  startTime: number;
}

// --- Active Sessions ---

const sessions = new Map<string, StreamSession>();

/**
 * Create a resilient streaming response that auto-reconnects on failure
 *
 * Returns a ReadableStream that transparently reconnects to the next
 * inference tier if the current stream drops.
 */
export function createResilientStream(
  request: ChatCompletionRequest,
  maxReconnects = 3
): ReadableStream<Uint8Array> {
  const sessionId = `stream-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const encoder = new TextEncoder();

  const session: StreamSession = {
    id: sessionId,
    request: { ...request, stream: true },
    bufferedTokens: '',
    currentTier: 'mesh', // Will be set by first successful tier
    reconnectCount: 0,
    maxReconnects,
    startTime: Date.now(),
  };
  sessions.set(sessionId, session);

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        await streamWithReconnect(session, controller, encoder);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : 'Stream failed';
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ error: errMsg })}\n\n`)
        );
      } finally {
        try {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        } catch {
          // Already closed
        }
        sessions.delete(sessionId);
      }
    },
  });
}

/**
 * Stream from inference with automatic reconnection on failure
 */
async function streamWithReconnect(
  session: StreamSession,
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder
): Promise<void> {
  while (session.reconnectCount <= session.maxReconnects) {
    try {
      // Build request, including buffered tokens as context if reconnecting
      const request = buildReconnectRequest(session);

      // Get inference result
      const result = await infer(request);
      session.currentTier = result.tier;

      // Send tier info
      controller.enqueue(
        encoder.encode(
          `: tier=${result.tier} reconnect=${session.reconnectCount}\n\n`
        )
      );

      // Read the upstream response
      const contentType = result.response.headers.get('content-type') ?? '';

      if (contentType.includes('text/event-stream') && result.response.body) {
        // Stream SSE events, buffering tokens
        await readSSEStream(result.response.body, session, controller);
        // Stream completed successfully
        return;
      }

      // Non-streaming response — convert to SSE
      const data = await result.response.json();
      const content =
        (data as { choices?: Array<{ message?: { content?: string } }> })
          .choices?.[0]?.message?.content ?? '';

      session.bufferedTokens += content;
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            choices: [
              {
                delta: { content },
                index: 0,
                finish_reason: 'stop',
              },
            ],
          })}\n\n`
        )
      );
      return;
    } catch {
      // Stream failed — reconnect
      session.reconnectCount++;
      if (session.reconnectCount > session.maxReconnects) {
        throw new Error(
          `Stream failed after ${session.maxReconnects} reconnection attempts`
        );
      }

      // Brief pause before reconnecting
      await new Promise((r) => setTimeout(r, 500));

      controller.enqueue(
        encoder.encode(
          `: reconnecting (attempt ${session.reconnectCount}/${session.maxReconnects})\n\n`
        )
      );
    }
  }
}

/**
 * Build a request that continues from where we left off
 */
function buildReconnectRequest(session: StreamSession): ChatCompletionRequest {
  if (session.bufferedTokens.length === 0) {
    return session.request;
  }

  // Add the partial response as assistant context so the model continues
  const messages = [
    ...session.request.messages,
    {
      role: 'assistant' as const,
      content: session.bufferedTokens,
    },
    {
      role: 'user' as const,
      content:
        'Continue your previous response from where you left off. Do not repeat what you already said.',
    },
  ];

  return {
    ...session.request,
    messages,
  };
}

/**
 * Read an SSE stream, buffering tokens and forwarding to the controller
 */
async function readSSEStream(
  body: ReadableStream<Uint8Array>,
  session: StreamSession,
  controller: ReadableStreamDefaultController<Uint8Array>
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value, { stream: true });
    buffer += chunk;

    // Forward the raw chunk to the client
    controller.enqueue(value);

    // Extract tokens from SSE events for buffering
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? ''; // Keep incomplete line in buffer

    for (const line of lines) {
      if (line.startsWith('data: ') && line !== 'data: [DONE]') {
        try {
          const data = JSON.parse(line.slice(6)) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const token = data.choices?.[0]?.delta?.content;
          if (token) {
            session.bufferedTokens += token;
          }
        } catch {
          // Not valid JSON, ignore
        }
      }
    }
  }
}

/**
 * Get active stream sessions (for debugging)
 */
export function getActiveSessions(): Array<{
  id: string;
  tier: InferenceTier;
  reconnects: number;
  bufferedLength: number;
  durationMs: number;
}> {
  return Array.from(sessions.values()).map((s) => ({
    id: s.id,
    tier: s.currentTier,
    reconnects: s.reconnectCount,
    bufferedLength: s.bufferedTokens.length,
    durationMs: Date.now() - s.startTime,
  }));
}
