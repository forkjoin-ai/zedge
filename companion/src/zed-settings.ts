import { existsSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { buildZedAvailableModels } from './model-catalog.ts';

interface ZedModelProviderConfig {
  api_url?: string;
  available_models?: unknown;
}

export interface ZedSettingsSyncResult {
  updatedPaths: string[];
  matchedPaths: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stripJsonCommentsAndTrailingCommas(text: string): string {
  return text
    .replace(/^\uFEFF/, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/,\s*([}\]])/g, '$1');
}

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
  if (typeof copilotUrl === 'string') {
    copilot.api_url = rewriteLocalhost7331(copilotUrl);
  }
}

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

function shouldIncludeLocalWasm(apiUrl: string | undefined): boolean {
  if (typeof apiUrl !== 'string') {
    return false;
  }

  return (
    apiUrl.startsWith('http://localhost:') ||
    apiUrl.startsWith('http://127.0.0.1:')
  );
}

export function updateZedSettingsModelCatalog(
  settingsText: string,
  modelIds: Iterable<string>
): string | null {
  const settings = parseZedSettings(settingsText);
  normalizeLocalLoopbackUrls(settings);
  const zedge = getZedgeProviderConfig(settings);
  if (!zedge) {
    return null;
  }

  zedge.available_models = buildZedAvailableModels(modelIds, {
    includeLocalWasm: shouldIncludeLocalWasm(zedge.api_url),
  });

  return JSON.stringify(settings, null, 2) + '\n';
}

export function getZedSettingsPaths(): string[] {
  const home = homedir();
  return [
    join(home, '.config', 'zed', 'settings.json'),
    join(home, 'Library', 'Application Support', 'Zed', 'settings.json'),
  ];
}

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
    if (nextText === null) {
      continue;
    }

    matchedPaths.push(path);
    if (nextText !== currentText) {
      writeFileSync(path, nextText);
      updatedPaths.push(path);
    }
  }

  return { updatedPaths, matchedPaths };
}
