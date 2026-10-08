import { scopeMatches } from "@/lib/scope-utils";
import type { PermissionGroup } from "@/types";

const BUILTIN_GROUP_ORDER = ["system-admin", "admin", "operator", "viewer", "guest"];

export function builtinGroupSortOrder(name: string): number {
  const index = BUILTIN_GROUP_ORDER.indexOf(name);
  return index < 0 ? BUILTIN_GROUP_ORDER.length : index;
}

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
