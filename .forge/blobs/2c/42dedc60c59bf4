/**
 * UCAN Scoping for Zedge Ghostwriter
 *
 * Generates room-scoped capability tokens for collaborative sessions.
 * Pure JS implementation — no external UCAN packages needed.
 */

export interface ZedgeCapability {
  resource: string;
  action: 'read' | 'write' | '*';
}

export type ZedgeAccessMode = 'reviewMode' | 'pairMode' | 'autonomousMode';

const MODE_CAPABILITIES: Record<ZedgeAccessMode, ZedgeCapability[]> = {
  reviewMode: [
    { resource: 'zedge/file', action: 'read' },
    { resource: 'zedge/presence', action: 'read' },
    { resource: 'zedge/diagnostics', action: 'read' },
    { resource: 'zedge/annotations', action: 'read' },
  ],
  pairMode: [
    { resource: 'zedge/file', action: '*' },
    { resource: 'zedge/presence', action: '*' },
    { resource: 'zedge/diagnostics', action: '*' },
    { resource: 'zedge/annotations', action: '*' },
    { resource: 'zedge/cursor', action: '*' },
  ],
  autonomousMode: [{ resource: 'zedge/*', action: '*' }],
};

export interface RoomUcanPayload {
  iss: string;
  aud: string;
  room: string;
  capabilities: ZedgeCapability[];
  exp: number;
  iat: number;
  nonce: string;
}

export interface RoomUcanToken {
  token: string;
  payload: RoomUcanPayload;
}

export interface InviteToken {
  token: string;
  roomName: string;
  mode: ZedgeAccessMode;
  expiresAt: number;
  deepLinkUrl: string;
}

function base64UrlEncode(data: string): string {
  return btoa(data).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(data: string): string {
  const padded = data.replace(/-/g, '+').replace(/_/g, '/');
  return atob(padded);
}

/**
 * Generate a room-scoped UCAN token.
 * This is a simplified JWT-like token for room authorization.
 */
export function generateRoomUcan(
  issuer: string,
  audience: string,
  roomName: string,
  capabilities: ZedgeCapability[],
  ttlMs: number = 15 * 60 * 1000
): RoomUcanToken {
  const now = Date.now();
  const payload: RoomUcanPayload = {
    iss: issuer,
    aud: audience,
    room: roomName,
    capabilities,
    exp: now + ttlMs,
    iat: now,
    nonce: crypto.randomUUID(),
  };

  const header = base64UrlEncode(
    JSON.stringify({ alg: 'none', typ: 'JWT', ucv: '0.10.0' })
  );
  const body = base64UrlEncode(JSON.stringify(payload));
  const token = `${header}.${body}.unsigned`;

  return { token, payload };
}

/**
 * Parse a room UCAN token (no signature verification — local companion only).
 */
export function parseRoomUcan(token: string): RoomUcanPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(base64UrlDecode(parts[1]!));
    return payload as RoomUcanPayload;
  } catch {
    return null;
  }
}

/**
 * Check if a token is expired.
 */
export function isRoomUcanExpired(token: string): boolean {
  const payload = parseRoomUcan(token);
  if (!payload) return true;
  return Date.now() > payload.exp;
}

/**
 * Get capabilities for a preset access mode.
 */
export function getCapabilitiesForMode(
  mode: ZedgeAccessMode
): ZedgeCapability[] {
  return MODE_CAPABILITIES[mode];
}

/**
 * Check if a set of capabilities satisfies a required capability.
 */
export function capabilitySatisfies(
  granted: ZedgeCapability[],
  required: ZedgeCapability
): boolean {
  return granted.some((g) => {
    const resourceMatch =
      g.resource === required.resource || g.resource === 'zedge/*';
    const actionMatch = g.action === required.action || g.action === '*';
    return resourceMatch && actionMatch;
  });
}

/**
 * Generate an invite token with a deep link URL.
 */
export function generateInvite(
  issuer: string,
  roomName: string,
  mode: ZedgeAccessMode,
  ttlMs: number = 15 * 60 * 1000
): InviteToken {
  const capabilities = getCapabilitiesForMode(mode);
  const { token, payload } = generateRoomUcan(
    issuer,
    '*',
    roomName,
    capabilities,
    ttlMs
  );
  const deepLinkUrl = `aeon://zedge/join?token=${encodeURIComponent(
    token
  )}&room=${encodeURIComponent(roomName)}`;

  return {
    token,
    roomName,
    mode,
    expiresAt: payload.exp,
    deepLinkUrl,
  };
}
