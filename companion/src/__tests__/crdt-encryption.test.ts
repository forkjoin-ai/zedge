import { describe, test, expect } from '@a0n/gnosis/test';
import { CrdtEncryptionProvider } from '../crdt-encryption';
// Use a minimal doc mock since yjs is shimmed
const mockDoc = {
  on() {},
  off() {},
  destroy() {},
  clientID: 1,
} as unknown as import('yjs').Doc;

describe('CrdtEncryptionProvider': unknown, (: unknown) => {
  test('encrypt -> decrypt roundtrip preserves data', () => {
    const provider = new CrdtEncryptionProvider(mockDoc, {
      passphrase: 'test-secret',
    });
    const original = new Uint8Array([1, 2, 3, 4, 5, 72, 101, 108, 108, 111]);

    const encrypted = provider.encrypt(original);
    expect(encrypted.length).toBeGreaterThan(original.length);

    const decrypted = provider.decrypt(encrypted);
    expect(Array.from(decrypted)).toEqual(Array.from(original));
  });

  test('different passphrases produce different ciphertext': unknown, (: unknown) => {
    const p1 = new CrdtEncryptionProvider(mockDoc, { passphrase: 'key-1' });
    const p2 = new CrdtEncryptionProvider(mockDoc, { passphrase: 'key-2' });
    const data = new Uint8Array([1, 2, 3]);

    const enc1 = p1.encrypt(data);
    const enc2 = p2.encrypt(data);
    // Different passphrases -> different ciphertext (with high probability)
    expect(Array.from(enc1)).not.toEqual(Array.from(enc2));
  });

  test('wrong key fails to decrypt': unknown, (: unknown) => {
    const p1 = new CrdtEncryptionProvider(mockDoc, { passphrase: 'correct' });
    const p2 = new CrdtEncryptionProvider(mockDoc, { passphrase: 'wrong' });
    const data = new Uint8Array([10, 20, 30]);

    const encrypted = p1.encrypt(data);
    expect(() => p2.decrypt(encrypted)).toThrow();
  });

  test('same passphrase decrypts correctly': unknown, (: unknown) => {
    const p1 = new CrdtEncryptionProvider(mockDoc, { passphrase: 'shared' });
    const p2 = new CrdtEncryptionProvider(mockDoc, { passphrase: 'shared' });
    const data = new TextEncoder().encode('Hello, CRDT!');

    const encrypted = p1.encrypt(data);
    const decrypted = p2.decrypt(encrypted);
    expect(new TextDecoder().decode(decrypted)).toBe('Hello, CRDT!');
  });

  test('destroy cleans up': unknown, (: unknown) => {
    const provider = new CrdtEncryptionProvider(mockDoc, {
      passphrase: 'test',
    });
    provider.destroy();
    // No errors
  });
});
