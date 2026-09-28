import { OpenAPIHono } from '@hono/zod-openapi';
import { container } from '@/container.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import { hasScope } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import { authMiddleware, requireAnyScopeBase } from '@/modules/auth/auth.middleware.js';
import { DomainsService } from '@/modules/domains/domain.service.js';
import { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import { ProxyService } from '@/modules/proxy/proxy.service.js';
import type { AppEnv } from '@/types.js';
import {
  addIngressGroupMemberRoute,
  convertDomainToIngressGroupRoute,
  convertRouteToIngressGroupRoute,
  createIngressGroupRoute,
  deleteIngressGroupRoute,
  getIngressGroupRoute,
  listIngressGroupsRoute,
  removeIngressGroupMemberRoute,
  reorderIngressGroupRoute,
  updateIngressGroupRoute,
} from './ingress-group.docs.js';
import {
  AddIngressGroupMemberSchema,
  CreateIngressGroupSchema,
  IngressGroupDomainConversionSchema,
  IngressGroupListQuerySchema,
  IngressGroupRouteConversionSchema,
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
  viewableIngressGroupFolderIds,
} from './ingress-group-access.js';

export const ingressGroupRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

ingressGroupRoutes.use('*', authMiddleware);

const viewMiddleware = requireAnyScopeBase('nodes:details', 'nodes:manage');
const manageMiddleware = requireAnyScopeBase('nodes:manage');

/** Creating or changing group runtime needs the entitlement; existing groups keep serving without it (S11). */
async function requireGroupEntitlement() {
  await container.resolve(LicensePolicyService).requireFeature('multi-node-availability');
}

async function requireManageableGroup(scopes: string[], id: string) {
  const group = await container.resolve(IngressGroupService).requireGroup(id);
  assertCanManageIngressGroup(scopes, group.folderId);
  return group;
}

ingressGroupRoutes.openapi({ ...listIngressGroupsRoute, middleware: viewMiddleware }, async (c) => {
  const query = IngressGroupListQuerySchema.parse(c.req.query());
  const scopes = c.get('effectiveScopes') || [];
  const folderIds = viewableIngressGroupFolderIds(scopes);
  const service = container.resolve(IngressGroupService);
  const groups = await service.list(query);
  const data =
    folderIds === null ? groups : groups.filter((group) => group.folderId && folderIds.includes(group.folderId));
  return c.json({ data });
});

ingressGroupRoutes.openapi({ ...getIngressGroupRoute, middleware: viewMiddleware }, async (c) => {
  const service = container.resolve(IngressGroupService);
  const group = await service.requireGroup(c.req.param('id')!);
  if (!canViewIngressGroup(c.get('effectiveScopes') || [], group.folderId)) {
    throw new AppError(404, 'INGRESS_GROUP_NOT_FOUND', 'Ingress group not found');
  }
  return c.json({ data: await service.get(group.id) });
});

ingressGroupRoutes.openapi({ ...createIngressGroupRoute, middleware: manageMiddleware }, async (c) => {
  const input = CreateIngressGroupSchema.parse(await c.req.json());
  const scopes = c.get('effectiveScopes') || [];
  assertCanManageIngressGroup(scopes, input.folderId ?? null);
  for (const nodeId of input.nodeIds) assertCanManageMemberNode(scopes, nodeId);
  await requireGroupEntitlement();
  const data = await container.resolve(IngressGroupService).create(input, c.get('user')!.id);
  return c.json({ data }, 201);
});

ingressGroupRoutes.openapi({ ...updateIngressGroupRoute, middleware: manageMiddleware }, async (c) => {
  const id = c.req.param('id')!;
  const input = UpdateIngressGroupSchema.parse(await c.req.json());
  const scopes = c.get('effectiveScopes') || [];
  await requireManageableGroup(scopes, id);
  if (input.folderId !== undefined) assertCanManageIngressGroup(scopes, input.folderId);
  await requireGroupEntitlement();
  return c.json({ data: await container.resolve(IngressGroupService).update(id, input, c.get('user')!.id) });
});

ingressGroupRoutes.openapi({ ...deleteIngressGroupRoute, middleware: manageMiddleware }, async (c) => {
  const id = c.req.param('id')!;
  await requireManageableGroup(c.get('effectiveScopes') || [], id);
  // Deleting an unused group removes runtime rather than changing it: allowed without the entitlement.
  await container.resolve(IngressGroupService).delete(id, c.get('user')!.id);
  return c.body(null, 204);
});

ingressGroupRoutes.openapi({ ...addIngressGroupMemberRoute, middleware: manageMiddleware }, async (c) => {
  const id = c.req.param('id')!;
  const input = AddIngressGroupMemberSchema.parse(await c.req.json());
  const scopes = c.get('effectiveScopes') || [];
  await requireManageableGroup(scopes, id);
  assertCanManageMemberNode(scopes, input.nodeId);
  await requireGroupEntitlement();
  return c.json({ data: await container.resolve(IngressGroupService).addMember(id, input, c.get('user')!.id) });
});

ingressGroupRoutes.openapi({ ...removeIngressGroupMemberRoute, middleware: manageMiddleware }, async (c) => {
  const id = c.req.param('id')!;
  const nodeId = c.req.param('nodeId')!;
  const scopes = c.get('effectiveScopes') || [];
  await requireManageableGroup(scopes, id);
  const raw = await c.req.text();
  const input = RemoveIngressGroupMemberSchema.parse(raw ? JSON.parse(raw) : {});
  // Taking a member out keeps the rest serving; allowed without the entitlement so a lapsed license never blocks
  // shrinking the runtime.
  return c.json({
    data: await container.resolve(IngressGroupService).removeMember(id, nodeId, input, c.get('user')!.id),
  });
});

ingressGroupRoutes.openapi({ ...reorderIngressGroupRoute, middleware: manageMiddleware }, async (c) => {
  const id = c.req.param('id')!;
  const input = ReorderIngressGroupSchema.parse(await c.req.json());
  await requireManageableGroup(c.get('effectiveScopes') || [], id);
  await requireGroupEntitlement();
  return c.json({ data: await container.resolve(IngressGroupService).reorder(id, input.nodeIds, c.get('user')!.id) });
});

ingressGroupRoutes.openapi(
  { ...convertRouteToIngressGroupRoute, middleware: requireAnyScopeBase('proxy:edit') },
  async (c) => {
    const id = c.req.param('id')!;
    const { proxyHostId } = IngressGroupRouteConversionSchema.parse(await c.req.json());
    const scopes = c.get('effectiveScopes') || [];
    if (!hasScope(scopes, `proxy:edit:${proxyHostId}`)) {
      throw new AppError(403, 'FORBIDDEN', 'Moving a route requires proxy:edit on it', {
        requiredScope: `proxy:edit:${proxyHostId}`,
      });
    }
    const service = container.resolve(IngressGroupService);
    const group = await service.getSummary(id);
    const host = await container.resolve(ProxyService).getProxyHost(proxyHostId);
    assertCanPlaceOnMembers(
      scopes,
      'proxy:create',
      (host as { folderId?: string | null }).folderId ?? null,
      group.members.map((member) => member.nodeId)
    );
    await requireGroupEntitlement();
    return c.json({ data: await service.convertRoute(proxyHostId, { ingressGroupId: id }, c.get('user')!.id) });
  }
);

ingressGroupRoutes.openapi(
  { ...convertDomainToIngressGroupRoute, middleware: requireAnyScopeBase('domains:edit') },
  async (c) => {
    const id = c.req.param('id')!;
    const { domainId } = IngressGroupDomainConversionSchema.parse(await c.req.json());
    const scopes = c.get('effectiveScopes') || [];
    if (!hasScope(scopes, `domains:edit:${domainId}`)) {
      throw new AppError(403, 'FORBIDDEN', 'Moving a domain requires domains:edit on it', {
        requiredScope: `domains:edit:${domainId}`,
      });
    }
    const service = container.resolve(IngressGroupService);
    const group = await service.getSummary(id);
    const domain = await container.resolve(DomainsService).getDomain(domainId);
    assertCanPlaceOnMembers(
      scopes,
      'domains:create',
      domain.folderId ?? null,
      group.members.map((member) => member.nodeId)
    );
    await requireGroupEntitlement();
    return c.json({ data: await service.convertDomain(domainId, { ingressGroupId: id }, c.get('user')!.id) });
  }
);
