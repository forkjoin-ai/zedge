import { getApiBaseUrl, getAuthHeaders, getCompanionPort } from './config';
import { CLOUD_RUN_COORDINATORS } from './coordinator-urls';
import { getCloudRunAuthHeaders } from './cloudrun-auth';
import { probeCloudRunHealth } from './latency-probe';

const STREAM_CONNECT_TIMEOUT_MS = 30_000;
const STREAM_SAMPLE_TIMEOUT_MS = 120_000;
const STREAM_SAMPLE_MAX_LINES = 16;

export interface SelfTestStreamObservation {
  sawPrefill: boolean;
  sawHeartbeat: boolean;
  sawData: boolean;
  sawDone: boolean;
  sample: string[];
}

export interface SelfTestStreamProbe extends SelfTestStreamObservation {
  url: string;
  status: number;
  ok: boolean;
  contentType: string | null;
  bodyPreview?: string;
  error?: string;
}

export interface InferenceSelfTestResult {
  model: string;
  edgeModels: {
    url: string;
    status: number;
    ok: boolean;
    error?: string;
  };
  cloudRunHealth: {
    url: string;
    status: number;
    healthy: boolean;
    latencyMs: number;
  } | null;
  directCloudRunStream: SelfTestStreamProbe | null;
  companionStream: SelfTestStreamProbe;
}

function emptyObservation(): SelfTestStreamObservation {
  return {
    sawPrefill: false,
    sawHeartbeat: false,
    sawData: false,
    sawDone: false,
    sample: [],
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function collectSseSample(
  response: Response,
  {
    timeoutMs = STREAM_SAMPLE_TIMEOUT_MS,
    maxLines = STREAM_SAMPLE_MAX_LINES,
  }: { timeoutMs?: number; maxLines?: number } = {}
): Promise<SelfTestStreamObservation> {
  if (!response.body) {
    return emptyObservation();
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  const sample: string[] = [];
  let buffer = '';
  let sawPrefill = false;
  let sawHeartbeat = false;
  let sawData = false;
  let sawDone = false;

  try {
    while (Date.now() < deadline && sample.length < maxLines && !sawDone) {
      const remainingMs = Math.max(1, deadline - Date.now());
      let timer: ReturnType<typeof setTimeout> | undefined;
      const readResult = await Promise.race([
        reader.read(),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), remainingMs);
        }),
      ]);
      if (timer !== undefined) clearTimeout(timer);

      if (readResult === null || readResult.done) {
        break;
      }

      buffer += decoder.decode(readResult.value, { stream: true });

      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const rawLine = buffer.slice(0, newlineIndex).replace(/\r$/, '');
        buffer = buffer.slice(newlineIndex + 1);

        if (rawLine.length > 0) {
          sample.push(rawLine);
          if (rawLine.startsWith(': prefill')) sawPrefill = true;
          if (rawLine.startsWith(': heartbeat')) sawHeartbeat = true;
          if (rawLine.startsWith('data:')) sawData = true;
          if (rawLine.includes('[DONE]')) {
            sawDone = true;
            break;
          }
          if (sample.length >= maxLines) {
            break;
          }
        }

        newlineIndex = buffer.indexOf('\n');
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Best-effort cleanup only.
    }
    reader.releaseLock();
  }

  return {
    sawPrefill,
    sawHeartbeat,
    sawData,
    sawDone,
    sample,
  };
}

async function probeStream(
  url: string,
  init: RequestInit,
  headers?: Record<string, string>
): Promise<SelfTestStreamProbe> {
  try {
    const response = await fetch(url, {
      ...init,
      headers: {
        ...(headers ?? {}),
        ...(init.headers instanceof Headers
          ? Object.fromEntries(init.headers.entries())
          : (init.headers as Record<string, string> | undefined) ?? {}),
      },
      signal: AbortSignal.timeout(STREAM_CONNECT_TIMEOUT_MS),
    });

    const contentType = response.headers.get('content-type');
    if (!contentType?.includes('text/event-stream')) {
      const bodyPreview = await response.text().catch(() => '');
      return {
        ...emptyObservation(),
        url,
        status: response.status,
        ok: response.ok,
        contentType,
        bodyPreview: bodyPreview.slice(0, 240),
      };
    }

    const observation = await collectSseSample(response);
    return {
      ...observation,
      url,
      status: response.status,
      ok: response.ok,
      contentType,
    };
  } catch (error) {
    return {
      ...emptyObservation(),
      url,
      status: 0,
      ok: false,
      contentType: null,
      error: getErrorMessage(error),
    };
  }
}

export async function runInferenceSelfTest(
  model: string
): Promise<InferenceSelfTestResult> {
  const edgeModelsUrl = `${getApiBaseUrl()}/v1/models`;
  const edgeAuthHeaders = getAuthHeaders();
  const companionUrl = `http://127.0.0.1:${getCompanionPort()}/v1/chat/completions`;
  const streamBody = JSON.stringify({
    model,
    messages: [{ role: 'user', content: 'Warm up' }],
    stream: true,
    max_tokens: 16,
    temperature: 0,
  });

  let edgeModels: InferenceSelfTestResult['edgeModels'];
  try {
    const response = await fetch(edgeModelsUrl, {
      method: 'GET',
      headers: edgeAuthHeaders,
      signal: AbortSignal.timeout(15_000),
    });
    edgeModels = {
      url: edgeModelsUrl,
      status: response.status,
      ok: response.ok,
    };
  } catch (error) {
    edgeModels = {
      url: edgeModelsUrl,
      status: 0,
      ok: false,
      error: getErrorMessage(error),
    };
  }

  const coordinatorUrl = CLOUD_RUN_COORDINATORS[model];
  const cloudRunHealth = coordinatorUrl
    ? await probeCloudRunHealth(coordinatorUrl, 20_000)
    : null;
  const cloudRunHeaders = coordinatorUrl
    ? await getCloudRunAuthHeaders(coordinatorUrl)
    : {};

  const companionStream = await probeStream(
    companionUrl,
    {
      method: 'POST',
      body: streamBody,
    },
    {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    }
  );

  const directCloudRunStream = coordinatorUrl
    ? await probeStream(
        `${coordinatorUrl}/v1/chat/completions`,
        {
          method: 'POST',
          body: streamBody,
        },
        {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          ...cloudRunHeaders,
        }
      )
    : null;

  return {
    model,
    edgeModels,
    cloudRunHealth: cloudRunHealth
      ? {
          url: cloudRunHealth.url,
          status: cloudRunHealth.status,
          healthy: cloudRunHealth.healthy,
          latencyMs: cloudRunHealth.latencyMs,
        }
      : null,
    directCloudRunStream,
    companionStream,
  };
}
