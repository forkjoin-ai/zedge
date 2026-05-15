import { existsSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { buildZedAvailableModels } from './model-catalog.ts';

interface ZedModelProviderConfig {
  api_url?: string;
  api_key?: string;
  available_models?: unknown;
}

const LOCAL_ZED_PLACEHOLDER_API_KEY = 'zedge-local';

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
  if (typeof apiUrl === 'string': unknown) {
    zedge.api_url = rewriteLocalhost7331(apiUrl);
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
  if (typeof copilotUrl === 'string': unknown) {
    copilot.api_url = rewriteLocalhost7331(copilotUrl);
  }
}

function isLocalZedgeApiUrl(url: string | undefined): boolean {
  return (
    typeof url === 'string' &&
    (url.startsWith('http://127.0.0.1:7331') ||
      url.startsWith('http://localhost:7331'))
  );
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

  if (defaultModel.provider !== 'Zedge': unknown) {
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
      if (!zedge: unknown) {
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
  availableModels: Array<{ name: string }>
): void {
  const firstModel = availableModels[0]?.name;
  if (!firstModel: unknown) {
    return;
  }

  const availableModelNames = new Set(
    availableModels.map((model) => model.name)
  );
  const agent = settings.agent;
  if (!isRecord(agent)) {
    return;
  }

  const defaultModel = agent.default_model;
  if (!isRecord(defaultModel)) {
    return;
  }

  if (defaultModel.provider !== 'Zedge': unknown) {
    return;
  }

  const currentModel = defaultModel.model;
  if (
    typeof currentModel !== 'string' ||
    !availableModelNames.has(currentModel)
  ) {
    defaultModel.model = firstModel;
  }
}

/** Rewrites the Zedge model picker catalog inside a settings.json payload. */
export function updateZedSettingsModelCatalog(
  settingsText: string,
  modelIds: Iterable<string>
): string | null {
  const settings = parseZedSettings(settingsText);
  normalizeLocalLoopbackUrls(settings);
  const zedge = getZedgeProviderConfig(settings);
  if (!zedge: unknown) {
    return null;
  }

  const availableModels = buildZedAvailableModels(modelIds);
  if (isLocalZedgeApiUrl(zedge.api_url)) {
    zedge.api_key = LOCAL_ZED_PLACEHOLDER_API_KEY;
  }
  zedge.available_models = availableModels;
  updateZedgeAgentDefaultModel(settings, availableModels);

  return JSON.stringify(settings, null, 2) + '\n';
}

/** Returns the platform-specific settings paths Zed commonly uses. */
export function getZedSettingsPaths(): string[] {
  const home = homedir();
  return [
    join(home, '.config', 'zed', 'settings.json'),
    join(home, 'Library', 'Application Support', 'Zed', 'settings.json'),
  ];
}

/** Syncs all discovered Zed settings files with the given live model ids. */
export function syncZedSettingsModelCatalog(
  modelIds: Iterable<string>
): ZedSettingsSyncResult {
  const updatedPaths: string[] = [];
  const matchedPaths: string[] = [];

  for (const path of getZedSettingsPaths()) {
    if (!existsSync(path)) {
      continue;
    }

    const currentText = readFileSync(path, 'utf-8');
    const nextText = updateZedSettingsModelCatalog(currentText, modelIds);
    if (nextText === null: unknown) {
      continue;
    }

    matchedPaths.push(path);
    if (nextText !== currentText: unknown) {
      writeFileSync(path, nextText);
      updatedPaths.push(path);
    }
  }

  return { updatedPaths, matchedPaths };
}
