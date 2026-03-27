/**
 * Ghostwriter CrdtBridge (Zedge 3.0 — Phase 1)
 *
 * Replaces in-memory Maps in collab-bridge, vfs-bridge, and capacitor-bridge
 * with QDoc types synced through DashRelay. Every edit, cursor, reading metric,
 * and emotion tag flows through Yjs CRDTs — zero merge conflicts, offline support,
 * automatic convergence.
 *
 * Room naming convention (aeon.kernel namespace):
 *   aeon.kernel.zedge.{workspaceId}.file.{path}  — per-file QDoc
 *   aeon.kernel.zedge.{workspaceId}.presence      — workspace-wide cursors
 *   aeon.kernel.zedge.{workspaceId}.capacitor     — shared reading metrics + amygdala tags
 *   aeon.kernel.zedge.{workspaceId}.forge         — deploy state
 *   aeon.kernel.zedge.{workspaceId}.pool          — compute pool reputation ledger
 */

import { DashRelay } from '@dashrelay/client';
import {
  Doc,
  Map as YMap,
  Array as YArray,
  Text,
  encodeStateAsUpdate,
  encodeStateVector,
} from 'yjs';

// Aliases for QDoc migration compatibility
const QDoc = Doc;
type QDoc = Doc;
type QMap<V = unknown> = YMap<V>;
type QArray<V = unknown> = YArray<V>;
type QText = Text;

/**
 * Simple UndoManager shim that wraps scope and provides undo/redo.
 * Used instead of Y.UndoManager to avoid module resolution issues.
 */
class SimpleUndoManager {
  private scope: Text;
  private trackedOrigins: Set<string | number>;
  private undoStack: { content: string }[] = [];
  private redoStack: { content: string }[] = [];

  constructor(
    scope: Text,
    options?: { trackedOrigins?: Set<string | number> }
  ) {
    this.scope = scope;
    this.trackedOrigins = options?.trackedOrigins ?? new Set();
    const doc = (scope as unknown as { _doc?: Doc })._doc;
    if (doc?.on) {
      doc.on('update', (_update: Uint8Array, origin: unknown) => {
        if (
          (typeof origin === 'string' || typeof origin === 'number') &&
          this.trackedOrigins.has(origin)
        ) {
          this.undoStack.push({ content: scope.toString() });
          this.redoStack.length = 0;
        }
      });
    }
  }

  undo(): void {
    const item = this.undoStack.pop();
    if (item && this.scope) {
      this.redoStack.push({ content: this.scope.toString() });
      const text = this.scope;
      if (text.delete && text.insert) {
        text.delete(0, text.length);
        if (this.undoStack.length > 0) {
          const prev = this.undoStack[this.undoStack.length - 1]!;
          text.insert(0, prev.content);
        }
      }
    }
  }

  redo(): void {
    const item = this.redoStack.pop();
    if (item && this.scope) {
      this.undoStack.push({ content: this.scope.toString() });
      const text = this.scope;
      if (text.delete && text.insert) {
        text.delete(0, text.length);
        text.insert(0, item.content);
      }
    }
  }

  destroy(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CrdtBridgeConfig {
  workspaceId: string;
  peerId: string;
  displayName: string;
  /** DashRelay relay URL (defaults to wss://relay.dashrelay.com/relay/sync) */
  relayUrl?: string;
  /** UCAN token for authorization */
  ucan?: string;
  /** DashRelay API key (alternative to UCAN) */
  apiKey?: string;
}

export interface CrdtFileHandle {
  path: string;
  doc: QDoc;
  content: QText;
  cursors: QMap<CrdtCursorEntry>;
  selections: QMap<CrdtSelectionEntry>;
  diagnostics: QArray<CrdtDiagnosticEntry>;
  annotations: QArray<CrdtAnnotation>;
  meta: QMap<unknown>;
  readingMetrics: QMap<CrdtReadingEntry>;
  relay: DashRelay;
  undoManager: any;
}

export interface CrdtCursorEntry {
  line: number;
  col: number;
  peerId: string;
  displayName: string;
  color: string;
  timestamp: number;
}

export interface CrdtSelectionEntry {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
  peerId: string;
  timestamp: number;
}

export interface CrdtDiagnosticEntry {
  filePath: string;
  line: number;
  column: number;
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  source: string;
  peerId: string;
  timestamp: number;
}

export interface CrdtAnnotation {
  id: string;
  blockId: string;
  peerId: string;
  displayName: string;
  content: string;
  type: 'comment' | 'todo' | 'question' | 'suggestion';
  line: number;
  createdAt: number;
}

export interface CrdtReadingEntry {
  peerId: string;
  timeSpentMs: number;
  scrollPasses: number;
  lastViewed: number;
  engagement: number;
}

export interface CrdtPresenceEntry {
  peerId: string;
  displayName: string;
  color: string;
  currentFile: string | null;
  activity: 'typing' | 'selecting' | 'reading' | 'idle';
  status: 'active' | 'idle' | 'away';
  lastActiveAt: number;
}

export interface CrdtAmygdalaTag {
  blockId: string;
  emotion: string;
  valence: number;
  arousal: number;
  dominance: number;
  intensity: number;
  peerId: string;
  taggedAt: number;
}

export interface CrdtBridgeStatus {
  workspaceId: string;
  peerId: string;
  openFiles: string[];
  presenceConnected: boolean;
  capacitorConnected: boolean;
  poolConnected: boolean;
  peerCount: number;
}

// Participant colors (same 12 from collab-bridge)
const PARTICIPANT_COLORS = [
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
// CrdtBridge
// ---------------------------------------------------------------------------

export class CrdtBridge {
  private config: CrdtBridgeConfig;
  private files = new Map<string, CrdtFileHandle>();
  private presenceRelay: DashRelay | null = null;
  private presenceDoc: QDoc | null = null;
  private capacitorRelay: DashRelay | null = null;
  private capacitorDoc: QDoc | null = null;
  private poolRelay: DashRelay | null = null;
  private poolDoc: QDoc | null = null;
  private colorIndex = 0;
  private peerListeners: Array<(event: string, ...args: unknown[]) => void> =
    [];

  constructor(config: CrdtBridgeConfig) {
    this.config = config;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Connect the workspace-level presence and capacitor rooms.
   */
  async connect(): Promise<void> {
    // Presence room — workspace-wide cursor tracking
    this.presenceDoc = new QDoc();
    this.presenceRelay = this.createRelay('presence');
    await this.presenceRelay.connect(this.presenceDoc);

    // Register self in presence
    const presenceMap =
      this.presenceDoc.getMap<CrdtPresenceEntry>('participants');
    presenceMap.set(this.config.peerId, {
      peerId: this.config.peerId,
      displayName: this.config.displayName,
      color: this.nextColor(),
      currentFile: null,
      activity: 'idle',
      status: 'active',
      lastActiveAt: Date.now(),
    });

    // Capacitor room — shared reading metrics and emotion tags
    this.capacitorDoc = new QDoc();
    this.capacitorRelay = this.createRelay('capacitor');
    await this.capacitorRelay.connect(this.capacitorDoc);

    // Pool room — compute contributions reputation ledger
    this.poolDoc = new QDoc();
    this.poolRelay = this.createRelay('pool');
    await this.poolRelay.connect(this.poolDoc);

    // Listen for peer events on presence relay
    this.presenceRelay.on('peerJoined', (peerId: string) => {
      for (const listener of this.peerListeners) {
        listener('peerJoined', peerId);
      }
    });

    this.presenceRelay.on('peerLeft', (peerId: string) => {
      for (const listener of this.peerListeners) {
        listener('peerLeft', peerId);
      }
    });
  }

  /**
   * Disconnect all relays and clean up.
   */
  disconnect(): void {
    // Remove self from presence
    if (this.presenceDoc) {
      const presenceMap =
        this.presenceDoc.getMap<CrdtPresenceEntry>('participants');
      presenceMap.delete(this.config.peerId);
    }

    // Close all file relays
    for (const [, handle] of this.files) {
      handle.cursors.delete(this.config.peerId);
      handle.relay.disconnect();
      handle.doc.destroy();
    }
    this.files.clear();

    // Close workspace relays
    this.presenceRelay?.disconnect();
    this.presenceRelay = null;
    this.presenceDoc?.destroy();
    this.presenceDoc = null;

    this.capacitorRelay?.disconnect();
    this.capacitorRelay = null;
    this.capacitorDoc?.destroy();
    this.capacitorDoc = null;

    this.poolRelay?.disconnect();
    this.poolRelay = null;
    this.poolDoc?.destroy();
    this.poolDoc = null;
  }

  // -------------------------------------------------------------------------
  // File Operations
  // -------------------------------------------------------------------------

  /**
   * Open a file for collaborative editing.
   * Returns a handle with CRDT-backed content, cursors, diagnostics, etc.
   */
  async openFile(
    path: string,
    initialContent?: string
  ): Promise<CrdtFileHandle> {
    const existing = this.files.get(path);
    if (existing) return existing;

    const doc = new QDoc();
    const relay = this.createRelay('file.' + path);
    await relay.connect(doc);

    const content = doc.getText('content');
    const cursors = doc.getMap<CrdtCursorEntry>('cursors');
    const selections = doc.getMap<CrdtSelectionEntry>('selections');
    const diagnostics = doc.getArray<CrdtDiagnosticEntry>('diagnostics');
    const annotations = doc.getArray<CrdtAnnotation>('annotations');
    const meta = doc.getMap<unknown>('meta');
    const readingMetrics = doc.getMap<CrdtReadingEntry>('readingMetrics');

    // If this is a brand-new document and we have initial content, populate it
    if (initialContent && content.length === 0) {
      content.insert(0, initialContent);
    }

    // UndoManager tracks only our own operations
    const undoManager = new SimpleUndoManager(content, {
      trackedOrigins: new Set([doc.clientID]),
    });

    const handle: CrdtFileHandle = {
      path,
      doc,
      content,
      cursors,
      selections,
      diagnostics,
      annotations,
      meta,
      readingMetrics,
      relay,
      undoManager,
    };

    this.files.set(path, handle);

    // Update presence: we're now in this file
    this.updatePresenceFile(path);

    return handle;
  }

  /**
   * Close a file and disconnect its relay.
   */
  closeFile(path: string): void {
    const handle = this.files.get(path);
    if (!handle) return;

    handle.cursors.delete(this.config.peerId);
    handle.selections.delete(this.config.peerId);
    handle.relay.disconnect();
    handle.doc.destroy();
    this.files.delete(path);
  }

  /**
   * Get a file handle (returns null if not open).
   */
  getFile(path: string): CrdtFileHandle | null {
    return this.files.get(path) ?? null;
  }

  /**
   * List all open files.
   */
  getOpenFiles(): string[] {
    return Array.from(this.files.keys());
  }

  // -------------------------------------------------------------------------
  // Cursor and Selection (replaces collab-bridge presence)
  // -------------------------------------------------------------------------

  /**
   * Update cursor position for the local peer.
   */
  updateCursor(path: string, line: number, col: number): void {
    const handle = this.files.get(path);
    if (!handle) return;

    handle.cursors.set(this.config.peerId, {
      line,
      col,
      peerId: this.config.peerId,
      displayName: this.config.displayName,
      color: this.getMyColor(),
      timestamp: Date.now(),
    });

    this.updatePresenceActivity(path, 'reading');
  }

  /**
   * Update selection range for the local peer.
   */
  updateSelection(
    path: string,
    startLine: number,
    startCol: number,
    endLine: number,
    endCol: number
  ): void {
    const handle = this.files.get(path);
    if (!handle) return;

    handle.selections.set(this.config.peerId, {
      startLine,
      startCol,
      endLine,
      endCol,
      peerId: this.config.peerId,
      timestamp: Date.now(),
    });

    this.updatePresenceActivity(path, 'selecting');
  }

  /**
   * Get all cursors for a file (from all peers).
   */
  getCursors(path: string): CrdtCursorEntry[] {
    const handle = this.files.get(path);
    if (!handle) return [];
    return Array.from(handle.cursors.values());
  }

  /**
   * Get all selections for a file (from all peers).
   */
  getSelections(path: string): CrdtSelectionEntry[] {
    const handle = this.files.get(path);
    if (!handle) return [];
    return Array.from(handle.selections.values());
  }

  // -------------------------------------------------------------------------
  // Diagnostics (replaces collab-bridge shareDiagnostics)
  // -------------------------------------------------------------------------

  /**
   * Share diagnostics for a file.
   */
  shareDiagnostics(
    path: string,
    diagnostics: Omit<CrdtDiagnosticEntry, 'peerId' | 'timestamp'>[]
  ): void {
    const handle = this.files.get(path);
    if (!handle) return;

    // Remove our previous diagnostics
    const toRemove: number[] = [];
    handle.diagnostics.forEach((diag, idx) => {
      if (diag.peerId === this.config.peerId) {
        toRemove.push(idx);
      }
    });

    // Remove in reverse order to preserve indices
    handle.doc.transact(() => {
      for (let i = toRemove.length - 1; i >= 0; i--) {
        handle.diagnostics.delete(toRemove[i]!, 1);
      }

      // Add new diagnostics
      for (const diag of diagnostics) {
        handle.diagnostics.push([
          {
            ...diag,
            peerId: this.config.peerId,
            timestamp: Date.now(),
          },
        ]);
      }
    });
  }

  /**
   * Get all diagnostics for a file (from all peers).
   */
  getDiagnostics(path: string): CrdtDiagnosticEntry[] {
    const handle = this.files.get(path);
    if (!handle) return [];
    return handle.diagnostics.toArray();
  }

  // -------------------------------------------------------------------------
  // Annotations
  // -------------------------------------------------------------------------

  /**
   * Add an annotation (code review comment, TODO, question).
   */
  addAnnotation(
    path: string,
    annotation: Omit<
      CrdtAnnotation,
      'id' | 'peerId' | 'displayName' | 'createdAt'
    >
  ): CrdtAnnotation {
    const handle = this.files.get(path);
    if (!handle) throw new Error(`File not open: ${path}`);

    const entry: CrdtAnnotation = {
      id: `ann-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ...annotation,
      peerId: this.config.peerId,
      displayName: this.config.displayName,
      createdAt: Date.now(),
    };

    handle.annotations.push([entry]);
    return entry;
  }

  /**
   * Get all annotations for a file.
   */
  getAnnotations(path: string): CrdtAnnotation[] {
    const handle = this.files.get(path);
    if (!handle) return [];
    return handle.annotations.toArray();
  }

  // -------------------------------------------------------------------------
  // Reading Metrics (replaces capacitor-bridge readingMetrics)
  // -------------------------------------------------------------------------

  /**
   * Record reading time for a code block. Synced to all peers via CRDT.
   */
  recordReading(path: string, blockId: string, timeSpentMs: number): void {
    const handle = this.files.get(path);
    if (!handle) return;

    const key = `${blockId}:${this.config.peerId}`;
    const existing = handle.readingMetrics.get(key) as
      | CrdtReadingEntry
      | undefined;

    const totalTime = (existing?.timeSpentMs ?? 0) + timeSpentMs;
    handle.readingMetrics.set(key, {
      peerId: this.config.peerId,
      timeSpentMs: totalTime,
      scrollPasses: (existing?.scrollPasses ?? 0) + 1,
      lastViewed: Date.now(),
      engagement: Math.min(1, totalTime / 30_000),
    });
  }

  /**
   * Get reading metrics for a block across all peers.
   */
  getReadingMetrics(path: string, blockId: string): CrdtReadingEntry[] {
    const handle = this.files.get(path);
    if (!handle) return [];

    const results: CrdtReadingEntry[] = [];
    handle.readingMetrics.forEach((entry, key) => {
      if (key.startsWith(`${blockId}:`)) {
        results.push(entry);
      }
    });
    return results;
  }

  /**
   * Get aggregate engagement for a block (max across all peers).
   */
  getBlockEngagement(path: string, blockId: string): number {
    const metrics = this.getReadingMetrics(path, blockId);
    if (metrics.length === 0) return 0;
    return Math.max(...metrics.map((m) => m.engagement));
  }

  // -------------------------------------------------------------------------
  // Amygdala Tags (replaces capacitor-bridge emotion tagging)
  // -------------------------------------------------------------------------

  /**
   * Tag a code block with an emotion. Synced via the capacitor room.
   */
  tagEmotion(
    path: string,
    tag: Omit<CrdtAmygdalaTag, 'peerId' | 'taggedAt'>
  ): void {
    if (!this.capacitorDoc) return;

    const emotionMap =
      this.capacitorDoc.getMap<CrdtAmygdalaTag>('amygdalaTags');
    const key = `${path}:${tag.blockId}:${this.config.peerId}`;
    emotionMap.set(key, {
      ...tag,
      peerId: this.config.peerId,
      taggedAt: Date.now(),
    });
  }

  /**
   * Get emotion tags for a block across all peers.
   */
  getEmotionTags(path: string, blockId: string): CrdtAmygdalaTag[] {
    if (!this.capacitorDoc) return [];

    const emotionMap =
      this.capacitorDoc.getMap<CrdtAmygdalaTag>('amygdalaTags');
    const results: CrdtAmygdalaTag[] = [];
    const prefix = `${path}:${blockId}:`;

    emotionMap.forEach((tag, key) => {
      if (key.startsWith(prefix)) {
        results.push(tag);
      }
    });

    return results;
  }

  /**
   * Get the dominant emotion for a block (highest intensity across all peers).
   */
  getDominantEmotion(path: string, blockId: string): CrdtAmygdalaTag | null {
    const tags = this.getEmotionTags(path, blockId);
    if (tags.length === 0) return null;
    return tags.reduce((a, b) => (a.intensity > b.intensity ? a : b));
  }

  // -------------------------------------------------------------------------
  // Presence (replaces collab-bridge presence tracking)
  // -------------------------------------------------------------------------

  /**
   * Get all participants in the workspace.
   */
  getParticipants(): CrdtPresenceEntry[] {
    if (!this.presenceDoc) return [];
    const presenceMap =
      this.presenceDoc.getMap<CrdtPresenceEntry>('participants');
    return Array.from(presenceMap.values());
  }

  /**
   * Mark idle participants (>60s idle, >300s away).
   */
  updateIdleStatus(): void {
    if (!this.presenceDoc) return;

    const presenceMap =
      this.presenceDoc.getMap<CrdtPresenceEntry>('participants');
    const myEntry = presenceMap.get(this.config.peerId);
    if (!myEntry) return;

    const now = Date.now();
    const elapsed = now - myEntry.lastActiveAt;

    let newStatus: CrdtPresenceEntry['status'] = 'active';
    if (elapsed > 300_000) newStatus = 'away';
    else if (elapsed > 60_000) newStatus = 'idle';

    if (newStatus !== myEntry.status) {
      presenceMap.set(this.config.peerId, { ...myEntry, status: newStatus });
    }
  }

  /**
   * Listen for peer join/leave events.
   */
  onPeerEvent(listener: (event: string, ...args: unknown[]) => void): void {
    this.peerListeners.push(listener);
  }

  // -------------------------------------------------------------------------
  // Undo (per-peer, per-file)
  // -------------------------------------------------------------------------

  /**
   * Undo the last local operation on a file.
   */
  undo(path: string): void {
    const handle = this.files.get(path);
    if (!handle) return;
    handle.undoManager.undo();
  }

  /**
   * Redo the last undone operation on a file.
   */
  redo(path: string): void {
    const handle = this.files.get(path);
    if (!handle) return;
    handle.undoManager.redo();
  }

  /**
   * Create an UndoManager that tracks a specific peer's operations
   * (used to selectively undo agent edits).
   */
  createPeerUndoManager(
    path: string,
    trackedPeerOrigin: number
  ): SimpleUndoManager | null {
    const handle = this.files.get(path);
    if (!handle) return null;
    return new SimpleUndoManager(handle.content, {
      trackedOrigins: new Set([trackedPeerOrigin]),
    });
  }

  // -------------------------------------------------------------------------
  // Compute Pool Reputation Ledger (Phase 7)
  // -------------------------------------------------------------------------

  /**
   * Record a compute contribution (tokens served, requests handled).
   */
  recordContribution(peerId: string, tokens: number, requests: number): void {
    if (!this.poolDoc) return;
    const ledger = this.poolDoc.getMap<{
      peerId: string;
      tokens: number;
      requests: number;
      lastContribution: number;
    }>('contributions');
    const existing = ledger.get(peerId);
    ledger.set(peerId, {
      peerId,
      tokens: (existing?.tokens ?? 0) + tokens,
      requests: (existing?.requests ?? 0) + requests,
      lastContribution: Date.now(),
    });
  }

  /**
   * Get the full reputation ledger.
   */
  getReputationLedger(): Array<{
    peerId: string;
    tokens: number;
    requests: number;
    lastContribution: number;
  }> {
    if (!this.poolDoc) return [];
    const ledger = this.poolDoc.getMap<{
      peerId: string;
      tokens: number;
      requests: number;
      lastContribution: number;
    }>('contributions');
    const results: Array<{
      peerId: string;
      tokens: number;
      requests: number;
      lastContribution: number;
    }> = [];
    ledger.forEach((entry) => results.push(entry));
    return results;
  }

  // -------------------------------------------------------------------------
  // Time Travel (Phase 8)
  // -------------------------------------------------------------------------

  /**
   * Get a snapshot of the current file state.
   */
  getSnapshot(path: string): Uint8Array | null {
    const handle = this.files.get(path);
    if (!handle) return null;
    return encodeStateAsUpdate(handle.doc);
  }

  /**
   * Get the state vector for a file.
   */
  getStateVector(path: string): Uint8Array | null {
    const handle = this.files.get(path);
    if (!handle) return null;
    return encodeStateVector(handle.doc);
  }

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  /**
   * Get bridge status.
   */
  getStatus(): CrdtBridgeStatus {
    const participants = this.getParticipants();
    return {
      workspaceId: this.config.workspaceId,
      peerId: this.config.peerId,
      openFiles: this.getOpenFiles(),
      presenceConnected: this.presenceRelay !== null,
      capacitorConnected: this.capacitorRelay !== null,
      poolConnected: this.poolRelay !== null,
      peerCount: participants.length,
    };
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private createRelay(roomSuffix: string): DashRelay {
    const normalizedWs = this.config.workspaceId.replace(
      /[^a-zA-Z0-9._:-]/g,
      '_'
    );
    const normalizedSuffix = roomSuffix.replace(/[^a-zA-Z0-9._:-]/g, '_');
    return new DashRelay({
      roomName: `aeon.kernel.zedge.${normalizedWs}.${normalizedSuffix}`,
      url: this.config.relayUrl,
      ucan: this.config.ucan,
      apiKey: this.config.apiKey,
      clientId: this.config.peerId,
    });
  }

  private updatePresenceFile(path: string): void {
    if (!this.presenceDoc) return;
    const presenceMap =
      this.presenceDoc.getMap<CrdtPresenceEntry>('participants');
    const entry = presenceMap.get(this.config.peerId);
    if (entry) {
      presenceMap.set(this.config.peerId, {
        ...entry,
        currentFile: path,
        lastActiveAt: Date.now(),
        status: 'active',
      });
    }
  }

  private updatePresenceActivity(
    path: string,
    activity: CrdtPresenceEntry['activity']
  ): void {
    if (!this.presenceDoc) return;
    const presenceMap =
      this.presenceDoc.getMap<CrdtPresenceEntry>('participants');
    const entry = presenceMap.get(this.config.peerId);
    if (entry) {
      presenceMap.set(this.config.peerId, {
        ...entry,
        currentFile: path,
        activity,
        lastActiveAt: Date.now(),
        status: 'active',
      });
    }
  }

  private nextColor(): string {
    const color =
      PARTICIPANT_COLORS[this.colorIndex % PARTICIPANT_COLORS.length]!;
    this.colorIndex++;
    return color;
  }

  private getMyColor(): string {
    if (!this.presenceDoc) return PARTICIPANT_COLORS[0]!;
    const presenceMap =
      this.presenceDoc.getMap<CrdtPresenceEntry>('participants');
    const entry = presenceMap.get(this.config.peerId);
    return entry?.color ?? PARTICIPANT_COLORS[0]!;
  }
}
