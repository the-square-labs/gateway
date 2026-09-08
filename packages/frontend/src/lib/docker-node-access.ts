import { deriveAllowedResourceIdsByScope, scopeMatches } from "@/lib/scope-utils";
import { api } from "@/services/api";
import type { Node } from "@/types";
import { isNodeIncompatible } from "@/types";

export const DOCKER_VIEW_NODE_SCOPES = [
  "docker:containers:view",
  "docker:images:view",
  "docker:volumes:view",
  "docker:networks:view",
  "docker:compose:view",
] as const;

export type DockerViewNodeScope = (typeof DOCKER_VIEW_NODE_SCOPES)[number];
type DockerNodeScope =
  | DockerViewNodeScope
  | "docker:containers:create"
  | "docker:compose:create"
  | "docker:networks:create"
  | "docker:volumes:create"
  | "docker:images:pull";

function hasScopedDockerNodes(
  scopes: readonly string[],
  scopeBases: readonly DockerNodeScope[]
): boolean {
  const allowedIds = deriveAllowedResourceIdsByScope(scopes);
  return scopeBases.some((scopeBase) => (allowedIds[scopeBase]?.length ?? 0) > 0);
}

function hasBroadDockerNodeAccess(
  scopes: readonly string[],
  scopeBases: readonly DockerNodeScope[]
) {
  return scopeBases.some(
    (scopeBase) =>
      scopeMatches(scopes, scopeBase) ||
      ((scopeBase.endsWith(":create") || scopeBase === "docker:images:pull") &&
        scopes.some((scope) => scope.startsWith(`${scopeBase}:folder/`)))
  );
}

function dockerNodeIdFromScopeResourceId(resourceId: string): string {
  if (resourceId.startsWith("node/")) return resourceId.slice("node/".length);
  if (resourceId.startsWith("folder/")) return "";
  const separator = resourceId.indexOf("/");
  return separator > 0 ? resourceId.slice(0, separator) : resourceId;
}

export async function loadVisibleDockerNodes(
  scopes: readonly string[],
  scopeBases: readonly DockerNodeScope[],
  canListNodes: boolean
): Promise<Node[]> {
  const shouldListNodes =
    canListNodes ||
    hasBroadDockerNodeAccess(scopes, scopeBases) ||
    hasScopedDockerNodes(scopes, scopeBases);
  if (!shouldListNodes) return [];

  const response = await api.listNodes({ type: "docker", limit: 100 });
  const hasBroadAccess = hasBroadDockerNodeAccess(scopes, scopeBases);
  const allowedIdsByScope = deriveAllowedResourceIdsByScope(scopes);
  const allowedNodeIds = new Set(
    scopeBases
      .flatMap((scopeBase) => allowedIdsByScope[scopeBase] ?? [])
      .map(dockerNodeIdFromScopeResourceId)
  );
  return response.data.filter(
    (node) =>
      node.status === "online" &&
      node.isConnected &&
      !isNodeIncompatible(node) &&
      (hasBroadAccess || allowedNodeIds.has(node.id))
  );
}
