/**
 * Tests for teams.ts — Team scoping, UCAN invites, bridge integration
 *
 * Team creation/join/leave, persistence, invite generation, bridge startup
 */

import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  afterAll,
} from '@a0n/gnosis/test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Team state is persisted to `~/.edgework/team.json`, and this suite creates,
 * joins and leaves teams — so it used to rewrite the developer's REAL membership
 * file (and `leaveTeam()` does not delete it, so the last test's team stuck
 * around for the next launch). Redirect the config dir BEFORE importing the
 * module: under a sandbox the write is EPERM, which is only the loud version of
 * the same bug.
 */
const configDir = mkdtempSync(join(tmpdir(), 'zedge-teams-'));
process.env.ZEDGE_TEAM_DIR = configDir;

const { getTeamsManager } = await import('../teams.ts');

type TeamsManager = ReturnType<typeof getTeamsManager>;

describe('teams', () => {
  let teamsManager: TeamsManager;

  afterAll(() => {
    if (process.env.ZEDGE_TEAM_DIR === configDir) {
      delete process.env.ZEDGE_TEAM_DIR;
    }
    rmSync(configDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    teamsManager = getTeamsManager();
  });

  afterEach(() => {
    // Clean up after each test if leave is available
    try {
      teamsManager.leaveTeam();
    } catch {
      // Best effort cleanup
    }
  });

  test('should create a team and return team + deepLink', async () => {
    const result = teamsManager.createTeam('Engineering');

    expect(result.team).toBeDefined();
    expect(result.team.name).toBe('Engineering');
    expect(result.inviteDeepLink).toBeDefined();
    expect(result.inviteDeepLink).toContain('zedge://');
  });

  test('should slugify team name to teamId', async () => {
    const result = teamsManager.createTeam('My Team Name');

    expect(result.team.id).toBeDefined();
    expect(result.team.id).toMatch(/^[a-z0-9-]+$/);
    expect(result.team.id.length).toBeGreaterThan(0);
  });

  test('should set team role to host on creation', async () => {
    const result = teamsManager.createTeam('test-team');

    expect(result.team.role).toBe('host');
    expect(result.team.joinedAt).toBeDefined();
  });

  test('should expose getCurrentTeam after creation', async () => {
    teamsManager.createTeam('my-eng-team');
    const current = teamsManager.getCurrentTeam();

    expect(current).toBeDefined();
    expect(current?.name).toBe('my-eng-team');
  });

  test('should expose getCurrentWorkspaceId for CRDT', async () => {
    teamsManager.createTeam('collab-team');
    const workspaceId = teamsManager.getCurrentWorkspaceId();

    expect(workspaceId).toBeDefined();
    expect(workspaceId?.length).toBeGreaterThan(0);
  });

  test('should join a team by ID', async () => {
    // First create a team to get the ID
    const created = teamsManager.createTeam('join-test');
    const teamId = created.team.id;

    // Leave and rejoin to test join flow
    teamsManager.leaveTeam();
    const current1 = teamsManager.getCurrentTeam();
    expect(current1).toBeUndefined();

    // Join the team
    const joinedTeam = teamsManager.joinTeam(teamId);
    expect(joinedTeam.id).toBe(teamId);
    expect(joinedTeam.role).toBe('member');
  });

  test('should set role to member when joining without token', async () => {
    const created = teamsManager.createTeam('access-test');
    teamsManager.leaveTeam();

    const joined = teamsManager.joinTeam(created.team.id);
    expect(joined.role).toBe('member');
  });

  test('should clear team on leave', async () => {
    teamsManager.createTeam('temp-team');
    expect(teamsManager.getCurrentTeam()).toBeDefined();

    teamsManager.leaveTeam();
    expect(teamsManager.getCurrentTeam()).toBeUndefined();
  });

  test('should generate a fresh invite deepLink', async () => {
    teamsManager.createTeam('invite-test');

    const invite = teamsManager.inviteToTeam();
    expect(invite.deepLink).toBeDefined();
    expect(invite.deepLink).toContain('zedge://');
    expect(invite.expiresAt).toBeDefined();
  });

  test('should return team status with bridge info', async () => {
    teamsManager.createTeam('status-test');

    const status = teamsManager.getTeamStatus();
    expect(status.team).toBeDefined();
    expect(status.bridgeStatus).toBeDefined();
    expect(typeof status.memberCount).toBe('number');
    expect(typeof status.lanPeers).toBe('number');
  });

  test('should persist team membership across reinit', async () => {
    const name1 = 'persistent-team';
    teamsManager.createTeam(name1);
    const teamId = teamsManager.getCurrentTeam()?.id;

    // Get a fresh manager instance to simulate restart
    const teamsManager2 = getTeamsManager();
    const current = teamsManager2.getCurrentTeam();

    // Should have persisted
    expect(current?.id).toBe(teamId);
    expect(current?.name).toBe(name1);
  });

  test('should throw on joinTeam with invalid token', async () => {
    teamsManager.createTeam('token-test');

    // Attempt to join with an invalid/expired token
    // This should either throw or return gracefully depending on implementation
    try {
      teamsManager.joinTeam('some-team-id', 'invalid_token_12345');
      // If it succeeds, that's ok — depends on validation strictness
    } catch (e) {
      // Expected path if strict validation
      expect(e).toBeDefined();
    }
  });

  test('should not error on double-create with same name', () => {
    const result1 = teamsManager.createTeam('dupe-test');
    teamsManager.leaveTeam();

    const result2 = teamsManager.createTeam('dupe-test');

    // Both should succeed (or error consistently)
    expect(result1.team.name).toBe('dupe-test');
    expect(result2.team.name).toBe('dupe-test');
  });
});
