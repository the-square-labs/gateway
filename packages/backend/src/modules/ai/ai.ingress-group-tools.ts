import { AppError } from '@/middleware/error-handler.js';
import {
  addIngressGroupMemberFor,
  convertDomainToIngressGroupFor,
  convertRouteToIngressGroupFor,
  createIngressGroupFor,
  deleteIngressGroupFor,
  getIngressGroupFor,
  listIngressGroupsFor,
  removeIngressGroupMemberFor,
  reorderIngressGroupFor,
  updateIngressGroupFor,
} from '@/modules/ingress-groups/ingress-group-operations.js';
import { redactProxyHostForScopes } from '@/modules/proxy/page-target-visibility.js';
import type { User } from '@/types.js';
import { compactProxyHostForAgent } from './ai.service-helpers.js';

export const INGRESS_GROUP_TOOL_NAMES = new Set(['manage_ingress_group']);

function requiredString(value: unknown, field: string, operation: string): string {
  if (typeof value === 'string' && value) return value;
  throw new AppError(400, 'VALIDATION_ERROR', `${field} is required for ${operation}`);
}

/** Only the fields an operation takes, so a stray argument never reaches a schema that would accept it. */
function pick(a: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(fields.filter((field) => a[field] !== undefined).map((field) => [field, a[field]]));
}

/**
 * manage_ingress_group: the same operations, permission checks and entitlement checks as /api/ingress-groups.
 */
export async function executeIngressGroupTool(user: User, args: Record<string, unknown>): Promise<unknown> {
  const operation = String(args.operation ?? '');
  const actor = { scopes: user.scopes, userId: user.id };
  const groupId = () => requiredString(args.groupId, 'groupId', operation);
  switch (operation) {
    case 'list':
      return { data: await listIngressGroupsFor(user.scopes, pick(args, ['search', 'folderId'])) };
    case 'get':
      return getIngressGroupFor(user.scopes, groupId());
    case 'create':
      return createIngressGroupFor(actor, pick(args, ['name', 'description', 'folderId', 'nodeIds']));
    case 'update':
      return updateIngressGroupFor(
        actor,
        groupId(),
        pick(args, ['name', 'description', 'folderId', 'dnsFailoverMode'])
      );
    case 'delete':
      await deleteIngressGroupFor(actor, groupId());
      return { success: true };
    case 'add_member':
      return addIngressGroupMemberFor(actor, groupId(), pick(args, ['nodeId', 'position']));
    case 'remove_member':
      return removeIngressGroupMemberFor(
        actor,
        groupId(),
        requiredString(args.nodeId, 'nodeId', operation),
        pick(args, ['force'])
      );
    case 'reorder':
      return reorderIngressGroupFor(actor, groupId(), pick(args, ['nodeIds']));
    case 'convert_route': {
      const host = await convertRouteToIngressGroupFor(
        actor,
        groupId(),
        requiredString(args.proxyHostId, 'proxyHostId', operation)
      );
      return compactProxyHostForAgent(redactProxyHostForScopes(host as Record<string, any>, user.scopes));
    }
    case 'convert_domain':
      return convertDomainToIngressGroupFor(actor, groupId(), requiredString(args.domainId, 'domainId', operation));
    default:
      throw new AppError(400, 'VALIDATION_ERROR', `Unsupported ingress group operation: ${operation}`);
  }
}
