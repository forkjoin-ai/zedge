/**
 * Teams Manager
 *
 * Manages team membership and scoped mesh/CRDT workspaces. A team is identified by
 * a teamId which simultaneously is:
 * - The skymesh meshId (developers share a relay room)
 * - The CRDT workspaceId (developers see each other's cursors, share void-sync)
 *
 * Team membership is persisted to ~/.edgework/team.json.
 */

import { homedir } from 'os';
import { join } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { startSkymeshBridge, stopSkymeshBridge, getSkymeshBridgeStatus } from './skymesh-bridge.ts';
import { generateInvite, parseRoomUcan } from './ucan-scope.ts';

// --- Config ---

const CONFIG_DIR = join(homedir(), '.edgework');
const TEAM_FILE = join(CONFIG_DIR, 'team.json');

// --- Types ---

export interface Team {
  id: string;
  name: string;
  role: 'host' | 'member';
  joinedAt: number;
}

export interface TeamStatus {
  team: Team | null;
  bridgeStatus: { running: boolean; meshId?: string; admitted: boolean };
  memberCount: number;
  sharedCacheHits: number;
  lanPeers: number;
}

// --- Manager State ---

let currentTeam: Team | null = null;
let crdt: { workspaceId: string } | null = null;

// --- Initialization ---

function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

function loadTeam(): Team | null {
  try {
    if (!existsSync(TEAM_FILE)) {
      return null;
    }
    const data = JSON.parse(readFileSync(TEAM_FILE, 'utf-8')) as Team;
    return data;
  } catch {
    return null;
  }
}

function saveTeam(team: Team | null): void {
  ensureConfigDir();
  if (team === null) {
    try {
      if (existsSync(TEAM_FILE)) {
        // Don't delete, just clear by writing null
      }
    } catch {
      // ignore
    }
    return;
  }
  writeFileSync(TEAM_FILE, JSON.stringify(team, null, 2), { mode: 0o600 });
}

// Initialize on module load
currentTeam = loadTeam();
if (currentTeam) {
  crdt = { workspaceId: currentTeam.id };
  // Auto-rejoin on startup
  startSkymeshBridge({ meshId: currentTeam.id });
}

// --- Public API ---

export function createTeam(name: string): { team: Team; inviteDeepLink: string } {
  // Slugify name to teamId
  const teamId = name
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');

  if (!teamId) {
    throw new Error('Team name must contain at least one letter');
  }

  const team: Team = {
    id: teamId,
    name,
    role: 'host',
    joinedAt: Date.now(),
  };

  currentTeam = team;
  crdt = { workspaceId: team.id };
  saveTeam(team);

  startSkymeshBridge({
    meshId: team.id,
    models: [], // Will be set by caller or auto-detected
  });

  const inviteDeepLink = generateDeepLink(team, null);

  return { team, inviteDeepLink };
}

export function joinTeam(teamId: string, token?: string): Team {
  // Optional: verify token
  if (token) {
    try {
      parseRoomUcan(token);
    } catch {
      throw new Error('Invalid invite token');
    }
  }

  const team: Team = {
    id: teamId,
    name: teamId, // Will be updated if we knew it, but teamId is authoritative
    role: 'member',
    joinedAt: Date.now(),
  };

  currentTeam = team;
  crdt = { workspaceId: team.id };
  saveTeam(team);

  startSkymeshBridge({
    meshId: team.id,
    models: [],
  });

  return team;
}

export function leaveTeam(): void {
  currentTeam = null;
  crdt = null;
  saveTeam(null);
  stopSkymeshBridge();
}

export function inviteToTeam(): { deepLink: string; token: string; expiresAt: number } {
  if (!currentTeam) {
    throw new Error('Not in a team');
  }

  const deepLink = generateDeepLink(currentTeam, null);
  const { token, expiresAt } = parseDeepLink(deepLink);

  return { deepLink, token, expiresAt };
}

export function getTeamStatus(): TeamStatus {
  const bridgeStatus = getSkymeshBridgeStatus();

  return {
    team: currentTeam,
    bridgeStatus: {
      running: bridgeStatus.running,
      meshId: bridgeStatus.meshId,
      admitted: bridgeStatus.admitted,
    },
    memberCount: bridgeStatus.running ? 1 : 0, // Would be queried from relay in real impl
    sharedCacheHits: 0, // Would be tracked by bridge
    lanPeers: bridgeStatus.lanPeers,
  };
}

export function getCurrentTeam(): Team | null {
  return currentTeam;
}

export function getCurrentWorkspaceId(): string {
  return crdt?.workspaceId ?? 'default';
}

// --- Deep Link Helpers ---

function generateDeepLink(team: Team, token: string | null): string {
  const t = token ?? generateInvite(team.id).token;
  const baseUrl = 'zedge://join-team';
  const params = new URLSearchParams({
    id: team.id,
    token: t,
    relay: 'https://skymesh.forkjoin.ai',
  });
  return `${baseUrl}?${params.toString()}`;
}

function parseDeepLink(
  deepLink: string,
): { token: string; expiresAt: number } {
  const url = new URL(deepLink.replace('zedge://', 'http://'));
  const token = url.searchParams.get('token') ?? '';
  // Default to 1 hour from now
  const expiresAt = Date.now() + 3600 * 1000;
  return { token, expiresAt };
}

// --- Singleton Getter ---

export function getTeamsManager() {
  return {
    createTeam,
    joinTeam,
    leaveTeam,
    inviteToTeam,
    getTeamStatus,
    getCurrentTeam,
    getCurrentWorkspaceId,
  };
}
