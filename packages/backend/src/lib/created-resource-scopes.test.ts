import { describe, expect, it } from 'vitest';
import { createdResourceScopes, createdResourceScopesForCreator } from './created-resource-scopes.js';

describe('created resource permissions', () => {
  it('grants concrete management permissions without creation elsewhere or bypasses', () => {
    const scopes = createdResourceScopes('proxy', 'resource-id');
    expect(scopes).toEqual(
      expect.arrayContaining(['proxy:view:resource-id', 'proxy:edit:resource-id', 'proxy:delete:resource-id'])
    );
    expect(
      scopes.every(
        (scope) =>
          scope.endsWith(':resource-id') &&
          !scope.includes('bypass') &&
          !scope.includes('create') &&
          !scope.includes('templates')
      )
    ).toBe(true);
  });
  it('uses the exact Docker child identity rather than a node-wide grant', () => {
    const scopes = createdResourceScopes('docker:containers', 'node-id/stable-id');
    expect(scopes).toContain('docker:containers:manage:node-id/stable-id');
    expect(scopes.every((scope) => scope.endsWith(':node-id/stable-id'))).toBe(true);
  });
  it('never accepts a folder or provider as a created resource', () => {
    expect(() => createdResourceScopes('pages', 'folder/f1')).toThrow();
    expect(() => createdResourceScopes('nodes', '')).toThrow();
  });
  it('never includes the unrestricted proxy scope', () => {
    expect(createdResourceScopes('proxy', 'host-1')).not.toContain('proxy:unrestricted:host-1');
  });
});

describe('created resource permissions for the creator', () => {
  const folderId = '0b3d7f0e-1111-4c1a-9d2e-3f4a5b6c7d8e';

  it('keeps only the per-resource scopes the creator holds on the destination folder', () => {
    const scopes = createdResourceScopesForCreator(
      'docker:containers',
      'node-1/c1',
      [
        `docker:containers:create:folder/${folderId}`,
        `docker:containers:view:folder/${folderId}`,
        `docker:containers:manage:folder/${folderId}`,
      ],
      { folderId, nodeId: 'node-1' }
    );
    expect(scopes.sort()).toEqual(['docker:containers:manage:node-1/c1', 'docker:containers:view:node-1/c1']);
  });

  it('keeps broad scopes and grants implied through them, but not the whole family', () => {
    const scopes = createdResourceScopesForCreator('proxy', 'host-1', ['proxy:create', 'proxy:edit']);
    expect(scopes.sort()).toEqual(['proxy:edit:host-1', 'proxy:view:host-1']);
    expect(scopes).not.toContain('proxy:delete:host-1');
    expect(scopes).not.toContain('proxy:raw:write:host-1');
  });

  it('keeps node grants for node-bound resources', () => {
    expect(
      createdResourceScopesForCreator('docker:volumes', 'node-1/data', ['docker:volumes:view:node-1'], {
        nodeId: 'node-1',
      })
    ).toEqual(['docker:volumes:view:node-1/data']);
    expect(createdResourceScopesForCreator('pages', 'p1', ['pages:edit:node/node-1'], { nodeId: 'node-1' })).toEqual(
      expect.arrayContaining(['pages:edit:p1', 'pages:view:p1'])
    );
  });

  it('always lets the creator see what they created, whatever the destination information', () => {
    expect(createdResourceScopesForCreator('pages', 'p1', [`pages:create:folder/${folderId}`], { folderId })).toEqual([
      'pages:view:p1',
    ]);
    // Without destination information (a caller that passed none).
    expect(createdResourceScopesForCreator('pages', 'p1', [`pages:create:folder/${folderId}`])).toEqual([
      'pages:view:p1',
    ]);
    expect(createdResourceScopesForCreator('pages', 'p1', ['pages:create'])).toEqual(['pages:view:p1']);
    expect(createdResourceScopesForCreator('domains', 'd1', ['domains:create:node/node-9'], {})).toEqual([
      'domains:view:d1',
    ]);
    expect(
      createdResourceScopesForCreator('hosting:resources', 'vm-1', ['hosting:resources:create:account/a1'])
    ).toEqual(['hosting:resources:view:vm-1']);
    expect(createdResourceScopesForCreator('nodes', 'n1', ['nodes:create:folder/f1'])).toEqual(['nodes:details:n1']);
    expect(createdResourceScopesForCreator('admin:groups', 'g1', ['admin:groups:folder/f1'])).toEqual([
      'admin:groups:g1',
    ]);
  });

  it('keeps other per-resource scopes only when held broadly or on the destination', () => {
    const creator = [`pages:create:folder/${folderId}`, `pages:edit:folder/${folderId}`];
    expect(createdResourceScopesForCreator('pages', 'p1', creator, { folderId }).sort()).toEqual([
      'pages:edit:p1',
      'pages:view:p1',
    ]);
    // Without knowing the destination, a folder-only grant cannot be matched.
    expect(createdResourceScopesForCreator('pages', 'p1', creator)).toEqual(['pages:view:p1']);
  });

  it('recognises legacy bare node grants for routes and domains', () => {
    expect(
      createdResourceScopesForCreator('proxy', 'host-1', ['proxy:create:node-1', 'proxy:edit:node-1'], {
        nodeId: 'node-1',
      }).sort()
    ).toEqual(['proxy:edit:host-1', 'proxy:view:host-1']);
  });
});
