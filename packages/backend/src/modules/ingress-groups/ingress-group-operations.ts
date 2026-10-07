import { container } from '@/container.js';
import { hasScope, hasScopeBase } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import { DomainsService } from '@/modules/domains/domain.service.js';
import { canPickDomainNginxNode } from '@/modules/domains/domain-creation-access.js';
import { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import { ProxyService } from '@/modules/proxy/proxy.service.js';
import {
  AddIngressGroupMemberSchema,
  CreateIngressGroupSchema,
  IngressGroupListQuerySchema,
  RemoveIngressGroupMemberSchema,
  ReorderIngressGroupSchema,
  UpdateIngressGroupSchema,
} from './ingress-group.schemas.js';
import { IngressGroupService } from './ingress-group.service.js';
import {
  assertCanManageIngressGroup,
  assertCanManageMemberNode,
  assertCanPlaceOnMembers,
  canViewIngressGroup,
  INGRESS_GROUP_MANAGE_SCOPE,
  INGRESS_GROUP_VIEW_SCOPE,
  viewableIngressGroupFolderIds,
} from './ingress-group-access.js';

/**
 * Ingress group operations with their permission and entitlement checks, shared by the REST routes and the
 * `manage_ingress_group` AI/MCP tool so both refuse and allow exactly the same calls.
 *
 * Creating a group or changing its runtime (members, order, placing routes and domains on it) needs the
 * multi-node availability entitlement. Deleting a group and removing a member shrink the runtime and are allowed
 * without it, so a lapsed license never blocks scaling down; existing groups keep serving (S11).
 */
export interface IngressGroupActor {
  scopes: readonly string[];
  userId: string;
}

function service() {
  return container.resolve(IngressGroupService);
}

async function requireGroupEntitlement() {
  await container.resolve(LicensePolicyService).requireFeature('multi-node-availability');
}

function requireAnyBase(scopes: readonly string[], bases: readonly string[]) {
  if (bases.some((base) => hasScopeBase([...scopes], base))) return;
  throw new AppError(403, 'FORBIDDEN', `Missing required scope: ${bases.join(' or ')}`, { requiredScope: bases[0] });
}

async function requireManageableGroup(scopes: readonly string[], id: string) {
  const group = await service().requireGroup(id);
  assertCanManageIngressGroup(scopes, group.folderId);
  return group;
}

export async function listIngressGroupsFor(scopes: readonly string[], rawQuery: unknown) {
  requireAnyBase(scopes, [INGRESS_GROUP_VIEW_SCOPE, INGRESS_GROUP_MANAGE_SCOPE]);
  const query = IngressGroupListQuerySchema.parse(rawQuery ?? {});
  const folderIds = viewableIngressGroupFolderIds(scopes);
  const groups = await service().list(query);
  return folderIds === null ? groups : groups.filter((group) => group.folderId && folderIds.includes(group.folderId));
}

export async function getIngressGroupFor(scopes: readonly string[], id: string) {
  requireAnyBase(scopes, [INGRESS_GROUP_VIEW_SCOPE, INGRESS_GROUP_MANAGE_SCOPE]);
  const group = await service().requireGroup(id);
  if (!canViewIngressGroup(scopes, group.folderId)) {
    throw new AppError(404, 'INGRESS_GROUP_NOT_FOUND', 'Ingress group not found');
  }
  return service().get(group.id);
}

export async function createIngressGroupFor(actor: IngressGroupActor, raw: unknown) {
  const input = CreateIngressGroupSchema.parse(raw);
  assertCanManageIngressGroup(actor.scopes, input.folderId ?? null);
  for (const nodeId of input.nodeIds) assertCanManageMemberNode(actor.scopes, nodeId);
  await requireGroupEntitlement();
  return service().create(input, actor.userId);
}

export async function updateIngressGroupFor(actor: IngressGroupActor, id: string, raw: unknown) {
  const input = UpdateIngressGroupSchema.parse(raw);
  await requireManageableGroup(actor.scopes, id);
  if (input.folderId !== undefined) assertCanManageIngressGroup(actor.scopes, input.folderId);
  await requireGroupEntitlement();
  return service().update(id, input, actor.userId);
}

export async function deleteIngressGroupFor(actor: IngressGroupActor, id: string) {
  await requireManageableGroup(actor.scopes, id);
  await service().delete(id, actor.userId);
}

export async function addIngressGroupMemberFor(actor: IngressGroupActor, id: string, raw: unknown) {
  const input = AddIngressGroupMemberSchema.parse(raw);
  await requireManageableGroup(actor.scopes, id);
  assertCanManageMemberNode(actor.scopes, input.nodeId);
  await requireGroupEntitlement();
  return service().addMember(id, input, actor.userId);
}

export async function removeIngressGroupMemberFor(actor: IngressGroupActor, id: string, nodeId: string, raw: unknown) {
  await requireManageableGroup(actor.scopes, id);
  const input = RemoveIngressGroupMemberSchema.parse(raw ?? {});
  return service().removeMember(id, nodeId, input, actor.userId);
}

export async function reorderIngressGroupFor(actor: IngressGroupActor, id: string, raw: unknown) {
  const input = ReorderIngressGroupSchema.parse(raw);
  await requireManageableGroup(actor.scopes, id);
  await requireGroupEntitlement();
  return service().reorder(id, input.nodeIds, actor.userId);
}

/** Places an existing route on the group: proxy:edit on the route and proxy:create covering every member. */
export async function convertRouteToIngressGroupFor(actor: IngressGroupActor, id: string, proxyHostId: string) {
  if (!hasScope(actor.scopes, `proxy:edit:${proxyHostId}`)) {
    throw new AppError(403, 'FORBIDDEN', 'Moving a route requires proxy:edit on it', {
      requiredScope: `proxy:edit:${proxyHostId}`,
    });
  }
  const group = await service().getSummary(id);
  const host = await container.resolve(ProxyService).getProxyHost(proxyHostId);
  assertCanPlaceOnMembers(
    actor.scopes,
    'proxy:create',
    (host as { folderId?: string | null }).folderId ?? null,
    group.members.map((member) => member.nodeId)
  );
  await requireGroupEntitlement();
  return service().convertRoute(proxyHostId, { ingressGroupId: id }, actor.userId);
}

/** Places an existing domain (and its routes) on the group: domains:edit on it and domains:create on every member. */
export async function convertDomainToIngressGroupFor(actor: IngressGroupActor, id: string, domainId: string) {
  if (!hasScope(actor.scopes, `domains:edit:${domainId}`)) {
    throw new AppError(403, 'FORBIDDEN', 'Moving a domain requires domains:edit on it', {
      requiredScope: `domains:edit:${domainId}`,
    });
  }
  const group = await service().getSummary(id);
  const domain = await container.resolve(DomainsService).getDomain(domainId);
  assertCanPlaceOnMembers(
    actor.scopes,
    'domains:create',
    domain.folderId ?? null,
    group.members.map((member) => member.nodeId)
  );
  await requireGroupEntitlement();
  return service().convertDomain(domainId, { ingressGroupId: id }, actor.userId);
}

/**
 * Moving a domain onto an ingress group places it (and its routes) on every member: domains:create must cover each
 * member, and the entitlement is required. Moving it back to one member node only shrinks the runtime and needs
 * neither.
 */
export async function assertDomainPlacementAccess(
  scopes: readonly string[],
  domainId: string,
  input: { ingressGroupId?: string | null }
): Promise<void> {
  if (!input.ingressGroupId) return;
  const domain = await container.resolve(DomainsService).getDomain(domainId);
  const members = await service().memberNodeIds(input.ingressGroupId);
  assertCanPlaceOnMembers(scopes, 'domains:create', domain.folderId ?? null, members);
  await requireGroupEntitlement();
}

/** A new domain on an ingress group is served by every member: domains:create must cover each of them. */
export async function assertDomainCreationOnGroup(
  scopes: readonly string[],
  ingressGroupId: string,
  folderId: string | null | undefined
): Promise<void> {
  const members = await service().memberNodeIds(ingressGroupId);
  assertCanPlaceOnMembers(scopes, 'domains:create', folderId, members);
  await requireGroupEntitlement();
}

/** Moving a route onto an ingress group creates it on every member (entitlement required). */
export async function assertRoutePlacementOnGroup(
  scopes: readonly string[],
  ingressGroupId: string,
  folderId: string | null | undefined
): Promise<string[]> {
  const members = await service().memberNodeIds(ingressGroupId);
  assertCanPlaceOnMembers(scopes, 'proxy:create', folderId, members);
  await requireGroupEntitlement();
  return members;
}

/**
 * Who may preview (or be offered) a new domain's DNS: the preview returns node hostnames and addresses, so a caller
 * limited to nodes may use only nodes of its grant; for an ingress group every member must be one.
 */
export async function assertCanPreviewDomainDestination(
  scopes: readonly string[],
  input: { nginxNodeId?: string; ingressGroupId?: string }
): Promise<void> {
  const nodeIds = input.ingressGroupId ? await service().memberNodeIds(input.ingressGroupId) : [input.nginxNodeId];
  const refused = nodeIds.findIndex((nodeId) => !canPickDomainNginxNode([...scopes], nodeId));
  if (refused === -1 && nodeIds.length > 0) return;
  const nodeId = nodeIds[refused];
  throw new AppError(403, 'FORBIDDEN', 'Missing domains:create permission for the selected Nginx node', {
    requiredScope: nodeId ? `domains:create:node/${nodeId}` : 'domains:create',
  });
}
