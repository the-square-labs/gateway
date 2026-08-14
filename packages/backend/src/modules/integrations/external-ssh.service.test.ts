import { describe, expect, it, vi } from 'vitest';
import { ExternalSshService } from './external-ssh.service.js';

function serviceWithNodes(nodeRows: unknown[] = []) {
  const db = {
    select: vi.fn(() => ({ from: vi.fn().mockResolvedValue(nodeRows) })),
  };
  const crypto = {
    encryptString: vi.fn((value: string) => ({ ciphertext: `encrypted:${value}` })),
    decryptString: vi.fn(),
  };
  return { service: new ExternalSshService(db as never, crypto as never), db, crypto };
}

describe('ExternalSshService target safety', () => {
  it('rejects a managed node after hostname resolution', async () => {
    const { service } = serviceWithNodes([
      {
        hostname: 'managed-node',
        report: { localIpAddresses: ['10.20.0.8'], publicIpAddresses: [] },
      },
    ]);
    vi.spyOn(
      service as unknown as { resolveHostAddresses(host: string): Promise<string[]> },
      'resolveHostAddresses'
    ).mockResolvedValue(['10.20.0.8']);

    await expect((service as never as { assertExternalTarget(host: string): Promise<string> }).assertExternalTarget('alias.internal'))
      .rejects.toMatchObject({ code: 'SSH_MANAGED_TARGET_BLOCKED' });
  });

  it('rejects a local Docker container address', async () => {
    const { service } = serviceWithNodes();
    vi.spyOn(
      service as unknown as { resolveHostAddresses(host: string): Promise<string[]> },
      'resolveHostAddresses'
    ).mockResolvedValue(['172.19.0.4']);
    service.setDockerService({
      listLocalContainers: vi.fn().mockResolvedValue([
        {
          Id: 'container-1',
          Names: ['/worker'],
          NetworkSettings: { Networks: { gateway: { IPAddress: '172.19.0.4' } } },
        },
      ]),
    } as never);

    await expect((service as never as { assertExternalTarget(host: string): Promise<string> }).assertExternalTarget('worker.internal'))
      .rejects.toMatchObject({ code: 'SSH_CONTAINER_TARGET_BLOCKED' });
  });

  it('allows an unrelated private address', async () => {
    const { service } = serviceWithNodes();
    vi.spyOn(
      service as unknown as { resolveHostAddresses(host: string): Promise<string[]> },
      'resolveHostAddresses'
    ).mockResolvedValue(['10.40.0.9']);
    service.setDockerService({ listLocalContainers: vi.fn().mockResolvedValue([]) } as never);

    await expect(
      (service as never as { assertExternalTarget(host: string): Promise<string> }).assertExternalTarget('remote.internal')
    ).resolves.toBe('10.40.0.9');
  });
});

describe('ExternalSshService generated keys', () => {
  it('encrypts generated private material and returns only the public key', async () => {
    let inserted: Record<string, unknown> | null = null;
    const db = {
      insert: vi.fn(() => ({
        values: vi.fn((values: Record<string, unknown>) => {
          inserted = values;
          return {
            returning: vi.fn().mockResolvedValue([
              {
                id: 'ssh-1',
                ...values,
                createdAt: new Date(),
                updatedAt: new Date(),
              },
            ]),
          };
        }),
      })),
    };
    const crypto = {
      encryptString: vi.fn(() => ({ iv: 'iv', tag: 'tag', ciphertext: 'ciphertext' })),
      decryptString: vi.fn(),
    };
    const service = new ExternalSshService(db as never, crypto as never);
    vi.spyOn(
      service as unknown as { assertExternalTarget(host: string): Promise<string> },
      'assertExternalTarget'
    ).mockResolvedValue('10.40.0.9');

    const result = await service.create(
      { id: 'user-1', scopes: ['integrations:ssh:manage'] } as never,
      {
        name: 'Remote',
        host: '10.40.0.9',
        username: 'deploy',
        authMethod: 'private_key',
        generatePrivateKey: true,
        hostFingerprint: 'SHA256:test',
      }
    );

    expect(crypto.encryptString).toHaveBeenCalledWith(expect.stringContaining('BEGIN PRIVATE KEY'));
    expect(inserted).toMatchObject({ encryptedSecret: expect.stringContaining('ciphertext') });
    expect(result.generatedPublicKey).toMatch(/^ssh-ed25519 /);
    expect(result.connector).not.toHaveProperty('encryptedSecret');
  });
});
