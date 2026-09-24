import { container } from '@/container.js';
import { hasScope, hasScopeForCreation } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
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
  if (
    (input.displayName !== undefined || input.appearanceColor !== undefined || serviceAddressesUpdateRequested) &&
    !hasScope(scopes, `nodes:rename:${id}`)
  ) {
    throw new AppError(403, 'FORBIDDEN', 'Editing node identity or service addresses requires node rename access');
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
    if (!hasScope(scopes, `nodes:config:edit:${id}`)) {
      throw new AppError(403, 'FORBIDDEN', 'Editing Build Worker settings requires node config edit access');
    }
  }
  if (serviceAddressesUpdateRequested) {
    const current = await service.get(id);
    if (current.type === 'docker' && !hasScope(scopes, `docker:containers:config:${id}`)) {
      throw new AppError(403, 'FORBIDDEN', 'Editing the Docker service address requires Docker config access');
    }
    if (current.type === 'nginx' && !hasScope(scopes, `nodes:config:edit:${id}`)) {
      throw new AppError(403, 'FORBIDDEN', 'Editing the Nginx service address requires node config edit access');
    }
    if (current.type === 'nginx' && input.confirmDomainDnsUpdate && !hasScope(scopes, 'domains:edit')) {
      throw new AppError(403, 'FORBIDDEN', 'Updating assigned domain DNS targets requires domain edit access');
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
