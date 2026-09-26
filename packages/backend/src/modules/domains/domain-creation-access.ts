import { hasScope, hasScopeForCreation } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';

interface NodeOption {
  id: string;
}

interface NginxNodeOptions<TEligible extends NodeOption, TUnconfigured extends NodeOption> {
  eligibleNodes: TEligible[];
  unconfiguredNodes: TUnconfigured[];
  totalNginxNodes: number;
  unconfiguredNginxNodes: number;
}

/** A `<base>:folder/<id>` grant (kept next to its expanded form by the auth layer). */
function hasFolderCreationGrant(scopes: string[], baseScope: string): boolean {
  const prefix = `${baseScope}:folder/`;
  return scopes.some((scope) => scope.startsWith(prefix) && !scope.slice(prefix.length).includes('/'));
}

function hasAnyNodeDomainCreation(scopes: string[]): boolean {
  return hasScope(scopes, 'domains:create') || hasFolderCreationGrant(scopes, 'domains:create');
}

/**
 * Whether the caller may use this ingress node for a new domain (options, preview, create). Broad
 * and folder grants allow every node; node-only grants need the node named explicitly, so an
 * implicit single-node default never reveals a node outside the grant.
 */
export function canPickDomainNginxNode(scopes: string[], nodeId: string | null | undefined): boolean {
  if (hasAnyNodeDomainCreation(scopes)) return true;
  return !!nodeId && hasScopeForCreation(scopes, 'domains:create', null, nodeId);
}

/**
 * Ingress node options for domain creation, limited to what the caller may pick: broad and
 * folder domains:create grants allow every node, node-scoped grants (`domains:create:node/<id>`
 * or the legacy `domains:create:<id>`) only their nodes. Shared by REST and the AI/MCP tools.
 */
export function domainNginxNodeOptionsForScopes<TEligible extends NodeOption, TUnconfigured extends NodeOption>(
  options: NginxNodeOptions<TEligible, TUnconfigured>,
  scopes: string[]
): NginxNodeOptions<TEligible, TUnconfigured> {
  if (hasAnyNodeDomainCreation(scopes)) return options;
  const allowNode = (node: NodeOption) => canPickDomainNginxNode(scopes, node.id);
  const eligibleNodes = options.eligibleNodes.filter(allowNode);
  const unconfiguredNodes = options.unconfiguredNodes.filter(allowNode);
  return {
    ...options,
    eligibleNodes,
    unconfiguredNodes,
    totalNginxNodes: eligibleNodes.length + unconfiguredNodes.length,
    unconfiguredNginxNodes: unconfiguredNodes.length,
  };
}

interface NamedNginxNode {
  id: string;
  hostname: string;
  displayName: string | null;
}

const LISTED_NODES_IN_MESSAGE = 10;

/** The DOMAIN_NGINX_NODE_REQUIRED refusal: several ingress nodes qualify, so the caller must name one. */
export function domainNginxNodeRequiredError(eligibleNodes: readonly NamedNginxNode[]): AppError {
  const nodes = eligibleNodes.map((node) => ({ id: node.id, displayName: node.displayName, hostname: node.hostname }));
  const listed = nodes
    .slice(0, LISTED_NODES_IN_MESSAGE)
    .map((node) =>
      node.displayName && node.displayName !== node.hostname
        ? `${node.displayName} (${node.hostname}): ${node.id}`
        : `${node.hostname}: ${node.id}`
    )
    .join('; ');
  const more = nodes.length > LISTED_NODES_IN_MESSAGE ? `; and ${nodes.length - LISTED_NODES_IN_MESSAGE} more` : '';
  return new AppError(
    409,
    'DOMAIN_NGINX_NODE_REQUIRED',
    `nginxNodeId is required: ${nodes.length} Nginx ingress nodes with a public address can serve this domain. Pass nginxNodeId with one of: ${listed}${more}`,
    { eligibleNodes: nodes }
  );
}

/**
 * The ingress node of a domain created without nginxNodeId. A broad grant, or a grant on the
 * destination folder, covers every node: the service then picks the only node with a public address
 * or lists them. A caller limited to nodes (`domains:create:node/<id>`) gets its only such granted
 * node; several refuse with the list, none leaves it unset so the destination check refuses.
 */
export async function resolveDomainCreationNginxNodeId<TEligible extends NamedNginxNode>(
  scopes: string[],
  input: { nginxNodeId?: string; folderId?: string | null },
  loadOptions: () => Promise<{ eligibleNodes: TEligible[] }>
): Promise<string | undefined> {
  if (input.nginxNodeId) return input.nginxNodeId;
  if (hasScopeForCreation(scopes, 'domains:create', input.folderId ?? null)) return undefined;
  const nodeScoped = scopes.some(
    (scope) => scope.startsWith('domains:create:') && !scope.startsWith('domains:create:folder/')
  );
  if (!nodeScoped) return undefined;
  const candidates = (await loadOptions()).eligibleNodes.filter((node) =>
    hasScopeForCreation(scopes, 'domains:create', input.folderId ?? null, node.id)
  );
  if (candidates.length > 1) throw domainNginxNodeRequiredError(candidates);
  return candidates[0]?.id;
}

/**
 * Moving a domain's ingress to another node re-creates every covered route there, so it needs the
 * same grants as `PUT /proxy-hosts/:id {nodeId}`: proxy:create on the target for each route's
 * folder (broad, `folder/<id>`, `node/<id>` or the legacy bare node id) and proxy:edit on each
 * route (broad, per route or through its folder). A domain without routes needs some proxy:create
 * destination on the target node.
 */
export function assertDomainIngressMoveAccess(
  scopes: string[],
  targetNodeId: string,
  hosts: ReadonlyArray<{ id: string; folderId?: string | null }>
): void {
  const canCreateOnTarget = (folderId: string | null) =>
    hasScopeForCreation(scopes, 'proxy:create', folderId, targetNodeId);
  const allowed =
    hosts.length > 0
      ? hosts.every((host) => canCreateOnTarget(host.folderId ?? null))
      : canCreateOnTarget(null) || hasFolderCreationGrant(scopes, 'proxy:create');
  if (!allowed) {
    throw new AppError(403, 'FORBIDDEN', `Missing required scope: proxy:create:${targetNodeId}`);
  }
  const unauthorizedHost = hosts.find((host) => !hasScope(scopes, `proxy:edit:${host.id}`));
  if (unauthorizedHost) {
    throw new AppError(403, 'FORBIDDEN', `Missing required scope: proxy:edit:${unauthorizedHost.id}`);
  }
}
