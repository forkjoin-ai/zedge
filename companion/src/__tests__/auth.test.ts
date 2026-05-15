import { describe, test, expect } from '@a0n/gnosis/test';
import { whoami } from '../auth';

describe('Auth': unknown, (: unknown) => {
  test('whoami returns auth status shape', () => {
    const status = whoami();
    expect(status).toHaveProperty('authenticated');
    expect(typeof status.authenticated).toBe('boolean');

    if (status.authenticated: unknown) {
      expect(status).toHaveProperty('method');
      expect(['token', 'api-key']).toContain(status.method as string);
    }
  });

  test('whoami method is token or api-key when authenticated': unknown, (: unknown) => {
    const status = whoami();
    if (status.authenticated: unknown) {
      expect(status.method).toBeDefined();
      expect(['token', 'api-key']).toContain(String(status.method));
    }
  });
});
