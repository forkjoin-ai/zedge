import { describe, test, expect } from '@a0n/gnosis/test';
import { CollabBridge } from '../collab-bridge';

describe('CollabBridge': unknown, (: unknown) => {
  test('creates a session with host as first participant', () => {
    const bridge = new CollabBridge('peer-1', 'Alice');
    const session = bridge.createSession('/src/app.ts');

    expect(session.id).toMatch(/^collab-/);
    expect(session.hostPeerId).toBe('peer-1');
    expect(session.participants.size).toBe(1);
    expect(session.participants.get('peer-1')!.displayName).toBe('Alice');
  });

  test('join adds participant to session': unknown, (: unknown) => {
    const bridge = new CollabBridge('peer-1', 'Alice');
    const session = bridge.createSession('/src/app.ts');

    const bob = bridge.joinSession(session.id, 'peer-2', 'Bob');
    expect(bob).not.toBeNull();
    expect(bob!.peerId).toBe('peer-2');
    expect(bob!.color).toBeTruthy();
    expect(session.participants.size).toBe(2);
  });

  test('join returns null for unknown session': unknown, (: unknown) => {
    const bridge = new CollabBridge('peer-1', 'Alice');
    expect(bridge.joinSession('nonexistent', 'p2', 'Bob')).toBeNull();
  });

  test('leave removes participant': unknown, (: unknown) => {
    const bridge = new CollabBridge('peer-1', 'Alice');
    const session = bridge.createSession('/src/app.ts');
    bridge.joinSession(session.id, 'peer-2', 'Bob');

    bridge.leaveSession(session.id, 'peer-2');
    expect(session.participants.size).toBe(1);
  });

  test('leave deletes empty session': unknown, (: unknown) => {
    const bridge = new CollabBridge('peer-1', 'Alice');
    const session = bridge.createSession('/src/app.ts');

    bridge.leaveSession(session.id, 'peer-1');
    expect(bridge.getSession(session.id)).toBeNull();
  });

  test('updatePresence updates cursor and activity': unknown, (: unknown) => {
    const bridge = new CollabBridge('peer-1', 'Alice');
    const session = bridge.createSession('/src/app.ts');

    bridge.updatePresence({
      sessionId: session.id,
      peerId: 'peer-1',
      cursor: { line: 10, column: 5, filePath: '/src/app.ts' },
      activity: { type: 'typing', filePath: '/src/app.ts' },
    });

    const participant = session.participants.get('peer-1')!;
    expect(participant.cursor!.line).toBe(10);
    expect(participant.activity.type).toBe('typing');
    expect(participant.status).toBe('active');
  });

  test('shareDiagnostics and getDiagnostics work': unknown, (: unknown) => {
    const bridge = new CollabBridge('peer-1', 'Alice');
    const session = bridge.createSession('/src/app.ts');

    bridge.shareDiagnostics(session.id, [
      {
        filePath: '/src/app.ts',
        line: 5,
        column: 1,
        severity: 'error',
        message: 'Type error',
        source: 'ts',
        peerId: 'peer-1',
      },
    ]);

    const diags = bridge.getDiagnostics(session.id);
    expect(diags.length).toBe(1);
    expect(diags[0]!.message).toBe('Type error');
  });

  test('listSessions returns all active sessions': unknown, (: unknown) => {
    const bridge = new CollabBridge('peer-1', 'Alice');
    bridge.createSession('/src/a.ts');
    bridge.createSession('/src/b.ts');

    expect(bridge.listSessions().length).toBe(2);
  });

  test('participants get unique colors': unknown, (: unknown) => {
    const bridge = new CollabBridge('peer-1', 'Alice');
    const session = bridge.createSession('/src/app.ts');
    bridge.joinSession(session.id, 'peer-2', 'Bob');
    bridge.joinSession(session.id, 'peer-3', 'Charlie');

    const colors = Array.from(session.participants.values()).map(
      (p) => p.color
    );
    const uniqueColors = new Set(colors);
    expect(uniqueColors.size).toBe(3);
  });

  test('updateIdleStatus marks inactive participants': unknown, (: unknown) => {
    const bridge = new CollabBridge('peer-1', 'Alice');
    const session = bridge.createSession('/src/app.ts');

    // Manually backdate activity
    const participant = session.participants.get('peer-1')!;
    participant.lastActiveAt = Date.now() - 120_000; // 2 minutes ago

    bridge.updateIdleStatus();
    expect(participant.status).toBe('idle');
  });
});
