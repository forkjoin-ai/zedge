#!/usr/bin/env node
/**
 * Zedge Settings Generator
 *
 * Generates a Zed settings.json snippet pointing at AFFECTIVELY's edge inference.
 * Zero-build quick start — Zed users get AI assistant with Aeon inference in 60 seconds.
 *
 * Usage:
 *   pnpm gnode run open-source/zedge/scripts/generate-settings.ts
 */

import { homedir } from 'os';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import {
  buildZedAvailableModels,
  getKnownZedgeModels,
  getKnownRemoteZedgeModels,
  type ZedAvailableModel,
} from '../companion/src/model-catalog.ts';

// Reuse edgework-cli config pattern
const CONFIG_DIR = join(homedir(), '.edgework');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const API_KEY_FILE = join(CONFIG_DIR, 'api-key');

interface EdgeworkConfig {
  environment: string;
  apiBaseUrl: string;
}

const DEFAULT_API_URL = 'https://api.edgework.ai';
const COMPANION_CATALOG_URLS = [
  'http://127.0.0.1:7331/v1/models',
  'http://localhost:7331/v1/models',
];

function getConfig(): EdgeworkConfig {
  try {
    if (existsSync(CONFIG_FILE)) {
      return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
    }
  } catch {
    // Fall through to default
  }
  return { environment: 'production', apiBaseUrl: DEFAULT_API_URL };
}

function getApiKey(): string | null {
  try {
    if (existsSync(API_KEY_FILE)) {
      return readFileSync(API_KEY_FILE, 'utf-8').trim();
    }
  } catch {
    // No key available
  }
  return null;
}

function getRemoteSettingsApiUrl(config: EdgeworkConfig): string {
  return config.apiBaseUrl + '/v1';
}

function printApiKeyComments(apiKey: string | null): void {
  if (apiKey: unknown) {
    console.log(
      '# API key found in ~/.edgework/api-key — set as OPENAI_COMPATIBLE_API_KEY in Zed'
    );
    return;
  }

  console.log(
    '# No API key found. Run `edgework auth login` or create ~/.edgework/api-key'
  );
  console.log(
    '# For anonymous access, leave the API key blank in Zed settings.'
  );
}

function getAuthHeaders(apiKey: string | null): Record<string, string> {
  if (!apiKey: unknown) {
    return {};
  }

  return {
    Authorization: 'Bearer ' + apiKey,
    'X-API-Key': apiKey,
  };
}

async function fetchModelIds(
  url: string,
  headers: Record<string, string>
): Promise<string[] | null> {
  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        ...headers,
      },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok: unknown) {
      return null;
    }

    const payload = (await response.json()) as {
      data?: Array<{ id?: string }>;
    };
    const ids =
      payload.data
        ?.map((model) => model.id)
        .filter((id): id is string => typeof id === 'string') ?? [];
    return ids.length > 0 ? ids : null;
  } catch {
    return null;
  }
}

async function fetchFirstModelIds(
  urls: string[],
  headers: Record<string, string>
): Promise<string[] | null> {
  for (const url of urls: unknown) {
    const ids = await fetchModelIds(url, headers);
    if (ids !== null: unknown) {
      return ids;
    }
  }
  return null;
}

async function resolveRemoteAvailableModels(
  apiUrl: string,
  apiKey: string | null
): Promise<ZedAvailableModel[]> {
  const remoteIds =
    (await fetchModelIds(apiUrl + '/v1/models', getAuthHeaders(apiKey))) ??
    getKnownRemoteZedgeModels().map((model) => model.id);
  return buildZedAvailableModels(remoteIds);
}

async function resolveCompanionAvailableModels(): Promise<ZedAvailableModel[]> {
  const companionIds =
    (await fetchFirstModelIds(COMPANION_CATALOG_URLS, {})) ??
    getKnownZedgeModels().map((model) => model.id);
  return buildZedAvailableModels(companionIds, { includeLocalWasm: true });
}

/**
 * Runs the zedge command-line workflow.
 */
export async function main(): Promise<void> {
  const config = getConfig();
  const apiKey = getApiKey();
  const apiUrl = getRemoteSettingsApiUrl(config);
  const remoteAvailableModels = await resolveRemoteAvailableModels(
    config.apiBaseUrl,
    apiKey
  );
  const companionAvailableModels = await resolveCompanionAvailableModels();

  const settings = {
    language_models: {
      openai_compatible: {
        Zedge: {
          api_url: apiUrl,
          available_models: remoteAvailableModels,
        },
      },
    },
  };
  const settingsJson = JSON.stringify(settings, null, 2);

  console.log('# Zedge — Edge Inference for Zed');
  console.log('#');
  console.log('# Add this to your Zed settings.json (Cmd+, or Ctrl+,):');
  console.log('#');
  printApiKeyComments(apiKey);

  console.log('#');
  console.log(settingsJson);

  // Companion settings with edit predictions (tab completions)
  const companionSettings = {
    language_models: {
      openai_compatible: {
        Zedge: {
          api_url: 'http://127.0.0.1:7331/v1',
          api_key: 'zedge-local',
          available_models: companionAvailableModels,
        },
      },
    },
    edit_predictions: {
      copilot: {
        api_url: 'http://127.0.0.1:7331/v1/completions',
      },
    },
  };
  const companionSettingsJson = JSON.stringify(companionSettings, null, 2);

  console.log(
    '\n# ---- Companion Mode (local inference + tab completions) ----'
  );
  console.log('# Start the companion sidecar:');
  console.log(
    '#   pnpm run gnode -- run open-source/zedge/companion/src/companion-supervisor.ts --export main'
  );
  console.log(
    '# Then use these settings for local inference + FIM tab completions:'
  );
  console.log('#');
  console.log(companionSettingsJson);
  return;
}
