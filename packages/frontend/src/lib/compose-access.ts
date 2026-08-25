import { scopeMatches } from "@/lib/scope-utils";

export type ComposeProjectScope =
  | "docker:compose:view"
  | "docker:compose:create"
  | "docker:compose:manage"
  | "docker:compose:delete";

export function hasComposeProjectScope(
  scopes: readonly string[],
  baseScope: ComposeProjectScope,
  nodeId: string,
  projectId: string
) {
  return scopeMatches(scopes, `${baseScope}:${nodeId}/${projectId}`);
}

export function hasComposeNodeScope(
  scopes: readonly string[],
  baseScope: ComposeProjectScope,
  nodeId: string
) {
  return scopeMatches(scopes, `${baseScope}:${nodeId}`);
}

export function canAdoptComposeProject(
  scopes: readonly string[],
  nodeId: string,
  projectId: string
) {
  return (
    hasComposeProjectScope(scopes, "docker:compose:create", nodeId, projectId) &&
    hasComposeProjectScope(scopes, "docker:compose:manage", nodeId, projectId)
  );
}
