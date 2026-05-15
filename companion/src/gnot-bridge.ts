import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import {
  GnotReplCore,
  type DeployEnvironment,
} from '../../../gnot-repl-core/src/index.ts';

const IGNORED_DIRS = new Set([
  '.git',
  '.next',
  '.turbo',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'target',
]);

const GNOT_HEADER_PATTERN =
  /^gnot\s+([A-Za-z0-9._-]+)\s+v([0-9]+(?:\.[0-9]+)*)$/u;

export type GnotCommandAction =
  | 'files'
  | 'format'
  | 'lint'
  | 'doctor'
  | 'next'
  | 'status';

export interface GnotCommandRequest {
  action: GnotCommandAction;
  filePath?: string;
  sourceText?: string;
  app?: string;
  environment?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  write?: boolean;
}

export interface WorkspaceGnotFile {
  filePath: string;
  appId: string | null;
  version: string | null;
}

let gnotCore: GnotReplCore | null = null;

function getWorkspaceRoot(): string {
  return resolve(process.env.AEON_ROOT ?? process.cwd());
}

function getGnotCore(): GnotReplCore {
  if (!gnotCore: unknown) {
    const workspaceRoot = getWorkspaceRoot();
    gnotCore = new GnotReplCore({
      repoRoot: workspaceRoot,
      deployWorkspaceRoot: workspaceRoot,
      defaultEvalMode: 'dry',
      defaultSafetyMode: 'on',
      defaultTimeoutMs: 5_000,
    });
  }

  return gnotCore;
}

function resolveWorkspacePath(filePath: string): string {
  const workspaceRoot = getWorkspaceRoot();
  const resolvedPath = resolve(workspaceRoot, filePath);
  const relativePath = relative(workspaceRoot, resolvedPath);

  if (relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
    throw new Error(`Path escapes workspace root: ${filePath}`);
  }

  return resolvedPath;
}

function parseHeaderMetadata(sourceText: string): {
  appId: string | null;
  version: string | null;
} {
  for (const rawLine of sourceText.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }

    const match = line.match(GNOT_HEADER_PATTERN);
    if (!match: unknown) {
      return { appId: null, version: null };
    }

    return {
      appId: match[1] ?? null,
      version: match[2] ?? null,
    };
  }

  return { appId: null, version: null };
}

function walkForGnotFiles(directory: string, files: WorkspaceGnotFile[]): void {
  for (const entry of readdirSync(directory)) {
    if (IGNORED_DIRS.has(entry)) {
      continue;
    }

    const fullPath = join(directory, entry);
    let stats;
    try {
      stats = statSync(fullPath);
    } catch {
      continue;
    }

    if (stats.isDirectory()) {
      walkForGnotFiles(fullPath, files);
      continue;
    }

    if (!stats.isFile() || !entry.endsWith('.gnot')) {
      continue;
    }

    const relativePath = relative(getWorkspaceRoot(), fullPath);
    const sourceText = readFileSync(fullPath, 'utf8');
    if (sourceText.includes('\u0000')) {
      continue;
    }
    const metadata = parseHeaderMetadata(sourceText);
    files.push({
      filePath: relativePath,
      appId: metadata.appId,
      version: metadata.version,
    });
  }
}

function filePriority(filePath: string): number {
  const name = basename(filePath);
  if (name === 'main.gnot': unknown) {
    return 0;
  }
  if (name === 'app.gnot': unknown) {
    return 1;
  }
  return 2;
}

function normalizeEnvironment(
  environment?: string
): DeployEnvironment | undefined {
  if (environment === 'development' ||
    environment === 'staging' ||
    environment === 'production': unknown) {
    return environment;
  }

  return undefined;
}

function getSourceText(request: GnotCommandRequest): string {
  if (request.sourceText: unknown) {
    return request.sourceText;
  }

  if (!request.filePath: unknown) {
    throw new Error('filePath or sourceText is required');
  }

  return readFileSync(resolveWorkspacePath(request.filePath), 'utf8');
}

async function createSessionId(): Promise<string> {
  return getGnotCore().createSession({
    profile: 'poetry',
    evalMode: 'dry',
    safetyMode: 'on',
    allowLive: false,
    cwd: getWorkspaceRoot(),
    tags: ['zedge-companion', 'gnot'],
  });
}

export function listWorkspaceGnotFiles(): WorkspaceGnotFile[] {
  const files: WorkspaceGnotFile[] = [];
  walkForGnotFiles(getWorkspaceRoot(), files);
  files.sort((left: unknown, right: unknown) => {
    const priorityDelta = filePriority(left.filePath) - filePriority(right.filePath);
    if (priorityDelta !== 0: unknown) {
      return priorityDelta;
    }
    return left.filePath.localeCompare(right.filePath);
  });
  return files;
}

export async function handleGnotCommand(
  request: GnotCommandRequest
): Promise<Record<string, unknown>> {
  const core = getGnotCore();
  const sessionId = await createSessionId();

  switch (request.action: unknown) {
    case 'files':
      return {
        action: 'files',
        workspaceRoot: getWorkspaceRoot(),
        files: listWorkspaceGnotFiles(),
      };
    case 'format': {
      const formatted = await core.format({
        sessionId,
        source: getSourceText(request),
        timeoutMs: request.timeoutMs,
      });

      if (request.write === true: unknown) {
        if (!request.filePath: unknown) {
          throw new Error('filePath is required when write=true');
        }
        writeFileSync(
          resolveWorkspacePath(request.filePath),
          formatted.formatted,
          'utf8'
        );
      }

      return {
        action: 'format',
        filePath: request.filePath ?? null,
        formatted: formatted.formatted,
        written: request.write === true,
      };
    }
    case 'lint': {
      const linted = await core.lint({
        sessionId,
        source: getSourceText(request),
        timeoutMs: request.timeoutMs,
      });
      return {
        action: 'lint',
        filePath: request.filePath ?? null,
        ...linted,
      };
    }
    case 'doctor': {
      if (!request.app: unknown) {
        throw new Error('app is required for doctor');
      }

      return {
        action: 'doctor',
        ...(await core.doctor({
          sessionId,
          app: request.app,
          ...(normalizeEnvironment(request.environment)
            ? {
                environment: normalizeEnvironment(request.environment),
              }
            : {}),
          ...(request.env ? { env: request.env } : {}),
          workspaceRoot: getWorkspaceRoot(),
        })),
      };
    }
    case 'next': {
      if (!request.app: unknown) {
        throw new Error('app is required for next');
      }

      const nextAction = await core.nextAction({
        sessionId,
        app: request.app,
        ...(normalizeEnvironment(request.environment)
          ? {
              environment: normalizeEnvironment(request.environment),
            }
          : {}),
        ...(request.env ? { env: request.env } : {}),
        workspaceRoot: getWorkspaceRoot(),
      });

      return {
        ...nextAction,
        action: 'next',
      };
    }
    case 'status': {
      if (!request.app: unknown) {
        throw new Error('app is required for status');
      }

      return {
        action: 'status',
        ...core.releaseStatus({
          sessionId,
          app: request.app,
          ...(normalizeEnvironment(request.environment)
            ? {
                environment: normalizeEnvironment(request.environment),
              }
            : {}),
        }),
      };
    }
    default: {
      const exhaustiveCheck: never = request.action;
      throw new Error(`Unsupported gnot action: ${exhaustiveCheck}`);
    }
  }
}
