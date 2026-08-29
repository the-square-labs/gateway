/**
 * Unified scope definitions for group and user-specific permissions.
 * Both session users (via group membership) and API tokens use these scopes.
 *
 * Naming convention: domain:resource:action[:qualifier]
 * Resource-scopable scopes support suffixes: e.g. docker:containers:view:node-uuid
 */

import { ALL_SCOPES, MCP_EXTERNAL_INTEGRATION_SCOPE_PREFIXES, PROGRAMMATIC_DENIED_SCOPE_SET } from './scopes-base.js';
import { RESOURCE_SCOPABLE } from './scopes-resource.js';

export * from './scopes-base.js';
export * from './scopes-builtins.js';
export * from './scopes-resource.js';

const ALL_SCOPES_SET = new Set<string>(ALL_SCOPES);
const RESOURCE_SCOPABLE_SET = new Set<string>(RESOURCE_SCOPABLE);
const RESOURCE_SCOPABLE_BY_LENGTH = [...RESOURCE_SCOPABLE].sort((a, b) => b.length - a.length);

export const MANUAL_APPROVAL_SCOPES = [
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
] as const;
export const MANUAL_APPROVAL_SCOPE_SET = new Set<string>(MANUAL_APPROVAL_SCOPES);

/** Extract the base scope from a potentially resource-scoped string */
export function extractBaseScope(scope: string): string {
  if (ALL_SCOPES_SET.has(scope)) return scope;
  for (const base of RESOURCE_SCOPABLE_BY_LENGTH) {
    if (scope.startsWith(`${base}:`) && scope.length > base.length + 1) {
      return base;
    }
  }
  return scope;
}

/** Check if a scope string has a valid base scope */
export function isValidBaseScope(scope: string): boolean {
  const base = extractBaseScope(scope);
  return ALL_SCOPES_SET.has(base) && (scope === base || RESOURCE_SCOPABLE_SET.has(base));
}

/** Check whether a scope may be delegated to an API token */
export function isApiTokenScope(scope: string): boolean {
  return isValidBaseScope(scope) && !PROGRAMMATIC_DENIED_SCOPE_SET.has(extractBaseScope(scope));
}

/** Gateway MCP controls Gateway; source-control and SSH access belongs to dedicated MCP servers. */
export function isMcpTokenScope(scope: string): boolean {
  if (!isApiTokenScope(scope) || scope === 'mcp:use') return false;
  const baseScope = extractBaseScope(scope);
  return !MCP_EXTERNAL_INTEGRATION_SCOPE_PREFIXES.some((prefix) => baseScope.startsWith(prefix));
}

/** Check if a scope string is a resource-scoped variant */
export function isResourceScoped(scope: string): boolean {
  const base = extractBaseScope(scope);
  return scope !== base && RESOURCE_SCOPABLE.includes(base);
}

/** Canonicalize valid scopes so broad scopes win over resource-scoped variants. */
export function canonicalizeScopes(scopes: readonly string[]): string[] {
  const exactScopes = new Set<string>();
  const resourceScopedByBase = new Map<string, Set<string>>();

  for (const rawScope of scopes) {
    const scope = rawScope.trim();
    if (!scope || !isValidBaseScope(scope)) continue;
    const base = extractBaseScope(scope);
    if (scope === base) {
      exactScopes.add(scope);
      continue;
    }
    if (!resourceScopedByBase.has(base)) resourceScopedByBase.set(base, new Set());
    resourceScopedByBase.get(base)!.add(scope);
  }

  const canonical = new Set<string>(exactScopes);
  for (const [base, scopedVariants] of resourceScopedByBase.entries()) {
    if (exactScopes.has(base)) continue;
    for (const scope of scopedVariants) canonical.add(scope);
  }

  return [...canonical].sort();
}

export function withoutManualApprovalScopes(scopes: readonly string[]): string[] {
  return scopes.filter((scope) => !MANUAL_APPROVAL_SCOPE_SET.has(extractBaseScope(scope)));
}
