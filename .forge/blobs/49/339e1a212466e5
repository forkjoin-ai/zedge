import { describe, test, expect } from '@a0n/gnosis/test';
import { CapacitorBridge } from '../capacitor-bridge';
import type { CodeBlock } from '../capacitor-bridge';

describe('CapacitorBridge', () => {
  test('mount creates a capacitor', () => {
    const cap = new CapacitorBridge();
    const mount = cap.mount('/src/app.ts');
    expect(mount.id).toMatch(/^cap-/);
    expect(mount.projection).toBe('text');
  });

  test('indexBlock stores block with dual index', () => {
    const cap = new CapacitorBridge();
    const mount = cap.mount('/src');

    const block: CodeBlock = {
      id: 'block-1',
      filePath: '/src/app.ts',
      startLine: 1,
      endLine: 10,
      content: 'function handleError() { // TODO: fix this bug }',
      language: 'typescript',
      blockType: 'function',
    };

    cap.indexBlock(mount.id, block);
    expect(mount.blocks.size).toBe(1);
    expect(mount.amygdala.size).toBe(1);
    expect(mount.hippocampus.size).toBe(1);
  });

  test('amygdala tags frustration for TODO/FIXME code', () => {
    const cap = new CapacitorBridge();
    const mount = cap.mount('/src');

    cap.indexBlock(mount.id, {
      id: 'todo-block',
      filePath: '/src/app.ts',
      startLine: 1,
      endLine: 1,
      content: '// TODO: this is a hack, needs refactoring',
      language: 'typescript',
      blockType: 'comment',
    });

    const tag = mount.amygdala.get('todo-block')!;
    expect(tag.emotion).toBe('frustration');
    expect(tag.valence).toBeLessThan(0);
    expect(tag.intensity).toBeGreaterThan(0.5);
  });

  test('amygdala tags excitement for new features', () => {
    const cap = new CapacitorBridge();
    const mount = cap.mount('/src');

    cap.indexBlock(mount.id, {
      id: 'feat-block',
      filePath: '/src/feature.ts',
      startLine: 1,
      endLine: 5,
      content: 'export function newFeature() { implement(); }',
      language: 'typescript',
      blockType: 'function',
    });

    const tag = mount.amygdala.get('feat-block')!;
    expect(tag.emotion).toBe('excitement');
    expect(tag.valence).toBeGreaterThan(0);
  });

  test('getLayout returns blocks sorted by value', () => {
    const cap = new CapacitorBridge();
    const mount = cap.mount('/src');

    cap.indexBlock(mount.id, {
      id: 'important',
      filePath: '/src/a.ts',
      startLine: 1,
      endLine: 10,
      content: 'critical bug error crash handling',
      language: 'typescript',
      blockType: 'function',
    });
    cap.indexBlock(mount.id, {
      id: 'boring',
      filePath: '/src/b.ts',
      startLine: 1,
      endLine: 2,
      content: 'import x from "y"',
      language: 'typescript',
      blockType: 'import',
    });

    const layout = cap.getLayout(mount.id);
    expect(layout.blocks.length).toBe(2);
    expect(layout.blocks[0]!.blockId).toBe('important');
  });

  test('getClusters groups by file path', () => {
    const cap = new CapacitorBridge();
    const mount = cap.mount('/src');

    cap.indexBlock(mount.id, {
      id: 'a1',
      filePath: '/src/a.ts',
      startLine: 1,
      endLine: 5,
      content: 'function a() {}',
      language: 'ts',
      blockType: 'function',
    });
    cap.indexBlock(mount.id, {
      id: 'a2',
      filePath: '/src/a.ts',
      startLine: 6,
      endLine: 10,
      content: 'function b() {}',
      language: 'ts',
      blockType: 'function',
    });
    cap.indexBlock(mount.id, {
      id: 'b1',
      filePath: '/src/b.ts',
      startLine: 1,
      endLine: 5,
      content: 'class C {}',
      language: 'ts',
      blockType: 'class',
    });

    const clusters = cap.getClusters(mount.id);
    expect(clusters.length).toBe(2);
  });

  test('setProjection changes projection', () => {
    const cap = new CapacitorBridge();
    const mount = cap.mount('/src');
    expect(mount.projection).toBe('text');

    cap.setProjection(mount.id, 'spatial');
    expect(mount.projection).toBe('spatial');
  });

  test('recordReading tracks engagement', () => {
    const cap = new CapacitorBridge();
    cap.recordReading('block-1', 5000);
    cap.recordReading('block-1', 10000);

    const metrics = cap.getReadingMetrics();
    expect(metrics.length).toBe(1);
    expect(metrics[0]!.timeSpentMs).toBe(15000);
    expect(metrics[0]!.scrollPasses).toBe(2);
    expect(metrics[0]!.engagement).toBeGreaterThan(0);
  });

  test('personalize sets reader context', () => {
    const cap = new CapacitorBridge();
    cap.personalize({
      developerId: 'dev-1',
      preferences: { theme: 'dark' },
      recentFiles: ['/src/app.ts'],
      focusArea: 'performance',
    });
    // No error thrown = success (personalization affects layout internally)
  });

  test('unmount removes the capacitor', () => {
    const cap = new CapacitorBridge();
    const mount = cap.mount('/src');
    cap.unmount(mount.id);
    expect(cap.getMounts().length).toBe(0);
  });
});
