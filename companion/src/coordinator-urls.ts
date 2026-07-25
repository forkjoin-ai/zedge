/**
 * Cloud Run monofat (CPU middle) coordinator URLs for Zedge companion.
 *
 * These are the measured warm-tok/s daily drivers (2026-07-25 routing-clean bench):
 *   mistral-7b        ~189 p50 / ~222 max
 *   gemma3-4b-it      ~147 p50 / ~185 max
 *   gemma4-12b-it     ~144 p50 / ~189 max
 *   gemma4-31b-it     ~147 p50 / ~175 max
 *   codestral-22b     peer-a ~139 p50 / ~204 max; peer-b ~68 p50 (race both)
 *
 * min-instances=0, no GPU. Never point middle-tier models at gnosis-openai-mesh
 * (T11 overflow allowlist only: qwen3-8b, loki-8b-erotica).
 *
 * Env overrides: CLOUDRUN_<SNAKE>_URL or ZEDGE_CLOUDRUN_<SNAKE>_URL.
 * Codestral peers: CLOUDRUN_CODESTRAL_22B_URLS=urlA,urlB (csv).
 */

const CR_SUFFIX =
  process.env.ZEDGE_CLOUDRUN_URL_SUFFIX?.trim() ||
  '6ptd7xm6fq-uc.a.run.app';

function cr(service: string): string {
  return `https://${service}-${CR_SUFFIX}`;
}

function envUrl(...keys: string[]): string | undefined {
  for (const key of keys) {
    const v = process.env[key]?.trim();
    if (v) return v.replace(/\/$/, '');
  }
  return undefined;
}

/** Canonical model id → primary Cloud Run monofat OpenAI base URL. */
export const CLOUD_RUN_COORDINATORS: Record<string, string> = {
  // Daily driver (warm p50 ~189)
  'mistral-7b':
    envUrl('ZEDGE_CLOUDRUN_MISTRAL_7B_URL', 'CLOUDRUN_MISTRAL_7B_URL') ??
    cr('gnosis-openai-mistral-7b'),
  mistral:
    envUrl('ZEDGE_CLOUDRUN_MISTRAL_7B_URL', 'CLOUDRUN_MISTRAL_7B_URL') ??
    cr('gnosis-openai-mistral-7b'),

  // Coding race (prefer peer-a; race via getCloudRunPeerUrls)
  'codestral-22b':
    envUrl('ZEDGE_CLOUDRUN_CODESTRAL_22B_URL', 'CLOUDRUN_CODESTRAL_22B_URL') ??
    cr('gnosis-openai-codestral-22b'),
  codestral:
    envUrl('ZEDGE_CLOUDRUN_CODESTRAL_22B_URL', 'CLOUDRUN_CODESTRAL_22B_URL') ??
    cr('gnosis-openai-codestral-22b'),

  // Gemma capacity ladder (same ~145–155 warm tok/s band on CPU monofat)
  'gemma3-4b-it':
    envUrl('ZEDGE_CLOUDRUN_GEMMA3_4B_IT_URL', 'CLOUDRUN_GEMMA3_4B_IT_URL') ??
    cr('gnosis-openai-gemma3-4b-it'),
  'gemma4-12b-it':
    envUrl('ZEDGE_CLOUDRUN_GEMMA4_12B_IT_URL', 'CLOUDRUN_GEMMA4_12B_IT_URL') ??
    cr('gnosis-openai-gemma4-12b-it'),
  'gemma4-31b-it':
    envUrl('ZEDGE_CLOUDRUN_GEMMA4_31B_IT_URL', 'CLOUDRUN_GEMMA4_31B_IT_URL') ??
    cr('gnosis-openai-gemma4-31b-it'),

  // Present on CR but quality-gated (empty decode / beachhead) — keep wired
  // so /edge-model + probes work; product traffic should prefer the set above.
  'gemma3-1b-it':
    envUrl('ZEDGE_CLOUDRUN_GEMMA3_1B_IT_URL', 'CLOUDRUN_GEMMA3_1B_IT_URL') ??
    cr('gnosis-openai-gemma3-1b-it'),
};

/** Codestral monofat peer mesh (CPU middle stretch). peer-a preferred. */
export const CODESTRAL_22B_PEER_URLS: readonly string[] = (() => {
  const multi = envUrl(
    'ZEDGE_CLOUDRUN_CODESTRAL_22B_URLS',
    'CLOUDRUN_CODESTRAL_22B_URLS'
  );
  if (multi) {
    return multi
      .split(',')
      .map((u) => u.trim().replace(/\/$/, ''))
      .filter((u) => u.length > 0);
  }
  const primary = CLOUD_RUN_COORDINATORS['codestral-22b']!;
  const peerB = cr('gnosis-openai-codestral-22b-b');
  return Array.from(new Set([primary, peerB]));
})();

/** Client-facing model id → body.model the monofat box expects (when different). */
export const CLOUD_RUN_UPSTREAM_MODEL_NAMES: Record<string, string> = {
  'mistral-7b': 'mistral-7b-instruct-v0.3-q4km',
  mistral: 'mistral-7b-instruct-v0.3-q4km',
  codestral: 'codestral-22b',
};

/**
 * Returns whether has Cloud Run Coordinators is true.
 */
export function hasCloudRunCoordinators(): boolean {
  return Object.keys(CLOUD_RUN_COORDINATORS).length > 0;
}

/**
 * Returns whether has Cloud Run Coordinator For Model is true.
 */
export function hasCloudRunCoordinatorForModel(model: string): boolean {
  const id = model.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(CLOUD_RUN_COORDINATORS, id);
}

/**
 * Resolve peer URLs for a model (codestral races a‖b; others single primary).
 */
export function getCloudRunPeerUrls(model: string): string[] {
  const id = model.trim().toLowerCase();
  if (!id) return [];
  if (id === 'codestral-22b' || id === 'codestral') {
    return [...CODESTRAL_22B_PEER_URLS];
  }
  const one = CLOUD_RUN_COORDINATORS[id];
  return one ? [one] : [];
}

/**
 * Upstream model name to put in the OpenAI body for a monofat box.
 */
export function resolveCloudRunUpstreamModel(clientModel: string): string {
  const id = clientModel.trim().toLowerCase();
  return CLOUD_RUN_UPSTREAM_MODEL_NAMES[id] ?? clientModel.trim();
}

/**
 * Models that are product-ready for daily driver / coding (exclude quality fails).
 */
export const PRODUCT_READY_MIDDLE_MODELS = [
  'mistral-7b',
  'codestral-22b',
  'gemma3-4b-it',
  'gemma4-12b-it',
  'gemma4-31b-it',
] as const;
