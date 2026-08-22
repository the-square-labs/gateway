import { hasScope } from '@/lib/permissions.js';
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
      return compactProxyHostForAgent(
        await context.proxyService.createProxyHost(
          {
            type: a.type || 'proxy',
            upstreamKind: 'manual',
            nodeId: a.nodeId,
            domainNames: a.domainNames,
            forwardHost: a.forwardHost,
            forwardPort: a.forwardPort,
            forwardScheme: a.forwardScheme || 'http',
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
            rateLimitMode: a.rateLimitEnabled ? 'custom' : 'inherit',
            rateLimitOptions: a.rateLimitOptions,
            customRewrites: a.customRewrites || [],
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
          user.id
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
      const updateFields = PROXY_HOST_UPDATE_FIELDS.reduce<Record<string, unknown>>((fields, field) => {
        if (a[field] !== undefined) fields[field] = a[field];
        return fields;
      }, {});
      const bypassAdvancedValidation = hasScope(user.scopes, `proxy:advanced:bypass:${routeId}`);
      const fields =
        advancedConfig && hasScope(user.scopes, `proxy:advanced:${routeId}`)
          ? { ...updateFields, advancedConfig }
          : updateFields;
      return compactProxyHostForAgent(
        await context.proxyService.updateProxyHost(routeId, fields, user.id, { bypassAdvancedValidation })
      );
    }
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
