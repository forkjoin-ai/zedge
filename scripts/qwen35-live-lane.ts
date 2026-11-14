import { buildForkjoinRequestBody } from '../companion/src/inference-bridge.ts';

const BASE =
  process.env.ZEDGE_QWEN35_URL ??
  'https://aeon-puppet-qwen35-4b-cf.taylorbuley.workers.dev';

async function streamCount(): Promise<{ status: number; deltas: number; content: string }> {
  const body = buildForkjoinRequestBody(
    {
      model: 'qwen35-4b-uncensored',
      messages: [{ role: 'user', content: 'Count from one to five in words.' }],
      stream: true,
      disable_thinking: true,
      think_budget: 32,
    },
    [{ role: 'user', content: 'Count from one to five in words.' }],
    24,
    true
  );
  const res = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let deltas = 0;
  let content = '';
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6).trim();
    if (payload === '[DONE]') continue;
    try {
      const chunk = JSON.parse(payload) as {
        choices?: Array<{ delta?: { content?: string } }>;
      };
      const piece = chunk.choices?.[0]?.delta?.content;
      if (typeof piece === 'string' && piece.length > 0) {
        deltas += 1;
        content += piece;
      }
    } catch {
      // keepalive / non-JSON frame
    }
  }
  return { status: res.status, deltas, content };
}

async function toolCall(): Promise<{ status: number; name?: string; args?: string }> {
  const tools = [
    {
      type: 'function',
      function: {
        name: 'ping',
        description: 'Ping the station',
        parameters: { type: 'object', properties: {} },
      },
    },
  ];
  const body = buildForkjoinRequestBody(
    {
      model: 'qwen35-4b-uncensored',
      messages: [{ role: 'user', content: 'Call the ping tool.' }],
      tools,
      disable_thinking: true,
    },
    [{ role: 'user', content: 'Call the ping tool.' }],
    64,
    false
  );
  const res = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as {
    choices?: Array<{
      message?: { tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> };
    }>;
  };
  const call = json.choices?.[0]?.message?.tool_calls?.[0]?.function;
  return { status: res.status, name: call?.name, args: call?.arguments };
}

export async function main() {
  const stream = await streamCount();
  const tool = await toolCall();
  return JSON.stringify(
    { recordedAt: new Date().toISOString(), base: BASE, stream, tool },
    null,
    2
  );
}
