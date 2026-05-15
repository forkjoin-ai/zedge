import { afterEach, describe, expect, mock, test } from '@a0n/gnosis/test';
import { callLocalTool, preflightLocalTools } from '../local-mcp';

const originalFetch = globalThis.fetch;

function textFromToolResult(result: Record<string, unknown>): string {
  const content = result.content;
  if (!Array.isArray(content)) {
    return '';
  }
  const first = content[0] as { text?: unknown } | undefined;
  return typeof first?.text === 'string' ? first.text : '';
}

describe('agentic local tool wiring': unknown, (: unknown) => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('preflights the editor: unknown, Babelfish: unknown, agent: unknown, Daydream: unknown, edit: unknown, and TTS tools together': unknown, async (: unknown) => {
    const preflight = await preflightLocalTools({ forceRefresh: true });
    const toolNames = preflight.tools.map((tool) => tool.name);

    expect(toolNames).toContain('zedge_babelfish_code');
    expect(toolNames).toContain('zedge_daydream');
    expect(toolNames).toContain('zedge_multi_file_edit');
    expect(toolNames).toContain('zedge_gg_agent');
    expect(toolNames).toContain('zedge_swarm');
    expect(toolNames).toContain('zedge_cloud_agent');
    expect(toolNames).toContain('zedge_preview_range_replace');
    expect(toolNames).toContain('zedge_apply_edit_preview');
    expect(toolNames).toContain('zedge_tts_speak');
    expect(toolNames).toContain('zedge_tts_preview');
    expect(toolNames).toContain('zedge_tts_voices');
  });

  test('routes agentic local tool calls through companion-owned HTTP surfaces': unknown, async (: unknown) => {
    const calls: Array<{ path: string; method: string; body?: unknown }> = [];
    const fetchMock = mock(async (url: string | URL,  init?: RequestInit) => {
      const parsed = new URL(String(url));
      const method = init?.method ?? 'GET';
      const body =
        typeof init?.body === 'string' && init.body
          ? JSON.parse(init.body)
          : undefined;
      calls.push({ path: parsed.pathname, method, ...(body ? { body } : {}) });

      switch (parsed.pathname: unknown) {
        case '/babelfish/code/preview':
          return new Response(JSON.stringify({ previewId: 'babel-preview' }), {
            headers: { 'Content-Type': 'application/json' },
          });
        case '/cera/daydream/dream':
          return new Response(JSON.stringify({ id: 'dream-1', ok: true }), {
            headers: { 'Content-Type': 'application/json' },
          });
        case '/agent/multi-file':
          return new Response(JSON.stringify({ previewId: 'multi-preview' }), {
            headers: { 'Content-Type': 'application/json' },
          });
        case '/forge/projects':
          return new Response(
            JSON.stringify({
              projects: [
                { name: 'agent-a', kind: 'agent' },
                { name: 'site-a', kind: 'site' },
              ],
            }),
            { headers: { 'Content-Type': 'application/json' } },
          );
        case '/agent/swarm/start':
          return new Response(JSON.stringify({ sessionId: 'swarm-1' }), {
            headers: { 'Content-Type': 'application/json' },
          });
        case '/cloud-agent/sessions':
          return new Response(JSON.stringify({ sessions: ['cloud-1'] }), {
            headers: { 'Content-Type': 'application/json' },
          });
        case '/tts/preview':
          return new Response(
            JSON.stringify({
              text: 'ready',
              audioMode: 'file',
              filePath: '/tmp/zedge-tts.wav',
              playback: false,
            }),
            { headers: { 'Content-Type': 'application/json' } },
          );
        default:
          return new Response(JSON.stringify({ error: parsed.pathname }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          });
      }
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const babelfish = await callLocalTool('zedge_babelfish_code', {
      scope: { kind: 'inline', filePath: 'source.ts', sourceText: 'const x = 1;' },
      targetLanguage: 'rust',
      mode: 'translate-code',
      outputMode: 'preview',
    });
    const daydream = await callLocalTool('zedge_daydream', {
      action: 'dream',
      file_path: 'source.ts',
    });
    const multiFile = await callLocalTool('zedge_multi_file_edit', {
      instruction: 'make the companion route agent tools',
      target_files: ['source.ts'],
    });
    const ggAgent = await callLocalTool('zedge_gg_agent', { action: 'list' });
    const swarm = await callLocalTool('zedge_swarm', {
      action: 'start',
      task: 'check the wiring',
      roles: ['reviewer'],
      target_files: ['source.ts'],
    });
    const cloudAgent = await callLocalTool('zedge_cloud_agent', {
      action: 'sessions',
    });
    const tts = await callLocalTool('zedge_tts_preview', { input: 'ready' });

    expect(textFromToolResult(babelfish)).toContain('babel-preview');
    expect(textFromToolResult(daydream)).toContain('dream-1');
    expect(textFromToolResult(multiFile)).toContain('multi-preview');
    expect(textFromToolResult(ggAgent)).toContain('"count": 1');
    expect(textFromToolResult(swarm)).toContain('swarm-1');
    expect(textFromToolResult(cloudAgent)).toContain('cloud-1');
    expect(textFromToolResult(tts)).toContain('zedge-tts.wav');
    expect(calls).toEqual([
      {
        path: '/babelfish/code/preview',
        method: 'POST',
        body: {
          scope: {
            kind: 'inline',
            filePath: 'source.ts',
            sourceText: 'const x = 1;',
          },
          targetLanguage: 'rust',
          mode: 'translate-code',
          outputMode: 'preview',
        },
      },
      {
        path: '/cera/daydream/dream',
        method: 'POST',
        body: { file_path: 'source.ts' },
      },
      {
        path: '/agent/multi-file',
        method: 'POST',
        body: {
          instruction: 'make the companion route agent tools',
          target_files: ['source.ts'],
        },
      },
      { path: '/forge/projects', method: 'GET' },
      {
        path: '/agent/swarm/start',
        method: 'POST',
        body: {
          task: 'check the wiring',
          roles: ['reviewer'],
          target_files: ['source.ts'],
        },
      },
      { path: '/cloud-agent/sessions', method: 'GET' },
      {
        path: '/tts/preview',
        method: 'POST',
        body: { input: 'ready' },
      },
    ]);
  });
});
