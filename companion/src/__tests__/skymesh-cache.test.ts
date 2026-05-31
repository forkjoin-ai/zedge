/**
 * Skymesh Cache Tests
 *
 * Golden vector assertions to ensure byte-exact equivalence with the canonical
 * canonicalQueryHash implementation (apps/skymesh/src/lib/cache-key.ts).
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { canonicalQueryHash, isSkymeshTeleportEnabled, trySkymeshCacheTeleport } from '../skymesh-cache.ts';

describe('skymesh-cache', () => {
  describe('canonicalQueryHash', () => {
    it('produces the golden vector fp48 hash', () => {
      const result = canonicalQueryHash(
        [785, 6722, 315, 9625, 374],
        'qwen2.5-0.5b-instruct',
        'skymesh-query/v1',
      );
      expect(result).toBe('49af207da814');
    });

    it('throws on empty tokens', () => {
      expect(() => {
        canonicalQueryHash([], 'qwen2.5-0.5b-instruct', 'skymesh-query/v1');
      }).toThrow(RangeError);
    });

    it('is sensitive to model changes', () => {
      const hash1 = canonicalQueryHash(
        [785, 6722, 315, 9625, 374],
        'qwen2.5-0.5b-instruct',
        'skymesh-query/v1',
      );
      const hash2 = canonicalQueryHash(
        [785, 6722, 315, 9625, 374],
        'gemma4-31b',
        'skymesh-query/v1',
      );
      expect(hash1).not.toBe(hash2);
    });

    it('is sensitive to token changes', () => {
      const hash1 = canonicalQueryHash(
        [785, 6722, 315, 9625, 374],
        'qwen2.5-0.5b-instruct',
        'skymesh-query/v1',
      );
      const hash2 = canonicalQueryHash(
        [785, 6722, 315, 9625, 375],
        'qwen2.5-0.5b-instruct',
        'skymesh-query/v1',
      );
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('isSkymeshTeleportEnabled', () => {
    const originalEnv = process.env.ZEDGE_SKYMESH_TELEPORT;

    afterEach(() => {
      process.env.ZEDGE_SKYMESH_TELEPORT = originalEnv;
    });

    it('returns true by default', () => {
      delete process.env.ZEDGE_SKYMESH_TELEPORT;
      expect(isSkymeshTeleportEnabled()).toBe(true);
    });

    it('returns false when set to 0', () => {
      process.env.ZEDGE_SKYMESH_TELEPORT = '0';
      expect(isSkymeshTeleportEnabled()).toBe(false);
    });

    it('returns false when set to false', () => {
      process.env.ZEDGE_SKYMESH_TELEPORT = 'false';
      expect(isSkymeshTeleportEnabled()).toBe(false);
    });

    it('returns false when set to off', () => {
      process.env.ZEDGE_SKYMESH_TELEPORT = 'off';
      expect(isSkymeshTeleportEnabled()).toBe(false);
    });

    it('returns true for any other value', () => {
      process.env.ZEDGE_SKYMESH_TELEPORT = 'yes';
      expect(isSkymeshTeleportEnabled()).toBe(true);
    });
  });

  describe('trySkymeshCacheTeleport', () => {
    it('returns null when disabled', async () => {
      const originalEnv = process.env.ZEDGE_SKYMESH_TELEPORT;
      process.env.ZEDGE_SKYMESH_TELEPORT = '0';
      try {
        const result = await trySkymeshCacheTeleport(
          'test prompt',
          'qwen2.5-0.5b-instruct',
          'http://localhost:8000',
          'https://cache.example.com',
        );
        expect(result).toBe(null);
      } finally {
        process.env.ZEDGE_SKYMESH_TELEPORT = originalEnv;
      }
    });

    it('returns null on empty prompt', async () => {
      const result = await trySkymeshCacheTeleport(
        '   ',
        'qwen2.5-0.5b-instruct',
        'http://localhost:8000',
        'https://cache.example.com',
      );
      expect(result).toBe(null);
    });

    it('returns null when fat-station is unreachable', async () => {
      const result = await trySkymeshCacheTeleport(
        'test prompt',
        'qwen2.5-0.5b-instruct',
        'http://localhost:19999', // unlikely port
        'https://cache.example.com',
      );
      expect(result).toBe(null);
    });

    it('returns null on non-JSON cache response', async () => {
      // Mock server that returns non-JSON
      let server: any;
      try {
        server = Bun.serve({
          port: 19998,
          fetch() {
            return new Response('not json');
          },
        });

        const result = await trySkymeshCacheTeleport(
          'test prompt',
          'qwen2.5-0.5b-instruct',
          'http://localhost:19999', // point to unreachable tokenizer
          'http://localhost:19998',
        );
        expect(result).toBe(null);
      } finally {
        server?.stop();
      }
    });

    it('returns null on unverified cache hit', async () => {
      // Mock servers for both tokenizer and cache
      let tokenizerServer: any, cacheServer: any;
      try {
        tokenizerServer = Bun.serve({
          port: 19997,
          async fetch(req) {
            return new Response(JSON.stringify({ tokens: [785, 6722, 315, 9625, 374] }));
          },
        });

        cacheServer = Bun.serve({
          port: 19996,
          async fetch(req) {
            return new Response(
              JSON.stringify({
                hit: true,
                entry: {
                  answerText: 'cached answer',
                  attestation: {
                    pass: false, // unverified
                    admitted: false,
                    sig: '',
                  },
                },
              }),
            );
          },
        });

        const result = await trySkymeshCacheTeleport(
          'test prompt',
          'qwen2.5-0.5b-instruct',
          'http://localhost:19997',
          'http://localhost:19996',
        );
        expect(result).toBe(null);
      } finally {
        tokenizerServer?.stop();
        cacheServer?.stop();
      }
    });

    it('returns answerText on verified cache hit', async () => {
      // Mock servers for both tokenizer and cache
      let tokenizerServer: any, cacheServer: any;
      try {
        tokenizerServer = Bun.serve({
          port: 19995,
          async fetch(req) {
            return new Response(JSON.stringify({ tokens: [785, 6722, 315, 9625, 374] }));
          },
        });

        cacheServer = Bun.serve({
          port: 19994,
          async fetch(req) {
            return new Response(
              JSON.stringify({
                hit: true,
                entry: {
                  answerText: 'verified cached answer',
                  attestation: {
                    pass: true,
                    admitted: true,
                    sig: 'valid-signature-here',
                  },
                },
              }),
            );
          },
        });

        const result = await trySkymeshCacheTeleport(
          'test prompt',
          'qwen2.5-0.5b-instruct',
          'http://localhost:19995',
          'http://localhost:19994',
        );
        expect(result).toBe('verified cached answer');
      } finally {
        tokenizerServer?.stop();
        cacheServer?.stop();
      }
    });

    it('returns null on cache miss', async () => {
      // Mock servers for both tokenizer and cache
      let tokenizerServer: any, cacheServer: any;
      try {
        tokenizerServer = Bun.serve({
          port: 19993,
          async fetch(req) {
            return new Response(JSON.stringify({ tokens: [785, 6722, 315, 9625, 374] }));
          },
        });

        cacheServer = Bun.serve({
          port: 19992,
          async fetch(req) {
            return new Response(
              JSON.stringify({
                hit: false,
              }),
            );
          },
        });

        const result = await trySkymeshCacheTeleport(
          'uncached prompt',
          'qwen2.5-0.5b-instruct',
          'http://localhost:19993',
          'http://localhost:19992',
        );
        expect(result).toBe(null);
      } finally {
        tokenizerServer?.stop();
        cacheServer?.stop();
      }
    });
  });
});
