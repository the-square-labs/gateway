import { container } from '@/container.js';
import { hasScope, hasScopeBase, hasScopeForCreation } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import { assertNodeDomainDnsUpdateAccess } from '@/modules/domains/domain-dns-access.js';
import { NodeFolderService } from './node-folders.service.js';
import type { CreateNodeInput, UpdateNodeInput } from './nodes.schemas.js';
import { NodesService } from './nodes.service.js';

/**
 * Node creation and edits shared by /api/nodes and the AI/MCP tools, so both
 * enforce the same destination and per-field permissions.
 */
export interface NodeActor {
  id: string;
  /** Effective scopes of the request (bounded for programmatic callers). */
  scopes: string[];
}

export async function createNodeForActor(actor: NodeActor, input: CreateNodeInput, nodesService?: NodesService) {
  if (!hasScopeForCreation(actor.scopes, 'nodes:create', input.folderId)) {
    throw new AppError(403, 'FORBIDDEN', 'Missing nodes:create permission for the selected destination');
  }
  if (input.folderId) await container.resolve(NodeFolderService).assertFolderExists(input.folderId);
  return (nodesService ?? container.resolve(NodesService)).create(input, actor.id);
}

/**
 * A new enrollment token is for a node that has not enrolled yet, so it is part of creating or managing that node:
 * the actor needs nodes:create where the node sits (broadly, on its folder, or the legacy per-node grant) or
 * nodes:manage for the node. Folder-only creators and managers can therefore finish enrolling the nodes of their
 * folders, including ones created by someone else.
 */
export async function regenerateNodeEnrollmentTokenForActor(actor: NodeActor, id: string, nodesService?: NodesService) {
  const denied = () => new AppError(403, 'FORBIDDEN', `Missing required scope: nodes:create:${id}`);
  const service = nodesService ?? container.resolve(NodesService);
  if (hasScope(actor.scopes, `nodes:manage:${id}`)) return service.regenerateEnrollmentToken(id, actor.id);
  // Without any creation grant the node is not even looked up, so its existence stays hidden.
  if (!hasScopeBase(actor.scopes, 'nodes:create')) throw denied();
  let folderId: string | null;
  try {
    ({ folderId } = await service.get(id));
  } catch (error) {
    if (!hasScope(actor.scopes, 'nodes:create')) throw denied();
    throw error;
  }
  if (!hasScopeForCreation(actor.scopes, 'nodes:create', folderId, id)) throw denied();
  return service.regenerateEnrollmentToken(id, actor.id);
}

export async function updateNodeForActor(
  actor: NodeActor,
  id: string,
  input: UpdateNodeInput,
  nodesService?: NodesService
) {
  const service = nodesService ?? container.resolve(NodesService);
  const scopes = actor.scopes;
  const serviceAddressesUpdateRequested =
    input.serviceAddresses !== undefined ||
    input.serviceAddress !== undefined ||
    input.secondaryServiceAddress !== undefined;
  // Authorization is per field, so a patch must carry at least one field: an empty
  // patch or a bare confirmDomainDnsUpdate would otherwise pass every check below.
  if (
    input.displayName === undefined &&
    input.appearanceColor === undefined &&
    input.builderSettings === undefined &&
    !serviceAddressesUpdateRequested
  ) {
    throw new AppError(400, 'NO_NODE_CHANGES', 'Provide at least one node field to update');
  }
  if (
    (input.displayName !== undefined || input.appearanceColor !== undefined) &&
    !hasScope(scopes, `nodes:rename:${id}`)
  ) {
    throw new AppError(403, 'FORBIDDEN', 'Editing node identity requires node rename access');
  }
  if (input.builderSettings !== undefined) {
    const current = await service.get(id);
    if (current.type !== 'builder') {
      throw new AppError(
        400,
        'INVALID_BUILDER_SETTINGS_NODE',
        'Build settings are only supported for Build Worker nodes'
      );
    }
    if (!hasScope(scopes, `nodes:manage:${id}`)) {
      throw new AppError(403, 'FORBIDDEN', 'Editing Build Worker settings requires node manage access');
    }
  }
  if (serviceAddressesUpdateRequested) {
    const current = await service.get(id);
    // The service address is node configuration, not a container setting or the node's identity: every node type
    // that has one (Docker, Nginx, database and storage nodes) needs node manage, and only that.
    if (['docker', 'nginx', 'databases', 'storage'].includes(current.type) && !hasScope(scopes, `nodes:manage:${id}`)) {
      throw new AppError(403, 'FORBIDDEN', 'Editing the node service address requires node manage access');
    }
    if (current.type === 'nginx' && input.confirmDomainDnsUpdate) {
      await assertNodeDomainDnsUpdateAccess(id, scopes);
    }
    if (
      current.type !== 'docker' &&
      current.type !== 'databases' &&
      current.type !== 'storage' &&
      current.type !== 'nginx'
    ) {
      throw new AppError(
        400,
        'INVALID_SERVICE_ADDRESS_NODE',
        'Service address is only supported for Docker, database, and Nginx nodes'
      );
    }
    if (input.secondaryServiceAddress !== undefined && current.type !== 'nginx') {
      throw new AppError(
        400,
        'INVALID_SECONDARY_SERVICE_ADDRESS_NODE',
        'Secondary service address is only supported for Nginx nodes'
      );
    }
  }
  return service.update(id, input, actor.id);
}
