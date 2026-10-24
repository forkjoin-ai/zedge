import { describe, expect, mock, test } from '@a0n/gnosis/test';
import {
  raceCoordinatorResponses,
  type RacedCoordinatorResponse,
} from '../inference-bridge';

function respondAfter<T>(ms: number, valueFactory: () => T): Promise<T> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(valueFactory()), ms);
  });
}

function chatCompletionResponse(model: string, content: string): Response {
  return new Response(
    JSON.stringify({
      id: `chatcmpl-${model}`,
      object: 'chat.completion',
      created: 1,
      model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }
  );
}

describe('Inference bridge race semantics', () => {
  test('returns a slow successful coordinator without deadline failover', async () => {
    const edgePromise = new Promise<RacedCoordinatorResponse | null>(() => {});
    const cloudRunPromise = respondAfter(20, () => ({
      tier: 'cloudrun' as const,
      response: chatCompletionResponse(
        'qwen-2.5-coder-7b',
        'warmed qwen reply'
      ),
    }));

    const result = await raceCoordinatorResponses({
      requestModel: 'qwen-2.5-coder-7b',
      startMs: Date.now(),
      edgePromise,
      cloudRunPromise,
    });

    expect(result.winner?.tier).toBe('cloudrun');

    const payload = (await result.winner?.response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    expect(payload.choices[0]?.message.content).toBe('warmed qwen reply');
  });

  test('aborts and cancels the losing coordinator after a winner is chosen', async () => {
    const abortCloudRun = mock(() => undefined);
    const cancelSpy = mock(async () => undefined);

    const losingResponse = {
      ok: true,
      headers: new Headers({ 'Content-Type': 'application/json' }),
      body: {
        cancel: cancelSpy,
      },
    } as unknown as Response;

    const edgePromise = respondAfter(10, () => ({
      tier: 'edge' as const,
      response: chatCompletionResponse('tinyllama-1.1b', 'edge winner'),
    }));
    const cloudRunPromise = respondAfter(20, () => ({
      tier: 'cloudrun' as const,
      response: losingResponse,
    }));

    const result = await raceCoordinatorResponses({
      requestModel: 'tinyllama-1.1b',
      startMs: Date.now(),
      edgePromise,
      cloudRunPromise,
      abortCloudRun,
    });

    expect(result.winner?.tier).toBe('edge');

    await result.backgroundCleanup;

    expect(abortCloudRun).toHaveBeenCalledTimes(1);
    expect(cancelSpy).toHaveBeenCalledTimes(1);
  });
});
