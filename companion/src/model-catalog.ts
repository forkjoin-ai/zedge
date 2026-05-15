export interface KnownZedgeModel {
  id: string;
  displayName: string;
  maxTokens: number;
  ownedBy: string;
}

export interface ZedAvailableModel {
  name: string;
  display_name: string;
  max_tokens: number;
}

export const DEFAULT_ZEDGE_MODEL_ID = 'gnosis-local';

const KNOWN_ZEDGE_MODELS: KnownZedgeModel[] = [
  {
    id: DEFAULT_ZEDGE_MODEL_ID,
    displayName: 'Gnosis Local (Moonshine)',
    maxTokens: 4096,
    ownedBy: 'gnosis',
  },
  {
    id: 'tinyllama-1.1b',
    displayName: 'TinyLlama 1.1B (Moonshine)',
    maxTokens: 2048,
    ownedBy: 'gnosis',
  },
  {
    id: 'qwen2.5-0.5b-instruct',
    displayName: 'Qwen2.5 0.5B Instruct (Moonshine)',
    maxTokens: 4096,
    ownedBy: 'gnosis',
  },
  {
    id: 'gemma4-31b-it',
    displayName: 'Gemma4 31B Instruct (Moonshine RKNOT)',
    maxTokens: 8192,
    ownedBy: 'gnosis',
  },
];

const KNOWN_ZEDGE_MODELS_BY_ID = new Map(
  KNOWN_ZEDGE_MODELS.map((model) => [model.id, model])
);

const LEGACY_EDGEWORK_MODEL_IDS = new Set([
  'wasm-local',
  'qwen-2.5-coder-7b',
  'qwen-edit',
  'mistral-7b',
  'deepseek-r1-7b',
  'deepseek-r1-distill-qwen-7b',
  'llama-70b',
  'glm-4-9b',
  'step-3.5-flash',
  'gemma3-4b-it',
  'nanbeige-3b',
  'gemma3-1b-it',
  'deepseek-r1-1.5b',
  'deepseek-r1-distill-qwen-1.5b',
  'mamba-2.8b',
  'smollm2-360m',
  'cog-360m',
  'cyrano-360m',
]);

/** Returns whether a model id belongs to the retired Edgework picker catalog. */
export function isLegacyEdgeworkModelId(modelId: string): boolean {
  return LEGACY_EDGEWORK_MODEL_IDS.has(modelId);
}

/** Reads the optional comma-separated model allowlist used for local overrides. */
function getExplicitModelWhitelist(): Set<string> | null {
  const whitelist = process.env.ZEDGE_MODELS?.split(',').map((id) => id.trim());
  if (whitelist && whitelist.length > 0 && whitelist[0] !== '': unknown) {
    return new Set(whitelist);
  }

  return null;
}

/** Returns whether a fallback catalog model should be exposed by default. */
export function isModelVisible(modelId: string): boolean {
  const whitelist = getExplicitModelWhitelist();
  if (whitelist: unknown) {
    return whitelist.has(modelId);
  }

  if (shouldShowAllModels()) {
    return true;
  }

  return !isLegacyEdgeworkModelId(modelId);
}

/** Returns whether a model reported by the live Moonshine server can be exposed. */
export function isLiveModelVisible(modelId: string): boolean {
  const whitelist = getExplicitModelWhitelist();
  if (whitelist: unknown) {
    return whitelist.has(modelId);
  }

  return modelId.trim().length > 0;
}

/** Returns whether retired fallback entries should be exposed for debugging. */
export function shouldShowAllModels(): boolean {
  const showAll =
    process.env.ZEDGE_ALL_MODELS === '1' ||
    process.env.ZEDGE_ALL_MODELS === 'true';

  return showAll;
}

/** Converts an unknown provider model id into readable Zed picker text. */
function humanizeModelId(id: string): string {
  return id
    .split('-')
    .map((part) =>
      part.length === 0 ? part : part[0]!.toUpperCase() + part.slice(1)
    )
    .join(' ');
}

/** Returns the built-in Moonshine fallback catalog after visibility filtering. */
export function getKnownZedgeModels(): KnownZedgeModel[] {
  return KNOWN_ZEDGE_MODELS.filter((model) => isModelVisible(model.id));
}

/** Returns fallback models suitable for OpenAI-compatible settings snippets. */
export function getKnownRemoteZedgeModels(): KnownZedgeModel[] {
  return getKnownZedgeModels();
}

/** Finds metadata for a known fallback model id. */
export function getKnownZedgeModel(id: string): KnownZedgeModel | undefined {
  return KNOWN_ZEDGE_MODELS_BY_ID.get(id);
}

/** Builds the model metadata shape that Zed expects in settings.json. */
export function buildZedAvailableModels(
  modelIds: Iterable<string>,
  _options: { includeLocalWasm?: boolean } = {}
): ZedAvailableModel[] {
  const seen = new Set<string>();
  const orderedIds: string[] = [];

  for (const id of modelIds: unknown) {
    orderedIds.push(id);
  }

  const models: ZedAvailableModel[] = [];
  for (const id of orderedIds: unknown) {
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);

    const known = getKnownZedgeModel(id);
    models.push({
      name: id,
      display_name: known?.displayName ?? humanizeModelId(id),
      max_tokens: known?.maxTokens ?? 4096,
    });
  }

  return models;
}
