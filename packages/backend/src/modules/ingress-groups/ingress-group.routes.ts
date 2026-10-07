import { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { openApiValidationHook } from '@/lib/openapi.js';
import { authMiddleware, requireAnyScopeBase } from '@/modules/auth/auth.middleware.js';
import { redactProxyHostForScopes } from '@/modules/proxy/page-target-visibility.js';
import { redactRawProxyConfigForBrowser } from '@/modules/proxy/raw-visibility.js';
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
import { IngressGroupDomainConversionSchema, IngressGroupRouteConversionSchema } from './ingress-group.schemas.js';
import { INGRESS_GROUP_MANAGE_SCOPE, INGRESS_GROUP_VIEW_SCOPE } from './ingress-group-access.js';
import {
  addIngressGroupMemberFor,
  convertDomainToIngressGroupFor,
  convertRouteToIngressGroupFor,
  createIngressGroupFor,
  deleteIngressGroupFor,
  getIngressGroupFor,
  type IngressGroupActor,
  listIngressGroupsFor,
  removeIngressGroupMemberFor,
  reorderIngressGroupFor,
  updateIngressGroupFor,
} from './ingress-group-operations.js';

export const ingressGroupRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

ingressGroupRoutes.use('*', authMiddleware);

const viewMiddleware = requireAnyScopeBase(INGRESS_GROUP_VIEW_SCOPE, INGRESS_GROUP_MANAGE_SCOPE);
const manageMiddleware = requireAnyScopeBase(INGRESS_GROUP_MANAGE_SCOPE);

function actorOf(c: Context<AppEnv>): IngressGroupActor {
  return { scopes: c.get('effectiveScopes') || [], userId: c.get('user')!.id };
}

ingressGroupRoutes.openapi({ ...listIngressGroupsRoute, middleware: viewMiddleware }, async (c) => {
  return c.json({ data: await listIngressGroupsFor(c.get('effectiveScopes') || [], c.req.query()) });
});

ingressGroupRoutes.openapi({ ...getIngressGroupRoute, middleware: viewMiddleware }, async (c) => {
  return c.json({ data: await getIngressGroupFor(c.get('effectiveScopes') || [], c.req.param('id')!) });
});

ingressGroupRoutes.openapi({ ...createIngressGroupRoute, middleware: manageMiddleware }, async (c) => {
  return c.json({ data: await createIngressGroupFor(actorOf(c), await c.req.json()) }, 201);
});

ingressGroupRoutes.openapi({ ...updateIngressGroupRoute, middleware: manageMiddleware }, async (c) => {
  return c.json({ data: await updateIngressGroupFor(actorOf(c), c.req.param('id')!, await c.req.json()) });
});

ingressGroupRoutes.openapi({ ...deleteIngressGroupRoute, middleware: manageMiddleware }, async (c) => {
  await deleteIngressGroupFor(actorOf(c), c.req.param('id')!);
  return c.body(null, 204);
});

ingressGroupRoutes.openapi({ ...addIngressGroupMemberRoute, middleware: manageMiddleware }, async (c) => {
  return c.json({ data: await addIngressGroupMemberFor(actorOf(c), c.req.param('id')!, await c.req.json()) });
});

ingressGroupRoutes.openapi({ ...removeIngressGroupMemberRoute, middleware: manageMiddleware }, async (c) => {
  const raw = await c.req.text();
  return c.json({
    data: await removeIngressGroupMemberFor(
      actorOf(c),
      c.req.param('id')!,
      c.req.param('nodeId')!,
      raw ? JSON.parse(raw) : {}
    ),
  });
});

ingressGroupRoutes.openapi({ ...reorderIngressGroupRoute, middleware: manageMiddleware }, async (c) => {
  return c.json({ data: await reorderIngressGroupFor(actorOf(c), c.req.param('id')!, await c.req.json()) });
});

ingressGroupRoutes.openapi(
  { ...convertRouteToIngressGroupRoute, middleware: requireAnyScopeBase('proxy:edit') },
  async (c) => {
    const { proxyHostId } = IngressGroupRouteConversionSchema.parse(await c.req.json());
    const actor = actorOf(c);
    const host = await convertRouteToIngressGroupFor(actor, c.req.param('id')!, proxyHostId);
    // The route as GET /proxy-hosts/{id} shows it to this caller.
    const scoped = redactProxyHostForScopes(host as Record<string, unknown>, [...actor.scopes]);
    const canReadRaw =
      actor.scopes.includes('proxy:raw:read') || actor.scopes.includes(`proxy:raw:read:${proxyHostId}`);
    return c.json({ data: canReadRaw ? scoped : redactRawProxyConfigForBrowser(scoped) });
  }
);

ingressGroupRoutes.openapi(
  { ...convertDomainToIngressGroupRoute, middleware: requireAnyScopeBase('domains:edit') },
  async (c) => {
    const { domainId } = IngressGroupDomainConversionSchema.parse(await c.req.json());
    return c.json({ data: await convertDomainToIngressGroupFor(actorOf(c), c.req.param('id')!, domainId) });
  }
);
