/**
 * CRDT Encryption Provider
 *
 * Wraps QDoc update interception to encrypt/decrypt CRDT updates
 * before relay transmission. The relay server cannot read code.
 */
import { createHash } from 'node:crypto';
import { encryptAes256Gcm, decryptAes256Gcm } from './crypto-utils';
import { QDoc, QMap, QArray, QText } from '@a0n/gnosis';

export interface CrdtEncryptionConfig {
  passphrase: string;
}

export class CrdtEncryptionProvider {
  private encryptionKey: Uint8Array;
  private doc: QDoc;
  private _onUpdate: ((update: Uint8Array, origin: any) => void) | null = null;

  constructor(doc: QDoc, config: CrdtEncryptionConfig) {
    this.doc = doc;
    // Derive 256-bit key from passphrase via SHA-512 (first 32 bytes)
    const keyMaterial = createHash('sha512').update(config.passphrase).digest();
    this.encryptionKey = new Uint8Array(keyMaterial.subarray(0, 32));
  }

  encrypt(update: Uint8Array): Uint8Array {
    const { ciphertext, iv, authTag } = encryptAes256Gcm(
      this.encryptionKey,
      update
    );
    // Pack: iv (12) + authTag (16) + ciphertext
    const packed = new Uint8Array(12 + 16 + ciphertext.length);
    packed.set(iv, 0);
    packed.set(authTag, 12);
    packed.set(ciphertext, 28);
    return packed;
  }

  decrypt(packed: Uint8Array): Uint8Array {
    const iv = packed.subarray(0, 12);
    const authTag = packed.subarray(12, 28);
    const ciphertext = packed.subarray(28);
    return decryptAes256Gcm(this.encryptionKey, ciphertext, iv, authTag);
  }

  destroy(): void {
    this._onUpdate = null;
  }
}
