const BASE =
  'https://edgework-web.taylorbuley.workers.dev/api/v1/r2/distributed-inference/models';
const FILES = [
  'qwen35-4b-uncensored-q4km.knot',
  'qwen35-4b-uncensored-tokenizer.gguf',
];

async function check(file: string): Promise<{ file: string; status: number; ok: boolean }> {
  const res = await fetch(BASE + '/' + file, {
    method: 'GET',
    headers: { Range: 'bytes=0-0' },
    signal: AbortSignal.timeout(30_000),
  });
  const ok = res.status === 200 || res.status === 206;
  await res.body?.cancel();
  return { file, status: res.status, ok };
}

export async function main() {
  const results = [];
  for (const file of FILES) results.push(await check(file));
  const ok = results.every((result) => result.ok);
  return JSON.stringify({ ok, results }, null, 2);
}
