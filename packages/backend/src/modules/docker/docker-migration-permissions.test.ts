import { describe, expect, it } from 'vitest';
import {
  assertDockerMigrationCleanupAccess,
  missingDockerMigrationScopes,
  requiredDockerMigrationScopes,
} from './docker-migration-permissions.js';

const plan = {
  sourceNodeId: 'source',
  sourceResourceId: 'resource',
  targetNodeId: 'target',
  keepSource: false,
  hasVolumes: true,
  createsNetworks: true,
  hasProxyHosts: true,
};

describe('Docker migration composed permissions', () => {
  it('requires destructive, volume, network and proxy scopes for full mode', () => {
    const required = requiredDockerMigrationScopes(plan);
    expect(required).toContain('docker:containers:migrate:source/resource');
    expect(required).toContain('docker:containers:migrate:target');
    expect(required).toContain('docker:containers:delete:source/resource');
    expect(required).toContain('docker:volumes:delete:source');
    expect(required).toContain('docker:networks:create:target');
    expect(required).toContain('proxy:edit');
  });

  it('accepts broad scopes and reports only missing composed scopes', () => {
    const missing = missingDockerMigrationScopes(
      [
        'docker:containers:migrate',
        'docker:containers:view',
        'docker:containers:manage',
        'docker:containers:environment',
        'docker:containers:secrets',
        'docker:containers:create',
        'docker:containers:delete',
        'docker:volumes:view',
        'docker:volumes:create',
        'docker:volumes:delete',
        'docker:networks:view',
        'docker:networks:create',
      ],
      plan
    );
    expect(missing).toEqual(['proxy:edit']);
  });

  it('does not require source deletion in keep-source mode', () => {
    const required = requiredDockerMigrationScopes({ ...plan, keepSource: true });
    expect(required).not.toContain('docker:containers:delete:source/resource');
    expect(required).not.toContain('docker:volumes:delete:source');
  });

  it('rechecks destructive and proxy permissions before cleanup retry', () => {
    expect(() =>
      assertDockerMigrationCleanupAccess(['docker:containers:delete'], 'source', 'target', 'resource', true, true)
    ).toThrowError(expect.objectContaining({ code: 'MIGRATION_PERMISSION_DENIED' }));
    expect(() =>
      assertDockerMigrationCleanupAccess(
        ['docker:containers:delete', 'docker:volumes:delete', 'proxy:edit'],
        'source',
        'target',
        'resource',
        true,
        true
      )
    ).not.toThrow();
  });
});
