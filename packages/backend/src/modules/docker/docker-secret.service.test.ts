import { describe, expect, it, vi } from 'vitest';
import { DockerSecretService } from './docker-secret.service.js';

const ORIGIN_NODE = '11111111-1111-4111-8111-111111111111';
const NODE_ID = '22222222-2222-4222-8222-222222222222';

/** Envelope stand-in: the value travels in clear inside the JSON the service stores. */
const crypto = {
  encryptString: (value: string) => ({ encryptedKey: 'key', encryptedDek: value }),
  decryptString: (value: { encryptedDek: string }) => value.encryptedDek,
};
const stored = (value: string) => JSON.stringify(crypto.encryptString(value));

describe('DockerSecretService.replaceImported', () => {
  it('keeps the link flags of the secrets copied from the source container', async () => {
    // The logical container's secrets on its origin node: link credentials and a user secret.
    const sourceRows = [
      { key: 'DATABASE_URL', encryptedValue: stored('postgres://link'), managed: true, managedOwner: null },
      {
        key: 'AWS_SECRET_ACCESS_KEY',
        encryptedValue: stored('s3-secret'),
        managed: true,
        managedOwner: 'storage-binding:link-1',
      },
      { key: 'API_TOKEN', encryptedValue: stored('user-token'), managed: true, managedOwner: null },
      { key: 'API_TOKEN_USER', encryptedValue: stored('user-token'), managed: false, managedOwner: null },
    ];
    const insert = vi.fn();
    const tx = {
      select: () => ({ from: () => ({ where: vi.fn().mockResolvedValue(sourceRows) }) }),
      delete: () => ({ where: vi.fn().mockResolvedValue(undefined) }),
      insert: () => ({ values: insert }),
    };
    const db = { transaction: (run: (executor: typeof tx) => Promise<void>) => run(tx) };
    const service = new DockerSecretService(db as never, { log: vi.fn() } as never, crypto as never);

    await service.replaceImported(
      NODE_ID,
      'app',
      {
        DATABASE_URL: 'postgres://link',
        AWS_SECRET_ACCESS_KEY: 's3-secret',
        // Same key, another value: no longer the link's secret.
        API_TOKEN: 'replaced-token',
        API_TOKEN_USER: 'user-token',
        NEW_SECRET: 'value',
      },
      'user-1',
      { nodeId: ORIGIN_NODE, containerName: 'app' }
    );

    const rows = insert.mock.calls[0]![0] as Array<Record<string, unknown>>;
    const flags = Object.fromEntries(
      rows.map((row) => [row.key, { managed: row.managed, managedOwner: row.managedOwner }])
    );
    expect(flags).toEqual({
      DATABASE_URL: { managed: true, managedOwner: null },
      AWS_SECRET_ACCESS_KEY: { managed: true, managedOwner: 'storage-binding:link-1' },
      API_TOKEN: { managed: undefined, managedOwner: undefined },
      API_TOKEN_USER: { managed: false, managedOwner: null },
      NEW_SECRET: { managed: undefined, managedOwner: undefined },
    });
  });
});
