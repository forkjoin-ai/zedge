/**
 * Void Map Store -- Persistent Rejection Memory
 *
 * Every rejection (daydream, CERA, feedback) is recorded here as a JSONL
 * entry. The store computes steering vectors -- anti-patterns that the
 * developer consistently rejects -- which are injected into superinference
 * system prompts. The editor measurably improves from every "no."
 *
 * Storage: ~/.edgework/void-map.jsonl
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VoidMapEntry {
  timestamp: string;
  filePath: string;
  line?: number;
  category: string;
  rejectedContent: string;
  context?: string;
  source: 'daydream' | 'cera' | 'feedback';
  emotion?: string;
}

export interface VoidMapStatus {
  totalEntries: number;
  topCategories: Array<{ category: string; count: number }>;
  topFiles: Array<{ filePath: string; count: number }>;
  oldestEntry: string | null;
  newestEntry: string | null;
}

export interface SteeringVector {
  /** Anti-patterns to prepend to system prompt */
  negativePrompt: string;
  /** Number of entries that contributed to this vector */
  entryCount: number;
  /** Categories the user consistently rejects */
  rejectedCategories: Array<{ category: string; count: number }>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EDGEWORK_DIR = join(homedir(), '.edgework');
const VOID_MAP_FILE = join(EDGEWORK_DIR, 'void-map.jsonl');
const MAX_ENTRIES = 5000;
const STEERING_MIN_REJECTIONS = 3; // Need at least 3 rejections to steer

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

class VoidMapStore {
  private entries: VoidMapEntry[] = [];
  private loaded = false;
  private onRecordCallback: ((entry: VoidMapEntry) => void) | null = null;

  constructor() {
    this.load();
  }

  /** Register a callback that fires after every record (for training pipeline) */
  onRecord(callback: (entry: VoidMapEntry) => void): void {
    this.onRecordCallback = callback;
  }

  /** Record a new rejection */
  record(entry: Omit<VoidMapEntry, 'timestamp'>): void {
    const full: VoidMapEntry = {
      ...entry,
      timestamp: new Date().toISOString(),
    };

    this.entries.push(full);

    // Fire callback for training pipeline
    try {
      this.onRecordCallback?.(full);
    } catch {
      // Callback errors must not break record persistence
    }

    // Trim to max
    if (this.entries.length > MAX_ENTRIES) {
      this.entries = this.entries.slice(-MAX_ENTRIES);
      // Rewrite the whole file on compaction
      this.rewrite();
    } else {
      // Append single entry
      this.ensureDir();
      try {
        appendFileSync(VOID_MAP_FILE, JSON.stringify(full) + '\n');
      } catch {
        // Best effort
      }
    }
  }

  /** Query entries by file path and/or category */
  query(opts?: {
    filePath?: string;
    category?: string;
    limit?: number;
  }): VoidMapEntry[] {
    let results = this.entries;

    if (opts?.filePath) {
      results = results.filter((e) => e.filePath === opts.filePath);
    }
    if (opts?.category) {
      results = results.filter((e) => e.category === opts.category);
    }

    const limit = opts?.limit ?? 100;
    return results.slice(-limit);
  }

  /** Get aggregate status */
  getStatus(): VoidMapStatus {
    const categoryCounts = new Map<string, number>();
    const fileCounts = new Map<string, number>();

    for (const entry of this.entries) {
      categoryCounts.set(
        entry.category,
        (categoryCounts.get(entry.category) ?? 0) + 1
      );
      fileCounts.set(entry.filePath, (fileCounts.get(entry.filePath) ?? 0) + 1);
    }

    const topCategories = [...categoryCounts.entries()]
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    const topFiles = [...fileCounts.entries()]
      .map(([filePath, count]) => ({ filePath, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return {
      totalEntries: this.entries.length,
      topCategories,
      topFiles,
      oldestEntry: this.entries[0]?.timestamp ?? null,
      newestEntry: this.entries[this.entries.length - 1]?.timestamp ?? null,
    };
  }

  /**
   * Compute a steering vector for a given file path.
   * Returns anti-patterns that the user consistently rejects in this file
   * or globally, formatted as a negative prompt for superinference.
   */
  getSteeringVector(filePath?: string): SteeringVector {
    // Gather rejections for this file + global patterns
    const fileEntries = filePath
      ? this.entries.filter((e) => e.filePath === filePath)
      : [];
    const allEntries = this.entries;

    // Count categories across file-specific and global
    const fileCategoryCounts = new Map<string, number>();
    for (const e of fileEntries) {
      fileCategoryCounts.set(
        e.category,
        (fileCategoryCounts.get(e.category) ?? 0) + 1
      );
    }

    const globalCategoryCounts = new Map<string, number>();
    for (const e of allEntries) {
      globalCategoryCounts.set(
        e.category,
        (globalCategoryCounts.get(e.category) ?? 0) + 1
      );
    }

    // Build rejected categories (file-specific first, then global)
    const rejectedCategories: Array<{ category: string; count: number }> = [];

    // File-specific patterns (lower threshold -- 2 rejections)
    for (const [category, count] of fileCategoryCounts) {
      if (count >= 2) {
        rejectedCategories.push({ category, count });
      }
    }

    // Global patterns (higher threshold)
    for (const [category, count] of globalCategoryCounts) {
      if (
        count >= STEERING_MIN_REJECTIONS &&
        !rejectedCategories.find((r) => r.category === category)
      ) {
        rejectedCategories.push({ category, count });
      }
    }

    rejectedCategories.sort((a, b) => b.count - a.count);

    // Build negative prompt
    const entryCount = fileEntries.length + allEntries.length;
    if (rejectedCategories.length === 0) {
      return { negativePrompt: '', entryCount, rejectedCategories };
    }

    const lines: string[] = [];
    lines.push(
      'The developer has a history of rejecting the following types of suggestions:'
    );

    for (const { category, count } of rejectedCategories.slice(0, 5)) {
      // Get recent examples for this category
      const examples = (filePath ? fileEntries : allEntries)
        .filter((e) => e.category === category)
        .slice(-2)
        .map((e) => e.rejectedContent.slice(0, 80));

      lines.push(
        `- "${category}" suggestions (rejected ${count} times). Examples: ${examples.join(
          '; '
        )}`
      );
    }

    lines.push(
      'Avoid generating suggestions in these categories unless absolutely critical.'
    );

    return {
      negativePrompt: lines.join('\n'),
      entryCount,
      rejectedCategories,
    };
  }

  /** Compact the store -- merge duplicate file+category entries */
  compact(): number {
    const before = this.entries.length;
    // Keep only the most recent entry per file+category+content combo
    const seen = new Map<string, VoidMapEntry>();
    for (const entry of this.entries) {
      const key = `${entry.filePath}:${
        entry.category
      }:${entry.rejectedContent.slice(0, 50)}`;
      seen.set(key, entry); // Overwrites older with newer
    }
    this.entries = [...seen.values()].sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
    this.rewrite();
    return before - this.entries.length;
  }

  /** Get total entry count */
  get size(): number {
    return this.entries.length;
  }

  // --- Private ---

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;

    if (!existsSync(VOID_MAP_FILE)) return;

    try {
      const lines = readFileSync(VOID_MAP_FILE, 'utf-8')
        .split('\n')
        .filter((l) => l.trim().length > 0);

      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as VoidMapEntry;
          if (entry.timestamp && entry.filePath && entry.category) {
            this.entries.push(entry);
          }
        } catch {
          // Skip malformed lines
        }
      }

      // Trim on load
      if (this.entries.length > MAX_ENTRIES) {
        this.entries = this.entries.slice(-MAX_ENTRIES);
      }
    } catch {
      // File may not exist yet
    }
  }

  private ensureDir(): void {
    try {
      mkdirSync(EDGEWORK_DIR, { recursive: true });
    } catch {
      // Best effort
    }
  }

  private rewrite(): void {
    this.ensureDir();
    try {
      const content =
        this.entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
      writeFileSync(VOID_MAP_FILE, content);
    } catch {
      // Best effort
    }
  }
}

// Singleton
export const voidMapStore = new VoidMapStore();
