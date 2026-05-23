import { describe, expect, it } from '@a0n/gnosis/test';
import {
  generateRoomUcan,
  parseRoomUcan,
  isRoomUcanExpired,
  getCapabilitiesForMode,
  capabilitySatisfies,
  generateInvite,
} from '../ucan-scope';
import type { ZedgeCapability } from '../ucan-scope';

describe('ucan-scope', () => {
  describe('generateRoomUcan', () => {
    it('produces a valid token with all fields', () => {
      const capabilities: ZedgeCapability[] = [
        { resource: 'zedge/file', action: 'read' },
      ];
      const result = generateRoomUcan(
        'issuer-1',
        'audience-1',
        'my-room',
        capabilities
      );

      expect(result.token).toBeTruthy();
      expect(result.token.split('.')).toHaveLength(3);
      expect(result.token.endsWith('.unsigned')).toBe(true);
      expect(result.payload.iss).toBe('issuer-1');
      expect(result.payload.aud).toBe('audience-1');
      expect(result.payload.room).toBe('my-room');
      expect(result.payload.capabilities).toEqual(capabilities);
      expect(result.payload.exp).toBeGreaterThan(result.payload.iat);
      expect(result.payload.nonce).toBeTruthy();
    });

    it('respects custom TTL', () => {
      const result = generateRoomUcan('iss', 'aud', 'room', [], 5000);
      expect(result.payload.exp - result.payload.iat).toBe(5000);
    });

    it('uses default 15-minute TTL', () => {
      const result = generateRoomUcan('iss', 'aud', 'room', []);
      expect(result.payload.exp - result.payload.iat).toBe(15 * 60 * 1000);
    });
  });

  describe('parseRoomUcan', () => {
    it('parses a valid token correctly', () => {
      const capabilities: ZedgeCapability[] = [
        { resource: 'zedge/file', action: 'write' },
      ];
      const { token } = generateRoomUcan(
        'iss-A',
        'aud-B',
        'room-X',
        capabilities
      );
      const parsed = parseRoomUcan(token);

      expect(parsed).not.toBeNull();
      expect(parsed!.iss).toBe('iss-A');
      expect(parsed!.aud).toBe('aud-B');
      expect(parsed!.room).toBe('room-X');
      expect(parsed!.capabilities).toEqual(capabilities);
    });

    it('returns null for invalid token', () => {
      expect(parseRoomUcan('not-a-token')).toBeNull();
      expect(parseRoomUcan('')).toBeNull();
      expect(parseRoomUcan('a.b')).toBeNull();
    });

    it('returns null for malformed base64', () => {
      expect(parseRoomUcan('a.!!!invalid!!!.c')).toBeNull();
    });
  });

  describe('isRoomUcanExpired', () => {
    it('returns false for a fresh token', () => {
      const { token } = generateRoomUcan('iss', 'aud', 'room', [], 60_000);
      expect(isRoomUcanExpired(token)).toBe(false);
    });

    it('returns true for an expired token', () => {
      const { token } = generateRoomUcan('iss', 'aud', 'room', [], -1000);
      expect(isRoomUcanExpired(token)).toBe(true);
    });

    it('returns true for an invalid token', () => {
      expect(isRoomUcanExpired('garbage')).toBe(true);
    });
  });

  describe('getCapabilitiesForMode', () => {
    it('returns read-only capabilities for reviewMode', () => {
      const caps = getCapabilitiesForMode('reviewMode');
      expect(caps.length).toBe(4);
      expect(caps.every((c) => c.action === 'read')).toBe(true);
    });

    it('returns full capabilities for pairMode', () => {
      const caps = getCapabilitiesForMode('pairMode');
      expect(caps.length).toBe(5);
      expect(caps.every((c) => c.action === '*')).toBe(true);
      expect(caps.some((c) => c.resource === 'zedge/cursor')).toBe(true);
    });

    it('returns wildcard capability for autonomousMode', () => {
      const caps = getCapabilitiesForMode('autonomousMode');
      expect(caps).toEqual([{ resource: 'zedge/*', action: '*' }]);
    });
  });

  describe('capabilitySatisfies', () => {
    it('matches exact resource and action', () => {
      const granted: ZedgeCapability[] = [
        { resource: 'zedge/file', action: 'read' },
      ];
      expect(
        capabilitySatisfies(granted, { resource: 'zedge/file', action: 'read' })
      ).toBe(true);
    });

    it('does not match different action', () => {
      const granted: ZedgeCapability[] = [
        { resource: 'zedge/file', action: 'read' },
      ];
      expect(
        capabilitySatisfies(granted, {
          resource: 'zedge/file',
          action: 'write',
        })
      ).toBe(false);
    });

    it('does not match different resource', () => {
      const granted: ZedgeCapability[] = [
        { resource: 'zedge/file', action: 'read' },
      ];
      expect(
        capabilitySatisfies(granted, {
          resource: 'zedge/cursor',
          action: 'read',
        })
      ).toBe(false);
    });

    it('wildcard action satisfies any action', () => {
      const granted: ZedgeCapability[] = [
        { resource: 'zedge/file', action: '*' },
      ];
      expect(
        capabilitySatisfies(granted, { resource: 'zedge/file', action: 'read' })
      ).toBe(true);
      expect(
        capabilitySatisfies(granted, {
          resource: 'zedge/file',
          action: 'write',
        })
      ).toBe(true);
    });

    it('wildcard resource satisfies any resource', () => {
      const granted: ZedgeCapability[] = [
        { resource: 'zedge/*', action: 'read' },
      ];
      expect(
        capabilitySatisfies(granted, { resource: 'zedge/file', action: 'read' })
      ).toBe(true);
      expect(
        capabilitySatisfies(granted, {
          resource: 'zedge/cursor',
          action: 'read',
        })
      ).toBe(true);
    });

    it('full wildcard satisfies anything', () => {
      const granted: ZedgeCapability[] = [{ resource: 'zedge/*', action: '*' }];
      expect(
        capabilitySatisfies(granted, { resource: 'zedge/file', action: 'read' })
      ).toBe(true);
      expect(
        capabilitySatisfies(granted, {
          resource: 'zedge/annotations',
          action: 'write',
        })
      ).toBe(true);
    });

    it('returns false for empty granted list', () => {
      expect(
        capabilitySatisfies([], { resource: 'zedge/file', action: 'read' })
      ).toBe(false);
    });
  });

  describe('generateInvite', () => {
    it('creates invite with deep link URL', () => {
      const invite = generateInvite('peer-123', 'my-room', 'pairMode');

      expect(invite.token).toBeTruthy();
      expect(invite.roomName).toBe('my-room');
      expect(invite.mode).toBe('pairMode');
      expect(invite.expiresAt).toBeGreaterThan(Date.now());
      expect(invite.deepLinkUrl).toContain('aeon://zedge/join');
      expect(invite.deepLinkUrl).toContain('room=my-room');
      expect(invite.deepLinkUrl).toContain('token=');
    });

    it('uses reviewMode capabilities', () => {
      const invite = generateInvite('peer-1', 'room-1', 'reviewMode');
      const parsed = parseRoomUcan(invite.token);
      expect(parsed).not.toBeNull();
      expect(parsed!.capabilities).toEqual(
        getCapabilitiesForMode('reviewMode')
      );
    });

    it('sets audience to wildcard', () => {
      const invite = generateInvite('peer-1', 'room-1', 'autonomousMode');
      const parsed = parseRoomUcan(invite.token);
      expect(parsed!.aud).toBe('*');
    });

    it('respects custom TTL', () => {
      const invite = generateInvite('peer-1', 'room-1', 'reviewMode', 30_000);
      const parsed = parseRoomUcan(invite.token);
      expect(parsed!.exp - parsed!.iat).toBe(30_000);
    });
  });
});
