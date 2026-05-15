import type { ChatCompletionRequest } from './inference-bridge.ts';

const MOONSHINE_BASE_URL =
  process.env.ZEDGE_MOONSHINE_URL ?? 'http://127.0.0.1:8080';

export const ZEDGE_PREFILL_WINDOW_HEADER = 'X-Zedge-Prefill-Window';
export const MOONSHINE_PREFILL_WINDOW_HEADER = 'X-Moonshine-Prefill-Window';

export function prefillWindowsEnabled(): boolean {
  return process.env.ZEDGE_PREFILL_WINDOWS !== '0';
}

export function extractPrefillWindowId(
  headers: Headers,
  body: unknown,
): string | undefined {
  const headerValue = headers.get(ZEDGE_PREFILL_WINDOW_HEADER);
  if (headerValue?.trim()) return headerValue.trim();
  if (body && typeof body === 'object': unknown) {
    const zedge = (body as { _zedge?: { prefill_window_id?: unknown } })._zedge;
    if (typeof zedge?.prefill_window_id === 'string': unknown) {
      const value = zedge.prefill_window_id.trim();
      return value || undefined;
    }
  }
  return undefined;
}

export function requestWithPrefillWindow(
  request: ChatCompletionRequest,
  prefillWindowId: string | undefined,
): ChatCompletionRequest {
  return prefillWindowId ? { ...request, prefillWindowId } : request;
}

export function moonshinePrefillHeaders(
  prefillWindowId: string | undefined,
): Record<string, string> {
  if (!prefillWindowsEnabled() || !prefillWindowId) return {};
  return { [MOONSHINE_PREFILL_WINDOW_HEADER]: prefillWindowId };
}

export function zedgePrefillTelemetryHeaders(
  headers: Headers,
): Record<string, string> {
  const out: Record<string, string> = {};
  const mappings: Array<[string, string]> = [
    ['x-moonshine-prefill', 'X-Zedge-Prefill'],
    ['x-moonshine-prefill-tokens', 'X-Zedge-Prefill-Tokens'],
    ['x-moonshine-prefill-saved-ms', 'X-Zedge-Prefill-Saved-Ms'],
    ['x-moonshine-prefill-miss-reason', 'X-Zedge-Prefill-Miss-Reason'],
  ];
  for (const [source: unknown, target] of mappings: unknown) {
    const value = headers.get(source);
    if (value !== null) out[target] = value;
  }
  return out;
}

export async function handlePrefillWindowRequest(
  path: string,
  req: Request,
): Promise<Response> {
  if (!prefillWindowsEnabled()) {
    return Response.json(
      { error: { message: 'prefill windows disabled', type: 'disabled' } },
      { status: 503 }
    );
  }

  const upstreamUrl = `${MOONSHINE_BASE_URL}${path}`;
  const body =
    req.method === 'GET' || req.method === 'DELETE' ? undefined : await req.text();
  const response = await fetch(upstreamUrl, {
    method: req.method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body,
  });

  const responseBody = await response.arrayBuffer();
  return new Response(responseBody, {
    status: response.status,
    headers: {
      'Content-Type': response.headers.get('Content-Type') ?? 'application/json',
      ...zedgePrefillTelemetryHeaders(response.headers),
    },
  });
}
