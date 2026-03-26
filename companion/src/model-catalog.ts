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

const KNOWN_ZEDGE_MODELS: KnownZedgeModel[] = [
  {
    id: 'wasm-local',
    displayName: 'SmolLM2 360M (Local WASM)',
    maxTokens: 2048,
    ownedBy: 'edgework-wasm',
  },
  {
    id: 'qwen-2.5-coder-7b',
    displayName: 'Qwen 2.5 Coder 7B',
    maxTokens: 4096,
    ownedBy: 'edgework',
  },
  {
    id: 'qwen-edit',
    displayName: 'Qwen 2.5 Coder 7B (Edit)',
    maxTokens: 4096,
    ownedBy: 'edgework',
  },
  {
    id: 'mistral-7b',
    displayName: 'Mistral 7B',
    maxTokens: 4096,
    ownedBy: 'edgework',
  },
  {
    id: 'deepseek-r1-7b',
    displayName: 'DeepSeek R1 7B',
    maxTokens: 4096,
    ownedBy: 'edgework',
  },
  {
    id: 'deepseek-r1-distill-qwen-7b',
    displayName: 'DeepSeek R1 7B (Distill)',
    maxTokens: 4096,
    ownedBy: 'edgework',
  },
  {
    id: 'llama-70b',
    displayName: 'LLaMA 2 70B',
    maxTokens: 4096,
    ownedBy: 'edgework',
  },
  {
    id: 'glm-4-9b',
    displayName: 'GLM-4 9B',
    maxTokens: 4096,
    ownedBy: 'edgework',
  },
  {
    id: 'step-3.5-flash',
    displayName: 'Step 3.5 Flash',
    maxTokens: 4096,
    ownedBy: 'edgework',
  },
  {
    id: 'gemma3-4b-it',
    displayName: 'Gemma 3 4B IT',
    maxTokens: 4096,
    ownedBy: 'edgework',
  },
  {
    id: 'nanbeige-3b',
    displayName: 'Nanbeige 3B',
    maxTokens: 4096,
    ownedBy: 'edgework',
  },
  {
    id: 'gemma3-1b-it',
    displayName: 'Gemma 3 1B IT',
    maxTokens: 2048,
    ownedBy: 'edgework',
  },
  {
    id: 'tinyllama-1.1b',
    displayName: 'TinyLlama 1.1B (Fast)',
    maxTokens: 2048,
    ownedBy: 'edgework',
  },
  {
    id: 'deepseek-r1-1.5b',
    displayName: 'DeepSeek R1 1.5B',
    maxTokens: 2048,
    ownedBy: 'edgework',
  },
  {
    id: 'deepseek-r1-distill-qwen-1.5b',
    displayName: 'DeepSeek R1 1.5B (Distill)',
    maxTokens: 2048,
    ownedBy: 'edgework',
  },
  {
    id: 'mamba-2.8b',
    displayName: 'Mamba 2.8B',
    maxTokens: 4096,
    ownedBy: 'edgework',
  },
  {
    id: 'smollm2-360m',
    displayName: 'SmolLM2 360M',
    maxTokens: 1024,
    ownedBy: 'edgework',
  },
  {
    id: 'cog-360m',
    displayName: 'Cog 360M',
    maxTokens: 1024,
    ownedBy: 'edgework',
  },
  {
    id: 'cyrano-360m',
    displayName: 'Cyrano 360M',
    maxTokens: 1024,
    ownedBy: 'edgework',
  },
];

const KNOWN_ZEDGE_MODELS_BY_ID = new Map(
  KNOWN_ZEDGE_MODELS.map((model) => [model.id, model])
);

function humanizeModelId(id: string): string {
  return id
    .split('-')
    .map((part) =>
      part.length === 0 ? part : part[0]!.toUpperCase() + part.slice(1)
    )
    .join(' ');
}

export function getKnownZedgeModels(): KnownZedgeModel[] {
  return [...KNOWN_ZEDGE_MODELS];
}

export function getKnownRemoteZedgeModels(): KnownZedgeModel[] {
  return KNOWN_ZEDGE_MODELS.filter((model) => model.id !== 'wasm-local');
}

export function getKnownZedgeModel(id: string): KnownZedgeModel | undefined {
  return KNOWN_ZEDGE_MODELS_BY_ID.get(id);
}

export function buildZedAvailableModels(
  modelIds: Iterable<string>,
  options: { includeLocalWasm?: boolean } = {}
): ZedAvailableModel[] {
  const seen = new Set<string>();
  const orderedIds: string[] = [];

  if (options.includeLocalWasm === true) {
    orderedIds.push('wasm-local');
  }

  for (const id of modelIds) {
    orderedIds.push(id);
  }

  const models: ZedAvailableModel[] = [];
  for (const id of orderedIds) {
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
