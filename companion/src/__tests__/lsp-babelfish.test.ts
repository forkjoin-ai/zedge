import { beforeEach, describe, expect, test } from 'bun:test';
import {
  buildBabelfishCodeActions,
  buildBabelfishHintDiagnostic,
  detectBabelfishLanguageForUri,
} from '../lsp-babelfish';
import {
  dispatchRequest,
  resetGnosisLspStateForTest,
  setGnosisLspConfigGetterForTest,
  setGnosisLspSendForTest,
} from '../gnosis-lsp';

function testConfig(
  overrides: Partial<{
    enabled: boolean;
    ambientSuggestions: boolean;
    defaultHumanLanguage: string;
  }> = {}
) {
  return {
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
      enabled: overrides.enabled ?? true,
      ambientSuggestions: overrides.ambientSuggestions ?? true,
      defaultHumanLanguage: overrides.defaultHumanLanguage ?? 'en',
      requirePreviewForInPlaceRewrite: true,
    },
  };
}

describe('LSP Babelfish helpers', () => {
  beforeEach(() => {
    resetGnosisLspStateForTest();
  });

  test('detects supported languages from file URIs', () => {
    expect(detectBabelfishLanguageForUri('file:///tmp/example.ts')).toBe(
      'typescript'
    );
    expect(detectBabelfishLanguageForUri('file:///tmp/example.py')).toBe(
      'python'
    );
    expect(detectBabelfishLanguageForUri('file:///tmp/example.txt')).toBeNull();
  });

  test('builds non-mutating ambient hint diagnostics for supported files', () => {
    const diagnostic = buildBabelfishHintDiagnostic(
      'file:///tmp/example.ts'
    );
    expect(diagnostic?.severity).toBe(4);
    expect(diagnostic?.message).toContain('Babelfish available');
    expect(buildBabelfishHintDiagnostic('file:///tmp/example.txt')).toBeNull();
  });

  test('builds code actions for supported files', () => {
    const actions = buildBabelfishCodeActions(
      'file:///tmp/example.ts',
      'en'
    );
    expect(actions).toHaveLength(3);
    expect(actions.map((action) => action.title)).toEqual([
      'Babelfish: Explain File',
      'Babelfish: Translate Code',
      'Babelfish: Generate Target Scaffold',
    ]);
  });

  test('publishes Babelfish hint diagnostics only when ambient suggestions are enabled', async () => {
    const sentMessages: unknown[] = [];
    setGnosisLspSendForTest((message) => {
      sentMessages.push(message);
    });

    setGnosisLspConfigGetterForTest(() =>
      testConfig({ enabled: true, ambientSuggestions: true })
    );
    await dispatchRequest({
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: {
        textDocument: {
          uri: 'file:///tmp/example.py',
          text: 'print("hello")\n',
        },
      },
    });

    const enabledPublish = sentMessages[0] as {
      method: string;
      params: { diagnostics: Array<{ source: string; severity: number }> };
    };
    expect(enabledPublish.method).toBe('textDocument/publishDiagnostics');
    expect(
      enabledPublish.params.diagnostics.some(
        (diagnostic) =>
          diagnostic.source === 'zedge-babelfish' && diagnostic.severity === 4
      )
    ).toBe(true);

    sentMessages.length = 0;
    setGnosisLspConfigGetterForTest(() =>
      testConfig({ enabled: true, ambientSuggestions: false })
    );
    await dispatchRequest({
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: {
        textDocument: {
          uri: 'file:///tmp/example-disabled.py',
          text: 'print("hello")\n',
        },
      },
    });

    const disabledPublish = sentMessages[0] as {
      params: { diagnostics: Array<{ source: string }> };
    };
    expect(
      disabledPublish.params.diagnostics.some(
        (diagnostic) => diagnostic.source === 'zedge-babelfish'
      )
    ).toBe(false);
  });

  test('returns Babelfish code actions for supported files and none for unsupported or disabled files', async () => {
    setGnosisLspConfigGetterForTest(() =>
      testConfig({ enabled: true, defaultHumanLanguage: 'fr' })
    );

    const supportedActions = (await dispatchRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'textDocument/codeAction',
      params: {
        textDocument: { uri: 'file:///tmp/example.ts' },
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        },
        context: { diagnostics: [] },
      },
    })) as Array<{ title: string; command: { arguments: Array<{ audienceLanguage?: string }> } }>;

    expect(supportedActions.map((action) => action.title)).toEqual([
      'Babelfish: Explain File',
      'Babelfish: Translate Code',
      'Babelfish: Generate Target Scaffold',
    ]);
    expect(
      supportedActions[0]?.command.arguments[0]?.audienceLanguage
    ).toBe('fr');

    const unsupportedActions = await dispatchRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'textDocument/codeAction',
      params: {
        textDocument: { uri: 'file:///tmp/example.txt' },
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        },
        context: { diagnostics: [] },
      },
    });
    expect(unsupportedActions).toEqual([]);

    setGnosisLspConfigGetterForTest(() => testConfig({ enabled: false }));
    const disabledActions = await dispatchRequest({
      jsonrpc: '2.0',
      id: 3,
      method: 'textDocument/codeAction',
      params: {
        textDocument: { uri: 'file:///tmp/example.ts' },
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        },
        context: { diagnostics: [] },
      },
    });
    expect(disabledActions).toEqual([]);
  });
});
