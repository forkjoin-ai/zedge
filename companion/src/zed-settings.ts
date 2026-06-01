import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { buildZedAvailableModels } from './model-catalog.ts';

interface ZedModelProviderConfig {
  api_url?: string;
  api_key?: string;
  available_models?: unknown;
}

export const LOCAL_ZED_PLACEHOLDER_API_KEY = 'zedge-local';

export function getLocalZedgeApiUrl(port = 7331): string {
  return `http://127.0.0.1:${port}/v1`;
}

function getLocalZedgeCompletionsUrl(port = 7331): string {
  return `http://127.0.0.1:${port}/v1/completions`;
}

export interface ZedModelSelection {
  defaultModel: string | null;
  availableModels: string[];
}

export interface ZedSettingsSyncResult {
  updatedPaths: string[];
  matchedPaths: string[];
}

/** Narrows arbitrary JSON to an object with string keys. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Removes the JSONC features commonly present in Zed settings files. */
function stripJsonCommentsAndTrailingCommas(text: string): string {
  return text
    .replace(/^\uFEFF/, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/,\s*([}\]])/g, '$1');
}

/** Parses a Zed settings file that may contain comments or trailing commas. */
export function parseZedSettings(text: string): Record<string, unknown> {
  return JSON.parse(stripJsonCommentsAndTrailingCommas(text)) as Record<
    string,
    unknown
  >;
}

function isBrokenLocalZedgeUrl(url: string): boolean {
  return /127\.0\.0\.1:\/|localhost:\//.test(url);
}

function repairLocalZedgeEndpoint(url: string, port: number): string {
  if (isBrokenLocalZedgeUrl(url) || url.length === 0) {
    return getLocalZedgeApiUrl(port);
  }
  return rewriteLocalhost7331(url);
}

/** Prefer IPv4 loopback — `localhost` often resolves to ::1 while the sidecar binds 127.0.0.1. */
function rewriteLocalhost7331(url: string): string {
  if (url.startsWith('http://localhost:7331')) {
    return `http://127.0.0.1:7331${url.slice('http://localhost:7331'.length)}`;
  }
  return url;
}

/** Rewrites local Zedge URLs to IPv4 loopback so Zed avoids ::1 failures. */
function normalizeLocalLoopbackUrls(settings: Record<string, unknown>): void {
  const languageModels = settings.language_models;
  if (!isRecord(languageModels)) {
    return;
  }
  const openAiCompatible = languageModels.openai_compatible;
  if (!isRecord(openAiCompatible)) {
    return;
  }
  const zedge = openAiCompatible.Zedge;
  if (!isRecord(zedge)) {
    return;
  }
  const apiUrl = zedge.api_url;
  if (typeof apiUrl === 'string') {
    zedge.api_url = repairLocalZedgeEndpoint(apiUrl, 7331);
  }

  const editPredictions = settings.edit_predictions;
  if (!isRecord(editPredictions)) {
    return;
  }
  const copilot = editPredictions.copilot;
  if (!isRecord(copilot)) {
    return;
  }
  const copilotUrl = copilot.api_url;
  if (typeof copilotUrl === 'string') {
    if (isBrokenLocalZedgeUrl(copilotUrl) || copilotUrl.length === 0) {
      copilot.api_url = getLocalZedgeCompletionsUrl(7331);
    } else {
      copilot.api_url = rewriteLocalhost7331(copilotUrl);
    }
  }
}

function isLocalZedgeApiUrl(url: string | undefined, port = 7331): boolean {
  return (
    typeof url === 'string' &&
    (url.startsWith(`http://127.0.0.1:${port}`) ||
      url.startsWith(`http://localhost:${port}`))
  );
}

function isRemoteZedgeApiUrl(url: string | undefined): boolean {
  return (
    typeof url === 'string' &&
    url.length > 0 &&
    !isLocalZedgeApiUrl(url) &&
    !url.startsWith('http://127.0.0.1:') &&
    !url.startsWith('http://localhost:')
  );
}

/** Ensures Zed's OpenAI-compatible Zedge block exists for local companion use. */
export function ensureLocalZedgeProviderBlock(
  settings: Record<string, unknown>,
  port = 7331
): ZedModelProviderConfig {
  let languageModels = settings.language_models;
  if (!isRecord(languageModels)) {
    languageModels = {};
    settings.language_models = languageModels;
  }

  let openAiCompatible = languageModels.openai_compatible;
  if (!isRecord(openAiCompatible)) {
    openAiCompatible = {};
    languageModels.openai_compatible = openAiCompatible;
  }

  let zedge = openAiCompatible.Zedge;
  const hadBlock = isRecord(zedge);
  if (!hadBlock) {
    zedge = {};
    openAiCompatible.Zedge = zedge;
  }

  const apiUrl = typeof zedge.api_url === 'string' ? zedge.api_url : '';
  if (hadBlock && isRemoteZedgeApiUrl(apiUrl)) {
    return zedge;
  }

  zedge.api_url = getLocalZedgeApiUrl(port);

  let editPredictions = settings.edit_predictions;
  if (!isRecord(editPredictions)) {
    editPredictions = {};
    settings.edit_predictions = editPredictions;
  }

  let copilot = editPredictions.copilot;
  if (!isRecord(copilot)) {
    copilot = {};
    editPredictions.copilot = copilot;
  }

  const copilotUrl = typeof copilot.api_url === 'string' ? copilot.api_url : '';
  if (
    copilotUrl.length === 0 ||
    isBrokenLocalZedgeUrl(copilotUrl) ||
    isLocalZedgeApiUrl(copilotUrl, port) ||
    copilotUrl.includes(':7331')
  ) {
    copilot.api_url = getLocalZedgeCompletionsUrl(port);
  }

  return zedge;
}

/** Finds the OpenAI-compatible Zedge provider block in settings. */
function getZedgeProviderConfig(
  settings: Record<string, unknown>
): ZedModelProviderConfig | null {
  const languageModels = settings.language_models;
  if (!isRecord(languageModels)) {
    return null;
  }

  const openAiCompatible = languageModels.openai_compatible;
  if (!isRecord(openAiCompatible)) {
    return null;
  }

  const zedge = openAiCompatible.Zedge;
  if (!isRecord(zedge)) {
    return null;
  }

  return zedge;
}

function getZedgeDefaultModel(settings: Record<string, unknown>): string | null {
  const agent = settings.agent;
  if (!isRecord(agent)) {
    return null;
  }

  const defaultModel = agent.default_model;
  if (!isRecord(defaultModel)) {
    return null;
  }

  if (defaultModel.provider !== 'Zedge') {
    return null;
  }

  return typeof defaultModel.model === 'string' ? defaultModel.model : null;
}

function getZedgeAvailableModelNames(
  zedge: ZedModelProviderConfig
): string[] {
  if (!Array.isArray(zedge.available_models)) {
    return [];
  }

  return zedge.available_models
    .map((model) =>
      isRecord(model) && typeof model.name === 'string' ? model.name : null
    )
    .filter((model): model is string => model !== null);
}

/** Reads Zed's current Zedge model selection from settings.json. */
export function readZedModelSelection(): ZedModelSelection | null {
  for (const path of getZedSettingsPaths()) {
    if (!existsSync(path)) {
      continue;
    }

    try {
      const settings = parseZedSettings(readFileSync(path, 'utf-8'));
      const zedge = getZedgeProviderConfig(settings);
      if (!zedge) {
        continue;
      }

      return {
        defaultModel: getZedgeDefaultModel(settings),
        availableModels: getZedgeAvailableModelNames(zedge),
      };
    } catch {
      continue;
    }
  }

  return null;
}

/** Updates Zed's current default model when it still points at a retired entry. */
function updateZedgeAgentDefaultModel(
  settings: Record<string, unknown>,
  availableModels: Array<{ name: string }>,
  preferredModelId?: string
): void {
  const availableModelNames = new Set(
    availableModels.map((model) => model.name)
  );
  const preferred =
    preferredModelId && availableModelNames.has(preferredModelId)
      ? preferredModelId
      : availableModels[0]?.name;
  if (!preferred) {
    return;
  }

  let agent = settings.agent;
  if (!isRecord(agent)) {
    agent = {};
    settings.agent = agent;
  }

  let defaultModel = agent.default_model;
  if (!isRecord(defaultModel)) {
    agent.default_model = {
      provider: 'Zedge',
      model: preferred,
      enable_thinking: false,
    };
    return;
  }

  if (defaultModel.provider !== 'Zedge') {
    return;
  }

  const currentModel = defaultModel.model;
  if (
    typeof currentModel !== 'string' ||
    !availableModelNames.has(currentModel)
  ) {
    defaultModel.model = preferred;
    return;
  }

  if (
    preferredModelId &&
    availableModelNames.has(preferredModelId) &&
    currentModel !== preferredModelId
  ) {
    defaultModel.model = preferredModelId;
  }
}

/** Rewrites the Zedge model picker catalog inside a settings.json payload. */
export function updateZedSettingsModelCatalog(
  settingsText: string,
  modelIds: Iterable<string>,
  port = 7331,
  preferredModelId?: string
): string | null {
  const settings = parseZedSettings(settingsText);
  normalizeLocalLoopbackUrls(settings);
  const zedge = ensureLocalZedgeProviderBlock(settings, port);

  const availableModels = buildZedAvailableModels(modelIds);
  zedge.available_models = availableModels;
  updateZedgeAgentDefaultModel(
    settings,
    availableModels,
    preferredModelId?.trim() || process.env.ZEDGE_MOONSHINE_MODEL?.trim()
  );

  return JSON.stringify(settings, null, 2) + '\n';
}

function serializeZedSettings(settings: Record<string, unknown>): string {
  return JSON.stringify(settings, null, 2) + '\n';
}

/** Writes the local companion provider block into Zed settings and keychain. */
export function syncZedgeLocalProviderCredentials(
  port = 7331
): ZedSettingsSyncResult {
  const updatedPaths: string[] = [];
  const matchedPaths: string[] = [];

  for (const path of resolveZedSettingsTargets()) {
    const { settings, created } = readOrCreateZedSettings(path);
    normalizeLocalLoopbackUrls(settings);
    const before = created ? '' : serializeZedSettings(settings);
    ensureLocalZedgeProviderBlock(settings, port);
    const after = serializeZedSettings(settings);

    matchedPaths.push(path);
    if (created || after !== before) {
      writeFileSync(path, after);
      updatedPaths.push(path);
    }
  }

  return { updatedPaths, matchedPaths };
}

/** Returns the platform-specific settings paths Zed commonly uses. */
export function getZedSettingsPaths(): string[] {
  const override = process.env.ZEDGE_ZED_SETTINGS_PATHS;
  if (override) {
    return override.split(':').filter((path) => path.length > 0);
  }

  const home = homedir();
  // Zed reads user settings from ~/.config/zed on macOS (see zed-industries/zed paths.rs).
  return [join(home, '.config', 'zed', 'settings.json')];
}

function getPrimaryZedSettingsPath(): string {
  return getZedSettingsPaths()[0]!;
}

function resolveZedSettingsTargets(): string[] {
  const paths = getZedSettingsPaths();
  const existing = paths.filter((path) => existsSync(path));
  return existing.length > 0 ? existing : [getPrimaryZedSettingsPath()];
}

function readOrCreateZedSettings(path: string): {
  settings: Record<string, unknown>;
  created: boolean;
} {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    return { settings: {}, created: true };
  }

  return {
    settings: parseZedSettings(readFileSync(path, 'utf-8')),
    created: false,
  };
}

/** Syncs all discovered Zed settings files with the given live model ids. */
export function syncZedSettingsModelCatalog(
  modelIds: Iterable<string>,
  port = 7331,
  preferredModelId?: string
): ZedSettingsSyncResult {
  const updatedPaths: string[] = [];
  const matchedPaths: string[] = [];

  for (const path of resolveZedSettingsTargets()) {
    let currentText: string;
    let created = false;
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true });
      currentText = '{}';
      created = true;
    } else {
      currentText = readFileSync(path, 'utf-8');
    }

    const nextText = updateZedSettingsModelCatalog(
      currentText,
      modelIds,
      port,
      preferredModelId
    );
    if (nextText === null) {
      continue;
    }

    matchedPaths.push(path);
    if (created || nextText !== currentText) {
      writeFileSync(path, nextText);
      updatedPaths.push(path);
    }
  }

  return { updatedPaths, matchedPaths };
}
