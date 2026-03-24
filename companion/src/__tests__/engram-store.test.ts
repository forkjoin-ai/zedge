import { describe, test, expect } from 'bun:test';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('Engram Store', () => {
  const testWorkspace = join(tmpdir(), `engram-test-${Date.now()}`);

  test('remember and recall by keyword', async () => {
    const { EngramStore } = await import('../engram-store');
    const store = new EngramStore(testWorkspace);

    await store.remember({
      type: 'code-pattern',
      content: 'Always use async/await instead of raw promises in this codebase',
    });

    await store.remember({
      type: 'user-preference',
      content: 'Developer prefers functional style over class-based components',
    });

    // Keyword recall (no embedding function set)
    const results = await store.recall('async await promises', 5);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].engram.content).toContain('async/await');
    expect(results[0].score).toBeGreaterThan(0);
  });

  test('getStatus returns valid shape', async () => {
    const { EngramStore } = await import('../engram-store');
    const store = new EngramStore(testWorkspace);

    const status = store.getStatus();
    expect(status).toHaveProperty('workspaceHash');
    expect(status).toHaveProperty('totalEngrams');
    expect(status).toHaveProperty('byType');
    expect(status).toHaveProperty('storePath');
    expect(typeof status.totalEngrams).toBe('number');
    expect(status.byType).toHaveProperty('code-pattern');
    expect(status.byType).toHaveProperty('user-preference');
    expect(status.byType).toHaveProperty('conversation-summary');
    expect(status.byType).toHaveProperty('file-relationship');
  });

  test('forget removes engram by ID', async () => {
    const { EngramStore } = await import('../engram-store');
    const store = new EngramStore(join(tmpdir(), `engram-forget-${Date.now()}`));

    const engram = await store.remember({
      type: 'conversation-summary',
      content: 'Discussed refactoring the inference bridge for better error handling',
    });

    expect(store.size).toBe(1);
    const removed = store.forget(engram.id);
    expect(removed).toBe(true);
    expect(store.size).toBe(0);
  });

  test('forgetBefore removes old engrams', async () => {
    const { EngramStore } = await import('../engram-store');
    const store = new EngramStore(join(tmpdir(), `engram-forget-before-${Date.now()}`));

    await store.remember({
      type: 'code-pattern',
      content: 'Old pattern that should be forgotten',
    });

    // Wait a tick so timestamps differ
    await new Promise((r) => setTimeout(r, 10));
    const cutoff = new Date().toISOString();

    await store.remember({
      type: 'code-pattern',
      content: 'New pattern that should be kept',
    });

    expect(store.size).toBe(2);
    const removed = store.forgetBefore(cutoff);
    expect(removed).toBe(1);
    expect(store.size).toBe(1);
    expect(store.getAll()[0].content).toContain('New pattern');
  });

  test('persistence -- JSONL file created', async () => {
    const { EngramStore } = await import('../engram-store');
    const workspace = join(tmpdir(), `engram-persist-${Date.now()}`);
    const store = new EngramStore(workspace);

    await store.remember({
      type: 'file-relationship',
      content: 'server.ts depends on inference-bridge.ts for all model calls',
      filePath: 'server.ts',
    });

    expect(store.size).toBe(1);
    // The store path should exist
    expect(existsSync(store.getStatus().storePath)).toBe(true);
  });

  test('getEngramStore returns singleton per workspace', async () => {
    const { getEngramStore } = await import('../engram-store');
    const store1 = getEngramStore('/fake/workspace');
    const store2 = getEngramStore('/fake/workspace');
    expect(store1).toBe(store2);

    const store3 = getEngramStore('/different/workspace');
    expect(store3).not.toBe(store1);
  });
});
