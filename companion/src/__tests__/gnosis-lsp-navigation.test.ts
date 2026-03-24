import { describe, test, expect } from 'bun:test';
import { dispatchRequest } from '../gnosis-lsp';

const GG_SOURCE = `
(start:Sensor | temperature)
(filter:Process | threshold: 100)
(output:Sink | format: json)

start -[FORK]-> filter
filter -[RACE]-> output
filter -[VENT]-> void
`;

async function initLsp(): Promise<void> {
  await dispatchRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { capabilities: {} },
  });
  await dispatchRequest({
    jsonrpc: '2.0',
    method: 'initialized',
  });
  await dispatchRequest({
    jsonrpc: '2.0',
    method: 'textDocument/didOpen',
    params: {
      textDocument: {
        uri: 'file:///test/topology.gg',
        languageId: 'gnosis',
        version: 1,
        text: GG_SOURCE,
      },
    },
  });
}

describe('Gnosis LSP Navigation', () => {
  test('initialize reports definition and references providers', async () => {
    const result = (await dispatchRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { capabilities: {} },
    })) as Record<string, unknown>;
    const caps = result.capabilities as Record<string, unknown>;
    expect(caps.definitionProvider).toBe(true);
    expect(caps.referencesProvider).toBe(true);
  });

  test('textDocument/definition finds node declaration', async () => {
    await initLsp();

    // "filter" appears on line 2 (declaration) and line 5/6 (edges)
    // Ask for definition at line 5 (0-indexed), char ~0 which has "start"
    const result = await dispatchRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'textDocument/definition',
      params: {
        textDocument: { uri: 'file:///test/topology.gg' },
        position: { line: 5, character: 0 },
      },
    });

    expect(result).not.toBeNull();
    if (result) {
      const loc = result as { uri: string; range: { start: { line: number } } };
      expect(loc.uri).toBe('file:///test/topology.gg');
      // Should point to first declaration of "start"
      expect(loc.range.start.line).toBe(1); // (start:Sensor ...) is line 1
    }
  });

  test('textDocument/definition returns null for unknown token', async () => {
    await initLsp();
    const result = await dispatchRequest({
      jsonrpc: '2.0',
      id: 3,
      method: 'textDocument/definition',
      params: {
        textDocument: { uri: 'file:///test/topology.gg' },
        position: { line: 0, character: 0 }, // empty line
      },
    });
    expect(result).toBeNull();
  });

  test('textDocument/references finds all occurrences of a node', async () => {
    await initLsp();

    // "filter" appears on line 2 (decl), line 5, line 6, line 7
    const result = await dispatchRequest({
      jsonrpc: '2.0',
      id: 4,
      method: 'textDocument/references',
      params: {
        textDocument: { uri: 'file:///test/topology.gg' },
        position: { line: 2, character: 1 }, // "filter" on declaration line
      },
    });

    expect(Array.isArray(result)).toBe(true);
    const refs = result as Array<{ uri: string; range: { start: { line: number } } }>;
    // "filter" should appear at least 3 times (decl + 2 edge refs)
    expect(refs.length).toBeGreaterThanOrEqual(3);
  });

  test('textDocument/references returns empty for unknown token', async () => {
    await initLsp();
    const result = await dispatchRequest({
      jsonrpc: '2.0',
      id: 5,
      method: 'textDocument/references',
      params: {
        textDocument: { uri: 'file:///test/topology.gg' },
        position: { line: 0, character: 0 },
      },
    });
    expect(Array.isArray(result)).toBe(true);
    expect((result as unknown[]).length).toBe(0);
  });

  test('hover still works for keywords', async () => {
    await initLsp();
    const result = await dispatchRequest({
      jsonrpc: '2.0',
      id: 6,
      method: 'textDocument/hover',
      params: {
        textDocument: { uri: 'file:///test/topology.gg' },
        position: { line: 5, character: 12 }, // "FORK" on the edge line
      },
    });
    expect(result).not.toBeNull();
    if (result) {
      const hover = result as { contents: { value: string } };
      expect(hover.contents.value).toContain('FORK');
    }
  });
});
