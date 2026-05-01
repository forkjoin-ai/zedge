#!/usr/bin/env bun
/**
 * Gnosis Language Server (LSP)
 *
 * Provides real-time diagnostics and topological analysis for Gnosis (.gg, .ggl) files.
 * Speaks JSON-RPC over stdin/stdout.
 */

import {
  BettyCompiler,
  type Diagnostic,
  type GraphAST,
} from '@a0n/gnosis/betty/compiler';
import { compileGnarly } from '@a0n/gnosis/gnarly-compiler';
import { checkTypeScriptWithGnosis } from '@a0n/gnosis/ts-check';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { getZedgeConfig, type ZedgeConfig } from './config';
import {
  buildBabelfishCodeActions,
  buildBabelfishHintDiagnostic,
} from './lsp-babelfish';
import { provideBabelfishHover } from './babelfish-lsp';
import { handleGnotCommand } from './gnot-bridge';

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

interface Position {
  line: number;
  character: number;
}

interface Range {
  start: Position;
  end: Position;
}

interface LspDiagnostic {
  range: Range;
  severity: 1 | 2 | 3 | 4;
  message: string;
  source: string;
  code?: string;
  data?: unknown;
}

interface CompletionItem {
  label: string;
  kind: number;
}

const compiler = new BettyCompiler();
const documents = new Map<string, string>();
const keywordSet = new Set([
  'FORK',
  'RACE',
  'FOLD',
  'VENT',
  'PROCESS',
  'COLLAPSE',
  'TUNNEL',
  'INTERFERE',
  'MEASURE',
  'HALT',
  'EVOLVE',
  'ENTANGLE',
  'SUPERPOSE',
  'OBSERVE',
]);

let transportBuffer = Buffer.alloc(0);
let shutdownRequested = false;
let configGetter: () => ZedgeConfig = getZedgeConfig;

type SendHandler = (message: unknown) => void;

function log(message: string): void {
  console.error(`[gnosis-lsp] ${message}`);
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  return value as Record<string, unknown>;
}

function getString(
  object: Record<string, unknown>,
  key: string
): string | null {
  const value = object[key];
  return typeof value === 'string' ? value : null;
}

function getPosition(params: unknown): Position | null {
  const paramsObj = asObject(params);
  if (!paramsObj) {
    return null;
  }

  const position = asObject(paramsObj.position);
  if (!position) {
    return null;
  }

  const line = position.line;
  const character = position.character;
  if (typeof line !== 'number' || typeof character !== 'number') {
    return null;
  }

  return { line, character };
}

function getUriFromParams(params: unknown): string | null {
  const paramsObj = asObject(params);
  if (!paramsObj) {
    return null;
  }
  const textDocument = asObject(paramsObj.textDocument);
  if (!textDocument) {
    return null;
  }
  return getString(textDocument, 'uri');
}

function getExecuteCommandParams(
  params: unknown
): { command: string; arguments: unknown[] } | null {
  const paramsObj = asObject(params);
  if (!paramsObj) {
    return null;
  }
  const command = getString(paramsObj, 'command');
  const args = paramsObj.arguments;
  if (!command || !Array.isArray(args)) {
    return null;
  }
  return { command, arguments: args };
}

function uriFromScopeArgument(argument: unknown): string | null {
  const object = asObject(argument);
  const scope = object ? asObject(object.scope) : null;
  const filePath = scope ? getString(scope, 'filePath') : null;
  if (!filePath) {
    return null;
  }
  return filePath.startsWith('file://') ? filePath : `file://${filePath}`;
}

async function executeGnarlyCommand(params: unknown): Promise<unknown> {
  const commandParams = getExecuteCommandParams(params);
  if (!commandParams) {
    return null;
  }
  if (!commandParams.command.startsWith('zedge.gnarly.')) {
    return null;
  }

  const uri = uriFromScopeArgument(commandParams.arguments[0]);
  if (!uri) {
    return { error: 'Gnarly command requires a file scope.' };
  }
  const sourceText = documents.get(uri);
  if (sourceText === undefined) {
    return { error: `No open document for ${uri}.` };
  }
  const filePath = uri.startsWith('file://') ? uri.slice(7) : uri;
  const result = await compileGnarly(sourceText, { filePath });

  if (commandParams.command === 'zedge.gnarly.generateMissing') {
    return {
      generatedFiles: result.generatedFiles.filter((file) => !file.embedded),
      speedDiagnostics: result.speedDiagnostics,
    };
  }

  if (commandParams.command === 'zedge.gnarly.explainPath') {
    return {
      summary: `Gnarly topology has ${result.executionManifest.node_execution_plans.length} execution node(s), ${result.document.implementations.length} embedded implementation(s), and ${result.speedDiagnostics.length} speed hint(s).`,
      ggSource: result.ggSource,
      speedDiagnostics: result.speedDiagnostics,
    };
  }

  return {
    summary:
      commandParams.command === 'zedge.gnarly.fastest'
        ? `Prepared Gnarly fastest preview with ${result.speedDiagnostics.length} speed hint(s).`
        : `Compiled Gnarly topology with ${result.executionManifest.node_execution_plans.length} execution plan node(s).`,
    ggSource: result.ggSource,
    speedDiagnostics: result.speedDiagnostics,
    diagnostics: result.diagnostics,
    generatedFiles: result.generatedFiles,
    topoRaceGg: result.topoRaceGg,
  };
}

function getDidOpenDocument(
  params: unknown
): { uri: string; text: string } | null {
  const paramsObj = asObject(params);
  if (!paramsObj) {
    return null;
  }

  const textDocument = asObject(paramsObj.textDocument);
  if (!textDocument) {
    return null;
  }

  const uri = getString(textDocument, 'uri');
  const text = getString(textDocument, 'text');
  if (!uri || text === null) {
    return null;
  }

  return { uri, text };
}

function getDidChangeDocument(
  params: unknown
): { uri: string; text: string } | null {
  const paramsObj = asObject(params);
  if (!paramsObj) {
    return null;
  }

  const textDocument = asObject(paramsObj.textDocument);
  const contentChanges = paramsObj.contentChanges;
  if (
    !textDocument ||
    !Array.isArray(contentChanges) ||
    contentChanges.length < 1
  ) {
    return null;
  }

  const uri = getString(textDocument, 'uri');
  const firstChange = asObject(contentChanges[0]);
  const text = firstChange ? getString(firstChange, 'text') : null;
  if (!uri || text === null) {
    return null;
  }

  return { uri, text };
}

function diagnosticSeverity(value: Diagnostic['severity']): 1 | 2 | 3 {
  if (value === 'error') return 1;
  if (value === 'warning') return 2;
  return 3;
}

function toLspDiagnostic(
  diagnostic: Diagnostic,
  sourceText: string
): LspDiagnostic {
  const lines = sourceText.split('\n');
  const line = Math.max(0, diagnostic.line - 1);
  const character = Math.max(0, diagnostic.column - 1);
  const lineText = lines[line] ?? '';
  const endCharacter =
    lineText.length > character ? character + 1 : lineText.length;

  return {
    range: {
      start: { line, character },
      end: { line, character: endCharacter },
    },
    severity: diagnosticSeverity(diagnostic.severity),
    message: diagnostic.message,
    source: 'gnosis-betty',
  };
}

function defaultSend(message: unknown): void {
  const json = JSON.stringify(message);
  process.stdout.write(
    `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`
  );
}

let sendHandler: SendHandler = defaultSend;

export function setGnosisLspSendForTest(handler: SendHandler | null): void {
  sendHandler = handler ?? defaultSend;
}

export function setGnosisLspConfigGetterForTest(
  handler: (() => ZedgeConfig) | null
): void {
  configGetter = handler ?? getZedgeConfig;
}

export function resetGnosisLspStateForTest(): void {
  documents.clear();
  transportBuffer = Buffer.alloc(0);
  shutdownRequested = false;
  sendHandler = defaultSend;
  configGetter = getZedgeConfig;
}

function send(message: unknown): void {
  sendHandler(message);
}

function sendResponse(id: JsonRpcId, result: unknown): void {
  send({
    jsonrpc: '2.0',
    id,
    result,
  });
}

function sendError(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown
): void {
  send({
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
      data,
    },
  });
}

function isTypeScriptUri(uri: string): boolean {
  return uri.endsWith('.ts') || uri.endsWith('.tsx');
}

function isGnotUri(uri: string): boolean {
  return uri.endsWith('.gnot');
}

function isGnarlyUri(uri: string): boolean {
  return uri.endsWith('.gnarly');
}

async function publishTypeScriptDiagnostics(
  uri: string,
  text: string
): Promise<void> {
  try {
    const filePath = uri.startsWith('file://') ? uri.slice(7) : uri;
    const result = await checkTypeScriptWithGnosis(text, filePath);
    const diagnostics: LspDiagnostic[] = result.diagnostics.map((d) => ({
      range: {
        start: { line: d.line - 1, character: d.column - 1 },
        end: {
          line: (d.endLine ?? d.line) - 1,
          character: (d.endColumn ?? d.column) - 1,
        },
      },
      severity: d.level === 'error' ? 1 : d.level === 'warning' ? 2 : 3,
      message: `[${d.ruleId}] ${d.message}`,
      source: 'gnosis-ts',
    }));
    const config = configGetter();
    if (config.babelfish.enabled && config.babelfish.ambientSuggestions) {
      const hint = buildBabelfishHintDiagnostic(uri);
      if (hint) {
        diagnostics.push(hint);
      }
    }

    send({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: { uri, diagnostics },
    });
  } catch {
    // TS files that can't be bridged produce no diagnostics
    send({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: { uri, diagnostics: [] },
    });
  }
}

async function publishGnotDiagnostics(
  uri: string,
  text: string
): Promise<void> {
  try {
    const filePath = uri.startsWith('file://') ? uri.slice(7) : uri;
    const result = await handleGnotCommand({
      action: 'lint',
      filePath,
      sourceText: text,
      timeoutMs: 5000,
    });
    
    // Convert gnot diagnostics to LSP diagnostics
    const diagnostics: LspDiagnostic[] = [];
    if (Array.isArray(result.diagnostics)) {
      for (const d of result.diagnostics) {
        if (!d.line || !d.column || !d.message) continue;
        const line = Math.max(0, d.line - 1);
        const character = Math.max(0, d.column - 1);
        diagnostics.push({
          range: {
            start: { line, character },
            end: { line, character: character + 1 }, // Simple range for structural tokens
          },
          severity: d.severity === 'error' ? 1 : d.severity === 'warning' ? 2 : 3,
          message: `[gnot] ${d.message}`,
          source: 'gnot-compiler',
        });
      }
    }

    send({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: { uri, diagnostics },
    });
  } catch (err) {
    send({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: { uri, diagnostics: [] },
    });
  }
}

async function publishGnarlyDiagnostics(
  uri: string,
  text: string
): Promise<void> {
  try {
    const filePath = uri.startsWith('file://') ? uri.slice(7) : uri;
    const result = await compileGnarly(text, { filePath });
    const diagnostics: LspDiagnostic[] = [
      ...result.diagnostics.map((diagnostic) => ({
        range: {
          start: {
            line: Math.max(0, diagnostic.line - 1),
            character: Math.max(0, diagnostic.column - 1),
          },
          end: {
            line: Math.max(0, diagnostic.line - 1),
            character: Math.max(0, diagnostic.column),
          },
        },
        severity:
          diagnostic.severity === 'error'
            ? 1
            : diagnostic.severity === 'warning'
            ? 2
            : diagnostic.severity === 'hint'
            ? 4
            : 3,
        message: `[${diagnostic.code}] ${diagnostic.message}`,
        source: 'gnosis-gnarly',
        code: diagnostic.code,
      })),
      ...result.speedDiagnostics.map((diagnostic) => ({
        range: {
          start: {
            line: Math.max(0, diagnostic.line - 1),
            character: Math.max(0, diagnostic.column - 1),
          },
          end: {
            line: Math.max(0, diagnostic.line - 1),
            character: Math.max(0, diagnostic.column),
          },
        },
        severity: 4 as const,
        message: `[${diagnostic.code}] ${diagnostic.message}`,
        source: 'gnosis-gnarly-speed',
        code: diagnostic.code,
        data: {
          nodeId: diagnostic.nodeId,
          recommendedLanguage: diagnostic.recommendedLanguage,
          evidence: diagnostic.evidence,
        },
      })),
    ];

    send({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: { uri, diagnostics },
    });
  } catch {
    send({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: { uri, diagnostics: [] },
    });
  }
}

async function publishDiagnostics(uri: string, text: string): Promise<void> {
  if (isTypeScriptUri(uri)) {
    await publishTypeScriptDiagnostics(uri, text);
    return;
  }

  if (isGnotUri(uri)) {
    await publishGnotDiagnostics(uri, text);
    return;
  }

  if (isGnarlyUri(uri)) {
    await publishGnarlyDiagnostics(uri, text);
    return;
  }

  const parseResult = compiler.parse(text);
  const diagnostics = parseResult.diagnostics.map((diagnostic) =>
    toLspDiagnostic(diagnostic, text)
  );
  const config = configGetter();
  if (config.babelfish.enabled && config.babelfish.ambientSuggestions) {
    const hint = buildBabelfishHintDiagnostic(uri);
    if (hint) {
      diagnostics.push(hint);
    }
  }

  send({
    jsonrpc: '2.0',
    method: 'textDocument/publishDiagnostics',
    params: {
      uri,
      diagnostics,
    },
  });
}

function tokenAt(lineText: string, character: number): string | null {
  const tokenRegex = /[A-Za-z_][A-Za-z0-9_]*/g;
  let match: RegExpExecArray | null = tokenRegex.exec(lineText);

  while (match) {
    const token = match[0];
    const start = match.index;
    const end = start + token.length;
    if (character >= start && character <= end) {
      return token;
    }
    match = tokenRegex.exec(lineText);
  }

  return null;
}

function nodeHoverMarkdown(token: string, ast: GraphAST): string | null {
  const node = ast.nodes.get(token);
  if (!node) {
    return null;
  }

  const labelText = node.labels.length > 0 ? node.labels.join(', ') : 'none';
  const propertyEntries = Object.entries(node.properties);
  const propertiesText =
    propertyEntries.length > 0
      ? propertyEntries
          .map(([key, value]) => `- \`${key}\`: ${value}`)
          .join('\n')
      : '- none';

  return `### Node \`${token}\`\nLabels: ${labelText}\nProperties:\n${propertiesText}`;
}

function keywordHoverMarkdown(keyword: string): string | null {
  const docs: Record<string, string> = {
    FORK: 'Split execution into parallel branches.',
    RACE: 'Collapse to the fastest valid branch.',
    FOLD: 'Merge parallel branches deterministically.',
    VENT: 'Dissipate non-productive branches.',
    TUNNEL: 'Route around congestion with controlled flow.',
    COLLAPSE: 'Resolve superposition into a scalar state.',
    INTERFERE: 'Apply constructive or destructive path interference.',
    PROCESS: 'Perform payload transformation on a path.',
    OBSERVE: 'Read and collapse state at a boundary.',
  };

  return docs[keyword] ? `### ${keyword}\n${docs[keyword]}` : null;
}

function buildDocumentSymbols(
  uri: string,
  text: string
): Array<Record<string, unknown>> {
  const symbols: Array<Record<string, unknown>> = [];
  const lines = text.split('\n');

  lines.forEach((lineText, line) => {
    const nodeRegex = /\(([^:)\s|{}]+)/g;
    let match: RegExpExecArray | null = nodeRegex.exec(lineText);

    while (match) {
      const nodeId = match[1];
      const startCharacter = match.index + 1;
      const endCharacter = startCharacter + nodeId.length;
      const range: Range = {
        start: { line, character: startCharacter },
        end: { line, character: endCharacter },
      };

      symbols.push({
        name: nodeId,
        kind: 13, // SymbolKind.Variable
        location: {
          uri,
          range,
        },
      });

      match = nodeRegex.exec(lineText);
    }
  });

  return symbols;
}

function buildCompletionItems(labels: string[]): CompletionItem[] {
  return labels.map((label) => ({
    label,
    kind: keywordSet.has(label) ? 14 : 6, // 14=Keyword, 6=Variable
  }));
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  const object = asObject(value);
  if (!object) return false;
  return object.jsonrpc === '2.0' && typeof object.method === 'string';
}

export async function dispatchRequest(req: JsonRpcRequest): Promise<unknown> {
  switch (req.method) {
    case 'initialize':
      return {
        capabilities: {
          textDocumentSync: {
            openClose: true,
            change: 1, // TextDocumentSyncKind.Full
          },
          hoverProvider: true,
          documentSymbolProvider: true,
          codeActionProvider: true,
          executeCommandProvider: {
            commands: [
              'zedge.gnarly.compile',
              'zedge.gnarly.fastest',
              'zedge.gnarly.generateMissing',
              'zedge.gnarly.explainPath',
            ],
          },
          completionProvider: {
            triggerCharacters: [':', '(', '['],
          },
          definitionProvider: true,
          referencesProvider: true,
        },
        serverInfo: {
          name: 'gnosis-lsp',
          version: '1.2.0',
        },
      };

    case 'initialized':
      return null;

    case 'textDocument/didOpen': {
      const opened = getDidOpenDocument(req.params);
      if (opened) {
        documents.set(opened.uri, opened.text);
        await publishDiagnostics(opened.uri, opened.text);
      }
      return null;
    }

    case 'textDocument/didChange': {
      const changed = getDidChangeDocument(req.params);
      if (changed) {
        documents.set(changed.uri, changed.text);
        await publishDiagnostics(changed.uri, changed.text);
      }
      return null;
    }

    case 'textDocument/didClose': {
      const uri = getUriFromParams(req.params);
      if (uri) {
        documents.delete(uri);
        send({
          jsonrpc: '2.0',
          method: 'textDocument/publishDiagnostics',
          params: {
            uri,
            diagnostics: [],
          },
        });
      }
      return null;
    }

    case 'textDocument/didSave': {
      const uri = getUriFromParams(req.params);
      if (uri) {
        const text = documents.get(uri);
        if (text !== undefined) {
          await publishDiagnostics(uri, text);
        }
      }
      return null;
    }

    case 'textDocument/documentSymbol': {
      const uri = getUriFromParams(req.params);
      if (!uri) {
        return [];
      }

      const text = documents.get(uri) ?? '';
      return buildDocumentSymbols(uri, text);
    }

    case 'textDocument/completion': {
      const uri = getUriFromParams(req.params);
      const position = getPosition(req.params);
      if (!uri || !position) {
        return { isIncomplete: false, items: [] };
      }

      const text = documents.get(uri) ?? '';
      compiler.parse(text);
      const sourceLine = text.split('\n')[position.line] ?? '';
      const labels = compiler.getCompletions(sourceLine, position.character);

      return {
        isIncomplete: false,
        items: buildCompletionItems(labels),
      };
    }

    case 'textDocument/hover': {
      const uri = getUriFromParams(req.params);
      const position = getPosition(req.params);
      if (!uri || !position) {
        return null;
      }

      const text = documents.get(uri) ?? '';
      
      // Intercept hover with Babelfish hooks if enabled
      const config = configGetter();
      if (config.babelfish.enabled) {
        const babelHover = await provideBabelfishHover({ uri, position, sourceText: text });
        if (babelHover) return babelHover;
      }

      const sourceLine = text.split('\n')[position.line] ?? '';
      const token = tokenAt(sourceLine, position.character);
      if (!token) {
        return null;
      }

      const uppercaseToken = token.toUpperCase();
      const parseResult = compiler.parse(text);
      const keywordHelp = keywordHoverMarkdown(uppercaseToken);
      const nodeHelp = parseResult.ast
        ? nodeHoverMarkdown(token, parseResult.ast)
        : null;
      const help = keywordHelp ?? nodeHelp;

      if (!help) {
        return null;
      }

      return {
        contents: {
          kind: 'markdown',
          value: help,
        },
      };
    }

    case 'textDocument/definition': {
      const uri = getUriFromParams(req.params);
      const position = getPosition(req.params);
      if (!uri || !position) return null;

      const text = documents.get(uri) ?? '';
      const sourceLine = text.split('\n')[position.line] ?? '';
      const token = tokenAt(sourceLine, position.character);
      if (!token) return null;

      // Search all open documents for the node declaration
      for (const [docUri, docText] of documents) {
        const lines = docText.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const nodeRegex = /\(([^:)\s|{}]+)/g;
          let match: RegExpExecArray | null = nodeRegex.exec(lines[i]);
          while (match) {
            if (match[1] === token) {
              const startChar = match.index + 1;
              return {
                uri: docUri,
                range: {
                  start: { line: i, character: startChar },
                  end: { line: i, character: startChar + token.length },
                },
              };
            }
            match = nodeRegex.exec(lines[i]);
          }
        }
      }

      // Also check for edge type keywords -- jump to first usage
      if (keywordSet.has(token.toUpperCase())) {
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const idx = lines[i].indexOf(token.toUpperCase());
          if (idx >= 0) {
            return {
              uri,
              range: {
                start: { line: i, character: idx },
                end: { line: i, character: idx + token.length },
              },
            };
          }
        }
      }

      return null;
    }

    case 'textDocument/references': {
      const uri = getUriFromParams(req.params);
      const position = getPosition(req.params);
      if (!uri || !position) return [];

      const text = documents.get(uri) ?? '';
      const sourceLine = text.split('\n')[position.line] ?? '';
      const token = tokenAt(sourceLine, position.character);
      if (!token) return [];

      const references: Array<{ uri: string; range: Range }> = [];

      // Search all open documents for references to this token
      for (const [docUri, docText] of documents) {
        const lines = docText.split('\n');
        for (let i = 0; i < lines.length; i++) {
          // Match as node reference in edge declarations or node declarations
          const tokenRegex = new RegExp(`\\b${token}\\b`, 'g');
          let match: RegExpExecArray | null = tokenRegex.exec(lines[i]);
          while (match) {
            references.push({
              uri: docUri,
              range: {
                start: { line: i, character: match.index },
                end: { line: i, character: match.index + token.length },
              },
            });
            match = tokenRegex.exec(lines[i]);
          }
        }
      }

      return references;
    }

    case 'textDocument/codeAction': {
      const uri = getUriFromParams(req.params);
      if (!uri) {
        return [];
      }

      const config = configGetter();
      if (!config.babelfish.enabled) {
        return [];
      }

      return buildBabelfishCodeActions(
        uri,
        config.babelfish.defaultHumanLanguage
      );
    }

    case 'workspace/executeCommand':
      return executeGnarlyCommand(req.params);

    case 'gnosis/getTopologyGraph': {
      const graphUri = getUriFromParams(req.params);
      if (!graphUri) {
        return { nodes: [], edges: [], metrics: null };
      }
      const graphText = documents.get(graphUri) ?? '';
      if (!graphText || !isTypeScriptUri(graphUri)) {
        return { nodes: [], edges: [], metrics: null };
      }
      try {
        const graphFilePath = graphUri.startsWith('file://')
          ? graphUri.slice(7)
          : graphUri;
        const graphResult = await checkTypeScriptWithGnosis(
          graphText,
          graphFilePath
        );
        return {
          nodes: graphResult.topology.nodes,
          edges: graphResult.topology.edges,
          metrics: graphResult.metrics,
        };
      } catch {
        return { nodes: [], edges: [], metrics: null };
      }
    }

    case 'shutdown':
      shutdownRequested = true;
      return null;

    case 'exit':
      process.exit(shutdownRequested ? 0 : 1);
      break;

    default:
      if (req.id !== undefined) {
        throw new Error(`Method not found: ${req.method}`);
      }
      return null;
  }
}

export async function handleRequest(req: JsonRpcRequest): Promise<void> {
  try {
    const result = await dispatchRequest(req);
    if (req.id !== undefined) {
      sendResponse(req.id, result);
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown LSP error';
    if (req.id !== undefined) {
      sendError(req.id, -32601, message);
    }
    log(message);
  }
}

function processTransportBuffer(): void {
  while (true) {
    const headerEnd = transportBuffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) {
      return;
    }

    const header = transportBuffer.subarray(0, headerEnd).toString('utf8');
    const contentLengthMatch = header.match(/Content-Length:\s*(\d+)/i);
    if (!contentLengthMatch) {
      transportBuffer = transportBuffer.subarray(headerEnd + 4);
      continue;
    }

    const contentLength = Number.parseInt(contentLengthMatch[1], 10);
    const totalLength = headerEnd + 4 + contentLength;
    if (transportBuffer.length < totalLength) {
      return;
    }

    const bodyBuffer = transportBuffer.subarray(headerEnd + 4, totalLength);
    transportBuffer = transportBuffer.subarray(totalLength);

    const bodyText = bodyBuffer.toString('utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      sendError(null, -32700, 'Parse error');
      continue;
    }

    if (!isJsonRpcRequest(parsed)) {
      sendError(null, -32600, 'Invalid Request');
      continue;
    }

    void handleRequest(parsed);
  }
}

export function startGnosisLspStdioTransport(): void {
  process.stdin.on('data', (chunk: Buffer) => {
    transportBuffer = Buffer.concat([transportBuffer, chunk]);
    processTransportBuffer();
  });
}

export function main(): void {
  startGnosisLspStdioTransport();
}

function isExecutedDirectly(importMetaUrl: string): boolean {
  const entryPath = process.argv[1];
  if (!entryPath) {
    return false;
  }

  return resolve(fileURLToPath(importMetaUrl)) === resolve(entryPath);
}

if (isExecutedDirectly(import.meta.url)) {
  main();
}
