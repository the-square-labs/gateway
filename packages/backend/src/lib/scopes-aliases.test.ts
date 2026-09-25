import { describe, expect, it } from 'vitest';
import { hasScope } from './permissions.js';
import {
  ALL_SCOPES,
  canonicalizeInboundScopes,
  canonicalizeScopes,
  isValidBaseScope,
  isValidInboundScope,
  RETIRED_SCOPE_REPLACEMENTS,
  replaceRetiredScopes,
  SCOPE_CLEANUP_MIGRATION_ADDITIONS,
  scopeCleanupAdditions,
} from './scopes.js';
import { delegatedScopeIssue } from './scopes-schemas.js';

const FOLDER = 'folder/0b3d7f0e-1111-4c1a-9d2e-3f4a5b6c7d8e';

describe('retired scope aliases', () => {
  it('maps every retired name to current catalog scopes only', () => {
    const catalog = new Set<string>(ALL_SCOPES);
    for (const [retired, replacements] of Object.entries(RETIRED_SCOPE_REPLACEMENTS)) {
      expect(catalog.has(retired), retired).toBe(false);
      for (const replacement of replacements)
        expect(catalog.has(replacement), `${retired} -> ${replacement}`).toBe(true);
    }
    for (const [trigger, additions] of Object.entries(SCOPE_CLEANUP_MIGRATION_ADDITIONS)) {
      expect(catalog.has(trigger), trigger).toBe(true);
      for (const addition of additions) expect(catalog.has(addition), addition).toBe(true);
    }
  });

  it('never shadows a current scope with a retired prefix', () => {
    for (const retired of Object.keys(RETIRED_SCOPE_REPLACEMENTS)) {
      expect(
        ALL_SCOPES.filter((scope) => scope.startsWith(`${retired}:`)),
        retired
      ).toEqual([]);
    }
  });

  it('rewrites retired names on input, keeping qualifiers and dropping removed scopes', () => {
    expect(
      canonicalizeInboundScopes([
        'nodes:config:edit:node-1',
        'proxy:advanced:bypass:host-1',
        'proxy:raw:bypass:host-1',
        'proxy:raw:toggle',
        'ssl:cert:export:cert-1',
        'ssl:cert:revoke',
        'docker:containers:config:node-1/c1',
        `docker:containers:folders:manage`,
        `proxy:templates:edit:template-1`,
        'pki:ca:view:root',
        'integrations:gitlab:ci:edit',
        'integrations:github:system',
        'proxy:view',
      ])
    ).toEqual(
      [
        'docker:folders:manage',
        'integrations:github:use',
        'integrations:gitlab:repo:write',
        'nodes:manage:node-1',
        'pki:ca:view',
        'proxy:templates:manage:template-1',
        'proxy:unrestricted:host-1',
        'proxy:view',
      ].sort()
    );
  });

  it('splits and merges the notification and logging scopes', () => {
    expect(canonicalizeInboundScopes(['notifications:view'])).toEqual([
      'notifications:alerts:view',
      'notifications:webhooks:view',
    ]);
    expect(
      canonicalizeInboundScopes(['notifications:alerts:create', 'notifications:alerts:delete', 'notifications:manage'])
    ).toEqual(['notifications:alerts:manage', 'notifications:webhooks:manage']);
    expect(canonicalizeInboundScopes(['notifications:deliveries:view'])).toEqual(['notifications:webhooks:view']);
    const logging = canonicalizeInboundScopes(['logs:manage']);
    expect(logging).toEqual(canonicalizeScopes(ALL_SCOPES.filter((scope) => scope.startsWith('logs:'))));
    expect(logging).toEqual(expect.arrayContaining(['logs:read', 'logs:tokens:create', 'logs:schemas:folders:manage']));
  });

  it('keeps folder qualifiers on renamed folder-scopable scopes', () => {
    expect(canonicalizeInboundScopes([`nodes:config:edit:${FOLDER}`])).toEqual([`nodes:manage:${FOLDER}`]);
    expect(canonicalizeInboundScopes([`proxy:raw:bypass:${FOLDER}`])).toEqual([`proxy:unrestricted:${FOLDER}`]);
  });

  it('accepts retired names as inbound input but not in the catalog', () => {
    expect(isValidInboundScope('nodes:config:edit')).toBe(true);
    expect(isValidInboundScope('ssl:cert:revoke:cert-1')).toBe(true);
    expect(isValidInboundScope('notifications:manage')).toBe(true);
    expect(isValidInboundScope('nodes:config:bogus')).toBe(false);
    expect(isValidBaseScope('nodes:config:edit')).toBe(false);
    expect(isValidBaseScope('notifications:manage')).toBe(false);
    expect(delegatedScopeIssue('nodes:config:edit:node-1')).toBeNull();
    expect(delegatedScopeIssue(`proxy:templates:edit:${FOLDER}`)).toContain('cannot be restricted to a folder');
  });

  it('leaves unknown scopes for validation to reject', () => {
    expect(replaceRetiredScopes(['unknown:scope', ' proxy:view '])).toEqual(['unknown:scope', 'proxy:view']);
    expect(canonicalizeInboundScopes(['unknown:scope'])).toEqual([]);
  });

  it('maps GitLab project listing to connector view and keeps variable keys in repo:read', () => {
    expect(canonicalizeInboundScopes(['integrations:gitlab:projects:view'])).toEqual(['integrations:gitlab:view']);
    expect(canonicalizeInboundScopes(['integrations:gitlab:variables:view'])).toEqual([
      'integrations:gitlab:repo:read',
    ]);
  });

  it('passes additions on only for resource and bare node qualifiers, never destinations', () => {
    expect(scopeCleanupAdditions('docker:volumes:create')).toEqual(['docker:volumes:edit']);
    expect(scopeCleanupAdditions('docker:volumes:create:node-1')).toEqual(['docker:volumes:edit:node-1']);
    expect(scopeCleanupAdditions('docker:volumes:create:node/node-1')).toEqual([]);
    expect(scopeCleanupAdditions(`docker:volumes:create:${FOLDER}`)).toEqual([]);
    expect(scopeCleanupAdditions('docker:volumes:delete')).toEqual([]);
    expect(scopeCleanupAdditions('pki:ca:create:root')).toEqual(['pki:ca:edit', 'pki:ca:export']);
  });

  it('does not alias inside permission checks', () => {
    expect(hasScope(['notifications:manage'], 'notifications:alerts:manage')).toBe(false);
    expect(hasScope(['docker:containers:folders:manage'], 'docker:folders:manage')).toBe(false);
  });
});

describe('delegated scope targets', () => {
  it('accepts every documented target form on bases that support it', () => {
    for (const scope of [
      'proxy:view',
      'proxy:view:host-1',
      `proxy:view:${FOLDER}`,
      'proxy:view:node/node-1',
      `docker:containers:create:${FOLDER}`,
      'docker:containers:create:node/node-1',
      'docker:containers:create:node-1',
      'docker:containers:manage:node-1/deployment-1',
      'docker:availability:manage:node-1/c1',
      `docker:availability:manage:${FOLDER}`,
      'hosting:snapshots:view:node/node-1',
      'hosting:resources:power:account/account-1',
      'docker:registries:internal:push:group/project/app',
      'pki:cert:issue:ca-1',
      `admin:users:${FOLDER}`,
    ]) {
      expect(delegatedScopeIssue(scope), scope).toBeNull();
    }
  });

  it('rejects targets a base cannot resolve', () => {
    expect(delegatedScopeIssue('pki:ca:export:folder/0b3d7f0e-1111-4c1a-9d2e-3f4a5b6c7d8e')).toContain('folder');
    expect(delegatedScopeIssue('pages:settings:view:x')).toContain('cannot be restricted to a resource');
    expect(delegatedScopeIssue('hosting:resources:create:node/node-1')).toContain('node');
    expect(delegatedScopeIssue('admin:users:node/node-1')).toContain('node');
    expect(delegatedScopeIssue('proxy:view:account/a1')).toContain('hosting');
    expect(delegatedScopeIssue('databases:view:a/b')).toContain('nested');
    expect(delegatedScopeIssue('Proxy:view')).toBe('Invalid scope format');
    expect(delegatedScopeIssue('proxy:view:host 1')).toBe('Invalid scope format');
    expect(delegatedScopeIssue('bogus:scope')).toBe('Scope is not recognized');
  });
});
