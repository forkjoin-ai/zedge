import { describe, test, expect, beforeEach, afterEach } from '@a0n/gnosis/test';
import { VfsBridge } from '../vfs-bridge';
import { join } from 'node:path';
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';

const TEST_DIR = join(tmpdir(), `zedge-vfs-test-${Date.now()}`);
const PEER_DIR = join(tmpdir(), `zedge-vfs-peer-${Date.now()}`);

function setupRepo(dir: string, files: Record<string, string>): void {
  mkdirSync(dir, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    const fullPath = join(dir, path);
    mkdirSync(fullPath.replace(/\/[^/]+$/, ''), { recursive: true });
    writeFileSync(fullPath, content);
  }
}

function cleanup(): void {
  for (const dir of [TEST_DIR, PEER_DIR]) {
    try {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

describe('VfsBridge', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  test('mount indexes all files in repo', () => {
    setupRepo(TEST_DIR, {
      'src/index.ts': 'console.log("hello");',
      'src/utils.ts': 'export const x = 1;',
      'package.json': '{}',
    });

    const bridge = new VfsBridge('node-1');
    const mount = bridge.mount(TEST_DIR);

    expect(mount.id).toMatch(/^vfs-/);
    expect(mount.files.size).toBe(3);
    expect(mount.files.has('src/index.ts')).toBe(true);
    expect(mount.files.has('package.json')).toBe(true);
  });

  test('getStatus returns correct state', () => {
    setupRepo(TEST_DIR, { 'file.txt': 'content' });

    const bridge = new VfsBridge('node-1');
    const mount = bridge.mount(TEST_DIR);

    const status = bridge.getStatus(mount.id);
    expect(status.mounted).toBe(true);
    expect(status.fileCount).toBe(1);
    expect(status.peerCount).toBe(0);
  });

  test('getStatus for unknown mount returns unmounted', () => {
    const bridge = new VfsBridge('node-1');
    const status = bridge.getStatus('nonexistent');
    expect(status.mounted).toBe(false);
  });

  test('recordChange tracks file modifications', () => {
    setupRepo(TEST_DIR, { 'file.txt': 'original' });

    const bridge = new VfsBridge('node-1');
    const mount = bridge.mount(TEST_DIR);

    writeFileSync(join(TEST_DIR, 'file.txt'), 'modified');
    const change = bridge.recordChange(mount.id, 'file.txt', 'modify');

    expect(change).not.toBeNull();
    expect(change!.type).toBe('modify');
    expect(change!.hash).toBeTruthy();
  });

  test('recordChange tracks deletion', () => {
    setupRepo(TEST_DIR, { 'file.txt': 'content' });

    const bridge = new VfsBridge('node-1');
    const mount = bridge.mount(TEST_DIR);

    const change = bridge.recordChange(mount.id, 'file.txt', 'delete');
    expect(change).not.toBeNull();
    expect(change!.type).toBe('delete');
    expect(mount.files.has('file.txt')).toBe(false);
  });

  test('getBlob returns encrypted content with HMAC', () => {
    setupRepo(TEST_DIR, { 'secret.txt': 'sensitive data' });

    const bridge = new VfsBridge('node-1');
    const mount = bridge.mount(TEST_DIR, 'my-passphrase');

    const blob = bridge.getBlob(mount.id, 'secret.txt');
    expect(blob).not.toBeNull();
    expect(blob!.hash).toBeTruthy();
    expect(blob!.hmac).toBeTruthy();
    // Encrypted content should differ from plaintext
    const plaintext = readFileSync(join(TEST_DIR, 'secret.txt'));
    expect(blob!.content.length).toBeGreaterThan(plaintext.length);
  });

  test('applyBlob decrypts and writes correctly', () => {
    setupRepo(TEST_DIR, { 'file.txt': 'hello world' });
    mkdirSync(PEER_DIR, { recursive: true });

    const bridge1 = new VfsBridge('node-1');
    const mount1 = bridge1.mount(TEST_DIR, 'shared-secret');
    const blob = bridge1.getBlob(mount1.id, 'file.txt');
    expect(blob).not.toBeNull();

    const bridge2 = new VfsBridge('node-2');
    const mount2 = bridge2.mount(PEER_DIR, 'shared-secret');
    const applied = bridge2.applyBlob(mount2.id, 'file.txt', blob!);
    expect(applied).toBe(true);

    const peerContent = readFileSync(join(PEER_DIR, 'file.txt'), 'utf-8');
    expect(peerContent).toBe('hello world');
  });

  test('applyBlob rejects tampered HMAC', () => {
    setupRepo(TEST_DIR, { 'file.txt': 'data' });
    mkdirSync(PEER_DIR, { recursive: true });

    const bridge1 = new VfsBridge('node-1');
    const mount1 = bridge1.mount(TEST_DIR, 'key');
    const blob = bridge1.getBlob(mount1.id, 'file.txt')!;

    const bridge2 = new VfsBridge('node-2');
    const mount2 = bridge2.mount(PEER_DIR, 'key');
    const tampered = { ...blob, hmac: 'tampered-hmac' };
    expect(bridge2.applyBlob(mount2.id, 'file.txt', tampered)).toBe(false);
  });

  test('peer management works', () => {
    setupRepo(TEST_DIR, { 'f.txt': 'x' });
    const bridge = new VfsBridge('node-1');
    const mount = bridge.mount(TEST_DIR);

    bridge.addPeer(mount.id, 'peer-1');
    bridge.addPeer(mount.id, 'peer-2');
    expect(bridge.getStatus(mount.id).peerCount).toBe(2);

    bridge.removePeer(mount.id, 'peer-1');
    expect(bridge.getStatus(mount.id).peerCount).toBe(1);
  });

  test('unmount removes the mount', () => {
    setupRepo(TEST_DIR, { 'f.txt': 'x' });
    const bridge = new VfsBridge('node-1');
    const mount = bridge.mount(TEST_DIR);

    bridge.unmount(mount.id);
    expect(bridge.getStatus(mount.id).mounted).toBe(false);
    expect(bridge.getMounts().length).toBe(0);
  });
});
