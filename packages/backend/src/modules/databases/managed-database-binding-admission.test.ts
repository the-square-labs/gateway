import { describe, expect, it, vi } from 'vitest';
import { ManagedDatabaseBindingAdmission } from './managed-database-binding-admission.js';

function admission(secretKeys: string[] = []) {
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })),
    })),
  };
  const dockerManagement = {
    inspectContainer: vi.fn().mockResolvedValue({
      Name: '/orders-api',
      Config: { Env: ['KEEP=value', 'DATABASE_URL=legacy'] },
    }),
  };
  const dockerDeployments = { get: vi.fn() };
  const dockerSecrets = { getSecretKeys: vi.fn().mockResolvedValue(new Set(secretKeys)) };
  return new ManagedDatabaseBindingAdmission(
    db as never,
    dockerManagement as never,
    dockerDeployments as never,
    dockerSecrets as never
  );
}

describe('ManagedDatabaseBindingAdmission effective Environment checks', () => {
  it('allows a final ordinary draft that removes the variable claimed by the new secure link', async () => {
    const subject = admission();

    await expect(
      subject.assertEnvironmentNamesAvailable(
        'node-1',
        'container',
        'orders-api',
        { connectionUri: 'DATABASE_URL' },
        false,
        { KEEP: 'value' }
      )
    ).resolves.toBeUndefined();
  });

  it('keeps final-draft and Docker-secret collisions blocked', async () => {
    await expect(
      admission().assertEnvironmentNamesAvailable(
        'node-1',
        'container',
        'orders-api',
        { connectionUri: 'DATABASE_URL' },
        false,
        { KEEP: 'value', DATABASE_URL: 'legacy' }
      )
    ).rejects.toMatchObject({ code: 'MANAGED_DATABASE_BINDING_ENV_CONFLICT' });

    await expect(
      admission(['DATABASE_URL']).assertEnvironmentNamesAvailable(
        'node-1',
        'container',
        'orders-api',
        { connectionUri: 'DATABASE_URL' },
        false,
        { KEEP: 'value' }
      )
    ).rejects.toMatchObject({ code: 'MANAGED_DATABASE_BINDING_ENV_CONFLICT' });
  });
});
