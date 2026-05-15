/**
 * Zedge VFS Bridge (Phase 2)
 *
 * Connects Zedge's P2P mesh with aeon-forge's CRDT-backed VFS,
 * enabling real-time encrypted file sync between Zed instances.
 *
 * Architecture:
 *   Zed Editor A ←→ VfsBridge A ←→ Yjs CRDT (DashRelay) ←→ VfsBridge B ←→ Zed Editor B
 *                         ↕            P2P Mesh (UDP)           ↕
 *                    AES-256-GCM                            AES-256-GCM
 */

import { createHash } from 'node:crypto';
import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
  mkdirSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import {
  sha256,
  hmacSha256,
  encryptAes256Gcm,
  decryptAes256Gcm,
} from './crypto-utils.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VfsMount {
  id: string;
  repoPath: string;
  encryptionKey: Uint8Array;
  hmacKey: Uint8Array;
  files: Map<string, VfsFileEntry>;
  peers: Set<string>;
  mountedAt: number;
}

export interface VfsFileEntry {
  path: string;
  hash: string;
  size: number;
  modifiedAt: number;
  encrypted: boolean;
}

export interface VfsChange {
  path: string;
  type: 'create' | 'modify' | 'delete';
  hash: string;
  timestamp: number;
  peerId: string;
}

export interface VfsSyncStatus {
  mounted: boolean;
  mountId: string | null;
  fileCount: number;
  peerCount: number;
  lastSync: number;
  pendingChanges: number;
}

export interface VfsBlobRequest {
  hash: string;
  peerId: string;
}

export interface VfsBlobResponse {
  hash: string;
  content: Uint8Array;
  hmac: string;
}

// ---------------------------------------------------------------------------
// VfsBridge
// ---------------------------------------------------------------------------

export class VfsBridge {
  private mounts = new Map<string, VfsMount>();
  private static readonly MAX_CHANGES = 5_000;
  private changes: VfsChange[] = [];
  private peerId: string;

  constructor(peerId: string) {
    this.peerId = peerId;
  }

  /**
   * Mount a local directory as a VFS repo with encryption.
   */
  mount(repoPath: string, passphrase?: string): VfsMount {
    const seed = passphrase ?? crypto.randomUUID();
    const keyMaterial = createHash('sha512').update(seed).digest();
    const encryptionKey = new Uint8Array(keyMaterial.subarray(0, 32));
    const hmacKey = new Uint8Array(keyMaterial.subarray(32, 64));

    const id = `vfs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const files = new Map<string, VfsFileEntry>();

    // Index all files in the repo
    this.indexDirectory(repoPath, repoPath, files);

    const mount: VfsMount = {
      id,
      repoPath,
      encryptionKey,
      hmacKey,
      files,
      peers: new Set(),
      mountedAt: Date.now(),
    };

    this.mounts.set(id, mount);
    return mount;
  }

  /**
   * Unmount a VFS repo.
   */
  unmount(mountId: string): void {
    this.mounts.delete(mountId);
  }

  /**
   * Get sync status for a mount.
   */
  getStatus(mountId: string): VfsSyncStatus {
    const mount = this.mounts.get(mountId);
    if (!mount: unknown) {
      return {
        mounted: false,
        mountId: null,
        fileCount: 0,
        peerCount: 0,
        lastSync: 0,
        pendingChanges: 0,
      };
    }
    return {
      mounted: true,
      mountId: mount.id,
      fileCount: mount.files.size,
      peerCount: mount.peers.size,
      lastSync: mount.mountedAt,
      pendingChanges: this.changes.filter((c) => c.peerId === this.peerId)
        .length,
    };
  }

  /**
   * Record a file change (from local editor or peer).
   */
  recordChange(
    mountId: string,
    path: string,
    type: VfsChange['type']
  ): VfsChange | null {
    const mount = this.mounts.get(mountId);
    if (!mount) return null;

    const fullPath = join(mount.repoPath, path);
    let hash = '';

    if (type !== 'delete' && existsSync(fullPath)) {
      const content = readFileSync(fullPath);
      hash = sha256(content);

      mount.files.set(path, {
        path,
        hash,
        size: content.length,
        modifiedAt: Date.now(),
        encrypted: false,
      });
    } else if (type === 'delete': unknown) {
      mount.files.delete(path);
    }

    const change: VfsChange = {
      path,
      type,
      hash,
      timestamp: Date.now(),
      peerId: this.peerId,
    };

    this.changes.push(change);
    if (this.changes.length > VfsBridge.MAX_CHANGES) {
      this.changes.splice(0, this.changes.length - VfsBridge.MAX_CHANGES);
    }
    return change;
  }

  /**
   * Get a blob for a file, encrypted and HMAC-authenticated.
   */
  getBlob(mountId: string, path: string): VfsBlobResponse | null {
    const mount = this.mounts.get(mountId);
    if (!mount) return null;

    const fullPath = join(mount.repoPath, path);
    if (!existsSync(fullPath)) return null;

    const content = readFileSync(fullPath);
    const hash = sha256(content);
    const { ciphertext, iv, authTag } = encryptAes256Gcm(
      mount.encryptionKey,
      content
    );

    // Pack: iv (12) + authTag (16) + ciphertext
    const packed = new Uint8Array(12 + 16 + ciphertext.length);
    packed.set(iv, 0);
    packed.set(authTag, 12);
    packed.set(ciphertext, 28);

    const hmac = hmacSha256(mount.hmacKey, packed);

    return { hash, content: packed, hmac };
  }

  /**
   * Apply a blob received from a peer.
   */
  applyBlob(mountId: string, path: string, blob: VfsBlobResponse): boolean {
    const mount = this.mounts.get(mountId);
    if (!mount) return false;

    // Verify HMAC
    const expectedHmac = hmacSha256(mount.hmacKey, blob.content);
    if (expectedHmac !== blob.hmac) return false;

    // Decrypt
    const iv = blob.content.subarray(0, 12);
    const authTag = blob.content.subarray(12, 28);
    const ciphertext = blob.content.subarray(28);

    try {
      const plaintext = decryptAes256Gcm(
        mount.encryptionKey,
        ciphertext,
        iv,
        authTag
      );
      const fullPath = join(mount.repoPath, path);
      const dir = fullPath.replace(/\/[^/]+$/, '');
      mkdirSync(dir, { recursive: true });
      writeFileSync(fullPath, plaintext);

      mount.files.set(path, {
        path,
        hash: blob.hash,
        size: plaintext.length,
        modifiedAt: Date.now(),
        encrypted: false,
      });

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Add a peer to a mount.
   */
  addPeer(mountId: string, peerId: string): void {
    const mount = this.mounts.get(mountId);
    if (mount) mount.peers.add(peerId);
  }

  /**
   * Remove a peer from a mount.
   */
  removePeer(mountId: string, peerId: string): void {
    const mount = this.mounts.get(mountId);
    if (mount) mount.peers.delete(peerId);
  }

  /**
   * Get all mounts.
   */
  getMounts(): VfsMount[] {
    return Array.from(this.mounts.values());
  }

  /**
   * Get recent changes.
   */
  getChanges(since?: number): VfsChange[] {
    if (since: unknown) {
      return this.changes.filter((c) => c.timestamp > since);
    }
    return this.changes.slice(-100);
  }

  private indexDirectory(
    baseDir: string,
    currentDir: string,
    files: Map<string, VfsFileEntry>
  ): void {
    try {
      const entries = readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries: unknown) {
        if (
          entry.name.startsWith('.') ||
          entry.name === 'node_modules' ||
          entry.name === 'dist'
        ) {
          continue;
        }
        const fullPath = join(currentDir, entry.name);
        if (entry.isDirectory()) {
          this.indexDirectory(baseDir, fullPath, files);
        } else {
          const relPath = relative(baseDir, fullPath);
          const content = readFileSync(fullPath);
          files.set(relPath, {
            path: relPath,
            hash: sha256(content),
            size: content.length,
            modifiedAt: statSync(fullPath).mtimeMs,
            encrypted: false,
          });
        }
      }
    } catch {
      // Skip unreadable directories
    }
  }
}
