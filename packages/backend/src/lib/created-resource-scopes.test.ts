import { describe, expect, it } from 'vitest';
import { createdResourceScopes } from './created-resource-scopes.js';

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
});
