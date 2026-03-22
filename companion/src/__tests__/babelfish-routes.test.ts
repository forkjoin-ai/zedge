import {
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

mock.module('../config', () => ({
  getZedgeConfig: () => ({
    port: 7331,
    computePool: {
      enabled: false,
      maxCpuPercent: 50,
      maxMemoryMb: 2048,
      allowedModels: ['tinyllama-1.1b'],
    },
    preferredModel: 'tinyllama-1.1b',
    cloudRunDirect: true,
    babelfish: {
      enabled: true,
      ambientSuggestions: true,
      defaultHumanLanguage: 'fr',
      requirePreviewForInPlaceRewrite: true,
    },
  }),
}));

mock.module('../babelfish-gnosis', () => ({
  getPolyglotCapabilityMatrix: async () => ({
    registrySource: 'mock-registry',
    languages: [
      {
        id: 'typescript',
        displayName: 'TypeScript',
        operations: {
          analyze: 'supported',
          explain: 'supported',
          scaffold: 'supported',
          translate: 'supported',
          rewritePreview: 'experimental',
        },
      },
      {
        id: 'rust',
        displayName: 'Rust',
        operations: {
          analyze: 'supported',
          explain: 'supported',
          scaffold: 'supported',
          translate: 'supported',
          rewritePreview: 'experimental',
        },
      },
    ],
  }),
  analyzePolyglotSourceString: async (sourceText: string, filePath: string) => ({
    filePath,
    language: filePath.endsWith('.rs') ? 'rust' : 'typescript',
    functions: [
      {
        functionName: 'greet',
        ggSource: '(greet:PROCESS)',
        ast: { nodes: new Map(), edges: [] },
      },
    ],
    errors: sourceText.includes('warn-me') ? ['mock warning'] : [],
  }),
  translate: (
    _analysis: unknown,
    sourceFilePath: string,
    targetLanguage: string
  ) => ({
    ggSource: `// ${sourceFilePath} -> ${targetLanguage}`,
    files: [
      {
        fileName: targetLanguage === 'rust' ? 'greet.rs' : 'greet.ts',
        source:
          targetLanguage === 'rust'
            ? 'pub fn greet() -> &' + "'static str" + ' { "hola mundo" }\n'
            : 'export function greet() { return "hello world"; }\n',
      },
    ],
  }),
  extractFunctions: () => [
    {
      name: 'greet',
      nodeCount: 3,
      edgeTypes: ['PROCESS'],
    },
  ],
}));

const { handleBabelfishRequest } = await import('../babelfish-routes');
const { resetBabelfishStateForTest } = await import('../babelfish');

function jsonRequest(pathname: string, body?: Record<string, unknown>): Request {
  return new Request(`http://localhost:7331${pathname}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe('Babelfish HTTP routes', () => {
  beforeEach(() => {
    resetBabelfishStateForTest();
  });

  test('capabilities route returns the Gnosis-backed capability matrix', async () => {
    const response = await handleBabelfishRequest(
      jsonRequest('/babelfish/capabilities')
    );

    expect(response).not.toBeNull();
    expect(response?.status).toBe(200);

    const payload = await response?.json();
    expect(payload.registrySource).toBe('mock-registry');
    expect(payload.languages.map((language: { id: string }) => language.id)).toEqual([
      'typescript',
      'rust',
    ]);
  });

  test('code preview returns the standardized payload and preview-only tokens cannot rewrite in place', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'babelfish-route-preview-'));
    const filePath = path.join(dir, 'input.ts');
    writeFileSync(filePath, 'export const greet = () => "hello";\n', 'utf8');

    const previewResponse = await handleBabelfishRequest(
      jsonRequest('/babelfish/code/preview', {
        scope: { kind: 'file', filePath },
        targetLanguage: 'rust',
        mode: 'translate-code',
        outputMode: 'preview',
      })
    );

    expect(previewResponse?.status).toBe(200);
    const preview = await previewResponse?.json();
    expect(preview.previewId).toEqual(expect.any(String));
    expect(preview.summary).toContain('Prepared translate-code preview');
    expect(preview.generatedFiles).toHaveLength(1);
    expect(preview.diff).toContain('pub fn greet');

    const rejectedRewriteResponse = await handleBabelfishRequest(
      jsonRequest('/babelfish/code/apply', {
        previewId: preview.previewId,
        applyMode: 'rewrite_in_place',
      })
    );

    expect(rejectedRewriteResponse?.status).toBe(400);
    const rejectedRewrite = await rejectedRewriteResponse?.json();
    expect(rejectedRewrite.error).toContain(
      'only supports apply modes: generate_files'
    );
    expect(readFileSync(filePath, 'utf8')).toContain('hello');

    const applyResponse = await handleBabelfishRequest(
      jsonRequest('/babelfish/code/apply', {
        previewId: preview.previewId,
        applyMode: 'generate_files',
      })
    );

    expect(applyResponse?.status).toBe(200);
    expect(existsSync(path.join(dir, 'greet.rs'))).toBe(true);

    const repeatedApplyResponse = await handleBabelfishRequest(
      jsonRequest('/babelfish/code/apply', {
        previewId: preview.previewId,
        applyMode: 'generate_files',
      })
    );

    expect(repeatedApplyResponse?.status).toBe(400);
    const repeatedApply = await repeatedApplyResponse?.json();
    expect(repeatedApply.error).toContain('Unknown previewId');
  });

  test('rewrite_in_place_requested does not mutate until apply and remains single-use', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'babelfish-route-rewrite-'));
    const filePath = path.join(dir, 'input.ts');
    writeFileSync(filePath, 'export const greet = () => "hello";\n', 'utf8');

    const previewResponse = await handleBabelfishRequest(
      jsonRequest('/babelfish/code/preview', {
        scope: { kind: 'file', filePath },
        targetLanguage: 'rust',
        mode: 'rewrite-preview',
        outputMode: 'rewrite_in_place_requested',
      })
    );

    const preview = await previewResponse?.json();
    expect(previewResponse?.status).toBe(200);
    expect(preview.summary).toContain('Prepared in-place rewrite preview');
    expect(readFileSync(filePath, 'utf8')).toContain('hello');

    const applyResponse = await handleBabelfishRequest(
      jsonRequest('/babelfish/code/apply', {
        previewId: preview.previewId,
        applyMode: 'rewrite_in_place',
      })
    );

    expect(applyResponse?.status).toBe(200);
    expect(readFileSync(filePath, 'utf8')).toContain('pub fn greet');

    const repeatedApplyResponse = await handleBabelfishRequest(
      jsonRequest('/babelfish/code/apply', {
        previewId: preview.previewId,
        applyMode: 'rewrite_in_place',
      })
    );

    expect(repeatedApplyResponse?.status).toBe(400);
    const repeatedApply = await repeatedApplyResponse?.json();
    expect(repeatedApply.error).toContain('Unknown previewId');
  });

  test('text translation route preserves fenced and inline code', async () => {
    const response = await handleBabelfishRequest(
      jsonRequest('/babelfish/text/translate', {
        scope: {
          kind: 'inline',
          filePath: 'README.md',
          sourceText:
            'hello world\n\n```ts\nconsole.log("hello world");\n```\n\nUse `hello_world()` here.\n',
          diagnostics: [{ message: 'error in hello world' }],
        },
        targetHumanLanguage: 'es',
        includeDiagnostics: true,
        includeMarkdown: true,
      })
    );

    expect(response?.status).toBe(200);
    const payload = await response?.json();
    expect(payload.translatedText).toContain('hola mundo');
    expect(payload.translatedText).toContain('console.log("hello world");');
    expect(payload.translatedText).toContain('`hello_world()`');
    expect(payload.translatedDiagnostics[0]?.message).toContain('hola mundo');
  });

  test('explain route falls back to the configured audience language', async () => {
    const response = await handleBabelfishRequest(
      jsonRequest('/babelfish/explain', {
        scope: {
          kind: 'inline',
          filePath: 'input.ts',
          sourceText: 'export const greet = () => "hello";\n',
        },
        includeGg: true,
      })
    );

    expect(response?.status).toBe(200);
    const payload = await response?.json();
    expect(payload.audienceLanguage).toBe('fr');
    expect(payload.ggSource).toContain('(greet:PROCESS)');
  });
});
