import { describe, expect, it } from 'vitest';
import { CryptoService } from '@/services/crypto.service.js';
import {
  assertMigrationDeletionGate,
  assertMigrationManifest,
  migrationEnvList,
  migrationEnvMap,
  openMigrationPlan,
  sealMigrationPlan,
} from './docker-migration-runtime.js';

const verified = {
  imageDigestVerified: true,
  volumeTreeVerified: true,
  fsyncVerified: true,
  manifestVerified: true,
  environmentVerified: true,
  secretsVerified: true,
};

describe('Docker migration runtime safety', () => {
  const crypto = new CryptoService('11'.repeat(32));

  it('blocks source deletion until running-target health and all artifacts are verified', () => {
    const row = { sourceState: 'running', verification: verified } as never;
    expect(() => assertMigrationDeletionGate(row, [{ state: 'verified' }])).toThrowError(
      expect.objectContaining({ code: 'MIGRATION_DELETION_GATE_FAILED' })
    );
    expect(() =>
      assertMigrationDeletionGate(
        { sourceState: 'running', verification: { ...verified, healthVerified: true } } as never,
        [{ state: 'transferring' }]
      )
    ).toThrowError(expect.objectContaining({ code: 'MIGRATION_DELETION_GATE_FAILED' }));
  });

  it('allows stopped source deletion without a health gate after exact verification', () => {
    expect(() =>
      assertMigrationDeletionGate({ sourceState: 'stopped', verification: verified } as never, [{ state: 'verified' }])
    ).not.toThrow();
  });

  it('round-trips unicode and equals signs in environment values', () => {
    const env = { PASSWORD: 'a=b=c', UNICODE: 'пароль' };
    expect(migrationEnvMap(migrationEnvList(env))).toEqual(env);
  });

  it('reports the exact path of a create-manifest mismatch without exposing values', () => {
    expect(() =>
      assertMigrationManifest(
        { config: { Image: 'source' }, hostConfig: {}, envKeys: [], volumeNames: [] },
        { config: { Image: 'target' }, hostConfig: {}, envKeys: [], volumeNames: [] }
      )
    ).toThrowError(
      expect.objectContaining({
        code: 'MIGRATION_MANIFEST_MISMATCH',
        message: 'Target Docker create configuration differs at manifest.config.Image',
      })
    );
  });

  it('treats Docker OOM-killer null and false defaults as equivalent', () => {
    expect(() =>
      assertMigrationManifest(
        { config: {}, hostConfig: { OomKillDisable: null }, envKeys: [], volumeNames: [] },
        { config: {}, hostConfig: { OomKillDisable: false }, envKeys: [], volumeNames: [] }
      )
    ).not.toThrow();
  });

  it('treats omitted and empty implicit bridge endpoints as equivalent', () => {
    expect(() =>
      assertMigrationManifest(
        {
          config: {},
          hostConfig: { NetworkMode: 'bridge' },
          networkingConfig: { EndpointsConfig: {} },
          envKeys: [],
          volumeNames: [],
        },
        {
          config: {},
          hostConfig: { NetworkMode: 'bridge' },
          networkingConfig: {
            EndpointsConfig: {
              bridge: {
                IPAMConfig: null,
                Links: null,
                Aliases: [],
                DriverOpts: {},
                MacAddress: '',
                GatewayPriority: 0,
              },
            },
          },
          envKeys: [],
          volumeNames: [],
        }
      )
    ).not.toThrow();
  });

  it('still rejects meaningful bridge endpoint differences', () => {
    expect(() =>
      assertMigrationManifest(
        {
          config: {},
          hostConfig: { NetworkMode: 'bridge' },
          networkingConfig: { EndpointsConfig: {} },
          envKeys: [],
          volumeNames: [],
        },
        {
          config: {},
          hostConfig: { NetworkMode: 'bridge' },
          networkingConfig: { EndpointsConfig: { bridge: { Aliases: ['api'] } } },
          envKeys: [],
          volumeNames: [],
        }
      )
    ).toThrowError(expect.objectContaining({ code: 'MIGRATION_MANIFEST_MISMATCH' }));
  });

  it('encrypts sensitive create manifests in the durable migration plan', () => {
    const sealed = sealMigrationPlan(
      {
        target: { containerId: 'target-id' },
        manifest: {
          config: { Cmd: ['server', '--password=secret'], Labels: { token: 'plaintext-secret' } },
          hostConfig: { RestartPolicy: { Name: 'unless-stopped' } },
        },
      },
      crypto
    );
    const serialized = JSON.stringify(sealed);

    expect(serialized).not.toContain('plaintext-secret');
    expect(serialized).not.toContain('--password=secret');
    expect(sealed).not.toHaveProperty('manifest');
    expect(openMigrationPlan({ plan: sealed } as never, crypto).manifest?.hostConfig?.RestartPolicy?.Name).toBe(
      'unless-stopped'
    );
  });
});
