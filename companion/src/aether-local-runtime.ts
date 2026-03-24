import { formatChatPrompt } from "../../../aether/src/config/chat-templates.ts";

export interface LocalChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

type TransformersPipeline = (
  input: unknown,
  options?: Record<string, unknown>
) => Promise<unknown>;

interface TransformersEnvironment {
  allowLocalModels?: boolean;
  allowRemoteModels?: boolean;
  backends?: {
    onnx?: {
      wasm?: {
        numThreads?: number;
      };
    };
  };
}

interface TransformersModule {
  pipeline: (
    task: string,
    modelId: string,
    options?: Record<string, unknown>
  ) => Promise<TransformersPipeline>;
  env: TransformersEnvironment;
}

const LOCAL_CHAT_MODEL_CASCADE = [
  {
    modelId: 'onnx-community/SmolLM2-360M-Instruct',
    templateModel: 'smollm2-360m',
  },
  {
    modelId: 'Xenova/TinyLlama-1.1B-Chat-v1.0',
    templateModel: 'tinyllama-1.1b',
  },
] as const;

const LOCAL_EMBED_MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const LOCAL_HASH_EMBED_MODEL_ID = 'local-ngram-hash';
const LOCAL_EMBED_DIMS = 384;

function scrubGeneratedText(text: string): string {
  return text
    .replace(/<\|im_end\|>.*/s, '')
    .replace(/<\|im_start\|>.*/s, '')
    .trim();
}

function extractGeneratedText(result: unknown): string {
  if (typeof result === 'string') {
    return scrubGeneratedText(result);
  }

  if (!result || typeof result !== 'object') {
    return '';
  }

  if (
    'generated_text' in result &&
    typeof result.generated_text === 'string'
  ) {
    return scrubGeneratedText(result.generated_text);
  }

  if (!Array.isArray(result) || result.length === 0) {
    return '';
  }

  const first = result[0];
  if (
    first &&
    typeof first === 'object' &&
    'generated_text' in first &&
    typeof first.generated_text === 'string'
  ) {
    return scrubGeneratedText(first.generated_text);
  }

  return '';
}

function l2Normalize(vector: number[]): number[] {
  let magnitude = 0;
  for (const value of vector) {
    magnitude += value * value;
  }

  if (magnitude <= 0) {
    return vector;
  }

  const norm = Math.sqrt(magnitude);
  return vector.map((value) => value / norm);
}

function extractEmbedding(result: unknown): number[] | null {
  if (!result || typeof result !== 'object') {
    return null;
  }

  if ('data' in result && ArrayBuffer.isView(result.data)) {
    return l2Normalize(
      Array.from(result.data as unknown as ArrayLike<number>)
    );
  }

  if ('data' in result && Array.isArray(result.data)) {
    return l2Normalize(Array.from(result.data as number[]));
  }

  return null;
}

function localHashEmbed(text: string, dims = LOCAL_EMBED_DIMS): number[] {
  const vec = new Float32Array(dims);
  const normalized = text.toLowerCase();

  for (let i = 0; i <= normalized.length - 3; i++) {
    const trigram = normalized.slice(i, i + 3);
    let hash = 0;
    for (let j = 0; j < trigram.length; j++) {
      hash = ((hash << 5) - hash + trigram.charCodeAt(j)) | 0;
    }
    const bucket = ((hash % dims) + dims) % dims;
    vec[bucket] += 1;
  }

  let magnitude = 0;
  for (let i = 0; i < dims; i++) {
    magnitude += vec[i] * vec[i];
  }
  magnitude = Math.sqrt(magnitude);

  if (magnitude > 0) {
    for (let i = 0; i < dims; i++) {
      vec[i] /= magnitude;
    }
  }

  return Array.from(vec);
}

class AetherLocalRuntime {
  private transformersPromise: Promise<TransformersModule> | null = null;
  private chatPipe: TransformersPipeline | null = null;
  private chatLoadingPromise: Promise<boolean> | null = null;
  private chatLoadFailed = false;
  private chatTemplateModel: string = LOCAL_CHAT_MODEL_CASCADE[0].templateModel;
  private chatModelId: string | null = null;
  private embedPipe: TransformersPipeline | null = null;
  private embedLoadingPromise: Promise<boolean> | null = null;
  private embedLoadFailed = false;
  private embeddingModelId = LOCAL_HASH_EMBED_MODEL_ID;

  private async loadTransformers(): Promise<TransformersModule> {
    if (!this.transformersPromise) {
      this.transformersPromise = import(
        '@xenova/transformers'
      ) as Promise<TransformersModule>;
    }

    const transformers = await this.transformersPromise;
    transformers.env.allowLocalModels = false;
    transformers.env.allowRemoteModels = true;
    if (transformers.env.backends?.onnx?.wasm) {
      transformers.env.backends.onnx.wasm.numThreads = 1;
    }

    return transformers;
  }

  async ensureChatReady(): Promise<boolean> {
    if (this.chatPipe) return true;
    if (this.chatLoadFailed) return false;
    if (this.chatLoadingPromise) return this.chatLoadingPromise;

    this.chatLoadingPromise = this.loadChatPipeline();
    return this.chatLoadingPromise;
  }

  get chatStatus(): 'idle' | 'loading' | 'ready' | 'failed' {
    if (this.chatPipe) {
      return 'ready';
    }
    if (this.chatLoadFailed) {
      return 'failed';
    }
    if (this.chatLoadingPromise) {
      return 'loading';
    }
    return 'idle';
  }

  private async loadChatPipeline(): Promise<boolean> {
    try {
      const { pipeline } = await this.loadTransformers();

      for (const candidate of LOCAL_CHAT_MODEL_CASCADE) {
        try {
          this.chatPipe = await pipeline('text-generation', candidate.modelId, {
            quantized: true,
          });
          this.chatTemplateModel = candidate.templateModel;
          this.chatModelId = candidate.modelId;
          return true;
        } catch {
          continue;
        }
      }
    } catch {
      // Fall through to load failure below.
    }

    this.chatLoadFailed = true;
    return false;
  }

  async generate(
    messages: LocalChatMessage[],
    maxTokens: number,
    temperature: number
  ): Promise<string> {
    const ready = await this.ensureChatReady();
    if (!ready || !this.chatPipe) {
      throw new Error('Local model failed to load');
    }

    const prompt = formatChatPrompt(messages, this.chatTemplateModel);
    const result = await this.chatPipe(prompt, {
      max_new_tokens: Math.min(maxTokens, 512),
      temperature: Math.max(0.1, temperature),
      do_sample: temperature > 0,
      return_full_text: false,
    });

    return extractGeneratedText(result);
  }

  async ensureEmbeddingReady(): Promise<boolean> {
    if (this.embedPipe) return true;
    if (this.embedLoadFailed) return false;
    if (this.embedLoadingPromise) return this.embedLoadingPromise;

    this.embedLoadingPromise = this.loadEmbeddingPipeline();
    return this.embedLoadingPromise;
  }

  private async loadEmbeddingPipeline(): Promise<boolean> {
    try {
      const { pipeline } = await this.loadTransformers();
      this.embedPipe = await pipeline(
        'feature-extraction',
        LOCAL_EMBED_MODEL_ID,
        { quantized: true }
      );
      this.embeddingModelId = LOCAL_EMBED_MODEL_ID;
      return true;
    } catch {
      this.embedLoadFailed = true;
      this.embeddingModelId = LOCAL_HASH_EMBED_MODEL_ID;
      return false;
    }
  }

  async embed(text: string): Promise<number[]> {
    const ready = await this.ensureEmbeddingReady();
    if (!ready || !this.embedPipe) {
      return localHashEmbed(text);
    }

    try {
      const result = await this.embedPipe(text, {
        pooling: 'mean',
        normalize: true,
      });
      const embedding = extractEmbedding(result);
      if (embedding && embedding.length > 0) {
        this.embeddingModelId = LOCAL_EMBED_MODEL_ID;
        return embedding;
      }
    } catch {
      // Fall through to the hash fallback below.
    }

    this.embeddingModelId = LOCAL_HASH_EMBED_MODEL_ID;
    return localHashEmbed(text);
  }

  get modelId(): string {
    return this.chatModelId ?? 'wasm-local';
  }

  get localEmbeddingModelId(): string {
    return this.embeddingModelId;
  }
}

export const aetherLocalRuntime = new AetherLocalRuntime();
