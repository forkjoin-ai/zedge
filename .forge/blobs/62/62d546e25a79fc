import { describe, test, expect, afterEach } from '@a0n/gnosis/test';
import { createSession, getSession, deleteSession } from '../acp-agent';
import type { AgentCapabilities, AgentSession } from '../acp-agent';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('ACP Agent', () => {
  let testDir: string;

  function setupTestWorkspace(): string {
    testDir = mkdtempSync(join(tmpdir(), 'zedge-test-'));
    writeFileSync(join(testDir, 'main.ts'), 'console.log("hello");');
    writeFileSync(
      join(testDir, 'utils.ts'),
      'export const add = (a: number, b: number) => a + b;'
    );
    mkdirSync(join(testDir, 'src'));
    writeFileSync(
      join(testDir, 'src', 'index.ts'),
      'import { add } from "../utils";'
    );
    return testDir;
  }

  afterEach(() => {
    if (testDir) {
      try {
        rmSync(testDir, { recursive: true });
      } catch {
        // Cleanup best-effort
      }
    }
  });

  test('createSession returns valid session', () => {
    const workspace = setupTestWorkspace();
    const capabilities: AgentCapabilities = {
      processExec: ['bun test *'],
      fileRead: true,
      fileWrite: false,
      gitAccess: false,
    };

    const session = createSession(workspace, capabilities);

    expect(session).toHaveProperty('id');
    expect(session).toHaveProperty('workspacePath');
    expect(session).toHaveProperty('capabilities');
    expect(session).toHaveProperty('conversationHistory');
    expect(session).toHaveProperty('contextCache');
    expect(session).toHaveProperty('createdAt');

    expect(session.id).toMatch(/^session-/);
    expect(session.workspacePath).toBe(workspace);
    expect(session.capabilities.fileRead).toBe(true);
    expect(session.capabilities.fileWrite).toBe(false);
    expect(session.capabilities.gitAccess).toBe(false);
    expect(session.capabilities.processExec).toEqual(['bun test *']);
    expect(session.conversationHistory).toEqual([]);
    expect(session.createdAt).toBeGreaterThan(0);
  });

  test('getSession retrieves existing session', () => {
    const workspace = setupTestWorkspace();
    const session = createSession(workspace, {
      processExec: [],
      fileRead: true,
      fileWrite: true,
      gitAccess: true,
    });

    const retrieved = getSession(session.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(session.id);
    expect(retrieved!.workspacePath).toBe(workspace);
  });

  test('getSession returns null for nonexistent session', () => {
    const retrieved = getSession('nonexistent-id');
    expect(retrieved).toBeNull();
  });

  test('deleteSession removes session', () => {
    const workspace = setupTestWorkspace();
    const session = createSession(workspace, {
      processExec: [],
      fileRead: true,
      fileWrite: false,
      gitAccess: false,
    });

    expect(getSession(session.id)).not.toBeNull();
    deleteSession(session.id);
    expect(getSession(session.id)).toBeNull();
  });

  test('deleteSession is idempotent', () => {
    deleteSession('already-deleted');
    deleteSession('already-deleted');
    // No error thrown
  });

  test('multiple sessions are independent', () => {
    const workspace1 = setupTestWorkspace();
    const workspace2 = mkdtempSync(join(tmpdir(), 'zedge-test2-'));

    const s1 = createSession(workspace1, {
      processExec: [],
      fileRead: true,
      fileWrite: false,
      gitAccess: false,
    });
    const s2 = createSession(workspace2, {
      processExec: ['git *'],
      fileRead: true,
      fileWrite: true,
      gitAccess: true,
    });

    expect(s1.id).not.toBe(s2.id);
    expect(s1.workspacePath).not.toBe(s2.workspacePath);
    expect(s1.capabilities.fileWrite).toBe(false);
    expect(s2.capabilities.fileWrite).toBe(true);

    deleteSession(s1.id);
    expect(getSession(s1.id)).toBeNull();
    expect(getSession(s2.id)).not.toBeNull();

    // Cleanup
    try {
      rmSync(workspace2, { recursive: true });
    } catch {
      // Best effort
    }
  });

  test('session contextCache initializes empty', () => {
    const workspace = setupTestWorkspace();
    const session = createSession(workspace, {
      processExec: [],
      fileRead: true,
      fileWrite: false,
      gitAccess: false,
    });

    expect(session.contextCache.fileTree).toBeNull();
    expect(session.contextCache.fileTreeTimestamp).toBe(0);
    expect(session.contextCache.openFiles.size).toBe(0);
    expect(session.contextCache.gitDiff).toBeNull();
    expect(session.contextCache.gitDiffTimestamp).toBe(0);
  });
});
