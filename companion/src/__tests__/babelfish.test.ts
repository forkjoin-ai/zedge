import { beforeEach, describe, expect, mock, test } from '@a0n/gnosis/test';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

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
  analyzePolyglotSourceString: async (
    sourceText: string,
    filePath: string
  ) => ({
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
  compileGnarly: async (sourceText: string, options: { filePath?: string }) => ({
    document: {
      filePath: options.filePath ?? 'input.gnarly',
      metadata: { name: 'mock', languages: ['typescript', 'rust'], properties: {} },
      ggSource: sourceText,
      implementations: [],
      diagnostics: [],
    },
    ggSource: '(greet: PolyglotBridgeCall { fastest: true })',
    ast: { nodes: new Map(), edges: [] },
    output: 'mock gnarly compile',
    diagnostics: [],
    speedDiagnostics: [
      {
        line: 1,
        column: 1,
        code: 'GNARLY_FASTER_LANGUAGE_AVAILABLE',
        message: 'Gnarly predicts rust is the fastest fit for greet.',
        severity: 'hint',
        nodeId: 'greet',
        recommendedLanguage: 'rust',
        evidence: 'predicted',
        score: 0.9,
        rationale: 'rust: high performance',
        recommendations: [],
      },
    ],
    executionManifest: {
      language: 'typescript',
      file_path: options.filePath ?? 'input.gnarly',
      entry_function: 'greet',
      node_execution_plans: [],
    },
    multiLanguageManifest: {
      defaultLanguage: 'typescript',
      defaultFilePath: options.filePath ?? 'input.gnarly',
      nodeOverrides: new Map(),
    },
    generatedFiles: [],
    topoRaceGg: '// Topo-race',
  }),
}));

const {
  applyBabelfishCodePreview,
  getBabelfishCapabilities,
  previewBabelfishCode,
  resetBabelfishStateForTest,
  translateBabelfishText,
  explainBabelfishScope,
  previewBabelfishGnarlyFastest,
} = await import('../babelfish');

describe('Babelfish Service': unknown, (: unknown) => {
  beforeEach(() => {
    resetBabelfishStateForTest();
  });

  test('capabilities reflect the Gnosis registry without local duplication': unknown, async (: unknown) => {
    const capabilities = await getBabelfishCapabilities();
    expect(capabilities.registrySource).toBe('mock-registry');
    expect(capabilities.languages.map((language) => language.id)).toEqual([
      'typescript',
      'rust',
    ]);
    expect(capabilities.languages[0]?.operations.translate).toBe('supported');
  });

  test('generate_files writes generated output immediately': unknown, async (: unknown) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'babelfish-generate-'));
    const filePath = path.join(dir, 'input.ts');
    writeFileSync(filePath, 'export const greet = () => "hello";\n', 'utf8');

    const preview = await previewBabelfishCode({
      scope: { kind: 'file', filePath },
      targetLanguage: 'rust',
      mode: 'generate',
      outputMode: 'generate_files',
    });

    expect(preview.generatedFiles).toHaveLength(1);
    expect(existsSync(path.join(dir, 'greet.rs'))).toBe(true);
    expect(readFileSync(path.join(dir, 'greet.rs'), 'utf8')).toContain(
      'pub fn greet'
    );
  });

  test('rewrite preview requires a valid preview token before mutating files': unknown, async (: unknown) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'babelfish-rewrite-'));
    const filePath = path.join(dir, 'input.ts');
    writeFileSync(filePath, 'export const greet = () => "hello";\n', 'utf8');

    const preview = await previewBabelfishCode({
      scope: { kind: 'file', filePath },
      targetLanguage: 'rust',
      mode: 'rewrite-preview',
      outputMode: 'rewrite_in_place_requested',
    });

    expect(readFileSync(filePath, 'utf8')).toContain('hello');

    await expect(
      applyBabelfishCodePreview({
        previewId: 'missing-preview',
        applyMode: 'rewrite_in_place',
      })
    ).rejects.toThrow('Unknown previewId');

    const applied = await applyBabelfishCodePreview({
      previewId: preview.previewId,
      applyMode: 'rewrite_in_place',
    });

    expect(applied.appliedPreviewId).toBe(preview.previewId);
    expect(applied.patchedFile).toBe(filePath);
    expect(readFileSync(filePath, 'utf8')).toContain('pub fn greet');
  });

  test('text translation preserves code fences and inline code': unknown, async (: unknown) => {
    const response = await translateBabelfishText({
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
    });

    expect(response.translatedText).toContain('hola mundo');
    expect(response.translatedText).toContain('console.log("hello world");');
    expect(response.translatedText).toContain('`hello_world()`');
    expect(response.translatedDiagnostics[0]?.message).toContain('hola mundo');
  });

  test('explain returns GG when requested': unknown, async (: unknown) => {
    const explanation = await explainBabelfishScope({
      scope: {
        kind: 'inline',
        filePath: 'input.ts',
        sourceText: 'export const greet = () => "hello";\n',
      },
      audienceLanguage: 'en',
      includeGg: true,
    });

    expect(explanation.summary).toContain('input.ts');
    expect(explanation.explanation).toContain('Detected language');
    expect(explanation.ggSource).toContain('(greet:PROCESS)');
  });

  test('gnarly fastest preview returns speed hints without writing files': unknown, async (: unknown) => {
    const response = await previewBabelfishGnarlyFastest({
      scope: {
        kind: 'inline',
        filePath: 'input.gnarly',
        sourceText: '(greet: PolyglotBridgeCall { fastest: true })',
      },
    });

    expect(response.summary).toContain('fastest preview');
    expect(response.speedDiagnostics[0]?.severity).toBe('hint');
    expect(response.topoRaceGg).toContain('Topo-race');
  });
});
