/**
 * Zedge Python type server (TSP) session.
 *
 * The Zedge companion needs Python type facts that do not come from an editor
 * hover: the inferred type of an expression, the declared type of a symbol, the
 * type a call site expects, resolved import targets, and the search paths the
 * analyzer would use. Those are exactly the questions Microsoft's Type Server
 * Protocol (TSP) answers, so this module owns one TSP session per workspace and
 * projects it into the shapes the MCP tools and slash commands use.
 *
 * The protocol client itself lives in Gnosis (@a0n/gnosis/polyglot-tsp) because
 * the polyglot surface is where cross-language type facts belong; this file is
 * the Zedge-specific lifecycle: command resolution, one session per workspace,
 * disk-backed document synchronization, and idle shutdown.
 *
 * Configuration:
 *   ZEDGE_TYPE_SERVER_COMMAND  shell-free command line
 *                              (default: 'pyright-typeserver --stdio')
 *   ZEDGE_TYPE_SERVER_DISABLED '1' or 'true' disables the surface entirely
 *   ZEDGE_TYPE_SERVER_IDLE_MS  idle shutdown in ms (default 600000)
 *   ZEDGE_TYPE_SERVER_TIMEOUT_MS per-request timeout in ms (default 30000)
 *
 * Honest boundaries:
 * - Nothing here type-checks. It reports what the configured server said, and
 *   says so when the server is missing or declines.
 * - The session syncs full document text from disk on every query; unsaved
 *   editor buffers are not visible to it.
 * - Pylance is not open source. pyright-typeserver is the default because it is.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve as resolvePath } from 'node:path';

import {
  DEFAULT_TYPE_SERVER_COMMAND,
  TypeServerClient,
  connectTypeServer,
  createNodeArg,
  describeType,
  pathToFileUri,
  type ConnectedTypeServer,
  type TypeDescription,
  type TspType,
} from '@a0n/gnosis/polyglot-tsp';

/** Which TSP type query to run. */
export type PythonTypeKind = 'computed' | 'declared' | 'expected';

const DEFAULT_IDLE_MS = 600_000;
const DEFAULT_TIMEOUT_MS = 30_000;

interface SessionEntry {
  root: string;
  connected: ConnectedTypeServer;
  idleTimer: ReturnType<typeof setTimeout> | null;
  openedDocuments: Set<string>;
  lastUsedAt: number;
  queries: number;
}

const sessions = new Map<string, SessionEntry>();
let lastFailure: string | null = null;
let exitHookInstalled = false;

/**
 * Install a one-shot exit hook the first time a session opens.
 *
 * The idle timer is unref'd, so it never keeps the process alive; this hook is
 * what stops a live type server from outliving the MCP bridge that spawned it.
 */
function ensureExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    for (const entry of sessions.values()) {
      try {
        entry.connected.dispose();
      } catch {
        // A failing dispose during process exit has nowhere to report.
      }
    }
    sessions.clear();
  });
}

/** The command line Zedge would run, from env or the default. */
export function resolveTypeServerCommand(): string {
  const configured = process.env.ZEDGE_TYPE_SERVER_COMMAND;
  if (typeof configured === 'string' && configured.trim().length > 0) {
    return configured.trim();
  }
  return DEFAULT_TYPE_SERVER_COMMAND;
}

/** True when the surface is switched off by configuration. */
export function isTypeServerDisabled(): boolean {
  const value = process.env.ZEDGE_TYPE_SERVER_DISABLED;
  return value === '1' || value === 'true';
}

function idleTimeoutMs(): number {
  return readPositiveInt(process.env.ZEDGE_TYPE_SERVER_IDLE_MS, DEFAULT_IDLE_MS);
}

function requestTimeoutMs(): number {
  return readPositiveInt(
    process.env.ZEDGE_TYPE_SERVER_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS
  );
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function log(message: string): void {
  console.error('[zedge-tsp] ' + message);
}

/**
 * Child environment for the type-server process.
 *
 * pyright-typeserver (and every pyright front end) ships as a shebang script --
 * "#!/usr/bin/env node" -- so the child must find a Node runtime on PATH even
 * when Zedge itself was launched by absolute path (launchd, Zed, an MCP client,
 * or a test runner that never exported PATH). Put the runtime that is already
 * executing this code first instead of trusting the ambient PATH.
 */
function typeServerChildEnv(): Record<string, string | undefined> {
  const execPath = process.execPath;
  if (typeof execPath !== 'string' || execPath.length === 0) return {};
  const nodeDir = dirname(execPath);
  const ambientPath = process.env.PATH;
  if (ambientPath === undefined) return {};
  if (ambientPath.split(':').includes(nodeDir)) return {};
  return { PATH: nodeDir + ':' + ambientPath };
}

/** A resolved workspace file plus the text the server will analyze. */
export interface ResolvedPythonFile {
  /** Absolute path on disk. */
  path: string;
  /** Path relative to the workspace root, for display. */
  relativePath: string;
  /** File URI handed to the type server. */
  uri: string;
  /** Full document text. */
  text: string;
}

/**
 * Resolve a workspace-relative (or absolute) Python file.
 *
 * Throws with a precise reason when the path is missing, not a file, or not a
 * Python document, because a silent empty type is worse than a refusal.
 */
export function resolvePythonFile(
  workspaceRoot: string,
  filePath: string
): ResolvedPythonFile {
  const absolute = isAbsolute(filePath)
    ? filePath
    : resolvePath(workspaceRoot, filePath);
  if (!existsSync(absolute)) {
    throw new Error('Python file not found: ' + filePath);
  }
  const stats = statSync(absolute);
  if (!stats.isFile()) {
    throw new Error('Not a file: ' + filePath);
  }
  const lower = absolute.toLowerCase();
  if (
    !lower.endsWith('.py') &&
    !lower.endsWith('.pyi') &&
    !lower.endsWith('.pyw')
  ) {
    throw new Error('Not a Python document: ' + filePath);
  }
  const root = workspaceRoot.endsWith('/')
    ? workspaceRoot.slice(0, -1)
    : workspaceRoot;
  const relativePath = absolute.startsWith(root + '/')
    ? absolute.slice(root.length + 1)
    : absolute;
  return {
    path: absolute,
    relativePath,
    uri: pathToFileUri(absolute),
    text: readFileSync(absolute, 'utf8'),
  };
}

/** A zero-based source range, LSP-shaped. */
export interface CharacterRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

const IDENTIFIER_CHAR = /[A-Za-z0-9_]/;

/**
 * Expand a cursor position to the identifier under it.
 *
 * TSP type queries answer for a *node*, not a point: pyright-typeserver returns
 * nothing for getDeclaredType on a zero-width range, and the declared type of a
 * parameter only appears when the range covers the parameter name. Editors send
 * the node range; an agent (or a slash command) only has a cursor, so widen it
 * here rather than guessing at the server.
 *
 * Falls back to a zero-width range when the cursor is not on or next to an
 * identifier (punctuation, whitespace, end of line).
 */
export function tokenRangeAt(
  text: string,
  position: { line: number; character: number }
): CharacterRange {
  const lines = text.split('\n');
  const lineIndex = Math.max(0, Math.min(position.line, Math.max(0, lines.length - 1)));
  const lineText = lines[lineIndex] ?? '';
  const character = Math.max(0, Math.min(position.character, lineText.length));
  const isIdentifier = (value: string | undefined): boolean =>
    value !== undefined && IDENTIFIER_CHAR.test(value);

  let startCharacter = character;
  let endCharacter = character;
  if (isIdentifier(lineText[character])) {
    while (startCharacter > 0 && isIdentifier(lineText[startCharacter - 1])) {
      startCharacter -= 1;
    }
    while (
      endCharacter < lineText.length &&
      isIdentifier(lineText[endCharacter])
    ) {
      endCharacter += 1;
    }
  } else if (isIdentifier(lineText[character - 1])) {
    startCharacter = character - 1;
    endCharacter = character;
    while (startCharacter > 0 && isIdentifier(lineText[startCharacter - 1])) {
      startCharacter -= 1;
    }
    while (
      endCharacter < lineText.length &&
      isIdentifier(lineText[endCharacter])
    ) {
      endCharacter += 1;
    }
  }

  return {
    start: { line: lineIndex, character: startCharacter },
    end: { line: lineIndex, character: endCharacter },
  };
}

/** Get (or create) the session for a workspace root. */
async function getSession(workspaceRoot: string): Promise<SessionEntry> {
  const existing = sessions.get(workspaceRoot);
  if (existing !== undefined) {
    existing.lastUsedAt = Date.now();
    if (existing.idleTimer !== null) {
      existing.idleTimer.refresh();
    }
    return existing;
  }
  if (isTypeServerDisabled()) {
    throw new Error(
      'Zedge Python type server is disabled by ZEDGE_TYPE_SERVER_DISABLED'
    );
  }

  const commandLine = resolveTypeServerCommand();
  try {
    const connected = await connectTypeServer({
      commandLine,
      workspaceRoot,
      requestTimeoutMs: requestTimeoutMs(),
      env: typeServerChildEnv(),
      logger: log,
    });
    const entry: SessionEntry = {
      root: workspaceRoot,
      connected,
      idleTimer: null,
      openedDocuments: new Set<string>(),
      lastUsedAt: Date.now(),
      queries: 0,
    };
    scheduleIdleShutdown(entry);
    sessions.set(workspaceRoot, entry);
    ensureExitHook();
    lastFailure = null;
    return entry;
  } catch (error) {
    lastFailure = error instanceof Error ? error.message : String(error);
    throw new Error(
      'Python type server is unavailable for ' +
        workspaceRoot +
        ' (' +
        commandLine +
        '): ' +
        lastFailure +
        '. Install pyright-typeserver (npm i -g pyright-typeserver) or set ZEDGE_TYPE_SERVER_COMMAND.'
    );
  }
}

function scheduleIdleShutdown(entry: SessionEntry): void {
  const timeout = idleTimeoutMs();
  if (entry.idleTimer !== null) clearTimeout(entry.idleTimer);
  const timer = setTimeout(() => {
    const current = sessions.get(entry.root);
    if (current !== entry) return;
    sessions.delete(entry.root);
    try {
      entry.connected.dispose();
      log('idle type server session closed for ' + entry.root);
    } catch (error) {
      log('idle close failed: ' + describe(error));
    }
  }, timeout);
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
    (timer as { unref?: () => void }).unref?.();
  }
  entry.idleTimer = timer;
}

/** Synchronize a file with its session, opening it on first use. */
async function syncFile(
  entry: SessionEntry,
  file: ResolvedPythonFile
): Promise<TypeServerClient> {
  const client = entry.connected.client;
  await client.syncDocument({ uri: file.uri, text: file.text });
  entry.openedDocuments.add(file.uri);
  entry.lastUsedAt = Date.now();
  return client;
}

/** Options common to every TSP query surfaced by Zedge. */
export interface PythonQueryContext {
  /** Workspace root the session belongs to. */
  workspaceRoot: string;
  /** Workspace-relative or absolute Python file path. */
  filePath: string;
}

/** Result of a Python type query. */
export interface PythonTypeResult {
  /** True when a type server answered (even with no type for this node). */
  available: boolean;
  /** Which query ran. */
  kind: PythonTypeKind;
  /** Path relative to the workspace root. */
  file: string;
  /** Document URI used with the type server. */
  uri: string;
  /** Zero-based position the caller asked about. */
  position: { line: number; character: number };
  /** Zero-based range actually sent to the type server (cursor expanded to its token). */
  range: CharacterRange;
  /** Python-ish rendering of the type, or null when the server returned none. */
  text: string | null;
  /** Structural facts about the type, or null. */
  description: TypeDescription | null;
  /** Snapshot the answer belongs to. */
  snapshot: number | null;
  /** Why text is null, when it is. */
  reason?: string;
  /** Raw TSP type graph, for callers that need more than the projection. */
  raw: TspType | null;
}

/** Options for queryPythonType. */
export interface PythonTypeQueryOptions extends PythonQueryContext {
  /** Zero-based line. */
  line: number;
  /** Zero-based UTF-16 character offset. */
  character: number;
  /** Optional explicit range end; defaults to a zero-width node. */
  endLine?: number;
  endCharacter?: number;
  /** Query to run. Defaults to computed. */
  kind?: PythonTypeKind;
}

/** Run one TSP type query against the workspace session. */
export async function queryPythonType(
  options: PythonTypeQueryOptions
): Promise<PythonTypeResult> {
  const kind: PythonTypeKind = options.kind ?? 'computed';
  const file = resolvePythonFile(options.workspaceRoot, options.filePath);
  const entry = await getSession(options.workspaceRoot);
  const client = await syncFile(entry, file);
  entry.queries += 1;

  const cursor = { line: options.line, character: options.character };
  const range: CharacterRange =
    options.endLine === undefined
      ? tokenRangeAt(file.text, cursor)
      : {
          start: cursor,
          end: {
            line: options.endLine,
            character: options.endCharacter ?? options.character,
          },
        };
  const arg = createNodeArg(file.uri, range);

  const raw = await runTypeQuery(client, kind, arg);
  const description = raw === null ? null : describeType(raw);
  const result: PythonTypeResult = {
    available: true,
    kind,
    file: file.relativePath,
    uri: file.uri,
    position: { line: options.line, character: options.character },
    range,
    text: description === null ? null : description.text,
    description,
    snapshot: client.snapshot,
    raw,
  };
  if (raw === null) {
    result.reason =
      'the type server returned no ' +
      kind +
      ' type for this node (it may be untyped, out of scope, or not yet analyzed)';
  }
  return result;
}

async function runTypeQuery(
  client: TypeServerClient,
  kind: PythonTypeKind,
  arg: ReturnType<typeof createNodeArg>
): Promise<TspType | null> {
  if (kind === 'computed') return client.getComputedType(arg);
  if (kind === 'declared') return client.getDeclaredType(arg);
  return client.getExpectedType(arg);
}

/** Result of a search-path query. */
export interface PythonSearchPathsResult {
  available: boolean;
  file: string;
  paths: string[];
  snapshot: number | null;
  reason?: string;
}

/** Ask the type server which directories it searches for Python modules. */
export async function queryPythonSearchPaths(
  context: PythonQueryContext
): Promise<PythonSearchPathsResult> {
  const file = resolvePythonFile(context.workspaceRoot, context.filePath);
  const entry = await getSession(context.workspaceRoot);
  const client = await syncFile(entry, file);
  const paths = await client.getPythonSearchPaths(file.uri);
  if (paths === null) {
    return {
      available: true,
      file: file.relativePath,
      paths: [],
      snapshot: client.snapshot,
      reason: 'the type server does not implement typeServer/getPythonSearchPaths',
    };
  }
  return {
    available: true,
    file: file.relativePath,
    paths,
    snapshot: client.snapshot,
  };
}

/** Result of an import-resolution query. */
export interface PythonResolveImportResult {
  available: boolean;
  file: string;
  module: string;
  /** Resolved document URI, or null when the import does not resolve. */
  resolvedUri: string | null;
  /** Resolved absolute path, when the URI is a file URI. */
  resolvedPath: string | null;
  snapshot: number | null;
  reason?: string;
}

/** Resolve a Python import specifier from a source file. */
export async function resolvePythonImport(
  context: PythonQueryContext & { module: string }
): Promise<PythonResolveImportResult> {
  const file = resolvePythonFile(context.workspaceRoot, context.filePath);
  const entry = await getSession(context.workspaceRoot);
  const client = await syncFile(entry, file);
  const resolvedUri = await client.resolveImport(file.uri, context.module);
  const result: PythonResolveImportResult = {
    available: true,
    file: file.relativePath,
    module: context.module,
    resolvedUri,
    resolvedPath: null,
    snapshot: client.snapshot,
  };
  if (resolvedUri === null) {
    result.reason =
      'the type server did not resolve this import (module missing, not installed, or shadowed)';
    return result;
  }
  if (resolvedUri.startsWith('file://')) {
    try {
      const { fileURLToPath } = await import('node:url');
      result.resolvedPath = fileURLToPath(resolvedUri);
    } catch {
      result.resolvedPath = null;
    }
  }
  return result;
}

/** Status of the Python type-server surface, for diagnostics and tools. */
export interface PythonTypeServerStatus {
  enabled: boolean;
  commandLine: string;
  running: boolean;
  sessions: Array<{
    workspaceRoot: string;
    queries: number;
    documents: number;
    protocolVersion: string | null;
    compatible: boolean;
    compatibilityDetail: string;
    snapshot: number | null;
    serverName: string | null;
    multiConnectionTransports: string[];
    lastUsedAt: number;
  }>;
  lastFailure: string | null;
  idleTimeoutMs: number;
  requestTimeoutMs: number;
}

/** Report the configured command and every live session. */
export function getPythonTypeServerStatus(): PythonTypeServerStatus {
  const sessionStatus = [...sessions.values()].map((entry) => {
    const status = entry.connected.client.status();
    return {
      workspaceRoot: entry.root,
      queries: entry.queries,
      documents: status.documents,
      protocolVersion: status.protocolVersion,
      compatible: status.compatibility.compatible,
      compatibilityDetail: status.compatibility.detail,
      snapshot: status.snapshot,
      serverName: status.serverInfo?.name ?? null,
      multiConnectionTransports: status.multiConnectionTransports,
      lastUsedAt: entry.lastUsedAt,
    };
  });
  return {
    enabled: !isTypeServerDisabled(),
    commandLine: resolveTypeServerCommand(),
    running: sessionStatus.length > 0,
    sessions: sessionStatus,
    lastFailure,
    idleTimeoutMs: idleTimeoutMs(),
    requestTimeoutMs: requestTimeoutMs(),
  };
}

/**
 * Close the session for one workspace, or every session when no root is given.
 *
 * Used by tests and by the companion shutdown path; safe to call when no
 * session exists.
 */
export function disposePythonTypeServer(workspaceRoot?: string): void {
  const roots =
    workspaceRoot === undefined ? [...sessions.keys()] : [workspaceRoot];
  for (const root of roots) {
    const entry = sessions.get(root);
    if (entry === undefined) continue;
    sessions.delete(root);
    if (entry.idleTimer !== null) clearTimeout(entry.idleTimer);
    try {
      entry.connected.dispose();
    } catch (error) {
      log('dispose failed for ' + root + ': ' + describe(error));
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
