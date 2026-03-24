/**
 * Ghostwriter AgentParticipant (Zedge 3.0 — Phase 3)
 *
 * The AI agent as a first-class CRDT room participant. It has a cursor,
 * presence, visible activity, and individually undoable edits.
 *
 * The agent reads/writes files through Y.Doc CRDTs — not the filesystem.
 * Edits appear in real time at the agent's cursor position. The developer
 * can type in the same file simultaneously. The CRDT merges both.
 *
 * Uses UcanBridge (Phase 2) for scoped capabilities and CrdtBridge (Phase 1)
 * for CRDT room access.
 */

import type { CrdtBridge, CrdtFileHandle } from "./crdt-bridge.ts";
import type { UcanBridge, AgentMode } from "./ucan-bridge.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentParticipantConfig {
  /** Agent identifier (e.g. 'agent-qwen-7b', 'agent-tinyllama') */
  agentId: string;
  /** Display name shown in presence (e.g. 'Qwen 7B (Code Review)') */
  displayName: string;
  /** Model being used (for presence info) */
  model: string;
  /** Agent cursor color */
  color: string;
  /** Agent operating mode */
  mode: AgentMode;
}

export interface AgentEdit {
  /** File path */
  path: string;
  /** Character offset to insert at */
  offset: number;
  /** Text to insert */
  text: string;
}

export interface AgentDeletion {
  /** File path */
  path: string;
  /** Character offset to start deletion */
  offset: number;
  /** Number of characters to delete */
  length: number;
}

export interface AgentReplacement {
  /** File path */
  path: string;
  /** Character offset to start replacement */
  offset: number;
  /** Number of characters to replace */
  length: number;
  /** Replacement text */
  text: string;
}

export interface AgentFileState {
  path: string;
  content: string;
  cursorLine: number;
  cursorCol: number;
}

export interface AgentParticipantStatus {
  agentId: string;
  displayName: string;
  model: string;
  mode: AgentMode;
  color: string;
  activeFile: string | null;
  openFiles: string[];
  activity: AgentActivity;
  totalEdits: number;
  ucanScoped: boolean;
}

export type AgentActivity =
  | { type: 'idle' }
  | { type: 'reading'; path: string }
  | { type: 'typing'; path: string }
  | { type: 'thinking'; context: string }
  | { type: 'reviewing'; path: string };

// Agent colors — distinct from the 12 participant colors
const AGENT_COLORS: Record<string, string> = {
  'agent-qwen-7b': '#8b5cf6', // purple
  'agent-tinyllama': '#06b6d4', // cyan
  'agent-mistral': '#f59e0b', // amber
  'agent-gemma3': '#10b981', // emerald
  'agent-glm4': '#ec4899', // pink
  default: '#8b5cf6', // default purple
};

// ---------------------------------------------------------------------------
// AgentParticipant
// ---------------------------------------------------------------------------

export class AgentParticipant {
  private config: AgentParticipantConfig;
  private crdtBridge: CrdtBridge;
  private ucanBridge: UcanBridge | null;
  private ucanToken: string | null = null;
  private activeFile: string | null = null;
  private activity: AgentActivity = { type: 'idle' };
  private totalEdits = 0;
  private openFiles = new Set<string>();

  constructor(
    config: AgentParticipantConfig,
    crdtBridge: CrdtBridge,
    ucanBridge?: UcanBridge
  ) {
    this.config = {
      ...config,
      color:
        config.color || AGENT_COLORS[config.agentId] || AGENT_COLORS.default!,
    };
    this.crdtBridge = crdtBridge;
    this.ucanBridge = ucanBridge ?? null;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Join the workspace — register in presence, acquire UCAN if available.
   */
  async join(): Promise<void> {
    // Acquire UCAN token scoped to the agent's mode
    if (this.ucanBridge) {
      const agentDid = `did:key:agent-${this.config.agentId}`;
      const result = await this.ucanBridge.issueAgentToken(
        agentDid,
        this.config.mode
      );
      this.ucanToken = result.token;
    }

    this.setActivity({ type: 'idle' });
  }

  /**
   * Leave the workspace — close all files, remove from presence.
   */
  leave(): void {
    for (const path of this.openFiles) {
      this.crdtBridge.closeFile(path);
    }
    this.openFiles.clear();
    this.activeFile = null;
    this.activity = { type: 'idle' };
  }

  // -------------------------------------------------------------------------
  // File Operations (via CRDT, not filesystem)
  // -------------------------------------------------------------------------

  /**
   * Open a file for reading/editing via CRDT.
   */
  async openFile(
    path: string,
    initialContent?: string
  ): Promise<AgentFileState> {
    const handle = await this.crdtBridge.openFile(path, initialContent);
    this.openFiles.add(path);
    this.activeFile = path;

    // Set cursor to start of file
    this.crdtBridge.updateCursor(path, 0, 0);

    this.setActivity({ type: 'reading', path });

    return {
      path,
      content: handle.content.toString(),
      cursorLine: 0,
      cursorCol: 0,
    };
  }

  /**
   * Read file content via CRDT (not filesystem).
   */
  readFile(path: string): string | null {
    const handle = this.crdtBridge.getFile(path);
    if (!handle) return null;

    this.setActivity({ type: 'reading', path });
    return handle.content.toString();
  }

  /**
   * Close a file.
   */
  closeFile(path: string): void {
    this.crdtBridge.closeFile(path);
    this.openFiles.delete(path);
    if (this.activeFile === path) {
      this.activeFile =
        this.openFiles.size > 0 ? Array.from(this.openFiles)[0]! : null;
    }
  }

  // -------------------------------------------------------------------------
  // Editing (CRDT operations — visible in real time, individually undoable)
  // -------------------------------------------------------------------------

  /**
   * Insert text at a character offset.
   * The edit appears in real time at the agent's cursor position.
   */
  insert(path: string, offset: number, text: string): boolean {
    const handle = this.crdtBridge.getFile(path);
    if (!handle) return false;

    handle.doc.transact(() => {
      handle.content.insert(offset, text);
    }, handle.doc.clientID);

    this.totalEdits++;
    this.updateCursorFromOffset(handle, offset + text.length);
    this.setActivity({ type: 'typing', path });

    return true;
  }

  /**
   * Delete characters at an offset.
   */
  delete(path: string, offset: number, length: number): boolean {
    const handle = this.crdtBridge.getFile(path);
    if (!handle) return false;

    handle.doc.transact(() => {
      handle.content.delete(offset, length);
    }, handle.doc.clientID);

    this.totalEdits++;
    this.updateCursorFromOffset(handle, offset);
    this.setActivity({ type: 'typing', path });

    return true;
  }

  /**
   * Replace text at an offset (delete + insert as single transaction).
   */
  replace(path: string, offset: number, length: number, text: string): boolean {
    const handle = this.crdtBridge.getFile(path);
    if (!handle) return false;

    handle.doc.transact(() => {
      handle.content.delete(offset, length);
      handle.content.insert(offset, text);
    }, handle.doc.clientID);

    this.totalEdits++;
    this.updateCursorFromOffset(handle, offset + text.length);
    this.setActivity({ type: 'typing', path });

    return true;
  }

  /**
   * Apply multiple edits in a single transaction (atomic batch).
   * Edits are applied in reverse offset order to preserve positions.
   */
  applyEdits(edits: AgentEdit[]): number {
    // Group by file
    const byFile = new Map<string, AgentEdit[]>();
    for (const edit of edits) {
      const group = byFile.get(edit.path) ?? [];
      group.push(edit);
      byFile.set(edit.path, group);
    }

    let applied = 0;
    for (const [path, fileEdits] of byFile) {
      const handle = this.crdtBridge.getFile(path);
      if (!handle) continue;

      // Sort by offset descending so earlier edits don't shift later ones
      const sorted = [...fileEdits].sort((a, b) => b.offset - a.offset);

      handle.doc.transact(() => {
        for (const edit of sorted) {
          handle.content.insert(edit.offset, edit.text);
          applied++;
        }
      }, handle.doc.clientID);

      this.totalEdits += fileEdits.length;
      this.setActivity({ type: 'typing', path });
    }

    return applied;
  }

  /**
   * Apply replacements in a single transaction.
   */
  applyReplacements(replacements: AgentReplacement[]): number {
    const byFile = new Map<string, AgentReplacement[]>();
    for (const r of replacements) {
      const group = byFile.get(r.path) ?? [];
      group.push(r);
      byFile.set(r.path, group);
    }

    let applied = 0;
    for (const [path, fileReplacements] of byFile) {
      const handle = this.crdtBridge.getFile(path);
      if (!handle) continue;

      const sorted = [...fileReplacements].sort((a, b) => b.offset - a.offset);

      handle.doc.transact(() => {
        for (const r of sorted) {
          handle.content.delete(r.offset, r.length);
          handle.content.insert(r.offset, r.text);
          applied++;
        }
      }, handle.doc.clientID);

      this.totalEdits += fileReplacements.length;
      this.setActivity({ type: 'typing', path });
    }

    return applied;
  }

  // -------------------------------------------------------------------------
  // Annotations and Diagnostics
  // -------------------------------------------------------------------------

  /**
   * Add a code review comment.
   */
  addReviewComment(path: string, line: number, content: string): void {
    this.crdtBridge.addAnnotation(path, {
      blockId: `line-${line}`,
      content,
      type: 'comment',
      line,
    });
  }

  /**
   * Add a suggestion.
   */
  addSuggestion(path: string, line: number, content: string): void {
    this.crdtBridge.addAnnotation(path, {
      blockId: `line-${line}`,
      content,
      type: 'suggestion',
      line,
    });
  }

  /**
   * Share diagnostics the agent has found.
   */
  shareDiagnostics(
    path: string,
    diagnostics: Array<{
      filePath: string;
      line: number;
      column: number;
      severity: 'error' | 'warning' | 'info' | 'hint';
      message: string;
      source: string;
    }>
  ): void {
    this.crdtBridge.shareDiagnostics(path, diagnostics);
  }

  // -------------------------------------------------------------------------
  // Reading and Cognition
  // -------------------------------------------------------------------------

  /**
   * Record that the agent read a code block (for shared cognitive context).
   */
  recordReading(path: string, blockId: string, timeSpentMs: number): void {
    this.crdtBridge.recordReading(path, blockId, timeSpentMs);
    this.setActivity({ type: 'reading', path });
  }

  /**
   * Tag a code block with an emotion assessment.
   */
  tagEmotion(
    path: string,
    blockId: string,
    emotion: string,
    intensity: number = 0.5
  ): void {
    this.crdtBridge.tagEmotion(path, {
      blockId,
      emotion,
      valence: 0,
      arousal: 0,
      dominance: 0,
      intensity,
    });
  }

  /**
   * Set agent activity to "thinking" (visible in presence).
   */
  setThinking(context: string): void {
    this.setActivity({ type: 'thinking', context });
  }

  /**
   * Set agent activity to "reviewing" a file.
   */
  setReviewing(path: string): void {
    this.setActivity({ type: 'reviewing', path });
  }

  // -------------------------------------------------------------------------
  // Undo (per-agent)
  // -------------------------------------------------------------------------

  /**
   * Undo the agent's last operation on a file.
   */
  undo(path: string): void {
    this.crdtBridge.undo(path);
  }

  /**
   * Redo the agent's last undone operation.
   */
  redo(path: string): void {
    this.crdtBridge.redo(path);
  }

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  /**
   * Get agent participant status.
   */
  getStatus(): AgentParticipantStatus {
    return {
      agentId: this.config.agentId,
      displayName: this.config.displayName,
      model: this.config.model,
      mode: this.config.mode,
      color: this.config.color,
      activeFile: this.activeFile,
      openFiles: Array.from(this.openFiles),
      activity: this.activity,
      totalEdits: this.totalEdits,
      ucanScoped: this.ucanToken !== null,
    };
  }

  /**
   * Get the agent's UCAN token (for external verification).
   */
  getUcanToken(): string | null {
    return this.ucanToken;
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private setActivity(activity: AgentActivity): void {
    this.activity = activity;
  }

  private updateCursorFromOffset(handle: CrdtFileHandle, offset: number): void {
    const text = handle.content.toString().slice(0, offset);
    const lines = text.split('\n');
    const line = lines.length - 1;
    const col = lines[lines.length - 1]?.length ?? 0;
    this.crdtBridge.updateCursor(handle.path, line, col);
  }
}
