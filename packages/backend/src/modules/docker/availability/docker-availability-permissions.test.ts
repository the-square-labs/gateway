import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import {
  dockerAvailabilityWorkloadFolderId,
  missingDockerAvailabilityCandidateScopes,
} from './docker-availability-permissions.js';

const deployment = {
  kind: 'deployment' as const,
  currentNodeId: 'node-a',
  resourceId: 'deployment-1',
  displayName: 'api',
};
const compose = { kind: 'compose' as const, currentNodeId: 'node-a', resourceId: 'project-1', displayName: 'stack' };

/** What folder expansion yields for create + manage + environment + secrets on folder-1 holding the deployment. */
const folderScopes = [
  'docker:containers:create:folder/folder-1',
  'docker:containers:manage:folder/folder-1',
  'docker:containers:environment:folder/folder-1',
  'docker:containers:secrets:folder/folder-1',
  'docker:containers:manage:node-a/deployment-1',
  'docker:containers:environment:node-a/deployment-1',
  'docker:containers:secrets:node-a/deployment-1',
];

describe('Availability candidate permissions', () => {
  it('lets a folder grant place replicas of a workload in that folder on any Docker node', () => {
    expect(missingDockerAvailabilityCandidateScopes(folderScopes, deployment, 'node-b', 'folder-1')).toEqual([]);
  });

  it('requires creation where the workload stays when the folder grant is for another folder', () => {
    expect(missingDockerAvailabilityCandidateScopes(folderScopes, deployment, 'node-b', 'folder-2')).toEqual([
      'docker:containers:create',
    ]);
    expect(missingDockerAvailabilityCandidateScopes(folderScopes, deployment, 'node-b', null)).toEqual([
      'docker:containers:create',
    ]);
  });

  it('keeps node grants working and does not let a node grant on the current node cover another node', () => {
    const nodeB = ['create', 'manage', 'environment', 'secrets'].map((action) => `docker:containers:${action}:node-b`);
    expect(missingDockerAvailabilityCandidateScopes(nodeB, deployment, 'node-b', null)).toEqual([]);

    const nodeA = ['manage', 'environment', 'secrets'].map((action) => `docker:containers:${action}:node-a`);
    expect(
      missingDockerAvailabilityCandidateScopes(['docker:containers:create', ...nodeA], deployment, 'node-b', null)
    ).toEqual(['docker:containers:manage', 'docker:containers:environment', 'docker:containers:secrets']);
  });

  it('uses the Compose scopes for Compose Projects', () => {
    expect(
      missingDockerAvailabilityCandidateScopes(
        ['docker:compose:create:folder/folder-1', 'docker:compose:manage:node-a/project-1'],
        compose,
        'node-b',
        'folder-1'
      )
    ).toEqual([]);
    expect(missingDockerAvailabilityCandidateScopes([], compose, 'node-b', null)).toEqual([
      'docker:compose:create',
      'docker:compose:manage',
    ]);
  });

  it('reads the folder of containers and deployments by name and of Compose Projects by id', async () => {
    const where = vi.fn(() => ({ limit: vi.fn().mockResolvedValue([{ folderId: 'folder-1' }]) }));
    const db = { select: vi.fn(() => ({ from: vi.fn(() => ({ where })) })) };

    await expect(dockerAvailabilityWorkloadFolderId(db as never, deployment)).resolves.toBe('folder-1');
    await expect(dockerAvailabilityWorkloadFolderId(db as never, compose)).resolves.toBe('folder-1');

    const params = (call: unknown[]) => new PgDialect().sqlToQuery(call[0] as SQL).params;
    expect(params(where.mock.calls[0] as unknown[])).toEqual(['node-a', 'container', 'api']);
    expect(params(where.mock.calls[1] as unknown[])).toEqual(['node-a', 'compose', 'project-1']);
  });
});
