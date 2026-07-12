/**
 * Shared Crypto Utilities
 *
 * Extracted from vfs-bridge.ts for reuse across modules:
 * - VfsBridge (encrypted file sync)
 * - CrdtEncryptionProvider (encrypted CRDT updates)
 */

import {
  createHash,
  createHmac,
  randomBytes,
  createCipheriv,
  createDecipheriv,
} from 'node:crypto';

/**
 * Handles the zedge sha256 workflow.
 */
export function sha256(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Handles the zedge hmac Sha256 workflow.
 */
export function hmacSha256(key: Uint8Array, data: Uint8Array): string {
  return createHmac('sha256', key).update(data).digest('hex');
}

/**
 * Handles the zedge encrypt Aes256 Gcm workflow.
 */
export function encryptAes256Gcm(
  key: Uint8Array,
  plaintext: Uint8Array
): { ciphertext: Uint8Array; iv: Uint8Array; authTag: Uint8Array } {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: new Uint8Array(encrypted),
    iv: new Uint8Array(iv),
    authTag: new Uint8Array(authTag),
  };
}

/**
 * Handles the zedge decrypt Aes256 Gcm workflow.
 */
export function decryptAes256Gcm(
  key: Uint8Array,
  ciphertext: Uint8Array,
  iv: Uint8Array,
  authTag: Uint8Array
): Uint8Array {
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return new Uint8Array(decrypted);
}
