import { describe, test, expect } from 'bun:test';

describe('Agent Roles', () => {
  test('listRoles returns all built-in roles', async () => {
    const { listRoles, getRole } = await import('../agent-roles');

    const roles = listRoles();
    expect(roles.length).toBeGreaterThanOrEqual(5);
    expect(roles).toContain('reviewer');
    expect(roles).toContain('refactorer');
    expect(roles).toContain('tester');
    expect(roles).toContain('documenter');
    expect(roles).toContain('security-auditor');
  });

  test('getRole returns valid role with all fields', async () => {
    const { getRole } = await import('../agent-roles');

    const reviewer = getRole('reviewer');
    expect(reviewer).not.toBeNull();
    expect(reviewer!.id).toBe('reviewer');
    expect(reviewer!.displayName).toBe('Code Reviewer');
    expect(reviewer!.mode).toBe('review');
    expect(reviewer!.strategy).toBe('constructive');
    expect(reviewer!.color).toBeTruthy();
    expect(reviewer!.systemPrompt.length).toBeGreaterThan(0);
  });

  test('getRole returns null for unknown role', async () => {
    const { getRole } = await import('../agent-roles');
    expect(getRole('nonexistent')).toBeNull();
  });

  test('reviewer is read-only, refactorer is pair mode', async () => {
    const { getRole } = await import('../agent-roles');

    expect(getRole('reviewer')!.mode).toBe('review');
    expect(getRole('refactorer')!.mode).toBe('pair');
    expect(getRole('tester')!.mode).toBe('pair');
    expect(getRole('security-auditor')!.mode).toBe('review');
  });

  test('each role has a distinct color', async () => {
    const { AGENT_ROLES } = await import('../agent-roles');

    const colors = Object.values(AGENT_ROLES).map((r) => r.color);
    const unique = new Set(colors);
    expect(unique.size).toBe(colors.length);
  });

  test('tester role has file pattern restriction', async () => {
    const { getRole } = await import('../agent-roles');

    const tester = getRole('tester');
    expect(tester!.filePattern).toBe('**/*.test.*');

    const reviewer = getRole('reviewer');
    expect(reviewer!.filePattern).toBeNull();
  });
});

describe('Agent Swarm', () => {
  test('AgentSwarm.listRoles returns available roles', async () => {
    const { AgentSwarm } = await import('../agent-swarm');
    const roles = AgentSwarm.listRoles();
    expect(roles.length).toBeGreaterThanOrEqual(5);
  });

  test('SwarmStatus shape is valid when not active', async () => {
    const { AgentSwarm } = await import('../agent-swarm');

    // Create with mock bridges
    const mockCrdtBridge = {} as any;
    const swarm = new AgentSwarm(mockCrdtBridge);

    expect(swarm.isActive).toBe(false);

    const status = swarm.getStatus();
    expect(status.active).toBe(false);
    expect(status.task).toBe('');
    expect(Array.isArray(status.agents)).toBe(true);
    expect(status.agents.length).toBe(0);
  });
});
