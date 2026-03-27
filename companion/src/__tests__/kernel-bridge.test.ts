import { describe, test, expect } from '@a0n/gnosis/test';
import { KernelBridge } from '../kernel-bridge';

describe('KernelBridge', () => {
  test('has builtin commands on init', () => {
    const kernel = new KernelBridge();
    const commands = kernel.listCommands();
    expect(commands.length).toBeGreaterThanOrEqual(4);
    expect(commands.some((c) => c.id === 'aeon:deploy')).toBe(true);
    expect(commands.some((c) => c.id === 'aeon:health')).toBe(true);
  });

  test('executeCommand runs a command', async () => {
    const kernel = new KernelBridge();
    const result = await kernel.executeCommand('aeon:health');
    expect(result).toHaveProperty('uptime');
    expect(result).toHaveProperty('daemons');
  });

  test('executeCommand throws for unknown command', async () => {
    const kernel = new KernelBridge();
    await expect(kernel.executeCommand('nonexistent')).rejects.toThrow(
      'not found'
    );
  });

  test('routeTask returns correct model for bug-fix', () => {
    const kernel = new KernelBridge();
    const route = kernel.routeTask('Fix the null pointer bug', 'bug-fix');
    expect(route.taskType).toBe('bug-fix');
    expect(route.recommendedModel).toBe('qwen-2.5-coder-7b');
    expect(route.confidence).toBeGreaterThan(0.5);
  });

  test('routeTask infers task type from description', () => {
    const kernel = new KernelBridge();
    const route = kernel.routeTask('Please review this code and give feedback');
    expect(route.taskType).toBe('code-review');
    expect(route.recommendedModel).toBeTruthy();
  });

  test('routeTask defaults to chat for unknown descriptions', () => {
    const kernel = new KernelBridge();
    const route = kernel.routeTask('hello there');
    expect(route.taskType).toBe('chat');
  });

  test('registerPlugin adds commands', () => {
    const kernel = new KernelBridge();
    const before = kernel.listCommands().length;

    kernel.registerPlugin({
      id: 'test-plugin',
      name: 'Test',
      version: '1.0',
      capabilities: ['test'],
      commands: [
        {
          id: 'test:cmd',
          label: 'Test',
          description: 'A test command',
          execute: async () => 'ok',
        },
      ],
    });

    expect(kernel.listCommands().length).toBe(before + 1);
    expect(kernel.getPlugins().length).toBe(1);
  });

  test('getDaemonStatus returns all daemons', () => {
    const kernel = new KernelBridge();
    const daemons = kernel.getDaemonStatus();
    expect(daemons.length).toBe(4);
    expect(daemons.every((d) => d.status === 'stopped')).toBe(true);
  });

  test('parseDeepLink handles aeon:// protocol', () => {
    const kernel = new KernelBridge();
    const link = kernel.parseDeepLink(
      'aeon://zedge/open?file=src/app.ts&line=42'
    );
    expect(link).not.toBeNull();
    expect(link!.action).toBe('open');
    expect(link!.params.file).toBe('src/app.ts');
    expect(link!.params.line).toBe('42');
  });

  test('parseDeepLink returns null for non-aeon URLs', () => {
    const kernel = new KernelBridge();
    expect(kernel.parseDeepLink('https://example.com')).toBeNull();
  });

  test('flight recorder logs events', async () => {
    const kernel = new KernelBridge();
    await kernel.executeCommand('aeon:health');

    const log = kernel.getFlightLog();
    expect(log.length).toBeGreaterThan(0);
    expect(log.some((e) => e.event === 'command-executed')).toBe(true);
  });
});
