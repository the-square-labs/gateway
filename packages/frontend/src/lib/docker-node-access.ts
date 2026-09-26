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
export type DockerCreationNodeScope =
  | "docker:containers:create"
  | "docker:compose:create"
  | "docker:networks:create"
  | "docker:volumes:create"
  | "docker:images:pull";
export type DockerNodeScope = DockerViewNodeScope | DockerCreationNodeScope;

/**
 * Mirrors the backend creation check for a node picker: broad, node or legacy node grants for that node, or any
 * folder grant (a folder creation grant works on every Docker node; the folder is chosen separately).
 */
export function canCreateDockerResourceOnNode(
  scopes: readonly string[],
  base: DockerCreationNodeScope,
  nodeId: string
): boolean {
  return (
    scopeMatches(scopes, base) ||
    scopeMatches(scopes, `${base}:${nodeId}`) ||
    scopeMatches(scopes, `${base}:node/${nodeId}`) ||
    scopes.some((scope) => scope.startsWith(`${base}:folder/`))
  );
}

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

/** Every Docker node, before access filtering. */
export async function fetchDockerNodeList(): Promise<Node[]> {
  const response = await api.listNodes({ type: "docker", limit: 100 });
  return response.data;
}

/**
 * The online, compatible Docker nodes the caller can use for these scopes.
 * `listNodes` supplies the unfiltered list; pass a shared one when several
 * scope sets are resolved at once, so the list is fetched a single time.
 */
export async function loadVisibleDockerNodes(
  scopes: readonly string[],
  scopeBases: readonly DockerNodeScope[],
  canListNodes: boolean,
  listNodes: () => Promise<Node[]> = fetchDockerNodeList
): Promise<Node[]> {
  const shouldListNodes =
    canListNodes ||
    hasBroadDockerNodeAccess(scopes, scopeBases) ||
    hasScopedDockerNodes(scopes, scopeBases);
  if (!shouldListNodes) return [];

  const nodes = await listNodes();
  const hasBroadAccess = hasBroadDockerNodeAccess(scopes, scopeBases);
  const allowedIdsByScope = deriveAllowedResourceIdsByScope(scopes);
  const allowedNodeIds = new Set(
    scopeBases
      .flatMap((scopeBase) => allowedIdsByScope[scopeBase] ?? [])
      .map(dockerNodeIdFromScopeResourceId)
  );
  return nodes.filter(
    (node) =>
      node.status === "online" &&
      node.isConnected &&
      !isNodeIncompatible(node) &&
      (hasBroadAccess || allowedNodeIds.has(node.id))
  );
}
