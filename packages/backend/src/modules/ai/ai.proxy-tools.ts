import { container } from '@/container.js';
import { createChildLogger } from '@/lib/logger.js';
import { hasScope, hasScopeForCreation, hasScopeForResource } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import { PageProfileService } from '@/modules/pages/profile/page-profile.service.js';
import type { FolderService } from '@/modules/proxy/folder.service.js';
import type { ProxyService } from '@/modules/proxy/proxy.service.js';
import {
  reservedTemplateVariableNames,
  withoutReservedTemplateVariables,
} from '@/modules/proxy/proxy-template-variables.js';
import type { User } from '@/types.js';
import {
  agentPage,
  agentPageLimit,
  allowedResourceIdsForScopes,
  compactProxyHostForAgent,
  PROXY_HOST_UPDATE_FIELDS,
} from './ai.service-helpers.js';

const logger = createChildLogger('AIProxyTools');

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
    case 'create_route': {
      if (!hasScopeForCreation(user.scopes, 'proxy:create', a.folderId, a.nodeId)) {
        throw new AppError(403, 'FORBIDDEN', 'Missing proxy:create permission for the selected destination');
      }
      await context.folderService.assertFolderExists(a.folderId);
      if (a.advancedConfig && !hasScope(user.scopes, 'proxy:advanced')) {
        throw new Error('Advanced config requires proxy:advanced scope');
      }
      if (a.upstreamKind === 'pages') await requirePagesRouteAccess(user, a.pageProjectId);
      if (togglesRawMode(a) && !hasScope(user.scopes, 'proxy:raw:toggle')) {
        throw new AppError(403, 'FORBIDDEN', 'Enabling raw mode requires proxy:raw:toggle scope');
      }
      const templateVariables = dropReservedTemplateVariables(a.templateVariables);
      await context.proxyService.assertReferenceAccess(user.scopes, a);
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
            upstreamIpv6Enabled: a.upstreamIpv6Enabled ?? false,
            dockerNodeId: a.dockerNodeId,
            dockerContainerName: a.dockerContainerName,
            dockerComposeProjectId: a.dockerComposeProjectId,
            dockerComposeServiceName: a.dockerComposeServiceName,
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
            templateVariables,
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
    }
    case 'update_route': {
      const { routeId } = a;
      if ('rawConfig' in a) {
        throw new Error('Raw config changes require dedicated raw config tools');
      }
      const existing = await context.proxyService.getProxyHost(routeId);
      const updateFields = PROXY_HOST_UPDATE_FIELDS.reduce<Record<string, unknown>>((fields, field) => {
        if (a[field] !== undefined) fields[field] = a[field];
        return fields;
      }, {});
      // Moving a route between folders goes through the same checks as the
      // move endpoint. An unchanged folderId is ignored.
      if (updateFields.folderId !== undefined) {
        const folderId = (updateFields.folderId as string | null) ?? null;
        if (folderId === ((existing as { folderId?: string | null }).folderId ?? null)) {
          delete updateFields.folderId;
        } else {
          if (!hasScope(user.scopes, 'proxy:folders:manage')) {
            throw new AppError(403, 'FORBIDDEN', 'Moving a route requires proxy:folders:manage scope', {
              requiredScope: 'proxy:folders:manage',
            });
          }
          if (
            !hasScope(user.scopes, `proxy:edit:${routeId}`) ||
            !hasScopeForCreation(user.scopes, 'proxy:edit', folderId)
          ) {
            throw new AppError(403, 'FORBIDDEN', 'Missing route edit access for the move destination');
          }
          await context.folderService.assertFolderExists(folderId ?? undefined);
        }
      }
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
      // Setting or clearing the advanced config both need the scope; echoing
      // the stored value (or the redacted null) does not.
      if (a.advancedConfig !== undefined) {
        if (
          !hasScope(user.scopes, `proxy:advanced:${routeId}`) &&
          normalizedAdvancedConfig(a.advancedConfig) !== normalizedAdvancedConfig(existing.advancedConfig)
        ) {
          if (normalizedAdvancedConfig(a.advancedConfig) !== null) {
            throw new Error('Advanced config requires proxy:advanced scope');
          }
        } else {
          updateFields.advancedConfig = a.advancedConfig;
        }
      }
      // A raw-mode toggle is an actual change of the stored mode; echoing the
      // stored type/flag does not need the raw scopes.
      const rawToggle = togglesRawMode(a, existing as RawModeState);
      if (rawToggle) {
        if (!hasScope(user.scopes, `proxy:raw:toggle:${routeId}`)) {
          throw new AppError(403, 'FORBIDDEN', 'Toggling raw mode requires proxy:raw:toggle scope');
        }
        if (a.rawConfigEnabled !== undefined) updateFields.rawConfigEnabled = a.rawConfigEnabled;
      }
      if (
        typeof a.nodeId === 'string' &&
        a.nodeId &&
        a.nodeId !== existing.nodeId &&
        !hasScopeForResource(user.scopes, 'proxy:create', a.nodeId)
      ) {
        throw new AppError(403, 'FORBIDDEN', `Missing required scope: proxy:create:${a.nodeId}`);
      }
      if (updateFields.templateVariables !== undefined) {
        updateFields.templateVariables = dropReservedTemplateVariables(updateFields.templateVariables);
      }
      // The update route does not accept `enabled`; enabling or disabling goes
      // through the toggle lifecycle, which protects system and public routes.
      const enabled = typeof updateFields.enabled === 'boolean' ? updateFields.enabled : undefined;
      delete updateFields.enabled;
      await context.proxyService.assertReferenceAccess(user.scopes, updateFields, existing);
      const bypassAdvancedValidation = hasScope(user.scopes, `proxy:advanced:bypass:${routeId}`);
      let updated: Record<string, any> = existing;
      if (Object.keys(updateFields).length > 0 || enabled === undefined) {
        updated = await context.proxyService.updateProxyHost(routeId, updateFields, user.id, {
          actorScopes: user.scopes,
          bypassAdvancedValidation,
          ...(rawToggle ? { bypassRawValidation: hasScope(user.scopes, `proxy:raw:bypass:${routeId}`) } : {}),
        });
      }
      if (enabled !== undefined && enabled !== updated.enabled) {
        updated = await context.proxyService.toggleProxyHost(routeId, enabled, user.id);
      }
      return compactProxyHostForAgent(updated);
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
      if (!hasScopeForCreation(user.scopes, 'proxy:edit', a.folderId ?? null)) {
        throw new AppError(403, 'FORBIDDEN', 'Missing route edit access for the move destination');
      }
      return context.folderService.moveHostsToFolder({ hostIds: a.routeIds, folderId: a.folderId }, user.id);
    case 'delete_route_folder':
      await context.folderService.deleteFolder(a.folderId, user.id);
      return { success: true };
    default:
      throw new Error(`Unsupported proxy tool: ${toolName}`);
  }
}

type RawModeState = { type?: string | null; rawConfigEnabled?: boolean | null };

/** Mirrors proxy.routes.ts: only an actual change of the stored raw mode counts as a toggle. */
function togglesRawMode(input: { type?: unknown; rawConfigEnabled?: unknown }, existing: RawModeState = {}): boolean {
  const becomesRawType = input.type === 'raw' && existing.type !== 'raw';
  const leavesRawType = existing.type === 'raw' && input.type !== undefined && input.type !== 'raw';
  const changesFlag =
    input.rawConfigEnabled !== undefined && input.rawConfigEnabled !== (existing.rawConfigEnabled ?? false);
  return becomesRawType || leavesRawType || changesFlag;
}

function normalizedAdvancedConfig(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Same rule as the proxy host schemas: Gateway-managed render keys cannot be
 * overridden, and are dropped (and logged) instead of rejecting the save.
 */
function dropReservedTemplateVariables<T>(variables: T): T {
  if (variables === undefined || variables === null) return variables;
  if (typeof variables !== 'object' || Array.isArray(variables)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'templateVariables must be an object');
  }
  const reserved = reservedTemplateVariableNames(variables as Record<string, unknown>);
  if (reserved.length === 0) return variables;
  logger.info('Dropped Gateway-managed template variables from proxy host input', { reserved });
  return withoutReservedTemplateVariables(variables as Record<string, unknown>) as T;
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
