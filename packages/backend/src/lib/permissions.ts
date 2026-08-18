/**
 * Scope-based permission helpers.
 * Replaces the old role-based helpers (hasRole, canManageCAs, etc.)
 */

import { isFolderScopedScope } from './folder-scopes.js';
import { extractBaseScope, isValidBaseScope } from './scopes.js';

function parentResourceId(baseScope: string, resourceId: string | null): string | null {
  if (!baseScope.startsWith('docker:containers:')) return null;
  if (!resourceId) return null;
  const separator = resourceId.indexOf('/');
  return separator > 0 ? resourceId.slice(0, separator) : null;
}

const IMPLIED_SCOPES_BY_REQUIRED_SCOPE: Record<string, readonly string[]> = {
  'domains:view': ['domains:edit'],
  'pki:templates:view': ['pki:templates:edit'],
  'proxy:view': ['proxy:edit'],
  'pages:view': [
    'pages:edit',
    'pages:delete',
    'pages:deploy',
    'pages:deployments:manage',
    'pages:tags:manage',
    'pages:tokens:manage',
  ],
  'pages:settings:view': ['pages:settings:edit'],
  'proxy:templates:view': ['proxy:templates:edit'],
  'acl:view': ['acl:edit'],
  'nodes:details': ['nodes:rename'],
  'nodes:config:view': ['nodes:config:edit'],
  'settings:gateway:view': ['settings:gateway:edit'],
  'housekeeping:view': ['housekeeping:run', 'housekeeping:configure'],
  'license:view': ['license:manage'],
  'docker:containers:view': [
    'docker:containers:edit',
    'docker:containers:config',
    'docker:containers:manage',
    'docker:containers:console',
    'docker:containers:files',
    'docker:containers:environment',
    'docker:containers:secrets',
    'docker:containers:webhooks',
  ],
  'docker:networks:view': ['docker:networks:edit'],
  'docker:registries:view': ['docker:registries:edit'],
  'databases:view': ['databases:edit', 'databases:query:read', 'databases:query:write', 'databases:query:admin'],
  'databases:query:read': ['databases:query:write', 'databases:query:admin'],
  'databases:query:write': ['databases:query:admin'],
  'notifications:alerts:view': ['notifications:alerts:edit'],
  'notifications:webhooks:view': ['notifications:webhooks:edit'],
  'notifications:view': ['notifications:manage'],
  'audit:siem:view': ['audit:siem:manage'],
  'logs:environments:view': ['logs:environments:edit', 'logs:read'],
  'logs:tokens:view': ['logs:manage'],
  'logs:schemas:view': ['logs:schemas:edit'],
  'logs:read': ['logs:manage'],
  'status-page:view': ['status-page:manage'],
  'integrations:cloudflare:view': ['integrations:cloudflare:manage'],
  'integrations:github:view': ['integrations:github:manage'],
  'integrations:git:view': ['integrations:git:manage'],
  'integrations:ssh:view': ['integrations:ssh:manage'],
  'integrations:cloudflare:dns:view': [
    'integrations:cloudflare:manage',
    'integrations:cloudflare:dns:edit',
    'integrations:cloudflare:dns:delete',
  ],
  'inference:providers:view': ['inference:providers:manage', 'inference:models:manage'],
};

function hasImpliedScope(scopes: readonly string[], requiredScope: string): boolean {
  const requiredBase = extractBaseScope(requiredScope);
  const impliedScopes = getTransitiveImpliedScopes(requiredBase);
  if (impliedScopes.length === 0) return false;

  const resourceId = requiredBase === requiredScope ? null : requiredScope.slice(requiredBase.length + 1);
  const parentId = parentResourceId(requiredBase, resourceId);
  for (const impliedScope of impliedScopes) {
    if (scopes.includes(impliedScope)) return true;
    if (resourceId && scopes.includes(`${impliedScope}:${resourceId}`)) return true;
    if (parentId && scopes.includes(`${impliedScope}:${parentId}`)) return true;
  }
  return false;
}

function getTransitiveImpliedScopes(requiredBase: string): string[] {
  const result = new Set<string>();
  const queue = [...(IMPLIED_SCOPES_BY_REQUIRED_SCOPE[requiredBase] ?? [])];
  for (let index = 0; index < queue.length; index += 1) {
    const scope = queue[index];
    if (result.has(scope)) continue;
    result.add(scope);
    queue.push(...(IMPLIED_SCOPES_BY_REQUIRED_SCOPE[scope] ?? []));
  }
  return [...result];
}

/**
 * Check if a set of scopes grants a required permission.
 * Supports hierarchical matching: 'cert:issue' grants 'cert:issue:ca-123'
 */
export function hasScope(scopes: string[], requiredScope: string): boolean {
  if (scopes.includes(requiredScope)) return true;

  const baseScope = extractBaseScope(requiredScope);
  if (baseScope !== requiredScope) {
    if (scopes.includes(baseScope)) return true;
    const resourceId = requiredScope.slice(baseScope.length + 1);
    const parentId = parentResourceId(baseScope, resourceId);
    if (parentId && scopes.includes(`${baseScope}:${parentId}`)) return true;
    return hasImpliedScope(scopes, requiredScope);
  }

  if (hasImpliedScope(scopes, requiredScope)) return true;

  if (isValidBaseScope(requiredScope)) return false;

  const parts = requiredScope.split(':');
  for (let i = parts.length - 1; i >= 1; i--) {
    const prefix = parts.slice(0, i).join(':');
    if (scopes.includes(prefix)) return true;
  }

  return false;
}

/** Check if scopes contain a broad scope or any resource-scoped variant of it. */
export function hasScopeBase(scopes: string[], baseScope: string): boolean {
  if (hasScope(scopes, baseScope)) return true;
  return scopes.some((scope) => {
    const scopeBase = extractBaseScope(scope);
    if (scope === scopeBase) return false;
    const resourceId = scope.slice(scopeBase.length + 1);
    return hasScope([scope], `${baseScope}:${resourceId}`);
  });
}

/** Check if scopes grant a broad scope or a specific resource-scoped variant. */
export function hasScopeForResource(scopes: string[], baseScope: string, resourceId: string): boolean {
  return hasScope(scopes, baseScope) || (!!resourceId && hasScope(scopes, `${baseScope}:${resourceId}`));
}

/** Return resource IDs from scoped grants that satisfy baseScope:<id>. */
export function getResourceScopedIds(scopes: readonly string[], baseScope: string): string[] {
  const ids = new Set<string>();
  for (const scope of scopes) {
    if (isFolderScopedScope(scope)) continue;
    const scopeBase = extractBaseScope(scope);
    if (scope === scopeBase) continue;
    const resourceId = scope.slice(scopeBase.length + 1);
    if (resourceId && hasScope([scope], `${baseScope}:${resourceId}`)) ids.add(resourceId);
  }
  return [...ids];
}

/** Check if scopes grant any of the required scopes */
export function hasAnyScope(scopes: string[], requiredScopes: string[]): boolean {
  return requiredScopes.some((s) => hasScope(scopes, s));
}

/** Check if scopes grant all of the required scopes */
export function hasAllScopes(scopes: string[], requiredScopes: string[]): boolean {
  return requiredScopes.every((s) => hasScope(scopes, s));
}

/** Check if a user can use the AI assistant */
export function canUseAI(scopes: string[]): boolean {
  return hasScope(scopes, 'feat:ai:use');
}

/** Check if all requested scopes are a subset of the allowed scopes */
export function isScopeSubset(requestedScopes: string[], allowedScopes: string[]): boolean {
  return requestedScopes.every((s) => hasScope(allowedScopes, s));
}

/**
 * Bound delegated scopes by the principal's current scopes.
 *
 * This is not a simple array intersection because scopes are hierarchical:
 * a broad token scope plus a resource-scoped user scope should still allow
 * that specific resource, and vice versa.
 */
export function boundScopes(delegatedScopes: string[], principalScopes: string[]): string[] {
  const bounded = new Set<string>();

  for (const scope of delegatedScopes) {
    if (hasScope(principalScopes, scope)) bounded.add(scope);
  }

  for (const scope of principalScopes) {
    const scopeBase = extractBaseScope(scope);
    if (
      delegatedScopes.some(
        (delegatedScope) => extractBaseScope(delegatedScope) === scopeBase && hasScope([delegatedScope], scope)
      )
    ) {
      bounded.add(scope);
    }
  }

  for (const delegatedScope of delegatedScopes) {
    const delegatedBase = extractBaseScope(delegatedScope);
    if (delegatedScope !== delegatedBase) continue;

    for (const principalScope of principalScopes) {
      const principalBase = extractBaseScope(principalScope);
      if (principalScope === principalBase) continue;
      const resourceId = principalScope.slice(principalBase.length + 1);
      const narrowedDelegatedScope = `${delegatedBase}:${resourceId}`;
      if (hasScope([principalScope], narrowedDelegatedScope)) bounded.add(narrowedDelegatedScope);
    }
  }

  return [...bounded];
}

/**
 * Check if actor can manage target based on scope containment.
 * Returns null if allowed, or an error message string if denied.
 *
 * Rules:
 * 1. Target has admin:system → actor must also have admin:system
 * 2. Target's scopes must be a subset of actor's scopes
 *    (you can't touch someone who has permissions you lack)
 */
export function canManageUser(actorScopes: string[], targetScopes: string[]): string | null {
  // Rule 1: admin:system is a hard shield
  if (targetScopes.includes('admin:system') && !actorScopes.includes('admin:system')) {
    return 'Cannot manage a system administrator';
  }

  // Rule 2: target's scopes must be contained by actor's scopes
  if (!isScopeSubset(targetScopes, actorScopes)) {
    return 'Cannot manage a user with permissions you do not possess';
  }

  return null;
}
