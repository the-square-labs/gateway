import { describe, expect, it } from 'vitest';
import {
  assertDockerMigrationCleanupAccess,
  assertDockerMigrationReadAccess,
  missingDockerMigrationScopes,
  requiredDockerMigrationScopes,
} from './docker-migration-permissions.js';

const plan = {
  sourceNodeId: 'source',
  sourceResourceId: 'resource',
  targetNodeId: 'target',
  targetFolderId: null,
  keepSource: false,
  hasVolumes: true,
  createsNetworks: true,
  hasProxyHosts: true,
};

describe('Docker migration composed permissions', () => {
  const dependencies = {
    volumes: [{ resourceId: 'data', folderId: 'volume-folder' }],
    networks: [
      { resourceId: 'network-source', resourceKey: 'app', folderId: 'network-folder', targetResourceId: null },
    ],
    proxyHostIds: ['proxy-1'],
  };
  const scopedDependencies = [
    ...['migrate', 'view', 'manage', 'environment', 'secrets', 'create', 'delete'].map(
      (action) => `docker:containers:${action}`
    ),
    'docker:volumes:view:source/data',
    'docker:volumes:delete:source/data',
    'docker:volumes:create:folder/volume-folder',
    'docker:networks:view:source/network-source',
    'docker:networks:create:folder/network-folder',
    'proxy:edit:proxy-1',
  ];

  it('accepts exact dependency grants and creation in the preserved folders', () => {
    expect(missingDockerMigrationScopes(scopedDependencies, { ...plan, ...dependencies })).toEqual([]);
  });

  it('does not allow unrelated dependency IDs or creating outside the authorized folder', () => {
    const missing = missingDockerMigrationScopes(scopedDependencies, {
      ...plan,
      ...dependencies,
      volumes: [{ resourceId: 'other', folderId: null }],
      proxyHostIds: ['proxy-2'],
    });
    expect(missing).toEqual(
      expect.arrayContaining([
        'docker:volumes:view:source/other',
        'docker:volumes:delete:source/other',
        'docker:volumes:create:target',
        'proxy:edit:proxy-2',
      ])
    );
  });

  it('requires access to the existing target network, not permission to create another network', () => {
    const withExisting = {
      ...plan,
      ...dependencies,
      networks: [{ ...dependencies.networks[0]!, targetResourceId: 'network-target' }],
    };
    expect(missingDockerMigrationScopes(scopedDependencies, withExisting)).toEqual([
      'docker:networks:edit:target/network-target',
    ]);
    expect(
      missingDockerMigrationScopes([...scopedDependencies, 'docker:networks:edit:target/network-target'], withExisting)
    ).toEqual([]);
  });

  it('accepts exact volume and proxy grants for cleanup but rejects another volume', () => {
    expect(() =>
      assertDockerMigrationCleanupAccess(scopedDependencies, 'source', 'target', 'resource', true, true, dependencies)
    ).not.toThrow();
    expect(() =>
      assertDockerMigrationCleanupAccess(scopedDependencies, 'source', 'target', 'resource', true, true, {
        ...dependencies,
        volumes: [{ resourceId: 'other', folderId: null }],
      })
    ).toThrow();
  });

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

  it('accepts a preserved destination folder for target container creation capabilities', () => {
    const missing = missingDockerMigrationScopes(
      [
        'docker:containers:migrate:source/resource',
        'docker:containers:view:source/resource',
        'docker:containers:manage:source/resource',
        'docker:containers:environment:source/resource',
        'docker:containers:secrets:source/resource',
        'docker:containers:delete:source/resource',
        'docker:containers:migrate:folder/folder-1',
        'docker:containers:create:folder/folder-1',
        'docker:containers:manage:folder/folder-1',
        'docker:containers:environment:folder/folder-1',
        'docker:containers:secrets:folder/folder-1',
        'docker:volumes:view',
        'docker:volumes:create',
        'docker:volumes:delete',
        'docker:networks:view',
        'docker:networks:create',
        'proxy:edit',
      ],
      { ...plan, targetFolderId: 'folder-1' }
    );
    expect(missing).toEqual([]);
  });

  it('does not let a destination folder scope substitute for source resource access', () => {
    const missing = missingDockerMigrationScopes(
      [
        'docker:containers:migrate:folder/folder-1',
        'docker:containers:create:folder/folder-1',
        'docker:containers:manage:folder/folder-1',
        'docker:containers:environment:folder/folder-1',
        'docker:containers:secrets:folder/folder-1',
      ],
      {
        ...plan,
        targetFolderId: 'folder-1',
        keepSource: true,
        hasVolumes: false,
        createsNetworks: false,
        hasProxyHosts: false,
      }
    );
    expect(missing).toEqual(
      expect.arrayContaining([
        'docker:containers:migrate:source/resource',
        'docker:containers:view:source/resource',
        'docker:containers:manage:source/resource',
        'docker:containers:environment:source/resource',
        'docker:containers:secrets:source/resource',
      ])
    );
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

  it('accepts node-scoped task visibility for a migration on that node', () => {
    expect(() =>
      assertDockerMigrationReadAccess(
        ['docker:tasks:source', 'docker:containers:view:source/resource'],
        'source',
        'target',
        'resource'
      )
    ).not.toThrow();
  });
});
