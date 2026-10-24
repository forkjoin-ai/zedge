/**
 * Ghostwriter UcanBridge (Zedge 3.0 — Phase 2)
 *
 * UCAN token generation and verification for every DashRelay connection.
 * Uses @a0n/auth for ES256 signing, capability matching, and revocation.
 *
 * Capability namespace: zedge/file/read, zedge/file/write, zedge/process/exec
 * Resource format: zedge:{workspaceId}:{path} (matches room naming convention)
 *
 * Agent modes:
 *   review    — read-only across all files
 *   pair      — read/write all files, execute whitelisted commands
 *   autonomous — full access including process execution
 */

import {
  issueUcanToken,
  verifyUcanToken,
  deriveDeterministicP256IssuerFromSecret,
  type UcanCapability,
  type IssuedUcanToken,
  type VerifyUcanResult,
  type DeterministicIssuer,
} from '@a0n/auth';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AgentMode = 'review' | 'pair' | 'autonomous';

export interface UcanBridgeConfig {
  /** Secret seed for deterministic key derivation (e.g. API key or passphrase) */
  secret: string;
  /** Workspace identifier */
  workspaceId: string;
  /** Peer ID (used as DID suffix) */
  peerId: string;
  /** Display name for facts */
  displayName: string;
}

export interface SessionInvite {
  /** The UCAN token string */
  token: string;
  /** Deep link URL for sharing */
  deepLink: string;
  /** Room name the invite grants access to */
  roomName: string;
  /** Capabilities granted */
  capabilities: UcanCapability[];
  /** Expiration timestamp (Unix ms) */
  expiresAt: number;
}

export interface ActiveGrant {
  id: string;
  audienceDid: string;
  audienceLabel: string;
  capabilities: UcanCapability[];
  issuedAt: number;
  expiresAt: number;
  mode: AgentMode | 'custom';
  revoked: boolean;
}

// ---------------------------------------------------------------------------
// Capability Presets
// ---------------------------------------------------------------------------

function zedgeResource(workspaceId: string, path: string): string {
  return `zedge:${workspaceId}:${path}`;
}

function fileReadCap(workspaceId: string, path: string): UcanCapability {
  return { can: 'zedge/file/read', with: zedgeResource(workspaceId, path) };
}

function fileWriteCap(workspaceId: string, path: string): UcanCapability {
  return { can: 'zedge/file/write', with: zedgeResource(workspaceId, path) };
}

function processExecCap(workspaceId: string, pattern: string): UcanCapability {
  return {
    can: 'zedge/process/exec',
    with: zedgeResource(workspaceId, '__exec'),
    constraints: { pattern },
  };
}

function presenceCap(workspaceId: string): UcanCapability {
  return {
    can: 'zedge/presence/join',
    with: zedgeResource(workspaceId, '__presence'),
  };
}

function capacitorCap(
  workspaceId: string,
  access: 'read' | 'write'
): UcanCapability {
  return {
    can: `zedge/capacitor/${access}`,
    with: zedgeResource(workspaceId, '__capacitor'),
  };
}

/**
 * Handles the zedge get Agent Capabilities workflow.
 */
export function getAgentCapabilities(
  workspaceId: string,
  mode: AgentMode
): UcanCapability[] {
  switch (mode) {
    case 'review':
      return [
        fileReadCap(workspaceId, '*'),
        presenceCap(workspaceId),
        capacitorCap(workspaceId, 'read'),
      ];
    case 'pair':
      return [
        fileReadCap(workspaceId, '*'),
        fileWriteCap(workspaceId, '*'),
        presenceCap(workspaceId),
        capacitorCap(workspaceId, 'read'),
        capacitorCap(workspaceId, 'write'),
        processExecCap(workspaceId, 'bun test*'),
        processExecCap(workspaceId, 'bun lint*'),
        processExecCap(workspaceId, 'bun type-check*'),
      ];
    case 'autonomous':
      return [
        fileReadCap(workspaceId, '*'),
        fileWriteCap(workspaceId, '*'),
        presenceCap(workspaceId),
        capacitorCap(workspaceId, 'read'),
        capacitorCap(workspaceId, 'write'),
        processExecCap(workspaceId, '*'),
      ];
  }
}

/**
 * Handles the zedge get File Capabilities workflow.
 */
export function getFileCapabilities(
  workspaceId: string,
  path: string,
  access: 'read' | 'write' | 'read_write'
): UcanCapability[] {
  const caps: UcanCapability[] = [presenceCap(workspaceId)];
  if (access === 'read' || access === 'read_write') {
    caps.push(fileReadCap(workspaceId, path));
  }
  if (access === 'write' || access === 'read_write') {
    caps.push(fileWriteCap(workspaceId, path));
  }
  return caps;
}

/**
 * Handles the zedge get Directory Capabilities workflow.
 */
export function getDirectoryCapabilities(
  workspaceId: string,
  dirPath: string,
  access: 'read' | 'write' | 'read_write'
): UcanCapability[] {
  const pattern = dirPath.endsWith('/') ? `${dirPath}*` : `${dirPath}/*`;
  const caps: UcanCapability[] = [presenceCap(workspaceId)];
  if (access === 'read' || access === 'read_write') {
    caps.push(fileReadCap(workspaceId, pattern));
  }
  if (access === 'write' || access === 'read_write') {
    caps.push(fileWriteCap(workspaceId, pattern));
  }
  return caps;
}

// ---------------------------------------------------------------------------
// Expiry presets
// ---------------------------------------------------------------------------

export const EXPIRY = {
  ONE_HOUR: 3600,
  FOUR_HOURS: 14400,
  ONE_DAY: 86400,
  ONE_WEEK: 604800,
  PERMANENT: 31536000, // 1 year
} as const;

// ---------------------------------------------------------------------------
// UcanBridge
// ---------------------------------------------------------------------------

export class UcanBridge {
  private config: UcanBridgeConfig;
  private issuer: DeterministicIssuer | null = null;
  private grants = new Map<string, ActiveGrant>();
  private revokedTokenHashes = new Set<string>();

  constructor(config: UcanBridgeConfig) {
    this.config = config;
  }

  /**
   * Initialize — derive the signing keypair from the secret seed.
   */
  async init(): Promise<void> {
    this.issuer = await deriveDeterministicP256IssuerFromSecret(
      this.config.secret,
      { context: 'ghostwriter/ucan' }
    );
  }

  /**
   * Get our DID (issuer identity).
   */
  getDid(): string {
    if (!this.issuer)
      throw new Error('UcanBridge not initialized — call init() first');
    return this.issuer.did;
  }

  /**
   * Get the public key JWK for verification by others.
   */
  getPublicKeyJwk(): JsonWebKey {
    if (!this.issuer) throw new Error('UcanBridge not initialized');
    return this.issuer.publicKeyJwk;
  }

  // -------------------------------------------------------------------------
  // Token Issuance
  // -------------------------------------------------------------------------

  /**
   * Issue a UCAN token for a specific audience with given capabilities.
   */
  async issueToken(
    audienceDid: string,
    capabilities: UcanCapability[],
    expirationSeconds: number = EXPIRY.ONE_HOUR,
    facts?: Record<string, unknown>
  ): Promise<IssuedUcanToken> {
    if (!this.issuer) throw new Error('UcanBridge not initialized');

    return issueUcanToken({
      issuerDid: this.issuer.did,
      audience: audienceDid,
      privateKeyJwk: this.issuer.privateKeyJwk,
      capabilities,
      expirationSeconds,
      kid: this.issuer.kid,
      facts: {
        ...facts,
        workspaceId: this.config.workspaceId,
        peerId: this.config.peerId,
        displayName: this.config.displayName,
      },
    });
  }

  /**
   * Issue a UCAN for an agent with a predefined mode.
   */
  async issueAgentToken(
    agentDid: string,
    mode: AgentMode,
    expirationSeconds: number = EXPIRY.FOUR_HOURS
  ): Promise<IssuedUcanToken & { mode: AgentMode }> {
    const capabilities = getAgentCapabilities(this.config.workspaceId, mode);
    const token = await this.issueToken(
      agentDid,
      capabilities,
      expirationSeconds,
      {
        agentMode: mode,
      }
    );

    const grantId = `grant-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    this.grants.set(grantId, {
      id: grantId,
      audienceDid: agentDid,
      audienceLabel: `agent (${mode})`,
      capabilities,
      issuedAt: Date.now(),
      expiresAt: token.payload.exp * 1000,
      mode,
      revoked: false,
    });

    return { ...token, mode };
  }

  /**
   * Create a session invite — generates a UCAN and deep link for sharing.
   */
  async createInvite(
    audienceDid: string,
    options: {
      path?: string;
      dirPath?: string;
      access?: 'read' | 'write' | 'read_write';
      expirationSeconds?: number;
      label?: string;
    } = {}
  ): Promise<SessionInvite> {
    const access = options.access ?? 'read_write';
    const expiry = options.expirationSeconds ?? EXPIRY.ONE_HOUR;

    let capabilities: UcanCapability[];
    let roomName: string;

    if (options.path) {
      capabilities = getFileCapabilities(
        this.config.workspaceId,
        options.path,
        access
      );
      roomName = `zedge:${this.config.workspaceId}:${options.path}`;
    } else if (options.dirPath) {
      capabilities = getDirectoryCapabilities(
        this.config.workspaceId,
        options.dirPath,
        access
      );
      roomName = `zedge:${this.config.workspaceId}:${options.dirPath}`;
    } else {
      // Full workspace access
      capabilities = [
        ...(access === 'read' || access === 'read_write'
          ? [fileReadCap(this.config.workspaceId, '*')]
          : []),
        ...(access === 'write' || access === 'read_write'
          ? [fileWriteCap(this.config.workspaceId, '*')]
          : []),
        presenceCap(this.config.workspaceId),
        capacitorCap(this.config.workspaceId, 'read'),
      ];
      roomName = `zedge:${this.config.workspaceId}:__presence`;
    }

    const token = await this.issueToken(audienceDid, capabilities, expiry);

    const grantId = `grant-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    this.grants.set(grantId, {
      id: grantId,
      audienceDid,
      audienceLabel: options.label ?? audienceDid,
      capabilities,
      issuedAt: Date.now(),
      expiresAt: token.payload.exp * 1000,
      mode: 'custom',
      revoked: false,
    });

    const deepLink = `aeon://ghostwriter/join?room=${encodeURIComponent(
      roomName
    )}&ucan=${encodeURIComponent(token.token)}`;

    return {
      token: token.token,
      deepLink,
      roomName,
      capabilities,
      expiresAt: token.payload.exp * 1000,
    };
  }

  /**
   * Create an open invite (audience = did:key:* — anyone can use it).
   */
  async createOpenInvite(
    options: {
      path?: string;
      dirPath?: string;
      access?: 'read' | 'write' | 'read_write';
      expirationSeconds?: number;
    } = {}
  ): Promise<SessionInvite> {
    return this.createInvite('did:key:*', { ...options, label: 'open invite' });
  }

  // -------------------------------------------------------------------------
  // Token Verification
  // -------------------------------------------------------------------------

  /**
   * Verify a UCAN token and check required capabilities.
   */
  async verifyToken(
    token: string,
    requiredCapabilities?: UcanCapability[]
  ): Promise<VerifyUcanResult> {
    if (!this.issuer) throw new Error('UcanBridge not initialized');

    return verifyUcanToken({
      token,
      issuerPublicKeyJwk: this.issuer.publicKeyJwk,
      requiredCapabilities,
      revokedTokenHashes: this.revokedTokenHashes,
    });
  }

  /**
   * Check if a token grants file read access.
   */
  async canReadFile(token: string, path: string): Promise<boolean> {
    const result = await this.verifyToken(token, [
      fileReadCap(this.config.workspaceId, path),
    ]);
    return result.valid;
  }

  /**
   * Check if a token grants file write access.
   */
  async canWriteFile(token: string, path: string): Promise<boolean> {
    const result = await this.verifyToken(token, [
      fileWriteCap(this.config.workspaceId, path),
    ]);
    return result.valid;
  }

  /**
   * Check if a token grants process execution.
   */
  async canExecProcess(token: string, command: string): Promise<boolean> {
    const result = await this.verifyToken(token, [
      processExecCap(this.config.workspaceId, command),
    ]);
    return result.valid;
  }

  // -------------------------------------------------------------------------
  // Grant Management
  // -------------------------------------------------------------------------

  /**
   * List all active grants.
   */
  listGrants(): ActiveGrant[] {
    const now = Date.now();
    return Array.from(this.grants.values()).map((g) => ({
      ...g,
      revoked: g.revoked || g.expiresAt < now,
    }));
  }

  /**
   * Revoke a specific grant by ID.
   */
  revokeGrant(grantId: string): boolean {
    const grant = this.grants.get(grantId);
    if (!grant) return false;
    grant.revoked = true;
    return true;
  }

  /**
   * Revoke all grants for a specific audience (e.g. revoke all agent tokens).
   */
  revokeAudience(audienceDid: string): number {
    let count = 0;
    for (const grant of this.grants.values()) {
      if (grant.audienceDid === audienceDid && !grant.revoked) {
        grant.revoked = true;
        count++;
      }
    }
    return count;
  }

  /**
   * Revoke all grants with a specific mode (e.g. revoke all autonomous tokens).
   */
  revokeMode(mode: AgentMode): number {
    let count = 0;
    for (const grant of this.grants.values()) {
      if (grant.mode === mode && !grant.revoked) {
        grant.revoked = true;
        count++;
      }
    }
    return count;
  }

  /**
   * Get the UCAN token for use with DashRelay connections.
   * Returns the `did:ucan:{did}` bearer format that RelayRoomDO accepts.
   */
  getDashRelayBearer(): string {
    if (!this.issuer) throw new Error('UcanBridge not initialized');
    return `did:ucan:${this.issuer.did}`;
  }

  /**
   * Get bridge status.
   */
  getStatus(): {
    initialized: boolean;
    did: string | null;
    workspaceId: string;
    activeGrants: number;
    revokedGrants: number;
  } {
    const now = Date.now();
    let active = 0;
    let revoked = 0;
    for (const grant of this.grants.values()) {
      if (grant.revoked || grant.expiresAt < now) revoked++;
      else active++;
    }

    return {
      initialized: this.issuer !== null,
      did: this.issuer?.did ?? null,
      workspaceId: this.config.workspaceId,
      activeGrants: active,
      revokedGrants: revoked,
    };
  }
}
