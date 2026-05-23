import { describe, test, expect } from '@a0n/gnosis/test';

describe('Cloud Agent Sessions', () => {
  test('startCloudAgent creates session with valid shape', async () => {
    const { startCloudAgent } = await import('../cloud-agent-session');

    const session = await startCloudAgent({
      agentName: 'test-agent',
      task: 'Review the codebase for security issues',
      targetFiles: [],
    });

    expect(session.id).toContain('cloud-agent-');
    expect(session.agentName).toBe('test-agent');
    expect(session.task).toBe('Review the codebase for security issues');
    expect(['starting', 'running', 'completed', 'failed']).toContain(
      session.status
    );
    expect(session.startedAt).toBeGreaterThan(0);
  });

  test('listSessions returns array', async () => {
    const { listSessions } = await import('../cloud-agent-session');
    const sessions = listSessions();
    expect(Array.isArray(sessions)).toBe(true);
  });

  test('getSession returns null for unknown ID', async () => {
    const { getSession } = await import('../cloud-agent-session');
    expect(getSession('nonexistent')).toBeNull();
  });

  test('cancelSession returns false for unknown ID', async () => {
    const { cancelSession } = await import('../cloud-agent-session');
    expect(cancelSession('nonexistent')).toBe(false);
  });

  test('createSessionStream returns ReadableStream', async () => {
    const { createSessionStream } = await import('../cloud-agent-session');
    const stream = createSessionStream('test-session');
    expect(stream).toBeInstanceOf(ReadableStream);
  });
});
