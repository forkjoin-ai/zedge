export interface KnownZedgeModel {
  id: string;
  displayName: string;
  maxTokens: number;
  ownedBy: string;
  /**
   * Whether this model is served by the Forkjoin own-runtime distributed
   * inference mesh (fat-station / knots / WASM worker). When true, the
   * 'forkjoin' tier passes chat-completion requests through to the mesh's
   * OpenAI-compatible endpoint before falling back to Moonshine / echo.
   */
  forkjoinTier?: boolean;
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
    forkjoinTier: true,
  },
  {
    id: 'tinyllama-1.1b',
    displayName: 'TinyLlama 1.1B (Moonshine)',
    maxTokens: 2048,
    ownedBy: 'gnosis',
    forkjoinTier: true,
  },
  {
    // Coder model: route to completions/FIM, not chat (chat deflects).
    // Backed by the cached, runnable ~/.edgework/models/qwen-coder-7b.knot.
    id: 'qwen-coder-7b',
    displayName: 'Qwen Coder 7B (Moonshine)',
    maxTokens: 8192,
    ownedBy: 'gnosis',
    forkjoinTier: true,
  },
  {
    id: 'gemma4-31b-it',
    displayName: 'Gemma4 31B Instruct (Moonshine RKNOT)',
    maxTokens: 8192,
    ownedBy: 'gnosis',
    forkjoinTier: true,
  },
  // ── New mesh knots (dense .knot on R2; served by fat-station / the worker
  //    via HTTP Range). Validated tensor counts; the 1-tensor falcon-mamba-7b
  //    and gemma3-4b-it conversions are excluded until re-encoded. ──────────
  {
    id: 'smollm2-360m',
    displayName: 'SmolLM2 360M (Moonshine)',
    maxTokens: 2048,
    ownedBy: 'gnosis',
    forkjoinTier: true,
  },
  // UN-WIRED 2026-05-24: the R2 gemma3-1b-it.knot is BROKEN (gate = 262144/262144
  // NaN logits; pre-Q8-fix 36-byte encode, config 26L/1152h). NOT a pipeline bug —
  // gemma3-4b passes the same Gemma4Pipeline. Re-encode + re-gate, then re-add.
  // {
  //   id: 'gemma3-1b-it',
  //   displayName: 'Gemma3 1B Instruct (Moonshine)',
  //   maxTokens: 8192,
  //   ownedBy: 'gnosis',
  //   forkjoinTier: true,
  // },
  {
    // ADMITTED (monster-guard PASS, Paris 12095 rank0 logit11.30). Re-knot fixed
    // rope_theta: 1e6→10000 (encoder qwen2 branch now uses _resolve_rope_theta;
    // transformers v5 nests rope_theta under rope_scaling). qwen2->NativeLlama.
    id: 'deepseek-r1-1.5b',
    displayName: 'DeepSeek-R1 Distill Qwen 1.5B (Moonshine)',
    maxTokens: 4096,
    ownedBy: 'gnosis',
    forkjoinTier: true,
  },
  {
    id: 'phi-3.5-mini',
    displayName: 'Phi-3.5 Mini (Moonshine)',
    maxTokens: 8192,
    ownedBy: 'gnosis',
    forkjoinTier: true,
  },
  {
    // ADMITTED (Paris 7785 rank0, nan=0) after the full SSM fix chain: Q8 loader
    // (34-byte), a_log F32, A-discretization, causal-conv1d reorder, and the
    // tied-lm_head fallback (mamba ties lm_head to the embedding; the loader was
    // returning an all-zero output_weight). mamba arch -> MambaPipeline.
    id: 'mamba-2.8b',
    displayName: 'Mamba 2.8B (Moonshine SSM)',
    maxTokens: 2048,
    ownedBy: 'gnosis',
    forkjoinTier: true,
  },
  {
    // Landed + config-QA'd on R2 (4.4 GB, arch qwen2 [loader default], 28
    // layers / 3584 hidden / 339 tensors). Same arch as the proven
    // qwen-coder-7b (Paris gate verified), so the NativeLlama path serves it.
    id: 'qwen2.5-7b',
    displayName: 'Qwen2.5 7B Instruct (Moonshine)',
    maxTokens: 8192,
    ownedBy: 'gnosis',
    forkjoinTier: true,
  },
  {
    // Re-encoded 34-byte Q8_0; ADMITTED via monster-guard (Paris token 6233 rank
    // 0, reject 1040 fails) after the runtime bowl_q_filter fix. mistral = qwen2
    // arch -> NativeLlama. See monster-swarm/ADMITTED_MODELS.md.
    id: 'mistral-7b',
    displayName: 'Mistral 7B Instruct v0.3 (Moonshine)',
    maxTokens: 8192,
    ownedBy: 'gnosis',
    forkjoinTier: true,
  },
  {
    // Re-encoded with the rope_theta-from-rope_scaling fix (500000, was 10000)
    // + bowl_q_filter runtime fix. ADMITTED via monster-guard (Paris 12366 rank0,
    // reject 279 fails). arch=llama -> NativeLlama (28L / 3072h / 254 tensors).
    id: 'llama-3.2-3b',
    displayName: 'Llama 3.2 3B Instruct (Moonshine)',
    maxTokens: 8192,
    ownedBy: 'gnosis',
    forkjoinTier: true,
  },
  {
    // ADMITTED via monster-guard (Paris 12095 rank0, logit 20.69) after the
    // amplituhedron-hotpath fix (it corrupted qwen3's qkv_dim!=hidden_dim path).
    // qwen3 dense -> NativeLlama with per-head q/k-norm (36L / 2560h / 32 heads).
    id: 'qwen3-4b',
    displayName: 'Qwen3 4B (Moonshine)',
    maxTokens: 8192,
    ownedBy: 'gnosis',
    forkjoinTier: true,
  },
  {
    // ADMITTED via monster-guard (Paris 12095 rank0, logit 21.95) after the
    // amplituhedron-hotpath fix. qwen3 dense -> NativeLlama + per-head q/k-norm.
    id: 'qwen3-8b',
    displayName: 'Qwen3 8B (Moonshine)',
    maxTokens: 8192,
    ownedBy: 'gnosis',
    forkjoinTier: true,
  },
  {
    // ADMITTED (Paris 6671 rank0, nan=0). Falcon-Mamba is Mamba-1 + weightless
    // RMSNorms on B/C/dt (FalconMamba's stability addition); fixes: d_inner
    // derived from conv weight (config expand=16 was wrong→8192), and the
    // weightless b/c/dt rms applied in mamba1_s6_step. falcon-mamba->MambaPipeline.
    id: 'falcon-mamba-7b',
    displayName: 'Falcon-Mamba 7B (Moonshine SSM)',
    maxTokens: 8192,
    ownedBy: 'gnosis',
    forkjoinTier: true,
  },
  {
    // ADMITTED 2026-05-24 (Paris 9079 rank0, logit 21.25 == HF; monster-guard PASS).
    // Fixed the SWAPPED gemma3 sandwich norms in model_gemma4.rs: the knot's
    // ffn_norm IS HF post_attention_layernorm and post_attention_norm IS HF
    // pre_feedforward_layernorm (llama.cpp gemma naming) — were fetched backwards.
    id: 'gemma3-4b-it',
    displayName: 'Gemma3 4B Instruct (Moonshine)',
    maxTokens: 8192,
    ownedBy: 'gnosis',
    forkjoinTier: true,
  },
  {
    // ADMITTED (Paris 37138 rank0, nan=0). RWKV-7 recurrent (no attention).
    // Fixes: 8 Goose loader bugs (name aliases, *_bias, low-rank dims, channel-mix,
    // v_first) + head partition derived n_heads=hidden/64 (40x64, was 32x80).
    // rwkv7 -> RWKV7Pipeline. See monster-swarm/ADMITTED_MODELS.md.
    id: 'rwkv7-2.9b',
    displayName: 'RWKV-7 2.9B (Moonshine recurrent)',
    maxTokens: 4096,
    ownedBy: 'gnosis',
    forkjoinTier: true,
  },
  {
    // ADMITTED 2026-05-24 (vision-language / image-understanding). Real caption of
    // a test face image, coherent + on-topic. Re-encode carries the Qwen2.5-VL
    // vision tower (build 9da8efe5, 4.32GB); model_qwen2vl_vit.rs ViT -> 256 visual
    // tokens spliced before text -> NativeLlama. Text backbone arch=qwen2.
    id: 'qwen2.5-vl-3b',
    displayName: 'Qwen2.5-VL 3B (Moonshine vision)',
    maxTokens: 8192,
    ownedBy: 'gnosis',
    forkjoinTier: true,
  },
];

const KNOWN_ZEDGE_MODELS_BY_ID = new Map(
  KNOWN_ZEDGE_MODELS.map((model) => [model.id, model])
);

const LEGACY_EDGEWORK_MODEL_IDS = new Set([
  'wasm-local',
  // Demoted: knot exists neither locally nor in R2. Re-promote once produced.
  'qwen2.5-0.5b-instruct',
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
  if (whitelist && whitelist.length > 0 && whitelist[0] !== '') {
    return new Set(whitelist);
  }

  return null;
}

/** Returns whether a fallback catalog model should be exposed by default. */
export function isModelVisible(modelId: string): boolean {
  const whitelist = getExplicitModelWhitelist();
  if (whitelist) {
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
  if (whitelist) {
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

/**
 * Returns whether a model should be routed through the Forkjoin own-runtime
 * distributed inference mesh ('forkjoin' tier). True for catalog models flagged
 * `forkjoinTier`, and for explicit mesh/local naming conventions so live or
 * uncataloged mesh models (e.g. gnosis-local variants) still passthrough.
 */
export function isForkjoinTierModel(modelId: string): boolean {
  const known = getKnownZedgeModel(modelId);
  if (known?.forkjoinTier === true) {
    return true;
  }

  const normalized = modelId.trim().toLowerCase();
  return (
    normalized === 'gnosis-local' ||
    normalized.startsWith('gnosis-local') ||
    normalized.startsWith('qwen-coder') ||
    normalized.startsWith('forkjoin')
  );
}

/** Builds the model metadata shape that Zed expects in settings.json. */
export function buildZedAvailableModels(
  modelIds: Iterable<string>,
  _options: { includeLocalWasm?: boolean } = {}
): ZedAvailableModel[] {
  const seen = new Set<string>();
  const orderedIds: string[] = [];

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
