/**
 * VFS-CRDT Adapter
 *
 * Bridges VfsBridge (filesystem) and CrdtBridge (CRDT) for bidirectional sync.
 * CRDT is authoritative; filesystem is the "view".
 */
import type { VfsBridge } from './vfs-bridge';
import type { CrdtBridge, CrdtFileHandle } from './crdt-bridge';

export class VfsCrdtAdapter {
  private vfs: VfsBridge;
  private crdt: CrdtBridge;
  private mountId: string | null = null;
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private syncedFiles = new Set<string>();

  constructor(vfs: VfsBridge, crdt: CrdtBridge) {
    this.vfs = vfs;
    this.crdt = crdt;
  }

  /**
   * Bind a VFS mount to the CRDT bridge.
   */
  bind(mountId: string): void {
    this.mountId = mountId;
  }

  /**
   * Sync a local file change to CRDT.
   * Called when VfsBridge detects a file change.
   */
  async syncLocalToCrdt(filePath: string, content: string): Promise<void> {
    const handle = await this.crdt.openFile(filePath, content);
    const currentContent = handle.content.toString();

    if (currentContent !== content) {
      handle.doc.transact(() => {
        handle.content.delete(0, handle.content.length);
        handle.content.insert(0, content);
      }, handle.doc.clientID);
    }

    this.syncedFiles.add(filePath);
  }

  /**
   * Get the CRDT content for a file (the authoritative version).
   */
  getCrdtContent(filePath: string): string | null {
    const handle = this.crdt.getFile(filePath);
    if (!handle) return null;
    return handle.content.toString();
  }

  /**
   * Get list of synced files.
   */
  getSyncedFiles(): string[] {
    return Array.from(this.syncedFiles);
  }

  /**
   * Unbind and clean up.
   */
  unbind(): void {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.syncedFiles.clear();
    this.mountId = null;
  }
}
