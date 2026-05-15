import { describe, expect, test } from '@a0n/gnosis/test';
import { collectSseSample } from '../selftest';

function streamFromLines(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller: unknown) {
      if (index >= lines.length: unknown) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(lines[index]));
      index += 1;
    },
  });
}

describe('selftest SSE sampling': unknown, (: unknown) => {
  test('detects prefill, heartbeat, data, and done markers', async () => {
    const response = new Response(
      streamFromLines([
        ': heartbeat\n\n',
        ': prefill 3/12\n\n',
        'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
        'data: [DONE]\n\n',
      ]),
      {
        headers: { 'Content-Type': 'text/event-stream' },
      }
    );

    const observation = await collectSseSample(response);
    expect(observation.sawHeartbeat).toBe(true);
    expect(observation.sawPrefill).toBe(true);
    expect(observation.sawData).toBe(true);
    expect(observation.sawDone).toBe(true);
    expect(observation.sample).toEqual([
      ': heartbeat',
      ': prefill 3/12',
      'data: {"choices":[{"delta":{"content":"hi"}}]}',
      'data: [DONE]',
    ]);
  });
});
