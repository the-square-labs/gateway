import { container } from '@/container.js';
import { hasScope, hasScopeForResource } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import { PageProfileService } from '@/modules/pages/profile/page-profile.service.js';
import type { FolderService } from '@/modules/proxy/folder.service.js';
import type { ProxyService } from '@/modules/proxy/proxy.service.js';
import type { User } from '@/types.js';
import {
  agentPage,
  agentPageLimit,
  allowedResourceIdsForScopes,
  compactProxyHostForAgent,
  PROXY_HOST_UPDATE_FIELDS,
} from './ai.service-helpers.js';

export const PROXY_TOOL_NAMES = new Set([
  'list_routes',
  'get_route',
  'create_route',
  'update_route',
  'set_route_maintenance',
  'delete_route',
  'create_route_folder',
  'move_routes_to_folder',
  'delete_route_folder',
]);

export interface ProxyToolContext {
  proxyService: ProxyService;
  folderService: FolderService;
}

export async function executeProxyTool(
  context: ProxyToolContext,
  user: User,
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const a = args as any;

  switch (toolName) {
    case 'list_routes': {
      const result = await context.proxyService.listProxyHosts(
        {
          search: a.search,
          page: agentPage(a.page),
          limit: agentPageLimit(a.limit),
        },
        { allowedIds: allowedResourceIdsForScopes(user.scopes, 'proxy:view') }
      );
      return {
        ...result,
        data: result.data.map((host: any) => compactProxyHostForAgent(host)),
      };
    }
    case 'get_route':
      return compactProxyHostForAgent(await context.proxyService.getProxyHost(a.routeId));
    case 'create_route':
      if (a.advancedConfig && !hasScope(user.scopes, 'proxy:advanced')) {
        throw new Error('Advanced config requires proxy:advanced scope');
      }
      if (a.upstreamKind === 'pages') await requirePagesRouteAccess(user, a.pageProjectId);
      return compactProxyHostForAgent(
        await context.proxyService.createProxyHost(
          {
            type: a.type || 'proxy',
            upstreamKind: a.upstreamKind || 'manual',
            nodeId: a.nodeId,
            domainNames: a.domainNames,
            forwardHost: a.forwardHost,
            forwardPort: a.forwardPort,
            forwardScheme: a.forwardScheme || 'http',
            dockerNodeId: a.dockerNodeId,
            dockerContainerName: a.dockerContainerName,
            dockerDeploymentId: a.dockerDeploymentId,
            dockerContainerPort: a.dockerContainerPort,
            pageProjectId: a.pageProjectId,
            pageTagId: a.pageTagId,
            relaySpreadMode: a.relaySpreadMode,
            relaySpreadCount: a.relaySpreadCount,
            sslEnabled: a.sslEnabled || false,
            sslForced: a.sslForced || false,
            http2Support: a.http2Support || false,
            websocketSupport: a.websocketSupport || false,
            sslCertificateId: a.sslCertificateId,
            redirectUrl: a.redirectUrl,
            redirectStatusCode: a.redirectStatusCode,
            customHeaders: a.customHeaders || [],
            cacheEnabled: a.cacheEnabled || false,
            cacheOptions: a.cacheOptions,
            rateLimitEnabled: a.rateLimitEnabled || false,
            rateLimitMode: a.rateLimitMode ?? (a.rateLimitEnabled ? 'custom' : 'inherit'),
            rateLimitOptions: a.rateLimitOptions,
            customRewrites: a.customRewrites || [],
            advancedConfig: a.advancedConfig,
            internalCertificateId: a.internalCertificateId,
            accessListId: a.accessListId,
            folderId: a.folderId,
            nginxTemplateId: a.nginxTemplateId,
            templateVariables: a.templateVariables,
            healthCheckEnabled: a.healthCheckEnabled || false,
            healthCheckUrl: a.healthCheckUrl,
            healthCheckInterval: a.healthCheckInterval,
            healthCheckExpectedStatus: a.healthCheckExpectedStatus,
            healthCheckExpectedBody: a.healthCheckExpectedBody,
            healthCheckBodyMatchMode: a.healthCheckBodyMatchMode,
            healthCheckSlowThreshold: a.healthCheckSlowThreshold,
          },
          user.id,
          {
            actorScopes: user.scopes,
            bypassAdvancedValidation: hasScope(user.scopes, 'proxy:advanced:bypass'),
          }
        )
      );
    case 'update_route': {
      const { routeId, advancedConfig } = a;
      if ('rawConfig' in a || 'rawConfigEnabled' in a || a.type === 'raw') {
        throw new Error('Raw config changes require dedicated raw config tools');
      }
      if (advancedConfig && !hasScope(user.scopes, `proxy:advanced:${routeId}`)) {
        throw new Error('Advanced config requires proxy:advanced scope');
      }
      const existing = await context.proxyService.getProxyHost(routeId);
      if (a.upstreamKind === 'pages' || a.pageProjectId != null || a.pageTagId != null) {
        await requirePagesAvailable();
      }
      const existingPageTarget = existing.pageTarget as { projectId?: unknown } | null | undefined;
      if (existing.upstreamKind === 'pages') {
        requirePageProjectAccess(user, existingPageTarget?.projectId);
      }
      if (a.pageProjectId !== undefined || a.pageTagId !== undefined) {
        if (typeof a.pageProjectId !== 'string' || typeof a.pageTagId !== 'string') {
          throw new AppError(403, 'FORBIDDEN', 'Viewing the selected Page Project is required');
        }
        requirePageProjectAccess(user, a.pageProjectId);
      }
      const updateFields = PROXY_HOST_UPDATE_FIELDS.reduce<Record<string, unknown>>((fields, field) => {
        if (a[field] !== undefined) fields[field] = a[field];
        return fields;
      }, {});
      const bypassAdvancedValidation = hasScope(user.scopes, `proxy:advanced:bypass:${routeId}`);
      const fields = advancedConfig !== undefined ? { ...updateFields, advancedConfig } : updateFields;
      return compactProxyHostForAgent(
        await context.proxyService.updateProxyHost(routeId, fields, user.id, {
          actorScopes: user.scopes,
          bypassAdvancedValidation,
        })
      );
    }
    case 'set_route_maintenance':
      return compactProxyHostForAgent(
        await context.proxyService.toggleMaintenance(a.routeId, a.enabled === true, user.id)
      );
    case 'delete_route':
      await context.proxyService.deleteProxyHost(a.routeId, user.id);
      return { success: true };
    case 'create_route_folder':
      return context.folderService.createFolder({ name: a.name, parentId: a.parentId }, user.id);
    case 'move_routes_to_folder':
      for (const routeId of a.routeIds || []) {
        if (!hasScope(user.scopes, `proxy:edit:${routeId}`)) {
          throw new Error(`PERMISSION_DENIED: Missing required scope proxy:edit:${routeId}`);
        }
      }
      return context.folderService.moveHostsToFolder({ hostIds: a.routeIds, folderId: a.folderId }, user.id);
    case 'delete_route_folder':
      await context.folderService.deleteFolder(a.folderId, user.id);
      return { success: true };
    default:
      throw new Error(`Unsupported proxy tool: ${toolName}`);
  }
}

async function requirePagesRouteAccess(user: User, projectId: unknown) {
  await requirePagesAvailable();
  requirePageProjectAccess(user, projectId);
}

async function requirePagesAvailable() {
  await container.resolve(LicensePolicyService).requireFeature('pages');
  await container.resolve(PageProfileService).requireEnabled();
}

function requirePageProjectAccess(user: User, projectId: unknown) {
  if (typeof projectId !== 'string' || !hasScopeForResource(user.scopes, 'pages:view', projectId)) {
    throw new AppError(403, 'FORBIDDEN', 'Viewing the selected Page Project is required');
  }
}
