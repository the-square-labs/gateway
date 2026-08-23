import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasScope, hasScopeForResource } from './permissions.js';
import {
  ADMIN_SCOPES,
  ALL_SCOPES,
  API_TOKEN_SCOPES,
  BUILTIN_GROUPS,
  canonicalizeScopes,
  extractBaseScope,
  FOLDER_SCOPABLE,
  GUEST_SCOPES,
  isApiTokenScope,
  isMcpTokenScope,
  isValidBaseScope,
  MANUAL_APPROVAL_SCOPES,
  MCP_TOKEN_SCOPES,
  OPERATOR_SCOPES,
  PROGRAMMATIC_DENIED_BASE_SCOPES,
  RESOURCE_SCOPABLE,
  SYSTEM_ADMIN_SCOPES,
  VIEWER_SCOPES,
} from './scopes.js';

function frontendResourceScopableScopes(): string[] {
  const source = readFileSync(join(process.cwd(), '../frontend/src/types/scopes.ts'), 'utf8');
  const match = source.match(/export const RESOURCE_SCOPABLE_SCOPES = \[([\s\S]*?)\] as const;/);
  if (!match) throw new Error('RESOURCE_SCOPABLE_SCOPES not found');
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

function frontendSelectableScopes(): string[] {
  const source = readFileSync(join(process.cwd(), '../frontend/src/types/scopes.ts'), 'utf8');
  const match = source.match(/const RAW_TOKEN_SCOPES = \[([\s\S]*?)\] as const;/);
  if (!match) throw new Error('RAW_TOKEN_SCOPES not found');
  return [...match[1].matchAll(/value: "([^"]+)"/g)].map((entry) => entry[1]);
}

function frontendProgrammaticDeniedScopes(): string[] {
  const source = readFileSync(join(process.cwd(), '../frontend/src/types/scopes.ts'), 'utf8');
  const match = source.match(/const PROGRAMMATIC_DENIED_SCOPE_VALUES = new Set<string>\(\[([\s\S]*?)\]\);/);
  if (!match) throw new Error('PROGRAMMATIC_DENIED_SCOPE_VALUES not found');
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

function listScopeRemovalMigration(): string {
  return readFileSync(join(process.cwd(), 'src/db/migrations/0030_remove_list_scopes.sql'), 'utf8');
}

function documentedScopes(): string[] {
  const source = readFileSync(join(process.cwd(), '../../SCOPES.md'), 'utf8');
  const section = source.match(/## Scope List([\s\S]*?)## API Token Delegation/);
  if (!section) throw new Error('SCOPES.md scope list not found');
  return [...section[1].matchAll(/\| `([^`]+)` \|/g)].map((entry) => entry[1]);
}

function documentedProgrammaticDeniedScopes(): string[] {
  const source = readFileSync(join(process.cwd(), '../../SCOPES.md'), 'utf8');
  const section = source.match(/## API Token Delegation([\s\S]*?)## OAuth Manual Approval Scopes/);
  if (!section) throw new Error('SCOPES.md API token delegation list not found');
  return [...section[1].matchAll(/\| `([^`]+)` \|/g)].map((entry) => entry[1]);
}

function documentedManualApprovalScopes(): string[] {
  const source = readFileSync(join(process.cwd(), '../../SCOPES.md'), 'utf8');
  const section = source.match(/## OAuth Manual Approval Scopes([\s\S]*)$/);
  if (!section) throw new Error('SCOPES.md OAuth manual approval list not found');
  return [...section[1].matchAll(/\| `([^`]+)` \|/g)].map((entry) => entry[1]);
}

function migratedProgrammaticStoredScopes(scopes: string[]): string[] {
  return canonicalizeScopes(
    scopes.filter(
      (scope) => !PROGRAMMATIC_DENIED_BASE_SCOPES.some((denied) => scope === denied || scope.startsWith(`${denied}:`))
    )
  );
}

describe('canonical scope definitions', () => {
  it('keeps external source-control and SSH integrations out of Gateway MCP delegation', () => {
    expect(MCP_TOKEN_SCOPES).toContain('nodes:details');
    expect(MCP_TOKEN_SCOPES).toContain('integrations:cloudflare:view');
    expect(MCP_TOKEN_SCOPES).not.toContain('mcp:use');
    expect(MCP_TOKEN_SCOPES.some((scope) => scope.startsWith('integrations:gitlab:'))).toBe(false);
    expect(MCP_TOKEN_SCOPES.some((scope) => scope.startsWith('integrations:github:'))).toBe(false);
    expect(MCP_TOKEN_SCOPES.some((scope) => scope.startsWith('integrations:git:'))).toBe(false);
    expect(MCP_TOKEN_SCOPES.some((scope) => scope.startsWith('integrations:ssh:'))).toBe(false);
    expect(isMcpTokenScope('integrations:gitlab:repo:read')).toBe(false);
    expect(isMcpTokenScope('nodes:details:node-1')).toBe(true);
  });

  it('keeps system-admin on every canonical scope', () => {
    expect(SYSTEM_ADMIN_SCOPES).toEqual([...ALL_SCOPES]);
    expect(SYSTEM_ADMIN_SCOPES).toContain('ai:skills:manage');
    expect(OPERATOR_SCOPES).not.toContain('ai:skills:manage');
  });

  it('keeps the public scope reference aligned with canonical scope contracts', () => {
    expect(documentedScopes()).toEqual([...ALL_SCOPES]);
    expect(documentedProgrammaticDeniedScopes()).toEqual([...PROGRAMMATIC_DENIED_BASE_SCOPES]);
    expect(documentedManualApprovalScopes()).toEqual([...MANUAL_APPROVAL_SCOPES]);
  });

  it('keeps frontend scope selectors aligned while reserving inference setup for OAuth', () => {
    expect(frontendSelectableScopes().sort()).toEqual(ALL_SCOPES.filter((scope) => scope !== 'inference:setup').sort());
    expect(frontendProgrammaticDeniedScopes().sort()).toEqual([...PROGRAMMATIC_DENIED_BASE_SCOPES].sort());
  });

  it('keeps built-in admin broad while excluding protected operational scopes', () => {
    expect(ADMIN_SCOPES).toContain('settings:gateway:view');
    expect(ADMIN_SCOPES).not.toContain('settings:gateway:edit');
    expect(ADMIN_SCOPES).toContain('housekeeping:run');
    expect(ADMIN_SCOPES).not.toContain('housekeeping:configure');
    expect(ADMIN_SCOPES).toContain('docker:registries:view');
    expect(ADMIN_SCOPES).not.toContain('docker:registries:create');
    expect(ADMIN_SCOPES).not.toContain('docker:registries:edit');
    expect(ADMIN_SCOPES).not.toContain('docker:registries:delete');
    expect(ADMIN_SCOPES).toContain('docker:containers:mounts');
    expect(ADMIN_SCOPES).toContain('proxy:raw:bypass');
    expect(ADMIN_SCOPES).toContain('audit:siem:view');
    expect(ADMIN_SCOPES).toContain('audit:siem:manage');
    expect(ADMIN_SCOPES).not.toContain('nodes:console');
    expect(SYSTEM_ADMIN_SCOPES).toContain('admin:users:impersonate');
    expect(ADMIN_SCOPES).not.toContain('admin:users:impersonate');
    expect(OPERATOR_SCOPES).not.toContain('proxy:raw:bypass');
    expect(OPERATOR_SCOPES).toContain('proxy:maintenance:bypass');
    expect(OPERATOR_SCOPES).not.toContain('nodes:console');
    expect(ADMIN_SCOPES).not.toContain('admin:system');
    expect(hasScope(['admin:users'], 'admin:users:impersonate')).toBe(false);
    expect(hasScope(['admin:users:impersonate'], 'admin:users:impersonate')).toBe(true);
  });

  it('grants Docker mount editing only to built-in admin tiers by default', () => {
    expect(SYSTEM_ADMIN_SCOPES).toContain('docker:containers:mounts');
    expect(ADMIN_SCOPES).toContain('docker:containers:mounts');
    expect(OPERATOR_SCOPES).not.toContain('docker:containers:mounts');
    expect(ALL_SCOPES).toContain('docker:containers:mounts');
  });

  it('uses Docker operation scopes instead of provider-specific GitLab registry scopes', () => {
    expect(ALL_SCOPES).not.toContain('integrations:gitlab:registry:use');
    expect(ALL_SCOPES).not.toContain('integrations:gitlab:registry:view');
    expect(SYSTEM_ADMIN_SCOPES).not.toContain('integrations:gitlab:registry:use');
    expect(SYSTEM_ADMIN_SCOPES).not.toContain('integrations:gitlab:registry:view');
    expect(ADMIN_SCOPES).not.toContain('integrations:gitlab:registry:use');
    expect(ADMIN_SCOPES).not.toContain('integrations:gitlab:registry:view');
    expect(ADMIN_SCOPES).toContain('docker:registries:view');
    expect(VIEWER_SCOPES).not.toContain('integrations:gitlab:registry:use');
    expect(VIEWER_SCOPES).not.toContain('integrations:gitlab:registry:view');
    expect(VIEWER_SCOPES).toContain('docker:registries:view');
    expect(VIEWER_SCOPES).not.toContain('integrations:gitlab:registry:manage');
  });

  it('keeps the built-in guest group authenticated but unprivileged', () => {
    expect(GUEST_SCOPES).toEqual([]);
    expect(BUILTIN_GROUPS.at(-1)).toMatchObject({
      name: 'guest',
      scopes: [],
    });
  });

  it('applies the Pages built-in, resource, folder, and API-token scope contract', () => {
    const operatorPages = [
      'pages:view',
      'pages:create',
      'pages:edit',
      'pages:deploy',
      'pages:deployments:manage',
      'pages:tags:manage',
      'pages:folders:manage',
      'pages:settings:view',
    ];
    for (const scope of operatorPages) {
      expect(SYSTEM_ADMIN_SCOPES).toContain(scope);
      expect(ADMIN_SCOPES).toContain(scope);
      expect(OPERATOR_SCOPES).toContain(scope);
    }
    expect(OPERATOR_SCOPES).not.toContain('pages:delete');
    expect(OPERATOR_SCOPES).not.toContain('pages:tokens:manage');
    expect(OPERATOR_SCOPES).not.toContain('pages:settings:edit');
    expect(VIEWER_SCOPES).toEqual(expect.arrayContaining(['pages:view', 'pages:settings:view']));
    expect(VIEWER_SCOPES).not.toContain('pages:edit');

    const projectScopes = [
      'pages:view',
      'pages:edit',
      'pages:delete',
      'pages:deploy',
      'pages:deployments:manage',
      'pages:tags:manage',
      'pages:tokens:manage',
    ];
    for (const scope of projectScopes) {
      expect(RESOURCE_SCOPABLE).toContain(scope);
      expect(FOLDER_SCOPABLE).toContain(scope);
      expect(isApiTokenScope(`${scope}:project-1`)).toBe(true);
    }
    for (const scope of ['pages:create', 'pages:folders:manage', 'pages:settings:view', 'pages:settings:edit']) {
      expect(RESOURCE_SCOPABLE).not.toContain(scope);
      expect(FOLDER_SCOPABLE).not.toContain(scope);
    }
    expect(canonicalizeScopes(['pages:view:project-2', 'pages:view:project-1'])).toEqual([
      'pages:view:project-1',
      'pages:view:project-2',
    ]);
    expect(extractBaseScope('pages:deployments:manage:project-1')).toBe('pages:deployments:manage');
  });

  it('grants Docker migrations only to admin tiers and requires manual approval', () => {
    expect(SYSTEM_ADMIN_SCOPES).toContain('docker:containers:migrate');
    expect(ADMIN_SCOPES).toContain('docker:containers:migrate');
    expect(OPERATOR_SCOPES).not.toContain('docker:containers:migrate');
    expect(RESOURCE_SCOPABLE).toContain('docker:containers:migrate');
    expect(MANUAL_APPROVAL_SCOPES).toContain('docker:containers:migrate');
    expect(hasScopeForResource([...ADMIN_SCOPES], 'docker:containers:migrate', 'node-1')).toBe(true);
    expect(hasScopeForResource(['docker:containers:migrate:node-1'], 'docker:containers:migrate', 'node-1')).toBe(true);
    expect(hasScopeForResource(['docker:containers:migrate:node-1'], 'docker:containers:migrate', 'node-2')).toBe(
      false
    );
  });

  it('protects Docker archive export with a resource-scoped manual-approval permission', () => {
    expect(SYSTEM_ADMIN_SCOPES).toContain('docker:containers:export');
    expect(ADMIN_SCOPES).toContain('docker:containers:export');
    expect(OPERATOR_SCOPES).not.toContain('docker:containers:export');
    expect(RESOURCE_SCOPABLE).toContain('docker:containers:export');
    expect(MANUAL_APPROVAL_SCOPES).toContain('docker:containers:export');
    expect(
      hasScopeForResource(
        ['docker:containers:export:node-1/container-1'],
        'docker:containers:export',
        'node-1/container-1'
      )
    ).toBe(true);
    expect(
      hasScopeForResource(
        ['docker:containers:export:node-1/container-1'],
        'docker:containers:export',
        'node-1/container-2'
      )
    ).toBe(false);
  });

  it('protects Docker volume archive export with a resource-scoped manual-approval permission', () => {
    expect(SYSTEM_ADMIN_SCOPES).toContain('docker:volumes:export');
    expect(ADMIN_SCOPES).toContain('docker:volumes:export');
    expect(OPERATOR_SCOPES).not.toContain('docker:volumes:export');
    expect(RESOURCE_SCOPABLE).toContain('docker:volumes:export');
    expect(MANUAL_APPROVAL_SCOPES).toContain('docker:volumes:export');
    expect(hasScopeForResource(['docker:volumes:export:node-1'], 'docker:volumes:export', 'node-1')).toBe(true);
    expect(hasScopeForResource(['docker:volumes:export:node-1'], 'docker:volumes:export', 'node-2')).toBe(false);
  });

  it('requires explicit grants for high-risk host node consoles', () => {
    expect(ALL_SCOPES).toContain('nodes:console');
    expect(SYSTEM_ADMIN_SCOPES).toContain('nodes:console');
    expect(RESOURCE_SCOPABLE).toContain('nodes:console');
    expect(MANUAL_APPROVAL_SCOPES).toContain('nodes:console');
    expect(ADMIN_SCOPES).not.toContain('nodes:console');
    expect(OPERATOR_SCOPES).not.toContain('nodes:console');
    expect(hasScopeForResource([...ADMIN_SCOPES], 'nodes:console', 'node-1')).toBe(false);
    expect(hasScopeForResource([...OPERATOR_SCOPES], 'nodes:console', 'node-1')).toBe(false);
    expect(hasScopeForResource(['nodes:console:node-1'], 'nodes:console', 'node-1')).toBe(true);
    expect(hasScopeForResource(['nodes:console:node-1'], 'nodes:console', 'node-2')).toBe(false);
    expect(hasScopeForResource(['nodes:console'], 'nodes:console', 'node-2')).toBe(true);
  });

  it('removes deprecated housekeeping scope and rejects admin:system for API tokens', () => {
    expect(ALL_SCOPES).not.toContain('admin:housekeeping');
    expect(API_TOKEN_SCOPES).not.toContain('admin:system');
    expect(API_TOKEN_SCOPES).not.toContain('mcp:use');
    expect(ALL_SCOPES).not.toContain('inference:use');
    expect(ALL_SCOPES).not.toContain('inference:usage:view:self');
    expect(API_TOKEN_SCOPES).not.toContain('inference:tokens:manage');
    expect(API_TOKEN_SCOPES).not.toContain('inference:providers:manage');
    expect(API_TOKEN_SCOPES).not.toContain('admin:users');
    expect(API_TOKEN_SCOPES).not.toContain('admin:users:impersonate');
    expect(API_TOKEN_SCOPES).not.toContain('settings:gateway:edit');
    expect(API_TOKEN_SCOPES).not.toContain('integrations:gitlab:manage');
    expect(API_TOKEN_SCOPES).toContain('integrations:gitlab:repo:read');
    expect(API_TOKEN_SCOPES).toContain('integrations:gitlab:repo:write');
    expect(API_TOKEN_SCOPES).toContain('integrations:gitlab:variables:delete');
    expect(API_TOKEN_SCOPES).not.toContain('proxy:raw:write');
    expect(API_TOKEN_SCOPES).not.toContain('proxy:raw:bypass');
    expect(API_TOKEN_SCOPES).not.toContain('proxy:advanced:bypass');
    expect(API_TOKEN_SCOPES).toContain('nodes:files:read');
    expect(API_TOKEN_SCOPES).toContain('nodes:files:write');
    expect(isApiTokenScope('admin:system')).toBe(false);
    expect(isApiTokenScope('mcp:use')).toBe(false);
    expect(isValidBaseScope('inference:use')).toBe(false);
    expect(isValidBaseScope('inference:usage:view:self')).toBe(false);
    expect(isApiTokenScope('inference:models:manage')).toBe(false);
    expect(isApiTokenScope('admin:users')).toBe(false);
    expect(isApiTokenScope('admin:users:impersonate')).toBe(false);
    expect(isApiTokenScope('proxy:raw:write:host-1')).toBe(false);
    expect(isApiTokenScope('proxy:raw:bypass:host-1')).toBe(false);
    expect(isApiTokenScope('nodes:files:read:node-1')).toBe(true);
    expect(isApiTokenScope('nodes:files:write:node-1')).toBe(true);
    expect(isApiTokenScope('integrations:gitlab:manage')).toBe(false);
    expect(isApiTokenScope('integrations:gitlab:repo:read')).toBe(true);
    expect(isApiTokenScope('integrations:gitlab:repo:write')).toBe(true);
  });

  it('grants inference administration only to built-in admin tiers by default', () => {
    for (const scope of [
      'inference:tokens:manage',
      'inference:providers:view',
      'inference:providers:manage',
      'inference:models:manage',
      'inference:limits:manage',
      'inference:usage:view',
    ]) {
      expect(SYSTEM_ADMIN_SCOPES).toContain(scope);
      expect(ADMIN_SCOPES).toContain(scope);
      expect(OPERATOR_SCOPES).not.toContain(scope);
    }

    expect(SYSTEM_ADMIN_SCOPES).toContain('feat:ai:use');
    expect(ADMIN_SCOPES).toContain('feat:ai:use');
    expect(OPERATOR_SCOPES).toContain('feat:ai:use');

    expect(isValidBaseScope('inference:tokens:create')).toBe(false);
    expect(isValidBaseScope('inference:tokens:revoke')).toBe(false);
  });

  it('keeps OAuth manual approval scopes focused on high-risk delegated access', () => {
    expect(MANUAL_APPROVAL_SCOPES).toEqual([
      'pki:ca:create:root',
      'pki:ca:create:intermediate',
      'pki:ca:revoke:root',
      'pki:ca:revoke:intermediate',
      'pki:cert:export',
      'ssl:cert:issue',
      'ssl:cert:delete',
      'ssl:cert:revoke',
      'ssl:cert:export',
      'proxy:raw:bypass',
      'pages:delete',
      'pages:tokens:manage',
      'pages:settings:edit',
      'nodes:console',
      'nodes:files:read',
      'nodes:files:write',
      'docker:containers:console',
      'docker:containers:files:read',
      'docker:containers:files:write',
      'docker:containers:export',
      'docker:containers:secrets',
      'docker:containers:mounts',
      'docker:containers:migrate',
      'docker:volumes:export',
      'docker:volumes:files:read',
      'docker:volumes:files:write',
      'databases:query:read',
      'databases:query:write',
      'databases:query:admin',
      'databases:credentials:reveal',
      'integrations:gitlab:repo:write',
      'integrations:gitlab:ci:edit',
      'integrations:gitlab:variables:edit',
      'integrations:gitlab:variables:delete',
      'integrations:gitlab:webhooks:manage',
      'integrations:gitlab:registry:manage',
      'integrations:gitlab:sandbox:clone',
      'logs:tokens:create',
      'admin:audit',
      'audit:siem:manage',
      'admin:details:certificates',
      'admin:update',
    ]);
    expect(MANUAL_APPROVAL_SCOPES).not.toContain('docker:containers:environment');
  });

  it('keeps SIEM read and configuration scopes distinct while allowing management to imply read', () => {
    expect(ALL_SCOPES).toContain('audit:siem:view');
    expect(ALL_SCOPES).toContain('audit:siem:manage');
    expect(MANUAL_APPROVAL_SCOPES).toContain('audit:siem:manage');
    expect(MANUAL_APPROVAL_SCOPES).not.toContain('audit:siem:view');
  });

  it('keeps backend and frontend resource-scopable lists aligned', () => {
    expect(frontendResourceScopableScopes()).toEqual([...RESOURCE_SCOPABLE]);
  });

  it('uses longest-match parsing for resource-scoped scopes', () => {
    expect(extractBaseScope('proxy:advanced:bypass:host-1')).toBe('proxy:advanced:bypass');
    expect(extractBaseScope('proxy:advanced:host-1')).toBe('proxy:advanced');
    expect(isValidBaseScope('admin:users:team-1')).toBe(false);
  });

  it('canonicalizes scopes with broad scopes winning over resource variants', () => {
    expect(canonicalizeScopes(['proxy:view:host-1', 'proxy:view', 'proxy:view:host-2'])).toEqual(['proxy:view']);
    expect(canonicalizeScopes(['proxy:view:host-2', 'proxy:view:host-1'])).toEqual([
      'proxy:view:host-1',
      'proxy:view:host-2',
    ]);
  });

  it('removes obsolete list scopes from stored scope-bearing tables', () => {
    const migration = listScopeRemovalMigration();

    for (const scope of [
      'pki:ca:list:root',
      'pki:ca:list:intermediate',
      'pki:cert:list',
      'pki:templates:list',
      'proxy:list',
      'ssl:cert:list',
      'acl:list',
      'nodes:list',
      'docker:containers:list',
      'docker:images:list',
      'docker:volumes:list',
      'docker:networks:list',
      'docker:registries:list',
      'databases:list',
      'notifications:alerts:list',
      'notifications:webhooks:list',
      'notifications:deliveries:list',
      'logs:environments:list',
      'logs:tokens:list',
      'logs:schemas:list',
    ]) {
      expect(migration).toContain(`('${scope}')`);
    }
    for (const table of [
      'permission_groups',
      'api_tokens',
      'oauth_authorization_codes',
      'oauth_refresh_tokens',
      'oauth_access_tokens',
    ]) {
      expect(migration).toContain(`UPDATE "${table}"`);
    }
    expect(migration).toContain('"requested_scopes"');
    expect(migration).toContain("scope_value LIKE obsolete.scope || ':%'");
    expect(migration).not.toContain('proxy:view');
  });

  it('models the stored-scope migration behavior for denied suffixes and overlapping resource scopes', () => {
    expect(
      migratedProgrammaticStoredScopes([
        'mcp:use:any',
        'admin:system:legacy',
        'proxy:raw:write:host-1',
        'proxy:advanced:bypass:host-1',
        'proxy:advanced:host-1',
        'proxy:advanced:bypasser',
        'proxy:view',
        'proxy:view:host-1',
        'unknown:scope',
      ])
    ).toEqual(['proxy:advanced:bypasser', 'proxy:advanced:host-1', 'proxy:view']);
  });
});
