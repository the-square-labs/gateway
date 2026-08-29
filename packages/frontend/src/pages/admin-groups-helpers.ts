import { requiresResourceSelection, scopeMatches } from "@/lib/scope-utils";
import type { PermissionGroup } from "@/types";

export function isScopeSubset(requestedScopes: string[], allowedScopes: string[]): boolean {
  return requestedScopes.every((scope) => scopeMatches(allowedScopes, scope));
}

export function getGroupEffectiveScopes(group: PermissionGroup): string[] {
  return [...new Set([...group.scopes, ...(group.inheritedScopes ?? [])])];
}

export function formatGroupNameInput(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/g, "");
}

export function formatGroupName(value: string): string {
  return formatGroupNameInput(value).replace(/-+$/g, "");
}

export function findMissingRequiredResourceSelection(
  baseScopes: string[],
  resources: Record<string, string[]>,
  allowedResourceIdsByScope: Record<string, string[]>,
  initialResourceLimitedScopes: readonly string[]
): string | null {
  for (const scope of baseScopes) {
    if (
      requiresResourceSelection(scope, allowedResourceIdsByScope, initialResourceLimitedScopes) &&
      (resources[scope]?.length ?? 0) === 0
    ) {
      return scope;
    }
  }
  return null;
}
