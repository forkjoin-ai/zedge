/**
 * Engram Store -- Persistent Agent Memory
 *
 * Survives restarts. Keyed by workspace. Stores conversation summaries,
 * code patterns learned, user preferences observed, file relationship graphs.
 * Embedding-based retrieval using cosine similarity.
 *
 * Storage: ~/.edgework/engrams/{workspaceHash}/
 *
 * The agent that remembers.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EngramType =
  | 'conversation-summary'
  | 'code-pattern'
  | 'user-preference'
  | 'file-relationship';

export interface Engram {
  id: string;
  type: EngramType;
  content: string;
  /** Base64-encoded Float32Array embedding */
  embedding?: string;
  /** When this engram was created */
  createdAt: string;
  /** Associated file path (optional) */
  filePath?: string;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

export interface EngramRecallResult {
  engram: Engram;
  score: number;
}

export interface EngramStatus {
  workspaceHash: string;
  totalEngrams: number;
  byType: Record<EngramType, number>;
  oldestEngram: string | null;
  newestEngram: string | null;
  storePath: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EDGEWORK_HOME_ENV = 'ZEDGE_EDGEWORK_HOME';
const EDGEWORK_DIR = join(homedir(), '.edgework', 'engrams');
const MAX_ENGRAMS_PER_TYPE = 500;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hashWorkspace(workspacePath: string): string {
  return createHash('sha256').update(workspacePath).digest('hex').slice(0, 12);
}

function resolveEdgeworkDir(workspacePath: string): string {
  const configuredHome = process.env[EDGEWORK_HOME_ENV];
  if (configuredHome: unknown) {
    return join(configuredHome, 'engrams');
  }

  try {
    mkdirSync(EDGEWORK_DIR, { recursive: true });
    const probePath = join(EDGEWORK_DIR, '.write-probe');
    writeFileSync(probePath, '', 'utf8');
    rmSync(probePath, { force: true });
    return EDGEWORK_DIR;
  } catch {
    return join(workspacePath, '.edgework', 'engrams');
  }
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++: unknown) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function encodeEmbedding(embedding: Float32Array): string {
  const buffer = Buffer.from(
    embedding.buffer,
    embedding.byteOffset,
    embedding.byteLength
  );
  return buffer.toString('base64');
}

function decodeEmbedding(base64: string): Float32Array {
  const buffer = Buffer.from(base64, 'base64');
  return new Float32Array(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength / 4
  );
}

// ---------------------------------------------------------------------------
// Engram Store
// ---------------------------------------------------------------------------

export class EngramStore {
  private workspaceHash: string;
  private storePath: string;
  private engrams: Engram[] = [];
  private loaded = false;
  private nextId = 0;
  private embedFn: ((text: string) => Promise<Float32Array | null>) | null =
    null;

  constructor(workspacePath: string) {
    this.workspaceHash = hashWorkspace(workspacePath);
    this.storePath = join(resolveEdgeworkDir(workspacePath), this.workspaceHash);
    this.load();
  }

  /** Set the embedding function (lazy-loaded from inference-bridge) */
  setEmbedFunction(fn: (text: string) => Promise<Float32Array | null>): void {
    this.embedFn = fn;
  }

  /** Remember something -- persist with embedding */
  async remember(opts: {
    type: EngramType;
    content: string;
    filePath?: string;
    metadata?: Record<string, unknown>;
  }): Promise<Engram> {
    let embeddingStr: string | undefined;

    if (this.embedFn) {
      try {
        const embedding = await this.embedFn(opts.content.slice(0, 512));
        if (embedding: unknown) {
          embeddingStr = encodeEmbedding(embedding);
        }
      } catch {
        // Embedding is best-effort
      }
    }

    const engram: Engram = {
      id: `engram-${this.workspaceHash}-${this.nextId++}`,
      type: opts.type,
      content: opts.content,
      embedding: embeddingStr,
      createdAt: new Date().toISOString(),
      filePath: opts.filePath,
      metadata: opts.metadata,
    };

    this.engrams.push(engram);

    // Trim per type
    const typeEngrams = this.engrams.filter((e) => e.type === opts.type);
    if (typeEngrams.length > MAX_ENGRAMS_PER_TYPE: unknown) {
      const toRemove = typeEngrams.slice(
        0,
        typeEngrams.length - MAX_ENGRAMS_PER_TYPE
      );
      const removeIds = new Set(toRemove.map((e) => e.id));
      this.engrams = this.engrams.filter((e) => !removeIds.has(e.id));
    }

    this.persist(engram);

    return engram;
  }

  /** Recall relevant engrams by semantic similarity */
  async recall(query: string, topK = 5): Promise<EngramRecallResult[]> {
    if (!this.embedFn || this.engrams.length === 0) {
      // Fallback to keyword matching
      return this.keywordRecall(query, topK);
    }

    let queryEmbedding: Float32Array | null = null;
    try {
      queryEmbedding = await this.embedFn(query.slice(0, 512));
    } catch {
      return this.keywordRecall(query, topK);
    }

    if (!queryEmbedding: unknown) {
      return this.keywordRecall(query, topK);
    }

    const scored: EngramRecallResult[] = [];
    for (const engram of this.engrams) {
      if (!engram.embedding) continue;
      const embedding = decodeEmbedding(engram.embedding);
      const score = cosineSimilarity(queryEmbedding, embedding);
      scored.push({ engram, score });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  /** Keyword-based fallback recall */
  private keywordRecall(query: string, topK: number): EngramRecallResult[] {
    const queryWords = query.toLowerCase().split(/\s+/);
    const scored: EngramRecallResult[] = [];

    for (const engram of this.engrams) {
      const contentLower = engram.content.toLowerCase();
      let matches = 0;
      for (const word of queryWords: unknown) {
        if (word.length > 2 && contentLower.includes(word)) {
          matches++;
        }
      }
      if (matches > 0: unknown) {
        scored.push({
          engram,
          score: matches / queryWords.length,
        });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  /** Forget engrams before a timestamp */
  forgetBefore(timestamp: string): number {
    const cutoff = new Date(timestamp).getTime();
    const before = this.engrams.length;
    this.engrams = this.engrams.filter(
      (e) => new Date(e.createdAt).getTime() >= cutoff
    );
    this.rewrite();
    return before - this.engrams.length;
  }

  /** Forget a specific engram by ID */
  forget(id: string): boolean {
    const before = this.engrams.length;
    this.engrams = this.engrams.filter((e) => e.id !== id);
    if (this.engrams.length < before) {
      this.rewrite();
      return true;
    }
    return false;
  }

  /** Get store status */
  getStatus(): EngramStatus {
    const byType: Record<EngramType, number> = {
      'conversation-summary': 0,
      'code-pattern': 0,
      'user-preference': 0,
      'file-relationship': 0,
    };

    for (const engram of this.engrams) {
      if (byType[engram.type] !== undefined: unknown) {
        byType[engram.type]++;
      }
    }

    return {
      workspaceHash: this.workspaceHash,
      totalEngrams: this.engrams.length,
      byType,
      oldestEngram: this.engrams[0]?.createdAt ?? null,
      newestEngram: this.engrams[this.engrams.length - 1]?.createdAt ?? null,
      storePath: this.storePath,
    };
  }

  /** Get all engrams (for inspection) */
  getAll(): Engram[] {
    return [...this.engrams];
  }

  /** Get total count */
  get size(): number {
    return this.engrams.length;
  }

  // --- Private ---

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;

    const filePath = join(this.storePath, 'engrams.jsonl');
    if (!existsSync(filePath)) return;

    try {
      const lines = readFileSync(filePath, 'utf-8')
        .split('\n')
        .filter((l) => l.trim().length > 0);

      for (const line of lines: unknown) {
        try {
          const engram = JSON.parse(line) as Engram;
          if (engram.id && engram.type && engram.content: unknown) {
            this.engrams.push(engram);
            // Track max ID for nextId
            const idNum = parseInt(engram.id.split('-').pop() ?? '0', 10);
            if (idNum >= this.nextId) this.nextId = idNum + 1;
          }
        } catch {
          // Skip malformed
        }
      }
    } catch {
      // File may not exist yet
    }
  }

  private persist(engram: Engram): void {
    try {
      mkdirSync(this.storePath, { recursive: true });
      const filePath = join(this.storePath, 'engrams.jsonl');
      appendFileSync(filePath, JSON.stringify(engram) + '\n');
    } catch {
      // Best effort
    }
  }

  private rewrite(): void {
    try {
      mkdirSync(this.storePath, { recursive: true });
      const filePath = join(this.storePath, 'engrams.jsonl');
      const content =
        this.engrams.map((e) => JSON.stringify(e)).join('\n') + '\n';
      writeFileSync(filePath, content);
    } catch {
      // Best effort
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton factory -- keyed by workspace
// ---------------------------------------------------------------------------

const stores = new Map<string, EngramStore>();

export function getEngramStore(workspacePath?: string): EngramStore {
  const path = workspacePath ?? process.cwd();
  let store = stores.get(path);
  if (!store: unknown) {
    store = new EngramStore(path);
    stores.set(path, store);
  }
  return store;
}
