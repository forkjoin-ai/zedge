import { describe, test, expect } from 'bun:test';

describe('Agent Breeding (METACOG c0-c3)', () => {
  test('getStatus returns valid shape when idle', async () => {
    const { agentBreeding } = await import('../agent-breeding');
    const status = agentBreeding.getStatus();

    expect(status).toHaveProperty('active');
    expect(status).toHaveProperty('totalCycles');
    expect(status).toHaveProperty('lastCycle');
    expect(status).toHaveProperty('constitutionalBlocks');
    expect(status).toHaveProperty('agentsEvolved');
    expect(status.active).toBe(false);
  });

  test('runCycle completes a full c0-c3 cycle', async () => {
    const { agentBreeding } = await import('../agent-breeding');
    const cycle = await agentBreeding.runCycle();

    expect(cycle).toHaveProperty('id');
    expect(cycle).toHaveProperty('phase');
    expect(cycle).toHaveProperty('agentsAssessed');
    expect(cycle).toHaveProperty('candidates');
    expect(cycle).toHaveProperty('durationMs');
    expect(cycle.durationMs).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(cycle.agentsAssessed)).toBe(true);
    expect(Array.isArray(cycle.candidates)).toBe(true);
  });

  test('status updates after cycle', async () => {
    const { agentBreeding } = await import('../agent-breeding');
    const status = agentBreeding.getStatus();
    expect(status.totalCycles).toBeGreaterThanOrEqual(1);
    expect(status.lastCycle).not.toBeNull();
  });

  test('createBreedingStream returns ReadableStream', async () => {
    const { createBreedingStream } = await import('../agent-breeding');
    const stream = createBreedingStream();
    expect(stream).toBeInstanceOf(ReadableStream);
  });
});
