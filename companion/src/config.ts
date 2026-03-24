/**
 * Zedge Companion Configuration
 *
 * Reuses ~/.edgework/ directory from edgework-cli.
 * Adds zedge.json for companion-specific settings.
 */

import { homedir } from 'os';
import { join } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';

const CONFIG_DIR = join(homedir(), '.edgework');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const API_KEY_FILE = join(CONFIG_DIR, 'api-key');
const ZEDGE_CONFIG_FILE = join(CONFIG_DIR, 'zedge.json');

export type Environment = 'production' | 'staging' | 'development';

export interface EdgeworkConfig {
  environment: Environment;
  apiBaseUrl: string;
  mcpEndpoint: string;
}

export interface ZedgeConfig {
  port: number;
  listener: {
    mode: 'bun' | 'gnosis-uring-proxy';
    threads: number;
    useUring: boolean;
    internalPort?: number;
    flowPort?: number;
  };
  computePool: {
    enabled: boolean;
    maxCpuPercent: number;
    maxMemoryMb: number;
    allowedModels: string[];
  };
  preferredModel: string;
  cloudRunDirect: boolean;
  babelfish: {
    enabled: boolean;
    ambientSuggestions: boolean;
    defaultHumanLanguage: string;
    requirePreviewForInPlaceRewrite: boolean;
  };
  /** DashRelay WebSocket URL for Ghostwriter CRDT sync */
  dashRelayUrl?: string;
  /** DashRelay API key (format: dr_<64-hex>) */
  dashRelayApiKey?: string;
  /** UCAN token for relay authorization */
  ucanToken?: string;
  /**
   * Emit debug/prefill info via `reasoning_content` (Zed thinking UI).
   * Disabled by default: Zed's openai_compatible provider ignores
   * reasoning_content and hangs (https://github.com/zed-industries/zed/issues/46794).
   * Enable when Zed ships the fix.
   */
  reasoningContent?: boolean;
}

const DEFAULT_EDGEWORK_CONFIG: EdgeworkConfig = {
  environment: 'production',
  apiBaseUrl: 'https://api.edgework.ai',
  mcpEndpoint: 'https://api.edgework.ai/mcp',
};

const DEFAULT_ZEDGE_CONFIG: ZedgeConfig = {
  port: 7331,
  listener: {
    mode: 'bun',
    threads: 1,
    useUring: false,
  },
  computePool: {
    enabled: false,
    maxCpuPercent: 50,
    maxMemoryMb: 2048,
    allowedModels: ['tinyllama-1.1b', 'gemma3-1b-it'],
  },
  preferredModel: 'wasm-local',
  cloudRunDirect: false,
  babelfish: {
    enabled: true,
    ambientSuggestions: true,
    defaultHumanLanguage: 'en',
    requirePreviewForInPlaceRewrite: true,
  },
};

function parsePortOverride(value: string | undefined): number | undefined {
  if (!value) return undefined;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    return undefined;
  }

  return parsed;
}

function parseListenerModeOverride(
  value: string | undefined
): ZedgeConfig['listener']['mode'] | undefined {
  if (value === 'bun' || value === 'gnosis-uring-proxy') {
    return value;
  }

  return undefined;
}

function deriveInternalPort(port: number): number {
  return port <= 55_535 ? port + 10_000 : Math.max(1_024, port - 1_000);
}

function deriveFlowPort(port: number): number {
  return port <= 64_535 ? port + 1_000 : Math.max(1_024, port - 100);
}

function mergeZedgeConfig(config: Partial<ZedgeConfig> | undefined): ZedgeConfig {
  const port = config?.port ?? DEFAULT_ZEDGE_CONFIG.port;
  return {
    ...DEFAULT_ZEDGE_CONFIG,
    ...config,
    port,
    listener: {
      ...DEFAULT_ZEDGE_CONFIG.listener,
      ...(config?.listener ?? {}),
      internalPort:
        config?.listener?.internalPort ?? deriveInternalPort(port),
      flowPort: config?.listener?.flowPort ?? deriveFlowPort(port),
    },
    computePool: {
      ...DEFAULT_ZEDGE_CONFIG.computePool,
      ...(config?.computePool ?? {}),
    },
    babelfish: {
      ...DEFAULT_ZEDGE_CONFIG.babelfish,
      ...(config?.babelfish ?? {}),
    },
  };
}

function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

function readJsonFile<T>(path: string, defaultValue: T): T {
  try {
    if (!existsSync(path)) return defaultValue;
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch {
    return defaultValue;
  }
}

function writeJsonFile(path: string, data: unknown): void {
  ensureConfigDir();
  writeFileSync(path, JSON.stringify(data, null, 2), { mode: 0o600 });
}

export function getEdgeworkConfig(): EdgeworkConfig {
  return readJsonFile(CONFIG_FILE, DEFAULT_EDGEWORK_CONFIG);
}

export function getZedgeConfig(): ZedgeConfig {
  const fileConfig = mergeZedgeConfig(
    readJsonFile<Partial<ZedgeConfig>>(ZEDGE_CONFIG_FILE, DEFAULT_ZEDGE_CONFIG)
  );
  const portOverride = parsePortOverride(process.env.ZEDGE_COMPANION_PORT);
  const listenerModeOverride = parseListenerModeOverride(
    process.env.ZEDGE_LISTENER_MODE
  );

  return mergeZedgeConfig({
    ...fileConfig,
    port: portOverride ?? fileConfig.port,
    listener: {
      ...fileConfig.listener,
      mode: listenerModeOverride ?? fileConfig.listener.mode,
    },
  });
}

export function saveZedgeConfig(config: Partial<ZedgeConfig>): ZedgeConfig {
  const current = getZedgeConfig();
  const updated = mergeZedgeConfig({
    ...current,
    ...config,
    listener: {
      ...current.listener,
      ...(config.listener ?? {}),
    },
    computePool: {
      ...current.computePool,
      ...(config.computePool ?? {}),
    },
    babelfish: {
      ...current.babelfish,
      ...(config.babelfish ?? {}),
    },
  });
  writeJsonFile(ZEDGE_CONFIG_FILE, updated);
  return updated;
}

export function getApiKey(): string | null {
  // Prefer env var — check both EDGEWORK_API_TOKEN and ZEDGE_API_KEY
  const envKey = process.env.EDGEWORK_API_TOKEN ?? process.env.ZEDGE_API_KEY;
  if (envKey) return envKey;
  try {
    if (!existsSync(API_KEY_FILE)) return null;
    return readFileSync(API_KEY_FILE, 'utf-8').trim();
  } catch {
    return null;
  }
}

export function getAuthHeaders(): Record<string, string> {
  const apiKey = getApiKey();
  if (apiKey) {
    return {
      Authorization: `Bearer ${apiKey}`,
      'X-API-Key': apiKey,
      'X-Subscription-Tier': 'admin',
    };
  }
  return {};
}

export function getApiBaseUrl(): string {
  return getEdgeworkConfig().apiBaseUrl;
}

export function getCompanionPort(): number {
  return getZedgeConfig().port;
}
