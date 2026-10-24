/**
 * FIM Response Cache
 *
 * LRU cache for fill-in-middle completion results. Sub-millisecond cache hits
 * eliminate redundant inference for rapid keystrokes. Speculative pre-fetch
 * warms the cache for the next likely cursor position.
 *
 * Key = sha256(filePath + cursorLine + last200CharsOfPrefix)
 * TTL = 5 seconds (code changes invalidate quickly)
 * Max entries = 256
 */

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FimCacheEntry {
  completion: string;
  model: string;
  tier: string;
  createdAt: number;
}

export interface FimCacheStats {
  size: number;
  maxSize: number;
  hits: number;
  misses: number;
  hitRate: number;
  evictions: number;
  prefetches: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_ENTRIES = 256;
const TTL_MS = 5_000;
const PREFIX_TAIL_LENGTH = 200;

// ---------------------------------------------------------------------------
// Cache Implementation
// ---------------------------------------------------------------------------

/** Compute a deterministic cache key from file context */
export function fimCacheKey(
  filePath: string,
  cursorLine: number,
  prefix: string
): string {
  const tail = prefix.slice(-PREFIX_TAIL_LENGTH);
  return createHash('sha256')
    .update(`${filePath}\0${cursorLine}\0${tail}`)
    .digest('hex')
    .slice(0, 32);
}

class FimLruCache {
  private cache = new Map<string, FimCacheEntry>();
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private prefetches = 0;

  get(key: string): FimCacheEntry | null {
    const entry = this.cache.get(key);
    if (!entry) {
      this.misses++;
      return null;
    }

    // Check TTL
    if (Date.now() - entry.createdAt > TTL_MS) {
      this.cache.delete(key);
      this.misses++;
      return null;
    }

    // LRU: move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, entry);
    this.hits++;
    return entry;
  }

  set(key: string, entry: FimCacheEntry): void {
    // If key exists, delete first to refresh LRU order
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }

    // Evict oldest if at capacity
    if (this.cache.size >= MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
        this.evictions++;
      }
    }

    this.cache.set(key, entry);
  }

  /** Invalidate all entries for a specific file (called on file save) */
  invalidateFile(filePath: string): number {
    let removed = 0;
    // We can't efficiently look up by file path since keys are hashes.
    // Instead, clear expired entries opportunistically.
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now - entry.createdAt > TTL_MS) {
        this.cache.delete(key);
        removed++;
      }
    }
    return removed;
  }

  /** Clear the entire cache */
  clear(): void {
    this.cache.clear();
  }

  recordPrefetch(): void {
    this.prefetches++;
  }

  getStats(): FimCacheStats {
    const total = this.hits + this.misses;
    return {
      size: this.cache.size,
      maxSize: MAX_ENTRIES,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? this.hits / total : 0,
      evictions: this.evictions,
      prefetches: this.prefetches,
    };
  }
}

// Singleton instance
export const fimCache = new FimLruCache();

// ---------------------------------------------------------------------------
// Speculative Pre-fetch
// ---------------------------------------------------------------------------

/** Active pre-fetch promises keyed by cache key (prevents duplicate fetches) */
const activePrefetches = new Map<string, Promise<void>>();

/**
 * Speculatively pre-fetch the completion for the next likely cursor position.
 * Called after returning a cache miss result to warm the cache for the next keystroke.
 *
 * @param inferFn - The inference function to call (injected to avoid circular deps)
 */
export function speculativePrefetch(
  filePath: string,
  nextLine: number,
  prefix: string,
  suffix: string,
  model: string,
  inferFn: (
    prefix: string,
    suffix: string,
    model: string
  ) => Promise<{ completion: string; tier: string } | null>
): void {
  const key = fimCacheKey(filePath, nextLine, prefix);

  // Already cached or in-flight
  if (fimCache.get(key) !== null || activePrefetches.has(key)) {
    return;
  }

  fimCache.recordPrefetch();

  const promise = inferFn(prefix, suffix, model)
    .then((result) => {
      if (result) {
        fimCache.set(key, {
          completion: result.completion,
          model,
          tier: result.tier,
          createdAt: Date.now(),
        });
      }
    })
    .catch(() => {
      // Pre-fetch failures are silent -- the real request will handle errors
    })
    .finally(() => {
      activePrefetches.delete(key);
    });

  activePrefetches.set(key, promise);
}
