/**
 * Zedge Companion Configuration
 *
 * Reuses ~/.edgework/ directory from edgework-cli.
 * Adds zedge.json for companion-specific settings.
 */

import { homedir } from 'os';
import { join } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import {
  DEFAULT_ZEDGE_MODEL_ID,
  isCandidateZedgeModel,
  isLegacyEdgeworkModelId,
  normalizeZedgeModelId,
} from './model-catalog.ts';
import { readZedModelSelection } from './zed-settings.ts';

const CONFIG_DIR = join(homedir(), '.edgework');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const API_KEY_FILE = join(CONFIG_DIR, 'api-key');
const ZEDGE_CONFIG_FILE = join(CONFIG_DIR, 'zedge.json');
const LOCAL_ZED_PLACEHOLDER_API_KEY = 'zedge-local';

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
    discoveryPort?: number;
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
  /**
   * Override the skymesh global cache URL for Tier -1 teleportation.
   * Defaults to https://www-edgework-app.edgework.ai (edgework prod).
   */
  skyMeshCacheUrl?: string;
  /**
   * Explicitly enable/disable Tier -1 skymesh cache teleportation.
   * true = on (default), false = off. Also controlled by ZEDGE_SKYMESH_TELEPORT env.
   */
  skyMeshTeleport?: boolean;
  /** Mesh room name for skymesh bridge (default: 'skymesh-global') */
  skyMeshId?: string;
  /** Auto-start WS bridge on companion startup (default: true) */
  skyMeshBridgeEnabled?: boolean;
  /** BRIDGE_TOKEN for the skymesh relay authentication */
  skyMeshBridgeToken?: string;
  /** Contribute inference results to global cache (default: true) */
  skyMeshCacheStore?: boolean;
  /** Current team ID (persisted from teams.ts) */
  teamId?: string;
  /** Current team name (for display) */
  teamName?: string;
}

type PartialZedgeConfig = Omit<
  Partial<ZedgeConfig>,
  'listener' | 'computePool' | 'babelfish'
> & {
  listener?: Partial<ZedgeConfig['listener']>;
  computePool?: Partial<ZedgeConfig['computePool']>;
  babelfish?: Partial<ZedgeConfig['babelfish']>;
};

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
    allowedModels: [
      'codestral-22b',
      'mistral-7b',
      'gemma3-4b-it',
      'gemma4-12b-it',
      'gemma4-31b-it',
      'gnosis-local',
      'tinyllama-1.1b',
    ],
  },
  preferredModel: 'codestral-22b',
  // CPU middle monofat is the production path for catalog models with
  // CLOUD_RUN_COORDINATORS entries (see coordinator-urls.ts + inference-bridge).
  cloudRunDirect: true,
  babelfish: {
    enabled: true,
    ambientSuggestions: true,
    defaultHumanLanguage: 'en',
    requirePreviewForInPlaceRewrite: true,
  },
};

function normalizePreferredModel(modelId: string | null | undefined): string {
  const normalized = modelId ? normalizeZedgeModelId(modelId) : undefined;
  if (
    !normalized ||
    isLegacyEdgeworkModelId(normalized) ||
    isCandidateZedgeModel(normalized)
  ) {
    return DEFAULT_ZEDGE_MODEL_ID;
  }

  return normalized;
}

function normalizeAllowedModels(modelIds: string[] | undefined): string[] {
  const seen = new Set<string>();
  const allowedModels: string[] = [];
  const candidates = modelIds ?? DEFAULT_ZEDGE_CONFIG.computePool.allowedModels;

  for (const rawModelId of candidates) {
    const modelId = normalizeZedgeModelId(rawModelId);
    if (
      modelId.length === 0 ||
      isLegacyEdgeworkModelId(modelId) ||
      isCandidateZedgeModel(modelId) ||
      seen.has(modelId)
    ) {
      continue;
    }

    seen.add(modelId);
    allowedModels.push(modelId);
  }

  return allowedModels.length > 0
    ? allowedModels
    : [...DEFAULT_ZEDGE_CONFIG.computePool.allowedModels];
}

function getMoonshineModelEnvOverride(): string | null {
  const envModel = process.env.ZEDGE_MOONSHINE_MODEL?.trim();
  if (!envModel) {
    return null;
  }
  // Launch-agent Moonshine model — not subject to retired Edgework picker rules.
  return normalizeZedgeModelId(envModel);
}

function getZedPreferredModelOverride(): string | null {
  const selection = readZedModelSelection();
  if (!selection) {
    return null;
  }

  const availableModels = normalizeAllowedModels(selection.availableModels);
  const selectedModel = selection.defaultModel?.trim();
  if (
    typeof selectedModel === 'string' &&
    selectedModel.length > 0 &&
    availableModels.includes(selectedModel)
  ) {
    return selectedModel;
  }

  const normalizedFallback = normalizePreferredModel(selection.defaultModel);
  if (availableModels.includes(normalizedFallback)) {
    return normalizedFallback;
  }

  return availableModels[0] ?? normalizedFallback;
}

function getZedAllowedModelsOverride(): string[] | null {
  const selection = readZedModelSelection();
  if (!selection || selection.availableModels.length === 0) {
    return null;
  }

  return normalizeAllowedModels(selection.availableModels);
}

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

function deriveDiscoveryPort(port: number): number {
  return port <= 65_534 ? port + 1 : Math.max(1_024, port - 1);
}

function mergeZedgeConfig(config: PartialZedgeConfig | undefined): ZedgeConfig {
  const port = config?.port ?? DEFAULT_ZEDGE_CONFIG.port;
  const zedAllowedModels = getZedAllowedModelsOverride();
  const computePool = {
    ...DEFAULT_ZEDGE_CONFIG.computePool,
    ...(config?.computePool ?? {}),
    allowedModels:
      zedAllowedModels ??
      config?.computePool?.allowedModels ??
      DEFAULT_ZEDGE_CONFIG.computePool.allowedModels,
  };
  const preferredModel =
    getMoonshineModelEnvOverride() ??
    getZedPreferredModelOverride() ??
    normalizePreferredModel(config?.preferredModel);

  return {
    ...DEFAULT_ZEDGE_CONFIG,
    ...config,
    port,
    preferredModel,
    listener: {
      ...DEFAULT_ZEDGE_CONFIG.listener,
      ...(config?.listener ?? {}),
      internalPort: config?.listener?.internalPort ?? deriveInternalPort(port),
      flowPort: config?.listener?.flowPort ?? deriveFlowPort(port),
      discoveryPort:
        config?.listener?.discoveryPort ?? deriveDiscoveryPort(port),
    },
    computePool: {
      ...computePool,
      allowedModels: normalizeAllowedModels(computePool.allowedModels),
    },
    babelfish: {
      ...DEFAULT_ZEDGE_CONFIG.babelfish,
      ...(config?.babelfish ?? {}),
    },
  };
}

function stripDerivedListenerPorts(
  listener: Partial<ZedgeConfig['listener']> | undefined,
  port: number
): Partial<ZedgeConfig['listener']> | undefined {
  if (!listener) {
    return undefined;
  }

  return {
    ...listener,
    internalPort:
      listener.internalPort === deriveInternalPort(port)
        ? undefined
        : listener.internalPort,
    flowPort:
      listener.flowPort === deriveFlowPort(port)
        ? undefined
        : listener.flowPort,
    discoveryPort:
      listener.discoveryPort === deriveDiscoveryPort(port)
        ? undefined
        : listener.discoveryPort,
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

/**
 * Handles the zedge get Edgework Config workflow.
 */
export function getEdgeworkConfig(): EdgeworkConfig {
  return readJsonFile(CONFIG_FILE, DEFAULT_EDGEWORK_CONFIG);
}

/**
 * Handles the zedge get Zedge Config workflow.
 */
export function getZedgeConfig(): ZedgeConfig {
  const rawFileConfig = readJsonFile<PartialZedgeConfig>(ZEDGE_CONFIG_FILE, {});
  const portOverride = parsePortOverride(process.env.ZEDGE_COMPANION_PORT);
  const listenerModeOverride = parseListenerModeOverride(
    process.env.ZEDGE_LISTENER_MODE
  );
  const filePort = rawFileConfig.port ?? DEFAULT_ZEDGE_CONFIG.port;
  const listener = stripDerivedListenerPorts(rawFileConfig.listener, filePort);

  return mergeZedgeConfig({
    ...rawFileConfig,
    port: portOverride ?? filePort,
    listener: {
      ...listener,
      mode:
        listenerModeOverride ??
        listener?.mode ??
        DEFAULT_ZEDGE_CONFIG.listener.mode,
    },
  });
}

/**
 * Handles the zedge save Zedge Config workflow.
 */
export function saveZedgeConfig(config: PartialZedgeConfig): ZedgeConfig {
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

/**
 * Handles the zedge get Api Key workflow.
 */
export function getApiKey(): string | null {
  // Prefer env var — check both EDGEWORK_API_TOKEN and ZEDGE_API_KEY
  const envKey = process.env.EDGEWORK_API_TOKEN ?? process.env.ZEDGE_API_KEY;
  if (envKey && envKey !== LOCAL_ZED_PLACEHOLDER_API_KEY) return envKey;
  try {
    if (!existsSync(API_KEY_FILE)) return null;
    return readFileSync(API_KEY_FILE, 'utf-8').trim();
  } catch {
    return null;
  }
}

/**
 * Handles the zedge get Auth Headers workflow.
 */
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

/**
 * Handles the zedge get Api Base Url workflow.
 */
export function getApiBaseUrl(): string {
  return getEdgeworkConfig().apiBaseUrl;
}

/**
 * Handles the zedge get Companion Port workflow.
 */
export function getCompanionPort(): number {
  return getZedgeConfig().port;
}
