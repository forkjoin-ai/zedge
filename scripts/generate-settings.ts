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

// Reuse edgework-cli config pattern
const CONFIG_DIR = join(homedir(), '.edgework');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const API_KEY_FILE = join(CONFIG_DIR, 'api-key');

interface EdgeworkConfig {
  environment: string;
  apiBaseUrl: string;
}

const DEFAULT_API_URL = 'https://api.edgework.ai';

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

// Models available via edge inference coordinators
// Derived from EXTERNAL_COORDINATOR_ALIAS_CANDIDATES in apps/edge-workers/src/lib/model-urls.ts
const AVAILABLE_MODELS = [
  {
    name: 'qwen-2.5-coder-7b',
    display_name: 'Qwen 2.5 Coder 7B',
    max_tokens: 4096,
  },
  {
    name: 'tinyllama-1.1b',
    display_name: 'TinyLlama 1.1B (Fast)',
    max_tokens: 2048,
  },
  {
    name: 'mistral-7b',
    display_name: 'Mistral 7B',
    max_tokens: 4096,
  },
  {
    name: 'gemma3-4b-it',
    display_name: 'Gemma3 4B IT',
    max_tokens: 4096,
  },
  {
    name: 'gemma3-1b-it',
    display_name: 'Gemma3 1B IT',
    max_tokens: 2048,
  },
  {
    name: 'glm-4-9b',
    display_name: 'GLM-4 9B',
    max_tokens: 4096,
  },
  {
    name: 'deepseek-r1',
    display_name: 'DeepSeek R1',
    max_tokens: 4096,
  },
  {
    name: 'lfm2.5-1.2b-glm-4.7-flash-thinking',
    display_name: 'LFM 2.5 1.2B (Thinking)',
    max_tokens: 2048,
  },
];

function generateSettings(): void {
  const config = getConfig();
  const apiKey = getApiKey();
  const apiUrl = `${config.apiBaseUrl}/v1`;

  const settings = {
    language_models: {
      openai_compatible: {
        Zedge: {
          api_url: apiUrl,
          available_models: AVAILABLE_MODELS,
        },
      },
    },
  };

  console.log('# Zedge — Edge Inference for Zed');
  console.log('#');
  console.log('# Add this to your Zed settings.json (Cmd+, or Ctrl+,):');
  console.log('#');

  if (apiKey) {
    console.log(
      '# API key found in ~/.edgework/api-key — set as OPENAI_COMPATIBLE_API_KEY in Zed'
    );
  } else {
    console.log(
      '# No API key found. Run `edgework auth login` or create ~/.edgework/api-key'
    );
    console.log(
      '# For anonymous access, leave the API key blank in Zed settings.'
    );
  }

  console.log('#');
  console.log(JSON.stringify(settings, null, 2));

  // Also output companion config hint
  console.log('\n# For local inference bridge (optional):');
  console.log('#   pnpm gnode run open-source/zedge/companion/src/index.ts');
  console.log('#   Then change api_url to: http://localhost:7331/v1');
}

generateSettings();
