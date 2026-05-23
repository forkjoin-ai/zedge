/**
 * Zedge Collaborative Editing Bridge (Phase 3)
 *
 * Google Docs-style collaborative editing using Yjs CRDTs.
 * Enables real-time cursor/selection sharing, presence awareness,
 * and session discovery via P2P mesh.
 */

// ---------------------------------------------------------------------------
// Types (aligned with aeon-flux-capacitor CollaborationPresence)
// ---------------------------------------------------------------------------

export interface CollabSession {
  id: string;
  name: string;
  hostPeerId: string;
  filePath: string;
  participants: Map<string, CollabParticipant>;
  createdAt: number;
  lastActivity: number;
}

export interface CollabParticipant {
  peerId: string;
  displayName: string;
  color: string;
  cursor: CollabCursor | null;
  selection: CollabSelection | null;
  activity: CollabActivity;
  lastActiveAt: number;
  status: 'active' | 'idle' | 'away';
}

export interface CollabCursor {
  line: number;
  column: number;
  filePath: string;
}

export interface CollabSelection {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  filePath: string;
}

export type CollabActivity =
  | { type: 'typing'; filePath: string }
  | { type: 'selecting'; filePath: string }
  | { type: 'reading'; filePath: string }
  | { type: 'idle' };

export interface CollabDiagnostic {
  filePath: string;
  line: number;
  column: number;
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  source: string;
  peerId: string;
}

export interface CollabPresenceUpdate {
  sessionId: string;
  peerId: string;
  cursor?: CollabCursor;
  selection?: CollabSelection;
  activity?: CollabActivity;
}

// Participant colors for collaborative editing
const COLLAB_COLORS = [
  '#3b82f6',
  '#ef4444',
  '#10b981',
  '#f59e0b',
  '#8b5cf6',
  '#ec4899',
  '#06b6d4',
  '#f97316',
  '#6366f1',
  '#14b8a6',
  '#e11d48',
  '#84cc16',
];

// ---------------------------------------------------------------------------
// CollabBridge
// ---------------------------------------------------------------------------

export class CollabBridge {
  private sessions = new Map<string, CollabSession>();
  private diagnostics = new Map<string, CollabDiagnostic[]>();
  private peerId: string;
  private displayName: string;
  private colorIndex = 0;

  constructor(peerId: string, displayName: string) {
    this.peerId = peerId;
    this.displayName = displayName;
  }

  /**
   * Create a new collaborative editing session.
   */
  createSession(filePath: string, name?: string): CollabSession {
    const id = `collab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const session: CollabSession = {
      id,
      name: name ?? `Session on ${filePath.split('/').pop()}`,
      hostPeerId: this.peerId,
      filePath,
      participants: new Map(),
      createdAt: Date.now(),
      lastActivity: Date.now(),
    };

    // Add self as first participant
    session.participants.set(this.peerId, {
      peerId: this.peerId,
      displayName: this.displayName,
      color: this.nextColor(),
      cursor: null,
      selection: null,
      activity: { type: 'idle' },
      lastActiveAt: Date.now(),
      status: 'active',
    });

    this.sessions.set(id, session);
    return session;
  }

  /**
   * Join an existing session.
   */
  joinSession(
    sessionId: string,
    peerId: string,
    displayName: string
  ): CollabParticipant | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const participant: CollabParticipant = {
      peerId,
      displayName,
      color: this.nextColor(),
      cursor: null,
      selection: null,
      activity: { type: 'idle' },
      lastActiveAt: Date.now(),
      status: 'active',
    };

    session.participants.set(peerId, participant);
    session.lastActivity = Date.now();
    return participant;
  }

  /**
   * Leave a session.
   */
  leaveSession(sessionId: string, peerId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.participants.delete(peerId);
      if (session.participants.size === 0) {
        this.sessions.delete(sessionId);
      }
    }
  }

  /**
   * Update cursor/selection/activity for a participant.
   */
  updatePresence(update: CollabPresenceUpdate): void {
    const session = this.sessions.get(update.sessionId);
    if (!session) return;

    const participant = session.participants.get(update.peerId);
    if (!participant) return;

    if (update.cursor !== undefined) participant.cursor = update.cursor;
    if (update.selection !== undefined)
      participant.selection = update.selection;
    if (update.activity !== undefined) participant.activity = update.activity;
    participant.lastActiveAt = Date.now();
    participant.status = 'active';
    session.lastActivity = Date.now();
  }

  /**
   * Share LSP diagnostics with session peers.
   */
  shareDiagnostics(sessionId: string, diagnostics: CollabDiagnostic[]): void {
    this.diagnostics.set(sessionId, diagnostics);
    const session = this.sessions.get(sessionId);
    if (session) session.lastActivity = Date.now();
  }

  /**
   * Get diagnostics for a session.
   */
  getDiagnostics(sessionId: string): CollabDiagnostic[] {
    return this.diagnostics.get(sessionId) ?? [];
  }

  /**
   * Get a session by ID.
   */
  getSession(sessionId: string): CollabSession | null {
    return this.sessions.get(sessionId) ?? null;
  }

  /**
   * List all active sessions.
   */
  listSessions(): CollabSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Get all participants in a session.
   */
  getParticipants(sessionId: string): CollabParticipant[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    return Array.from(session.participants.values());
  }

  /**
   * Mark idle participants (>60s no activity → idle, >300s → away).
   */
  updateIdleStatus(): void {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      for (const participant of session.participants.values()) {
        const elapsed = now - participant.lastActiveAt;
        if (elapsed > 300_000) {
          participant.status = 'away';
        } else if (elapsed > 60_000) {
          participant.status = 'idle';
        }
      }
    }
  }

  private nextColor(): string {
    const color = COLLAB_COLORS[this.colorIndex % COLLAB_COLORS.length]!;
    this.colorIndex++;
    return color;
  }
}
