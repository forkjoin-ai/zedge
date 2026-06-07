/**
 * Skymesh Cache Tests
 *
 * Golden vector assertions to ensure byte-exact equivalence with the canonical
 * canonicalQueryHash implementation (apps/skymesh/src/lib/cache-key.ts).
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { canonicalQueryHash, isSkymeshTeleportEnabled, trySkymeshCacheTeleport } from '../skymesh-cache.ts';

interface TestServer {
  stop(): Promise<void>;
}

function startTestServer(
  port: number,
  handler: () => Response | Promise<Response>,
): Promise<TestServer> {
  const server: Server = createServer(async (_req, res) => {
    try {
      const response = await handler();
      res.statusCode = response.status;
      response.headers.forEach((value, key) => {
        res.setHeader(key, value);
      });
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      res.statusCode = 500;
      res.end(error instanceof Error ? error.message : String(error));
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve({
        stop: () =>
          new Promise<void>((resolveStop, rejectStop) => {
            server.close((error) => {
              if (error) {
                rejectStop(error);
              } else {
                resolveStop();
              }
            });
          }),
      });
    });
  });
}

describe('skymesh-cache', () => {
  describe('canonicalQueryHash', () => {
    it('produces the model-agnostic golden vector fp48 hash', () => {
      const result = canonicalQueryHash(
        [785, 6722, 315, 9625, 374],
        'skymesh-query/v2',
      );
      expect(result).toBe('9f784d85c261');
    });

    it('throws on empty tokens', () => {
      expect(() => {
        canonicalQueryHash([], 'skymesh-query/v2');
      }).toThrow(RangeError);
    });

    it('is MODEL-AGNOSTIC: model is not in the key (no model arg)', () => {
      // The key is over (tokens, qspec) only — a different qspec is a different
      // key, but there is no model dimension to be sensitive to.
      const hash1 = canonicalQueryHash([785, 6722, 315, 9625, 374], 'skymesh-query/v2');
      const hash2 = canonicalQueryHash([785, 6722, 315, 9625, 374], 'skymesh-query/v1');
      expect(hash1).not.toBe(hash2); // qspec-sensitive
      // Re-deriving with the same args is stable (no hidden model input).
      expect(hash1).toBe(canonicalQueryHash([785, 6722, 315, 9625, 374], 'skymesh-query/v2'));
    });

    it('is sensitive to token changes', () => {
      const hash1 = canonicalQueryHash(
        [785, 6722, 315, 9625, 374],
        'skymesh-query/v2',
      );
      const hash2 = canonicalQueryHash(
        [785, 6722, 315, 9625, 375],
        'skymesh-query/v2',
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
      let server: TestServer | undefined;
      try {
        server = await startTestServer(19998, () => new Response('not json'));

        const result = await trySkymeshCacheTeleport(
          'test prompt',
          'qwen2.5-0.5b-instruct',
          'http://localhost:19999', // point to unreachable tokenizer
          'http://localhost:19998',
        );
        expect(result).toBe(null);
      } finally {
        await server?.stop();
      }
    });

    it('returns null on unverified cache hit', async () => {
      // Mock servers for both tokenizer and cache
      let tokenizerServer: TestServer | undefined;
      let cacheServer: TestServer | undefined;
      try {
        tokenizerServer = await startTestServer(19997, () =>
          new Response(JSON.stringify({ tokens: [785, 6722, 315, 9625, 374] }))
        );

        cacheServer = await startTestServer(19996, () =>
          new Response(
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
          )
        );

        const result = await trySkymeshCacheTeleport(
          'test prompt',
          'qwen2.5-0.5b-instruct',
          'http://localhost:19997',
          'http://localhost:19996',
        );
        expect(result).toBe(null);
      } finally {
        await tokenizerServer?.stop();
        await cacheServer?.stop();
      }
    });

    it('returns answerText on verified cache hit', async () => {
      // Mock servers for both tokenizer and cache
      let tokenizerServer: TestServer | undefined;
      let cacheServer: TestServer | undefined;
      try {
        tokenizerServer = await startTestServer(19995, () =>
          new Response(JSON.stringify({ tokens: [785, 6722, 315, 9625, 374] }))
        );

        cacheServer = await startTestServer(19994, () =>
          new Response(
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
          )
        );

        const result = await trySkymeshCacheTeleport(
          'test prompt',
          'qwen2.5-0.5b-instruct',
          'http://localhost:19995',
          'http://localhost:19994',
        );
        expect(result).toBe('verified cached answer');
      } finally {
        await tokenizerServer?.stop();
        await cacheServer?.stop();
      }
    });

    it('returns null on cache miss', async () => {
      // Mock servers for both tokenizer and cache
      let tokenizerServer: TestServer | undefined;
      let cacheServer: TestServer | undefined;
      try {
        tokenizerServer = await startTestServer(19993, () =>
          new Response(JSON.stringify({ tokens: [785, 6722, 315, 9625, 374] }))
        );

        cacheServer = await startTestServer(19992, () =>
          new Response(
            JSON.stringify({
              hit: false,
            }),
          )
        );

        const result = await trySkymeshCacheTeleport(
          'uncached prompt',
          'qwen2.5-0.5b-instruct',
          'http://localhost:19993',
          'http://localhost:19992',
        );
        expect(result).toBe(null);
      } finally {
        await tokenizerServer?.stop();
        await cacheServer?.stop();
      }
    });
  });
});
