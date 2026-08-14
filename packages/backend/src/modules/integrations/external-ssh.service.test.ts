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

    await expect(
      (service as never as { assertExternalTarget(host: string): Promise<string> }).assertExternalTarget(
        'alias.internal'
      )
    ).rejects.toMatchObject({ code: 'SSH_MANAGED_TARGET_BLOCKED' });
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

    await expect(
      (service as never as { assertExternalTarget(host: string): Promise<string> }).assertExternalTarget(
        'worker.internal'
      )
    ).rejects.toMatchObject({ code: 'SSH_CONTAINER_TARGET_BLOCKED' });
  });

  it('allows an unrelated private address', async () => {
    const { service } = serviceWithNodes();
    vi.spyOn(
      service as unknown as { resolveHostAddresses(host: string): Promise<string[]> },
      'resolveHostAddresses'
    ).mockResolvedValue(['10.40.0.9']);
    service.setDockerService({ listLocalContainers: vi.fn().mockResolvedValue([]) } as never);

    await expect(
      (service as never as { assertExternalTarget(host: string): Promise<string> }).assertExternalTarget(
        'remote.internal'
      )
    ).resolves.toBe('10.40.0.9');
  });
});

describe('ExternalSshService host key discovery', () => {
  it('reads the target fingerprint without requiring a login credential', async () => {
    const { service } = serviceWithNodes();
    vi.spyOn(
      service as unknown as { assertExternalTarget(host: string): Promise<string> },
      'assertExternalTarget'
    ).mockResolvedValue('10.40.0.9');
    vi.spyOn(
      service as unknown as {
        readHostFingerprint(host: string, port: number): Promise<string>;
      },
      'readHostFingerprint'
    ).mockResolvedValue('SHA256:discovered');

    await expect(
      service.discoverHostKey({ id: 'user-1', scopes: ['integrations:ssh:manage'] } as never, {
        host: 'remote.example.com',
        port: 2222,
      })
    ).resolves.toEqual({
      host: 'remote.example.com',
      port: 2222,
      hostFingerprint: 'SHA256:discovered',
    });
  });

  it('stops a host-key probe when its request is already cancelled', async () => {
    const { service } = serviceWithNodes();
    const controller = new AbortController();
    controller.abort();

    await expect(
      (
        service as unknown as {
          readHostFingerprint(host: string, port: number, sock: undefined, signal: AbortSignal): Promise<string>;
        }
      ).readHostFingerprint('10.40.0.9', 22, undefined, controller.signal)
    ).rejects.toMatchObject({ code: 'SSH_OPERATION_CANCELLED' });
  });

  it.each([
    {
      error: Object.assign(new Error('All configured authentication methods failed'), {
        level: 'client-authentication',
      }),
      code: 'SSH_JUMP_AUTHENTICATION_FAILED',
      message: 'generated public key is installed',
    },
    {
      error: new Error('Cannot parse privateKey: Unsupported key format'),
      code: 'SSH_JUMP_CREDENTIAL_INVALID',
      message: 'incompatible private key',
    },
  ])('returns an actionable jump error for $code', async ({ error, code, message }) => {
    const jump = {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Jump',
      host: 'jump.example.com',
      port: 22,
      username: 'deploy',
      authMethod: 'private_key',
      encryptedSecret: JSON.stringify({ ciphertext: 'jump-key' }),
      encryptedPassphrase: null,
      hostFingerprint: 'SHA256:jump',
      jumpConnectorId: null,
      enabled: true,
      createdBy: 'user-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([jump]) })),
        })),
      })),
    };
    const crypto = {
      decryptString: vi.fn().mockReturnValue('PRIVATE JUMP KEY'),
    };
    const service = new ExternalSshService(db as never, crypto as never);
    vi.spyOn(
      service as unknown as { assertExternalTarget(host: string): Promise<string> },
      'assertExternalTarget'
    ).mockResolvedValue('10.40.0.9');
    vi.spyOn(service as unknown as { connect(): Promise<never> }, 'connect').mockRejectedValue(error);

    await expect(
      service.discoverHostKey({ id: 'user-1', scopes: ['integrations:ssh:manage'] } as never, {
        host: 'target.example.com',
        jumpConnectorId: jump.id,
      })
    ).rejects.toMatchObject({ code, message: expect.stringContaining(message) });
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
    const eventBus = { publish: vi.fn() };
    service.setEventBus(eventBus as never);
    vi.spyOn(
      service as unknown as { assertExternalTarget(host: string): Promise<string> },
      'assertExternalTarget'
    ).mockResolvedValue('10.40.0.9');

    const result = await service.create({ id: 'user-1', scopes: ['integrations:ssh:manage'] } as never, {
      name: 'Remote',
      host: '10.40.0.9',
      username: 'deploy',
      authMethod: 'private_key',
      generatePrivateKey: true,
      hostFingerprint: 'SHA256:test',
    });

    expect(crypto.encryptString).toHaveBeenCalledWith(expect.stringContaining('BEGIN OPENSSH PRIVATE KEY'));
    expect(inserted).toMatchObject({ encryptedSecret: expect.stringContaining('ciphertext') });
    expect(result.generatedPublicKey).toMatch(/^ssh-ed25519 /);
    expect(result.connector).not.toHaveProperty('encryptedSecret');
    expect(eventBus.publish).toHaveBeenCalledWith('integration.connector.changed', {
      id: 'ssh-1',
      provider: 'ssh',
      action: 'created',
      name: 'Remote',
    });
  });

  it('rejects imported private key material', async () => {
    const { service } = serviceWithNodes();
    vi.spyOn(
      service as unknown as { assertExternalTarget(host: string): Promise<string> },
      'assertExternalTarget'
    ).mockResolvedValue('10.40.0.9');

    await expect(
      service.create({ id: 'user-1', scopes: ['integrations:ssh:manage'] } as never, {
        name: 'Remote',
        host: '10.40.0.9',
        username: 'deploy',
        authMethod: 'private_key',
        secret: '-----BEGIN OPENSSH PRIVATE KEY-----',
        hostFingerprint: 'SHA256:test',
      })
    ).rejects.toMatchObject({ code: 'SSH_PRIVATE_KEY_IMPORT_DISABLED' });
  });

  it('reuses an enabled generated jump key without exposing it to the client', async () => {
    let inserted: Record<string, unknown> | null = null;
    const source = {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Jump',
      host: 'jump.example.com',
      port: 22,
      username: 'deploy',
      authMethod: 'private_key',
      encryptedSecret: JSON.stringify({ ciphertext: 'jump-key' }),
      encryptedPassphrase: null,
      hostFingerprint: 'SHA256:jump',
      jumpConnectorId: null,
      enabled: true,
      createdBy: 'user-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([source]) })),
        })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn((values: Record<string, unknown>) => {
          inserted = values;
          return {
            returning: vi
              .fn()
              .mockResolvedValue([{ id: 'target-1', ...values, createdAt: new Date(), updatedAt: new Date() }]),
          };
        }),
      })),
    };
    const crypto = {
      decryptString: vi.fn().mockReturnValue('PRIVATE JUMP KEY'),
      encryptString: vi.fn().mockReturnValue({ ciphertext: 'copied-key' }),
    };
    const service = new ExternalSshService(db as never, crypto as never);
    vi.spyOn(
      service as unknown as { assertExternalTarget(host: string): Promise<string> },
      'assertExternalTarget'
    ).mockResolvedValue('10.40.0.10');

    const result = await service.create({ id: 'user-1', scopes: ['integrations:ssh:manage'] } as never, {
      name: 'Target',
      host: 'target.example.com',
      username: 'deploy',
      authMethod: 'private_key',
      hostFingerprint: 'SHA256:target',
      jumpConnectorId: source.id,
      reuseCredentialFromConnectorId: source.id,
    });

    expect(crypto.decryptString).toHaveBeenCalledWith({ ciphertext: 'jump-key' });
    expect(crypto.encryptString).toHaveBeenCalledWith('PRIVATE JUMP KEY');
    expect(inserted).toMatchObject({ authMethod: 'private_key', encryptedSecret: '{"ciphertext":"copied-key"}' });
    expect(result.generatedPublicKey).toBeNull();
    expect(result.connector).not.toHaveProperty('encryptedSecret');
  });
});
