import { describe, test, expect } from '@a0n/gnosis/test';
import { convertToRejectionRecords } from '../void-map-export';
import type { VoidMapEntry } from '../void-map-store';

describe('Void Map Export (Buleyean RL)', () => {
  test('convertToRejectionRecords groups by file+category', () => {
    const entries: VoidMapEntry[] = [
      {
        timestamp: '2026-03-23T01:00:00Z',
        filePath: '/a.ts',
        category: 'readability',
        rejectedContent: 'Extract helper',
        source: 'daydream',
      },
      {
        timestamp: '2026-03-23T01:01:00Z',
        filePath: '/a.ts',
        category: 'readability',
        rejectedContent: 'Rename variable',
        source: 'daydream',
      },
      {
        timestamp: '2026-03-23T01:02:00Z',
        filePath: '/a.ts',
        category: 'performance',
        rejectedContent: 'Use Map',
        source: 'daydream',
      },
      {
        timestamp: '2026-03-23T01:03:00Z',
        filePath: '/b.ts',
        category: 'readability',
        rejectedContent: 'Add comment',
        source: 'cera',
      },
    ];

    const records = convertToRejectionRecords(entries);

    // Should produce 3 groups: /a.ts:readability, /a.ts:performance, /b.ts:readability
    expect(records.length).toBe(3);

    const aReadability = records.find(
      (r) => r.prompt.includes('/a.ts') && r.prompt.includes('readability')
    );
    expect(aReadability).toBeTruthy();
    expect(aReadability!.rejectedResponses.length).toBe(2);
    expect(aReadability!.totalRounds).toBe(2);
    expect(aReadability!.rejectedResponses).toContain('Extract helper');
    expect(aReadability!.rejectedResponses).toContain('Rename variable');
  });

  test('convertToRejectionRecords counts duplicate rejections', () => {
    const entries: VoidMapEntry[] = [
      {
        timestamp: '2026-03-23T01:00:00Z',
        filePath: '/x.ts',
        category: 'refactor',
        rejectedContent: 'Same suggestion',
        source: 'daydream',
      },
      {
        timestamp: '2026-03-23T01:01:00Z',
        filePath: '/x.ts',
        category: 'refactor',
        rejectedContent: 'Same suggestion',
        source: 'daydream',
      },
      {
        timestamp: '2026-03-23T01:02:00Z',
        filePath: '/x.ts',
        category: 'refactor',
        rejectedContent: 'Same suggestion',
        source: 'daydream',
      },
    ];

    const records = convertToRejectionRecords(entries);
    expect(records.length).toBe(1);
    expect(records[0].rejectedResponses).toEqual(['Same suggestion']);
    expect(records[0].rejectionCounts).toEqual([3]);
    expect(records[0].totalRounds).toBe(3);
  });

  test('convertToRejectionRecords handles empty input', () => {
    const records = convertToRejectionRecords([]);
    expect(records).toEqual([]);
  });

  test('records match buleyean-rl RejectionRecord shape', () => {
    const entries: VoidMapEntry[] = [
      {
        timestamp: '2026-03-23T01:00:00Z',
        filePath: '/test.ts',
        category: 'security',
        rejectedContent: 'Sanitize input',
        source: 'cera',
      },
    ];

    const records = convertToRejectionRecords(entries);
    expect(records.length).toBe(1);

    const record = records[0];
    expect(record).toHaveProperty('prompt');
    expect(record).toHaveProperty('rejectedResponses');
    expect(record).toHaveProperty('rejectionCounts');
    expect(record).toHaveProperty('totalRounds');
    expect(typeof record.prompt).toBe('string');
    expect(Array.isArray(record.rejectedResponses)).toBe(true);
    expect(Array.isArray(record.rejectionCounts)).toBe(true);
    expect(typeof record.totalRounds).toBe('number');
  });
});
