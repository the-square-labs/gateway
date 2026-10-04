import { container } from '@/container.js';
import { AppError } from '@/middleware/error-handler.js';
import {
  assertContainerLinkEitherEndViewAccess,
  assertContainerLinkSourceAccess,
  assertContainerLinkTargetAccess,
  assertContainerLinkViewAccess,
} from '@/modules/docker/container-links/container-link-access.js';
import {
  CreateContainerLinkSchema,
  ListContainerLinksQuerySchema,
} from '@/modules/docker/container-links/container-links.schemas.js';
import { ContainerLinksService } from '@/modules/docker/container-links/container-links.service.js';
import type { User } from '@/types.js';

function hasEnvironment(environment: { host?: string; port?: string; url?: string } | undefined): boolean {
  return Boolean(environment && Object.values(environment).some(Boolean));
}

function requireLinkId(args: Record<string, unknown>): string {
  if (typeof args.linkId !== 'string' || !args.linkId) {
    throw new AppError(400, 'VALIDATION_ERROR', 'linkId is required');
  }
  return args.linkId;
}

/**
 * manage_container_link: the REST API of container links for the assistant and MCP, with the same access checks
 * (consumer edit, target link, view per end) and the license gates the service applies.
 */
export async function manageContainerLinkForAgent(user: User, args: Record<string, unknown>): Promise<unknown> {
  const scopes = user.scopes ?? [];
  const service = container.resolve(ContainerLinksService);
  switch (args.operation) {
    case 'list': {
      const query = ListContainerLinksQuerySchema.parse({
        nodeId: args.nodeId,
        type: args.type,
        resourceId: args.resourceId,
        direction: args.direction,
      });
      const ref = { nodeId: query.nodeId, type: query.type, resourceId: query.resourceId };
      await assertContainerLinkViewAccess(scopes, ref);
      return query.direction === 'incoming'
        ? service.listIncoming(ref.nodeId, ref.type, ref.resourceId)
        : service.listBySource(ref.nodeId, ref.type, ref.resourceId);
    }
    case 'create': {
      const input = CreateContainerLinkSchema.parse({
        sourceNodeId: args.sourceNodeId,
        sourceType: args.sourceType,
        sourceResourceId: args.sourceResourceId,
        targetNodeId: args.targetNodeId,
        targetType: args.targetType,
        targetResourceId: args.targetResourceId,
        targetPort: args.targetPort,
        alias: args.alias,
        environment: args.environment,
      });
      await assertContainerLinkSourceAccess(
        scopes,
        { nodeId: input.sourceNodeId, type: input.sourceType, resourceId: input.sourceResourceId },
        { environment: hasEnvironment(input.environment) }
      );
      await assertContainerLinkTargetAccess(scopes, {
        nodeId: input.targetNodeId,
        type: input.targetType,
        resourceId: input.targetResourceId,
      });
      return service.create(input, user.id);
    }
    case 'get_runtime': {
      const link = await service.get(requireLinkId(args));
      await assertContainerLinkEitherEndViewAccess(scopes, link);
      return service.getRuntime(link.id);
    }
    case 'delete': {
      const link = await service.get(requireLinkId(args));
      await assertContainerLinkSourceAccess(scopes, link.source, { environment: hasEnvironment(link.environment) });
      return service.delete(link.id, user.id);
    }
    default:
      throw new AppError(400, 'VALIDATION_ERROR', 'operation must be list, create, get_runtime or delete');
  }
}
