import { describe, expect, it } from 'vitest';
import {
  boundScopes,
  canManageUser,
  canUseAI,
  hasAllScopes,
  hasAnyScope,
  hasScope,
  hasScopeBase,
  hasScopeForResource,
  isScopeSubset,
} from './permissions.js';

describe('Scope-based permissions', () => {
  describe('hasScope', () => {
    it('exact match', () => {
      expect(hasScope(['cert:read', 'cert:issue'], 'cert:issue')).toBe(true);
    });

    it('no match', () => {
      expect(hasScope(['cert:read'], 'cert:issue')).toBe(false);
    });

    it('hierarchical: parent grants child', () => {
      expect(hasScope(['nodes:details'], 'nodes:details:node-123')).toBe(true);
    });

    it('hierarchical: child does not grant parent', () => {
      expect(hasScope(['nodes:details:node-123'], 'nodes:details')).toBe(false);
    });

    it('hierarchical: exact resource match', () => {
      expect(hasScope(['nodes:details:node-123'], 'nodes:details:node-123')).toBe(true);
    });

    it('hierarchical: different resource no match', () => {
      expect(hasScope(['nodes:details:node-123'], 'nodes:details:node-456')).toBe(false);
    });

    it('lets a Docker node grant cover child resources without crossing nodes', () => {
      expect(hasScope(['docker:containers:view:node-1'], 'docker:containers:view:node-1/container-1')).toBe(true);
      expect(hasScope(['docker:containers:view:node-1/container-1'], 'docker:containers:view:node-1/container-2')).toBe(
        false
      );
      expect(hasScope(['docker:containers:view:node-1/container-1'], 'docker:containers:view:node-2/container-1')).toBe(
        false
      );
    });

    it('does not apply Docker child hierarchy to unrelated slash resource ids', () => {
      expect(hasScope(['proxy:view:folder'], 'proxy:view:folder/host')).toBe(false);
    });

    it('does not let an exact scope grant a different exact scope with the same prefix', () => {
      expect(hasScope(['proxy:advanced'], 'proxy:advanced:bypass')).toBe(false);
      expect(hasScope(['proxy:advanced:bypass'], 'proxy:advanced:bypass:host-1')).toBe(true);
      expect(hasScope(['proxy:raw:bypass'], 'proxy:raw:bypass:host-1')).toBe(true);
      expect(hasScope(['proxy:raw:bypass:host-1'], 'proxy:raw:bypass:host-1')).toBe(true);
      expect(hasScope(['proxy:raw:bypass:host-1'], 'proxy:raw:bypass:host-2')).toBe(false);
      expect(hasScope(['proxy:raw:bypass:host-1'], 'proxy:raw:write:host-1')).toBe(false);
      expect(hasScope(['proxy:raw:write:host-1'], 'proxy:raw:bypass:host-1')).toBe(false);
      expect(hasScope(['proxy:advanced:bypass:host-1'], 'proxy:raw:bypass:host-1')).toBe(false);
    });

    it('lets write scopes satisfy matching read scopes', () => {
      expect(hasScope(['settings:gateway:edit'], 'settings:gateway:view')).toBe(true);
      expect(hasScope(['proxy:edit'], 'proxy:view')).toBe(true);
      expect(hasScope(['proxy:edit'], 'proxy:view')).toBe(true);
      expect(hasScope(['databases:query:admin'], 'databases:query:read')).toBe(true);
      expect(hasScope(['inference:providers:manage'], 'inference:providers:view')).toBe(true);
      expect(hasScope(['inference:models:manage'], 'inference:providers:view')).toBe(true);
    });

    it('does not let create-only or destructive action scopes satisfy read scopes', () => {
      expect(hasScope(['proxy:create'], 'proxy:view')).toBe(false);
      expect(hasScope(['proxy:delete'], 'proxy:view')).toBe(false);
      expect(hasScope(['proxy:raw:write'], 'proxy:raw:read')).toBe(false);
      expect(hasScope(['proxy:raw:write:host-1'], 'proxy:raw:read:host-1')).toBe(false);
      expect(hasScope(['notifications:webhooks:create'], 'notifications:webhooks:view')).toBe(false);
      expect(hasScope(['databases:create'], 'databases:view')).toBe(false);
      expect(hasScope(['databases:credentials:reveal'], 'databases:view')).toBe(false);
      expect(hasScope(['databases:credentials:reveal:db-1'], 'databases:view:db-1')).toBe(false);
      expect(hasScope(['logs:schemas:delete'], 'logs:schemas:view')).toBe(false);
    });

    it('keeps write-to-read implications inside the same resource boundary', () => {
      expect(hasScope(['proxy:edit:host-1'], 'proxy:view:host-1')).toBe(true);
      expect(hasScope(['proxy:edit:host-1'], 'proxy:view:host-2')).toBe(false);
      expect(hasScope(['proxy:edit:host-1'], 'proxy:view')).toBe(false);
      expect(hasScope(['databases:query:admin:db-1'], 'databases:query:write:db-1')).toBe(true);
      expect(hasScope(['databases:query:read:db-1'], 'databases:view:db-1')).toBe(true);
      expect(hasScope(['logs:environments:edit:env-1'], 'logs:environments:view:env-1')).toBe(true);
      expect(hasScope(['databases:query:admin:db-1'], 'databases:query:write')).toBe(false);
    });

    it('empty scopes', () => {
      expect(hasScope([], 'cert:read')).toBe(false);
    });
  });

  describe('hasAnyScope', () => {
    it('matches one of many', () => {
      expect(hasAnyScope(['cert:read'], ['admin:users', 'cert:read'])).toBe(true);
    });

    it('matches none', () => {
      expect(hasAnyScope(['cert:read'], ['admin:users', 'admin:audit'])).toBe(false);
    });
  });

  describe('hasScopeBase', () => {
    it('matches resource-scoped variants without treating sibling scopes as matches', () => {
      expect(hasScopeBase(['proxy:edit:host-1'], 'proxy:edit')).toBe(true);
      expect(hasScopeBase(['proxy:edit:host-1'], 'proxy:view')).toBe(true);
      expect(hasScopeBase(['proxy:raw:write:host-1'], 'proxy:raw:read')).toBe(false);
      expect(hasScopeBase(['proxy:advanced:bypass:host-1'], 'proxy:advanced')).toBe(false);
    });
  });

  describe('hasScopeForResource', () => {
    it('matches broad and exact resource-scoped scopes only', () => {
      expect(hasScopeForResource(['proxy:edit'], 'proxy:edit', 'host-1')).toBe(true);
      expect(hasScopeForResource(['proxy:edit:host-1'], 'proxy:edit', 'host-1')).toBe(true);
      expect(hasScopeForResource(['proxy:edit:host-2'], 'proxy:edit', 'host-1')).toBe(false);
    });
  });

  describe('hasAllScopes', () => {
    it('has all', () => {
      expect(hasAllScopes(['cert:read', 'cert:issue'], ['cert:read', 'cert:issue'])).toBe(true);
    });

    it('missing one', () => {
      expect(hasAllScopes(['cert:read'], ['cert:read', 'cert:issue'])).toBe(false);
    });
  });

  describe('canUseAI', () => {
    it('user with feat:ai:use can use AI', () => {
      expect(canUseAI(['feat:ai:use', 'cert:read'])).toBe(true);
    });

    it('user without feat:ai:use cannot use AI', () => {
      expect(canUseAI(['cert:read', 'cert:issue'])).toBe(false);
    });
  });

  describe('isScopeSubset', () => {
    it('subset passes', () => {
      expect(isScopeSubset(['cert:read', 'cert:issue'], ['cert:read', 'cert:issue', 'ca:read'])).toBe(true);
    });

    it('resource-scoped is subset of parent', () => {
      expect(isScopeSubset(['nodes:details:node-123'], ['nodes:details'])).toBe(true);
    });

    it('non-subset fails', () => {
      expect(isScopeSubset(['admin:users'], ['cert:read', 'cert:issue'])).toBe(false);
    });
  });

  describe('boundScopes', () => {
    it('keeps exact scopes granted by both sides', () => {
      expect(boundScopes(['admin:users', 'nodes:details'], ['admin:users', 'nodes:details'])).toEqual([
        'admin:users',
        'nodes:details',
      ]);
    });

    it('downgrades a broad token to the current resource-scoped user permission', () => {
      expect(boundScopes(['nodes:details'], ['nodes:details:node-1'])).toEqual(['nodes:details:node-1']);
    });

    it('downgrades broad delegated read scopes to resource-scoped read scopes implied by write access', () => {
      expect(boundScopes(['proxy:view'], ['proxy:edit:host-1'])).toEqual(['proxy:view:host-1']);
      expect(boundScopes(['databases:view'], ['databases:edit:db-1'])).toEqual(['databases:view:db-1']);
      expect(boundScopes(['logs:environments:view'], ['logs:environments:edit:env-1'])).toEqual([
        'logs:environments:view:env-1',
      ]);
    });

    it('keeps a resource-scoped token when the current user still has the broad permission', () => {
      expect(boundScopes(['nodes:details:node-1'], ['nodes:details'])).toEqual(['nodes:details:node-1']);
    });

    it('does not bound a denied exact child scope from a grantable exact parent scope', () => {
      expect(boundScopes(['proxy:advanced'], ['proxy:advanced:bypass'])).toEqual([]);
    });

    it('removes delegated scopes no longer granted by the current user', () => {
      expect(boundScopes(['admin:users', 'nodes:details:node-1'], ['nodes:details:node-2'])).toEqual([]);
    });

    it('does not merge different resource scopes', () => {
      expect(boundScopes(['nodes:details:node-1'], ['nodes:details:node-2'])).toEqual([]);
    });
  });

  describe('canManageUser', () => {
    it('admin can manage operator', () => {
      const admin = ['admin:users', 'admin:system', 'cert:read', 'cert:issue'];
      const operator = ['cert:read', 'cert:issue'];
      expect(canManageUser(admin, operator)).toBe(null);
    });

    it('operator cannot manage admin (admin has scopes operator lacks)', () => {
      const operator = ['admin:users', 'cert:read', 'cert:issue'];
      const admin = ['admin:users', 'admin:system', 'cert:read', 'cert:issue'];
      expect(canManageUser(operator, admin)).toMatch(/system administrator/);
    });

    it('admin:system is a hard shield', () => {
      // Even if actor has MORE scopes overall, lacking admin:system blocks management
      const actor = ['admin:users', 'cert:read', 'cert:issue', 'proxy:manage', 'ssl:manage'];
      const target = ['admin:system', 'cert:read'];
      expect(canManageUser(actor, target)).toMatch(/system administrator/);
    });

    it('admin:system holder can manage another admin:system holder', () => {
      const actor = ['admin:users', 'admin:system', 'cert:read'];
      const target = ['admin:system', 'cert:read'];
      expect(canManageUser(actor, target)).toBe(null);
    });

    it('cannot manage user with scope you lack', () => {
      const actor = ['admin:users', 'cert:read'];
      const target = ['cert:read', 'cert:issue']; // actor lacks cert:issue
      expect(canManageUser(actor, target)).toMatch(/permissions you do not possess/);
    });

    it('equal scopes allows management', () => {
      const scopes = ['admin:users', 'cert:read', 'cert:issue'];
      expect(canManageUser(scopes, scopes)).toBe(null);
    });
  });
});
