import { describe, test, expect } from '@a0n/gnosis/test';
import { getActiveSessions } from '../stream-reconnect';

describe('Stream Reconnect', () => {
  test('getActiveSessions returns empty array initially', () => {
    const sessions = getActiveSessions();
    expect(Array.isArray(sessions)).toBe(true);
    expect(sessions.length).toBe(0);
  });

  test('createResilientStream returns a ReadableStream', async () => {
    const { createResilientStream } = await import('../stream-reconnect');
    const stream = createResilientStream(
      {
        model: 'wasm-local-test',
        messages: [{ role: 'user', content: 'test' }],
        max_tokens: 10,
      },
      1 // max 1 reconnect for speed
    );

    expect(stream).toBeInstanceOf(ReadableStream);

    // Read the stream to completion
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let output = '';
    let chunks = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      output += decoder.decode(value, { stream: true });
      chunks++;
    }

    // Should have received at least the tier comment and DONE sentinel
    expect(chunks).toBeGreaterThan(0);
    expect(output.length).toBeGreaterThan(0);
  }, 30_000);

  test('active sessions empty after stream completes', async () => {
    const { createResilientStream } = await import('../stream-reconnect');
    const stream = createResilientStream(
      {
        model: 'wasm-local-test',
        messages: [{ role: 'user', content: 'test' }],
        max_tokens: 5,
      },
      0
    );

    // Consume the stream
    const reader = stream.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }

    // Session should be cleaned up
    const sessions = getActiveSessions();
    expect(sessions.length).toBe(0);
  }, 30_000);
});
