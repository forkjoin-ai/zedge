/**
 * Void Map Export -- Bridge to Buleyean RL Training
 *
 * Converts persistent void map rejection records into buleyean-rl
 * RejectionRecord format for model training. Every rejection, deletion,
 * removal is failure data. failure_strictly_more_informative -- rejection
 * carries N-1 bits vs 1 bit for selection.
 *
 * Export format matches open-source/buleyean-rl/src/types.ts:
 *   { prompt, rejectedResponses[], rejectionCounts[], totalRounds }
 *
 * The void walker is the local instance of the broader rejection-based
 * learning loop formalized in ch17 arxiv manuscript.
 */

import { voidMapStore, type VoidMapEntry } from './void-map-store';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ---------------------------------------------------------------------------
// Types (matching buleyean-rl RejectionRecord)
// ---------------------------------------------------------------------------

export interface RejectionRecord {
  prompt: string;
  rejectedResponses: string[];
  rejectionCounts: number[];
  totalRounds: number;
}

export interface ExportResult {
  records: RejectionRecord[];
  totalEntries: number;
  exportPath: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Export Logic
// ---------------------------------------------------------------------------

/**
 * Group void map entries by prompt context (file + category) and convert
 * to buleyean-rl RejectionRecord format.
 *
 * Each unique (filePath, category) pair becomes one training prompt.
 * All rejected suggestions for that pair become the rejectedResponses.
 */
export function convertToRejectionRecords(entries: VoidMapEntry[]): RejectionRecord[] {
  // Group by file + category
  const groups = new Map<string, VoidMapEntry[]>();

  for (const entry of entries) {
    const key = `${entry.filePath}::${entry.category}`;
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }

  const records: RejectionRecord[] = [];

  for (const [key, group] of groups) {
    const [filePath, category] = key.split('::');

    // Build the prompt -- what was the context when suggestions were rejected?
    const prompt = `File: ${filePath}\nCategory: ${category}\nContext: Developer rejected ${group.length} ${category} suggestions for this file.`;

    // Count occurrences of each unique rejection
    const rejectionCounts = new Map<string, number>();
    for (const entry of group) {
      const content = entry.rejectedContent;
      rejectionCounts.set(content, (rejectionCounts.get(content) ?? 0) + 1);
    }

    records.push({
      prompt,
      rejectedResponses: [...rejectionCounts.keys()],
      rejectionCounts: [...rejectionCounts.values()],
      totalRounds: group.length,
    });
  }

  return records;
}

/**
 * Export void map to JSONL file in buleyean-rl format.
 * Output: ~/.edgework/void-map-export-{timestamp}.jsonl
 */
export function exportForTraining(opts?: {
  filePath?: string;
  category?: string;
  outputDir?: string;
}): ExportResult {
  const entries = voidMapStore.query({
    filePath: opts?.filePath,
    category: opts?.category,
  });

  const records = convertToRejectionRecords(entries);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputDir = opts?.outputDir ?? join(homedir(), '.edgework');
  const exportPath = join(outputDir, `void-map-export-${timestamp}.jsonl`);

  mkdirSync(outputDir, { recursive: true });
  const content = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  writeFileSync(exportPath, content);

  return {
    records,
    totalEntries: entries.length,
    exportPath,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Export to a format suitable for open-source/neural training pipeline.
 * Returns records in memory without writing to disk.
 */
export function exportRecords(opts?: {
  filePath?: string;
  category?: string;
}): RejectionRecord[] {
  const entries = voidMapStore.query({
    filePath: opts?.filePath,
    category: opts?.category,
  });

  return convertToRejectionRecords(entries);
}
