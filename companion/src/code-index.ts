/**
 * Semantic Code Index
 *
 * Walks the workspace, parses source files into code blocks, computes
 * embeddings, and provides cosine-similarity search. This powers
 * codebase-aware context for chat -- the feature that makes Cursor's
 * @file/@codebase references work.
 *
 * Architecture:
 *   startup → walkWorkspace → parseBlocks → embed → in-memory index
 *   on file save → re-index changed file (via GnosisFileWatcher)
 *   on search → cosine similarity over embeddings → top-K blocks
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { embed } from './inference-bridge.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CodeBlock {
  id: string;
  filePath: string;
  relativePath: string;
  startLine: number;
  endLine: number;
  content: string;
  language: string;
  kind: 'function' | 'class' | 'method' | 'block' | 'file-summary';
}

export interface IndexedBlock extends CodeBlock {
  embedding: Float32Array;
  indexedAt: number;
}

export interface SearchResult {
  block: CodeBlock;
  score: number;
}

export interface CodeIndexStats {
  totalFiles: number;
  totalBlocks: number;
  indexedBlocks: number;
  lastFullIndexMs: number;
  lastIncrementalMs: number;
  workspaceRoot: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.rs',
  '.py',
  '.go',
  '.java',
  '.kt',
  '.swift',
  '.c',
  '.cpp',
  '.h',
  '.hpp',
  '.cs',
  '.rb',
  '.php',
  '.lua',
  '.zig',
  '.gg',
  '.gnot',
  '.css',
  '.scss',
  '.html',
  '.svelte',
  '.vue',
  '.json',
  '.toml',
  '.yaml',
  '.yml',
  '.sh',
  '.bash',
  '.zsh',
  '.sql',
  '.graphql',
  '.proto',
]);

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  '__pycache__',
  '.venv',
  'venv',
  'target',
  '.turbo',
  '.edgework',
  '.claude',
  'coverage',
]);

const MAX_FILE_SIZE = 100_000; // 100KB -- skip huge files
const MAX_BLOCK_LINES = 80; // Blocks longer than this get chunked
const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.rs': 'rust',
  '.py': 'python',
  '.go': 'go',
  '.java': 'java',
  '.kt': 'kotlin',
  '.swift': 'swift',
  '.c': 'c',
  '.cpp': 'cpp',
  '.cs': 'csharp',
  '.rb': 'ruby',
  '.php': 'php',
  '.lua': 'lua',
  '.zig': 'zig',
  '.gg': 'gnosis',
  '.gnot': 'gnot',
  '.css': 'css',
  '.html': 'html',
  '.sh': 'shell',
  '.sql': 'sql',
  '.graphql': 'graphql',
  '.proto': 'protobuf',
};

// ---------------------------------------------------------------------------
// Block Parsing
// ---------------------------------------------------------------------------

/** Simple heuristic block parser -- splits on function/class boundaries */
function parseFileIntoBlocks(
  content: string,
  filePath: string,
  relativePath: string
): CodeBlock[] {
  const ext = extname(filePath);
  const language = EXTENSION_TO_LANGUAGE[ext] ?? 'text';
  const lines = content.split('\n');
  const blocks: CodeBlock[] = [];
  let blockId = 0;

  // File-level summary (first 10 lines or first docstring)
  const summaryEnd = Math.min(10, lines.length);
  blocks.push({
    id: `${relativePath}:summary`,
    filePath,
    relativePath,
    startLine: 1,
    endLine: summaryEnd,
    content: lines.slice(0, summaryEnd).join('\n'),
    language,
    kind: 'file-summary',
  });

  // Heuristic: detect function/class boundaries by indentation + keywords
  const boundaryPattern =
    /^(export\s+)?(async\s+)?(function|class|interface|type|enum|const|let|def|fn|func|pub\s+fn|pub\s+struct|impl)\s/;

  let currentStart = 0;
  let currentKind: CodeBlock['kind'] = 'block';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isBoundary =
      boundaryPattern.test(line.trimStart()) && line.search(/\S/) < 4;

    if (isBoundary && i > currentStart) {
      // Emit previous block
      if (i - currentStart > 2) {
        blocks.push({
          id: `${relativePath}:${blockId++}`,
          filePath,
          relativePath,
          startLine: currentStart + 1,
          endLine: i,
          content: lines.slice(currentStart, i).join('\n'),
          language,
          kind: currentKind,
        });
      }
      currentStart = i;
      currentKind = line.includes('class')
        ? 'class'
        : line.includes('function') ||
          line.includes('fn ') ||
          line.includes('def ')
        ? 'function'
        : 'block';
    }

    // Chunk long blocks
    if (i - currentStart >= MAX_BLOCK_LINES) {
      blocks.push({
        id: `${relativePath}:${blockId++}`,
        filePath,
        relativePath,
        startLine: currentStart + 1,
        endLine: i + 1,
        content: lines.slice(currentStart, i + 1).join('\n'),
        language,
        kind: currentKind,
      });
      currentStart = i + 1;
      currentKind = 'block';
    }
  }

  // Emit final block
  if (lines.length - currentStart > 2) {
    blocks.push({
      id: `${relativePath}:${blockId++}`,
      filePath,
      relativePath,
      startLine: currentStart + 1,
      endLine: lines.length,
      content: lines.slice(currentStart).join('\n'),
      language,
      kind: currentKind,
    });
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Embedding
// ---------------------------------------------------------------------------

/** Extract embedding vector from the local embedding endpoint */
export async function computeEmbedding(
  text: string
): Promise<Float32Array | null> {
  try {
    const resp = await embed(text, 'local');
    const data = (await resp.json()) as {
      data?: Array<{ embedding?: number[] }>;
    };
    const vec = data?.data?.[0]?.embedding;
    if (!vec || vec.length === 0) return null;
    return new Float32Array(vec);
  } catch {
    return null;
  }
}

/** Cosine similarity between two vectors */
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

class SemanticCodeIndex {
  private blocks = new Map<string, IndexedBlock>();
  private workspaceRoot = '';
  private totalFiles = 0;
  private lastFullIndexMs = 0;
  private lastIncrementalMs = 0;
  private indexing = false;

  /** Full workspace index -- called on startup */
  async indexWorkspace(root: string): Promise<void> {
    if (this.indexing) return;
    this.indexing = true;
    this.workspaceRoot = root;
    const t0 = Date.now();

    try {
      const files = this.walkDirectory(root);
      this.totalFiles = files.length;
      // console.log(`[zedge:code-index] Indexing ${files.length} files...`);

      let indexed = 0;
      for (const filePath of files) {
        try {
          const content = readFileSync(filePath, 'utf-8');
          const relativePath = relative(root, filePath);
          const codeBlocks = parseFileIntoBlocks(
            content,
            filePath,
            relativePath
          );

          for (const block of codeBlocks) {
            // Compute embedding for blocks with meaningful content
            const textForEmbedding = block.content.slice(0, 512);
            const embedding = await computeEmbedding(textForEmbedding);

            if (embedding) {
              this.blocks.set(block.id, {
                ...block,
                embedding,
                indexedAt: Date.now(),
              });
              indexed++;
            }
          }
        } catch {
          // Skip unreadable files
        }
      }

      this.lastFullIndexMs = Date.now() - t0;
      console.log(
        `[zedge:code-index] Indexed ${indexed} blocks from ${files.length} files in ${this.lastFullIndexMs}ms`
      );
    } finally {
      this.indexing = false;
    }
  }

  /** Incremental re-index of a single file */
  async reindexFile(filePath: string): Promise<void> {
    const t0 = Date.now();

    // Remove old blocks for this file
    for (const [id, block] of this.blocks) {
      if (block.filePath === filePath) {
        this.blocks.delete(id);
      }
    }

    try {
      const content = readFileSync(filePath, 'utf-8');
      const relativePath = relative(this.workspaceRoot, filePath);
      const codeBlocks = parseFileIntoBlocks(content, filePath, relativePath);

      for (const block of codeBlocks) {
        const embedding = await computeEmbedding(block.content.slice(0, 512));
        if (embedding) {
          this.blocks.set(block.id, {
            ...block,
            embedding,
            indexedAt: Date.now(),
          });
        }
      }
    } catch {
      // File may have been deleted
    }

    this.lastIncrementalMs = Date.now() - t0;
  }

  /** Semantic search -- returns top-K most relevant blocks */
  async search(query: string, topK = 5): Promise<SearchResult[]> {
    const queryEmbedding = await computeEmbedding(query);
    if (!queryEmbedding) return [];

    const scored: SearchResult[] = [];
    for (const [, block] of this.blocks) {
      const score = cosineSimilarity(queryEmbedding, block.embedding);
      scored.push({ block, score });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  /** Get context for a specific file (related blocks from other files) */
  async getRelatedContext(filePath: string, topK = 5): Promise<SearchResult[]> {
    // Use the file's summary block as the query
    const relativePath = relative(this.workspaceRoot, filePath);
    const summaryBlock = this.blocks.get(`${relativePath}:summary`);
    if (!summaryBlock) return [];

    const scored: SearchResult[] = [];
    for (const [, block] of this.blocks) {
      // Skip blocks from the same file
      if (block.filePath === filePath) continue;
      const score = cosineSimilarity(summaryBlock.embedding, block.embedding);
      scored.push({ block, score });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  getStats(): CodeIndexStats {
    return {
      totalFiles: this.totalFiles,
      totalBlocks: this.blocks.size,
      indexedBlocks: this.blocks.size,
      lastFullIndexMs: this.lastFullIndexMs,
      lastIncrementalMs: this.lastIncrementalMs,
      workspaceRoot: this.workspaceRoot,
    };
  }

  private walkDirectory(dir: string): string[] {
    const files: string[] = [];
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') && entry.name !== '.editorconfig')
          continue;
        if (IGNORED_DIRS.has(entry.name)) continue;

        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          files.push(...this.walkDirectory(fullPath));
        } else if (entry.isFile()) {
          const ext = extname(entry.name);
          if (!SOURCE_EXTENSIONS.has(ext)) continue;
          try {
            const stat = statSync(fullPath);
            if (stat.size > MAX_FILE_SIZE) continue;
          } catch {
            continue;
          }
          files.push(fullPath);
        }
      }
    } catch {
      // Permission errors, etc.
    }
    return files;
  }
}

// Singleton
export const codeIndex = new SemanticCodeIndex();
